'use strict';

/**
 * src/flows/transferFlow.js — WAREHOUSE TRANSFER (TRF-2, lean).
 *
 * 5-tap admin wizard + one-tap counterparty cards. The request rides an
 * ApprovalQueue row (see transferService); bales sit `in_transit` at the
 * destination (visible, not sellable) until the receiver confirms.
 *
 *   Wizard (admin): source → design → shade → qty → destination →
 *                   confirm (auto-picked dispatcher/receiver) → Send.
 *                   Person pickers appear only when a warehouse has >1
 *                   assigned active user.
 *   Dispatcher DM:  ✅ Accept & dispatch / ❌ Decline
 *   Receiver DM:    ✅ Received / ⚠️ Reject
 *   Declines/rejects revert the bales to the source — no admin cancel.
 *
 * Callback namespace `trf:*` (wizard callbacks need the session; the
 * acc/dec/rcv/rej action callbacks are session-FREE, keyed by requestId):
 *   trf:wh:<i> · trf:dg:<i> · trf:sh:<i> · trf:qty:<n> · trf:dest:<i>
 *   trf:dp:<i> · trf:rc:<i>      dispatcher / receiver pickers
 *   trf:send · trf:back · trf:cancel · trf:list
 *   trf:acc:<id> · trf:dec:<id> · trf:rcv:<id> · trf:rej:<id>
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const usersRepository = require('../repositories/usersRepository');
const transferService = require('../services/transferService');
const auth = require('../middlewares/auth');
const config = require('../config');
const logger = require('../utils/logger');

const SESSION_TYPE = 'transfer_flow';
const STEPS = ['source', 'design', 'shade', 'qty', 'dest', 'dispatcher', 'receiver', 'confirm'];
const QTY_CHIPS = [1, 2, 5, 10];

const render = makeRenderer({ requireSession: true });

function cancelRow() { return [{ text: '❌ Cancel', callback_data: 'trf:cancel' }]; }
function navRow() { return [{ text: '⬅ Back', callback_data: 'trf:back' }, { text: '❌ Cancel', callback_data: 'trf:cancel' }]; }
function chunk(btns, n) { const out = []; for (let i = 0; i < btns.length; i += n) out.push(btns.slice(i, i + n)); return out; }

/* ── data helpers ──────────────────────────────────────────────────────── */

async function availableInventory() {
  const all = await inventoryRepository.getAll();
  return all.filter((r) => r.status === 'available');
}

/**
 * Active users assigned to `warehouse`; falls back to ALL active
 * employees/managers when none is assigned (spec §2 People).
 */
async function candidatesFor(warehouse) {
  const all = await usersRepository.getAll();
  const active = all.filter((u) => u.status === 'active');
  const w = String(warehouse).trim().toLowerCase();
  const assigned = active.filter((u) => (u.warehouses || []).some((x) => String(x).trim().toLowerCase() === w));
  if (assigned.length) return assigned;
  return active.filter((u) => ['employee', 'manager'].includes(String(u.role || '').toLowerCase()));
}

/* ── wizard screens ────────────────────────────────────────────────────── */

async function showSource(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const inv = await availableInventory();
  const whs = [...new Set(inv.map((r) => r.warehouse).filter(Boolean))].sort();
  if (whs.length < 2) {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, '🚚 Transfers need at least two warehouses with stock.');
    return;
  }
  session._whs = whs; session.step = 'source'; sessionStore.set(userId, session);
  const rows = chunk(whs.map((w, i) => ({ text: `📦 ${w}`, callback_data: `trf:wh:${i}` })), 2);
  rows.push(cancelRow());
  await render(bot, chatId, userId, '🚚 *Transfer Stock*\n\nFrom which warehouse?', rows);
}

