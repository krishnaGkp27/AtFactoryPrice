'use strict';

/**
 * src/flows/transferFlow.js — WAREHOUSE TRANSFER (TRF-2..TRF-6).
 *
 * 5-tap admin wizard + one-tap counterparty cards. The request rides an
 * ApprovalQueue row (see transferService); bales sit `in_transit` at the
 * destination (visible, not sellable) until the receiver confirms.
 *
 *   Wizard (admin): source → design → shade → qty → destination →
 *                   confirm (auto-picked dispatcher/receiver) → Send.
 *                   Person pickers appear only when a warehouse has >1
 *                   assigned active user.
 *   Dispatcher DM:  ✅ Accept & dispatch → bale picker → review →
 *                   📸 MANDATORY load photo/PDF → dispatch applies.
 *   Receiver DM:    ✅ Received → 📸 MANDATORY receipt photo/PDF →
 *                   receipt applies (stock goes live at the destination).
 *   Declines/rejects revert the bales to the source — no admin cancel.
 *
 * TRF-6: the dispatch/receive photo is a GATE, not an afterthought — nothing
 * moves and nobody is notified until the file arrives. The photo prompt is
 * always sent as a FRESH message (bottom of the chat) so the required next
 * step is unambiguous. There is no Skip; legacy Skip buttons answer with
 * "photos are now required".
 *
 * Callback namespace `trf:*` (wizard callbacks need the session; the
 * acc/dec/rcv/rej action callbacks are session-FREE, keyed by requestId):
 *   trf:wh:<i> · trf:dg:<i> · trf:sh:<i> · trf:qty:<n> · trf:dest:<i>
 *   trf:dp:<i> · trf:rc:<i>      dispatcher / receiver pickers
 *   trf:send · trf:back · trf:cancel · trf:list
 *   trf:acc:<id> · trf:dec:<id> · trf:rcv:<id> · trf:rej:<id>
 *   trf:nn:<id>                  receiver "not now" on the photo gate
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const usersRepository = require('../repositories/usersRepository');
const transferService = require('../services/transferService');
const driveBackup = require('../services/vision/driveBackup');
const telegramFiles = require('../utils/telegramFiles');
const auth = require('../middlewares/auth');
const config = require('../config');
const logger = require('../utils/logger');

// Accepted upload types for the dispatch / receive load photo (image or PDF).
const DOC_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
const BALE_PREVIEW_MAX = 8;

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
  // Cart handoffs already showed the full line list on the Transfer Cart
  // card just above — don't repeat it. Wizard-started transfers have no such
  // card, so they keep the inline line summary as their only reference.
  if (session.cartOrigin) {
    await render(bot, chatId, userId, `🚚 *${session.from}* → to which warehouse?`, rows);
  } else {
    const summary = (session.lines || []).map((l) => `${l.qty}× ${l.design}/${l.shade}`).join(' + ');
    await render(bot, chatId, userId, `🚚 *${summary}*\nFrom *${session.from}*\n\nTo which warehouse?`, rows);
  }
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
    // Dispatcher card (best-effort DM).
    try {
      const card = dispatcherCard(requestId, aj, session.receiver.name);
      await bot.sendMessage(session.dispatcher.user_id, card.text,
        { parse_mode: 'Markdown', reply_markup: card.kb });
    } catch (e) { logger.warn(`transferFlow: dispatcher DM failed: ${e.message}`); }
    // Render the receipt BEFORE clearing — the renderer is session-guarded.
    await render(bot, chatId, userId,
      `✅ *Transfer ${requestId} sent*\n${headOf(aj)}\n${linesBlock(aj.lines)}\n\n⏳ Waiting for *${session.dispatcher.name}* to dispatch.`,
      [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]]);
    sessionStore.clear(userId);
  } catch (e) {
    logger.error(`transferFlow: submit failed: ${e.message}`);
    await render(bot, chatId, userId, `⚠️ Could not create the transfer: ${e.message}`,
      [session.cartOrigin ? cancelRow() : navRow()]);
  }
}

/* ── counterparty actions (session-free, keyed by requestId) ───────────── */

/**
 * TRF-6 — grouped, indented line block (matches the Transfer Cart layout):
 *
 *   🧵 *80045*
 *    • Shade 1 ×1
 *    • Shade 7 ×2
 *
 * Long multi-line transfers were unreadable as a "+"-joined one-liner.
 */
function linesBlock(lines) {
  const byDesign = new Map();
  for (const l of (lines || [])) {
    if (!byDesign.has(l.design)) byDesign.set(l.design, []);
    byDesign.get(l.design).push(l);
  }
  const out = [];
  for (const [design, ls] of byDesign) {
    out.push(`🧵 *${design}*`);
    for (const l of ls) out.push(` • Shade ${l.shade} ×${l.qty}`);
  }
  return out.join('\n');
}

