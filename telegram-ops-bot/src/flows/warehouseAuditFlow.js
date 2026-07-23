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
const { makeRenderer, rowsFor } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const inventoryService    = require('../services/inventoryService');
const shadesRepository    = require('../repositories/shadesRepository');
const settingsRepository  = require('../repositories/settingsRepository');
const stockTakesRepository = require('../repositories/stockTakesRepository');
const auditLogRepository  = require('../repositories/auditLogRepository');
const auth                = require('../middlewares/auth');
const config              = require('../config');
const logger              = require('../utils/logger');

const SESSION_TYPE   = 'wh_audit_flow';
const MAX_DESIGNS    = 30;
const MAX_SHADES     = 40;
const THANS_PER_ROW  = 3;
const TILES_PER_ROW  = 2;

/**
 * Per-warehouse audit-mode setting (Settings sheet, key=`AUDIT_MODE.<wh>`).
 *   'than' = full per-than audit (Kano-style; every available than is a chip).
 *   'bale' = bale-level audit with Closed/Open prompt (Lagos-style); the
 *            Open branch falls into the than-chip view for that one bale.
 * Default is 'bale' — closed-by-default is the safer assumption for
 * warehouses that sell whole bales.
 */
const AUDIT_MODE_KEY_PREFIX = 'AUDIT_MODE.';
const AUDIT_MODE_THAN = 'than';
const AUDIT_MODE_BALE = 'bale';

/** Presence-mark cycle: unmarked -> present -> missing -> unmarked. */
const MARK_PRESENT = 'present';
const MARK_MISSING = 'missing';

/**
 * WAU-2 (owner flow, 17-Jul-2026) — warehouse → LOCATION grouping.
 * Owner-editable Settings rows `LOCATION.<warehouse>` override; fallback
 * heuristic: names containing "kano" → Kano, everything else → Lagos
 * (covers IDUMOTA→Lagos, Kano office→Kano, Lagos→Lagos today).
 */
const LOCATION_KEY_PREFIX = 'LOCATION.';
async function locationOf(warehouse) {
  try {
    const all = await settingsRepository.getAll();
    const v = String(all[`${LOCATION_KEY_PREFIX}${warehouse}`] || '').trim();
    if (v) return v;
  } catch (_) { /* fall through to heuristic */ }
  return /kano/i.test(warehouse) ? 'Kano' : 'Lagos';
}

/**
 * WAU-2 — design checklist for a warehouse: one entry per design with
 * FULL (sealed) bale count, loose bundle/than count from opened bales,
 * available yards, and whether a still-valid reconciliation exists
 * (valid = the latest reconciled StockTakes row's quantities EQUAL the
 * current ones; any stock change flips the design back to holding).
 */
async function loadChecklist(session) {
  const all = await inventoryRepository.getAll();
  const w = (session.warehouse || '').toLowerCase();
  const pkgs = new Map();
  for (const r of all) {
    if ((r.warehouse || '').toLowerCase() !== w || !r.design) continue;
    const k = r.packageNo;
    if (!pkgs.has(k)) pkgs.set(k, { design: r.design, total: 0, avail: 0, yards: 0 });
    const p = pkgs.get(k);
    p.total += 1;
    if (r.status === 'available') { p.avail += 1; p.yards += Number(r.yards) || 0; }
  }
  const designs = new Map();
  for (const p of pkgs.values()) {
    if (!p.avail) continue;
    const k = p.design;
    if (!designs.has(k)) designs.set(k, { design: k, fullBales: 0, looseThans: 0, yards: 0 });
    const d = designs.get(k);
    if (p.avail === p.total) d.fullBales += 1;
    else d.looseThans += p.avail;
    d.yards += p.yards;
  }
  const latest = await stockTakesRepository.latestFor(session.warehouse);
  return Array.from(designs.values())
    .sort((a, b) => String(a.design).localeCompare(String(b.design), undefined, { numeric: true }))
    .map((d) => {
      const rec = latest.get(String(d.design).toUpperCase());
      const reconciled = !!rec && rec.sheet_bales === d.fullBales && rec.sheet_bundles === d.looseThans;
      return { ...d, reconciled, reconciledAt: reconciled ? rec.audited_at.slice(0, 10) : '' };
    });
}

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
// Anchored edit-else-send renderer — shared flowKit implementation.
const render = makeRenderer({ parseMode: null });

function fmtQty(n) { return (Math.round((n || 0) * 100) / 100).toLocaleString('en-NG'); }
const { closeRow, backRow } = rowsFor('wai');

/**
 * Chunk a flat list of inline-keyboard buttons into rows of `perRow` tiles.
 * Used by the shade and bale pickers to render a graceful 2-column grid.
 */
function chunkButtons(buttons, perRow) {
  const out = [];
  for (let i = 0; i < buttons.length; i += perRow) out.push(buttons.slice(i, i + perRow));
  return out;
}

/**
 * Look up the per-warehouse audit mode from the Settings sheet.
 * Returns 'than' or 'bale'; defaults to 'bale' when unset, blank, or on
 * any read error (so the flow always has a safe fallback).
 * @param {string} warehouse Warehouse name as it appears in Inventory.
 * @returns {Promise<'than'|'bale'>}
 */