async function showDesigns(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const inv = await availableInventory();
  const agg = new Map();
  for (const r of inv) {
    if (r.warehouse !== session.from) continue;
    if (!agg.has(r.design)) agg.set(r.design, new Set());
    agg.get(r.design).add(r.packageNo);
  }
  const designs = [...agg.entries()].map(([design, pkgs]) => ({ design, bales: pkgs.size }))
    .sort((a, b) => b.bales - a.bales).slice(0, 30);
  if (!designs.length) {
    await render(bot, chatId, userId, `⚠️ No available stock in *${session.from}*.`, [cancelRow()]);
    return;
  }
  session._designs = designs.map((d) => d.design); session.step = 'design'; sessionStore.set(userId, session);
  const rows = chunk(designs.map((d, i) => ({ text: `${d.design} (${d.bales} bls)`, callback_data: `trf:dg:${i}` })), 2);
  rows.push(navRow());
  await render(bot, chatId, userId, `🚚 *Transfer from ${session.from}*\n\nPick a design:`, rows);
}

async function showShades(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const inv = await availableInventory();
  const agg = new Map();
  for (const r of inv) {
    if (r.warehouse !== session.from || r.design !== session.design) continue;
    const sh = r.shade || 'DEFAULT';
    if (!agg.has(sh)) agg.set(sh, new Set());
    agg.get(sh).add(r.packageNo);
  }
  const shades = [...agg.entries()].map(([shade, pkgs]) => ({ shade, bales: pkgs.size }))
    .sort((a, b) => b.bales - a.bales);
  session._shades = shades.map((s) => s.shade); session.step = 'shade'; sessionStore.set(userId, session);
  const rows = chunk(shades.map((s, i) => ({ text: `${s.shade} (${s.bales} bls)`, callback_data: `trf:sh:${i}` })), 2);
  rows.push(navRow());
  await render(bot, chatId, userId, `🚚 *${session.design}* — pick a shade:`, rows);
}

async function showQty(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const inv = await availableInventory();
  const avail = transferService.availableBales(inv, session.from, session.design, session.shade).length;
  session.availBales = avail; session.step = 'qty'; sessionStore.set(userId, session);
  const chips = QTY_CHIPS.filter((n) => n < avail).map((n) => ({ text: String(n), callback_data: `trf:qty:${n}` }));
  chips.push({ text: `All ${avail}`, callback_data: `trf:qty:${avail}` });
  const rows = chunk(chips, 4);
  rows.push(navRow());
  await render(bot, chatId, userId,
    `🚚 *${session.design} · ${session.shade}*\n${avail} bale(s) available in ${session.from}.\n\nHow many bales to transfer?`, rows);
}

async function showDest(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  // Destinations = warehouses with stock ∪ warehouses users are assigned
  // to — so a freshly-opened (empty) warehouse can still receive goods.
  const inv = await availableInventory();
  const users = await usersRepository.getAll();
  const set = new Set(inv.map((r) => r.warehouse).filter(Boolean));
  for (const u of users) for (const w of (u.warehouses || [])) if (w) set.add(w);
  const dests = [...set].sort().filter((w) => w !== session.from);
  if (!dests.length) {
    await render(bot, chatId, userId, '⚠️ No destination warehouse found. Assign users to the target warehouse first.', [cancelRow()]);
    return;
  }
  // Wizard mode carries design/shade/qty — normalize to the lines shape the
  // service expects (cart handoffs arrive with session.lines already set).
  if (session.design) {
    session.lines = [{ design: session.design, shade: session.shade, qty: session.qty }];
  }
  session._dests = dests; session.step = 'dest'; sessionStore.set(userId, session);
  const rows = chunk(dests.map((w, i) => ({ text: `🏭 ${w}`, callback_data: `trf:dest:${i}` })), 2);
  // Cart handoffs have no wizard steps to go back to — change the cart instead.
  rows.push(session.cartOrigin ? cancelRow() : navRow());
  const summary = (session.lines || []).map((l) => `${l.qty}× ${l.design}/${l.shade}`).join(' + ');
  await render(bot, chatId, userId, `🚚 *${summary}*\nFrom *${session.from}*\n\nTo which warehouse?`, rows);
}