/** Grouped dispatch-outcome block, marking per-line shortfalls. */
function dispatchedBlock(aj) {
  const ds = aj.dispatched || [];
  if (!ds.length) return linesBlock(aj.lines);
  const byDesign = new Map();
  for (const d of ds) {
    if (!byDesign.has(d.design)) byDesign.set(d.design, []);
    byDesign.get(d.design).push(d);
  }
  const out = [];
  for (const [design, list] of byDesign) {
    out.push(`🧵 *${design}*`);
    for (const d of list) {
      out.push(d.sent < d.requested
        ? ` • Shade ${d.shade} — ${d.sent}/${d.requested} ⚠️ short`
        : ` • Shade ${d.shade} ×${d.sent}`);
    }
  }
  return out.join('\n');
}

/** One-line header: "*Lagos* → *Kano office* · 12 bale(s)". */
function headOf(aj) {
  const n = (aj.dispatched || []).reduce((s, d) => s + d.sent, 0) || totalBales(aj);
  return `*${aj.from}* → *${aj.to}* · ${n} bale(s)`;
}

/** Compact one-liner for list rows: "12 bale(s) · 80045 · Lagos → Kano office". */
function compactOf(aj) {
  const designs = [...new Set((aj.lines || []).map((l) => l.design))].join(', ');
  return `${totalBales(aj)} bale(s) · ${designs} · ${aj.from} → ${aj.to}`;
}

/** Compact "8801, 8804 … (+N)" preview of a bale-number list. */
function baleListPreview(bales, max = BALE_PREVIEW_MAX) {
  const arr = bales || [];
  if (!arr.length) return '—';
  if (arr.length <= max) return arr.join(', ');
  return `${arr.slice(0, max).join(', ')} … (+${arr.length - max})`;
}

/** Total requested bales across every line. */
function totalBales(aj) {
  return (aj.lines || []).reduce((s, l) => s + (l.qty || 0), 0);
}

/**
 * Dispatcher's action card (Accept & dispatch / Decline). Used for the
 * submit-time DM and for re-sends from the My Tasks transfer queue.
 * @returns {{text:string, kb:object}}
 */
function dispatcherCard(requestId, aj, receiverName) {
  return {
    text: `🚚 *Transfer ${requestId} — please dispatch*\n${headOf(aj)}\n${linesBlock(aj.lines)}\nReceiver: ${receiverName}\n\n_Accepting logs the actual bales you send. A load photo/PDF is required to complete the dispatch._`,
    kb: { inline_keyboard: [[
      { text: '✅ Accept & dispatch', callback_data: `trf:acc:${requestId}` },
      { text: '❌ Decline', callback_data: `trf:dec:${requestId}` },
    ]] },
  };
}

/**
 * Receiver's action card (Received / Reject). Used for the dispatch-time DM
 * and for re-sends from the My Tasks transfer queue.
 * @returns {{text:string, kb:object}}
 */
function receiverCard(requestId, aj) {
  const shortNote = aj.short ? '\n⚠️ _Partially dispatched — some lines were short of stock._' : '';
  return {
    text: `📦 *Transfer ${requestId} incoming*\n${headOf(aj)}\n${dispatchedBlock(aj)}${shortNote}\n📦 Bales: ${baleListPreview(aj.bales)}\n\nConfirm when the goods arrive and match — a photo/PDF of the received goods is required:`,
    kb: { inline_keyboard: [[
      { text: '✅ Received', callback_data: `trf:rcv:${requestId}` },
      { text: '⚠️ Reject', callback_data: `trf:rej:${requestId}` },
    ]] },
  };
}

/** Human state label from a live queue row (status + stage). */
function stateLabel(row) {
  if (!row) return 'unknown';
  if (row.status === 'approved') return 'received ✅';
  if (row.status === 'rejected') return 'closed ❌';
  const stage = row.actionJSON && row.actionJSON.stage;
  return stage === 'in_transit' ? 'in transit 🚚' : 'awaiting dispatch ⏳';
}

/* ── admin cards: short by default, expand on demand ───────────────────── */

/** One-line admin card (the default the admin sees). */
function shortCard(requestId, aj, label) {
  const n = (aj.dispatched || []).reduce((s, d) => s + d.sent, 0) || totalBales(aj);
  return `🚚 *${requestId}* ${label} — ${n} bale(s) · ${aj.from} → ${aj.to}`;
}
function viewMoreKb(requestId) {
  return { inline_keyboard: [[{ text: '🔍 View details', callback_data: `trf:info:${requestId}` }]] };
}

/** Best-effort id→name map for the people on a transfer. */
async function nameMap(ids) {
  const out = {};
  try {
    const users = await usersRepository.getAll();
    for (const u of users) out[String(u.user_id)] = u.name || String(u.user_id);
  } catch (_) { /* repo absent — fall back to raw ids */ }
  for (const id of ids) if (!out[String(id)]) out[String(id)] = String(id);
  return out;
}

