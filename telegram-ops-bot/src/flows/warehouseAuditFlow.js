'use strict';

/**
 * src/flows/warehouseAuditFlow.js — WAREHOUSE AUDIT (DBP-1.5 Concept A).
 *
 * Admin-only, tap-only bale -> than drill-down so an admin can audit a
 * warehouse himself. Pure inspect: presence marks (present/missing/unmarked)
 * live in the session only — there are NO inventory writes. A reconciliation
 * summary compares the system count against what the admin physically marked.
 *
 * This is deliberately NOT the allocation engine / dispatch flow (DBP-1.5
 * Concept B). It shares only the design -> shade -> bale visual language.
 *
 * Spec: telegram-ops-bot/specs/dbp-1.5-than-bale-allocation.md §9A.
 *
 * Flow: warehouse -> design -> shade -> bale list (skipped when a shade has a
 * single bale) -> tappable than card -> reconciliation summary.
 *
 * Callback namespace `wai:*`:
 *   wai:close                 end the flow
 *   wai:back                  step back one level
 *   wai:wh:<idx>              pick warehouse (index into session._warehouses)
 *   wai:design:<idx>          pick design  (index into session._designs)
 *   wai:shade:<idx>           pick shade   (index into session._shades)
 *   wai:bale:<idx>            open bale     (index into session._bales)
 *   wai:than:<thanNo>         cycle presence mark on the current bale
 *   wai:recon                 show session reconciliation summary
 *   wai:noop                  no-op (header rows)
 */

const sessionStore        = require('../utils/sessionStore');
const inventoryRepository = require('../repositories/inventoryRepository');
const inventoryService    = require('../services/inventoryService');
const shadesRepository    = require('../repositories/shadesRepository');
const auth                = require('../middlewares/auth');
const config              = require('../config');
const logger              = require('../utils/logger');

const SESSION_TYPE   = 'wh_audit_flow';
const MAX_DESIGNS    = 30;
const MAX_SHADES     = 40;
const THANS_PER_ROW  = 3;

/** Presence-mark cycle: unmarked -> present -> missing -> unmarked. */
const MARK_PRESENT = 'present';
const MARK_MISSING = 'missing';

/* ───────────────────────────── render helper ───────────────────────────── */

/**
 * Render the single anchored audit card (edit-in-place when possible).
 * @param {object} bot Telegram bot instance.
 * @param {number|string} chatId Chat id.
 * @param {string} userId Telegram user id.
 * @param {string} text Plain-text body.
 * @param {Array<Array<object>>} rows Inline keyboard rows.
 * @returns {Promise<void>}
 */
async function render(bot, chatId, userId, text, rows) {
  const session = sessionStore.get(userId);
  const opts = { reply_markup: { inline_keyboard: rows } };
  const mid = session && session.flowMessageId;
  if (mid) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...opts });
      return;
    } catch (_) { /* fall through to fresh send */ }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  if (session) {
    session.flowMessageId = sent.message_id;
    sessionStore.set(userId, session);
  }
}

function fmtQty(n) { return (Math.round((n || 0) * 100) / 100).toLocaleString('en-NG'); }
function closeRow() { return [{ text: '❌ Close', callback_data: 'wai:close' }]; }
function backRow(label) { return [{ text: label || '⬅ Back', callback_data: 'wai:back' }]; }

/* ───────────────────────────── entry ───────────────────────────── */

/**
 * Start the warehouse audit flow. Admin-only; no-op when the feature flag
 * is off.
 * @param {object} bot Telegram bot instance.
 * @param {number|string} chatId Chat id.
 * @param {string} userId Telegram user id.
 * @param {number|null} messageId Optional message id to edit in place.
 * @returns {Promise<void>}
 */
