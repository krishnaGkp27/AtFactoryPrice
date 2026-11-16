'use strict';

/**
 * PAY-4 / PAY-4b — FOUR EYES ON THE MONEY, walked through the REAL two taps.
 *
 * Owner ruling, 14-Sep-2026 (BUSINESS_RULES §13): "the person who is
 * approving shall not be paying from the same Telegram ID." A payment is
 * released only by an id that gave NEITHER approval.
 *
 * `test/unit/services/paymentFourEyes.test.js` proves the gate against rows
 * it writes by hand. That is exactly how the second approver slipped through
 * until 11-Nov-2026: the hand-written row carried both ids in `approvals`,
 * and the live flow only ever parks the FIRST signature there. So this file
 * writes no row by hand. It raises a payment as the employee, taps ✅ Approve
 * as one admin and then as another, through the real controller, the real
 * approval handler, the real executor and the real ApprovalQueue /
 * PaymentRequests repositories on the in-memory sheet — and only then asks
 * who may pay.
 *
 * Every scenario runs three times, because the event trail is fail-open
 * Postgres and must never be the only thing that remembers a signature:
 *
 *   trail live   — the trail answers (an in-memory array);
 *   trail off    — the REAL repository with no database (returns nothing);
 *   trail down   — every trail call throws.
 *
 * Pinned:
 *  - the admin who gives the SECOND approval, when also a finance seat, gets
 *    a finance card with no ✔ Mark Done, is refused at the tap, and sees the
 *    row marked 🔒 in 💳 Waiting for me to pay; a seat that signed nothing
 *    still pays;
 *  - the Paid / Declined notice reaches BOTH signers (the second one too,
 *    with the trail off or down);
 *  - when every finance seat signed, each signer is told 🔒 Nobody can pay,
 *    and ✖ Decline remains the way out;
 *  - the same holds for the first signer, and for the ONE approver of a
 *    payment an admin raised (a request that never has a first signature).
 */

