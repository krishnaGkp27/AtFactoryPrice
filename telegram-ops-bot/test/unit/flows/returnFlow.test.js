'use strict';

/**
 * RET-4 — ↩️ Return goods, the customer-first multi-than return card
 * (specs/RET-3_RETURN_CREDIT.md Part B, owner-locked 02-Sep-2026).
 *
 * Drives the whole state machine offline — customer → bale → tick thans →
 * returned-on (quick chip AND the calendar leg) → condition → photo →
 * confirm → submit — with no controller, no sheets and no network, and
 * pins the ONE contract the executor and the admin card agree on: the
 * queued `return_thans` payload.
 *
 * Dates are computed from today (dateCalendar.lagosISO), never hardcoded —
 * a fixed ISO would fall out of the calendar's reach as the repo ages.
 *
 * ANCH-1 — a chip tap still EDITS the card in place, but the user's own
 * message (a typed name, note or date; the goods photo) buries it, so the
 * flow deletes the old card and sends the next one BELOW that message. The
 * anchor therefore MOVES: after any typed or photo step the live card is
 * `session.flowMessageId`, not the tapped tile, and its text arrives as a
 * fresh sendMessage. `cbq()` follows that anchor; `lastText()`/`lastKb()`
 * read whichever call rendered last.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '555';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const sessionStore = require('../../../src/utils/sessionStore');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const customersRepository = require('../../../src/repositories/customersRepository');
const settingsRepository = require('../../../src/repositories/settingsRepository');
const unitDisplayService = require('../../../src/services/unitDisplayService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const approvalEvents = require('../../../src/events/approvalEvents');
const approvalCards = require('../../../src/services/approvalCards');
const dateCalendar = require('../../../src/utils/dateCalendar');
const fmtDate = require('../../../src/utils/formatDate');
const returnFlow = require('../../../src/flows/returnFlow');

const EMP = '555';
const ADMIN = '777';
const CHAT = 1;
const CARD = 42;                         // the tapped tile's message id

/* ── fixture ──────────────────────────────────────────────────────────────
 * ABBA holds four sold thans of Bale 9037 in Kano office (a than-visible
 * store → "4t") plus the whole of Bale 9040 in IDUMOTA ("1B"), so the
 * customer chip exercises BOTH halves of the qty labeller. CHIMA holds one
 * than elsewhere; one available row must never appear in the return door.
 */
const ROWS = [
  { rowIndex: 2, packageNo: '9037', design: 'Cashmere', shade: 'Blue', thanNo: 1, yards: 30, status: 'sold', warehouse: 'Kano office', pricePerYard: 2500, soldTo: 'ABBA', soldDate: '2026-08-20', arrivalBatch: 'Jul26', baleUid: 'BAL-9037-1' },
  { rowIndex: 3, packageNo: '9037', design: 'Cashmere', shade: 'Blue', thanNo: 2, yards: 30, status: 'sold', warehouse: 'Kano office', pricePerYard: 2500, soldTo: 'ABBA', soldDate: '2026-08-20', arrivalBatch: 'Jul26', baleUid: 'BAL-9037-2' },
  { rowIndex: 4, packageNo: '9037', design: 'Cashmere', shade: 'Blue', thanNo: 3, yards: 28, status: 'sold', warehouse: 'Kano office', pricePerYard: 2500, soldTo: 'ABBA', soldDate: '2026-08-20', arrivalBatch: 'Jul26', baleUid: 'BAL-9037-3' },
  { rowIndex: 5, packageNo: '9037', design: 'Cashmere', shade: 'Blue', thanNo: 4, yards: 30, status: 'sold', warehouse: 'Kano office', pricePerYard: 2500, soldTo: 'ABBA', soldDate: '2026-08-20', arrivalBatch: 'Jul26', baleUid: 'BAL-9037-4' },
  { rowIndex: 6, packageNo: '9040', design: 'TR', shade: 'Red', thanNo: 1, yards: 40, status: 'sold', warehouse: 'IDUMOTA', pricePerYard: 1000, soldTo: 'ABBA', soldDate: '2026-08-10', arrivalBatch: 'Jul26', baleUid: 'BAL-9040-1' },
  { rowIndex: 7, packageNo: '9050', design: 'Senator', shade: 'Cream', thanNo: 1, yards: 25, status: 'sold', warehouse: 'IDUMOTA', pricePerYard: 900, soldTo: 'CHIMA', soldDate: '2026-08-01', arrivalBatch: 'Jul26', baleUid: 'BAL-9050-1' },
  { rowIndex: 8, packageNo: '9060', design: 'Chinos', shade: 'Navy', thanNo: 1, yards: 20, status: 'available', warehouse: 'Kano office', pricePerYard: 800, soldTo: '', soldDate: '', arrivalBatch: 'Jul26', baleUid: 'BAL-9060-1' },
];

let rows = ROWS;
inventoryRepository.getAll = async () => rows.map((r) => ({ ...r }));
customersRepository.getAll = async () => [
  { customer_id: 'CUS-ABBA', name: 'ABBA', status: 'Active', aliases: [] },
  { customer_id: 'CUS-CHIMA', name: 'CHIMA', status: 'Active', aliases: [] },
];
settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: 'Kano office' });
unitDisplayService.invalidateCache();

const queued = [];
const audits = [];
const notified = [];
const forwarded = [];
const cardsBuilt = [];
approvalQueueRepository.append = async (rec) => { queued.push(rec); return rec; };
approvalQueueRepository.updateActionJSON = async () => true;
auditLogRepository.append = async (eventType, payload, user) => { audits.push({ eventType, payload, user }); };
approvalEvents.notifyAdminsApprovalRequest = async (bot, requestId, label, summary, reason, excludeId) => {
  notified.push({ requestId, label, summary, reason, excludeId });
  return { sent: 2, failed: 0 };
};
approvalCards.buildReturnThansCard = async (aj) => { cardsBuilt.push(aj); return '↩️ Return card'; };
approvalCards.resolveUserLabel = async (uid) => `User ${uid}`;
approvalCards.forwardAttachmentsToAdmins = async (bot, requestId, atts, excludeId) => {
  forwarded.push({ requestId, atts, excludeId });
  return atts.length;
};

