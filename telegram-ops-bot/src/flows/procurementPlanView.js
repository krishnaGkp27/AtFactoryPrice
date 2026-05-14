/**
 * Procurement Plan view (P4).
 *
 * Admin-only read view + drafting flow for purchase orders.
 *
 * Surfaces:
 *   📊 Low-stock alerts        — distinct (design, shade) where total
 *                                 available bales < LOW_STOCK_THRESHOLD
 *                                 (from Settings; default 5)
 *   🛒 Open Procurement Orders — POs not in terminal states
 *
 * Actions:
 *   ➕ New Procurement Order  → multi-line drafting flow
 *   📥 Receive Goods (PO-x)   → jumps to GRN flow with PO context (P2)
 *   📄 PO details             → header + lines + received progress
 *
 * Callback namespace: `pp:*`
 *   pp:open                  re-render the main view
 *   pp:po:<po_id>            open detail card for a PO
 *   pp:new                   start the New PO drafting flow
 *   pp:new_sup:<contact_id>  pick supplier
 *   pp:new_sup_none          create supplier inline
 *   pp:new_dg_done           done adding lines, ask expected date
 *   pp:new_dt:<offset>       pick expected date offset (today+N days)
 *   pp:new_submit            final submit
 *   pp:new_cancel            abandon
 *   pp:receive:<po_id>       jump into GRN flow with PO pre-selected
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const inventoryRepository = require('../repositories/inventoryRepository');
const procurementOrdersRepo = require('../repositories/procurementOrdersRepository');
const contactsRepository = require('../repositories/contactsRepository');
const settingsRepository = require('../repositories/settingsRepository');
const auth = require('../middlewares/auth');
const config = require('../config');
const logger = require('../utils/logger');
const { editOrSend } = require('../utils/telegramUI');
const { fmtQty } = require('../utils/format');

const DEFAULT_LOW_STOCK_THRESHOLD = 5; // bales

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function backRow() {
  return [
    { text: '⬅ Back to Admin', callback_data: 'act:__hub__:admin' },
    { text: '🏠 Menu',          callback_data: 'act:__back__' },
  ];
}

async function getLowStockThreshold() {
  try {
    const all = await settingsRepository.getAll();
    const n = parseInt(all.LOW_STOCK_THRESHOLD, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) { /* fall through */ }
  return DEFAULT_LOW_STOCK_THRESHOLD;
}

/**
 * Compute low-stock alerts: distinct (design, shade) groups with total
 * available bales below the threshold.
 */
