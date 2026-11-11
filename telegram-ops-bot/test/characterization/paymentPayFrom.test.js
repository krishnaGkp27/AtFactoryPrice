'use strict';

/**
 * PAY-6 (owner, 11-Nov-2026) — "the account through which the payment will
 * go through shall also be mentioned with the bank name, so that each
 * transaction is clubbed with the source and the recipient, both visible to
 * Financer (the person who will pay)." Ruling the same day: the admin who
 * gives the LAST approval decides the paying account; finance is told and
 * cannot change it.
 *
 * Walked through the REAL controller, the real approval path, the real
 * executor and the real PaymentAccounts / PaymentRequests / ApprovalQueue
 * repositories on the in-memory sheet (only Postgres is an in-memory array).
 *
 * Pinned:
 *  - two accounts configured: the completing Approve draws the picker and
 *    NOTHING is written, answered as an approval, or wiped; ✖ Not now and
 *    an abandoned picker leave the request exactly as it was;
 *  - the pick approves through the same guards as any Approve, stamps
 *    column T in the approval's own row write, parks `payFrom` on the queue
 *    row, and every card that follows says From and To;
 *  - one account: no picker, stamped; none: today's messages, byte for byte;
 *  - a stale / forged / foreign picker chip meets the EXISTING refusals;
 *  - a chip whose account left the list is never honoured: the picker is
 *    redrawn.
 */

process.env.ADMIN_IDS = '777,888,555';
process.env.EMPLOYEE_IDS = '7430648262,999';
// A finance seat that signs nothing — it is the one hand that may pay.
process.env.FINANCE_IDS = '999';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