function reset() {
  rows = ROWS;
  queued.length = 0; audits.length = 0; notified.length = 0;
  forwarded.length = 0; cardsBuilt.length = 0;
  sessionStore.clear(EMP); sessionStore.clear(ADMIN);
}

/**
 * fakeBot records call ARGUMENTS, not what it answered — and ANCH-1 makes
 * the id `sendMessage` RETURNS the flow's new anchor, so remember them.
 */
function makeBot() {
  const bot = createFakeBot();
  bot.sentIds = [];
  const send = bot.sendMessage;
  bot.sendMessage = async (chatId, text, opts) => {
    const m = await send(chatId, text, opts);
    bot.sentIds.push(m.message_id);
    return m;
  };
  return bot;
}
/** The id of the newest card the fake bot sent. */
function lastSentId(bot) { return bot.sentIds[bot.sentIds.length - 1]; }

/** The card the user is looking at RIGHT NOW (ANCH-1 moves the anchor). */
function liveCard(uid) {
  const s = sessionStore.get(uid);
  return (s && s.flowMessageId) || CARD;
}

let qid = 0;
/** A tap on the live card; pass `messageId` to tap a stale one on purpose. */
function cbq(data, uid = EMP, messageId) {
  qid += 1;
  const mid = messageId === undefined ? liveCard(uid) : messageId;
  return { id: `q${qid}`, data, from: { id: uid }, message: { chat: { id: CHAT }, message_id: mid } };
}
function txt(body, uid = EMP) {
  return { from: { id: uid }, chat: { id: CHAT }, text: body };
}
/**
 * The last card render — an in-place edit for a chip tap, or the fresh send
 * ANCH-1 drops below the user's own message. Both carry `text` and `opts`.
 */
function lastRender(bot) {
  const cards = bot.calls.filter((c) => c.method === 'editMessageText' || c.method === 'sendMessage');
  return cards.length ? cards[cards.length - 1] : null;
}
function lastText(bot) {
  const c = lastRender(bot);
  return c ? String(c.args.text || '') : '';
}
function lastKb(bot) {
  const c = lastRender(bot);
  const opts = c && c.args.opts;
  return (opts && opts.reply_markup && opts.reply_markup.inline_keyboard) || [];
}
function chipTexts(bot) { return lastKb(bot).flat().map((b) => b.text); }
function chipData(bot) { return lastKb(bot).flat().map((b) => b.callback_data); }
/** Every answerCallbackQuery recorded for one callback id. */
function answersFor(bot, id) {
  return bot.callsTo('answerCallbackQuery').filter((c) => c.args.callbackQueryId === id);
}

/** Walk customer → bale → two ticks → date, leaving the condition card up. */
async function walkToCondition(bot, uid = EMP) {
  await returnFlow.start(bot, CHAT, uid, CARD);
  await returnFlow.handleCallback(bot, cbq('rn:cust:0', uid));   // ABBA
  await returnFlow.handleCallback(bot, cbq('rn:bale:0', uid));   // 9037 (Kano office)
  await returnFlow.handleCallback(bot, cbq('rn:t:0', uid));      // ☑ #1
  await returnFlow.handleCallback(bot, cbq('rn:t:3', uid));      // ☑ #4
  await returnFlow.handleCallback(bot, cbq('rn:tnext', uid));
  const iso = dateCalendar.lagosISO(2);
  await returnFlow.handleCallback(bot, cbq(`rn:dd:${iso}`, uid));
  return iso;
}

/** …then damaged + a typed note + a photo, leaving the confirm card up. */
async function walkToConfirm(bot, uid = EMP) {
  const iso = await walkToCondition(bot, uid);
  await returnFlow.handleCallback(bot, cbq('rn:c:damaged', uid));
  await returnFlow.handleText(bot, txt('6 yd cut off', uid));
  await returnFlow.handlePhoto(bot, {
    from: { id: uid }, chat: { id: CHAT },
    photo: [{ file_id: 'ph-small' }, { file_id: 'ph-1' }],
  });
  return iso;
}

/* ── 1 · the first card ───────────────────────────────────────────────── */

test('RET-4 · start renders the customer card, anchored on the tapped tile', async () => {
  reset();
  const bot = makeBot();
  await returnFlow.start(bot, CHAT, EMP, CARD);

  const s = sessionStore.get(EMP);
  assert.equal(s.type, 'return_flow');
  assert.equal(s.step, 'customer');
  assert.equal(s.flowMessageId, CARD, 'the tile message is the anchor');

  assert.equal(bot.callsTo('sendMessage').length, 0, 'navigation edits, never appends');
  assert.equal(bot.callsTo('editMessageText')[0].args.opts.message_id, CARD);
  assert.match(lastText(bot), /Who is returning\?/);

  // One chip per customer with goods out — labelled by the RESOLVED qty
  // labeller (createQtyLabeller is async; an un-awaited Promise would blow
  // up the moment it is called as a function).
  const chips = chipTexts(bot);
  assert.deepEqual(chipData(bot).filter((d) => d.startsWith('rn:cust:')), ['rn:cust:0', 'rn:cust:1']);
  assert.ok(chips.includes('👤 ABBA · 1B + 4t'), `labeller output on the chip, got: ${chips.join(' | ')}`);
  assert.ok(chips.includes('👤 CHIMA · 1B'), `got: ${chips.join(' | ')}`);
  assert.ok(chips.includes('🔎 Type a name'));
  assert.ok(chips.includes('❌ Cancel'));
  assert.ok(chipData(bot).includes('act:__back__'), 'a session-free way home');
  // The available bale is not out with anybody.
  assert.ok(!chips.some((c) => /9060/.test(c)));
});

