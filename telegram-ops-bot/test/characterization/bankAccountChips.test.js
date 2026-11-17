'use strict';

/**
 * BANK-4 (owner, 17-Nov-2026) — through the REAL controller and the real
 * repositories on fake sheets:
 *
 *   · 💵 Payment Received asks the ACCOUNT when the bank holds two or more
 *     (`🏦 Zenith ▾ 2` → `🏦 AFP` · `🏦 BP`), and stores `Bank — Zenith — BP`;
 *   · the ledger's Bank row carries the account in the ONE new trailing
 *     column L `bank_account`; the receivable row and every earlier row
 *     keep an empty cell; A–K are written exactly as before;
 *   · the schema registers the header so the boot heal labels a live sheet.
 *
 * The wizard's own chips are pinned in
 * test/unit/events/approvalEvents.bankAccountChips.test.js.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

const LEDGER_HEADER = ['entry_id', 'txn_id', 'date', 'account_code', 'ledger_name', 'debit', 'credit', 'narration', 'created_by', 'created_at', 'customer_id', 'bank_account'];
const fake = createFakeSheets({
  // one row written before BANK-4: eleven cells, nothing in L
  Ledger_Entries: [LEDGER_HEADER,
    ['LE-OLD', 'T-OLD', '2026-11-01', '1002', 'Bank', 500, 0, 'Payment received from ABBA: NGN 500 via Bank', '777', '2026-11-01T09:00:00Z', 'C-1']],
  ChartOfAccounts: [['account_code', 'account_name', 'type'],
    ['1001', 'Cash', 'asset'], ['1002', 'Bank', 'asset'], ['1100', 'Customer Receivable', 'asset']],
});
installFakeSheets(fake);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const chartRepo = require(path.join(SRC, 'repositories/chartOfAccountsRepository'));
const ledgerRepo = require(path.join(SRC, 'repositories/ledgerRepository'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const approvalGate = require(path.join(SRC, 'services/approvalGate'));
const schemaMapper = require(path.join(SRC, 'services/schemaMapper'));

let QUEUE = [];
let BANK_LIST = 'GTBank, Zenith, Zenith — AFP, Zenith — BP';
approvalQueueRepository.append = async (rec) => { QUEUE.push({ createdAt: new Date().toISOString(), ...rec }); };
approvalQueueRepository.getByRequestId = async (id) => QUEUE.find((q) => String(q.requestId) === String(id)) || null;
approvalQueueRepository.getAllPending = async () => QUEUE.filter((q) => q.status === 'pending');
approvalQueueRepository.getAllWithRowIndex = async () => QUEUE.map((q, i) => ({ ...q, rowIndex: i + 2 }));
auditLogRepository.append = async () => {};
customersRepository.getAll = async () => [
  { customer_id: 'C-1', name: 'ABBA', phone: '0801', status: 'Active', outstanding_balance: 120000 },
];
settingsRepository.getAll = async () => ({ BANK_LIST });
chartRepo.findByName = async (name) => ({ cash: { account_code: '1001' }, bank: { account_code: '1002' }, 'customer receivable': { account_code: '1100' } }[String(name).toLowerCase()] || null);
approvalEvents.notifyAdminsApprovalRequest = async () => ({ sent: 2, failed: 0 });
approvalCards.resolveUserLabel = async (id) => ({ 777: 'Krishna', 888: 'Musa', 4242: 'Abdul' }[String(id)] || String(id));

const cq = (uid, data) => ({ id: `cq-${data}`, data, from: { id: Number(uid) }, message: { chat: { id: Number(uid) }, message_id: 77 } });
const msg = (uid, text) => ({ message_id: 5, text, from: { id: Number(uid) }, chat: { id: Number(uid), type: 'private' } });
function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}
function lastKb(bot) {
  const c = bot.calls.filter((x) => x.args && x.args.opts && x.args.opts.reply_markup && x.args.opts.reply_markup.inline_keyboard);
  const kb = c.length ? c[c.length - 1].args.opts.reply_markup.inline_keyboard : [];
  return kb.flat().map((b) => `${b.text}|${b.callback_data}`);
}
function reset() {
  QUEUE = [];
  BANK_LIST = 'GTBank, Zenith, Zenith — AFP, Zenith — BP';
  ['777', '888', '4242'].forEach((u) => sessionStore.clear(u));
  approvalGate._internals.recent.clear();
}
async function toMethodStep(bot, uid = '4242') {
  await controller.handleCallbackQuery(bot, cq(uid, 'act:payment_received'));
  await controller.handleCallbackQuery(bot, cq(uid, 'prc:c:0'));
  await controller.handleMessage(bot, msg(uid, '50000'));
}

/* ── 💵 Payment Received ─────────────────────────────────────────────── */