const fake = createFakeSheets({});
installFakeSheets(fake);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const sheetsClient = require(path.join(SRC, 'repositories/sheetsClient'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const fmtDate = require(path.join(SRC, 'utils/formatDate'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const accountsRepo = require(path.join(SRC, 'repositories/paymentAccountsRepository'));
const requestsRepo = require(path.join(SRC, 'repositories/paymentRequestsRepository'));
const reasonsRepo = require(path.join(SRC, 'repositories/paymentReasonsRepository'));
const eventsRepo = require(path.join(SRC, 'repositories/paymentEventsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const paymentService = require(path.join(SRC, 'services/paymentService'));
const inboxFlow = require(path.join(SRC, 'flows/approvalsInboxFlow'));

const ABDUL = '7430648262';
const AJEET = '777';
const JOHN = '888';
const MUSA = '555';
const OFFICE = '999';
const NAMES = { [ABDUL]: 'Abdul', [AJEET]: 'Ajeet', [JOHN]: 'John', [MUSA]: 'Musa', [OFFICE]: 'Office' };
const USERS = [
  { user_id: ABDUL, name: 'Abdul', departments: ['Sales'], department: 'Sales', status: 'active' },
  { user_id: OFFICE, name: 'Office', departments: ['Finance'], department: 'Finance', status: 'active' },
];

const ZENITH = 'ZENITH — BLACK PANTHER';
const GTB = 'GTBANK — BLACK PANTHER';
const TWO = { BANK_LIST: 'GTBank,Zenith,Access', PAYMENT_SOURCE_ACCOUNTS: `${ZENITH}; ${GTB}` };
const ONE = { BANK_LIST: 'GTBank,Zenith,Access', PAYMENT_SOURCE_ACCOUNTS: ZENITH };
// What every deployment looks like before the owner lists a paying account.
const NONE = { BANK_LIST: 'GTBank,Zenith,Access' };

let SETTINGS = NONE;
let EVENTS = [];
let AUDIT = [];

usersRepository.getAll = async () => USERS;
usersRepository.findByUserId = async (id) => USERS.find((u) => u.user_id === String(id)) || null;
const realGetAllStrict = settingsRepository.getAllStrict;
settingsRepository.getAll = async () => ({ ...SETTINGS });
// The paying-account list is read through the STRICT reader (PAY-6 review).
settingsRepository.getAllStrict = async () => ({ ...SETTINGS });
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);
auditLogRepository.append = async (event, payload, by) => { AUDIT.push({ event, payload, by }); };
// The Postgres trail, as in-memory rows (it is fail-open and optional live).
reasonsRepo.record = async () => 1;
reasonsRepo.forPayment = async () => null;
eventsRepo.record = async (e) => { EVENTS.push(e); return EVENTS.length; };
eventsRepo.forPayment = async (id) => EVENTS.filter((e) => e.paymentId === id)
  .map((e) => ({ kind: e.kind, actor_id: e.actorId, actor_name: e.actorName, chat_id: e.chatId, message_id: e.messageId, detail: e.detail || {} }));
eventsRepo.financeCardsFor = async (id) => EVENTS
  .filter((e) => e.paymentId === id && ['finance_card_sent', 'reminder_sent'].includes(e.kind) && e.messageId)
  .map((e) => ({ chat_id: e.chatId, message_id: e.messageId }));

// Google Sheets keeps a text-quoted cell WITHOUT its apostrophe; the fake
// echoes writes verbatim. Account numbers are written text-quoted, so drop
// the quote the way the real sheet does — the cards then read as they do live.
const rawAppendRows = sheetsClient.appendRows;
sheetsClient.appendRows = (sheet, rows) => rawAppendRows(sheet,
  rows.map((r) => r.map((c) => (typeof c === 'string' && /^'\d/.test(c) ? c.slice(1) : c))));

const QUEUE_HEADERS = ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'];
const T = requestsRepo.HEADERS.indexOf('paid_from');
const STATUS = requestsRepo.HEADERS.indexOf('status');
const APPROVED_BY = requestsRepo.HEADERS.indexOf('approved_by');

function reset(settings) {
  SETTINGS = settings;
  EVENTS = [];
  AUDIT = [];
  fake._store.set(accountsRepo.SHEET, [[...accountsRepo.HEADERS]]);
  fake._store.set(requestsRepo.SHEET, [[...requestsRepo.HEADERS]]);
  fake._store.set('ApprovalQueue', [[...QUEUE_HEADERS]]);
  accountsRepo.invalidateCache();
  requestsRepo.invalidateCache();
  [ABDUL, AJEET, JOHN, MUSA, OFFICE].forEach((id) => sessionStore.clear(id));
}

const msg = (uid, text) => ({ chat: { id: uid }, from: { id: uid, first_name: 'X' }, text });
const queueRow = () => fake._store.get('ApprovalQueue')[1];
const queueJson = () => JSON.parse(queueRow()[2]);
const payRow = () => fake._store.get(requestsRepo.SHEET)[1];
/** Both sheets' data rows, frozen as text — "nothing was written" is one comparison. */
const snapshot = () => JSON.stringify([fake._store.get('ApprovalQueue'), fake._store.get(requestsRepo.SHEET)]);

const sentTo = (bot, id, from = 0) => bot.calls.slice(from)
  .filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === String(id));
const textsTo = (bot, id, from = 0) => sentTo(bot, id, from).map((c) => String(c.args.text));
const toasts = (bot, from = 0) => bot.calls.slice(from)
  .filter((c) => c.method === 'answerCallbackQuery').map((c) => (c.args.opts && c.args.opts.text) || '');
const wipes = (bot, from = 0) => bot.calls.slice(from)
  .filter((c) => c.method === 'editMessageReplyMarkup' && c.args.replyMarkup.inline_keyboard.length === 0)
  .map((c) => `${c.args.opts.chat_id}:${c.args.opts.message_id}`);
/** The picker message(s) drawn in one chat, as { text, chips }. */
const pickersTo = (bot, id, from = 0) => sentTo(bot, id, from)
  .filter((c) => /Pay from which account\?/.test(c.args.text))
  .map((c) => ({ text: c.args.text, opts: c.args.opts, chips: c.args.opts.reply_markup.inline_keyboard.flat() }));

const PICKER_TEXT = [
  '💳 *Pay from which account?*',
  '₦25,000 → Abdul · 0123456789 · GTBank',
  '📝 Transport to Idumota',
  '',
  '_You are giving the last approval. Finance will be told to pay from the account you tap._',
].join('\n');

/** Abdul (an employee) raises ₦25,000 into his own registered account. */
async function raise(bot) {
  await accountsRepo.append({
    owner_name: 'Abdul', owner_type: 'employee', owner_telegram_id: ABDUL,
    account_number: '0123456789', bank: 'GTBank', status: 'active',
  });
  for (const d of ['act:payments', 'pay:start:req', 'pay:acct:0']) await controller.handleCallbackQuery(bot, cb(d, ABDUL));
  await controller.handleMessage(bot, msg(ABDUL, '25000'));
  await controller.handleMessage(bot, msg(ABDUL, 'Transport to Idumota'));
  await controller.handleCallbackQuery(bot, cb('pay:bill:skip', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));
  const requestId = queueRow()[0];
  assert.equal(requestId.length, 36, 'a UUID request id — the longest the chips must carry');
  return { requestId, paymentId: payRow()[0] };
}

/** Raise, then Ajeet gives the first of the two approvals. */
async function raiseAndSignOnce(bot) {
  const ids = await raise(bot);
  await controller.handleCallbackQuery(bot, cb(`approve:${ids.requestId}`, AJEET, 71));
  assert.equal(queueRow()[4], 'pending');
  assert.deepEqual(queueJson().approvals, [AJEET]);
  return ids;
}

/** John taps ✅ Approve on his card (message 72) and gets the picker back. */
async function openPicker(bot, requestId, admin = JOHN, cardMsgId = 72) {
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${requestId}`, admin, cardMsgId));
  const drawn = pickersTo(bot, admin, from);
  assert.equal(drawn.length, 1, 'one picker message');
  return drawn[0];
}

/** The decision chips the approval card still carries (Telegram sends the
 *  replied-to message as it now stands). */
const cardChips = (requestId) => ({ inline_keyboard: [[
  { text: '✅ Approve', callback_data: `approve:${requestId}` },
  { text: '❌ Reject', callback_data: `reject:${requestId}` },
]] });

/** A picker chip's tap: the picker is a reply to the approval card it answers. */
const chipCb = (data, uid, msgId, cardId, extra = {}) => ({
  ...cb(data, uid, msgId),
  message: {
    chat: { id: uid },
    message_id: msgId,
    reply_to_message: { message_id: cardId, reply_markup: cardChips(String(data).replace(/^pay:fromx?:/, '').replace(/:[^:]*$/, '')) },
    ...extra,
  },
});

const financeCard = (lines, row) => [
  '💳 *Payment* — Abdul · employee',
  ...lines,
  '💰 *₦25,000*',
  '📝 Transport to Idumota',
  '✅ Approved: Ajeet ‖ John',
  `_Raised by Abdul · ${fmtDate.withTime(row[requestsRepo.HEADERS.indexOf('raised_at')])}_`,
  `\`${row[0]}\``,
].join('\n');

/* ── 1. two accounts: the picker asks, and asking changes nothing ──── */

test('PAY-6: the completing Approve draws the picker — nothing is written, the card keeps its buttons, the request still waits', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  const before = snapshot();
  const events = EVENTS.length;
  const audit = AUDIT.length;
  const from = bot.calls.length;

  await controller.handleCallbackQuery(bot, cb(`approve:${requestId}`, JOHN, 72));

  // Exactly two Telegram calls: the picker as a NEW message, and the toast.
  assert.deepEqual(bot.calls.slice(from).map((c) => c.method), ['sendMessage', 'answerCallbackQuery']);
  const [picker] = pickersTo(bot, JOHN, from);
  assert.equal(picker.text, PICKER_TEXT);
  assert.equal(picker.opts.parse_mode, 'Markdown');
  const list = await paymentService.sourceAccounts();
  assert.deepEqual(picker.opts.reply_markup.inline_keyboard, [
    [{ text: '🏦 ZENITH — BLACK PANTHER', callback_data: `pay:from:${requestId}:${paymentService.sourceAccountKey(list, 0)}` }],
    [{ text: '🏦 GTBANK — BLACK PANTHER', callback_data: `pay:from:${requestId}:${paymentService.sourceAccountKey(list, 1)}` }],
    [{ text: '✖ Not now', callback_data: `pay:fromx:${requestId}` }],
  ], 'one chip per account and its own way out — no house footer is appended');
  for (const chip of picker.chips) assert.ok(Buffer.byteLength(chip.callback_data) <= 64, chip.callback_data);
  assert.deepEqual(toasts(bot, from), ['Choose the account to pay from.'], 'never "Approving..."');

  // Nothing was approved, written, logged or wiped.
  assert.equal(snapshot(), before, 'not one cell of the queue row or the payment row changed');
  assert.equal(queueRow()[4], 'pending');
  assert.deepEqual(queueJson().approvals, [AJEET], 'still one signature');
  assert.equal(queueJson().payFrom, undefined);
  assert.equal(payRow()[STATUS], 'pending_approval');
  assert.equal(payRow()[T], '');
  assert.equal(EVENTS.length, events, 'no trail row');
  assert.equal(AUDIT.length, audit, 'no audit line');
  assert.deepEqual(wipes(bot, from), [], 'John\'s approval card still has ✅ Approve and ❌ Reject');
  for (const id of [ABDUL, AJEET, MUSA, OFFICE]) assert.equal(sentTo(bot, id, from).length, 0, `nobody else hears anything (${id})`);
});

test('PAY-6: ✖ Not now closes the picker and the request is exactly as it was; Approve again asks again', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  const before = snapshot();
  const picker = await openPicker(bot, requestId);

  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(picker.chips[2].callback_data, JOHN, 1500));
  assert.deepEqual(bot.calls.slice(from).map((c) => c.method), ['answerCallbackQuery', 'editMessageText']);
  const edit = bot.calls[bot.calls.length - 1].args;
  assert.equal(edit.text, 'Nothing was approved. The request still waits for its last approval.');
  assert.equal(edit.opts.chat_id, JOHN);
  assert.equal(edit.opts.message_id, 1500, 'the picker message itself');
  assert.deepEqual(edit.opts.reply_markup, { inline_keyboard: [] }, 'no buttons left on it');
  assert.equal(snapshot(), before);
  assert.equal(EVENTS.filter((e) => e.kind === 'approved').length, 0);

  // No session was needed and none was left behind; the card still works.
  assert.equal(sessionStore.get(JOHN), null);
  const again = await openPicker(bot, requestId);
  assert.equal(again.text, PICKER_TEXT);
  assert.equal(snapshot(), before);
});

/* ── 2. the pick ────────────────────────────────────────────────────── */

test('PAY-6: picking an account completes the approval — column T, the pair, From and To on the finance card, the account named on both sides', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId, paymentId } = await raiseAndSignOnce(bot);
  const picker = await openPicker(bot, requestId);

  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(picker.chips[0].callback_data, JOHN, 1500));

  // The tap is answered ONCE, as the approval it now is; the picker loses its chips.
  assert.deepEqual(toasts(bot, from), ['Approving...']);
  assert.deepEqual(wipes(bot, from), [`${JOHN}:1500`]);

  // The PaymentRequests row: approved, the pair, and the paying account in T.
  const row = payRow();
  assert.equal(row[STATUS], 'approved');
  assert.equal(row[APPROVED_BY], 'Ajeet ‖ John');
  assert.equal(row[T], ZENITH);
  assert.equal(row.length, requestsRepo.HEADERS.length);
  assert.equal((await requestsRepo.findById(paymentId)).paid_from, ZENITH);

  // The queue row: approved by both, and `payFrom` parked beside approverIds.
  assert.equal(queueRow()[4], 'approved');
  assert.equal(queueRow()[7], 'Ajeet + John');
  const aj = queueJson();
  assert.deepEqual(aj.approverIds, [AJEET, JOHN]);
  assert.equal(aj.payFrom.label, ZENITH);
  assert.equal(aj.payFrom.by, JOHN, 'the admin who gave the last approval named it');
  assert.ok(!Number.isNaN(Date.parse(aj.payFrom.at)));
  assert.deepEqual(Object.keys(aj.payFrom).sort(), ['at', 'by', 'label']);

  // The trail's existing `approved` event carries the label.
  const approved = EVENTS.filter((e) => e.kind === 'approved');
  assert.equal(approved.length, 1);
  assert.deepEqual(approved[0].detail, { approverIds: [AJEET, JOHN], approverLabel: 'Ajeet ‖ John', paid_from: ZENITH });

  // John's result and Abdul's closing card both name the account.
  const note = '✅ Payment of ₦25,000 to Abdul approved by Ajeet ‖ John — now with finance to pay. Paying from ZENITH — BLACK PANTHER.';
  assert.deepEqual(textsTo(bot, JOHN, from), [`✅ Request ${requestId} approved by Ajeet + John. Changes applied.\n${note}`]);
  const closing = textsTo(bot, ABDUL, from);
  assert.equal(closing.length, 1);
  const lines = closing[0].split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[0], '✅ Approved · 2 of 2');
  assert.equal(lines[1], '💳 Payment request · ₦25,000 → Abdul · Transport to Idumota');
  assert.match(lines[2], /^✅ Ajeet · /);
  assert.match(lines[3], /^✅ John · /);
  assert.equal(lines[4], note);
  assert.match(lines[5], /^Ref R-[0-9A-F]{4}$/);

  // The finance seat's card: source and recipient together.
  const cards = sentTo(bot, OFFICE, from);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].args.text, financeCard(['📤 From: ZENITH — BLACK PANTHER', '📥 To: 0123456789 · GTBank'], row));
  assert.deepEqual(cards[0].args.opts.reply_markup.inline_keyboard, [[
    { text: '✔ Mark Done', callback_data: `pay:done:${paymentId}` },
    { text: '✖ Decline', callback_data: `pay:dec:${paymentId}` },
  ]], 'finance still has exactly Mark Done and Decline — it cannot change the account');

  // Four eyes: the admin who picked can never pay it, even as a finance seat.
  assert.deepEqual(await paymentService.approverIdsFor({ payment_id: paymentId, approval_request_id: requestId }), [AJEET, JOHN]);
});

