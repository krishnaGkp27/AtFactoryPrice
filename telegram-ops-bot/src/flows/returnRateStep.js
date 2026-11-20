'use strict';

/**
 * returnRateStep — RET-8 (owner, 20-Nov-2026): the admin's rate step on a
 * return whose sale record carries no rate for some thans.
 *
 *   ✅ Approve (first, no signature, no fill)
 *     → `↩️ Return R-C677 · rate needed` per gap (buyer · design), as a
 *       reply to the approval card: type the rate, or tap the rate the
 *       customer last paid, or `⏭ No credit for these`
 *     → `↩️ Return R-C677 · check the credit` → `✅ Approve with this credit`
 *       saves the fills on the request (one write, read back) and continues
 *       into handleApprovalCallback as this admin's approval
 *   ✅ Approve (another admin, fills entered by someone else)
 *     → the same check card, `Musa typed this rate. Check it before you
 *       approve.` → `✅ Approve · credit 261,000` signs exactly that print
 *
 * The PRC-2 amount step (paymentReceivedFlow) is the model; its guards are
 * copied, not reinvented. Pure logic lives in services/returnRate.js.
 *
 * It lives behind the typed-return flow's two entries (session type
 * 'return_bundle_flow', step 'admin_rate'; callbacks `rb:r…`) because the
 * controller already hands those to returnBundleFlow. Every chip is
 * re-checked against the live request (still pending, still a return, the
 * tapper is an admin and not the requester); answers live in the session
 * until the ✅ chip, which carries the fingerprint of what it confirms.
 *
 *   rb:rv:<id>:<gi>   the rate this customer last paid, for gap gi
 *   rb:rn:<id>:<gi>   ⏭ No credit for these
 *   rb:re:<id>        ✏️ Type the rate (re-opens the step; also after a restart)
 *   rb:rc:<id>        ✏️ Change rate (back to the first gap)
 *   rb:rx:<id>        ✖ Not now
 *   rb:ry:<id>:<hash> ✅ Approve with this credit (the entering admin)
 *   rb:rk:<id>:<hash> ✅ Approve · credit N (a second admin checks it)
 */

const sessionStore = require('../utils/sessionStore');
const config = require('../config');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const returnRate = require('../services/returnRate');
const { parseRateNumber } = require('../utils/rateInput');
const money = require('../utils/money');
const { fmtQty } = require('../utils/format');
const logger = require('../utils/logger');

const SESSION_TYPE = 'return_bundle_flow';   // returnBundleFlow.SESSION_TYPE (the controller's entry)
const STEP = 'admin_rate';
const NS = 'rb:';
/** An admin looks the rate up before typing: the step outlives the 5-minute default. */
const ADMIN_RATE_TTL_MS = 30 * 60 * 1000;
const NOT_NOW = 'Nothing was approved. The request still waits.';
const VERBS = /^(rv|rn|re|rc|rx|ry|rk):/;

const isAdmin = (id) => config.access.adminIds.map(String).includes(String(id));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const rateText = (n) => {
  const v = Number(n) || 0;
  return money.saleRate(v, { fraction: Number.isInteger(v) ? 0 : 2 });
};
const refOf = (requestId) => require('../services/approvalCards').shortRequestRef(requestId);

async function nameOf(id, bot) {
  try { return await require('../services/approvalCards').resolveUserLabel(String(id), bot); } catch (_) { return String(id); }
}

function approvalCount(row) {
  const required = require('../services/approvalGate').requiredFor(row);
  const signed = Array.isArray(row && row.actionJSON && row.actionJSON.approvals) ? row.actionJSON.approvals.length : 0;
  return { required, signed };
}

const liveStep = (uid, requestId) => {
  const s = sessionStore.get(uid);
  return s && s.type === SESSION_TYPE && s.step === STEP && (!requestId || s.requestId === requestId) ? s : null;
};

/**
 * Review 1 (R1-1) — the requester may not enter the rate on their own
 * request, by the same rule as the H1 self-approval guard
 * (approvalEvents.handleApprovalCallback): refused while ANOTHER admin
 * exists to review it (Railway ADMIN_IDS and the Users-sheet admins); a
 * sole admin may, or nothing they raise could ever clear. Like H1, a failed
 * enumeration does not block.
 */
function ownRequestRefused(row, uid) {
  if (!row || String(row.user) !== String(uid)) return false;
  try {
    const envAdmins = config.access.adminIds.map(String);
    let sheetAdmins = [];
    try { sheetAdmins = (require('../middlewares/auth')._internals.snapshotAdmins() || []).map(String); } catch (_) { /* cache not ready */ }
    return [...new Set([...envAdmins, ...sheetAdmins])].some((id) => id !== String(uid));
  } catch (e) {
    logger.warn(`RET-8: own-request check could not enumerate admins: ${e.message}`);
    return false;
  }
}
const OWN_REQUEST = '🔒 You cannot enter the rate on your own request — a second admin must.';