test('Payment Received: one chip per bank; the bank with two accounts says how many', async () => {
  reset();
  const bot = createFakeBot();
  await toMethodStep(bot);
  assert.match(lastText(bot), /How was it paid\?$/);
  assert.deepEqual(lastKb(bot), [
    '💵 Cash|prc:m:0', '🏦 GTBank|prc:m:1', '🏦 Zenith ▾ 2|prc:m:2', '⬅ Back|prc:back', '❌ Cancel|prc:cancel',
  ]);
});

test('Payment Received: the bank with two accounts asks which; nothing is chosen until an account is tapped', async () => {
  reset();
  const bot = createFakeBot();
  await toMethodStep(bot);
  await controller.handleCallbackQuery(bot, cq('4242', 'prc:m:2'));
  assert.match(lastText(bot), /Customer: \*ABBA\*\nAmount: \*50,000\*\n\n🏦 Zenith · which account\?$/);
  assert.deepEqual(lastKb(bot), ['🏦 AFP|prc:ma:1:0', '🏦 BP|prc:ma:1:1', '⬅ Back|prc:back', '❌ Cancel|prc:cancel']);
  assert.ok(!sessionStore.get('4242').method, 'no method stored yet');
  assert.equal(sessionStore.get('4242').step, 'method_account');

  // ⬅ Back returns to the banks, not to the amount.
  await controller.handleCallbackQuery(bot, cq('4242', 'prc:back'));
  assert.match(lastText(bot), /How was it paid\?$/);
  assert.equal(sessionStore.get('4242').step, 'method');
});

test('Payment Received: the account rides the request as `Bank — Zenith — BP`, on every card of the door', async () => {
  reset();
  const bot = createFakeBot();
  await toMethodStep(bot);
  await controller.handleCallbackQuery(bot, cq('4242', 'prc:m:2'));
  await controller.handleCallbackQuery(bot, cq('4242', 'prc:ma:1:1'));
  assert.equal(sessionStore.get('4242').method, 'Bank — Zenith — BP');
  assert.match(lastText(bot), /Paid by: Bank — Zenith — BP\n\nWho should approve it\?/);

  await controller.handleCallbackQuery(bot, cq('4242', 'prc:ad:any'));
  assert.match(lastText(bot), /Paid by: Bank — Zenith — BP/);
  await controller.handleCallbackQuery(bot, cq('4242', 'prc:submit'));
  assert.equal(QUEUE.length, 1);
  assert.equal(QUEUE[0].actionJSON.action, 'record_payment');
  assert.equal(QUEUE[0].actionJSON.method, 'Bank — Zenith — BP');
  assert.equal(QUEUE[0].actionJSON.amount, 50000);
});

test('Payment Received: a bank with one account is stamped at the tap; a bank with none is the bank, as before', async () => {
  reset();
  BANK_LIST = 'GTBank, UBA — MAIN';
  const bot = createFakeBot();
  await toMethodStep(bot);
  assert.deepEqual(lastKb(bot).slice(0, 3), ['💵 Cash|prc:m:0', '🏦 GTBank|prc:m:1', '🏦 UBA — MAIN|prc:m:2']);
  await controller.handleCallbackQuery(bot, cq('4242', 'prc:m:2'));
  assert.equal(sessionStore.get('4242').method, 'Bank — UBA — MAIN');
  assert.equal(sessionStore.get('4242').step, 'approver', 'no second screen');

  reset();
  BANK_LIST = 'GTBank, UBA — MAIN';
  const bot2 = createFakeBot();
  await toMethodStep(bot2);
  await controller.handleCallbackQuery(bot2, cq('4242', 'prc:m:1'));
  assert.equal(sessionStore.get('4242').method, 'Bank — GTBank');
});