/** Full detail card for the "View details" expansion. */
async function detailCard(row) {
  const aj = row.actionJSON;
  const names = await nameMap([aj.dispatcher, aj.receiver]);
  const out = [
    `🚚 *${row.requestId}* — ${stateLabel(row)}`,
    headOf(aj),
    `Dispatcher: ${names[String(aj.dispatcher)]} · Receiver: ${names[String(aj.receiver)]}`,
    '',
    aj.dispatched && aj.dispatched.length ? dispatchedBlock(aj) : linesBlock(aj.lines),
  ];
  if (aj.bales && aj.bales.length) out.push('', `📦 Bales: ${baleListPreview(aj.bales, 30)}`);
  if (aj.dispatchDoc && aj.dispatchDoc.url) out.push(`📸 Dispatch photo: ${aj.dispatchDoc.url}`);
  if (aj.receiveDoc && aj.receiveDoc.url) out.push(`📸 Receipt photo: ${aj.receiveDoc.url}`);
  return out.join('\n');
}

/** Brief every admin (except the actor) with the short card + expander. */
async function notifyAdmins(bot, requestId, aj, label, excludeId) {
  const text = shortCard(requestId, aj, label);
  for (const adminId of config.access.adminIds) {
    if (String(adminId) === String(excludeId)) continue;
    try {
      await bot.sendMessage(adminId, text, { parse_mode: 'Markdown', reply_markup: viewMoreKb(requestId) });
    } catch (_) { /* best-effort */ }
  }
}

/** Brief the original requester when they're not an admin (avoids dupes). */
async function notifyRequester(bot, row, requestId, aj, label, actorId) {
  if (!row.user) return;
  if (String(row.user) === String(actorId)) return;
  if (config.access.adminIds.includes(String(row.user))) return;
  try {
    await bot.sendMessage(row.user, shortCard(requestId, aj, label), { parse_mode: 'Markdown', reply_markup: viewMoreKb(requestId) });
  } catch (_) { /* best-effort */ }
}

/**
 * Expand / collapse an admin card in place. Session-free — reads the live
 * queue row, so it works on any card at any time, even days later.
 */
async function showInfo(bot, query, requestId, expand) {
  await bot.answerCallbackQuery(query.id).catch(() => {});
  const row = await transferService.findTransfer(requestId);
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  if (!row) {
    await bot.editMessageText('🚚 Transfer not found or already purged.', {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
    }).catch(() => {});
    return true;
  }
  const aj = row.actionJSON;
  const text = expand ? await detailCard(row) : shortCard(requestId, aj, stateLabel(row));
  const kb = expand
    ? { inline_keyboard: [[{ text: '◀ Less', callback_data: `trf:less:${requestId}` }]] }
    : viewMoreKb(requestId);
  await bot.editMessageText(text, {
    chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
    disable_web_page_preview: true, reply_markup: kb,
  }).catch(() => {});
  return true;
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
  // TRF-6: stale-card guard — cards can be tapped days later; refuse taps
  // that no longer match the live stage instead of relying on the service.
  if (row.status !== 'pending'
      || (action === 'acc' && aj.stage !== 'requested')
      || (action === 'rcv' && aj.stage !== 'in_transit')) {
    await bot.answerCallbackQuery(query.id, { text: `Transfer is ${stateLabel(row)} — nothing to do here.`, show_alert: true }).catch(() => {});
    return true;
  }
  await bot.answerCallbackQuery(query.id).catch(() => {});

  // Accept → open the dispatcher's bale picker anchored on the tapped card.
  // Dispatch applies only after bales are reviewed AND the load photo lands.
  if (action === 'acc') {
    await startDispatchPicker(bot, chatId, userId, row, query.message.message_id);
    return true;
  }

  // TRF-6: Received → photo gate. The receipt is applied by handleFile once
  // the mandatory photo/PDF arrives; nothing changes until then.
  if (action === 'rcv') {
    await armDocGate(bot, chatId, userId, requestId, 'receive', {
      sealMessageId: query.message.message_id,
      sealText: `📦 *${requestId}* — receipt pending 📸`,
      promptText: `📸 *Photo required — ${requestId}*\n`
        + `Send a photo or PDF of the received goods now to confirm receipt.\n`
        + `_Stock goes live at *${aj.to}* when it arrives._`,
      kb: [[{ text: '↩ Not now', callback_data: `trf:nn:${requestId}` }]],
    });
    return true;
  }

  // dec / rej
  const res = await transferService.abort(requestId, userId);
  if (!res.ok) { await bot.sendMessage(chatId, `⚠️ ${res.message}`); return true; }
  const label = res.kind === 'declined' ? 'declined ❌' : 'rejected ❌';
  const card = res.kind === 'declined'
    ? `❌ *${requestId} declined* — nothing was moved.\n${headOf(aj)}\n${linesBlock(aj.lines)}`
    : `❌ *${requestId} rejected* — bales reverted to *${aj.from}*.\n${headOf(aj)}\n${dispatchedBlock(aj)}`;
  await bot.editMessageText(card, {
    chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown',
  }).catch(() => {});
  await notifyAdmins(bot, requestId, aj, label, userId);
  await notifyRequester(bot, row, requestId, aj, label, userId);
  return true;
}