test('PAY-6: after a pick — the Paid notice, finance\'s confirmation, the reopened card and the inbox record all carry the account', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId, paymentId } = await raiseAndSignOnce(bot);
  const picker = await openPicker(bot, requestId);
  await controller.handleCallbackQuery(bot, cb(picker.chips[1].callback_data, JOHN, 1500));
  assert.equal(payRow()[T], GTB, 'the SECOND chip names the second account');

  // 💳 Waiting for me to pay → the card again: read from the row, so the same From / To.
  let from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb('pay:start:wait', OFFICE));
  await controller.handleCallbackQuery(bot, cb('pay:wait:0', OFFICE));
  const reopened = sentTo(bot, OFFICE, from).filter((c) => /💳 \*Payment\*/.test(c.args.text));
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].args.text, financeCard(['📤 From: GTBANK — BLACK PANTHER', '📥 To: 0123456789 · GTBank'], payRow()));

  // ✔ Mark Done — the plain-text Paid notice to the requester and both approvers.
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`pay:done:${paymentId}`, OFFICE, 1600));
  const done = await requestsRepo.findById(paymentId);
  assert.equal(done.status, 'done');
  assert.equal(done.paid_from, GTB, 'Mark Done never touches column T');
  const notice = [
    '💸 Paid — ₦25,000 to Abdul (employee)',
    '📝 Transport to Idumota',
    '📤 From: GTBANK — BLACK PANTHER',
    '📥 To: 0123456789 · GTBank',
    `Paid by Office · ${done.done_at}`,
    `Ref ${paymentId} · approved by Ajeet ‖ John`,
  ].join('\n');
  for (const id of [ABDUL, AJEET, JOHN]) {
    const dms = sentTo(bot, id, from);
    assert.equal(dms.length, 1, `one notice to ${id}`);
    assert.equal(dms[0].args.text, notice);
    assert.equal(dms[0].args.opts, undefined, 'plain text, as before');
  }

  // Finance's own ✅ Paid confirmation.
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb('pay:proof:skip', OFFICE, 1601));
  const confirmation = bot.calls.slice(from)
    .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).map((c) => c.args.text).pop();
  assert.equal(confirmation, [
    '✅ *Paid* — ₦25,000 to Abdul',
    'From: GTBANK — BLACK PANTHER',
    `\`${paymentId}\``,
    '',
    `_Recorded ${done.done_at}._`,
  ].join('\n'));

  // 🛂 Approvals → ✅❌ Decided → the record: body and status line.
  from = bot.calls.length;
  await inboxFlow.start(bot, JOHN, JOHN, null);
  await controller.handleCallbackQuery(bot, cb('abx:cat:decided', JOHN));
  await controller.handleCallbackQuery(bot, cb('abx:i:0', JOHN));
  const record = bot.calls.slice(from)
    .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).map((c) => c.args.text).pop();
  const recLines = record.split('\n');
  assert.deepEqual(recLines.slice(0, 5), [
    'Payment request: ₦25,000',
    'Payee: Abdul (employee)',
    'Account: 0123456789 · GTBank',
    'Pay from: GTBANK — BLACK PANTHER',
    'Reason: Transport to Idumota',
  ]);
  assert.match(recLines[6], /^✅ _Already approved by Ajeet \+ John · .+ — no action needed\._$/);
  assert.equal(recLines[7], `💸 Paid by Office · ${done.done_at} · ${paymentId} · from GTBANK — BLACK PANTHER`);
  sessionStore.clear(JOHN);
});