/* ── texts ────────────────────────────────────────────────────────────── */

function promptText(requestId, gaps, gi, note = '') {
  const g = gaps[gi];
  const head = `↩️ Return ${refOf(requestId)} · rate needed${gaps.length > 1 ? ` · ${gi + 1} of ${gaps.length}` : ''}`;
  return [
    head, '',
    `${g.customer || 'the buyer'} · ${g.design || '—'}`,
    `${plural(g.thans, 'than')} · ${fmtQty(g.yards)} yd ${g.thans === 1 ? 'has' : 'have'} no rate on the sale record.`,
    '',
    'Type the rate per yard this customer was charged, for example 1450.',
    'Nothing is approved until you confirm.',
    ...(note ? ['', note] : []),
  ].join('\n');
}

function promptKeyboard(requestId, gi, lastPaid, customer) {
  const rows = [];
  if (lastPaid > 0) {
    rows.push([{ text: `${rateText(lastPaid)} — last paid by ${String(customer || '').slice(0, 24)}`, callback_data: `${NS}rv:${requestId}:${gi}` }]);
  }
  rows.push([{ text: '⏭ No credit for these', callback_data: `${NS}rn:${requestId}:${gi}` }]);
  rows.push([
    { text: '✏️ Type the rate', callback_data: `${NS}re:${requestId}` },
    { text: '✖ Not now', callback_data: `${NS}rx:${requestId}` },
  ]);
  return rows;
}

/** The credit blocks of the check card, one per buyer with a gap. */
async function creditBlocks(aj, fills) {
  const blocks = [];
  for (const b of returnRate.creditByBuyer(aj, fills)) {
    if (!b.gaps.length) continue;
    const lines = [];
    for (const { gap, fill } of b.gaps) {
      lines.push(`${gap.customer || 'the buyer'} · ${gap.design || '—'} · ${plural(gap.thans, 'than')} · ${fmtQty(gap.yards)} yd`);
      const r = returnRate.fillRate(fill);
      lines.push(r > 0 ? `${rateText(r)} → credit ${returnRate.amountText(gap.yards * r)}` : 'no credit');
    }
    if (b.rated > 0 || b.gaps.length > 1) lines.push(`Credit for ${b.customer || 'the buyer'} on this return: ${returnRate.amountText(b.total)}`);
    try {
      const { outstandingAsOfToday } = await require('../services/accountingService').getCustomerLedger(b.customer);
      const now = Number(outstandingAsOfToday);
      // Omitted, never guessed, when the ledger cannot be read.
      if (Number.isFinite(now)) lines.push(`Outstanding ${returnRate.amountText(now)} → ${returnRate.amountText(now - b.total)}`);
    } catch (_) { /* the line is left out */ }
    blocks.push(lines.join('\n'));
  }
  return blocks;
}

/**
 * Review 2 (R2-1) — the credit of the buyers the check card SHOWS (those
 * with a gap): the one figure on the chip a second admin signs under must
 * be on the card above it. Another buyer's rated thans on the same return
 * are not part of the rate being checked and are not added in.
 */
const shownCredit = (aj, fills) => returnRate.round2(returnRate.creditByBuyer(aj, fills)
  .filter((b) => b.gaps.length).reduce((s, b) => s + b.total, 0));

async function checkText(row, fills) {
  const { required, signed } = approvalCount(row);
  const completes = signed + 1 >= required;
  return [
    `↩️ Return ${refOf(row.requestId)} · check the credit`, '',
    (await creditBlocks(row.actionJSON || {}, fills)).join('\n\n'),
    '',
    completes ? 'Your approval completes the return.'
      : `Your approval is the first of ${required === 2 ? 'two' : required}. A second admin checks the rate.`,
  ].join('\n');
}

function checkKeyboard(requestId, fills) {
  const hash = returnRate.hashOf(returnRate.printOf(fills));
  return [
    [{ text: '✅ Approve with this credit', callback_data: `${NS}ry:${requestId}:${hash}` }],
    [
      { text: '✏️ Change rate', callback_data: `${NS}rc:${requestId}` },
      { text: '✖ Not now', callback_data: `${NS}rx:${requestId}` },
    ],
  ];
}