async function start(bot, chatId, userId, messageId) {
  if (!config.warehouseAudit || !config.warehouseAudit.enabled) {
    await bot.sendMessage(chatId, '🔍 Warehouse Audit is currently disabled.');
    return;
  }
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId, '🔍 Warehouse Audit is admin-only.');
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'pick_warehouse',
    flowMessageId: messageId || null,
    startedAt: new Date().toISOString(),
    warehouse: '',
    design: '',
    shade: '',
    packageNo: '',
    skippedBaleList: false,
    marks: {},
    _warehouses: [],
    _designs: [],
    _shades: [],
    _bales: [],
  });
  await renderWarehousePicker(bot, chatId, userId);
}

/* ───────────────────────────── warehouse ───────────────────────────── */

async function renderWarehousePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const warehouses = await inventoryRepository.getWarehouses();
  if (!warehouses.length) {
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      '🔍 Warehouse Audit\n\nNo warehouses with stock found.',
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return;
  }
  if (warehouses.length === 1) {
    session.warehouse = warehouses[0];
    session.step = 'pick_design';
    sessionStore.set(userId, session);
    await renderDesignPicker(bot, chatId, userId);
    return;
  }
  session._warehouses = warehouses;
  sessionStore.set(userId, session);
  const rows = warehouses.map((w, i) => ([{ text: `🏬 ${w}`, callback_data: `wai:wh:${i}` }]));
  rows.push(closeRow());
  await render(bot, chatId, userId,
    '🔍 Warehouse Audit\n\nSelect a warehouse to inspect:', rows);
}

/* ───────────────────────────── design ───────────────────────────── */

async function renderDesignPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const all = await inventoryRepository.getAll();
  const w = (session.warehouse || '').toLowerCase();
  const designs = new Map();
  for (const r of all) {
    if (r.status !== 'available') continue;
    if (w && (r.warehouse || '').toLowerCase() !== w) continue;
    if (!r.design) continue;
    const k = r.design;
    if (!designs.has(k)) designs.set(k, { design: r.design, thans: 0, yards: 0, bales: new Set(), shades: new Set() });
    const e = designs.get(k);
    e.thans += 1;
    e.yards += r.yards;
    e.bales.add(r.packageNo);
    if (r.shade) e.shades.add(r.shade);
  }
  const list = Array.from(designs.values()).sort((a, b) => String(a.design).localeCompare(String(b.design), undefined, { numeric: true }));
  if (!list.length) {
    await render(bot, chatId, userId,
      `🔍 ${session.warehouse}\n\nNo available stock in this warehouse.`,
      [backRow('⬅ Warehouses'), closeRow()]);
    return;
  }
  session._designs = list.map((d) => ({ design: d.design }));
  sessionStore.set(userId, session);
  const rows = list.slice(0, MAX_DESIGNS).map((d, i) => ([{
    text: `🎨 ${d.design} · ${d.bales.size} bale(s) · ${d.shades.size} shade(s)`,
    callback_data: `wai:design:${i}`,
  }]));
  const more = list.length > MAX_DESIGNS ? `\n\n(+${list.length - MAX_DESIGNS} more — narrow by warehouse)` : '';
  rows.push(backRow('⬅ Warehouses'));
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `🔍 ${session.warehouse}\n\nPick a design:${more}`, rows);
}

/* ───────────────────────────── shade ───────────────────────────── */

async function renderShadePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const all = await inventoryRepository.getAll();
  const w = (session.warehouse || '').toLowerCase();
  const shades = new Map();
  for (const r of all) {
    if (r.status !== 'available') continue;
    if (w && (r.warehouse || '').toLowerCase() !== w) continue;
    if (r.design !== session.design) continue;
    const k = r.shade || '—';
    if (!shades.has(k)) shades.set(k, { shade: k, thans: 0, yards: 0, bales: new Set() });
    const e = shades.get(k);
    e.thans += 1;
    e.yards += r.yards;
    e.bales.add(r.packageNo);
  }
  const list = Array.from(shades.values()).sort((a, b) => String(a.shade).localeCompare(String(b.shade), undefined, { numeric: true }));
  if (!list.length) {
    await render(bot, chatId, userId,
      `🔍 ${session.design} — ${session.warehouse}\n\nNo available shades.`,
      [backRow('⬅ Designs'), closeRow()]);
    return;
  }
  let shadesList = [];
  try { shadesList = await shadesRepository.getAll(); } catch (_) { shadesList = []; }
  session._shades = list.map((s) => ({ shade: s.shade }));
  sessionStore.set(userId, session);
  const rows = list.slice(0, MAX_SHADES).map((s, i) => {
    let chip = '🎨';
    try { chip = shadesRepository.chipFromList(shadesList, s.shade) || '🎨'; } catch (_) { /* keep default */ }
    return [{
      text: `${chip} ${s.shade} (${s.bales.size} bale${s.bales.size === 1 ? '' : 's'} · ${s.thans} than)`,
      callback_data: `wai:shade:${i}`,
    }];
  });
  rows.push(backRow('⬅ Designs'));
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `🔍 ${session.design} — ${session.warehouse}\n\nPick a shade:`, rows);
}