async function computeLowStock(threshold) {
  const all = await inventoryRepository.getAll();
  const groups = new Map();
  for (const r of all) {
    if (r.status !== 'available') continue;
    const key = `${(r.design || '').trim()}|${(r.shade || '').trim()}`;
    if (!groups.has(key)) groups.set(key, { design: r.design, shade: r.shade, bales: 0, yards: 0 });
    const g = groups.get(key);
    g.bales += 1;
    g.yards += r.yards || 0;
  }
  const lows = [];
  for (const g of groups.values()) {
    if (g.bales < threshold) lows.push(g);
  }
  lows.sort((a, b) => a.bales - b.bales);
  return lows;
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

async function showPlan(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId)) {
    await editOrSend(bot, chatId, messageId,
      '🔒 Procurement Plan is admin-only.',
      { reply_markup: { inline_keyboard: [backRow()] } });
    return;
  }
  const threshold = await getLowStockThreshold();
  const lows = await computeLowStock(threshold);
  const openPOs = await procurementOrdersRepo.getOpen();

  const lines = ['📋 *Procurement Plan*', ''];
  lines.push(`_Low-stock threshold: < ${threshold} bales · change with /setlowstock N_`, '');

  lines.push(`📊 *Low-stock alerts* (${lows.length})`);
  if (!lows.length) {
    lines.push('   _All designs above threshold._');
  } else {
    for (const l of lows.slice(0, 8)) {
      const shadeLabel = l.shade ? ` / ${l.shade}` : '';
      const flag = l.bales === 0 ? ' 🚨' : (l.bales <= 1 ? ' ⚠️' : '');
      lines.push(`   • *${l.design}*${shadeLabel} — ${l.bales} bale${l.bales === 1 ? '' : 's'} (${fmtQty(l.yards, { maxFraction: 0 })} yds)${flag}`);
    }
    if (lows.length > 8) lines.push(`   _…and ${lows.length - 8} more_`);
  }
  lines.push('');

  lines.push(`🛒 *Open Procurement Orders* (${openPOs.length})`);
  if (!openPOs.length) {
    lines.push('   _No open POs._');
  } else {
    for (const p of openPOs.slice(0, 8)) {
      const exp = p.expected_date ? ` · exp ${p.expected_date}` : '';
      lines.push(`   • \`${p.po_id}\` · ${p.supplier || '_no supplier_'}${exp} · ${p.status}`);
    }
    if (openPOs.length > 8) lines.push(`   _…and ${openPOs.length - 8} more_`);
  }

  const rows = [];
  rows.push([{ text: '➕ New Procurement Order', callback_data: 'pp:new' }]);
  for (const p of openPOs.slice(0, 4)) {
    rows.push([
      { text: `📄 ${p.po_id}`,           callback_data: `pp:po:${p.po_id}` },
      { text: `📥 Receive (${p.po_id})`, callback_data: `pp:receive:${p.po_id}` },
    ]);
  }
  rows.push(backRow());

  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

// ---------------------------------------------------------------------------
// PO detail card
// ---------------------------------------------------------------------------