/** The second admin's check of fills another admin entered. */
async function secondCheckText(row) {
  const aj = row.actionJSON || {};
  const by = (aj.rateFillBy && (aj.rateFillBy.name || aj.rateFillBy.id)) || 'An admin';
  const { required, signed } = approvalCount(row);
  const fills = returnRate.fillsOf(aj);
  // Review 2 (R2-1) — "typed this rate" only when a rate was typed.
  const allNone = fills.length > 0 && fills.every((f) => !(returnRate.fillRate(f) > 0));
  return [
    `↩️ Return ${refOf(row.requestId)} · check the credit`, '',
    (await creditBlocks(aj, fills)).join('\n\n'),
    '',
    allNone ? `${by} chose no credit for these. Check it before you approve.` : `${by} typed this rate. Check it before you approve.`,
    signed + 1 >= required ? 'Your approval completes the return.' : 'Your approval is recorded; another admin still signs.',
  ].join('\n');
}

function secondCheckKeyboard(row) {
  const aj = row.actionJSON || {};
  const fills = returnRate.fillsOf(aj);
  const total = shownCredit(aj, fills);
  const hash = returnRate.hashOf(returnRate.printOf(fills));
  return [
    [{ text: total > 0 ? `✅ Approve · credit ${returnRate.amountText(total)}` : '✅ Approve · no credit', callback_data: `${NS}rk:${row.requestId}:${hash}` }],
    [{ text: '✖ Not now', callback_data: `${NS}rx:${row.requestId}` }],
  ];
}

/* ── drawing ──────────────────────────────────────────────────────────── */

/** The bot and chat that last drew each admin's step (for the replaced-session note). */
const botFor = new Map();

/**
 * Review 2 (R2-5) — another flow took the admin's session while the step
 * was open (the 🛂 inbox's ⬅ Back, a tile): the step message must not keep
 * looking live, or a typed rate goes to whatever owns the chat now. It is
 * rewritten to say it closed, with the chip that reopens it. Nothing was
 * recorded: answers live in the session until ✅.
 */
function onStepReplaced(userId, prev) {
  if (!prev || prev.type !== SESSION_TYPE || prev.step !== STEP || !prev.flowMessageId || !prev.requestId) return;
  const at = botFor.get(String(userId));
  if (!at || !at.bot) return;
  const text = `Rate step for return ${refOf(prev.requestId)} closed — nothing was approved. The request still waits.\nTap ✏️ Type the rate to open it again.`;
  Promise.resolve()
    .then(() => at.bot.editMessageText(text, {
      chat_id: at.chatId, message_id: prev.flowMessageId,
      reply_markup: { inline_keyboard: [[
        { text: '✏️ Type the rate', callback_data: `${NS}re:${prev.requestId}` },
        { text: '✖ Not now', callback_data: `${NS}rx:${prev.requestId}` },
      ]] },
    }))
    .catch(() => { /* too old to edit, or already gone */ });
}
sessionStore.onReplaced(onStepReplaced);

/**
 * Draw a step screen: edit `editId` when given, else drop the previous step
 * message and send a new one as a reply to the approval card (a typed reply
 * sits below the old screen). Plain text: names carry `_` and `*`.
 */
async function draw(bot, chatId, uid, session, text, rows, { editId = null } = {}) {
  const kb = { inline_keyboard: rows };
  let messageId = null;
  if (editId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: editId, reply_markup: kb });
      messageId = editId;
    } catch (e) {
      if (/message is not modified/i.test(String(e && e.message))) messageId = editId;
    }
  }
  if (!messageId) {
    if (session && session.flowMessageId && String(session.flowMessageId) !== String(editId || '')) {
      try { await bot.deleteMessage(chatId, session.flowMessageId); } catch (_) { /* already gone */ }
    }
    const sent = await bot.sendMessage(chatId, text, {
      reply_markup: kb,
      ...(session && session.cardMessageId ? { reply_to_message_id: session.cardMessageId, allow_sending_without_reply: true } : {}),
    });
    messageId = sent && sent.message_id;
  }
  if (messageId) botFor.set(String(uid), { bot, chatId });
  if (session) {
    session.flowMessageId = messageId || null;
    // Review 1 (R1-13) — when the step was last on screen: a sale wizard
    // touched after it takes the admin's typed replies instead.
    session.touchedAt = Date.now();
    sessionStore.set(uid, session);
  }
  return messageId;
}

async function lastPaidFor(gap) {
  try {
    const rate = await require('../events/approvalEvents').getLastPaidRate(gap.customer, gap.design);
    return Number(rate) > 0 ? Number(rate) : 0;
  } catch (_) { return 0; }
}