test('RET-4 · no goods out anywhere is said plainly and the session closes', async () => {
  reset();
  rows = ROWS.filter((r) => r.status !== 'sold');
  const bot = makeBot();
  await returnFlow.start(bot, CHAT, EMP, CARD);
  assert.match(lastText(bot), /No goods are out with any customer right now\./);
  assert.equal(sessionStore.get(EMP), null, 'nothing to steer — the session is cleared');
  rows = ROWS;
});

/* ── 2 · every step, in order, on ONE card ────────────────────────────── */

test('RET-4 · the whole path walks customer → bale → thans → date → condition → photo → confirm', async () => {
  reset();
  const bot = makeBot();
  await returnFlow.start(bot, CHAT, EMP, CARD);
  const step = () => sessionStore.get(EMP).step;

  await returnFlow.handleCallback(bot, cbq('rn:cust:0'));
  assert.equal(step(), 'bale');
  // The warehouse sits right after the number (TRF-INT4 — it is the only
  // differing token when one printed number was sold in two stores).
  assert.ok(chipTexts(bot).some((c) => /9037.*🏭 Kano office.*Cashmere Blue/.test(c)),
    `bale chip, got: ${chipTexts(bot).join(' | ')}`);

  await returnFlow.handleCallback(bot, cbq('rn:bale:0'));
  assert.equal(step(), 'thans');
  assert.deepEqual(chipData(bot).filter((d) => d.startsWith('rn:t:')),
    ['rn:t:0', 'rn:t:1', 'rn:t:2', 'rn:t:3']);

  await returnFlow.handleCallback(bot, cbq('rn:t:0'));
  await returnFlow.handleCallback(bot, cbq('rn:t:3'));
  await returnFlow.handleCallback(bot, cbq('rn:tnext'));
  assert.equal(step(), 'date');

  // The date leg in full: the 📆 chip and the ◀ ▶ nav are BOTH `rn:dm:`,
  // the grid cells `rn:dd:`, its headers `rn:noop`, and ⬅ Quick dates
  // `rn:dq`. Handling only `rn:dd:` would leave the calendar unopenable.
  const thisYm = dateCalendar.lagosISO(0).slice(0, 7);
  assert.ok(chipData(bot).some((d) => d === `rn:dm:${thisYm}`), 'the calendar door');
  await returnFlow.handleCallback(bot, cbq(`rn:dm:${thisYm}`));
  assert.equal(step(), 'date_cal');
  assert.ok(chipData(bot).some((d) => d.startsWith('rn:dd:')), 'grid days');
  assert.ok(chipData(bot).some((d) => d === 'rn:noop'), 'inert cells');

  const before = JSON.stringify(sessionStore.get(EMP));
  await returnFlow.handleCallback(bot, cbq('rn:noop'));
  assert.equal(JSON.stringify(sessionStore.get(EMP)), before, 'noop mutates nothing');

  const prevYm = dateCalendar.lagosISO(45).slice(0, 7);
  await returnFlow.handleCallback(bot, cbq(`rn:dm:${prevYm}`));
  assert.equal(sessionStore.get(EMP).calYm, prevYm, 'month paging stays on the grid');
  await returnFlow.handleCallback(bot, cbq('rn:dq'));
  assert.equal(step(), 'date', '⬅ Quick dates goes back to the chips');

  const iso = dateCalendar.lagosISO(2);
  await returnFlow.handleCallback(bot, cbq(`rn:dd:${iso}`));
  assert.equal(step(), 'condition');
  assert.equal(sessionStore.get(EMP).returnedOn, iso);
  assert.match(lastText(bot), /How do the goods look\?/);
  // §6d — the condition never changes the stock status; say so where it is asked.
  assert.match(lastText(bot), /The than still goes back to stock/);

  await returnFlow.handleCallback(bot, cbq('rn:c:damaged'));
  assert.equal(step(), 'photo');
  assert.match(lastText(bot), /Send ONE photo/);

  await returnFlow.handleCallback(bot, cbq('rn:pskip'));
  assert.equal(step(), 'confirm');

  // Every single screen was an edit of the SAME card.
  assert.equal(bot.callsTo('sendMessage').length, 0);
  const ids = new Set(bot.callsTo('editMessageText').map((c) => c.args.opts.message_id));
  assert.deepEqual([...ids], [CARD]);
});

/* ── 3 · ticking ─────────────────────────────────────────────────────── */

test('RET-4 · ticks toggle, All selects everything, and Next refuses an empty set', async () => {
  reset();
  const bot = makeBot();
  await returnFlow.start(bot, CHAT, EMP, CARD);
  await returnFlow.handleCallback(bot, cbq('rn:cust:0'));
  await returnFlow.handleCallback(bot, cbq('rn:bale:0'));

  assert.ok(chipTexts(bot).includes('☐ #1 · 30 yds'), `got ${chipTexts(bot).join(' | ')}`);
  await returnFlow.handleCallback(bot, cbq('rn:t:0'));
  assert.ok(chipTexts(bot).includes('☑ #1 · 30 yds'));
  await returnFlow.handleCallback(bot, cbq('rn:t:0'));
  assert.ok(chipTexts(bot).includes('☐ #1 · 30 yds'), 'a second tap unticks');
  assert.deepEqual(sessionStore.get(EMP)._picked, []);

  await returnFlow.handleCallback(bot, cbq('rn:tall'));
  assert.deepEqual(sessionStore.get(EMP)._picked, [0, 1, 2, 3]);
  await returnFlow.handleCallback(bot, cbq('rn:tall'));
  assert.deepEqual(sessionStore.get(EMP)._picked, [], 'All toggles off again');

  // Empty Next: no move, and ONE answer carrying the alert. A re-introduced
  // eager ack would make this alert a silent no-op (§15 — no tap is silent).
  const q = cbq('rn:tnext');
  await returnFlow.handleCallback(bot, q);
  assert.equal(sessionStore.get(EMP).step, 'thans', 'nothing advanced');
  const answers = answersFor(bot, q.id);
  assert.equal(answers.length, 1, 'exactly one answer per callback id');
  assert.deepEqual(answers[0].args.opts, { text: 'Tick at least one than.', show_alert: true });
});