async function getAuditMode(warehouse) {
  if (!warehouse) return AUDIT_MODE_BALE;
  try {
    const all = await settingsRepository.getAll();
    const v = String(all[`${AUDIT_MODE_KEY_PREFIX}${warehouse}`] || '').toLowerCase().trim();
    return v === AUDIT_MODE_THAN ? AUDIT_MODE_THAN : AUDIT_MODE_BALE;
  } catch (e) {
    logger.warn(`warehouseAuditFlow.getAuditMode: ${e.message}`);
    return AUDIT_MODE_BALE;
  }
}

/**
 * Whether the admin has tapped/marked any than of the given bale in this
 * audit session. Used to decorate the bale tile (✅ when fully verified
 * by the Closed shortcut, 🔍 when partially audited).
 */
function baleAuditState(session, packageNo, availableCount) {
  if (!session || !session.marks) return 'untouched';
  let present = 0; let missing = 0;
  const prefix = `${packageNo}|`;
  for (const k of Object.keys(session.marks)) {
    if (!k.startsWith(prefix)) continue;
    const m = session.marks[k];
    if (m === MARK_PRESENT) present += 1;
    else if (m === MARK_MISSING) missing += 1;
  }
  if (present === 0 && missing === 0) return 'untouched';
  if (missing === 0 && present >= availableCount) return 'verified';
  return 'in_progress';
}

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
  // WAU-3 (owner 20-Jul): warehouse staff run blind-count audits. Any
  // authorized user may audit — they never see book quantities; only
  // 🔬 Deep inspect (which reveals them) stays admin-only.
  if (!auth.isAllowed(userId)) {
    await bot.sendMessage(chatId, '🔍 You are not authorized to use this bot.');
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'pick_location',
    flowMessageId: messageId || null,
    startedAt: new Date().toISOString(),
    location: '',
    warehouse: '',
    auditMode: AUDIT_MODE_BALE,
    design: '',
    shade: '',
    packageNo: '',
    skippedBaleList: false,
    marks: {},
    _locations: [],
    _warehouses: [],
    _checklist: [],
    _checked: {},
    _designs: [],
    _shades: [],
    _bales: [],
  });
  await renderLocationPicker(bot, chatId, userId);
}

/* ───────────────────────────── WAU-2: location ───────────────────────────── */

async function renderLocationPicker(bot, chatId, userId) {
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
  const byLoc = new Map();
  for (const w of warehouses) {
    const loc = await locationOf(w);
    if (!byLoc.has(loc)) byLoc.set(loc, []);
    byLoc.get(loc).push(w);
  }
  const locations = [...byLoc.keys()].sort();
  session._locations = locations;
  session._locWarehouses = Object.fromEntries(byLoc);
  sessionStore.set(userId, session);
  if (locations.length === 1) {
    session.location = locations[0];
    session.step = 'pick_warehouse';
    sessionStore.set(userId, session);
    await renderWarehousePicker(bot, chatId, userId);
    return;
  }
  const rows = locations.map((l, i) => ([{ text: `📍 ${l} (${byLoc.get(l).length} warehouse${byLoc.get(l).length > 1 ? 's' : ''})`, callback_data: `wai:loc:${i}` }]));
  rows.push(closeRow());
  await render(bot, chatId, userId, '🔍 Warehouse Audit\n\nSelect the location:', rows);
}

/* ───────────────────────────── WAU-2: checklist ───────────────────────────── */

/**
 * WAU-3 — per-design same-day audit state derived from StockTakes rows:
 * how many failed attempts today and whether the design is flag-locked
 * (a 'flagged' row today with no later 'flag_cleared' row today).
 */
async function todayStateFor(warehouse) {
  const dayIso = new Date().toISOString().slice(0, 10);
  const rows = await stockTakesRepository.rowsForDay(warehouse, dayIso);
  const map = new Map();
  for (const r of rows) {
    const k = r.design.toUpperCase();
    if (!map.has(k)) map.set(k, { mismatches: 0, flaggedAt: '', clearedAt: '' });
    const s = map.get(k);
    if (r.result === 'mismatch') s.mismatches += 1;
    if (r.result === 'flagged' && r.audited_at > s.flaggedAt) s.flaggedAt = r.audited_at;
    if (r.result === 'flag_cleared' && r.audited_at > s.clearedAt) s.clearedAt = r.audited_at;
  }
  for (const s of map.values()) s.locked = !!s.flaggedAt && s.flaggedAt > s.clearedAt;
  return map;
}

/**
 * WAU-3 — the blind reconcile engine, shared by the tap pad and the
 * offline AUDIT batch. Compares a physical count against the live book
 * numbers WITHOUT ever revealing them to the auditor.
 *
 * @returns {{status:'match'|'recount'|'flagged'|'locked'|'already'|'unknown_design', d?:object, flagRow?:object}}
 */