async function showPODetail(bot, chatId, userId, messageId, poId) {
  if (!auth.isAdmin(userId)) return;
  const header = await procurementOrdersRepo.getById(poId);
  if (!header) {
    await editOrSend(bot, chatId, messageId, `❌ PO \`${poId}\` not found.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [backRow()] } });
    return;
  }
  const lines = await procurementOrdersRepo.getLines(poId);
  const out = [];
  out.push(`📄 *${header.po_id}*`);
  out.push(`Supplier: *${header.supplier || '_none_'}*`);
  if (header.expected_date) out.push(`Expected: *${header.expected_date}*`);
  out.push(`Status: *${header.status}*`);
  if (header.notes) out.push(`Notes: ${header.notes}`);
  out.push('');
  out.push(`*Lines* (${lines.length})`);
  if (!lines.length) {
    out.push('  _No lines._');
  } else {
    for (const l of lines) {
      const shadeLabel = l.shade ? ` / ${l.shade}` : '';
      const recv = l.received_bales > 0
        ? `  → recv ${l.received_bales}/${l.qty_bales}`
        : '';
      out.push(`  • *${l.design}*${shadeLabel} — ${l.qty_bales} bales${recv}`);
    }
  }
  const buttons = [];
  const open = new Set(['draft', 'sent', 'partially_received']);
  if (open.has(header.status)) {
    buttons.push([{ text: '📥 Receive against this PO', callback_data: `pp:receive:${poId}` }]);
  }
  buttons.push([{ text: '⬅ Plan',  callback_data: 'pp:open' }, ...backRow()]);
  await editOrSend(bot, chatId, messageId, out.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons },
  });
}

// ---------------------------------------------------------------------------
// New PO drafting flow
// ---------------------------------------------------------------------------

function newPOHeader(s) {
  const parts = ['🛒 *New Procurement Order*'];
  if (s.supplier) parts.push(`✓ Supplier: *${s.supplier}*`);
  if (s.lines && s.lines.length) {
    parts.push(`✓ Lines: *${s.lines.length}*`);
    for (const l of s.lines.slice(0, 5)) {
      parts.push(`   • ${l.design}${l.shade ? ' / ' + l.shade : ''} — ${l.qty_bales} bales`);
    }
    if (s.lines.length > 5) parts.push(`   _…and ${s.lines.length - 5} more_`);
  }
  if (s.expected_date) parts.push(`✓ Expected: *${s.expected_date}*`);
  return parts.join('\n');
}

async function renderNewPO(bot, chatId, userId, prompt, rows) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const text = newPOHeader(session) + '\n\n' + prompt;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  const mid = session.flowMessageId;
  if (mid) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...opts });
      return;
    } catch (_) { /* fall through */ }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  session.flowMessageId = sent.message_id;
  sessionStore.set(userId, session);
}

async function startNewPO(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId)) return;
  sessionStore.set(userId, {
    type: 'po_new_flow', step: 'supplier',
    flowMessageId: messageId || null,
    supplier: '', supplier_id: '',
    lines: [],
    expected_date: '',
  });
  await showSupplierPickerPO(bot, chatId, userId);
}

async function showSupplierPickerPO(bot, chatId, userId) {
  const suppliers = await contactsRepository.getByType('supplier');
  const rows = [];
  for (const s of suppliers.slice(0, 12)) {
    rows.push([{ text: `🏢 ${s.name}`, callback_data: `pp:new_sup:${s.contact_id}` }]);
  }
  rows.push([{ text: '✏️ Type supplier name', callback_data: 'pp:new_sup_text' }]);
  rows.push([{ text: '❌ Cancel', callback_data: 'pp:new_cancel' }]);
  await renderNewPO(bot, chatId, userId, 'Select the *supplier*:', rows);
}

async function askLineDesign(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  session.step = 'line_design';
  sessionStore.set(userId, session);
  const distinct = await inventoryRepository.getDistinctDesigns();
  const designs = Array.from(new Set(distinct.map((d) => (d.design || '').trim()).filter(Boolean))).sort();
  const rows = [];
  for (let i = 0; i < Math.min(designs.length, 12); i += 2) {
    const row = [{ text: designs[i], callback_data: `pp:new_dg:${designs[i]}` }];
    if (designs[i + 1]) row.push({ text: designs[i + 1], callback_data: `pp:new_dg:${designs[i + 1]}` });
    rows.push(row);
  }
  rows.push([{ text: '✏️ Type design name', callback_data: 'pp:new_dg_text' }]);
  if (session.lines.length) {
    rows.push([{ text: '✅ Done adding lines', callback_data: 'pp:new_dg_done' }]);
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'pp:new_cancel' }]);
  await renderNewPO(bot, chatId, userId,
    session.lines.length ? `Add another line — pick *design* (or tap Done):` : 'Pick the *design* for the first line:',
    rows);
}

async function askLineShade(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  session.step = 'line_shade';
  sessionStore.set(userId, session);
  const all = await inventoryRepository.getAll();
  const shades = Array.from(
    new Set(all.filter((r) => (r.design || '').trim() === (session._pending_design || '').trim() && r.shade).map((r) => r.shade))
  ).sort();
  const rows = [];
  for (let i = 0; i < Math.min(shades.length, 12); i += 2) {
    const row = [{ text: shades[i], callback_data: `pp:new_sh:${shades[i]}` }];
    if (shades[i + 1]) row.push({ text: shades[i + 1], callback_data: `pp:new_sh:${shades[i + 1]}` });
    rows.push(row);
  }
  rows.push([{ text: '✏️ Type shade name', callback_data: 'pp:new_sh_text' }]);
  rows.push([{ text: '🚫 No shade',        callback_data: 'pp:new_sh_none' }]);
  rows.push([{ text: '❌ Cancel',          callback_data: 'pp:new_cancel' }]);
  await renderNewPO(bot, chatId, userId, `Pick *shade* for "${session._pending_design}":`, rows);
}

async function askLineQty(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  session.step = 'line_qty';
  sessionStore.set(userId, session);
  const rows = [
    [
      { text: '5 bales',  callback_data: 'pp:new_qty:5'  },
      { text: '10 bales', callback_data: 'pp:new_qty:10' },
      { text: '20 bales', callback_data: 'pp:new_qty:20' },
    ],
    [
      { text: '30 bales', callback_data: 'pp:new_qty:30' },
      { text: '50 bales', callback_data: 'pp:new_qty:50' },
      { text: '✏️ Custom', callback_data: 'pp:new_qty_text' },
    ],
    [{ text: '❌ Cancel', callback_data: 'pp:new_cancel' }],
  ];
  const shadeLabel = session._pending_shade ? ` / ${session._pending_shade}` : '';
  await renderNewPO(bot, chatId, userId,
    `Pick *qty bales* for ${session._pending_design}${shadeLabel}:`, rows);
}

async function askExpectedDate(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  session.step = 'expected';
  sessionStore.set(userId, session);
  const rows = [
    [
      { text: '7 days',  callback_data: 'pp:new_dt:7'  },
      { text: '14 days', callback_data: 'pp:new_dt:14' },
      { text: '30 days', callback_data: 'pp:new_dt:30' },
    ],
    [
      { text: '⏭ Skip date',  callback_data: 'pp:new_dt:skip' },
      { text: '✏️ Type date', callback_data: 'pp:new_dt_text' },
    ],
    [{ text: '❌ Cancel', callback_data: 'pp:new_cancel' }],
  ];
  await renderNewPO(bot, chatId, userId, 'When is delivery *expected*?', rows);
}

async function showPOConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  session.step = 'confirm';
  sessionStore.set(userId, session);
  const totalBales = (session.lines || []).reduce((s, l) => s + (l.qty_bales || 0), 0);
  const out = [];
  out.push('*Review and submit*');
  out.push('');
  out.push(`Supplier: *${session.supplier || '_none_'}*`);
  out.push(`Expected: ${session.expected_date || '_unspecified_'}`);
  out.push('');
  out.push(`*Lines* (${session.lines.length}, total ${totalBales} bales)`);
  for (const l of session.lines) {
    out.push(`  • ${l.design}${l.shade ? ' / ' + l.shade : ''} — ${l.qty_bales} bales`);
  }
  const rows = [
    [{ text: '✅ Submit', callback_data: 'pp:new_submit' }],
    [{ text: '❌ Cancel', callback_data: 'pp:new_cancel' }],
  ];
  await renderNewPO(bot, chatId, userId, out.join('\n'), rows);
}

async function submitNewPO(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'po_new_flow') return;
  const header = await procurementOrdersRepo.appendHeader({
    supplier: session.supplier === '__none__' ? '' : session.supplier,
    supplier_id: session.supplier_id || '',
    expected_date: session.expected_date || '',
    status: procurementOrdersRepo.STATUSES.SENT,
    created_by: String(userId),
  });
  if (session.lines && session.lines.length) {
    await procurementOrdersRepo.appendLines(header.po_id, session.lines.map((l) => ({
      design: l.design,
      shade: l.shade === '__none__' ? '' : l.shade,
      qty_bales: l.qty_bales,
      qty_yards: (l.qty_bales || 0) * 50, // default 50 yds/bale; revisable later
    })));
  }
  sessionStore.clear(userId);
  await renderNewPO(bot, chatId, userId,
    `✅ *Created* \`${header.po_id}\`\n\n_Tap "📥 Receive" against this PO once goods arrive — the GRN flow will pre-fill the supplier + design._`,
    [
      [{ text: '📄 Open PO', callback_data: `pp:po:${header.po_id}` }],
      [{ text: '📋 Procurement Plan', callback_data: 'pp:open' }],
      backRow(),
    ],
  );

  // Broadcast PO creation through the admin feed (respects per-admin opt-in).
  try {
    const adminFeed = require('../services/adminFeed');
    const totalBales = (session.lines || []).reduce((s, l) => s + (l.qty_bales || 0), 0);
    const text = `🛒 *New Procurement Order*\n\`${header.po_id}\` · ${header.supplier || '_no supplier_'}\n${session.lines.length} line${session.lines.length === 1 ? '' : 's'} · ${totalBales} bales total${header.expected_date ? '\nExpected: ' + header.expected_date : ''}`;
    await adminFeed.notify(bot, 'po.created', text, { parse_mode: 'Markdown' }, { excludeUserId: userId });
  } catch (e) {
    logger.warn(`procurementPlanView.submitNewPO: feed broadcast failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Callback dispatcher + text dispatcher
// ---------------------------------------------------------------------------

async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('pp:')) return false;
  try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) { /* noop */ }
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  if (data === 'pp:open') { await showPlan(bot, chatId, userId, messageId); return true; }
  if (data.startsWith('pp:po:'))      { await showPODetail(bot, chatId, userId, messageId, data.slice('pp:po:'.length)); return true; }
  if (data === 'pp:new')              { await startNewPO(bot, chatId, userId, messageId); return true; }
  if (data === 'pp:new_cancel') {
    sessionStore.clear(userId);
    await editOrSend(bot, chatId, messageId, '❌ Cancelled.', {});
    return true;
  }
  if (data.startsWith('pp:receive:')) {
    // Hand off to GRN flow with a pre-pinned po_id. The GRN flow reads this
    // from session and skips/auto-fills the relevant steps.
    const poId = data.slice('pp:receive:'.length);
    const grnFlow = require('./goodsReceiptFlow');
    sessionStore.clear(userId);
    await grnFlow.start(bot, chatId, userId, messageId);
    const s = sessionStore.get(userId);
    if (s && s.type === 'grn_flow') {
      s.po_id = poId;
      sessionStore.set(userId, s);
    }
    return true;
  }

  // From here on we assume an active po_new_flow session.
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'po_new_flow') return true;

  if (data.startsWith('pp:new_sup:')) {
    const sid = data.slice('pp:new_sup:'.length);
    const s = (await contactsRepository.getByType('supplier')).find((c) => c.contact_id === sid);
    if (s) { session.supplier = s.name; session.supplier_id = s.contact_id; }
    sessionStore.set(userId, session);
    await askLineDesign(bot, chatId, userId);
    return true;
  }
  if (data === 'pp:new_sup_text') {
    session.step = 'supplier_text';
    sessionStore.set(userId, session);
    await renderNewPO(bot, chatId, userId, 'Type the *supplier name* (reply in chat):',
      [[{ text: '❌ Cancel', callback_data: 'pp:new_cancel' }]]);
    return true;
  }

  if (data.startsWith('pp:new_dg:')) {
    session._pending_design = data.slice('pp:new_dg:'.length);
    sessionStore.set(userId, session);
    await askLineShade(bot, chatId, userId);
    return true;
  }
  if (data === 'pp:new_dg_text') {
    session.step = 'design_text';
    sessionStore.set(userId, session);
    await renderNewPO(bot, chatId, userId, 'Type the *design name* (reply in chat):',
      [[{ text: '❌ Cancel', callback_data: 'pp:new_cancel' }]]);
    return true;
  }
  if (data === 'pp:new_dg_done') {
    if (!session.lines.length) {
      await renderNewPO(bot, chatId, userId, '⚠️ Add at least one line before continuing.',
        [[{ text: '❌ Cancel', callback_data: 'pp:new_cancel' }]]);
      return true;
    }
    await askExpectedDate(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('pp:new_sh:')) {
    session._pending_shade = data.slice('pp:new_sh:'.length);
    sessionStore.set(userId, session);
    await askLineQty(bot, chatId, userId);
    return true;
  }
  if (data === 'pp:new_sh_none') {
    session._pending_shade = '__none__';
    sessionStore.set(userId, session);
    await askLineQty(bot, chatId, userId);
    return true;
  }
  if (data === 'pp:new_sh_text') {
    session.step = 'shade_text';
    sessionStore.set(userId, session);
    await renderNewPO(bot, chatId, userId, 'Type the *shade name* (reply in chat):',
      [[{ text: '❌ Cancel', callback_data: 'pp:new_cancel' }]]);
    return true;
  }

  if (data.startsWith('pp:new_qty:')) {
    const qty = parseInt(data.slice('pp:new_qty:'.length), 10);
    if (Number.isFinite(qty) && qty > 0) {
      session.lines.push({
        design: session._pending_design,
        shade: session._pending_shade === '__none__' ? '' : (session._pending_shade || ''),
        qty_bales: qty,
      });
      delete session._pending_design;
      delete session._pending_shade;
      sessionStore.set(userId, session);
      await askLineDesign(bot, chatId, userId);
    }
    return true;
  }
  if (data === 'pp:new_qty_text') {
    session.step = 'qty_text';
    sessionStore.set(userId, session);
    await renderNewPO(bot, chatId, userId, 'Type the *bale quantity* (reply in chat):',
      [[{ text: '❌ Cancel', callback_data: 'pp:new_cancel' }]]);
    return true;
  }

  if (data.startsWith('pp:new_dt:')) {
    const v = data.slice('pp:new_dt:'.length);
    if (v === 'skip') {
      session.expected_date = '';
    } else {
      const days = parseInt(v, 10);
      if (Number.isFinite(days) && days > 0) {
        const d = new Date(Date.now() + days * 86400000);
        session.expected_date = d.toISOString().split('T')[0];
      }
    }
    sessionStore.set(userId, session);
    await showPOConfirm(bot, chatId, userId);
    return true;
  }
  if (data === 'pp:new_dt_text') {
    session.step = 'date_text';
    sessionStore.set(userId, session);
    await renderNewPO(bot, chatId, userId, 'Type the *expected date* (YYYY-MM-DD):',
      [[{ text: '❌ Cancel', callback_data: 'pp:new_cancel' }]]);
    return true;
  }
  if (data === 'pp:new_submit') {
    await submitNewPO(bot, chatId, userId);
    return true;
  }
  return false;
}

async function handleTextStep(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'po_new_flow') return false;
  const chatId = msg.chat.id;
  const raw = (msg.text || '').trim();
  if (!raw) return false;

  if (session.step === 'supplier_text') {
    if (raw.length < 2 || raw.length > 80) {
      await bot.sendMessage(chatId, '⚠️ Supplier name must be 2-80 chars.');
      return true;
    }
    const saved = await contactsRepository.append({ name: raw, type: 'supplier' });
    session.supplier = saved.name;
    session.supplier_id = saved.contact_id;
    sessionStore.set(userId, session);
    await askLineDesign(bot, chatId, userId);
    return true;
  }
  if (session.step === 'design_text') {
    session._pending_design = raw;
    sessionStore.set(userId, session);
    await askLineShade(bot, chatId, userId);
    return true;
  }
  if (session.step === 'shade_text') {
    session._pending_shade = raw;
    sessionStore.set(userId, session);
    await askLineQty(bot, chatId, userId);
    return true;
  }
  if (session.step === 'qty_text') {
    const n = parseInt(raw.replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(n) || n <= 0) {
      await bot.sendMessage(chatId, '⚠️ Enter a positive number, e.g. 25');
      return true;
    }
    session.lines.push({
      design: session._pending_design,
      shade: session._pending_shade === '__none__' ? '' : (session._pending_shade || ''),
      qty_bales: n,
    });
    delete session._pending_design;
    delete session._pending_shade;
    sessionStore.set(userId, session);
    await askLineDesign(bot, chatId, userId);
    return true;
  }
  if (session.step === 'date_text') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      await bot.sendMessage(chatId, '⚠️ Use YYYY-MM-DD format, e.g. 2026-05-21');
      return true;
    }
    session.expected_date = raw;
    sessionStore.set(userId, session);
    await showPOConfirm(bot, chatId, userId);
    return true;
  }
  return false;
}

module.exports = {
  showPlan,
  showPODetail,
  handleCallback,
  handleTextStep,
  _internals: { computeLowStock, getLowStockThreshold, DEFAULT_LOW_STOCK_THRESHOLD },
};