/** Draw the prompt for the session's current gap, or the check card when all are answered. */
async function drawCurrent(bot, chatId, uid, session, row, { editId = null, note = '' } = {}) {
  const gaps = returnRate.gapsOf(row.actionJSON);
  const gi = Math.max(0, Math.min(Number(session.gi) || 0, gaps.length));
  session.gi = gi;
  if (gi >= gaps.length) {
    const fills = returnRate.buildFills(gaps, session.answers || []);
    if (fills) {
      await draw(bot, chatId, uid, session, await checkText(row, fills), checkKeyboard(row.requestId, fills), { editId });
      return;
    }
    session.gi = 0; session.answers = [];
  }
  const g = gaps[session.gi];
  session.lastPaid = session.lastPaid || {};
  if (session.lastPaid[g.key] === undefined) session.lastPaid[g.key] = await lastPaidFor(g);
  await draw(bot, chatId, uid, session, promptText(row.requestId, gaps, session.gi, note),
    promptKeyboard(row.requestId, session.gi, session.lastPaid[g.key], g.customer), { editId });
}

/**
 * Open the rate step for one admin over a live session (NAV-1: the other
 * flow's messages come down; the approval card stays).
 */
async function openStep(bot, chatId, adminId, row, { cardMessageId = null, editMessageId = null, keep = false } = {}) {
  const live = sessionStore.get(adminId);
  const mine = live && live.type === SESSION_TYPE && live.step === STEP;
  // Review 1 (R1-14) — one person has one open flow. The other one comes
  // down (NAV-1), and the admin is told which, never silently.
  const closed = live && !mine ? closedFlowWords(live) : '';
  if (live && !mine) {
    try { await require('../services/sessionJanitor').leaveFlow(bot, adminId, cardMessageId || editMessageId); } catch (_) { /* best-effort */ }
  }
  const resume = keep && mine && live.requestId === row.requestId;
  const session = {
    ttlMs: ADMIN_RATE_TTL_MS,
    type: SESSION_TYPE, step: STEP, requestId: row.requestId,
    gi: resume ? live.gi : 0, answers: resume ? (live.answers || []) : [], lastPaid: resume ? (live.lastPaid || {}) : {},
    flowMessageId: mine ? live.flowMessageId : null,
    cardMessageId: cardMessageId || (mine && live.requestId === row.requestId ? live.cardMessageId : null) || null,
  };
  sessionStore.set(adminId, session);
  await drawCurrent(bot, chatId, adminId, session, row, {
    editId: editMessageId,
    note: closed ? `ℹ️ ${closed} was closed to open this step.` : '',
  });
  return { closed };
}

/** What the admin had open, in words (`Your return draft`), for the closing note. */
function closedFlowWords(live) {
  if (!live || !live.type) return '';
  // Review 2 (R2-6) — the 🛂 inbox's card is the one the step answers and it
  // stays on screen with working buttons: nothing the admin had was lost.
  if (live.type === 'approvals_inbox_flow') return '';
  if (live.type === SESSION_TYPE && Array.isArray(live.bales) && live.bales.length) return 'Your own return draft';
  return 'The screen you had open';
}

/* ── the seam (approvalEvents.handleApprovalCallback) ─────────────────── */

/**
 * RET-8 — called by approvalEvents.handleApprovalCallback for an Approve on
 * a return with a gap, after the already-decided, self-approval and
 * super-admin guards, under the per-request lock, outside any catch that
 * falls back to single approval.
 *
 *   no gap                              → `{ stop:false }` (nothing changes)
 *   gap, already signed, no fill        → `{ stop:false }` (as before: no credit for the gap)
 *   gap, no signature, no fill, no      → the rate step opens; nothing is
 *     `rateFill`                          recorded; `{ stop:true }`
 *   gap, no fill, `rateFill`            → saved on the row with `rateFillBy`
 *                                         in one write and read back; a
 *                                         refused or different save stops;
 *                                         else `{ stop:false }`
 *   fills saved, `rateFill` again       → a stale chip: approves nothing
 *                                         (unless it is this admin's own same
 *                                         fills — a retry)
 *   fills another admin saved, no       → the check card opens; nothing is
 *     `rateChecked` equal to their print  recorded; `{ stop:true }`
 *
 * @returns {Promise<{stop:boolean}>}
 */