test('PAY-6: an approved, unpaid payment reads "With finance to pay · from <account>" on its inbox record', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  const picker = await openPicker(bot, requestId);
  await controller.handleCallbackQuery(bot, cb(picker.chips[0].callback_data, JOHN, 1500));
  const from = bot.calls.length;
  await inboxFlow.start(bot, JOHN, JOHN, null);
  await controller.handleCallbackQuery(bot, cb('abx:cat:decided', JOHN));
  await controller.handleCallbackQuery(bot, cb('abx:i:0', JOHN));
  const record = bot.calls.slice(from)
    .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).map((c) => c.args.text).pop();
  assert.equal(record.split('\n').pop(), '🏦 With finance to pay · from ZENITH — BLACK PANTHER');
  sessionStore.clear(JOHN);
});

/* ── 3. one account, and none ──────────────────────────────────────── */

test('PAY-6: ONE account configured — no picker; the completing Approve stamps it', async () => {
  reset(ONE);
  const bot = createFakeBot();
  const { requestId, paymentId } = await raiseAndSignOnce(bot);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${requestId}`, JOHN, 72));

  assert.equal(pickersTo(bot, JOHN, from).length, 0, 'one option is not a question');
  assert.deepEqual(toasts(bot, from), ['Approving...']);
  assert.deepEqual(wipes(bot, from), [`${JOHN}:72`], 'the approval card is spent, as on any approval');
  assert.equal(payRow()[STATUS], 'approved');
  assert.equal(payRow()[T], ZENITH);
  assert.equal(queueJson().payFrom.label, ZENITH);
  assert.equal(queueJson().payFrom.by, JOHN);
  assert.deepEqual(textsTo(bot, JOHN, from), [
    `✅ Request ${requestId} approved by Ajeet + John. Changes applied.\n`
    + '✅ Payment of ₦25,000 to Abdul approved by Ajeet ‖ John — now with finance to pay. Paying from ZENITH — BLACK PANTHER.',
  ]);
  const cards = sentTo(bot, OFFICE, from);
  assert.equal(cards[0].args.text, financeCard(['📤 From: ZENITH — BLACK PANTHER', '📥 To: 0123456789 · GTBank'], payRow()));
  assert.equal((await requestsRepo.findById(paymentId)).paid_from, ZENITH);
});

test('PAY-6: NO account configured — every message, card and cell is exactly what it was before PAY-6', async () => {
  reset(NONE);
  const bot = createFakeBot();
  const { requestId, paymentId } = await raiseAndSignOnce(bot);
  let from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${requestId}`, JOHN, 72));

  // The completing tap: toast, wipe, result — then the requester and finance.
  assert.deepEqual(bot.calls.slice(from).map((c) => `${c.method}>${c.args.chatId || (c.args.opts && c.args.opts.chat_id) || ''}`), [
    'answerCallbackQuery>',
    `editMessageReplyMarkup>${JOHN}`,
    `sendMessage>${JOHN}`,
    `sendMessage>${ABDUL}`,
    `sendMessage>${OFFICE}`,
  ]);
  assert.deepEqual(toasts(bot, from), ['Approving...']);
  const note = '✅ Payment of ₦25,000 to Abdul approved by Ajeet ‖ John — now with finance to pay.';
  assert.deepEqual(textsTo(bot, JOHN, from), [`✅ Request ${requestId} approved by Ajeet + John. Changes applied.\n${note}`]);
  const closing = textsTo(bot, ABDUL, from)[0].split('\n');
  assert.equal(closing.length, 6);
  assert.equal(closing[0], '✅ Approved · 2 of 2');
  assert.equal(closing[4], note);
  const row = payRow();
  assert.equal(sentTo(bot, OFFICE, from)[0].args.text, financeCard(['🏦 0123456789 · GTBank'], row));

  // The sheet and the queue row carry nothing new.
  assert.equal(row[STATUS], 'approved');
  assert.equal(row[APPROVED_BY], 'Ajeet ‖ John');
  assert.equal(row[T], '', 'column T stays blank');
  const aj = queueJson();
  assert.equal('payFrom' in aj, false);
  assert.deepEqual(aj.approverIds, [AJEET, JOHN]);
  assert.deepEqual(EVENTS.filter((e) => e.kind === 'approved')[0].detail, { approverIds: [AJEET, JOHN], approverLabel: 'Ajeet ‖ John' });

  // …and so does everything after it.
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`pay:done:${paymentId}`, OFFICE, 1600));
  const done = await requestsRepo.findById(paymentId);
  assert.equal(textsTo(bot, ABDUL, from)[0], [
    '💸 Paid — ₦25,000 to Abdul (employee)',
    '📝 Transport to Idumota',
    '🏦 GTBank 0123456789',
    `Paid by Office · ${done.done_at}`,
    `Ref ${paymentId} · approved by Ajeet ‖ John`,
  ].join('\n'));
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb('pay:proof:skip', OFFICE, 1601));
  assert.equal(bot.calls.slice(from).filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).pop().args.text,
    `✅ *Paid* — ₦25,000 to Abdul\n\`${paymentId}\`\n\n_Recorded ${done.done_at}._`);
  from = bot.calls.length;
  await inboxFlow.start(bot, JOHN, JOHN, null);
  await controller.handleCallbackQuery(bot, cb('abx:cat:decided', JOHN));
  await controller.handleCallbackQuery(bot, cb('abx:i:0', JOHN));
  const record = bot.calls.slice(from).filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).pop().args.text.split('\n');
  assert.deepEqual(record.slice(0, 4), [
    'Payment request: ₦25,000', 'Payee: Abdul (employee)', 'Account: 0123456789 · GTBank', 'Reason: Transport to Idumota',
  ]);
  assert.equal(record[record.length - 1], `💸 Paid by Office · ${done.done_at} · ${paymentId}`);
  sessionStore.clear(JOHN);
});