async function reconcileDesign({ warehouse, location, design, bales, bundles, auditor }) {
  const list = await loadChecklist({ warehouse });
  const d = list.find((x) => String(x.design).toUpperCase() === String(design).toUpperCase());
  if (!d) return { status: 'unknown_design' };
  const state = (await todayStateFor(warehouse)).get(String(design).toUpperCase())
    || { mismatches: 0, locked: false };
  if (state.locked) return { status: 'locked', d };
  if (d.reconciled) return { status: 'already', d };
  const base = {
    warehouse, location: location || '', design: d.design,
    sheet_bales: d.fullBales, sheet_bundles: d.looseThans, sheet_yards: Math.round(d.yards),
    counted_bales: bales, counted_bundles: bundles, auditor,
  };
  if (d.fullBales === bales && d.looseThans === bundles) {
    await stockTakesRepository.appendMany([{ ...base, result: 'reconciled', note: 'blind match' }]);
    return { status: 'match', d };
  }
  if (state.mismatches >= 1) {
    const [flagRow] = await stockTakesRepository.appendMany([{ ...base, result: 'flagged', note: `attempt ${state.mismatches + 1}` }]);
    return { status: 'flagged', d, flagRow };
  }
  await stockTakesRepository.appendMany([{ ...base, result: 'mismatch', note: 'attempt 1' }]);
  return { status: 'recount', d };
}

/** 🚩 flag → one card per admin with the counted vs book figures. */
async function notifyAdminsOfFlag(bot, { warehouse, location, design, bales, bundles, d, flagRow, auditor }) {
  let who = String(auditor);
  try { who = await require('../services/approvalCards').resolveUserLabel(auditor, bot); } catch (_) {}
  const text = `🚩 Stock audit flag — ${warehouse}${location ? ` (${location})` : ''}\n\n`
    + `Design ${design}\n`
    + `Counted: ${bales} bale${bales === 1 ? '' : 's'} + ${bundles} bundle${bundles === 1 ? '' : 's'}\n`
    + `Book: ${d.fullBales} bale${d.fullBales === 1 ? '' : 's'} + ${d.looseThans} bundle${d.looseThans === 1 ? '' : 's'} (${fmtQty(d.yards)} yds)\n`
    + `Counted by: ${who} (2 attempts, both off)\n\n`
    + `The design is LOCKED for re-audit today. Investigate physically, then clear the flag.`;
  const keyboard = { inline_keyboard: [[{ text: '✅ Clear flag (re-open audit)', callback_data: `wai:aclr:${flagRow.stocktake_id}` }]] };
  for (const adminId of config.access.adminIds) {
    try { await bot.sendMessage(adminId, text, { reply_markup: keyboard }); }
    catch (e) { logger.warn(`audit flag DM to ${adminId} failed: ${e.message}`); }
  }
  try {
    await auditLogRepository.append('stocktake_flagged',
      { warehouse, design, counted: `${bales}+${bundles}`, book: `${d.fullBales}+${d.looseThans}`, stocktake_id: flagRow.stocktake_id }, auditor);
  } catch (_) { /* best effort */ }
}

async function renderChecklist(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const list = await loadChecklist(session);
  if (!list.length) {
    await render(bot, chatId, userId,
      `🔍 ${session.warehouse}\n\nNo available stock in this warehouse.`,
      [backRow('⬅ Warehouses'), closeRow()]);
    return;
  }
  // WAU-3 BLIND LIST — no quantities anywhere (the auditor must count,
  // not confirm). Book numbers stay server-side in _checklist for the
  // reconcile comparison only.
  const state = await todayStateFor(session.warehouse);
  session._checklist = list.map((d) => ({ design: d.design, fullBales: d.fullBales, looseThans: d.looseThans, yards: d.yards, reconciled: d.reconciled }));
  sessionStore.set(userId, session);
  const done = list.filter((d) => d.reconciled).length;
  const rows = list.map((d, i) => {
    const s = state.get(String(d.design).toUpperCase()) || {};
    if (d.reconciled) return [{ text: `✅ ${d.design} (done ${d.reconciledAt})`, callback_data: 'wai:noop' }];
    if (s.locked) return [{ text: `🚩 ${d.design} — locked (admin review)`, callback_data: 'wai:noop' }];
    const icon = s.mismatches ? '🔁' : '⬜';
    return [{ text: `${icon} ${d.design}`, callback_data: `wai:ck:${i}` }];
  });
  rows.push([{ text: '📄 Offline count sheet', callback_data: 'wai:tmpl' }]);
  if (auth.isAdmin(userId)) rows.push([{ text: '🔬 Deep inspect (bale/than level)', callback_data: 'wai:inspect' }]);
  rows.push(backRow('⬅ Warehouses'));
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `🔍 ${session.warehouse} — ${session.location}\n`
    + `Reconciled ${done}/${list.length} designs\n\n`
    + 'Tap a design and enter what you PHYSICALLY count.\n'
    + 'Poor network in the store? Use 📄 Offline count sheet.', rows);
}

/* ───────────────────────── WAU-3: tap-pad count entry ───────────────────────── */

const PAD_MAX_LEN = 9;

function padRows() {
  const k = (c) => ({ text: c, callback_data: `wai:k:${c}` });
  return [
    [k('1'), k('2'), k('3')],
    [k('4'), k('5'), k('6')],
    [k('7'), k('8'), k('9')],
    [{ text: '➕', callback_data: 'wai:k:p' }, k('0'), { text: '⌫', callback_data: 'wai:k:b' }],
    [{ text: '✔ Done', callback_data: 'wai:padok' }],
    [{ text: '⬅ Back to list', callback_data: 'wai:padcx' }],
  ];
}