/* ───────────────────────────── bale list ───────────────────────────── */

/**
 * Build the bale list for the current warehouse+design+shade, ordered
 * front/LIFO (newest addedAt first). Returns the list and caches it.
 */
async function loadBales(session) {
  const all = await inventoryRepository.getAll();
  const w = (session.warehouse || '').toLowerCase();
  const byPkg = new Map();
  for (const r of all) {
    if (w && (r.warehouse || '').toLowerCase() !== w) continue;
    if (r.design !== session.design) continue;
    if ((r.shade || '—') !== session.shade) continue;
    if (!byPkg.has(r.packageNo)) {
      byPkg.set(r.packageNo, {
        packageNo: r.packageNo, total: 0, available: 0, yards: 0,
        availableYards: 0, addedAt: r.addedAt || '', binLocation: r.binLocation || '',
      });
    }
    const e = byPkg.get(r.packageNo);
    e.total += 1;
    e.yards += r.yards;
    if (r.status === 'available') { e.available += 1; e.availableYards += r.yards; }
    if ((r.addedAt || '') > e.addedAt) e.addedAt = r.addedAt || e.addedAt;
  }
  // Front/LIFO: last-in (newest addedAt) first.
  return Array.from(byPkg.values()).sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
}

async function renderBaleList(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const bales = await loadBales(session);
  if (!bales.length) {
    await render(bot, chatId, userId,
      `🔍 ${session.design} · ${session.shade}\n\nNo bales found.`,
      [backRow('⬅ Shades'), closeRow()]);
    return;
  }
  // Single-bale shade: skip the list, open the than card directly (§9A.2).
  if (bales.length === 1) {
    session.skippedBaleList = true;
    session.packageNo = bales[0].packageNo;
    session.step = 'view_than';
    session._bales = bales.map((b) => ({ packageNo: b.packageNo }));
    sessionStore.set(userId, session);
    await renderThanCard(bot, chatId, userId);
    return;
  }
  session.skippedBaleList = false;
  session._bales = bales.map((b) => ({ packageNo: b.packageNo }));
  sessionStore.set(userId, session);

  const totThans = bales.reduce((s, b) => s + b.available, 0);
  const totYards = bales.reduce((s, b) => s + b.availableYards, 0);
  const rows = bales.map((b, i) => {
    const open = b.available < b.total;
    const tag = i === 0 ? '🟢 front' : (open ? '🟠 open' : '🟢');
    return [{
      text: `📦 Bale ${b.packageNo} · ${b.available}/${b.total} · ${fmtQty(b.availableYards)}y · ${tag}`,
      callback_data: `wai:bale:${i}`,
    }];
  });
  rows.push(backRow('⬅ Shades'));
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `🔍 ${session.design} · ${session.shade} — ${session.warehouse}\n`
    + `Available: ${totThans} thans · ${fmtQty(totYards)} yds across ${bales.length} bales\n\n`
    + 'Tap a bale to inspect its thans:', rows);
}

/* ───────────────────────────── than card ───────────────────────────── */