test('Payment Received: a stale or crafted account chip redraws the banks and stores nothing', async () => {
  reset();
  const bot = createFakeBot();
  await toMethodStep(bot);
  // an account chip while the BANK screen is up: not this step
  await controller.handleCallbackQuery(bot, cq('4242', 'prc:ma:1:0'));
  assert.ok(!sessionStore.get('4242').method);
  // an account index that does not exist
  await controller.handleCallbackQuery(bot, cq('4242', 'prc:m:2'));
  await controller.handleCallbackQuery(bot, cq('4242', 'prc:ma:1:9'));
  assert.ok(!sessionStore.get('4242').method);
  assert.match(lastText(bot), /How was it paid\?$/);
});

/* ── the ledger sheet ────────────────────────────────────────────────── */

test('ledger sheet: the Bank row carries the account in column L; the receivable row and A–K are as before', async () => {
  reset();
  const before = fake._store.get('Ledger_Entries').length;
  await accountingService.recordPaymentReceived({ customer: 'ABBA', customerId: 'C-1', amount: 50000, method: 'Bank — Zenith — BP', userId: '777', txnId: 'R-77' });
  const rows = fake._store.get('Ledger_Entries');
  assert.equal(rows.length, before + 2, 'one pair appended');
  const [debit, credit] = rows.slice(-2);
  assert.equal(debit.length, 12, 'twelve cells: A–K as before + L');
  assert.deepEqual([debit[1], debit[3], debit[4], debit[5], debit[6], debit[10], debit[11]],
    ['R-77', '1002', 'Bank', 50000, 0, 'C-1', 'Zenith — BP']);
  assert.equal(debit[7], 'Payment received from ABBA: NGN 50000 via Bank · Zenith — BP');
  assert.deepEqual([credit[3], credit[4], credit[5], credit[6], credit[10], credit[11]],
    ['1100', 'Customer Receivable', 0, 50000, 'C-1', '']);
  // the row written before BANK-4 was not touched
  assert.deepEqual(rows[1].length, 11);
});

test('ledger read: bank_account is read from L; a row written before the column reads blank', async () => {
  const all = await ledgerRepo.getAll();
  assert.equal(all.find((e) => e.entry_id === 'LE-OLD').bank_account, '');
  const bank = all.filter((e) => e.txn_id === 'R-77' && e.ledger_name === 'Bank');
  assert.equal(bank.length, 1);
  assert.equal(bank[0].bank_account, 'Zenith — BP');
  assert.equal(bank[0].customer_id, 'C-1', 'K is still read');
});

test('ledger: a sale row leaves column L blank, whatever its payment mode says', async () => {
  const before = fake._store.get('Ledger_Entries').length;
  await accountingService.recordSale({ customer: 'ABBA', customerId: 'C-1', yards: 30, pricePerYard: 10, design: '9006', shade: '1', packageNo: '771', paymentMode: 'Paid to Zenith — AFP', userId: '777', txnId: 'R-78' });
  const row = fake._store.get('Ledger_Entries').slice(before)[0];
  assert.ok(row, 'the sale was written');
  assert.equal(row[11] || '', '', 'a sale is a receivable row — no bank account');
});

test('schema: Ledger_Entries registers `bank_account` as its ONE new trailing header — A–K unchanged', () => {
  const headers = schemaMapper.REQUIRED_SHEETS
    ? schemaMapper.REQUIRED_SHEETS.Ledger_Entries.headers
    : schemaMapper._internals.REQUIRED_SHEETS.Ledger_Entries.headers;
  assert.deepEqual(headers, LEDGER_HEADER);
  assert.deepEqual(headers.slice(0, 11), ['entry_id', 'txn_id', 'date', 'account_code', 'ledger_name', 'debit', 'credit', 'narration', 'created_by', 'created_at', 'customer_id']);
});