/** After destination: resolve people (auto-pick singles) then confirm. */
async function resolvePeople(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session.dispatcher) {
    const cands = await candidatesFor(session.from);
    if (!cands.length) { await render(bot, chatId, userId, `⚠️ No active users found for *${session.from}*. Add one first.`, [cancelRow()]); return; }
    if (cands.length === 1) { session.dispatcher = cands[0]; sessionStore.set(userId, session); }
    else { await showPersonPicker(bot, chatId, userId, 'dispatcher', cands); return; }
  }
  if (!session.receiver) {
    const cands = await candidatesFor(session.to);
    if (!cands.length) { await render(bot, chatId, userId, `⚠️ No active users found for *${session.to}*. Add one first.`, [cancelRow()]); return; }
    if (cands.length === 1) { session.receiver = cands[0]; sessionStore.set(userId, session); }
    else { await showPersonPicker(bot, chatId, userId, 'receiver', cands); return; }
  }
  await showConfirm(bot, chatId, userId);
}

async function showPersonPicker(bot, chatId, userId, role, cands) {
  const session = sessionStore.get(userId);
  const list = cands.slice(0, 12);
  session._people = list.map((u) => ({ user_id: u.user_id, name: u.name }));
  session.step = role; sessionStore.set(userId, session);
  const pfx = role === 'dispatcher' ? 'trf:dp' : 'trf:rc';
  const wh = role === 'dispatcher' ? session.from : session.to;
  const rows = chunk(list.map((u, i) => ({ text: `👤 ${u.name}`, callback_data: `${pfx}:${i}` })), 2);
  rows.push(navRow());
  await render(bot, chatId, userId,
    `🚚 Who ${role === 'dispatcher' ? `dispatches from *${wh}*` : `receives at *${wh}*`}?`, rows);
}

async function showConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  session.step = 'confirm'; sessionStore.set(userId, session);
  const items = (session.lines || []).map((l) => `  🧵 ${l.design} · Shade ${l.shade} · ×${l.qty} bls`).join('\n');
  const total = (session.lines || []).reduce((s, l) => s + l.qty, 0);
  await render(bot, chatId, userId,
    `🚚 *Confirm transfer* — ${total} bale(s)\n\n${items}\n\n`
    + `*${session.from}* → *${session.to}*\n`
    + `Dispatcher: *${session.dispatcher.name}*\nReceiver: *${session.receiver.name}*\n\n`
    + `_This sends an ORDER — ${session.dispatcher.name} logs the actual bales when dispatching; nothing is locked until then._`,
    [[{ text: '✅ Send', callback_data: 'trf:send' }], session.cartOrigin ? cancelRow() : navRow()]);
}

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  try {
    const { requestId, aj } = await transferService.createTransferRequest({
      from: session.from, to: session.to, lines: session.lines, requestedBy: userId,
      dispatcher: session.dispatcher.user_id, receiver: session.receiver.user_id,
    });
    const line = lineOf(aj);
    // Dispatcher card (best-effort DM).
    try {
      await bot.sendMessage(session.dispatcher.user_id,
        `🚚 *Transfer ${requestId} — please dispatch*\n${line}\nReceiver: ${session.receiver.name}\n\n_Accepting logs the actual bales you send._`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '✅ Accept & dispatch', callback_data: `trf:acc:${requestId}` },
          { text: '❌ Decline', callback_data: `trf:dec:${requestId}` },
        ]] } });
    } catch (e) { logger.warn(`transferFlow: dispatcher DM failed: ${e.message}`); }
    // Render the receipt BEFORE clearing — the renderer is session-guarded.
    await render(bot, chatId, userId,
      `✅ *Transfer ${requestId} sent*\n${line}\n\n⏳ Waiting for *${session.dispatcher.name}* to dispatch.`,
      [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]]);
    sessionStore.clear(userId);
  } catch (e) {
    logger.error(`transferFlow: submit failed: ${e.message}`);
    await render(bot, chatId, userId, `⚠️ Could not create the transfer: ${e.message}`,
      [session.cartOrigin ? cancelRow() : navRow()]);
  }
}