/* ── 4. the picker chip meets every existing refusal ───────────────── */

test('PAY-6: a stale picker after ANOTHER admin completed — "Already approved — nothing to do.", nothing written', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  const johns = await openPicker(bot, requestId, JOHN, 72);
  const musas = await openPicker(bot, requestId, MUSA, 73);
  // Musa picks first: the payment is approved by Ajeet and Musa, from GTBANK.
  await controller.handleCallbackQuery(bot, cb(musas.chips[1].callback_data, MUSA, 1700));
  assert.equal(payRow()[APPROVED_BY], 'Ajeet ‖ Musa');
  assert.equal(payRow()[T], GTB);
  const before = snapshot();
  const events = EVENTS.length;

  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(johns.chips[0].callback_data, JOHN, 1500));
  assert.deepEqual(toasts(bot, from), ['Already approved — nothing to do.']);
  assert.deepEqual(wipes(bot, from), [`${JOHN}:1500`], 'the stale picker loses its chips, as any stale card does');
  const told = textsTo(bot, JOHN, from);
  assert.equal(told.length, 1);
  assert.match(told[0], new RegExp(`^ℹ️ Request ${requestId} was already approved on .+ — no change made\\.$`));
  assert.equal(snapshot(), before, 'John\'s ZENITH never replaces Musa\'s GTBANK');
  assert.equal(EVENTS.length, events);
  assert.equal(queueJson().payFrom.by, MUSA);
});

test('PAY-6: a stale picker after the request was REJECTED — "Already rejected — nothing to do."', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  const johns = await openPicker(bot, requestId, JOHN, 72);
  await controller.handleCallbackQuery(bot, cb(`reject:${requestId}`, MUSA, 73));
  assert.equal(queueRow()[4], 'rejected');
  const before = snapshot();

  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(johns.chips[0].callback_data, JOHN, 1500));
  assert.deepEqual(toasts(bot, from), ['Already rejected — nothing to do.']);
  assert.deepEqual(wipes(bot, from), [`${JOHN}:1500`]);
  assert.equal(snapshot(), before);
  assert.equal(payRow()[T], '');
  assert.equal(payRow()[STATUS], 'rejected');
});

test('PAY-6: a picker chip in the wrong hands — the first signer, a non-admin — is refused by the existing guards', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  const picker = await openPicker(bot, requestId);
  const before = snapshot();
  const chip = picker.chips[0].callback_data;

  // Ajeet already gave the first approval: his tap on a chip is not the second.
  let from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip, AJEET, 1500));
  const alert = bot.calls.slice(from).filter((c) => c.method === 'answerCallbackQuery');
  assert.equal(alert.length, 1);
  assert.deepEqual(alert[0].args.opts,
    { text: '🔏 You already gave the first approval — a different admin must give the second.', show_alert: true });
  assert.equal(snapshot(), before);

  // Abdul is not an admin (and is the requester).
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip, ABDUL, 1500));
  assert.deepEqual(toasts(bot, from), ['Only admins can approve.']);
  assert.equal(snapshot(), before);
  assert.equal(EVENTS.filter((e) => e.kind === 'approved').length, 0);

  // John's own picker is untouched by all of it and still completes.
  await controller.handleCallbackQuery(bot, cb(chip, JOHN, 1500));
  assert.equal(payRow()[T], ZENITH);
  assert.equal(queueJson().payFrom.by, JOHN);
});

