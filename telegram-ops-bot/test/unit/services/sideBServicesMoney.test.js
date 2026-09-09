'use strict';

/**
 * CUR-1 release A, package P3 — the side-B SERVICES and COMMANDS print money
 * bare (BUSINESS_RULES §17; CUR-1 §5): reports, rate suggestions, the landed
 * cost preview, the ledger command replies. One legend line at most per
 * reply, and none while money.saleLegend() is '' (R5 as recommended); the
 * accounting narration keeps the stored CODE (R7); the AI data context keeps
 * its per-number code prefixes (R18).
 *
 * Every repository/service reached is monkeypatched on its module object —
 * no sheet, no Telegram, no model call.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../../../src/utils/money');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const pricingService = require('../../../src/services/pricingService');
const analytics = require('../../../src/ai/analytics');
const queryEngine = require('../../../src/services/queryEngine');
const rateSuggestionService = require('../../../src/services/rateSuggestionService');
const landedCostService = require('../../../src/services/landedCostService');
const accountingService = require('../../../src/services/accountingService');
const ledgerRepo = require('../../../src/repositories/ledgerRepository');
const chartRepo = require('../../../src/repositories/chartOfAccountsRepository');
const ledgerService = require('../../../src/services/ledgerService');
const balanceService = require('../../../src/services/balanceService');
const transactionService = require('../../../src/services/transactionService');
const ledgerCommands = require('../../../src/commands/ledgerCommands');

const NO_SYMBOL = /₦|NGN/;

const ROWS = [
  { packageNo: 'P1', design: 'D1', shade: 'Red', indent: 'I1', warehouse: 'Kano office', status: 'available', yards: 50, pricePerYard: 1450, soldTo: '', soldDate: '', dateReceived: '2026-01-01' },
  { packageNo: 'P1', design: 'D1', shade: 'Red', indent: 'I1', warehouse: 'Kano office', status: 'available', yards: 50, pricePerYard: 1450, soldTo: '', soldDate: '', dateReceived: '2026-01-01' },
  { packageNo: 'P2', design: 'D1', shade: 'Red', indent: 'I1', warehouse: 'Kano office', status: 'sold', yards: 40, pricePerYard: 1500, soldTo: 'ABBA', soldDate: '2026-09-01', dateReceived: '2026-01-01' },
];

function fakeBot() {
  const texts = [];
  return { texts, sendMessage: async (_chat, text) => { texts.push(String(text)); } };
}

test.beforeEach(() => {
  inventoryRepository.getAll = async () => ROWS;
});

test('legend seam: saleLegend() is empty today, so no side-B report carries a legend line', () => {
  assert.equal(money.saleLegend(), '');
});

test('queryEngine reports: bare values, Selling as a bare rate, no legend fragment', async () => {
  pricingService.canSeeSalePrice = () => true;
  const summary = await queryEngine.stockSummary('777');
  assert.match(summary, /Selling: 1,500\/yd ·varies/);
  assert.doesNotMatch(summary, NO_SYMBOL);
  assert.ok(!summary.endsWith('\n'), 'no dangling legend line when saleLegend() is empty');

  const valuation = await queryEngine.stockValuation();
  assert.match(valuation, /Total value: 145,000$/);
  assert.doesNotMatch(valuation, NO_SYMBOL);

  const sales = await queryEngine.salesReport('all');
  assert.match(sales, /Revenue: 60,000\n/);
  assert.doesNotMatch(sales, NO_SYMBOL);

  const sold = await queryEngine.soldReport('', '', 'all');
  assert.match(sold, /Value: 60,000$/);
  assert.doesNotMatch(sold, NO_SYMBOL);

  const customers = await queryEngine.customerReport();
  assert.match(customers, /ABBA: 1 pkgs \(1 thans\), 40 yds, 60,000/);
  assert.doesNotMatch(customers, NO_SYMBOL);

  const warehouses = await queryEngine.warehouseSummary();
  assert.match(warehouses, /Kano office: 1 pkgs \(2 thans\), 100 yds — 145,000/);
  assert.doesNotMatch(warehouses, NO_SYMBOL);

  const dead = await queryEngine.deadStockReport();
  assert.doesNotMatch(dead, NO_SYMBOL);
});

test('queryEngine.stockSummary: a role without price access sees no rate digits (re-pinned on digits, not ₦)', async () => {
  pricingService.canSeeSalePrice = () => false;
  const text = await queryEngine.stockSummary('2');
  assert.doesNotMatch(text, /Selling/);
  assert.doesNotMatch(text, /1,500/);
});

test('analytics.getAnalysisSummary: stock and sales values bare, no symbol', async () => {
  const text = await analytics.getAnalysisSummary();
  assert.match(text, /yards \(145,000\)/);
  assert.match(text, /yards \(60,000\)/);
  assert.match(text, /ABBA: 1 pkgs \(1 thans\), 40 yds, 60,000/);
  assert.doesNotMatch(text, NO_SYMBOL);
  assert.equal(typeof analytics.fmtMoney, 'undefined', 'dead fmtMoney re-export is gone');
});

test('rateSuggestionService.formatSuggestionLines: every hint is a bare rate', () => {
  const text = rateSuggestionService.formatSuggestionLines({
    lastCustomerRate: 4500, lastAnyRate: 4400, median30dRate: 4350.4, median30dCount: 12, floorRate: 3800,
  });
  assert.match(text, /Last to this customer: 4,500\/yd/);
  assert.match(text, /30-day median: 4,350\/yd \(12 sales\)/);
  assert.match(text, /Floor \(landed cost\): 3,800\/yd/);
  assert.doesNotMatch(text, NO_SYMBOL);
  assert.doesNotMatch(text, /\/yd\/yd/, 'the divisor is printed once');
});

test('landedCostService.buildPreviewText (R8): sealed rate bare at 2 dp, pair leg named by code(), USD keeps $', () => {
  const text = landedCostService.buildPreviewText({
    grn: { grn_id: 'GRN-1', warehouse: 'Kano office', supplier: 'S', total_bales: 10 },
    usdPerYard: 2,
    charges: [{ type_name: 'Freight', amount_usd: 100 }],
    allocation: { totalYards: 1000, chargesUsd: 100, chargeCount: 1, usdChargesPerYard: 0.1, usdLandedPerYard: 2.1, fxRate: 1520, ngnLandedPerYard: 3192.456 },
  });
  assert.match(text, /USD cost \/ yard: \*\$2\*/);
  assert.match(text, /FX \(USD→NGN\):\s+1,520/);
  assert.match(text, /NGN landed \/ yd: 3,192\.46\/yd\*/);
  assert.doesNotMatch(text, /₦/);
});