/* ── counterparty actions (session-free, keyed by requestId) ───────────── */

/** "2× 9006/3 + 1× 9032/4 · Lagos → Kano office" from an actionJSON. */
function lineOf(aj) {
  const parts = (aj.lines || []).map((l) => `${l.qty}× ${l.design}/${l.shade}`);
  return `${parts.join(' + ')} · ${aj.from} → ${aj.to}`;
}

/** Per-line dispatch outcome, marking shortfalls. */
function dispatchedSummary(aj) {
  return (aj.dispatched || []).map((d) => (d.sent < d.requested
    ? `${d.sent}/${d.requested}× ${d.design}/${d.shade} ⚠️ short`
    : `${d.sent}× ${d.design}/${d.shade}`)).join(' + ');
}

async function notifyAdmins(bot, text, excludeId) {
  for (const adminId of config.access.adminIds) {
    if (String(adminId) === String(excludeId)) continue;
    try { await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' }); } catch (_) { /* best-effort */ }
  }
}

async function handleAction(bot, query, requestId, action) {
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;
  const row = await transferService.findTransfer(requestId);
  if (!row) {
    await bot.answerCallbackQuery(query.id, { text: 'Transfer not found or already closed.', show_alert: true });
    return true;
  }
  const aj = row.actionJSON;
  const isDispatchAction = action === 'acc' || (action === 'dec' && aj.stage === 'requested');
  const allowed = isDispatchAction ? aj.dispatcher : aj.receiver;
  if (userId !== String(allowed) && !auth.isAdmin(userId)) {
    await bot.answerCallbackQuery(query.id, { text: 'This action is for the assigned person only.', show_alert: true });
    return true;
  }
  await bot.answerCallbackQuery(query.id).catch(() => {});

  let res; let card;
  if (action === 'acc') {
    // TRF-3 — accepting IS the logging moment: the actual bales are
    // live-selected now and flipped in-transit; shortfalls are recorded.
    res = await transferService.dispatch(requestId, userId);
    if (res.ok) {
      const sent = dispatchedSummary(res.aj);
      const shortNote = res.short ? '\n⚠️ _Partially dispatched — some lines were short of stock._' : '';
      card = `🚚 *${requestId} dispatched* — bales logged\n${sent} · ${aj.from} → ${aj.to}${shortNote}`;
      try {
        await bot.sendMessage(aj.receiver,
          `📦 *Transfer ${requestId} incoming*\n${sent} · from ${aj.from}${shortNote}\n\nConfirm when the goods arrive and match:`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
            { text: '✅ Received', callback_data: `trf:rcv:${requestId}` },
            { text: '⚠️ Reject', callback_data: `trf:rej:${requestId}` },
          ]] } });
      } catch (e) { logger.warn(`transferFlow: receiver DM failed: ${e.message}`); }
    }
  } else if (action === 'rcv') {
    res = await transferService.confirmReceipt(requestId, userId);
    if (res.ok) card = `✅ *${requestId} received* — bales are now live at *${aj.to}*.\n${dispatchedSummary(aj) || lineOf(aj)}`;
  } else { // dec / rej
    res = await transferService.abort(requestId, userId);
    if (res.ok) {
      card = res.kind === 'declined'
        ? `❌ *${requestId} declined* — nothing was moved.\n${lineOf(aj)}`
        : `❌ *${requestId} rejected* — bales reverted to *${aj.from}*.\n${lineOf(aj)}`;
    }
  }

  if (!res.ok) {
    await bot.sendMessage(chatId, `⚠️ ${res.message}`);
    return true;
  }
  // Seal the tapped card, tell the actor, brief admins + requester.
  await bot.editMessageText(card, {
    chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown',
  }).catch(() => {});
  await notifyAdmins(bot, card, userId);
  if (row.user && String(row.user) !== userId && !config.access.adminIds.includes(String(row.user))) {
    try { await bot.sendMessage(row.user, card, { parse_mode: 'Markdown' }); } catch (_) { /* best-effort */ }
  }
  return true;
}