/* ── dispatcher bale picker (session-backed, anchored on the DM card) ───── */

/**
 * Open the bale picker after the dispatcher accepts. Pre-selects FIFO bales
 * per line; lines with no real choice (candidates ≤ qty) are auto-filled and
 * skipped. When no line needs a decision, jumps straight to the confirm
 * screen. Anchored on the tapped card so everything edits in place.
 */
async function startDispatchPicker(bot, chatId, userId, row, messageId) {
  const aj = row.actionJSON;
  const inv = await availableInventory();
  const pl = (aj.lines || []).map((l) => {
    const cands = transferService.availableBales(inv, aj.from, l.design, l.shade);
    return {
      design: l.design, shade: l.shade, qty: l.qty,
      cands,
      sel: cands.slice(0, l.qty),       // FIFO pre-selection
      choice: cands.length > l.qty,      // is there anything to decide?
    };
  });
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'dispatch_pick',
    requestId: row.requestId, from: aj.from, to: aj.to,
    pl, idx: 0, flowMessageId: messageId || null,
  });
  const first = pl.findIndex((p) => p.choice);
  if (first === -1) { await showDispatchConfirm(bot, chatId, userId); return; }
  const session = sessionStore.get(userId);
  session.idx = first; sessionStore.set(userId, session);
  await showBalePicker(bot, chatId, userId);
}

function nextChoiceIdx(session, fromIdx) {
  for (let i = fromIdx + 1; i < session.pl.length; i += 1) if (session.pl[i].choice) return i;
  return -1;
}
function prevChoiceIdx(session, fromIdx) {
  for (let i = fromIdx - 1; i >= 0; i -= 1) if (session.pl[i].choice) return i;
  return -1;
}

/** Render the current line's bale-picker screen. */
async function showBalePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const line = session.pl[session.idx];
  const selSet = new Set(line.sel);
  const chips = line.cands.map((pkg, i) => ({
    text: `${selSet.has(pkg) ? '✅ ' : ''}${pkg}`, callback_data: `trf:bl:t:${i}`,
  }));
  const rows = chunk(chips, 3);
  rows.push([{ text: nextChoiceIdx(session, session.idx) === -1 ? '✅ Review' : '➡ Next', callback_data: 'trf:bl:nx' }]);
  rows.push([{ text: '⏭ Auto-pick remaining', callback_data: 'trf:bl:auto' }]);
  rows.push([{ text: '❌ Decline', callback_data: `trf:dec:${session.requestId}` }]);
  await render(bot, chatId, userId,
    `🚚 *${session.requestId}* — line ${session.idx + 1} of ${session.pl.length}\n`
    + `${line.design} · Shade ${line.shade} — pick ${line.qty} bale(s)   _(${line.cands.length} in stock)_\n`
    + `Selected: *${line.sel.length}/${line.qty}*`,
    rows);
}

/** Final review before the photo gate. Notes auto-filled lines (TRF-6). */
async function showDispatchConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  session.step = 'dispatch_confirm';
  delete session.docKind; delete session.gate;
  sessionStore.set(userId, session);
  const picked = session.pl.flatMap((p) => p.sel);
  const perLine = session.pl.map((p) => (p.sel.length < p.qty
    ? ` • ${p.design}/${p.shade}: ${p.sel.length}/${p.qty} ⚠️ short`
    : ` • ${p.design}/${p.shade}: ${p.sel.join(', ')}`)).join('\n');
  // When stock exactly matched the request there was no picker to show —
  // say so, or the operator wonders where the bale-picking step went.
  const autoNote = session.pl.every((p) => !p.choice)
    ? '\n_Bales auto-filled (oldest first) — stock matched the request, nothing to choose._'
    : '';
  await render(bot, chatId, userId,
    `🚚 *${session.requestId}* — dispatch ${picked.length} bale(s)?\n${perLine}${autoNote}\n\n*${session.from}* → *${session.to}*\n📸 _A load photo/PDF is required next._`,
    [[{ text: '🚚 Dispatch', callback_data: 'trf:bl:go' }],
      [{ text: '◀ Back', callback_data: 'trf:bl:bk' }, { text: '❌ Decline', callback_data: `trf:dec:${session.requestId}` }]]);
}