async function renderPad(bot, chatId, userId, note = '') {
  const session = sessionStore.get(userId);
  if (!session) return;
  await render(bot, chatId, userId,
    `🔍 ${session.warehouse} — Design ${session.countDesign}\n\n`
    + `Your count: ${session.padDraft || '—'}\n\n`
    + 'Tap the number of FULL bales; use ➕ for loose bundles.\n'
    + `Example: 12➕5 = 12 bales and 5 loose bundles.${note ? `\n\n${note}` : ''}`,
    padRows());
}

async function openPad(bot, chatId, userId, idx, query) {
  const session = sessionStore.get(userId);
  if (!session || session.step !== 'checklist') return;
  const d = (session._checklist || [])[idx];
  if (!d) return;
  if (d.reconciled) {
    await bot.answerCallbackQuery(query.id, { text: 'Already reconciled today.' }).catch(() => {});
    return;
  }
  const s = (await todayStateFor(session.warehouse)).get(String(d.design).toUpperCase());
  if (s && s.locked) {
    await bot.answerCallbackQuery(query.id, { text: '🚩 Locked until an admin clears the flag.', show_alert: true }).catch(() => {});
    return;
  }
  session.step = 'count_entry';
  session.countDesign = d.design;
  session.padDraft = '';
  sessionStore.set(userId, session);
  await renderPad(bot, chatId, userId);
}

async function handlePadKey(bot, chatId, userId, key, query) {
  const session = sessionStore.get(userId);
  if (!session || session.step !== 'count_entry') return;
  let draft = session.padDraft || '';
  if (key === 'b') draft = draft.slice(0, -1);
  else if (key === 'p') {
    if (!draft || draft.includes('+')) { await bot.answerCallbackQuery(query.id, { text: 'Bales first, then ➕.' }).catch(() => {}); return; }
    draft += '+';
  } else if (/^\d$/.test(key)) {
    if (draft.length >= PAD_MAX_LEN) { await bot.answerCallbackQuery(query.id).catch(() => {}); return; }
    draft += key;
  } else return;
  session.padDraft = draft;
  sessionStore.set(userId, session);
  await renderPad(bot, chatId, userId);
}

async function commitPadCount(bot, chatId, userId, query) {
  const session = sessionStore.get(userId);
  if (!session || session.step !== 'count_entry') return;
  const { parseCount } = require('../utils/auditCountParser');
  const count = parseCount(session.padDraft);
  if (!count.ok) {
    await bot.answerCallbackQuery(query.id, { text: count.error, show_alert: true }).catch(() => {});
    return;
  }
  const out = await reconcileDesign({
    warehouse: session.warehouse, location: session.location,
    design: session.countDesign, bales: count.bales, bundles: count.bundles, auditor: userId,
  });
  if (out.status === 'match' || out.status === 'already') {
    try {
      await auditLogRepository.append('stocktake_reconciled',
        { warehouse: session.warehouse, design: session.countDesign, mode: 'blind_tap' }, userId);
    } catch (_) { /* best effort */ }
    await bot.answerCallbackQuery(query.id, { text: `✅ ${session.countDesign} matches — reconciled.` }).catch(() => {});
    session.step = 'checklist';
    delete session.countDesign; delete session.padDraft;
    sessionStore.set(userId, session);
    await renderChecklist(bot, chatId, userId);
    return;
  }
  if (out.status === 'recount') {
    session.padDraft = '';
    sessionStore.set(userId, session);
    await renderPad(bot, chatId, userId,
      '⚠️ That does not match the book. Recount CAREFULLY and enter again — a second miss locks this design for admin review.');
    return;
  }
  if (out.status === 'flagged') {
    await notifyAdminsOfFlag(bot, {
      warehouse: session.warehouse, location: session.location, design: session.countDesign,
      bales: count.bales, bundles: count.bundles, d: out.d, flagRow: out.flagRow, auditor: userId,
    });
    session.step = 'checklist';
    delete session.countDesign; delete session.padDraft;
    sessionStore.set(userId, session);
    await render(bot, chatId, userId,
      `🚩 Design flagged for admin review\n\n`
      + 'Your two counts did not match the book. The admins have been notified '
      + 'with both figures and this design is locked for today.\n\n'
      + 'Continue with the other designs.',
      [[{ text: '⬅ Back to list', callback_data: 'wai:padcx' }]]);
    return;
  }
  await bot.answerCallbackQuery(query.id, { text: 'Could not reconcile — try again.', show_alert: true }).catch(() => {});
}

/* ───────────────────────── WAU-3: offline batch template ───────────────────────── */

async function sendOfflineTemplate(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const state = await todayStateFor(session.warehouse);
  const open = (session._checklist || []).filter((d) => {
    const s = state.get(String(d.design).toUpperCase());
    return !d.reconciled && !(s && s.locked);
  });
  if (!open.length) {
    await bot.sendMessage(chatId, 'Nothing left to count here — every design is reconciled or locked.');
    return;
  }
  const template = `AUDIT ${session.warehouse}\n${open.map((d) => `${d.design} =`).join('\n')}`;
  await bot.sendMessage(chatId, template);
  await bot.sendMessage(chatId,
    '📄 Your offline count sheet (message above).\n\n'
    + '1. Long-press it → Copy.\n'
    + '2. Walk the store with NO network — paste it into the message box and fill each line: 9032 = 12+5 (bales+bundles). Leave lines you did not count empty.\n'
    + '3. Press send when you are back in coverage — Telegram delivers it automatically and I reply with the results.');
}