/* ── 4 · back and cancel ─────────────────────────────────────────────── */

test('RET-4 · Back walks the whole path in reverse; Cancel queues nothing', async () => {
  reset();
  const bot = makeBot();
  await walkToConfirm(bot);
  const step = () => sessionStore.get(EMP).step;
  assert.equal(step(), 'confirm');
  // ANCH-1 — the typed note and the photo each bumped the card once. From
  // here every tap must edit the card that is up, appending nothing.
  const sendsAfterWalk = bot.callsTo('sendMessage').length;
  assert.equal(sendsAfterWalk, 2, 'one fresh card per user message, no more');

  await returnFlow.handleCallback(bot, cbq('rn:back'));
  assert.equal(step(), 'photo');
  await returnFlow.handleCallback(bot, cbq('rn:back'));
  assert.equal(step(), 'condition');
  await returnFlow.handleCallback(bot, cbq('rn:back'));
  assert.equal(step(), 'date');
  await returnFlow.handleCallback(bot, cbq('rn:back'));
  assert.equal(step(), 'thans');
  assert.deepEqual(sessionStore.get(EMP)._picked, [0, 3], 'the ticks survive the walk back');
  await returnFlow.handleCallback(bot, cbq('rn:back'));
  assert.equal(step(), 'bale');
  await returnFlow.handleCallback(bot, cbq('rn:back'));
  assert.equal(step(), 'customer');

  await returnFlow.handleCallback(bot, cbq('rn:cancel'));
  assert.match(lastText(bot), /❌ Return cancelled — nothing was queued\./);
  assert.equal(sessionStore.get(EMP), null);
  assert.equal(queued.length, 0);
  // The cancel card is rendered BEFORE the clear (the renderer is strict),
  // and every tap since the photo edited the live card in place.
  assert.equal(bot.callsTo('sendMessage').length, sendsAfterWalk);

  assert.equal(returnFlow._internals.prevStep('customer'), '', 'no Back on the first card');
});

/* ── 5 · the photo ───────────────────────────────────────────────────── */

test('RET-4 · the photo step stores the LARGEST size and lands on confirm', async () => {
  reset();
  const bot = makeBot();
  await walkToCondition(bot);
  await returnFlow.handleCallback(bot, cbq('rn:c:good'));
  assert.equal(sessionStore.get(EMP).step, 'photo');

  const oldCard = sessionStore.get(EMP).flowMessageId;
  const editsBefore = bot.callsTo('editMessageText').length;
  const sendsBefore = bot.callsTo('sendMessage').length;
  const handled = await returnFlow.handlePhoto(bot, {
    from: { id: EMP }, chat: { id: CHAT },
    photo: [{ file_id: 'small' }, { file_id: 'mid' }, { file_id: 'largest' }],
  });
  assert.equal(handled, true);
  assert.equal(sessionStore.get(EMP).photoFileId, 'largest');
  assert.equal(sessionStore.get(EMP).step, 'confirm');
  assert.match(lastText(bot), /📎 Photo attached/);

  // ANCH-1 — the photo is the user's OWN message, so the confirm card may
  // not be edited into place above it: the old card goes, a fresh one lands
  // at the bottom, and the session anchors on THAT id.
  const dels = bot.callsTo('deleteMessage');
  assert.equal(dels.length, 1, 'the old card is deleted exactly once');
  assert.equal(dels[0].args.messageId, oldCard, 'the card that was up, by id');
  assert.equal(dels[0].args.chatId, CHAT);
  const sends = bot.callsTo('sendMessage');
  assert.equal(sends.length - sendsBefore, 1, 'one fresh card, at the bottom');
  assert.match(sends[sends.length - 1].args.text, /Confirm return/);
  assert.equal(bot.callsTo('editMessageText').length, editsBefore,
    'nothing was edited in place for this render');
  assert.equal(sessionStore.get(EMP).flowMessageId, lastSentId(bot),
    'the anchor is the NEW message id');
  assert.notEqual(sessionStore.get(EMP).flowMessageId, oldCard);

  // Off-step files belong to whatever comes after this flow.
  assert.equal(await returnFlow.handlePhoto(bot, {
    from: { id: EMP }, chat: { id: CHAT }, photo: [{ file_id: 'x' }],
  }), false);
});

test('RET-4 · a second ALBUM photo cannot overwrite the first or double the card', async () => {
  reset();
  const bot = makeBot();
  await walkToCondition(bot);
  await returnFlow.handleCallback(bot, cbq('rn:c:good'));
  const sendsBefore = bot.callsTo('sendMessage').length;

  // server.js dispatches each photo of an album with an UN-AWAITED
  // handleFileMessage, so both can be in flight at once. This passes only
  // because handlePhoto closes the step synchronously, before its first await.
  const a = returnFlow.handlePhoto(bot, {
    from: { id: EMP }, chat: { id: CHAT }, photo: [{ file_id: 'album-1' }],
  });
  const b = returnFlow.handlePhoto(bot, {
    from: { id: EMP }, chat: { id: CHAT }, photo: [{ file_id: 'album-2' }],
  });
  const [first, second] = await Promise.all([a, b]);

  assert.equal(first, true);
  assert.equal(second, false, 'the second photo of the album is ignored');
  assert.equal(sessionStore.get(EMP).photoFileId, 'album-1');
  // ANCH-1 — however many photos of the album arrive at once, ONE card is
  // dropped and ONE fresh confirm card is sent.
  assert.equal(bot.callsTo('deleteMessage').length, 1, 'the old card dropped once');
  assert.equal(bot.callsTo('sendMessage').length - sendsBefore, 1,
    'the confirm card is rendered exactly once');
});