/**
 * TRF-6 — arm the mandatory-photo gate: seal the tapped/anchored card (no
 * buttons left behind), then send the photo prompt as a FRESH message at the
 * bottom of the chat and anchor the flow on it. The actual state change
 * happens in handleFile when the photo/PDF arrives.
 *
 * @param {object} bot @param {number|string} chatId @param {string} userId
 * @param {string} requestId
 * @param {'dispatch'|'receive'} docKind
 * @param {{sealMessageId?:number, sealText?:string, promptText:string, kb:Array, keep?:object}} p
 *   `keep` = extra session fields to retain (e.g. the dispatcher's picks).
 */
async function armDocGate(bot, chatId, userId, requestId, docKind, p) {
  if (p.sealMessageId && p.sealText) {
    await bot.editMessageText(p.sealText, {
      chat_id: chatId, message_id: p.sealMessageId, parse_mode: 'Markdown',
    }).catch(() => { /* deleted / identical — the fresh prompt still lands */ });
  }
  const sent = await bot.sendMessage(chatId, p.promptText, {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: p.kb || [] },
  });
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'await_doc', gate: true, requestId, docKind,
    flowMessageId: (sent && sent.message_id) || null,
    ...(p.keep || {}),
  });
}

/**
 * TRF-6 — bale review confirmed: DON'T dispatch yet. Require the load
 * photo/PDF first; handleFile applies the dispatch when it arrives.
 */
async function askDispatchDoc(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const requestId = session.requestId;
  const picked = session.pl.flatMap((p) => p.sel);
  await armDocGate(bot, chatId, userId, requestId, 'dispatch', {
    sealMessageId: session.flowMessageId,
    sealText: `🚚 *${requestId}* — ${picked.length} bale(s) picked ✔`,
    promptText: `📸 *Photo required — ${requestId}*\n`
      + `Send a photo or PDF of the load now to complete the dispatch.\n`
      + `_Nothing moves until it arrives._`,
    kb: [[{ text: '◀ Back to bales', callback_data: 'trf:bl:bk' },
      { text: '❌ Decline', callback_data: `trf:dec:${requestId}` }]],
    keep: { pl: session.pl, from: session.from, to: session.to, idx: session.idx || 0 },
  });
}

/** Apply the dispatch once the gate photo has landed (TRF-6). */
async function completeDispatch(bot, session, userId) {
  const requestId = session.requestId;
  const manualPicks = (session.pl || []).map((p) => p.sel);
  const row = await transferService.findTransfer(requestId);
  const res = await transferService.dispatch(requestId, userId, manualPicks);
  if (!res.ok) return { ok: false, message: res.message };
  const aj = res.aj;
  try {
    const card = receiverCard(requestId, aj);
    await bot.sendMessage(aj.receiver, card.text, { parse_mode: 'Markdown', reply_markup: card.kb });
  } catch (e) { logger.warn(`transferFlow: receiver DM failed: ${e.message}`); }
  await notifyAdmins(bot, requestId, aj, 'dispatched 🚚', userId);
  if (row) await notifyRequester(bot, row, requestId, aj, 'dispatched 🚚', userId);
  const shortNote = res.short ? '\n⚠️ _Partially dispatched — some lines were short of stock._' : '';
  return {
    ok: true,
    sealText: `🚚 *${requestId} dispatched* — bales logged\n${headOf(aj)}\n${dispatchedBlock(aj)}${shortNote}\n📦 ${baleListPreview(aj.bales)}`,
  };
}

/** Apply the receipt once the gate photo has landed (TRF-6). */
async function completeReceipt(bot, session, userId) {
  const requestId = session.requestId;
  const row = await transferService.findTransfer(requestId);
  const res = await transferService.confirmReceipt(requestId, userId);
  if (!res.ok) return { ok: false, message: res.message };
  const aj = res.aj;
  await notifyAdmins(bot, requestId, aj, 'received ✅', userId);
  if (row) await notifyRequester(bot, row, requestId, aj, 'received ✅', userId);
  return {
    ok: true,
    sealText: `✅ *${requestId} received* — bales are now live at *${aj.to}*.\n${headOf(aj)}\n${dispatchedBlock(aj)}`,
  };
}

/* ── load photo / PDF (dispatch + receive), reusing driveBackup ────────── */

/**
 * Post-hoc attach prompt (non-gate) — used only by rearmDoc for transfers
 * whose stage already applied (e.g. legacy cards from before TRF-6). Arms an
 * await_doc session WITHOUT the gate flag: handleFile just attaches the file,
 * it does not move stock.
 */
async function promptForDoc(bot, chatId, userId, requestId, docKind, base, messageId) {
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'await_doc', requestId, docKind, flowMessageId: messageId || null,
  });
  const verb = docKind === 'receive' ? 'received goods' : 'load';
  await render(bot, chatId, userId,
    `${base}\n\n📸 Send a photo or PDF of the ${verb} now to attach it.`, []);
}

/**
 * TRF-6 — Skip is retired: photos are mandatory. Old messages may still
 * carry the button; answer with the new rule and re-arm the attach prompt.
 */
