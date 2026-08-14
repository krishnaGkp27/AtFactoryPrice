'use strict';

/**
 * PAY-1 end to end, through the REAL controller — the owner's hand-drawn
 * system design (14-Aug-2026) walked from first tap to money marked paid.
 *
 *   register an account (dual-admin) → raise a payment against it
 *   (dual-admin) → the ONE finance id pays at the bank → Mark Done
 *
 * Pinned, in the order the risks actually bite:
 *  - a payment can only ever name an APPROVED account (the register is
 *    the safety, because a wrong number is an unrecoverable transfer);
 *  - the account number is typed twice and a mismatch restarts it;
 *  - both writes queue for dual-admin — nothing is written live;
 *  - the finance card carries the owner's layout, and the ⚠ badge shows
 *    only above ₦50,000;
 *  - Mark Done and Decline belong to the one finance id, and refuse
 *    anyone else — including an admin;
 *  - Mark Done refuses a payment that is not approved (no paying twice,
 *    no paying something still awaiting a signature).
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '7430648262';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const accountsRepo = require(path.join(SRC, 'repositories/paymentAccountsRepository'));
const requestsRepo = require(path.join(SRC, 'repositories/paymentRequestsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const paymentCards = require(path.join(SRC, 'services/paymentCards'));

const ABDUL = '7430648262';
const OFFICE = '8896799323';
const ADMIN = '777';

let ACCOUNTS = [];
let REQUESTS = [];
let QUEUED = [];

usersRepository.getAll = async () => [
  { user_id: ABDUL, name: 'Abdul', departments: ['Sales'], department: 'Sales', status: 'active' },
  { user_id: OFFICE, name: 'Office', departments: ['Finance'], department: 'Finance', status: 'active', role: 'marketer' },
];
settingsRepository.getAll = async () => ({ BANK_LIST: 'GTBank,Zenith,Access' });
approvalCards.resolveUserLabel = async (id) => (id === ABDUL ? 'Abdul' : 'Office');
auditLogRepository.append = async () => {};
approvalEvents.notifyAdminsApprovalRequest = async () => ({ sent: 1, failed: 0 });
approvalQueueRepository.append = async (row) => { QUEUED.push(row); return row; };

accountsRepo.append = async (e) => {
  const saved = { ...e, account_id: e.account_id || `PAC-${ACCOUNTS.length + 1}`, rowIndex: ACCOUNTS.length + 2 };
  ACCOUNTS.push(saved);
  return saved;
};
accountsRepo.findLive = async (num, bank) => ACCOUNTS.find(
  (a) => a.status !== 'inactive'
    && String(a.account_number).replace(/\D/g, '') === String(num).replace(/\D/g, '')
    && String(a.bank).toLowerCase() === String(bank).toLowerCase()) || null;
accountsRepo.activeForTelegramId = async (id) => ACCOUNTS.filter(
  (a) => a.status === 'active' && a.owner_telegram_id === String(id));
accountsRepo.activeContractors = async () => ACCOUNTS.filter(
  (a) => a.status === 'active' && a.owner_type === 'contractor');

requestsRepo.append = async (e) => {
  const saved = { ...e, payment_id: e.payment_id || `PAY-${REQUESTS.length + 1}`, raised_at: '2026-08-14T17:20:00.000Z' };
  REQUESTS.push(saved);
  return saved;
};
requestsRepo.findById = async (id) => REQUESTS.find((p) => p.payment_id === id) || null;
requestsRepo.update = async (id, patch) => {
  const row = REQUESTS.find((p) => p.payment_id === id);
  if (row) Object.assign(row, patch);
  return row;
};
requestsRepo.forRaiser = async (id) => REQUESTS.filter((p) => p.raised_by === String(id));

function reset() {
  ACCOUNTS = []; REQUESTS = []; QUEUED = [];
  sessionStore.clear(ABDUL); sessionStore.clear(OFFICE); sessionStore.clear(ADMIN);
}
const msg = (uid, text) => ({ chat: { id: uid }, from: { id: uid, first_name: 'X' }, text });
const lastText = (bot) => {
  const t = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
  return t.length ? String(t[t.length - 1].args.text) : '';
};

/** Register + approve an account so payment tests have somewhere to pay. */
async function registerApproved(overrides = {}) {
  const saved = await accountsRepo.append({
    owner_name: 'Abdul', owner_type: 'employee', owner_telegram_id: ABDUL,
    account_number: '0123456789', bank: 'GTBank', status: 'active', ...overrides,
  });
  return saved;
}

/* ── registering an account ── */