/**
 * Stateless offline batch: "AUDIT <warehouse>" + one line per design.
 * Works with NO session (the message may arrive hours later, after the
 * outbox flushes) — the header carries everything needed.
 */
async function handleBatchText(bot, msg) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  if (!config.warehouseAudit || !config.warehouseAudit.enabled) return false;
  const { parseAuditBatch } = require('../utils/auditCountParser');
  const warehouses = await inventoryRepository.getWarehouses();
  const parsed = parseAuditBatch(msg.text, warehouses);
  if (!parsed.ok) {
    await bot.sendMessage(chatId, `⚠️ ${parsed.error}`);
    return true;
  }
  const location = await locationOf(parsed.warehouse);
  const matched = [];
  const recount = [];
  const flagged = [];
  const locked = [];
  const unknown = [];
  for (const e of parsed.entries) {
    const out = await reconcileDesign({
      warehouse: parsed.warehouse, location, design: e.design,
      bales: e.bales, bundles: e.bundles, auditor: userId,
    });
    if (out.status === 'match' || out.status === 'already') matched.push(e.design);
    else if (out.status === 'recount') recount.push(e.design);
    else if (out.status === 'locked') locked.push(e.design);
    else if (out.status === 'unknown_design') unknown.push(e.design);
    else if (out.status === 'flagged') {
      flagged.push(e.design);
      await notifyAdminsOfFlag(bot, {
        warehouse: parsed.warehouse, location, design: e.design,
        bales: e.bales, bundles: e.bundles, d: out.d, flagRow: out.flagRow, auditor: userId,
      });
    }
  }
  try {
    await auditLogRepository.append('stocktake_batch',
      { warehouse: parsed.warehouse, matched: matched.length, recount: recount.length, flagged: flagged.length }, userId);
  } catch (_) { /* best effort */ }
  let reply = `🔍 Audit results — ${parsed.warehouse}\n`;
  if (matched.length) reply += `\n✅ Reconciled (${matched.length}): ${matched.join(', ')}`;
  if (recount.length) reply += `\n🔁 Did NOT match — recount these and send a new AUDIT message with just them:\n${recount.map((d) => `${d} =`).join('\n')}`;
  if (flagged.length) reply += `\n🚩 Flagged for admin review (locked today): ${flagged.join(', ')}`;
  if (locked.length) reply += `\n🔒 Already locked (admin review pending): ${locked.join(', ')}`;
  if (unknown.length) reply += `\n❓ Not found in ${parsed.warehouse}: ${unknown.join(', ')}`;
  if (parsed.skipped.length) reply += `\n⬜ Left blank (${parsed.skipped.length}): ${parsed.skipped.join(', ')}`;
  if (parsed.errors.length) reply += `\n⚠️ ${parsed.errors.join('\n⚠️ ')}`;
  if (!parsed.entries.length) reply += '\nNo counts were filled in — fill the lines like: 9032 = 12+5';
  await bot.sendMessage(chatId, reply);
  return true;
}

/** Admin clears a 🚩 flag from the DM card (session-free). */
async function handleFlagClear(bot, query) {
  const adminId = String(query.from.id);
  if (!auth.isAdmin(adminId)) {
    await bot.answerCallbackQuery(query.id, { text: 'Only admins can clear audit flags.' }).catch(() => {});
    return true;
  }
  const takeId = query.data.slice('wai:aclr:'.length);
  const row = await stockTakesRepository.getById(takeId);
  if (!row || row.result !== 'flagged') {
    await bot.answerCallbackQuery(query.id, { text: 'Flag not found (already cleared?).' }).catch(() => {});
    return true;
  }
  await stockTakesRepository.appendMany([{
    warehouse: row.warehouse, location: row.location, design: row.design,
    sheet_bales: row.sheet_bales, sheet_bundles: row.sheet_bundles, sheet_yards: row.sheet_yards,
    result: 'flag_cleared', auditor: adminId, note: `cleared ${takeId}`,
  }]);
  try {
    await auditLogRepository.append('stocktake_flag_cleared', { warehouse: row.warehouse, design: row.design, stocktake_id: takeId }, adminId);
  } catch (_) { /* best effort */ }
  await bot.answerCallbackQuery(query.id, { text: '✅ Flag cleared — design re-opened for audit.' }).catch(() => {});
  try {
    await bot.editMessageText(
      `✅ Flag cleared — ${row.warehouse} design ${row.design} re-opened for audit.`,
      { chat_id: query.message.chat.id, message_id: query.message.message_id });
  } catch (_) { /* stale card */ }
  return true;
}

/* ───────────────────────────── warehouse ───────────────────────────── */