test('RET-4 · a card too old to DELETE has its keyboard stripped instead', async () => {
  // Telegram refuses to delete a message older than 48h. The fallback must
  // still leave no dead chips live above the user's photo, and the fresh
  // card must go out regardless (the wizardAnchorBump precedent).
  reset();
  const bot = makeBot();
  await walkToCondition(bot);
  await returnFlow.handleCallback(bot, cbq('rn:c:good'));
  const oldCard = sessionStore.get(EMP).flowMessageId;
  bot.deleteMessage = async () => { throw new Error("message can't be deleted"); };
  const sendsBefore = bot.callsTo('sendMessage').length;

  assert.equal(await returnFlow.handlePhoto(bot, {
    from: { id: EMP }, chat: { id: CHAT }, photo: [{ file_id: 'old-card-1' }],
  }), true);

  const strips = bot.callsTo('editMessageReplyMarkup');
  assert.equal(strips.length, 1, 'the undeletable card loses its keyboard');
  assert.equal(strips[0].args.opts.message_id, oldCard);
  assert.equal(strips[0].args.opts.chat_id, CHAT);
  assert.deepEqual(strips[0].args.replyMarkup, { inline_keyboard: [] });

  assert.equal(bot.callsTo('sendMessage').length - sendsBefore, 1, 'the fresh card still goes out');
  assert.match(lastText(bot), /Confirm return/);
  assert.equal(sessionStore.get(EMP).flowMessageId, lastSentId(bot), 'the anchor still follows');
  assert.notEqual(sessionStore.get(EMP).flowMessageId, oldCard);
  // And the new card is the live one: a tap on it is honoured.
  await returnFlow.handleCallback(bot, cbq('rn:back'));
  assert.equal(sessionStore.get(EMP).step, 'photo');
});

test('RET-4 · an image DOCUMENT counts; a PDF falls through to later handlers', async () => {
  reset();
  const bot = makeBot();
  await walkToCondition(bot);
  await returnFlow.handleCallback(bot, cbq('rn:c:good'));
  assert.equal(await returnFlow.handlePhoto(bot, {
    from: { id: EMP }, chat: { id: CHAT }, document: { file_id: 'pdf-1', mime_type: 'application/pdf' },
  }), false);
  assert.equal(sessionStore.get(EMP).step, 'photo', 'a PDF does not close the step');
  assert.equal(await returnFlow.handlePhoto(bot, {
    from: { id: EMP }, chat: { id: CHAT }, document: { file_id: 'img-1', mime_type: 'image/jpeg' },
  }), true);
  assert.equal(sessionStore.get(EMP).photoFileId, 'img-1');
});

test('RET-4 · a picture sent as a FILE is forwarded as a document, not a photo', async () => {
  // Telegram refuses to re-send a file as a different type: a document
  // file_id handed to sendPhoto reaches NO admin. SHP-1 actively teaches the
  // owner to send pictures as a File (📎 → File) to dodge compression, so
  // this is the path the return photo will actually take.
  reset();
  const bot = makeBot();
  await walkToCondition(bot);
  await returnFlow.handleCallback(bot, cbq('rn:c:good'));
  await returnFlow.handlePhoto(bot, {
    from: { id: EMP }, chat: { id: CHAT },
    document: { file_id: 'file-doc-1', mime_type: 'image/jpeg' },
  });
  assert.equal(sessionStore.get(EMP).photoKind, 'document');
  await returnFlow.handleCallback(bot, cbq('rn:submit'));

  assert.equal(queued[0].actionJSON.return_photo_type, 'document',
    'the queue row remembers HOW the picture came in (sale_doc_type precedent)');
  assert.deepEqual(forwarded[0].atts, [{
    fileId: 'file-doc-1', kind: 'document',
    caption: `📷 Returned goods for request ${notified[0].requestId}`,
  }]);
});

test('RET-4 · a compressed photo still forwards as a photo', async () => {
  reset();
  const bot = makeBot();
  await walkToConfirm(bot);
  await returnFlow.handleCallback(bot, cbq('rn:submit'));
  assert.equal(queued[0].actionJSON.return_photo_type, 'photo');
  assert.equal(forwarded[0].atts[0].kind, 'photo');
});

test('RET-4 · Skip photo leaves no photo type behind either', async () => {
  reset();
  const bot = makeBot();
  await walkToCondition(bot);
  await returnFlow.handleCallback(bot, cbq('rn:c:good'));
  await returnFlow.handleCallback(bot, cbq('rn:pskip'));
  await returnFlow.handleCallback(bot, cbq('rn:submit'));
  assert.equal(queued[0].actionJSON.return_photo_file_id, '');
  assert.equal(queued[0].actionJSON.return_photo_type, '');
  assert.equal(forwarded.length, 0, 'nothing to forward');
});

/* ── 6 · skip ────────────────────────────────────────────────────────── */

test('RET-4 · Skip photo reaches confirm with no 📎 line at all', async () => {
  reset();
  const bot = makeBot();
  await walkToCondition(bot);
  await returnFlow.handleCallback(bot, cbq('rn:c:good'));
  await returnFlow.handleCallback(bot, cbq('rn:pskip'));
  assert.equal(sessionStore.get(EMP).step, 'confirm');
  // CARD-3 — silence means normal; never a "no photo" line.
  assert.ok(!/📎/.test(lastText(bot)), `got: ${lastText(bot)}`);
  assert.match(lastText(bot), /✅ Good — back to stock/);
});

/* ── 7 · the confirm card ────────────────────────────────────────────── */

