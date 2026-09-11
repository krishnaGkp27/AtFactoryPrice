'use strict';

/**
 * CUR-1 build step 7 — the controller's money surfaces, driven through the
 * REAL controller (BUSINESS_RULES §17, spec §5 "The controller" table).
 *
 * Side B / C→B (bare, `money.sale` / `money.saleRate`): the typed
 * check_balance / check_customer / statement replies (R5), the bale card
 * (`Price: 3,500/yd`), Check Stock and Stock Value, the sales reports and
 * their legend (no "amounts in NGN" fragment), the price-update wizard,
 * the CON-1 credit chips (R12), the receipt-flow amount echo and the
 * record-payment "which customer" prompt (R6).
 *
 * R5a — the daybook and trial balance stay EXACTLY as today (`DR NGN 1,500`)
 * until the finance portal takes them; pinned so a later sweep cannot move
 * them without an owner ruling.
 *
 * Every negative is pinned on the digits the role must not see, not on the
 * absent symbol (CUR-1 §6 "Negatives that must be RE-PINNED").
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, kbTexts } = require('../helpers/charFixture');

const HEADER = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];
const row = (than, yards, status = 'available', soldTo = '', soldDate = '') => ['6061', 'ST/1321', '', '9043-A', '6', String(than), String(yards), status, 'Kano office',
  '3500', '2026-02-10', soldTo, soldDate, '', '', '', 'fabric', `BAL-20260210-6061-${than}`, '2026-02-10', '', '', 'Feb26', ''];

const { todayInLagos } = require(path.join(SRC, 'utils/dates'));
const TODAY = todayInLagos();

// 3 available thans × 60 yds @ 3,500 = 630,000 stock value; one than sold
// today to Qaribullah (60 × 3,500 = 210,000) for the sales reports.
const fakeSheets = createFakeSheets({
  Inventory: [HEADER, row(1, 60), row(2, 60), row(3, 60), row(4, 60, 'sold', 'Qaribullah', TODAY)],
  ApprovalQueue: [['requestId', 'user', 'actionJSON', 'riskReason', 'status', 'createdAt', 'resolvedAt']],
});
installFakeSheets(fakeSheets);
let nextIntent = { action: 'unknown', confidence: 0 };
installFakeIntent(() => nextIntent);

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const crmService = require(path.join(SRC, 'services/crmService'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
const customerEntity = require(path.join(SRC, 'services/customerEntity'));

auditLogRepository.append = async () => {};
usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}` });
settingsRepository.getAll = async () => ({});

crmService.getCustomer = async () => ({
  name: 'Alhaji Musa', customer_id: 'C1', category: 'Standard', status: 'active',
  outstanding_balance: 140000, credit_limit: 500000, payment_terms: 'COD',
});

/** Button labels of the LAST keyboard (kbTexts joins `text|callback_data`). */
const labels = (bot) => kbTexts(bot).map((t) => String(t).split('|')[0]);
const msg = (text, uid = '777') => ({ from: { id: uid, first_name: 'U' }, chat: { id: uid }, text });
const NO_UNIT = /₦|NGN/;

async function typed(intent, text, uid = '777') {
  nextIntent = { confidence: 0.95, ...intent };
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg(text, uid));
  return bot;
}

/* ── R5: typed balance / customer / statement replies ── */

test('check_balance: bare figures, one legend seam, no symbol or code', async () => {
  const bot = await typed({ action: 'check_balance', customer: 'Alhaji Musa' }, "what is Alhaji Musa's balance");
  const text = bot.allText();
  assert.match(text, /Alhaji Musa: Outstanding balance 140,000 \(limit: 500,000\)/, `got: ${text}`);
  assert.doesNotMatch(text, NO_UNIT);
});

test('check_customer: credit limit and outstanding bare', async () => {
  const bot = await typed({ action: 'check_customer', customer: 'Alhaji Musa' }, 'show customer Alhaji Musa');
  const text = bot.allText();
  assert.match(text, /Credit limit: 500,000\n/, `got: ${text}`);
  assert.match(text, /Outstanding: 140,000\n/);
  assert.doesNotMatch(text, NO_UNIT);
});