async function renderWarehousePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  // WAU-2: only this location's warehouses.
  const warehouses = (session._locWarehouses && session._locWarehouses[session.location]) || [];
  if (!warehouses.length) {
    session.step = 'pick_location';
    sessionStore.set(userId, session);
    await renderLocationPicker(bot, chatId, userId);
    return;
  }
  if (warehouses.length === 1) {
    session.warehouse = warehouses[0];
    session.auditMode = await getAuditMode(warehouses[0]);
    session.step = 'checklist';
    session._checked = {};
    sessionStore.set(userId, session);
    await renderChecklist(bot, chatId, userId);
    return;
  }
  session._warehouses = warehouses;
  sessionStore.set(userId, session);
  // Warehouses are usually few (2–3) and have long names; keep one per row
  // so the names don't get truncated on phone screens.
  const rows = warehouses.map((w, i) => ([{ text: `🏬 ${w}`, callback_data: `wai:wh:${i}` }]));
  rows.push(backRow('⬅ Locations'));
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `🔍 Warehouse Audit — 📍 ${session.location}\n\nSelect the warehouse to audit:`, rows);
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
  // Designs render as 2-col tiles (compact, like the marketer view) so
  // long lists don't scroll forever.
  const tiles = list.slice(0, MAX_DESIGNS).map((d, i) => ({
    text: `🎨 ${d.design} · ${d.bales.size}b · ${d.shades.size}sh`,
    callback_data: `wai:design:${i}`,
  }));
  const rows = chunkButtons(tiles, TILES_PER_ROW);
  const more = list.length > MAX_DESIGNS ? `\n\n(+${list.length - MAX_DESIGNS} more — narrow by warehouse)` : '';
  rows.push(backRow('⬅ Warehouses'));
  rows.push(closeRow());
  const modeChip = session.auditMode === AUDIT_MODE_THAN ? 'than-mode' : 'bale-mode';
  await render(bot, chatId, userId,
    `🔍 ${session.warehouse} · ${modeChip}\n\nPick a design:${more}`, rows);
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
  // 2-col tile grid mirrors the marketer view's compact look. Labels are
  // shortened to "<chip> <shade> (Nb · Nt)" so two tiles fit per row.
  const tiles = list.slice(0, MAX_SHADES).map((s, i) => {
    let chip = '🎨';
    try { chip = shadesRepository.chipFromList(shadesList, s.shade) || '🎨'; } catch (_) { /* keep default */ }
    return {
      text: `${chip} ${s.shade} (${s.bales.size}b · ${s.thans}t)`,
      callback_data: `wai:shade:${i}`,
    };
  });
  const rows = chunkButtons(tiles, TILES_PER_ROW);
  rows.push(backRow('⬅ Designs'));
  rows.push(closeRow());
  const modeChip = session.auditMode === AUDIT_MODE_THAN ? 'than-mode' : 'bale-mode';
  await render(bot, chatId, userId,
    `🔍 ${session.design} — ${session.warehouse} · ${modeChip}\n\nPick a shade:`, rows);
}

/* ───────────────────────────── bale list ───────────────────────────── */

/**
 * Build the bale list for the current warehouse+design+shade. Bales with
 * zero available thans are excluded — audit only inspects what the system
 * believes is physically present. Order is currently the natural read
 * order from the sheet (random / by row); ordering by physical pull-out
 * is deferred until layout in the warehouse warrants it.
 * @returns {Promise<Array<{packageNo:string,total:number,available:number,yards:number,availableYards:number,binLocation:string}>>}
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
        availableYards: 0, binLocation: r.binLocation || '',
      });
    }
    const e = byPkg.get(r.packageNo);
    e.total += 1;
    e.yards += r.yards;
    if (r.status === 'available') { e.available += 1; e.availableYards += r.yards; }
  }
  // Drop bales with no available thans — they're already fully sold and
  // outside the audit's scope (point #3: hide sold).
  return Array.from(byPkg.values()).filter((b) => b.available > 0);
}

async function renderBaleList(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const bales = await loadBales(session);
  if (!bales.length) {
    await render(bot, chatId, userId,
      `🔍 ${session.design} · ${session.shade}\n\nNo bales with available thans.`,
      [backRow('⬅ Shades'), closeRow()]);
    return;
  }
  session._bales = bales.map((b) => ({ packageNo: b.packageNo, total: b.total, available: b.available }));
  // Single-bale shade: skip the list. In than-mode go straight to the
  // than card; in bale-mode go to the Closed/Open prompt.
  if (bales.length === 1) {
    session.skippedBaleList = true;
    session.packageNo = bales[0].packageNo;
    if (session.auditMode === AUDIT_MODE_BALE) {
      session.step = 'bale_choice';
      sessionStore.set(userId, session);
      await renderBaleChoice(bot, chatId, userId);
    } else {
      session.step = 'view_than';
      sessionStore.set(userId, session);
      await renderThanCard(bot, chatId, userId);
    }
    return;
  }
  session.skippedBaleList = false;
  sessionStore.set(userId, session);

  const totThans = bales.reduce((s, b) => s + b.available, 0);
  const totYards = bales.reduce((s, b) => s + b.availableYards, 0);
  const tiles = bales.map((b, i) => {
    const state = baleAuditState(session, b.packageNo, b.available);
    const prefix = state === 'verified' ? '✅' : state === 'in_progress' ? '🔍' : '📦';
    return {
      text: `${prefix} ${b.packageNo} · ${b.available}/${b.total} · ${fmtQty(b.availableYards)}y`,
      callback_data: `wai:bale:${i}`,
    };
  });
  const rows = chunkButtons(tiles, TILES_PER_ROW);
  rows.push([{ text: '📋 Reconciliation', callback_data: 'wai:recon' }]);
  rows.push(backRow('⬅ Shades'));
  rows.push(closeRow());
  const modeChip = session.auditMode === AUDIT_MODE_THAN ? 'than-mode' : 'bale-mode';
  const hint = session.auditMode === AUDIT_MODE_BALE
    ? 'Tap a bale to mark it Closed or Open.'
    : 'Tap a bale to inspect its thans.';
  await render(bot, chatId, userId,
    `🔍 ${session.design} · ${session.shade} — ${session.warehouse} · ${modeChip}\n`
    + `${bales.length} bales · ${totThans} thans · ${fmtQty(totYards)} yds available\n\n`
    + hint, rows);
}

/**
 * Bale-mode prompt: ask whether the physical bale is Closed (sealed, all
 * available thans implicitly verified) or Open (drill into the than card
 * for that one bale). Only used when session.auditMode === 'bale'.
 */