async function skipDoc(bot, query, code, requestId) {
  await bot.answerCallbackQuery(query.id, {
    text: '📸 Photos are now required for transfers — please send the photo/PDF.',
    show_alert: true,
  }).catch(() => {});
  return rearmDoc(bot, query, code, requestId, { answered: true });
}

/** Re-arm the attach prompt (legacy Attach buttons / after session expiry). */
async function rearmDoc(bot, query, code, requestId, opts = {}) {
  if (!opts.answered) await bot.answerCallbackQuery(query.id).catch(() => {});
  const userId = String(query.from.id);
  const row = await transferService.findTransfer(requestId);
  if (!row) { await bot.sendMessage(query.message.chat.id, '🚚 Transfer not found or already closed.'); return true; }
  const aj = row.actionJSON;
  const kind = code === 'r' ? 'receive' : 'dispatch';
  const allowed = kind === 'receive' ? aj.receiver : aj.dispatcher;
  if (userId !== String(allowed) && !auth.isAdmin(userId)) {
    await bot.answerCallbackQuery(query.id, { text: 'Only the assigned person can attach this.', show_alert: true }).catch(() => {});
    return true;
  }
  const base = `🚚 *${requestId}* — ${stateLabel(row)}`;
  await promptForDoc(bot, query.message.chat.id, userId, requestId, kind, base, query.message.message_id);
  return true;
}

/**
 * TRF-6 — receiver's "Not now" on the photo gate: stand down without
 * confirming. The prompt message turns back into the actionable receiver
 * card, and the transfer stays in_transit (still in My Tasks).
 */
async function gateNotNow(bot, query, requestId) {
  await bot.answerCallbackQuery(query.id).catch(() => {});
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);
  if (session && session.type === SESSION_TYPE && session.step === 'await_doc' && session.gate) {
    sessionStore.clear(userId);
  }
  const row = await transferService.findTransfer(requestId);
  if (!row || row.status !== 'pending') return true;
  const card = receiverCard(requestId, row.actionJSON);
  await bot.editMessageText(card.text, {
    chat_id: query.message.chat.id, message_id: query.message.message_id,
    parse_mode: 'Markdown', reply_markup: card.kb,
  }).catch(() => {});
  return true;
}

/**
 * Capture a dispatch/receive photo or PDF while an await_doc session is live.
 *
 * TRF-6 gate sessions (armed by askDispatchDoc / the Received tap): the file
 * IS the trigger — the dispatch/receipt is applied first, and only then are
 * the counterparty + admins notified, so nobody hears about a move that
 * didn't happen. Non-gate sessions (legacy post-hoc attach) just store the
 * file. Archiving to Drive stays best-effort — the Telegram file itself is
 * always forwarded, so a Drive outage never blocks the transfer.
 * Returns true when consumed.
 */
async function handleFile(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE || session.step !== 'await_doc') return false;
  const chatId = msg.chat.id;
  const { requestId } = session;
  const kind = session.docKind || 'dispatch';

  let fileId = null; let mimeType = ''; let fileName = '';
  if (msg.photo && msg.photo.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
    mimeType = 'image/jpeg';
    fileName = `transfer-${requestId}.jpg`;
  } else if (msg.document) {
    fileId = msg.document.file_id;
    mimeType = (msg.document.mime_type || '').toLowerCase();
    fileName = msg.document.file_name || `transfer-${requestId}`;
    if (!DOC_MIMES.includes(mimeType)) {
      const ext = (fileName.split('.').pop() || '').toLowerCase();
      mimeType = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' }[ext] || mimeType;
    }
  } else {
    return false;
  }
  if (!DOC_MIMES.includes(mimeType)) {
    await bot.sendMessage(chatId, '⚠️ Send a photo (JPG/PNG) or a PDF to continue.');
    return true;
  }

  // TRF-6: gate sessions apply the state change FIRST. A stale gate (someone
  // else already dispatched/declined) fails cleanly here, before any
  // notification goes out.
  let sealText = null;
  if (session.gate) {
    const done = kind === 'receive'
      ? await completeReceipt(bot, session, userId)
      : await completeDispatch(bot, session, userId);
    if (!done.ok) {
      const flowMessageId = session.flowMessageId;
      sessionStore.clear(userId);
      await bot.editMessageText(`⚠️ *${requestId}* — ${done.message}`, {
        chat_id: chatId, message_id: flowMessageId, parse_mode: 'Markdown',
      }).catch(() => {});
      return true;
    }
    sealText = done.sealText;
  }

  let archive = null;
  try {
    const dl = await telegramFiles.downloadTelegramFile(bot, fileId);
    let uploader = msg.from.first_name || `user-${userId}`;
    try { const u = await usersRepository.findByUserId(userId); if (u && u.name) uploader = u.name; } catch (_) { /* fall back */ }
    archive = await driveBackup.archiveFile(dl.buffer, dl.mimeType || mimeType, {
      uploader, originalName: fileName, kind: 'photo',
    });
  } catch (e) {
    logger.warn(`transferFlow: doc archive failed: ${e.message}`);
  }
  const url = (archive && archive.drive && archive.drive.webViewLink) || '';
  await transferService.attachDoc(requestId, kind, {
    url, name: (archive && archive.readableName) || fileName, fileId, by: userId,
  });

  // Forward the file for eyes-on to the counterparty, admins, and requester.
  const row = await transferService.findTransfer(requestId);
  const aj = row && row.actionJSON;
  const caption = `📸 ${kind === 'receive' ? 'Receipt' : 'Dispatch'} photo — ${requestId}`;
  const targets = new Set();
  if (aj) {
    targets.add(String(kind === 'receive' ? aj.dispatcher : aj.receiver));
    for (const a of config.access.adminIds) targets.add(String(a));
    if (row.user) targets.add(String(row.user));
  }
  targets.delete(userId);
  for (const t of targets) {
    if (!t) continue;
    try {
      if (msg.photo && msg.photo.length) await bot.sendPhoto(t, fileId, { caption });
      else await bot.sendDocument(t, fileId, { caption });
    } catch (_) { /* best-effort */ }
  }

  const flowMessageId = session.flowMessageId;
  sessionStore.clear(userId);
  const linkNote = url ? `\n🔗 ${url}` : '';
  const head = sealText || `🚚 *${requestId}*`;
  await bot.editMessageText(
    `${head}\n📸 *${kind === 'receive' ? 'Receipt' : 'Dispatch'} photo attached*${linkNote}`,
    { chat_id: chatId, message_id: flowMessageId, parse_mode: 'Markdown', disable_web_page_preview: true },
  ).catch(() => {});
  return true;
}