async function rateSeam(bot, callbackQuery, requestId, item, opts = {}) {
  const adminId = String(callbackQuery.from.id);
  const aj = (item && item.actionJSON) || {};
  const toast = async (text, alert) => {
    try { await bot.answerCallbackQuery(callbackQuery.id, { text, show_alert: !!alert }); } catch (_) { /* stale query */ }
  };
  const state = returnRate.stepState(aj);
  if (state === 'none') return { stop: false };
  const proposed = Array.isArray(opts.rateFill) ? opts.rateFill : null;
  const signedIds = (Array.isArray(aj.approvals) ? aj.approvals : []).map(String);

  if (state === 'legacy') {
    // Signed before any rate was asked (a request from before RET-8): it
    // finishes as it always did. A rate chip on it is stale.
    if (!proposed) return { stop: false };
    await toast('This return was signed before a rate was asked — nothing was approved. Open the card to approve or reject it.', true);
    return { stop: true };
  }

  if (state === 'filled') {
    const fills = returnRate.fillsOf(aj);
    const print = returnRate.printOf(fills);
    const by = aj.rateFillBy || {};
    if (proposed) {
      if (String(by.id || '') === adminId && returnRate.printOf(proposed) === print) return { stop: false }; // a retry of one's own entry
      const who = by.name || (by.id ? await nameOf(by.id, bot) : 'Another admin');
      await toast(`${who} already entered the rate for this return. Open the card to approve or reject it.`, true);
      return { stop: true };
    }
    if (signedIds.includes(adminId)) return { stop: false }; // the gate refuses a second signature
    if (String(by.id || '') === adminId) return { stop: false };
    if (opts.rateChecked && String(opts.rateChecked) === returnRate.hashOf(print)) return { stop: false };
    if (opts.rateChecked) {
      await toast('The rate on this return changed — nothing was approved. Open the card again.', true);
      return { stop: true };
    }
    await toast('Check the rate first.');
    try {
      const row = { ...item, requestId };
      await bot.sendMessage(callbackQuery.message.chat.id, await secondCheckText(row), {
        reply_markup: { inline_keyboard: secondCheckKeyboard(row) },
        reply_to_message_id: callbackQuery.message.message_id, allow_sending_without_reply: true,
      });
    } catch (e) { logger.warn(`RET-8: rate check for ${requestId} not drawn: ${e.message}`); }
    return { stop: true };
  }

  // state === 'ask' — no signature, no fill yet.
  if (!proposed) {
    const live = sessionStore.get(adminId);
    const closing = live && !(live.type === SESSION_TYPE && live.step === STEP) ? closedFlowWords(live) : '';
    await toast(closing ? `Type the rate first. ${closing} was closed.` : 'Type the rate first.', !!closing);
    try {
      await openStep(bot, callbackQuery.message.chat.id, adminId, { ...item, requestId },
        { cardMessageId: callbackQuery.message.message_id });
    } catch (e) { logger.warn(`RET-8: rate step for ${requestId} not drawn: ${e.message}`); }
    return { stop: true };
  }
  // The fills are rebuilt from the row's own gaps: a chip can only answer
  // the gaps the request has NOW, with a rate above zero or "no credit".
  const gaps = returnRate.gapsOf(aj);
  const answers = gaps.map((g) => proposed.find((p) => p && p.key === g.key) || null);
  const fills = proposed.length === gaps.length && answers.every(Boolean) ? returnRate.buildFills(gaps, answers) : null;
  if (!fills) {
    await toast('The goods on this return changed — nothing was approved. Open the card again.', true);
    return { stop: true };
  }
  const rateFillBy = { id: adminId, name: await nameOf(adminId, bot), at: new Date().toISOString() };
  let saved = false;
  try {
    saved = await approvalQueueRepository.updateActionJSON(requestId, { rateFill: fills, rateFillBy });
  } catch (e) {
    logger.error(`RET-8 rate save failed for ${requestId} — nothing approved: ${e.message}`);
  }
  if (!saved) {
    await toast('⚠️ Could not save the rate — nothing was approved. Tap again in a minute.', true);
    return { stop: true };
  }
  // Read the row back: the signature below is given for THESE fills only.
  let fresh = null;
  try { fresh = await approvalQueueRepository.getByRequestId(requestId); } catch (_) { /* unreadable: refused below */ }
  const fa = (fresh && fresh.actionJSON) || {};
  const stillMine = fresh && String(fresh.status || '').toLowerCase() === 'pending'
    && returnRate.printOf(returnRate.fillsOf(fa)) === returnRate.printOf(fills)
    && fa.rateFillBy && String(fa.rateFillBy.id) === adminId
    && !(Array.isArray(fa.approvals) && fa.approvals.length);
  if (!stillMine) {
    logger.warn(`RET-8 rate for ${requestId} did not read back as entered by ${adminId} — nothing approved`);
    await toast('⚠️ The rate on this return changed while you typed — nothing was approved. Open the card again.', true);
    return { stop: true };
  }
  Object.assign(aj, fa, { rateFill: fa.rateFill, rateFillBy: fa.rateFillBy });
  if (item) item.actionJSON = aj;
  try {
    await require('../repositories/auditLogRepository').append('return_rate_entered',
      { requestId, fills, admin: { id: adminId, name: rateFillBy.name } }, adminId);
  } catch (e) { logger.warn(`RET-8 rate audit for ${requestId} failed: ${e.message}`); }
  return { stop: false };
}

/* ── the step's taps ──────────────────────────────────────────────────── */