test('PAY-1: the account number is typed TWICE, and a mismatch starts it over', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:reg', ABDUL));
  assert.match(lastText(bot), /10-digit account number/);

  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  assert.match(lastText(bot), /type it again|once more/i, 'it asks a second time');

  await controller.handleMessage(bot, msg(ABDUL, '0123456780'));   // one digit off
  assert.match(lastText(bot), /did not match/i);
  assert.equal(sessionStore.get(ABDUL).step, 'reg_number', 'back to the first entry, nothing kept');

  // Correct pair now walks on to the bank.
  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  assert.match(lastText(bot), /Which bank/);
});

test('PAY-1: a registration queues for dual admin and writes nothing live', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:reg', ABDUL));
  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  await controller.handleCallbackQuery(bot, cb('pay:bank:0', ABDUL));
  assert.match(lastText(bot), /Register this account\?/);
  await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));

  assert.equal(QUEUED.length, 1);
  assert.equal(QUEUED[0].actionJSON.action, 'register_payment_account');
  assert.equal(ACCOUNTS.length, 1);
  assert.equal(ACCOUNTS[0].status, 'pending',
    'the account exists but is NOT payable until two admins sign it');
  assert.match(lastText(bot), /Sent for approval/);
});

test('PAY-1: the same account cannot be registered twice', async () => {
  reset();
  await registerApproved();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:reg', ABDUL));
  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  await controller.handleCallbackQuery(bot, cb('pay:bank:0', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));
  assert.match(lastText(bot), /Already registered/);
  assert.equal(QUEUED.length, 0, 'two rows meaning one destination would be a trap');
});

/* ── raising a payment ── */

test('PAY-1: with no approved account there is nothing to pay into', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:req', ABDUL));
  assert.match(lastText(bot), /No approved account/);
  assert.match(lastText(bot), /Register an account first/);
});

test('PAY-1: a payment picks a registered account, then queues for dual admin', async () => {
  reset();
  await registerApproved();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:req', ABDUL));
  assert.match(lastText(bot), /Pay into which account/);

  await controller.handleCallbackQuery(bot, cb('pay:acct:0', ABDUL));
  await controller.handleMessage(bot, msg(ABDUL, '45000'));
  assert.match(lastText(bot), /bill or invoice/i, 'paperwork is offered');
  await controller.handleCallbackQuery(bot, cb('pay:bill:skip', ABDUL));
  assert.match(lastText(bot), /₦45,000/);
  assert.ok(!/large payment/.test(lastText(bot)), '₦45,000 is under the line');

  await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));
  assert.equal(QUEUED.length, 1);
  assert.equal(QUEUED[0].actionJSON.action, 'request_payment');
  assert.equal(REQUESTS[0].status, 'pending_approval');
  assert.equal(REQUESTS[0].amount_ngn, 45000);
  assert.equal(REQUESTS[0].account_number, '0123456789',
    'the account is SNAPSHOT, so a later edit cannot rewrite what was paid');
});

test('PAY-1: ₦50,000 and above is badged as large, on the way in', async () => {
  reset();
  await registerApproved();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:req', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:acct:0', ABDUL));
  await controller.handleMessage(bot, msg(ABDUL, '50000'));
  await controller.handleCallbackQuery(bot, cb('pay:bill:skip', ABDUL));
  assert.match(lastText(bot), /large payment/, 'unmissable, exactly at the line');
  await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));
  assert.equal(REQUESTS[0].above_threshold, true);
});

/* ── the finance card ── */

test('PAY-1: the finance card carries the owner\'s layout', () => {
  const text = paymentCards.buildFinanceCard({
    payment_id: 'PAY-1', payee_name: 'Yerima', payee_type: 'employee',
    account_number: '0123456789', bank: 'GTBank', amount_ngn: 45000,
    above_threshold: false, approved_by: 'Ajeet ‖ John',
    raised_by: ABDUL, raised_by_name: 'Yerima', raised_at: '2026-08-14T17:20:00.000Z',
  }, { ok: true });
  assert.match(text, /💳 \*Payment\* — Yerima · employee/);
  assert.match(text, /🏦 0123456789 · GTBank/);
  assert.match(text, /💰 \*₦45,000\*/);
  assert.match(text, /✅ Approved: Ajeet ‖ John/);
  assert.ok(!/large payment/.test(text), 'no badge under the line');

  const big = paymentCards.buildFinanceCard({
    payment_id: 'PAY-2', payee_name: 'Mason', payee_type: 'contractor',
    account_number: '9', bank: 'Zenith', amount_ngn: 250000, above_threshold: true,
    bill_file_id: 'FILE', raised_by: ABDUL, raised_at: '2026-08-14T17:20:00.000Z',
  }, { ok: true });
  assert.match(big, /💰 \*₦250,000\* {4}⚠️ large payment/, 'the badge qualifies the amount');
  assert.match(big, /📎 Bill attached/);
});