test('accountingService (R7): the persisted narration keeps the accounting CODE from money.code(), never ₦', async () => {
  const appended = [];
  chartRepo.findByName = async () => null;
  ledgerRepo.append = async (row) => { appended.push(row); };
  ledgerRepo.appendPair = async (a, b) => { appended.push(a, b); };
  await accountingService.recordSale({ customer: 'ABBA', yards: 10, pricePerYard: 500, packageNo: 'P1', design: 'D1', shade: 'Red', paymentMode: 'Cash', amountPaid: 5000 });
  await accountingService.recordPaymentReceived({ customer: 'ABBA', amount: 2000, method: 'Bank' });
  assert.match(appended[0].narration, /\| Cash NGN 5000$/);
  assert.match(appended[1].narration, /: NGN 2000 via Bank$/);
  for (const r of appended) assert.doesNotMatch(r.narration, /₦/);
});

test('ledgerCommands (R5): /ledger, /balance, /payment print bare figures with no legend fragment', async () => {
  ledgerService.getCustomerLedger = async () => ({
    ok: true,
    customer: { customer_id: 'CUST-1', customer_name: 'ABBA' },
    rows: [
      { date: '2026-09-01', description: 'Sale', debit: 60000, credit: 0, balance: 60000 },
      { date: '2026-09-02', description: 'Payment', debit: 0, credit: 20000, balance: 40000 },
    ],
  });
  balanceService.getCustomerBalance = async () => ({ ok: true, customer_name: 'ABBA', balance: 40000 });
  transactionService.createTransaction = async () => ({ ok: true, balance: 15000 });

  const bot = fakeBot();
  await ledgerCommands.handleLedger(bot, 1, '777', 'CUST-1');
  await ledgerCommands.handleBalance(bot, 1, '777', 'CUST-1');
  await ledgerCommands.handlePayment(bot, 1, '777', 'CUST-1 25,000');

  const [ledger, balance, payment] = bot.texts;
  assert.match(ledger, /\|\s+60,000 \|\s+— \| 60,000/);
  assert.match(ledger, /\|\s+— \|\s+20,000 \| 40,000/);
  assert.ok(!/\n_.*_$/.test(ledger), 'no legend line while saleLegend() is empty');
  assert.match(balance, /Balance: 40,000$/);
  assert.match(payment, /New balance: 15,000$/);
  for (const t of bot.texts) assert.doesNotMatch(t, NO_SYMBOL);
});

test('dead re-exports are gone: salesFlowService.fmtMoney, crmService.fmtMoney, inventoryService.formatMoney', () => {
  assert.equal(typeof require('../../../src/services/salesFlowService').fmtMoney, 'undefined');
  assert.equal(typeof require('../../../src/services/crmService').fmtMoney, 'undefined');
  assert.equal(typeof require('../../../src/services/inventoryService').formatMoney, 'undefined');
});