function markIcon(session, packageNo, thanNo, status) {
  if (status !== 'available') return '🔴';
  const m = session.marks[`${packageNo}|${thanNo}`];
  if (m === MARK_PRESENT) return '✅';
  if (m === MARK_MISSING) return '❌';
  return '⬜';
}

async function renderThanCard(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const summary = await inventoryService.getPackageSummary(session.packageNo);
  if (!summary) {
    await render(bot, chatId, userId,
      `🔍 Bale ${session.packageNo} not found.`,
      [backRow(session.skippedBaleList ? '⬅ Shades' : '⬅ Bales'), closeRow()]);
    return;
  }
  const open = summary.availableThans < summary.totalThans;
  let present = 0; let missing = 0; let unmarked = 0;
  const chipRows = [];
  let row = [];
  for (const t of summary.thans) {
    const icon = markIcon(session, summary.packageNo, t.thanNo, t.status);
    if (t.status === 'available') {
      const m = session.marks[`${summary.packageNo}|${t.thanNo}`];
      if (m === MARK_PRESENT) present += 1;
      else if (m === MARK_MISSING) missing += 1;
      else unmarked += 1;
      row.push({ text: `${icon} #${t.thanNo} ${fmtQty(t.yards)}y`, callback_data: `wai:than:${t.thanNo}` });
    } else {
      row.push({ text: `${icon} #${t.thanNo}`, callback_data: 'wai:noop' });
    }
    if (row.length === THANS_PER_ROW) { chipRows.push(row); row = []; }
  }
  if (row.length) chipRows.push(row);

  const header =
    `📦 Bale ${summary.packageNo} — ${summary.design} · ${summary.shade}\n`
    + `Indent: ${summary.indent || '—'} · ${summary.warehouse} · ${open ? '🟠 open' : '🟢 intact'}\n`
    + (summary.pricePerYard ? `Price: ₦${fmtQty(summary.pricePerYard)}/yard\n` : '')
    + '\nTap a than: ⬜ → ✅ present → ❌ missing\n'
    + `System available: ${summary.availableThans} · 🔴 sold: ${summary.soldThans}\n`
    + `Verified — ✅ ${present} · ❌ ${missing} · ⬜ ${unmarked} unchecked`;

  const rows = chipRows.slice();
  rows.push([{ text: '📋 Reconciliation', callback_data: 'wai:recon' }]);
  rows.push(backRow(session.skippedBaleList ? '⬅ Shades' : '⬅ Bales'));
  rows.push(closeRow());
  await render(bot, chatId, userId, header, rows);
}

/* ───────────────────────────── reconciliation ───────────────────────────── */

async function renderReconciliation(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const entries = Object.entries(session.marks);
  let present = 0; let missing = 0;
  const byBale = new Map();
  for (const [key, mark] of entries) {
    const [pkg] = key.split('|');
    if (!byBale.has(pkg)) byBale.set(pkg, { present: 0, missing: 0 });
    const e = byBale.get(pkg);
    if (mark === MARK_PRESENT) { e.present += 1; present += 1; }
    else if (mark === MARK_MISSING) { e.missing += 1; missing += 1; }
  }
  let body = '📋 Audit reconciliation\n'
    + `Scope: ${session.warehouse || 'all'}\n\n`;
  if (!byBale.size) {
    body += 'No thans marked yet. Open a bale and tap thans to mark them ✅ present / ❌ missing.';
  } else {
    for (const [pkg, e] of byBale) {
      body += `📦 Bale ${pkg}: ✅ ${e.present} present · ❌ ${e.missing} missing\n`;
    }
    body += `\nTotal: ✅ ${present} present · ❌ ${missing} missing`;
    if (missing > 0) body += `\n⚠️ ${missing} than(s) marked missing — investigate.`;
  }
  body += '\n\n(Audit only — no inventory changes were made.)';
  const rows = [];
  if (session.packageNo) rows.push([{ text: '⬅ Back to bale', callback_data: 'wai:back' }]);
  rows.push(closeRow());
  await render(bot, chatId, userId, body, rows);
}

/* ───────────────────────────── back navigation ───────────────────────────── */