test('customer statement: DR / CR / Bal and both Outstanding lines bare; the narration keeps its stored code (C5)', async () => {
  accountingService.getCustomerLedger = async () => ({
    entries: [
      { date: '2026-09-01', debit: 60000, credit: 0, running: 60000, narration: 'Sale: 9043-A to Bello | Cash NGN 5000' },
      { date: '2026-09-03', debit: 0, credit: 20000, running: 40000, narration: 'Payment received from Bello: NGN 20000 via Bank' },
    ],
    totalDebit: 60000, totalCredit: 20000, outstanding: 40000, outstandingAsOfToday: 240000,
  });
  const bot = await typed({ action: 'show_ledger', customer: 'Bello' }, 'ledger for Bello');
  const text = bot.allText();
  assert.match(text, /2026-09-01 \| DR 60,000 \| Bal 60,000\n/, `got: ${text}`);
  assert.match(text, /2026-09-03 \| CR 20,000 \| Bal 40,000\n/);
  assert.match(text, /\*Total DR: 60,000 \| Total CR: 20,000 \| Outstanding \(total\): 40,000\*/);
  assert.match(text, /\*Outstanding as of today: 240,000\*/);
  // Narration lines are indented; every OTHER line is a rendered figure and
  // must carry no unit. The narrations keep `NGN` — stored data, C5.
  const figureLines = text.split('\n').filter((l) => !l.startsWith('  '));
  assert.doesNotMatch(figureLines.join('\n'), NO_UNIT, `a figure line carries a unit: ${text}`);
  assert.match(text, /\n {2}Sale: 9043-A to Bello \| Cash NGN 5000/, 'the persisted narration is printed as stored');
});

/* ── R5a: daybook and trial balance stay exactly as today ── */

test('R5a: the daybook still prints DR NGN 1,500 (fmtMoney), untouched by the sweep', async () => {
  accountingService.getDaybook = async () => ([
    { ledger_name: 'Cash', debit: 1500, credit: 0, narration: 'Opening float' },
    { ledger_name: 'Bello', debit: 0, credit: 1500, narration: 'Payment received' },
  ]);
  const bot = await typed({ action: 'show_ledger' }, 'show ledger');
  const text = bot.allText();
  assert.match(text, /Cash: DR NGN 1,500 — Opening float/, `got: ${text}`);
  assert.match(text, /Bello: CR NGN 1,500 — Payment received/);
});

test('R5a: the trial balance still prints DR NGN … | CR NGN … (fmtMoney), untouched by the sweep', async () => {
  accountingService.getTrialBalance = async () => ([
    { account_name: 'Cash', totalDebit: 1500, totalCredit: 0 },
    { account_name: 'Receivables', totalDebit: 60000, totalCredit: 20000 },
  ]);
  const bot = await typed({ action: 'trial_balance' }, 'trial balance');
  const text = bot.allText();
  assert.match(text, /Cash: DR NGN 1,500 \| CR NGN 0\n/, `got: ${text}`);
  assert.match(text, /Receivables: DR NGN 60,000 \| CR NGN 20,000\n/);
  assert.match(text, /\*Totals: DR NGN 61,500 \| CR NGN 20,000\*/);
});

/* ── the bale card, Check Stock, Stock Value ── */

test('bale card: `Price: 3,500/yd` for an admin — bare, per-yd, no /yard; employee sees no rate at all', async () => {
  const admin = await typed({ action: 'package_detail', packageNo: '6061' }, 'details of bale 6061');
  const text = admin.allText();
  assert.match(text, /^Price: 3,500\/yd$/m, `got: ${text}`);
  assert.doesNotMatch(text, NO_UNIT);
  assert.doesNotMatch(text, /\/yard/);

  const emp = await typed({ action: 'package_detail', packageNo: '6061' }, 'details of bale 6061', '4242');
  const et = emp.allText();
  assert.match(et, /Bale 6061/);
  assert.doesNotMatch(et, /Price:/);
  assert.doesNotMatch(et, /3,500/, 'the rate digits must not leak to an employee');
});

test('Check Stock: the selling header prints `Selling: 3,500/yd` to an admin and no digits to an employee', async () => {
  const admin = createFakeBot();
  await controller.handleCallbackQuery(admin, cb('cks:9043-A', '777'));
  const text = admin.allText();
  assert.match(text, /Selling: 3,500\/yd/, `got: ${text}`);
  assert.doesNotMatch(text, NO_UNIT);

  const emp = createFakeBot();
  await controller.handleCallbackQuery(emp, cb('cks:9043-A', '4242'));
  const et = emp.allText();
  assert.match(et, /Stock · 9043-A/);
  assert.doesNotMatch(et, /Selling/);
  assert.doesNotMatch(et, /3,500/);
});

test('Stock Value: list row, grand total, drill button and the shade drill-down are bare; no legend fragment', async () => {
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:stock_value', '777'));
  const text = bot.allText();
  assert.match(text, /\*9043-A\* — 630,000 \(180 yds · 3,500\/yd\)/, `got: ${text}`);
  assert.match(text, /🧮 \*Grand Total:\* 630,000 · 180 yds · 1 design/);
  assert.doesNotMatch(text, NO_UNIT);
  assert.doesNotMatch(text, /amounts in/, 'saleLegend() is empty today — the fragment is omitted, not printed blank');
  assert.ok(labels(bot).includes('9043-A · 630,000'), `drill button bare, got: ${labels(bot).join(' | ')}`);

  const drill = createFakeBot();
  await controller.handleCallbackQuery(drill, cb('svr:dg:9043-A', '777'));
  const dt = drill.allText();
  assert.match(dt, /Selling: 3,500\/yd\n/, `got: ${dt}`);
  assert.match(dt, /Available: 1 Bales · 180 yds · 630,000\n/);
  assert.match(dt, /Shade 6: 1 Bales · 180 yds · 630,000/);
  assert.match(dt, /🧮 \*Design Total:\* 630,000/);
  assert.doesNotMatch(dt, NO_UNIT);
  sessionStore.clear('777');
});