async function renderBaleChoice(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const summary = await inventoryService.getPackageSummary(session.packageNo);
  if (!summary) {
    await render(bot, chatId, userId,
      `🔍 Bale ${session.packageNo} not found.`,
      [backRow(session.skippedBaleList ? '⬅ Shades' : '⬅ Bales'), closeRow()]);
    return;
  }
  const head =
    `📦 Bale ${summary.packageNo} — ${summary.design} · ${summary.shade}\n`
    + `Indent: ${summary.indent || '—'} · ${summary.warehouse}\n`
    + `System: ${summary.availableThans} thans · ${fmtQty(summary.availableYards)} yds available\n\n`
    + 'Is this bale physically:';
  const rows = [
    [{ text: `✅ Closed (sealed, all ${summary.availableThans} present)`, callback_data: 'wai:closed' }],
    [{ text: '🟠 Open (some thans missing)', callback_data: 'wai:open' }],
    backRow(session.skippedBaleList ? '⬅ Shades' : '⬅ Bales'),
    closeRow(),
  ];
  await render(bot, chatId, userId, head, rows);
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
      [backRow(thanCardBackLabel(session)), closeRow()]);
    return;
  }
  // Audit only inspects what the system says is on the shelf — sold thans
  // are hidden entirely (point #3). Mark counters tally the available set.
  const availableThans = summary.thans.filter((t) => t.status === 'available');
  let present = 0; let missing = 0; let unmarked = 0;
  const chipRows = [];
  let row = [];
  for (const t of availableThans) {
    const icon = markIcon(session, summary.packageNo, t.thanNo, t.status);
    const m = session.marks[`${summary.packageNo}|${t.thanNo}`];
    if (m === MARK_PRESENT) present += 1;
    else if (m === MARK_MISSING) missing += 1;
    else unmarked += 1;
    row.push({ text: `${icon} #${t.thanNo} ${fmtQty(t.yards)}y`, callback_data: `wai:than:${t.thanNo}` });
    if (row.length === THANS_PER_ROW) { chipRows.push(row); row = []; }
  }
  if (row.length) chipRows.push(row);

  const header =
    `📦 Bale ${summary.packageNo} — ${summary.design} · ${summary.shade}\n`
    + `Indent: ${summary.indent || '—'} · ${summary.warehouse}\n`
    + (summary.pricePerYard ? `Price: ₦${fmtQty(summary.pricePerYard)}/yard\n` : '')
    + '\nTap a than: ⬜ → ✅ present → ❌ missing\n'
    + `Available: ${summary.availableThans} thans · ${fmtQty(summary.availableYards)} yds\n`
    + `Verified — ✅ ${present} · ❌ ${missing} · ⬜ ${unmarked} unchecked`;

  const rows = chipRows.slice();
  rows.push([{ text: '📋 Reconciliation', callback_data: 'wai:recon' }]);
  rows.push(backRow(thanCardBackLabel(session)));
  rows.push(closeRow());
  await render(bot, chatId, userId, header, rows);
}

/**
 * Back-button label for the than card. Depends on (a) whether the bale
 * list was skipped, (b) whether we entered via a bale-mode Open drill.
 */