test('RET-4 · the confirm card shows the booked-rate credit, the date and the condition', async () => {
  reset();
  const bot = makeBot();
  const iso = await walkToConfirm(bot);
  const text = lastText(bot);

  assert.match(text, /👤 Customer: \*ABBA\*/);
  assert.match(text, /📦 Bale \*9037\* — Cashmere · 🏭 Kano office/);
  assert.match(text, /Thans \*#1, #4\* · 60 yds/);
  assert.ok(text.includes(`📅 Returned: *${fmtDate(iso)}*`), `date on the card, got: ${text}`);
  assert.match(text, /⚠️ Damaged — 6 yd cut off/);
  assert.match(text, /📎 Photo attached/);
  assert.match(text, /💰 Credits ABBA \*₦150,000\* \(60 yds × ₦2,500\/yd\)/);
  assert.match(text, /Queues dual-admin approval/);
});

test('RET-4 · no rate on record says so instead of promising a ₦0 credit', async () => {
  reset();
  rows = ROWS.map((r) => (r.packageNo === '9037' ? { ...r, pricePerYard: 0 } : r));
  const bot = makeBot();
  await walkToConfirm(bot);
  assert.match(lastText(bot), /⚠️ No rate on record for these thans/);
  assert.ok(!/💰/.test(lastText(bot)));
  rows = ROWS;
});

/* ── 8 · submit ──────────────────────────────────────────────────────── */

test('RET-4 · submit queues ONE return_thans request with the owner-locked payload', async () => {
  reset();
  const bot = makeBot();
  const iso = await walkToConfirm(bot);
  await returnFlow.handleCallback(bot, cbq('rn:submit'));

  assert.equal(queued.length, 1);
  assert.equal(queued[0].user, EMP);
  assert.equal(queued[0].status, 'pending');
  assert.match(queued[0].riskReason, /two-admin approval/);
  assert.deepEqual(queued[0].actionJSON, {
    action: 'return_thans',
    packageNo: '9037',
    warehouse: 'Kano office',
    thanNos: [1, 4],
    customer: 'ABBA',
    customerId: 'CUS-ABBA',
    returnedOn: iso,
    condition: 'damaged',
    conditionNote: '6 yd cut off',
    return_photo_file_id: 'ph-1',
    return_photo_type: 'photo',
    pricePerYard: 2500,
    yards: 60,
    design: 'Cashmere',
    shade: 'Blue',
  });

  // ANL-2 — approval_queued is the completion signal, and it carries the
  // three facts RET-4 exists to add.
  const row = audits.find((a) => a.eventType === 'approval_queued');
  assert.ok(row, 'an audit row');
  assert.equal(row.payload.action, 'return_thans');
  assert.deepEqual(row.payload.thanNos, [1, 4]);
  assert.equal(row.payload.condition, 'damaged');
  assert.equal(row.payload.conditionNote, '6 yd cut off');
  assert.equal(row.payload.returnedOn, iso);
  assert.equal(row.payload.photo, true);
  assert.equal(row.payload.source, 'return_flow');

  // The admin card is built from the QUEUED payload, and the photo is
  // forwarded to the same admins.
  assert.equal(cardsBuilt.length, 1);
  assert.deepEqual(cardsBuilt[0], queued[0].actionJSON);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].excludeId, undefined, 'an employee requester excludes nobody');
  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0].atts, [{
    fileId: 'ph-1', kind: 'photo',
    caption: `📷 Returned goods for request ${notified[0].requestId}`,
  }]);

  // The receipt names the REAL gate for an employee, and the session closes
  // with no outcome (approval_queued already signalled completion).
  assert.match(lastText(bot), /⏳ Waiting for two admins to sign\./);
  assert.ok(lastText(bot).includes(notified[0].requestId));
  assert.equal(sessionStore.get(EMP), null);
  assert.ok(chipData(bot).includes('act:__hub__:stock_move'));
});

test('RET-4 · an ADMIN requester is excluded and told the truth: one more signature', async () => {
  reset();
  const bot = makeBot();
  await walkToConfirm(bot, ADMIN);
  await returnFlow.handleCallback(bot, cbq('rn:submit', ADMIN));

  assert.equal(queued.length, 1);
  assert.equal(notified[0].excludeId, ADMIN, 'never DM the requester their own card');
  assert.equal(forwarded[0].excludeId, ADMIN);
  // requiredAdminApprovals returns 1 for an admin requester — "two admins"
  // would be a lie on exactly the cards an admin raises.
  assert.match(lastText(bot), /⏳ Waiting for a 2nd admin's approval\./);
});

test('RET-4 · a queue append that fails re-opens the door instead of eating the request', async () => {
  reset();
  const bot = makeBot();
  await walkToConfirm(bot);
  const good = approvalQueueRepository.append;
  approvalQueueRepository.append = async () => { throw new Error('sheet down'); };
  try {
    await returnFlow.handleCallback(bot, cbq('rn:submit'));
  } finally {
    approvalQueueRepository.append = good;
  }
  assert.equal(queued.length, 0);
  assert.equal(notified.length, 0, 'no admin is told about a row that was never written');
  const s = sessionStore.get(EMP);
  assert.ok(s, 'the session survives so the user can retry');
  assert.equal(s.step, 'confirm');
  assert.ok(!s._submitting, 'the single-flight flag is released');
  assert.match(lastText(bot), /⚠️ Could not submit: sheet down/);
});

/* ── 9 · double tap ──────────────────────────────────────────────────── */

test('RET-4 · two submit taps append exactly once (SUB-1)', async () => {
  reset();
  const bot = makeBot();
  await walkToConfirm(bot);
  const first = returnFlow.handleCallback(bot, cbq('rn:submit'));
  const second = returnFlow.handleCallback(bot, cbq('rn:submit'));
  await Promise.all([first, second]);
  assert.equal(queued.length, 1, 'one request id, one admin card, one row');
  assert.equal(notified.length, 1);
});

/* ── 10 · stale cards ────────────────────────────────────────────────── */

test('RET-4 · a tap on an older card changes nothing and says so out loud', async () => {
  reset();
  const bot = makeBot();
  await walkToCondition(bot);
  const before = JSON.stringify(sessionStore.get(EMP));

  const q = cbq('rn:c:damaged', EMP, 999);        // a different card
  assert.equal(await returnFlow.handleCallback(bot, q), true, 'the tap is still consumed');
  assert.equal(JSON.stringify(sessionStore.get(EMP)), before, 'nothing moved');
  const answers = answersFor(bot, q.id);
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0].args.opts,
    { text: 'Card expired — open ↩️ Return goods again.', show_alert: true });
});