/* ── My Tasks integration: "transfers waiting on you" queue ────────────── */

// My Tasks stays scannable — the queue shows at most this many transfers.
const MY_QUEUE_MAX = 6;

/**
 * Build the "🚚 Transfers waiting on you" section for the My Tasks view.
 * Session-free: reads the live ApprovalQueue, so it survives bot restarts
 * and deleted DMs. Each entry gets one button that re-sends the actionable
 * card (Accept & dispatch / Received) via `trf:card:<requestId>`.
 *
 * @param {string} userId Telegram id of the viewer
 * @returns {Promise<{lines: string[], rows: Array<Array<object>>}>}
 *   Markdown lines + inline-keyboard rows; both empty when nothing pends.
 */
async function myQueueSection(userId) {
  const pend = await transferService.getActionableFor(userId);
  if (!pend.length) return { lines: [], rows: [] };
  const lines = ['🚚 *Transfers waiting on you*'];
  const rows = [];
  for (const t of pend.slice(0, MY_QUEUE_MAX)) {
    const aj = t.actionJSON;
    const toDispatch = aj.stage !== 'in_transit';
    const n = (aj.dispatched || []).reduce((s, d) => s + d.sent, 0) || totalBales(aj);
    lines.push(`   \`${t.requestId}\` ${n} bale(s) · ${aj.from} → ${aj.to}`);
    lines.push(`     ${toDispatch ? '⏳ waiting for you to dispatch' : '🚚 in transit — confirm receipt'}`);
    rows.push([{
      text: toDispatch ? `🚚 Dispatch — ${t.requestId}` : `📦 Receive — ${t.requestId}`,
      callback_data: `trf:card:${t.requestId}`,
    }]);
  }
  if (pend.length > MY_QUEUE_MAX) lines.push(`   _…and ${pend.length - MY_QUEUE_MAX} more_`);
  return { lines, rows };
}

/**
 * Re-send the actionable card for a transfer (tapped from the My Tasks
 * queue). Session-free — rebuilt from the live queue row every time.
 * Only the assigned actor (or an admin) gets the card.
 * @returns {Promise<boolean>} true (callback consumed)
 */
async function showActionCard(bot, query, requestId) {
  await bot.answerCallbackQuery(query.id).catch(() => {});
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  const row = await transferService.findTransfer(requestId);
  if (!row) {
    await bot.sendMessage(chatId, '🚚 Transfer not found or already closed.');
    return true;
  }
  const aj = row.actionJSON;
  if (row.status !== 'pending') {
    await bot.sendMessage(chatId, `🚚 *${requestId}* — ${stateLabel(row)}\n${compactOf(aj)}`, { parse_mode: 'Markdown' });
    return true;
  }
  const toDispatch = aj.stage !== 'in_transit';
  const allowed = toDispatch ? aj.dispatcher : aj.receiver;
  if (userId !== String(allowed) && !auth.isAdmin(userId)) {
    await bot.answerCallbackQuery(query.id, { text: 'This card is for the assigned person only.', show_alert: true }).catch(() => {});
    return true;
  }
  let card;
  if (toDispatch) {
    const names = await nameMap([aj.receiver]);
    card = dispatcherCard(requestId, aj, names[String(aj.receiver)]);
  } else {
    card = receiverCard(requestId, aj);
  }
  await bot.sendMessage(chatId, card.text, { parse_mode: 'Markdown', reply_markup: card.kb });
  return true;
}