test('PAY-6: a chip whose account left the list is never honoured — the picker is redrawn with the changed-list line', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  const picker = await openPicker(bot, requestId);
  const before = snapshot();

  // The owner edits the list under the open picker: position 0 is now another account.
  SETTINGS = { ...TWO, PAYMENT_SOURCE_ACCOUNTS: `OPAY — AFP LTD; ${GTB}` };
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(picker.chips[0].callback_data, JOHN, 1500));

  assert.deepEqual(bot.calls.slice(from).map((c) => c.method), ['answerCallbackQuery', 'editMessageText']);
  assert.deepEqual(toasts(bot, from), ['That list has changed — pick again.']);
  const edit = bot.calls[bot.calls.length - 1].args;
  assert.equal(edit.opts.message_id, 1500, 'redrawn in place');
  assert.equal(edit.text, `⚠️ That list has changed — pick again.\n\n${PICKER_TEXT}`);
  const chips = edit.opts.reply_markup.inline_keyboard.flat();
  assert.deepEqual(chips.map((c) => c.text), ['🏦 OPAY — AFP LTD', '🏦 GTBANK — BLACK PANTHER', '✖ Not now']);
  assert.equal(snapshot(), before, 'OPAY was NOT stamped in ZENITH\'s place — nothing was approved');

  // The redrawn chips work.
  await controller.handleCallbackQuery(bot, cb(chips[0].callback_data, JOHN, 1500));
  assert.equal(payRow()[STATUS], 'approved');
  assert.equal(payRow()[T], 'OPAY — AFP LTD');
});

/* ── 5. an admin requester: one other admin completes ───────────────── */

test('PAY-6: an ADMIN\'s own request — the one other admin who completes it gets the picker; the requester cannot use a chip', async () => {
  reset(TWO);
  const bot = createFakeBot();
  await accountsRepo.append({
    owner_name: 'Sani Loader', owner_type: 'contractor', owner_telegram_id: '',
    account_number: '0987654321', bank: 'Access', status: 'active',
  });
  for (const d of ['act:payments', 'pay:start:req', 'pay:acct:0']) await controller.handleCallbackQuery(bot, cb(d, AJEET));
  await controller.handleMessage(bot, msg(AJEET, '25000'));
  await controller.handleMessage(bot, msg(AJEET, 'Loading at the warehouse'));
  await controller.handleCallbackQuery(bot, cb('pay:bill:skip', AJEET));
  await controller.handleCallbackQuery(bot, cb('pay:submit', AJEET));
  const requestId = queueRow()[0];
  assert.equal(queueRow()[1], AJEET);
  const before = snapshot();

  // John's first tap IS the completing one (the requester counts as the first admin).
  const picker = await openPicker(bot, requestId, JOHN, 72);
  assert.equal(picker.text, [
    '💳 *Pay from which account?*',
    '₦25,000 → Sani Loader · 0987654321 · Access',
    '📝 Loading at the warehouse',
    '',
    '_You are giving the last approval. Finance will be told to pay from the account you tap._',
  ].join('\n'));
  assert.equal(snapshot(), before);

  // Ajeet forges / is forwarded a chip: his own request stays his own.
  let from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(picker.chips[0].callback_data, AJEET, 1500));
  const alert = bot.calls.slice(from).filter((c) => c.method === 'answerCallbackQuery');
  assert.deepEqual(alert[0].args.opts,
    { text: '🔒 You cannot approve your own request — a second admin must review it.', show_alert: true });
  assert.equal(snapshot(), before);

  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(picker.chips[1].callback_data, JOHN, 1500));
  assert.equal(payRow()[STATUS], 'approved');
  assert.equal(payRow()[APPROVED_BY], 'John');
  assert.equal(payRow()[T], GTB);
  assert.equal(queueJson().payFrom.by, JOHN);
  assert.deepEqual(textsTo(bot, JOHN, from), [
    `✅ Request ${requestId} approved by John. Changes applied.\n`
    + '✅ Payment of ₦25,000 to Sani Loader approved by John — now with finance to pay. Paying from GTBANK — BLACK PANTHER.',
  ]);
  assert.match(textsTo(bot, AJEET, from)[0], /^✅ Approved · 1 of 1\n/);
  assert.match(textsTo(bot, AJEET, from)[0], /Paying from GTBANK — BLACK PANTHER\.\nRef R-/);
});

/* ── 6. from the 🛂 inbox ───────────────────────────────────────────── */

test('PAY-6: ✅ Approve in the 🛂 inbox reaches the picker too; the inbox still counts the request as pending', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  const before = snapshot();
  await inboxFlow.start(bot, JOHN, JOHN, null);
  await controller.handleCallbackQuery(bot, cb('abx:cat:payments', JOHN));
  await controller.handleCallbackQuery(bot, cb('abx:i:0', JOHN));

  const card = sessionStore.get(JOHN).flowMessageId;
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`abx:ok:${requestId}`, JOHN, card));
  const drawn = pickersTo(bot, JOHN, from);
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].text, PICKER_TEXT);
  assert.equal(drawn[0].opts.reply_to_message_id, card, 'a reply to the inbox card');
  assert.deepEqual(toasts(bot, from), ['Choose the account to pay from.']);
  assert.deepEqual(wipes(bot, from), [], 'the inbox card keeps ✅ Approve and ❌ Reject');
  assert.equal(snapshot(), before);
  // PAY-6 review — nothing was decided, so the inbox posts no "still
  // pending" footer under the question: the picker is the last message and
  // the inbox card stays the anchor.
  assert.deepEqual(textsTo(bot, JOHN, from), [PICKER_TEXT]);
  assert.equal(sessionStore.get(JOHN).flowMessageId, card);

  // The pick ends the way an inbox decision does: the card loses its
  // buttons, the result, then the footer with the way back.
  const after = bot.calls.length;
  await controller.handleCallbackQuery(bot, chipCb(drawn[0].chips[0].callback_data, JOHN, 1500, card));
  assert.equal(queueRow()[4], 'approved');
  assert.equal(payRow()[T], ZENITH);
  assert.deepEqual(wipes(bot, after), [`${JOHN}:1500`, `${JOHN}:${card}`], 'the picker, then the inbox card');
  const told = textsTo(bot, JOHN, after);
  assert.match(told[0], /^✅ Request .+ approved by Ajeet \+ John\. Changes applied\.\n.+Paying from ZENITH — BLACK PANTHER\.$/);
  assert.equal(told[told.length - 1], '🛂 💳 Payments — *0* still pending.');
  const footerKb = sentTo(bot, JOHN, after).pop().args.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(footerKb, ['abx:back', 'act:__back__']);
  sessionStore.clear(JOHN);
});