test('RET-4 · a tap with no session at all gets the same one alert', async () => {
  reset();
  const bot = makeBot();
  const q = cbq('rn:cust:0');
  assert.equal(await returnFlow.handleCallback(bot, q), true);
  const answers = answersFor(bot, q.id);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].args.opts.show_alert, true);
  // Foreign callbacks are none of this flow's business.
  assert.equal(await returnFlow.handleCallback(bot, cbq('rmd:x')), false);
});

/* ── 11 · typed text ─────────────────────────────────────────────────── */

test('RET-4 · typed search filters the customer chips; a typed date only highlights', async () => {
  reset();
  const bot = makeBot();
  await returnFlow.start(bot, CHAT, EMP, CARD);
  await returnFlow.handleCallback(bot, cbq('rn:csearch'));
  assert.equal(sessionStore.get(EMP).step, 'customer_search');

  const oldCard = sessionStore.get(EMP).flowMessageId;
  const editsBefore = bot.callsTo('editMessageText').length;
  assert.equal(await returnFlow.handleText(bot, txt('chi')), true);
  assert.equal(sessionStore.get(EMP).step, 'customer');
  assert.match(lastText(bot), /Showing matches for "chi"/);
  assert.deepEqual(chipTexts(bot).filter((c) => c.startsWith('👤 ')), ['👤 CHIMA · 1B']);

  // ANCH-1 — the typed name is the user's own message: the old card is
  // deleted, the filtered list is SENT below it, and the anchor follows.
  const dels = bot.callsTo('deleteMessage');
  assert.equal(dels.length, 1, 'one delete, of the card that was up');
  assert.equal(dels[0].args.messageId, oldCard);
  const sends = bot.callsTo('sendMessage');
  assert.equal(sends.length, 1, 'exactly one fresh card');
  assert.match(sends[0].args.text, /Showing matches for "chi"/);
  assert.equal(bot.callsTo('editMessageText').length, editsBefore,
    'the filtered list was not edited into the buried card');
  assert.equal(sessionStore.get(EMP).flowMessageId, lastSentId(bot));
  assert.notEqual(sessionStore.get(EMP).flowMessageId, oldCard);

  await returnFlow.handleCallback(bot, cbq('rn:csearch'));
  assert.equal(await returnFlow.handleText(bot, txt('zzz')), true);
  assert.match(lastText(bot), /No customer with goods out matches "zzz"/);

  // Back out of the search to see everybody again.
  await returnFlow.handleCallback(bot, cbq('rn:csearch'));
  await returnFlow.handleCallback(bot, cbq('rn:back'));
  assert.equal(chipTexts(bot).filter((c) => c.startsWith('👤 ')).length, 2);

  // A typed date NEVER commits — it opens the calendar with the day marked
  // [D] (owner rule, 21-Jul). The tap is the sole commit.
  await returnFlow.handleCallback(bot, cbq('rn:cust:0'));
  await returnFlow.handleCallback(bot, cbq('rn:bale:0'));
  await returnFlow.handleCallback(bot, cbq('rn:t:0'));
  await returnFlow.handleCallback(bot, cbq('rn:tnext'));
  const iso = dateCalendar.lagosISO(3);
  const [y, m, d] = iso.split('-');
  assert.equal(await returnFlow.handleText(bot, txt(`${d}-${m}-${y}`)), true);
  assert.equal(sessionStore.get(EMP).step, 'date_cal');
  assert.equal(sessionStore.get(EMP).returnedOn, '', 'typing committed nothing');
  assert.ok(chipTexts(bot).includes(`[${Number(d)}]`), 'the typed day is marked');

  // Free text on a chip-only step still belongs to intent parsing.
  await returnFlow.handleCallback(bot, cbq(`rn:dd:${iso}`));
  assert.equal(sessionStore.get(EMP).step, 'condition');
  assert.equal(await returnFlow.handleText(bot, txt('check stock 9037')), false);
});

test('RET-4 · a typed note does NOT survive switching back to ✅ Good', async () => {
  // Back walks condition_note → condition. If the note stuck, the confirm
  // card would read "✅ Good — 6 yd cut off" while the admin card prints
  // nothing for `good` (CARD-3) — two cards disagreeing about one return,
  // with the note still landing in the AuditLog payload.
  reset();
  const bot = makeBot();
  await walkToCondition(bot);
  await returnFlow.handleCallback(bot, cbq('rn:c:other'));
  await returnFlow.handleText(bot, txt('6 yd cut off'));
  assert.equal(sessionStore.get(EMP).conditionNote, '6 yd cut off');

  await returnFlow.handleCallback(bot, cbq('rn:back'));      // photo → condition
  assert.equal(sessionStore.get(EMP).step, 'condition');
  await returnFlow.handleCallback(bot, cbq('rn:c:good'));
  assert.equal(sessionStore.get(EMP).conditionNote, '', 'the stale note is gone');

  await returnFlow.handleCallback(bot, cbq('rn:pskip'));
  assert.ok(!/6 yd cut off/.test(lastText(bot)), `confirm card, got: ${lastText(bot)}`);
  await returnFlow.handleCallback(bot, cbq('rn:submit'));
  assert.equal(queued[0].actionJSON.condition, 'good');
  assert.equal(queued[0].actionJSON.conditionNote, '');
  const row = audits.find((a) => a.eventType === 'approval_queued');
  assert.equal(row.payload.conditionNote, '');
});

test('RET-4 · the "other" condition takes a typed note and moves on', async () => {
  reset();
  const bot = makeBot();
  await walkToCondition(bot);
  await returnFlow.handleCallback(bot, cbq('rn:c:other'));
  assert.equal(sessionStore.get(EMP).step, 'condition_note');
  assert.equal(await returnFlow.handleText(bot, txt('water stain along one edge')), true);
  const s = sessionStore.get(EMP);
  assert.equal(s.step, 'photo');
  assert.equal(s.condition, 'other');
  assert.equal(s.conditionNote, 'water stain along one edge');
});