function thanCardBackLabel(session) {
  if (session && session.auditMode === AUDIT_MODE_BALE) return '⬅ Bale';
  if (session && session.skippedBaleList) return '⬅ Shades';
  return '⬅ Bales';
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
    case 'pick_warehouse':
      session.step = 'pick_location';
      session.warehouse = '';
      sessionStore.set(userId, session);
      await renderLocationPicker(bot, chatId, userId);
      break;
    case 'checklist':
      session.step = 'pick_warehouse';
      session.warehouse = '';
      session._checked = {};
      sessionStore.set(userId, session);
      await renderWarehousePicker(bot, chatId, userId);
      break;
    case 'pick_design':
      // WAU-2: the deep-inspect design picker returns to the checklist.
      session.step = 'checklist';
      session.design = '';
      sessionStore.set(userId, session);
      await renderChecklist(bot, chatId, userId);
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
    case 'bale_choice':
      // Back from the Closed/Open prompt: to the bale list (or shades
      // when the list was skipped because the shade had only one bale).
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
    case 'view_than':
      if (session.auditMode === AUDIT_MODE_BALE) {
        // In bale-mode the than card is the Open drill-down for one bale,
        // so back returns to that bale's Closed/Open prompt.
        session.step = 'bale_choice';
        sessionStore.set(userId, session);
        await renderBaleChoice(bot, chatId, userId);
      } else if (session.skippedBaleList) {
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

  // WAU-3 — flag-clear taps come from an admin's DM card, hours later,
  // with NO audit session. Handle before the session guard.
  if (data.startsWith('wai:aclr:')) return handleFlagClear(bot, query);

  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return false;

  // Pad taps answer their own callback (they often need toast text).
  if (data.startsWith('wai:k:')) { await handlePadKey(bot, chatId, userId, data.slice('wai:k:'.length), query); return true; }
  if (data === 'wai:padok') { await commitPadCount(bot, chatId, userId, query); return true; }
  if (data === 'wai:padcx') {
    try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
    session.step = 'checklist';
    delete session.countDesign; delete session.padDraft;
    sessionStore.set(userId, session);
    await renderChecklist(bot, chatId, userId);
    return true;
  }
  if (data === 'wai:tmpl') {
    try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
    await sendOfflineTemplate(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('wai:ck:')) {
    await openPad(bot, chatId, userId, parseInt(data.slice('wai:ck:'.length), 10), query);
    return true;
  }

  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }

  if (data === 'wai:noop') return true;

  if (data === 'wai:close') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '🔍 Audit closed.', [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return true;
  }

  if (data === 'wai:back') { await stepBack(bot, chatId, userId); return true; }

  if (data === 'wai:recon') { await renderReconciliation(bot, chatId, userId); return true; }

  if (data.startsWith('wai:loc:')) {
    const i = parseInt(data.slice('wai:loc:'.length), 10);
    const loc = (session._locations || [])[i];
    if (loc) {
      session.location = loc;
      session.step = 'pick_warehouse';
      sessionStore.set(userId, session);
      await renderWarehousePicker(bot, chatId, userId);
    }
    return true;
  }

  if (data.startsWith('wai:wh:')) {
    const i = parseInt(data.slice('wai:wh:'.length), 10);
    const wh = (session._warehouses || [])[i];
    if (wh) {
      session.warehouse = wh;
      session.auditMode = await getAuditMode(wh);
      session.step = 'checklist';
      session._checked = {};
      sessionStore.set(userId, session);
      await renderChecklist(bot, chatId, userId);
    }
    return true;
  }

  // WAU-3 — the checkbox/submit path is retired (replaced by the blind
  // tap-pad; wai:ck now opens the pad, handled above). Deep inspect
  // reveals book quantities, so it is ADMIN-ONLY in the blind flow.
  if (data === 'wai:inspect') {
    if (session.step !== 'checklist') return true;
    if (!auth.isAdmin(userId)) return true;
    session.step = 'pick_design';
    sessionStore.set(userId, session);
    await renderDesignPicker(bot, chatId, userId);
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
      if (session.auditMode === AUDIT_MODE_BALE) {
        session.step = 'bale_choice';
        sessionStore.set(userId, session);
        await renderBaleChoice(bot, chatId, userId);
      } else {
        session.step = 'view_than';
        sessionStore.set(userId, session);
        await renderThanCard(bot, chatId, userId);
      }
    }
    return true;
  }

  if (data === 'wai:closed') {
    // Bale-mode shortcut: bale is sealed → mark all available thans of
    // this bale as ✅ present implicitly, then go back to the bale list
    // (or shades, if the list was skipped). NO inventory writes — pure
    // session state, like every other mark in this flow.
    if (session.auditMode !== AUDIT_MODE_BALE || !session.packageNo) return true;
    const summary = await inventoryService.getPackageSummary(session.packageNo);
    if (summary) {
      for (const t of summary.thans) {
        if (t.status === 'available') {
          session.marks[`${session.packageNo}|${t.thanNo}`] = MARK_PRESENT;
        }
      }
    }
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
    return true;
  }

  if (data === 'wai:open') {
    // Bale-mode drill-down: bale is partially open → fall into the
    // than-card view restricted to this single bale's available thans.
    if (session.auditMode !== AUDIT_MODE_BALE || !session.packageNo) return true;
    session.step = 'view_than';
    sessionStore.set(userId, session);
    await renderThanCard(bot, chatId, userId);
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
  handleBatchText,
  _internals: {
    renderLocationPicker, renderChecklist, loadChecklist, locationOf,
    reconcileDesign, todayStateFor, sendOfflineTemplate,
    renderWarehousePicker, renderDesignPicker, renderShadePicker,
    renderBaleList, renderBaleChoice, renderThanCard, renderReconciliation,
    stepBack, loadBales, markIcon, getAuditMode, baleAuditState, chunkButtons,
    SESSION_TYPE, AUDIT_MODE_THAN, AUDIT_MODE_BALE, AUDIT_MODE_KEY_PREFIX,
  },
};