test('PAY-1: a misconfigured Finance department is said out loud on the card', () => {
  const text = paymentCards.buildFinanceCard(
    { payment_id: 'P', payee_name: 'X', payee_type: 'employee', amount_ngn: 1, raised_by: ABDUL, raised_at: '' },
    { ok: false, reason: 'no_finance_member', members: 0 });
  assert.match(text, /No one is in the Finance department/);
});

/* ── executing ── */

test('PAY-1: only the one finance id may Mark Done — an ADMIN cannot', async () => {
  reset();
  REQUESTS.push({
    payment_id: 'PAY-9', payee_name: 'Abdul', payee_type: 'employee', amount_ngn: 45000,
    account_number: '0123456789', bank: 'GTBank', status: 'approved', raised_by: ABDUL,
  });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('pay:done:PAY-9', ADMIN));
  const ack = bot.callsTo('answerCallbackQuery').pop();
  assert.match(ack.args.opts.text, /Only the finance person/);
  assert.equal(REQUESTS[0].status, 'approved', 'nothing moved');
});

test('PAY-1: the finance id marks it done, and the requester is told', async () => {
  reset();
  REQUESTS.push({
    payment_id: 'PAY-9', payee_name: 'Abdul', payee_type: 'employee', amount_ngn: 45000,
    account_number: '0123456789', bank: 'GTBank', status: 'approved', raised_by: ABDUL,
  });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('pay:done:PAY-9', OFFICE));

  assert.equal(REQUESTS[0].status, 'done');
  assert.equal(REQUESTS[0].done_by, OFFICE, 'the hand that moved the money is on the record');
  assert.ok(REQUESTS[0].done_at, 'and when');
  const toAbdul = bot.callsTo('sendMessage').find((c) => String(c.args.chatId) === ABDUL);
  assert.match(toAbdul.args.text, /✅ \*Paid\*/);
  assert.match(toAbdul.args.text, /₦45,000/);
});

test('PAY-1: Mark Done refuses anything not currently approved', async () => {
  reset();
  REQUESTS.push({ payment_id: 'P1', status: 'pending_approval', amount_ngn: 1, payee_name: 'A', raised_by: ABDUL });
  REQUESTS.push({ payment_id: 'P2', status: 'done', amount_ngn: 1, payee_name: 'A', raised_by: ABDUL });
  const bot = createFakeBot();

  await controller.handleCallbackQuery(bot, cb('pay:done:P1', OFFICE));
  assert.match(bot.callsTo('answerCallbackQuery').pop().args.opts.text, /pending approval/,
    'a payment nobody signed cannot be paid');

  await controller.handleCallbackQuery(bot, cb('pay:done:P2', OFFICE));
  assert.match(bot.callsTo('answerCallbackQuery').pop().args.opts.text, /Already marked done/,
    'and it cannot be paid twice');
});

test('PAY-1: Decline needs a reason, and the reason reaches the requester', async () => {
  reset();
  REQUESTS.push({
    payment_id: 'PAY-7', payee_name: 'Abdul', payee_type: 'employee', amount_ngn: 45000,
    account_number: '0123456789', bank: 'GTBank', status: 'approved', raised_by: ABDUL,
  });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('pay:dec:PAY-7', OFFICE));
  assert.match(lastText(bot), /Why\?/);

  await controller.handleMessage(bot, msg(OFFICE, 'no'));
  assert.match(lastText(bot), /Give a reason/, 'a one-word brush-off is not a reason');
  assert.equal(REQUESTS[0].status, 'approved');

  await controller.handleMessage(bot, msg(OFFICE, 'Account name does not match the invoice'));
  assert.equal(REQUESTS[0].status, 'declined');
  assert.equal(REQUESTS[0].decline_reason, 'Account name does not match the invoice');
  const toAbdul = bot.callsTo('sendMessage').find((c) => String(c.args.chatId) === ABDUL);
  assert.match(toAbdul.args.text, /declined/i);
  assert.match(toAbdul.args.text, /Account name does not match/);
});

test('PAY-1: My requests reports each one in plain words', async () => {
  reset();
  REQUESTS.push({ payment_id: 'P1', amount_ngn: 45000, status: 'done', raised_by: ABDUL, raised_at: '2026-08-14T10:00:00.000Z' });
  REQUESTS.push({ payment_id: 'P2', amount_ngn: 12000, status: 'pending_approval', raised_by: ABDUL, raised_at: '2026-08-14T11:00:00.000Z' });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:mine', ABDUL));
  const t = lastText(bot);
  assert.match(t, /₦45,000 — paid/);
  assert.match(t, /₦12,000 — waiting for approval/);
});