/* ── 12 · dates out of range ─────────────────────────────────────────── */

test('RET-4 · a future or too-old day is refused, loudly, and commits nothing', async () => {
  reset();
  const bot = makeBot();
  await returnFlow.start(bot, CHAT, EMP, CARD);
  await returnFlow.handleCallback(bot, cbq('rn:cust:0'));
  await returnFlow.handleCallback(bot, cbq('rn:bale:0'));
  await returnFlow.handleCallback(bot, cbq('rn:t:0'));
  await returnFlow.handleCallback(bot, cbq('rn:tnext'));

  await returnFlow.handleCallback(bot, cbq(`rn:dd:${dateCalendar.lagosISO(-3)}`));
  assert.equal(sessionStore.get(EMP).returnedOn, '');
  assert.match(lastText(bot), /⚠️ That date is in the future\./);

  await returnFlow.handleCallback(bot, cbq(`rn:dd:${dateCalendar.lagosISO(400)}`));
  assert.equal(sessionStore.get(EMP).returnedOn, '');
  assert.match(lastText(bot), /further back than 180 days/);
  assert.equal(sessionStore.get(EMP).step, 'date');
});

/* ── 13 · the container gap ──────────────────────────────────────────── */

test('RET-4 · one printed number in two containers of one store refuses to advance', async () => {
  reset();
  // §5 — a recycled printed number is a DIFFERENT bale, but the owner-locked
  // payload carries only packageNo + warehouse and neither finder separates
  // containers. The flow refuses rather than let the executor guess.
  rows = ROWS.concat([
    { rowIndex: 9, packageNo: '9037', design: 'Cashmere', shade: 'Green', thanNo: 1, yards: 30, status: 'sold', warehouse: 'Kano office', pricePerYard: 2000, soldTo: 'ABBA', soldDate: '2026-07-01', arrivalBatch: 'Jun26', baleUid: 'BAL-9037B-1' },
  ]);
  const bot = makeBot();
  await returnFlow.start(bot, CHAT, EMP, CARD);
  await returnFlow.handleCallback(bot, cbq('rn:cust:0'));

  const idx = sessionStore.get(EMP)._bales.findIndex((b) => b.packageNo === '9037');
  assert.ok(sessionStore.get(EMP)._bales[idx].ambiguous, 'the picker knows they collide');
  await returnFlow.handleCallback(bot, cbq(`rn:bale:${idx}`));
  assert.equal(sessionStore.get(EMP).step, 'bale', 'the chip does not advance');
  assert.match(lastText(bot), /exists twice in Kano office \(different containers\)/);
  assert.equal(sessionStore.get(EMP).packageNo, '', 'nothing was committed');
  rows = ROWS;
});

test('RET-4 · a LIVE same-numbered bale in the store refuses the return too', async () => {
  // The collision that matters is physical, not commercial: the second
  // container may be available, in transit, or another buyer's, and the
  // request still cannot say WHICH 9037 is coming back. Counting only this
  // customer's own sold rows would let the chip advance.
  reset();
  rows = ROWS.concat([
    { rowIndex: 9, packageNo: '9037', design: 'Cashmere', shade: 'Green', thanNo: 1, yards: 30, status: 'available', warehouse: 'Kano office', pricePerYard: 2000, soldTo: '', soldDate: '', arrivalBatch: 'Jun26', baleUid: 'BAL-9037B-1' },
  ]);
  const bot = makeBot();
  await returnFlow.start(bot, CHAT, EMP, CARD);
  await returnFlow.handleCallback(bot, cbq('rn:cust:0'));
  const idx = sessionStore.get(EMP)._bales.findIndex((b) => b.packageNo === '9037');
  assert.ok(sessionStore.get(EMP)._bales[idx].ambiguous,
    'a live duplicate is still a duplicate');
  await returnFlow.handleCallback(bot, cbq(`rn:bale:${idx}`));
  assert.equal(sessionStore.get(EMP).step, 'bale', 'the chip does not advance');
  assert.equal(sessionStore.get(EMP).packageNo, '');
  // The bale that does NOT collide is unaffected.
  const clean = sessionStore.get(EMP)._bales.findIndex((b) => b.packageNo === '9040');
  assert.ok(!sessionStore.get(EMP)._bales[clean].ambiguous);
  rows = ROWS;
});

/* ── 14 · the pure helpers ───────────────────────────────────────────── */

test('RET-4 · the helpers group by customer and by physical bale, and price at the booked rate', async () => {
  reset();
  const label = await unitDisplayService.createQtyLabeller(ROWS);
  const customers = returnFlow._internals.loadCustomers(ROWS, label);
  assert.deepEqual(customers.map((c) => c.name), ['ABBA', 'CHIMA'], 'most recent sale first');
  assert.equal(customers[0].rows.length, 5);

  const bales = returnFlow._internals.balesFor(customers[0].rows, ROWS, label);
  assert.deepEqual(bales.map((b) => b.packageNo), ['9037', '9040']);
  assert.equal(bales[0].warehouse, 'Kano office');
  assert.equal(bales[0].rosterThans, 4, 'the FULL roster, all statuses');
  assert.deepEqual(bales[0].thans.map((t) => t.thanNo), [1, 2, 3, 4], 'ascending');
  assert.ok(!bales[0].ambiguous);

  // The same maths the executor posts, so the card's number is the ledger's.
  const credit = returnFlow._internals.creditFor([bales[0].thans[0], bales[0].thans[3]]);
  assert.deepEqual(credit, { yards: 60, amount: 150000, rate: 2500 });

  // The `returned_to` seam: one map, two lines to change.
  assert.equal(returnFlow._internals.prevStep('date'), 'thans');
  assert.equal(returnFlow._internals.prevStep('condition'), 'date');
});