/* ── open-transfers list (read-only) ───────────────────────────────────── */

async function showList(bot, chatId, userId, messageId) {
  const open = await transferService.getOpenTransfers();
  let text = '🚚 *Open transfers*\n';
  if (!open.length) text += '\n_None — everything is settled._';
  for (const t of open.slice(0, 15)) {
    const badge = t.actionJSON.stage === 'in_transit' ? '🚚 in transit' : '⏳ awaiting dispatch';
    text += `\n\`${t.requestId}\` ${lineOf(t.actionJSON)} — ${badge}`;
  }
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]] } };
  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }).catch(async () => { await bot.sendMessage(chatId, text, opts); });
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

/* ── entry + dispatcher ────────────────────────────────────────────────── */

/**
 * Start the transfer wizard (admin only).
 * @param {object} bot @param {number|string} chatId
 * @param {string} userId @param {number|null} messageId
 * @param {{from: string, design?: string, shade?: string, qty?: number}} [prefill]
 *   Optional context handoff (e.g. from the supply cart). The wizard resumes
 *   at the furthest step the prefill validates against live stock; invalid
 *   parts degrade gracefully to the nearest earlier step.
 */
async function start(bot, chatId, userId, messageId, prefill) {
  if (!auth.isAdmin(String(userId))) {
    await bot.sendMessage(chatId, '🚚 Transfers can be created by admins only.');
    return;
  }
  sessionStore.set(userId, { type: SESSION_TYPE, step: 'source', flowMessageId: messageId || null });
  if (prefill && prefill.from) {
    await startPrefilled(bot, chatId, userId, prefill);
    return;
  }
  await showSource(bot, chatId, userId);
}

/**
 * Enter the wizard with prefilled context, validating each part against
 * live available stock. Falls back: bad warehouse → source screen, bad
 * design/shade → design screen, bad qty → qty screen.
 * @param {object} bot @param {number|string} chatId @param {string} userId
 * @param {{from: string, design?: string, shade?: string, qty?: number}} prefill
 */
async function startPrefilled(bot, chatId, userId, prefill) {
  const session = sessionStore.get(userId);
  const inv = await availableInventory();
  if (!inv.some((r) => r.warehouse === prefill.from)) {
    await showSource(bot, chatId, userId);
    return;
  }
  session.from = prefill.from;
  sessionStore.set(userId, session);
  // TRF-3 — full cart handoff: the lines ARE the selection; go straight to
  // the destination step. No re-picking of designs/shades/quantities.
  if (Array.isArray(prefill.lines) && prefill.lines.length) {
    session.lines = prefill.lines
      .map((l) => ({ design: l.design, shade: l.shade, qty: Math.max(0, parseInt(l.qty, 10) || 0) }))
      .filter((l) => l.design && l.qty > 0);
    if (session.lines.length) {
      session.cartOrigin = true;
      sessionStore.set(userId, session);
      await showDest(bot, chatId, userId);
      return;
    }
  }
  if (!prefill.design || prefill.shade === undefined || prefill.shade === null) {
    await showDesigns(bot, chatId, userId);
    return;
  }
  const avail = transferService.availableBales(inv, prefill.from, prefill.design, prefill.shade).length;
  if (!avail) {
    await showDesigns(bot, chatId, userId);
    return;
  }
  session.design = prefill.design;
  session.shade = prefill.shade;
  sessionStore.set(userId, session);
  const qty = parseInt(prefill.qty, 10);
  if (!qty || qty < 1 || qty > avail) {
    await showQty(bot, chatId, userId);
    return;
  }
  session.qty = qty;
  session.availBales = avail;
  sessionStore.set(userId, session);
  await showDest(bot, chatId, userId);
}