/** Every tap re-checks the request (the chips outlive sessions). The live row, or null after saying what is true. */
async function liveForRate(bot, query, requestId) {
  const uid = String(query.from.id);
  const answer = async (text, alert) => {
    try { await bot.answerCallbackQuery(query.id, text ? { text, show_alert: !!alert } : undefined); } catch (_) { /* stale */ }
  };
  const close = async (text) => {
    try {
      await bot.editMessageText(text, { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
    } catch (_) { /* too old to edit */ }
  };
  if (!isAdmin(uid)) { await answer('Only admins can approve.', true); return null; }
  let row = null;
  try { row = await approvalQueueRepository.getByRequestId(requestId); } catch (_) { /* unreadable: said below */ }
  if (!row) { await answer('That request could not be read just now. Try again in a minute.', true); return null; }
  const aj = row.actionJSON || {};
  if (!returnRate.isReturn(aj)) { await answer('Not a return.', true); return null; }
  const st = String(row.status || '').toLowerCase();
  if (st !== 'pending') {
    await answer(`Already ${st} — nothing to do.`);
    await close(`Already ${st} — nothing to do.`);
    if (liveStep(uid, requestId)) sessionStore.clear(uid);
    return null;
  }
  if (ownRequestRefused(row, uid)) {
    await answer(OWN_REQUEST, true);
    return null;
  }
  if (!returnRate.gapsOf(aj).length) {
    await answer('This return needs no rate.', true);
    await close('This return needs no rate. Open the card to approve or reject it.');
    return null;
  }
  return row;
}

/** Why a rate can no longer be entered on this row, or ''. */
async function closedReason(bot, row, uid) {
  const aj = row.actionJSON || {};
  const state = returnRate.stepState(aj);
  if (state === 'legacy') return 'This return was signed before a rate was asked. Open the card to approve or reject it.';
  if (state === 'filled') {
    const by = aj.rateFillBy || {};
    if (String(by.id || '') === uid) return 'You already entered the rate. Open the card to approve it.';
    const who = by.name || (by.id ? await nameOf(by.id, bot) : 'Another admin');
    return `${who} already entered the rate for this return. Open the card to approve or reject it.`;
  }
  return '';
}

/**
 * Hand the ✅ chip to the standard approval handler as THIS admin's Approve
 * (`opts` = the fills, or the checked fingerprint), then rewrite the step
 * message to what is recorded now.
 */
async function delegateApprove(bot, query, requestId, opts) {
  const uid = String(query.from.id);
  const chatId = query.message.chat.id;
  const cardMsg = query.message.reply_to_message || null;
  const cardKb = (cardMsg && cardMsg.reply_markup && cardMsg.reply_markup.inline_keyboard) || [];
  const cardLive = cardKb.flat().some((b) => b && (b.callback_data === `approve:${requestId}` || b.callback_data === `abx:ok:${requestId}`));
  const message = cardLive ? { ...cardMsg, chat: cardMsg.chat || query.message.chat } : query.message;
  const delegated = Object.assign(Object.create(Object.getPrototypeOf(query)), query, { data: `approve:${requestId}`, message });
  await require('../events/approvalEvents').handleApprovalCallback(bot, delegated, 'approve', opts);
  let after = null;
  try { after = await approvalQueueRepository.getByRequestId(requestId); } catch (_) { /* unreadable: no closing line */ }
  const aaj = (after && after.actionJSON) || {};
  const st = String((after && after.status) || '').toLowerCase();
  const signedNow = Array.isArray(aaj.approvals) && aaj.approvals.map(String).includes(uid);
  const ref = refOf(requestId);
  let closing = '';
  if (st === 'approved') closing = `✅ Return ${ref} is approved.`;
  else if (st === 'pending' && signedNow) {
    const { required, signed } = approvalCount(after);
    closing = opts.rateChecked
      ? `✅ You approved the credit — approval ${signed} of ${required}.`
      : `✅ You entered the rate and gave approval ${signed} of ${required}. A second admin checks it.`;
  } else if (st === 'rejected') closing = 'Already rejected — nothing to do.';
  else if (st === 'pending' && opts.rateFill && returnRate.fillsOf(aaj).length && aaj.rateFillBy && String(aaj.rateFillBy.id) !== uid) {
    closing = `${aaj.rateFillBy.name || 'Another admin'} already entered the rate for this return. Open the card to approve or reject it.`;
  }
  if (!closing) return;
  if (liveStep(uid, requestId)) sessionStore.clear(uid);
  try {
    await bot.editMessageText(closing, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
  } catch (_) { /* too old to edit */ }
}

/**
 * The `rb:r…` taps. Returns false for any other rb: callback.
 * @param {string} rest the data after `rb:`
 */
async function handleCallback(bot, query, rest) {
  if (!VERBS.test(rest)) return false;
  const uid = String(query.from.id);
  const chatId = query.message && query.message.chat && query.message.chat.id;
  const answer = async (text, alert) => {
    try { await bot.answerCallbackQuery(query.id, text ? { text, show_alert: !!alert } : undefined); } catch (_) { /* stale */ }
  };
  const verb = rest.slice(0, 2);
  const body = rest.slice(3);
  // Request ids carry hyphens, never a colon: the argument is after the LAST one.
  const cut = ['rv', 'rn', 'ry', 'rk'].includes(verb) ? body.lastIndexOf(':') : -1;
  const requestId = cut > 0 ? body.slice(0, cut) : body;
  const arg = cut > 0 ? body.slice(cut + 1) : '';

  if (verb === 'rx') {
    if (!isAdmin(uid)) { await answer('Only admins can approve.', true); return true; }
    await answer();
    let st = 'pending';
    try {
      const row = await approvalQueueRepository.getByRequestId(requestId);
      if (row) st = String(row.status || 'pending').toLowerCase();
    } catch (_) { /* unreadable: the usual sentence */ }
    if (liveStep(uid, requestId)) sessionStore.clear(uid);
    try {
      await bot.editMessageText(st === 'approved' || st === 'rejected' ? `Already ${st} — nothing to do.` : NOT_NOW,
        { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
    } catch (_) { /* too old to edit */ }
    return true;
  }

  const row = await liveForRate(bot, query, requestId);
  if (!row) return true;
  const aj = row.actionJSON || {};
  const cardMsg = query.message.reply_to_message || null;

  if (verb === 'rk') {
    // A second admin approves the fills they were shown.
    const fills = returnRate.fillsOf(aj);
    const by = aj.rateFillBy || {};
    let said = '';
    if (!fills.length) said = 'This return has no rate yet. Tap ✅ Approve on the card.';
    else if (arg !== returnRate.hashOf(returnRate.printOf(fills))) said = 'The rate on this return changed. Tap ✅ Approve on the card again.';
    else if (!by.id || String(by.id) === uid) said = '🔏 You typed this rate — a different admin must check it.';
    if (said) {
      await answer(said, true);
      try { await bot.editMessageText(said, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch (_) { /* too old */ }
      return true;
    }
    await delegateApprove(bot, query, requestId, { rateChecked: arg });
    return true;
  }

  const closed = await closedReason(bot, row, uid);
  if (closed) {
    await answer(closed, true);
    if (liveStep(uid, requestId)) sessionStore.clear(uid);
    try { await bot.editMessageText(closed, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch (_) { /* too old */ }
    return true;
  }

  if (verb === 're' || verb === 'rc') {
    await answer();
    await openStep(bot, chatId, uid, row, {
      cardMessageId: cardMsg ? cardMsg.message_id : null,
      editMessageId: query.message.message_id,
      keep: verb === 're',
    });
    return true;
  }

  const session = liveStep(uid, requestId);
  if (verb === 'ry') {
    const gaps = returnRate.gapsOf(aj);
    const fills = session ? returnRate.buildFills(gaps, session.answers || []) : null;
    if (!fills || returnRate.hashOf(returnRate.printOf(fills)) !== arg) {
      const said = '⚠️ This step expired — nothing was approved. Tap ✏️ Type the rate to start again.';
      await answer('Nothing was approved.', true);
      try {
        await bot.editMessageText(said, {
          chat_id: chatId, message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: '✏️ Type the rate', callback_data: `${NS}re:${requestId}` }, { text: '✖ Not now', callback_data: `${NS}rx:${requestId}` }]] },
        });
      } catch (_) { /* too old */ }
      if (session) sessionStore.clear(uid);
      return true;
    }
    await answer();
    await delegateApprove(bot, query, requestId, { rateFill: fills });
    return true;
  }

  // rv / rn — answer the current gap.
  const gi = parseInt(arg, 10);
  if (!session || session.gi !== gi) {
    // A chip from an older screen, or the session is gone: show the live step.
    await answer('That screen moved on.');
    await openStep(bot, chatId, uid, row, {
      cardMessageId: cardMsg ? cardMsg.message_id : null, editMessageId: query.message.message_id, keep: true,
    });
    return true;
  }
  const gaps = returnRate.gapsOf(aj);
  const g = gaps[gi];
  if (!g) { await answer(); await drawCurrent(bot, chatId, uid, session, row, { editId: query.message.message_id }); return true; }
  if (verb === 'rv') {
    const last = Number((session.lastPaid || {})[g.key]) || 0;
    if (!(last > 0)) { await answer('No earlier rate to use — type it.', true); return true; }
    session.answers[gi] = { rate: last };
    await answer(rateText(last));
  } else {
    session.answers[gi] = { noCredit: true };
    await answer('No credit for these');
  }
  session.gi = gi + 1;
  sessionStore.set(uid, session);
  await drawCurrent(bot, chatId, uid, session, row, { editId: query.message.message_id });
  return true;
}

/**
 * Review 2 (R2-3) — a typed line that belongs to another door: it opens with
 * a word of the typed script (`Return 6189/5`, `Sell …`, `Stock 9006`). Any
 * other line with a digit (`rate 1450`, `at 1450`, `N 1450`) is a try at
 * the rate: the step keeps it and says what a rate looks like.
 */
function opensAnotherDoor(text) {
  const first = String(text || '').trim().replace(/^\/+/, '').split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  if (!first) return false;
  try {
    return Object.prototype.hasOwnProperty.call(require('../utils/typedRouter').VERBS, first);
  } catch (_) { return false; }
}

/** The typed rate. True when the step took the message. */
async function handleText(bot, msg, session) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();
  if (!text || text.startsWith('/')) return false;
  // Review 1 (R1-13) — APC-1's rule for typed replies: they go to what the
  // admin touched LAST. A sale approval wizard opened or tapped after this
  // step was drawn takes the line (its Step 2 asks for a rate too).
  try {
    const wiz = require('../events/approvalEvents')._internals.activeWizard(userId, { forTyping: true });
    const wizAt = wiz ? Number(wiz.touchedAt || wiz.startedAt || 0) : 0;
    if (wiz && wizAt > Number(session.touchedAt || 0)) return false;
  } catch (_) { /* no wizard registry: the step keeps the line */ }
  // Review 1 (R1-15) — a typed way out, and a line that is plainly not a
  // rate (a word first, or no digit at all — `Return 6189/5`, `hello`)
  // closes the step and goes on to wherever it belongs. Nothing is approved.
  const ref = refOf(session.requestId);
  if (/^(cancel|stop|not now|exit)$/i.test(text) || !/\d/.test(text) || opensAnotherDoor(text)) {
    sessionStore.clear(userId);
    const said = `Rate step for return ${ref} closed — nothing was approved. The request still waits.`;
    if (session.flowMessageId) {
      try {
        await bot.editMessageText(said, { chat_id: chatId, message_id: session.flowMessageId, reply_markup: { inline_keyboard: [] } });
      } catch (_) { /* too old to edit */ }
    }
    if (/^(cancel|stop|not now|exit)$/i.test(text)) {
      await bot.sendMessage(chatId, said);
      return true;
    }
    return false;
  }
  let row = null;
  try { row = await approvalQueueRepository.getByRequestId(session.requestId); } catch (_) { /* unreadable: said below */ }
  const st = row ? String(row.status || '').toLowerCase() : '';
  if (!row || st !== 'pending' || !returnRate.isReturn(row.actionJSON) || returnRate.stepState(row.actionJSON) !== 'ask'
    || ownRequestRefused(row, userId) || !isAdmin(userId)) {
    sessionStore.clear(userId);
    let said = 'This return no longer needs a rate from you. Open 🛂 Approvals to see it.';
    if (!row) said = 'That request could not be read just now — nothing was approved. Tap ✅ Approve on the card again in a minute.';
    else if (st && st !== 'pending') said = `Already ${st} — nothing to do.`;
    else if (!isAdmin(userId)) said = 'Only admins can approve.';
    else if (ownRequestRefused(row, userId)) said = OWN_REQUEST;
    else said = (await closedReason(bot, row, userId)) || said;
    await bot.sendMessage(chatId, said);
    return true;
  }
  const gaps = returnRate.gapsOf(row.actionJSON);
  const gi = Math.max(0, Math.min(Number(session.gi) || 0, gaps.length));
  if (gi >= gaps.length) {
    // Every gap is answered: the check card is the live screen.
    await drawCurrent(bot, chatId, userId, session, row);
    return true;
  }
  const rate = parseRateNumber(text);
  if (rate === null || !(rate > 0)) {
    await drawCurrent(bot, chatId, userId, session, row,
      { note: '⚠️ That is not a rate. Type a number above zero, for example 1450.' });
    return true;
  }
  session.answers = Array.isArray(session.answers) ? session.answers : [];
  session.answers[gi] = { rate };
  session.gi = gi + 1;
  sessionStore.set(userId, session);
  await drawCurrent(bot, chatId, userId, session, row);
  return true;
}

module.exports = {
  STEP,
  ADMIN_RATE_TTL_MS,
  rateSeam,
  handleCallback,
  handleText,
  _internals: { promptText, checkText, secondCheckText, openStep },
};