test('PAY-6 review 2: a pick after the inbox card became the menu approves — and leaves the menu\'s buttons alone', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  await inboxFlow.start(bot, JOHN, JOHN, null);
  await controller.handleCallbackQuery(bot, cb('abx:cat:payments', JOHN));
  await controller.handleCallbackQuery(bot, cb('abx:i:0', JOHN));
  const card = sessionStore.get(JOHN).flowMessageId;
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`abx:ok:${requestId}`, JOHN, card));
  const [picker] = pickersTo(bot, JOHN, from);

  // 🏠 Menu on the card: the same message is now the main menu.
  const nav = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb('act:__back__', JOHN, card));
  const menuEdit = bot.calls.slice(nav).filter((c) => c.args && c.args.opts && c.args.opts.message_id === card
    && c.args.opts.reply_markup).pop();
  const menuKb = (menuEdit && menuEdit.args.opts.reply_markup) || { inline_keyboard: [[{ text: '💰 Finance', callback_data: 'act:__hub__:finance' }]] };
  assert.ok(!JSON.stringify(menuKb).includes(requestId), 'the menu carries no decision chip');

  const after = bot.calls.length;
  await controller.handleCallbackQuery(bot, chipCb(picker.chips[0].callback_data, JOHN, 1500, card,
    { reply_to_message: { message_id: card, reply_markup: menuKb } }));
  assert.equal(queueRow()[4], 'approved', 'the pick still approves');
  assert.equal(payRow()[T], ZENITH);
  assert.equal(bot.calls.slice(after).filter((c) => c.method === 'editMessageReplyMarkup'
    && c.args.opts.message_id === card).length, 0, 'the menu keeps every button');
  sessionStore.clear(JOHN);
});

/* ── 7. the first review round (PAY-6 review) ───────────────────────── */

test('PAY-6 review: a Settings read that FAILS at the completing Approve approves nothing — it is never "no account"', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  const before = snapshot();
  // The REAL strict reader, on a Settings sheet listing two accounts, whose read Google refuses.
  fake._store.set('Settings', [['Key', 'Value', 'UpdatedAt'], ['PAYMENT_SOURCE_ACCOUNTS', `${ZENITH}; ${GTB}`, '']]);
  settingsRepository.getAllStrict = realGetAllStrict;
  settingsRepository.invalidateCache();
  const origRead = sheetsClient.readRange;
  sheetsClient.readRange = async (sheet, ...rest) => {
    if (sheet === 'Settings') throw new Error('Quota exceeded for quota metric Read requests');
    return origRead(sheet, ...rest);
  };
  try {
    const from = bot.calls.length;
    await controller.handleCallbackQuery(bot, cb(`approve:${requestId}`, JOHN, 72));
    assert.deepEqual(bot.calls.slice(from).map((c) => c.method), ['answerCallbackQuery']);
    assert.deepEqual(bot.calls[bot.calls.length - 1].args.opts, {
      text: '⚠️ Could not read the paying accounts — nothing was approved. Tap ✅ Approve again in a minute.',
      show_alert: true,
    });
    assert.equal(snapshot(), before, 'nothing approved, nothing stamped');
    assert.equal(payRow()[STATUS], 'pending_approval');
    // The sheet answers again: the same tap now asks.
    sheetsClient.readRange = origRead;
    const drawn = await openPicker(bot, requestId);
    assert.equal(drawn.text, PICKER_TEXT);
  } finally {
    sheetsClient.readRange = origRead;
    settingsRepository.getAllStrict = async () => ({ ...SETTINGS });
    settingsRepository.invalidateCache();
  }
});