async function stepBack(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  switch (session.step) {
    case 'pick_design':
      session.step = 'pick_warehouse';
      session.design = '';
      sessionStore.set(userId, session);
      await renderWarehousePicker(bot, chatId, userId);
      break;
    case 'pick_shade':
      session.step = 'pick_design';
      session.shade = '';
      sessionStore.set(userId, session);
      await renderDesignPicker(bot, chatId, userId);
      break;
    case 'view_bale':
      session.step = 'pick_shade';
      sessionStore.set(userId, session);
      await renderShadePicker(bot, chatId, userId);
      break;
    case 'view_than':
      if (session.skippedBaleList) {
        session.step = 'pick_shade';
        session.packageNo = '';
        sessionStore.set(userId, session);
        await renderShadePicker(bot, chatId, userId);
      } else {
        session.step = 'view_bale';
        session.packageNo = '';
        sessionStore.set(userId, session);
        await renderBaleList(bot, chatId, userId);
      }
      break;
    default:
      sessionStore.clear(userId);
      await render(bot, chatId, userId, '🔍 Closed.', [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
  }
}

/* ───────────────────────────── callback dispatcher ───────────────────────────── */

/**
 * Handle a `wai:*` callback for the warehouse audit flow.
 * @param {object} bot Telegram bot instance.
 * @param {object} query Telegram callback query.
 * @returns {Promise<boolean>} true when handled.
 */
async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('wai:')) return false;
  const chatId = query.message && query.message.chat && query.message.chat.id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return false;

  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }

  if (data === 'wai:noop') return true;

  if (data === 'wai:close') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '🔍 Audit closed.', [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return true;
  }

  if (data === 'wai:back') { await stepBack(bot, chatId, userId); return true; }

  if (data === 'wai:recon') { await renderReconciliation(bot, chatId, userId); return true; }

  if (data.startsWith('wai:wh:')) {
    const i = parseInt(data.slice('wai:wh:'.length), 10);
    const wh = (session._warehouses || [])[i];
    if (wh) {
      session.warehouse = wh;
      session.step = 'pick_design';
      sessionStore.set(userId, session);
      await renderDesignPicker(bot, chatId, userId);
    }
    return true;
  }

  if (data.startsWith('wai:design:')) {
    const i = parseInt(data.slice('wai:design:'.length), 10);
    const d = (session._designs || [])[i];
    if (d) {
      session.design = d.design;
      session.step = 'pick_shade';
      sessionStore.set(userId, session);
      await renderShadePicker(bot, chatId, userId);
    }
    return true;
  }

  if (data.startsWith('wai:shade:')) {
    const i = parseInt(data.slice('wai:shade:'.length), 10);
    const s = (session._shades || [])[i];
    if (s) {
      session.shade = s.shade;
      session.step = 'view_bale';
      sessionStore.set(userId, session);
      await renderBaleList(bot, chatId, userId);
    }
    return true;
  }

  if (data.startsWith('wai:bale:')) {
    const i = parseInt(data.slice('wai:bale:'.length), 10);
    const b = (session._bales || [])[i];
    if (b) {
      session.packageNo = b.packageNo;
      session.step = 'view_than';
      sessionStore.set(userId, session);
      await renderThanCard(bot, chatId, userId);
    }
    return true;
  }

  if (data.startsWith('wai:than:')) {
    const thanNo = data.slice('wai:than:'.length);
    const key = `${session.packageNo}|${thanNo}`;
    const cur = session.marks[key];
    if (!cur) session.marks[key] = MARK_PRESENT;
    else if (cur === MARK_PRESENT) session.marks[key] = MARK_MISSING;
    else delete session.marks[key];
    sessionStore.set(userId, session);
    await renderThanCard(bot, chatId, userId);
    return true;
  }

  return false;
}

module.exports = {
  start,
  handleCallback,
  _internals: {
    renderWarehousePicker, renderDesignPicker, renderShadePicker,
    renderBaleList, renderThanCard, renderReconciliation, stepBack,
    loadBales, markIcon, SESSION_TYPE,
  },
};