process.env.ADMIN_IDS = '777,888,555';
process.env.EMPLOYEE_IDS = '7430648262,999';
process.env.FINANCE_IDS = '888,999';

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
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const accountsRepo = require(path.join(SRC, 'repositories/paymentAccountsRepository'));
const requestsRepo = require(path.join(SRC, 'repositories/paymentRequestsRepository'));
const reasonsRepo = require(path.join(SRC, 'repositories/paymentReasonsRepository'));
const eventsRepo = require(path.join(SRC, 'repositories/paymentEventsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const paymentService = require(path.join(SRC, 'services/paymentService'));

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
// No paying account listed (PAY-6): the completing Approve asks nothing.
const SETTINGS = { BANK_LIST: 'GTBank,Zenith,Access' };

usersRepository.getAll = async () => USERS;
usersRepository.findByUserId = async (id) => USERS.find((u) => u.user_id === String(id)) || null;
settingsRepository.getAll = async () => ({ ...SETTINGS });
settingsRepository.getAllStrict = async () => ({ ...SETTINGS });
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);
auditLogRepository.append = async () => {};
reasonsRepo.record = async () => 1;
reasonsRepo.forPayment = async () => null;

// Google Sheets keeps a text-quoted cell WITHOUT its apostrophe; the fake
// echoes writes verbatim. Account numbers are written text-quoted.
const rawAppendRows = sheetsClient.appendRows;
sheetsClient.appendRows = (sheet, rows) => rawAppendRows(sheet,
  rows.map((r) => r.map((c) => (typeof c === 'string' && /^'\d/.test(c) ? c.slice(1) : c))));

/* ── the event trail, in its three states ──────────────────────────── */

const REAL_TRAIL = {
  record: eventsRepo.record, forPayment: eventsRepo.forPayment, financeCardsFor: eventsRepo.financeCardsFor,
};
let EVENTS = [];
const TRAILS = {
  live() {
    eventsRepo.record = async (e) => { EVENTS.push(e); return EVENTS.length; };
    eventsRepo.forPayment = async (id) => EVENTS.filter((e) => e.paymentId === id)
      .map((e) => ({ kind: e.kind, actor_id: e.actorId, actor_name: e.actorName, chat_id: e.chatId, message_id: e.messageId, detail: e.detail || {} }));
    eventsRepo.financeCardsFor = async (id) => EVENTS
      .filter((e) => e.paymentId === id && ['finance_card_sent', 'reminder_sent'].includes(e.kind) && e.messageId)
      .map((e) => ({ chat_id: e.chatId, message_id: e.messageId }));
  },
  // The REAL repository. The harness scrubbed DATABASE_URL, so this is the
  // bot exactly as it runs with Postgres switched off: nothing is kept and
  // every read answers empty.
  off() { Object.assign(eventsRepo, REAL_TRAIL); },
  down() {
    const boom = async () => { throw new Error('pg down'); };
    eventsRepo.record = boom;
    eventsRepo.forPayment = boom;
    eventsRepo.financeCardsFor = boom;
  },
};
const TRAIL_NAMES = Object.keys(TRAILS);

const QUEUE_HEADERS = ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'];

function reset(trail, financeIds) {
  EVENTS = [];
  TRAILS[trail]();
  process.env.FINANCE_IDS = financeIds;
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

const sentTo = (bot, id, from = 0) => bot.calls.slice(from)
  .filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === String(id));
/** The finance cards one chat received, as { text, buttons }. */
const financeCardsTo = (bot, id, from = 0) => sentTo(bot, id, from)
  .filter((c) => /^💳 \*Payment\* — /.test(c.args.text))
  .map((c) => ({ text: c.args.text, buttons: c.args.opts.reply_markup.inline_keyboard.flat().map((b) => b.text) }));
const stuckNotesTo = (bot, id, from = 0) => sentTo(bot, id, from).filter((c) => /Nobody can pay/.test(c.args.text));
const lastAlert = (bot) => bot.callsTo('answerCallbackQuery').pop().args.opts;
/** The last flow card drawn in one chat, as { text, buttons }. */
const lastCardIn = (bot, id) => {
  const drawn = bot.calls.filter((c) => (c.method === 'sendMessage' && String(c.args.chatId) === String(id))
    || (c.method === 'editMessageText' && String(c.args.opts.chat_id) === String(id)));
  const last = drawn[drawn.length - 1];
  const kb = (last.args.opts && last.args.opts.reply_markup && last.args.opts.reply_markup.inline_keyboard) || [];
  return { text: String(last.args.text), buttons: kb.flat().map((b) => b.text) };
};

const LOCK_LINE = '🔒 _You approved this one, so you cannot pay it — a different hand must release the money._';
const REFUSAL = 'You approved this payment, so you cannot pay it. A different hand must release the money. (You can still ✖ Decline it.)';

/** `raiser` asks for ₦25,000 into the one account they may be paid through. */
async function raise(bot, raiser = ABDUL) {
  await accountsRepo.append(raiser === ABDUL
    ? { owner_name: 'Abdul', owner_type: 'employee', owner_telegram_id: ABDUL, account_number: '0123456789', bank: 'GTBank', status: 'active' }
    : { owner_name: 'Sani Loader', owner_type: 'contractor', owner_telegram_id: '', account_number: '0987654321', bank: 'Zenith', status: 'active' });
  for (const d of ['act:payments', 'pay:start:req', 'pay:acct:0']) await controller.handleCallbackQuery(bot, cb(d, raiser));
  await controller.handleMessage(bot, msg(raiser, '25000'));
  await controller.handleMessage(bot, msg(raiser, 'Transport to Idumota'));
  await controller.handleCallbackQuery(bot, cb('pay:bill:skip', raiser));
  await controller.handleCallbackQuery(bot, cb('pay:submit', raiser));
  assert.equal(queueRow()[4], 'pending', 'the request is queued and nothing is approved yet');
  return { requestId: queueRow()[0], paymentId: payRow()[0] };
}

/**
 * The live sequence: Abdul raises, Ajeet taps ✅ Approve on his card, then
 * John taps ✅ Approve on his. Returns the ids, the row as the repository
 * reads it, and where in the bot's call list the second tap begins.
 */
async function raiseAndApproveTwice(bot) {
  const ids = await raise(bot);
  await controller.handleCallbackQuery(bot, cb(`approve:${ids.requestId}`, AJEET, 71));
  assert.equal(queueRow()[4], 'pending', 'one signature is not an approval');
  assert.equal(payRow()[requestsRepo.HEADERS.indexOf('status')], 'pending_approval');
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${ids.requestId}`, JOHN, 72));
  assert.equal(queueRow()[4], 'approved', 'the second admin completes it');
  const pay = await requestsRepo.findById(ids.paymentId);
  assert.equal(pay.status, 'approved');
  assert.equal(pay.approved_by, 'Ajeet ‖ John');
  return { ...ids, pay, from };
}

/* ── 1. the second approver is a finance seat ──────────────────────── */

for (const trail of TRAIL_NAMES) {
  test(`PAY-4b [trail ${trail}]: the admin who gave the SECOND approval cannot pay — no ✔ Mark Done, refused at the tap, 🔒 in the queue; the unsigned seat pays and both signers hear`, async () => {
    reset(trail, `${JOHN},${OFFICE}`);
    const bot = createFakeBot();
    const { requestId, paymentId, pay, from } = await raiseAndApproveTwice(bot);

    // The request's own row remembers BOTH hands, whatever the trail does.
    assert.deepEqual(queueJson().approverIds, [AJEET, JOHN]);
    assert.deepEqual(await paymentService.approverIdsFor(pay), [AJEET, JOHN]);

    // The cards that went out on the completing tap.
    assert.deepEqual(financeCardsTo(bot, JOHN, from).map((c) => c.buttons), [['✖ Decline']],
      'John approved it: his copy has no ✔ Mark Done');
    assert.ok(financeCardsTo(bot, JOHN, from)[0].text.endsWith(`\n\n${LOCK_LINE}`), 'and says why');
    const officeCards = financeCardsTo(bot, OFFICE, from);
    assert.deepEqual(officeCards.map((c) => c.buttons), [['✔ Mark Done', '✖ Decline']], 'the seat that signed nothing pays');
    assert.doesNotMatch(officeCards[0].text, /You approved this one/);
    assert.equal(financeCardsTo(bot, AJEET, from).length, 0, 'Ajeet is not a finance seat');
    for (const id of [ABDUL, AJEET, JOHN, OFFICE]) {
      assert.equal(stuckNotesTo(bot, id).length, 0, `a seat is left to pay — nobody is told it is stuck (${id})`);
    }

    // The gate itself.
    const john = await paymentService.canExecute(JOHN, pay);
    assert.equal(john.ok, false);
    assert.equal(john.reason, 'approved_it');
    assert.deepEqual(john.approvers, [AJEET, JOHN]);
    assert.equal((await paymentService.canExecute(AJEET, pay)).reason, 'not_finance');
    assert.equal((await paymentService.canExecute(OFFICE, pay)).ok, true);
    assert.deepEqual(await paymentService.payableBy(pay), { payable: true, eligible: [OFFICE], blocked: [JOHN] });

    // The backstop: a ✔ Mark Done tap from an old card or a forged callback.
    await controller.handleCallbackQuery(bot, cb(`pay:done:${paymentId}`, JOHN, 1700));
    assert.deepEqual(lastAlert(bot), { text: REFUSAL, show_alert: true });
    const untouched = await requestsRepo.findById(paymentId);
    assert.equal(untouched.status, 'approved', 'no money was marked as moved');
    assert.equal(untouched.done_by, '');

    // 💳 Waiting for me to pay — John sees it locked, and its card again without the button.
    await controller.handleCallbackQuery(bot, cb('pay:start:wait', JOHN));
    const johnQueue = lastCardIn(bot, JOHN);
    assert.match(johnQueue.text, /_🔒 = you approved it, so a different hand must pay it\._/);
    assert.match(johnQueue.buttons[0], /^🔒 ₦25,000 → Abdul · /);
    let mark = bot.calls.length;
    await controller.handleCallbackQuery(bot, cb('pay:wait:0', JOHN));
    assert.deepEqual(financeCardsTo(bot, JOHN, mark).map((c) => c.buttons), [['✖ Decline']]);
    sessionStore.clear(JOHN);

    // The same list on the unsigned seat: no lock, and the card pays.
    await controller.handleCallbackQuery(bot, cb('pay:start:wait', OFFICE));
    const officeQueue = lastCardIn(bot, OFFICE);
    assert.doesNotMatch(officeQueue.text, /🔒/);
    assert.match(officeQueue.buttons[0], /^₦25,000 → Abdul · /);
    mark = bot.calls.length;
    await controller.handleCallbackQuery(bot, cb('pay:wait:0', OFFICE));
    assert.deepEqual(financeCardsTo(bot, OFFICE, mark).map((c) => c.buttons), [['✔ Mark Done', '✖ Decline']]);

    // Office pays. The requester and BOTH signers hear — the second one too.
    mark = bot.calls.length;
    await controller.handleCallbackQuery(bot, cb(`pay:done:${paymentId}`, OFFICE, 1800));
    const done = await requestsRepo.findById(paymentId);
    assert.equal(done.status, 'done');
    assert.equal(done.done_by, OFFICE);
    const notice = [
      '💸 Paid — ₦25,000 to Abdul (employee)',
      '📝 Transport to Idumota',
      '🏦 GTBank 0123456789',
      `Paid by Office · ${done.done_at}`,
      `Ref ${paymentId} · approved by Ajeet ‖ John`,
    ].join('\n');
    for (const id of [ABDUL, AJEET, JOHN]) {
      assert.deepEqual(sentTo(bot, id, mark).map((c) => c.args.text), [notice], `one Paid notice to ${NAMES[id]}`);
    }
    assert.equal(queueRow()[0], requestId);
  });
}

/* ── 2. every finance seat signed ──────────────────────────────────── */

for (const trail of TRAIL_NAMES) {
  test(`PAY-4b [trail ${trail}]: when BOTH signers are the only finance seats, each is told 🔒 Nobody can pay — and ✖ Decline is the way out`, async () => {
    reset(trail, `${AJEET},${JOHN}`);
    const bot = createFakeBot();
    const { paymentId, pay, from } = await raiseAndApproveTwice(bot);

    for (const id of [AJEET, JOHN]) {
      const cards = financeCardsTo(bot, id, from);
      assert.deepEqual(cards.map((c) => c.buttons), [['✖ Decline']], `${NAMES[id]} signed: no ✔ Mark Done`);
      assert.ok(cards[0].text.endsWith(`\n\n${LOCK_LINE}`));
      const notes = stuckNotesTo(bot, id, from);
      assert.equal(notes.length, 1, `${NAMES[id]} is told once, at the approval`);
      assert.equal(notes[0].args.text, [
        `🔒 *Nobody can pay ${paymentId} yet*`,
        '₦25,000 to Abdul is approved, but every finance seat it goes to also approved it.',
        '',
        '_Four eyes on the money: the hands that approve are never the hands that pay._',
        'Add a finance id that did not sign, or ✖ Decline it and have it raised again for different hands.',
      ].join('\n'));
      assert.equal(notes[0].args.opts.parse_mode, 'Markdown');
    }
    assert.equal(stuckNotesTo(bot, ABDUL).length, 0, 'the requester is not sent the admins\' note');
    assert.deepEqual(await paymentService.payableBy(pay), { payable: false, eligible: [], blocked: [AJEET, JOHN] });

    // Neither signature can release it.
    for (const id of [AJEET, JOHN]) {
      await controller.handleCallbackQuery(bot, cb(`pay:done:${paymentId}`, id, 1700));
      assert.deepEqual(lastAlert(bot), { text: REFUSAL, show_alert: true });
    }
    assert.equal((await requestsRepo.findById(paymentId)).status, 'approved');

    // The escape hatch moves no money, so a signer may take it. The
    // requester and the OTHER signer hear — here the second approver.
    await controller.handleCallbackQuery(bot, cb(`pay:dec:${paymentId}`, AJEET, 1701));
    const mark = bot.calls.length;
    await controller.handleMessage(bot, msg(AJEET, 'Both of us signed — raise it again'));
    const declined = await requestsRepo.findById(paymentId);
    assert.equal(declined.status, 'declined');
    assert.equal(declined.done_by, AJEET);
    assert.equal(declined.decline_reason, 'Both of us signed — raise it again');
    for (const id of [ABDUL, JOHN]) {
      const heard = sentTo(bot, id, mark).map((c) => c.args.text);
      assert.equal(heard.length, 1, `one Declined notice to ${NAMES[id]}`);
      assert.match(heard[0], /^✖ Payment declined — ₦25,000 to Abdul \(employee\) was not paid\./);
      assert.match(heard[0], /\nBoth of us signed — raise it again\n/);
    }
  });
}

/* ── 3. the first signer, and the lone approver of an admin's request ── */

for (const trail of TRAIL_NAMES) {
  test(`PAY-4 [trail ${trail}]: the admin who gave the FIRST approval cannot pay either`, async () => {
    reset(trail, `${AJEET},${OFFICE}`);
    const bot = createFakeBot();
    const { paymentId, pay, from } = await raiseAndApproveTwice(bot);

    assert.deepEqual(financeCardsTo(bot, AJEET, from).map((c) => c.buttons), [['✖ Decline']]);
    assert.deepEqual(financeCardsTo(bot, OFFICE, from).map((c) => c.buttons), [['✔ Mark Done', '✖ Decline']]);
    assert.equal(financeCardsTo(bot, JOHN, from).length, 0, 'John is not a finance seat here');
    assert.equal((await paymentService.canExecute(AJEET, pay)).reason, 'approved_it');
    assert.equal((await paymentService.canExecute(JOHN, pay)).reason, 'not_finance');
    await controller.handleCallbackQuery(bot, cb(`pay:done:${paymentId}`, AJEET, 1700));
    assert.deepEqual(lastAlert(bot), { text: REFUSAL, show_alert: true });
    assert.equal((await requestsRepo.findById(paymentId)).status, 'approved');
  });

  test(`PAY-4b [trail ${trail}]: a payment an ADMIN raised needs one approval — and that one approver cannot pay it`, async () => {
    reset(trail, `${JOHN},${OFFICE}`);
    const bot = createFakeBot();
    // Musa (an admin) raises for a contractor; one other admin completes it.
    const { requestId, paymentId } = await raise(bot, MUSA);
    const from = bot.calls.length;
    await controller.handleCallbackQuery(bot, cb(`approve:${requestId}`, JOHN, 72));
    assert.equal(queueRow()[4], 'approved', 'an admin\'s own request takes one more admin');
    const pay = await requestsRepo.findById(paymentId);
    assert.equal(pay.status, 'approved');

    // No first signature was ever parked — the completing tap is the only
    // one — so the row's `approverIds` is all that names the approver when
    // the trail is silent.
    assert.equal(queueJson().approvals, undefined);
    assert.deepEqual(queueJson().approverIds, [JOHN]);
    assert.deepEqual(await paymentService.approverIdsFor(pay), [JOHN]);

    assert.deepEqual(financeCardsTo(bot, JOHN, from).map((c) => c.buttons), [['✖ Decline']]);
    assert.deepEqual(financeCardsTo(bot, OFFICE, from).map((c) => c.buttons), [['✔ Mark Done', '✖ Decline']]);
    assert.equal((await paymentService.canExecute(JOHN, pay)).reason, 'approved_it');
    await controller.handleCallbackQuery(bot, cb(`pay:done:${paymentId}`, JOHN, 1700));
    assert.deepEqual(lastAlert(bot), { text: REFUSAL, show_alert: true });
    assert.equal((await requestsRepo.findById(paymentId)).status, 'approved');

    // The seat that signed nothing pays; the requester and the approver hear.
    const mark = bot.calls.length;
    await controller.handleCallbackQuery(bot, cb(`pay:done:${paymentId}`, OFFICE, 1800));
    assert.equal((await requestsRepo.findById(paymentId)).status, 'done');
    for (const id of [MUSA, JOHN]) {
      const heard = sentTo(bot, id, mark).map((c) => c.args.text);
      assert.equal(heard.length, 1, `one Paid notice to ${NAMES[id]}`);
      assert.match(heard[0], /^💸 Paid — ₦25,000 to Sani Loader \(contractor\)/);
    }
  });
}
