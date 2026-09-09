'use strict';

/**
 * PAY-2 — the finance card and the delivery trail.
 *
 * Owner, 09-Sep-2026: the card names BOTH approvers ("✅ Approved: Ajeet ‖
 * John", from PaymentRequests.approved_by, which now stores the pair), the
 * reason under the amount, and the requester by NAME — never a raw id.
 * Every delivered copy is logged to `payment_events` with its chat and
 * message id so Mark Done / Decline can wipe the buttons on each one.
 */

process.env.ADMIN_IDS = '777,888';
delete process.env.FINANCE_IDS;

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');
const { createFakeBot } = require('../../helpers/fakeBot');

installFakeSheets(createFakeSheets({}));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const requestsRepo = require(path.join(SRC, 'repositories/paymentRequestsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const reasonsRepo = require(path.join(SRC, 'repositories/paymentReasonsRepository'));
const eventsRepo = require(path.join(SRC, 'repositories/paymentEventsRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const paymentCards = require(path.join(SRC, 'services/paymentCards'));

const ABDUL = '7430648262';
const OFFICE = '8896799323';
const NAMES = { [ABDUL]: 'Abdul', [OFFICE]: 'Office', 777: 'Ajeet', 888: 'John' };

usersRepository.getAll = async () => [
  { user_id: OFFICE, name: 'Office', departments: ['Finance'], department: 'Finance', status: 'active' },
];
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);

let EVENTS = [];
let ROW = null;
let QUEUE = null;
requestsRepo.findById = async (id) => (ROW && ROW.payment_id === id ? { ...ROW } : null);
approvalQueueRepository.getByRequestId = async (id) => (QUEUE && QUEUE.requestId === id ? QUEUE : null);
reasonsRepo.forPayment = async () => null;
eventsRepo.record = async (e) => { EVENTS.push(e); return EVENTS.length; };

function seed(overrides = {}) {
  EVENTS = [];
  ROW = {
    payment_id: 'PAY-20260909-3F9A2C1E', payee_name: 'Abdul', payee_type: 'employee',
    account_number: '7048940378', bank: 'OPAY', amount_ngn: 4000, above_threshold: false,
    raised_by: ABDUL, raised_at: '2026-09-09T13:32:00.000Z', approval_request_id: 'REQ-9',
    approved_by: 'Ajeet ‖ John', status: 'approved', bill_file_id: '', ...overrides,
  };
  QUEUE = { requestId: 'REQ-9', actionJSON: { action: 'request_payment', reason: 'Transport to Idumota' } };
}

/* ── the card ── */

test('PAY-2: the finance card — pair, reason under the amount, requester by name, in the owner\'s order', () => {
  seed();
  const text = paymentCards.buildFinanceCard({ ...ROW, raised_by_name: 'Abdul' }, { ok: true }, { reason: 'Transport to Idumota' });
  assert.equal(text, [
    '💳 *Payment* — Abdul · employee',
    '🏦 7048940378 · OPAY',
    '💰 *₦4,000*',
    '📝 Transport to Idumota',
    '✅ Approved: Ajeet ‖ John',
    '_Raised by Abdul · 09-Sep-2026, 14:32_',
    '`PAY-20260909-3F9A2C1E`',
  ].join('\n'));
});

test('PAY-2: the reason is passed explicitly; the row\'s own field is the fallback; none means no line', () => {
  seed();
  assert.match(paymentCards.buildFinanceCard({ ...ROW, reason: 'From the row' }, { ok: true }), /📝 From the row/);
  assert.match(paymentCards.buildFinanceCard({ ...ROW, reason: 'From the row' }, { ok: true }, { reason: 'Explicit' }), /📝 Explicit/);
  assert.doesNotMatch(paymentCards.buildFinanceCard({ ...ROW, reason: 'From the row' }, { ok: true }, { reason: '' }), /📝/,
    'an explicit empty reason wins over the row — the caller has looked and found none');
  assert.doesNotMatch(paymentCards.buildFinanceCard(ROW, { ok: true }), /📝/);
});

test('PAY-2: the bill line and the badge keep their places around the reason', () => {
  seed({ bill_file_id: 'BILL', above_threshold: true, amount_ngn: 250000 });
  const text = paymentCards.buildFinanceCard({ ...ROW, raised_by_name: 'Abdul' }, { ok: true }, { reason: 'Diesel' });
  assert.match(text, /💰 \*₦250,000\* {4}⚠️ large payment\n📝 Diesel\n📎 Bill attached\n✅ Approved: Ajeet ‖ John/);
});

test('PAY-2: the approval summary carries "Reason:" after Account', () => {
  const card = paymentCards.buildApprovalSummary({
    amount_ngn: 4000, payee_name: 'Abdul', payee_type: 'employee', account_number: '7048940378', bank: 'OPAY',
    reason: 'Transport to Idumota', above_threshold: true, bill_file_id: 'BILL',
  });
  assert.equal(card, [
    'Payment request: ₦4,000',
    'Payee: Abdul (employee)',
    'Account: 7048940378 · OPAY',
    'Reason: Transport to Idumota',
    '⚠️ LARGE PAYMENT — above the threshold',
    'Bill: attached',
  ].join('\n'));
});

/* ── the delivery ── */

test('PAY-2: sendFinanceCard resolves the reason and the requester\'s name, and logs one event per copy', async () => {
  seed();
  const bot = createFakeBot();
  const r = await paymentCards.sendFinanceCard(bot, ROW.payment_id);
  assert.deepEqual(r, { sent: 1, failed: 0 });
  const sent = bot.callsTo('sendMessage');
  assert.equal(sent.length, 1);
  assert.equal(String(sent[0].args.chatId), OFFICE, 'the Users Finance row when FINANCE_IDS is blank');
  assert.match(sent[0].args.text, /📝 Transport to Idumota/, 'read from the queue payload');
  assert.match(sent[0].args.text, /✅ Approved: Ajeet ‖ John/, 'the pair, as stored');
  assert.match(sent[0].args.text, /_Raised by Abdul · /, 'the name, never the id');
  assert.doesNotMatch(sent[0].args.text, new RegExp(ABDUL));
  assert.deepEqual(sent[0].args.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data),
    [`pay:done:${ROW.payment_id}`, `pay:dec:${ROW.payment_id}`]);

  assert.equal(EVENTS.length, 1);
  const ev = EVENTS[0];
  assert.equal(ev.kind, 'finance_card_sent');
  assert.equal(ev.paymentId, ROW.payment_id);
  assert.equal(ev.approvalRequestId, 'REQ-9');
  assert.equal(ev.chatId, OFFICE);
  assert.equal(ev.messageId, '1001', 'the message id the fake bot handed back');
  assert.deepEqual(ev.detail, { source: 'users_finance' });
});

test('PAY-2: the reminder sweep logs its re-send as reminder_sent; a queue re-open goes to one chat only', async () => {
  seed();
  process.env.FINANCE_IDS = '555,666';
  try {
    const bot = createFakeBot();
    await paymentCards.sendFinanceCard(bot, ROW.payment_id, { kind: 'reminder_sent' });
    assert.deepEqual(bot.callsTo('sendMessage').map((c) => String(c.args.chatId)), ['555', '666'], 'every Railway id');
    assert.deepEqual(EVENTS.map((e) => [e.kind, e.chatId, e.messageId]),
      [['reminder_sent', '555', '1001'], ['reminder_sent', '666', '1002']]);

    EVENTS = [];
    const bot2 = createFakeBot();
    await paymentCards.sendFinanceCard(bot2, ROW.payment_id, { to: ['666'] });
    assert.deepEqual(bot2.callsTo('sendMessage').map((c) => String(c.args.chatId)), ['666']);
    assert.deepEqual(EVENTS.map((e) => [e.kind, e.chatId]), [['finance_card_sent', '666']]);
  } finally {
    delete process.env.FINANCE_IDS;
  }
});

test('PAY-2: a pre-PAY-2 row whose approved_by is still a raw id is named; the bill rides as the caption', async () => {
  seed({ approved_by: '888', bill_file_id: 'BILL-1' });
  const bot = createFakeBot();
  await paymentCards.sendFinanceCard(bot, ROW.payment_id);
  assert.equal(bot.callsTo('sendMessage').length, 0);
  const photo = bot.callsTo('sendPhoto')[0];
  assert.equal(photo.args.photo, 'BILL-1');
  assert.match(photo.args.opts.caption, /✅ Approved: John/, 'resolved through approverStamp');
  assert.match(photo.args.opts.caption, /📎 Bill attached/);
  assert.equal(EVENTS[0].messageId, '1001');
});

test('PAY-2: a Postgres failure on the trail never costs the card', async () => {
  seed();
  const orig = eventsRepo.record;
  eventsRepo.record = async () => { throw new Error('pg down'); };
  try {
    const bot = createFakeBot();
    const r = await paymentCards.sendFinanceCard(bot, ROW.payment_id);
    assert.deepEqual(r, { sent: 1, failed: 0 });
  } finally {
    eventsRepo.record = orig;
  }
});

test('PAY-2: a delivery failure is counted, not thrown, and leaves no trail row', async () => {
  seed();
  const bot = createFakeBot();
  bot.sendMessage = async () => { throw new Error('blocked'); };
  const r = await paymentCards.sendFinanceCard(bot, ROW.payment_id);
  assert.deepEqual(r, { sent: 0, failed: 1 });
  assert.equal(EVENTS.length, 0);
  assert.deepEqual(await paymentCards.sendFinanceCard(bot, 'PAY-nope'), { sent: 0, failed: 0 });
});