/* ── open-transfers list (read-only) ───────────────────────────────────── */

async function showList(bot, chatId, userId, messageId) {
  const open = await transferService.getOpenTransfers();
  let text = '🚚 *Open transfers*\n';
  if (!open.length) text += '\n_None — everything is settled._';
  for (const t of open.slice(0, 15)) {
    const badge = t.actionJSON.stage === 'in_transit' ? '🚚 in transit' : '⏳ awaiting dispatch';
    text += `\n\`${t.requestId}\` ${compactOf(t.actionJSON)} — ${badge}`;
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

  // Session-free actions first (cards live in counterparties' / admins' DMs).
  const m = data.match(/^trf:(acc|dec|rcv|rej):(.+)$/);
  if (m) return handleAction(bot, query, m[2], m[1]);
  const mInfo = data.match(/^trf:info:(.+)$/);
  if (mInfo) return showInfo(bot, query, mInfo[1], true);
  const mLess = data.match(/^trf:less:(.+)$/);
  if (mLess) return showInfo(bot, query, mLess[1], false);
  const mSkip = data.match(/^trf:dsk:([dr]):(.+)$/);
  if (mSkip) return skipDoc(bot, query, mSkip[1], mSkip[2]);
  const mAtt = data.match(/^trf:att:([dr]):(.+)$/);
  if (mAtt) return rearmDoc(bot, query, mAtt[1], mAtt[2]);
  const mNn = data.match(/^trf:nn:(.+)$/);
  if (mNn) return gateNotNow(bot, query, mNn[1]);
  const mCard = data.match(/^trf:card:(.+)$/);
  if (mCard) return showActionCard(bot, query, mCard[1]);
  if (data === 'trf:list') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await showList(bot, chatId, userId, query.message.message_id);
    return true;
  }

  const session = sessionStore.get(userId);
  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
  if (!session || session.type !== SESSION_TYPE) {
    await bot.sendMessage(chatId, '🚚 This transfer session has expired — open 📋 My Tasks to pick it up again (admins: Transfer Stock for a new one).');
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

  // Dispatcher bale picker (session-backed; anchored on the DM card).
  if (data.startsWith('trf:bl:')) {
    const atGate = session.step === 'await_doc' && session.gate && session.docKind === 'dispatch';
    // "Back to bales" on the photo-gate prompt → return to the review screen.
    if (atGate) {
      if (data === 'trf:bl:bk') await showDispatchConfirm(bot, chatId, userId);
      return true;
    }
    if (session.step !== 'dispatch_pick' && session.step !== 'dispatch_confirm') return true;
    const rest = data.slice('trf:bl:'.length);
    if (rest.startsWith('t:')) {
      const line = session.pl[session.idx];
      const pkg = line.cands[parseInt(rest.slice(2), 10)];
      if (pkg !== undefined) {
        const at = line.sel.indexOf(pkg);
        if (at >= 0) line.sel.splice(at, 1);              // deselect
        else if (line.sel.length < line.qty) line.sel.push(pkg); // add
        else { line.sel.shift(); line.sel.push(pkg); }    // at cap → swap oldest
        sessionStore.set(userId, session);
        await showBalePicker(bot, chatId, userId);
      }
      return true;
    }
    if (rest === 'nx') {
      const next = nextChoiceIdx(session, session.idx);
      if (next === -1) { await showDispatchConfirm(bot, chatId, userId); }
      else { session.idx = next; sessionStore.set(userId, session); await showBalePicker(bot, chatId, userId); }
      return true;
    }
    if (rest === 'auto') { await showDispatchConfirm(bot, chatId, userId); return true; }
    if (rest === 'bk') {
      const prev = prevChoiceIdx(session, session.pl.length);
      session.step = 'dispatch_pick';
      if (prev !== -1) session.idx = prev;
      sessionStore.set(userId, session);
      await showBalePicker(bot, chatId, userId);
      return true;
    }
    if (rest === 'go') { await askDispatchDoc(bot, chatId, userId); return true; }
    return true;
  }

  return false;
}

module.exports = {
  start,
  showList,
  handleCallback,
  handleFile,
  myQueueSection,
  _internals: {
    candidatesFor, resolvePeople, submit, handleAction, startPrefilled,
    startDispatchPicker, askDispatchDoc, completeDispatch, completeReceipt,
    armDocGate, gateNotNow, showInfo, promptForDoc, handleFile,
    linesBlock, dispatchedBlock, headOf, compactOf,
    detailCard, shortCard, showActionCard, dispatcherCard, receiverCard, SESSION_TYPE,
  },
};