test('PAY-6 review: the retry of a half-finished approval is not asked again — the account chosen then stands, and is named', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  const picker = await openPicker(bot, requestId);
  // John picks ZENITH; the payment row is approved but the queue row cannot be marked (QTA-1).
  const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
  const origUS = approvalQueueRepository.updateStatus;
  approvalQueueRepository.updateStatus = async () => { const e = new Error('Quota exceeded'); e.code = 'SHEETS_QUOTA'; throw e; };
  try {
    await controller.handleCallbackQuery(bot, chipCb(picker.chips[0].callback_data, JOHN, 1500, 72));
  } finally { approvalQueueRepository.updateStatus = origUS; }
  assert.equal(queueRow()[4], 'pending');
  assert.equal(payRow()[STATUS], 'approved');
  assert.equal(payRow()[T], ZENITH);

  // Musa taps ✅ Approve on his own copy: no picker, the queue row closes, and he is told what is recorded.
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${requestId}`, MUSA, 73));
  assert.equal(pickersTo(bot, MUSA, from).length, 0, 'never asked again');
  assert.equal(queueRow()[4], 'approved');
  assert.equal(payRow()[T], ZENITH, 'column T is not re-stamped');
  const told = textsTo(bot, MUSA, from);
  assert.equal(told.length, 1);
  assert.match(told[0], new RegExp(`\\nℹ️ Payment ${payRow()[0]} was already approved by Ajeet ‖ John — paying from ZENITH — BLACK PANTHER\\. Nothing changed\\.$`));
});

test('PAY-6 review: a completing signature that cannot be SAVED approves nothing — the admin is told so, the requester nothing', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  const picker = await openPicker(bot, requestId);
  const before = snapshot();
  const events = EVENTS.length;
  const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
  const origUA = approvalQueueRepository.updateActionJSON;
  approvalQueueRepository.updateActionJSON = async () => { throw new Error('Quota exceeded'); };
  const from = bot.calls.length;
  try {
    await controller.handleCallbackQuery(bot, chipCb(picker.chips[0].callback_data, JOHN, 1500, 72,
      { reply_markup: picker.opts.reply_markup }));
  } finally { approvalQueueRepository.updateActionJSON = origUA; }
  assert.equal(snapshot(), before, 'the payment row and the queue row are as they were');
  assert.equal(payRow()[STATUS], 'pending_approval');
  assert.equal(EVENTS.length, events, 'no approved trail row');
  assert.deepEqual(textsTo(bot, JOHN, from),
    ['⚠️ Could not record your approval — nothing was approved. Tap ✅ Approve again in a minute.'],
    'the sentence as it is — never "Approved but execution failed"');
  assert.equal(sentTo(bot, ABDUL, from).length, 0, 'the requester is told nothing: nothing changed');
  assert.equal(sentTo(bot, OFFICE, from).length, 0, 'no finance card');
  // The picker gets its chips back, so "tap again" can be done — and works.
  const restored = bot.calls.slice(from).filter((c) => c.method === 'editMessageReplyMarkup').pop();
  assert.deepEqual(restored.args.replyMarkup, picker.opts.reply_markup);
  assert.equal(restored.args.opts.message_id, 1500);
  assert.deepEqual(wipes(bot, from).filter((w) => w === `${JOHN}:72`), [], 'the approval card keeps its buttons');
  await controller.handleCallbackQuery(bot, chipCb(picker.chips[0].callback_data, JOHN, 1500, 72));
  assert.equal(payRow()[STATUS], 'approved');
  assert.deepEqual(queueJson().approverIds, [AJEET, JOHN]);
});

test('PAY-6 review: the picker is a reply to the card tapped; a pick takes that card\'s buttons down too', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  const picker = await openPicker(bot, requestId, JOHN, 72);
  assert.equal(picker.opts.reply_to_message_id, 72);
  assert.equal(picker.opts.allow_sending_without_reply, true);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, chipCb(picker.chips[1].callback_data, JOHN, 1500, 72));
  assert.equal(payRow()[T], GTB);
  assert.deepEqual(wipes(bot, from), [`${JOHN}:1500`, `${JOHN}:72`], 'the picker, then the approval card it answered');
  // A card that cannot be edited any more changes nothing else.
  reset(TWO);
  const bot2 = createFakeBot();
  const ids = await raiseAndSignOnce(bot2);
  const p2 = await openPicker(bot2, ids.requestId, JOHN, 72);
  const rawWipe = bot2.editMessageReplyMarkup;
  bot2.editMessageReplyMarkup = async (kb, opts) => { if (opts.message_id === 72) throw new Error('message to edit not found'); return rawWipe.call(bot2, kb, opts); };
  await controller.handleCallbackQuery(bot2, chipCb(p2.chips[0].callback_data, JOHN, 1500, 72));
  assert.equal(payRow()[STATUS], 'approved');
  assert.equal(payRow()[T], ZENITH);
});

test('PAY-6 review: ✖ Not now on a picker whose request was decided meanwhile says so', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const { requestId } = await raiseAndSignOnce(bot);
  const first = await openPicker(bot, requestId, JOHN, 72);
  const second = await openPicker(bot, requestId, JOHN, 72);
  await controller.handleCallbackQuery(bot, chipCb(first.chips[0].callback_data, JOHN, 1500, 72));
  assert.equal(queueRow()[4], 'approved');
  let from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(second.chips[2].callback_data, JOHN, 1501));
  let edit = bot.calls.slice(from).find((c) => c.method === 'editMessageText').args;
  assert.equal(edit.text, 'This request was already approved — nothing to do.');
  assert.deepEqual(edit.opts.reply_markup, { inline_keyboard: [] });

  reset(TWO);
  const ids = await raiseAndSignOnce(bot);
  const p = await openPicker(bot, ids.requestId, JOHN, 72);
  await controller.handleCallbackQuery(bot, cb(`reject:${ids.requestId}`, MUSA, 73));
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(p.chips[2].callback_data, JOHN, 1502));
  edit = bot.calls.slice(from).find((c) => c.method === 'editMessageText').args;
  assert.equal(edit.text, 'This request was already rejected — nothing to do.');
  assert.deepEqual(edit.opts.reply_markup, { inline_keyboard: [] });

  // Not an admin: refused, the message untouched.
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(p.chips[2].callback_data, ABDUL, 1502));
  assert.deepEqual(toasts(bot, from), ['Only admins can approve.']);
  assert.equal(bot.calls.slice(from).filter((c) => c.method === 'editMessageText').length, 0);
});

test('PAY-6 review: a pay:from: chip carrying another request type is refused — "Not a payment request."', async () => {
  reset(TWO);
  const bot = createFakeBot();
  const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
  await approvalQueueRepository.append({
    requestId: 'REQ-REG-1', user: ABDUL, actionJSON: { action: 'register_payment_account', approvals: [AJEET] },
    riskReason: 'test', status: 'pending', createdAt: new Date().toISOString(),
  });
  const before = JSON.stringify(fake._store.get('ApprovalQueue'));
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb('pay:from:REQ-REG-1:0.000000', JOHN, 1500));
  assert.deepEqual(toasts(bot, from), ['Not a payment request.']);
  assert.equal(JSON.stringify(fake._store.get('ApprovalQueue')), before);
});

test('PAY-6 review: two completing taps at the same instant — one approval; the other is told "Already decided", the requester hears no false alarm', async () => {
  for (const settings of [NONE, ONE]) {
    reset(settings);
    const bot = createFakeBot();
    const { requestId } = await raiseAndSignOnce(bot);
    const from = bot.calls.length;
    await Promise.all([
      controller.handleCallbackQuery(bot, cb(`approve:${requestId}`, JOHN, 72)),
      controller.handleCallbackQuery(bot, cb(`approve:${requestId}`, MUSA, 73)),
    ]);
    assert.equal(queueRow()[4], 'approved');
    assert.equal(EVENTS.filter((e) => e.kind === 'approved').length, 1, 'ONE execution');
    const all = [...textsTo(bot, JOHN, from), ...textsTo(bot, MUSA, from)];
    assert.equal(all.filter((t) => /Changes applied/.test(t)).length, 1, 'one winner');
    assert.equal(all.filter((t) => t === 'Already decided — nothing to do.').length, 1, 'the loser is told the truth');
    assert.ok(!all.some((t) => /execution failed/.test(t)));
    const abdul = textsTo(bot, ABDUL, from);
    assert.ok(!abdul.some((t) => /could not be completed/.test(t)), 'no false alarm to the requester');
    assert.equal(abdul.filter((t) => /^✅ Approved · 2 of 2/.test(t)).length, 1);
  }
});

test('PAY-6 review 2: Approve on a request id that does not exist is NOT "Already decided" — it reads as it did before PAY-6', async () => {
  reset(NONE);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('approve:deadbeef-0000-0000-0000-000000000000', JOHN, 72));
  const told = textsTo(bot, JOHN);
  assert.ok(!told.includes('Already decided — nothing to do.'), 'a typo or forged id was never decided');
  assert.deepEqual(told, ['⚠️ Approved but execution failed: Request not found or already resolved.']);
});