/** Step back one wizard screen. */
async function stepBack(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const order = { design: showSource, shade: showDesigns, qty: showShades, dest: showQty, dispatcher: showDest, receiver: showDest, confirm: showDest };
  // Re-picking destination re-resolves people; clear them.
  if (['dispatcher', 'receiver', 'confirm'].includes(session.step)) { session.dispatcher = null; session.receiver = null; }
  const target = order[session.step] || showSource;
  sessionStore.set(userId, session);
  await target(bot, chatId, userId);
}

/**
 * Handle a `trf:*` callback.
 * @returns {Promise<boolean>} true when handled.
 */
async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('trf:')) return false;
  const chatId = query.message && query.message.chat && query.message.chat.id;
  const userId = String(query.from.id);

  // Session-free actions first (cards live in counterparties' DMs).
  const m = data.match(/^trf:(acc|dec|rcv|rej):(.+)$/);
  if (m) return handleAction(bot, query, m[2], m[1]);
  if (data === 'trf:list') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await showList(bot, chatId, userId, query.message.message_id);
    return true;
  }

  const session = sessionStore.get(userId);
  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
  if (!session || session.type !== SESSION_TYPE) {
    await bot.sendMessage(chatId, '🚚 This transfer session has expired — open Transfer Stock again from the menu.');
    return true;
  }

  if (data === 'trf:cancel') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '🚚 Transfer cancelled — nothing was moved.', [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return true;
  }
  if (data === 'trf:back') { await stepBack(bot, chatId, userId); return true; }

  const pick = (list, i) => (Array.isArray(list) ? list[i] : undefined);
  if (data.startsWith('trf:wh:')) {
    const w = pick(session._whs, parseInt(data.slice(7), 10));
    if (w) { session.from = w; sessionStore.set(userId, session); await showDesigns(bot, chatId, userId); }
    return true;
  }
  if (data.startsWith('trf:dg:')) {
    const d = pick(session._designs, parseInt(data.slice(7), 10));
    if (d) { session.design = d; sessionStore.set(userId, session); await showShades(bot, chatId, userId); }
    return true;
  }
  if (data.startsWith('trf:sh:')) {
    const s = pick(session._shades, parseInt(data.slice(7), 10));
    if (s !== undefined) { session.shade = s; sessionStore.set(userId, session); await showQty(bot, chatId, userId); }
    return true;
  }
  if (data.startsWith('trf:qty:')) {
    const n = parseInt(data.slice(8), 10);
    if (n > 0 && n <= session.availBales) { session.qty = n; sessionStore.set(userId, session); await showDest(bot, chatId, userId); }
    return true;
  }
  if (data.startsWith('trf:dest:')) {
    const w = pick(session._dests, parseInt(data.slice(9), 10));
    if (w) { session.to = w; sessionStore.set(userId, session); await resolvePeople(bot, chatId, userId); }
    return true;
  }
  if (data.startsWith('trf:dp:') || data.startsWith('trf:rc:')) {
    const u = pick(session._people, parseInt(data.split(':')[2], 10));
    if (u) {
      if (data.startsWith('trf:dp:')) session.dispatcher = u; else session.receiver = u;
      sessionStore.set(userId, session);
      await resolvePeople(bot, chatId, userId);
    }
    return true;
  }
  if (data === 'trf:send') { await submit(bot, chatId, userId); return true; }

  return false;
}

module.exports = {
  start,
  showList,
  handleCallback,
  _internals: { candidatesFor, resolvePeople, submit, handleAction, startPrefilled, SESSION_TYPE },
};