/* ── sales reports and their legend ── */

test('sales report (design wise): legend has no "amounts in" fragment; rows and grand total bare', async () => {
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srg:design', '777'));
  const text = bot.allText();
  assert.match(text, /^_Bales · thans · yds · value_$/m, `legend line is the parts alone, got: ${text}`);
  assert.doesNotMatch(text, /amounts in/);
  assert.match(text, /1\. \*9043-A\* Shade 6 — 1 Bales · 1 thans · 60 yds · 210,000/, `got: ${text}`);
  assert.match(text, /🧮 \*Grand Total: 1 Bales · 1 thans · 60 yds · 210,000\*/);
  assert.doesNotMatch(text, NO_UNIT);
});

test('sales report (customer wise): the customer line and the per-row money tail are bare', async () => {
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srg:customer', '777'));
  const text = bot.allText();
  assert.match(text, /1\. 👤 \*Qaribullah\* — 1 Bales · 1 thans · 60 yds · 210,000/, `got: ${text}`);
  assert.match(text, /9043-A Shade 6: 1 Bales · 1 thans · 60 yds · 210,000/, `valStrRow tail bare, got: ${text}`);
  assert.doesNotMatch(text, /amounts in/);
  assert.doesNotMatch(text, NO_UNIT);
});

/* ── price update wizard ── */

test('price update confirm: Before / After print as bare per-yd rates', async () => {
  sessionStore.set('777', { type: 'update_price_flow', step: 'nudge', design: '9043-A', shade: '6', currentPrice: 3500, flowMessageId: 5 });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('upn:3600', '777'));
  const text = bot.allText();
  assert.match(text, /Before: \*3,500\/yd\*\n/, `got: ${text}`);
  assert.match(text, /After: {2}\*3,600\/yd\*/);
  assert.doesNotMatch(text, /\/yard/);
  assert.doesNotMatch(text, NO_UNIT);
  sessionStore.clear('777');
});

/* ── CON-1 credit chips (R12) ── */

test('CON-1 credit-limit preset chips read `0` / `50k` / `100k` — bare (R12)', async () => {
  sessionStore.set('777', { type: 'add_customer_flow', step: 'credit', personType: 'customer', name: 'Bello', flowMessageId: 5 });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('acb:credit', '777'));
  const chips = labels(bot);
  assert.ok(chips.includes('0'), `zero chip, got: ${chips.join(' | ')}`);
  assert.ok(chips.includes('50k') && chips.includes('100k'), `k chips, got: ${chips.join(' | ')}`);
  assert.ok(chips.every((t) => !NO_UNIT.test(t)), 'no chip carries a symbol');
  sessionStore.clear('777');
});

/* ── customer payment IN (R6): receipt echo, which-customer prompt ── */

test('receipt flow: the typed amount echoes back bare — `Amount: *50,000*`', async () => {
  sessionStore.set('4242', { type: 'receipt_flow', step: 'amount', customer: 'Bello', customerId: 'C1' });
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('50000', '4242'));
  const text = bot.allText();
  assert.match(text, /Amount: \*50,000\*\n\nPayment received in which account\?/, `got: ${text}`);
  assert.doesNotMatch(text, NO_UNIT);
  sessionStore.clear('4242');
});

test('record_payment with an ambiguous name asks `Which customer paid 45,000?` bare', async () => {
  const origResolve = customerEntity.resolve;
  const origSearch = customerEntity.search;
  customerEntity.resolve = async () => null;
  customerEntity.search = async () => ([
    { customer_id: 'C1', name: 'Bello Ahmad', status: 'Active' },
    { customer_id: 'C2', name: 'Bello Musa', status: 'Active' },
  ]);
  try {
    const bot = await typed({ action: 'record_payment', customer: 'Bello', price: 45000 }, 'record payment 45000 from Bello via bank');
    const text = bot.allText();
    assert.match(text, /Which customer paid 45,000\? Tap one:/, `got: ${text}`);
    assert.doesNotMatch(text, NO_UNIT);
  } finally {
    customerEntity.resolve = origResolve;
    customerEntity.search = origSearch;
    sessionStore.clear('777');
  }
});
