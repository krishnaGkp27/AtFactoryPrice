'use strict';

/**
 * BANK-4 — the CUSTOMER'S copy names the bank alone.
 *
 * Owner, 17-Nov-2026, on the invoice printing "paid to Zenith — AFP
 * account": "No need for customer copy to show bank account details. Let it
 * be same as before, plain and simple."
 *
 * Which of the company's accounts received a payment is kept for accounting
 * (the invoice ROW, the ledger narration, Ledger_Entries column L). The
 * three things a customer reads — the invoice PDF, its web copy, and the
 * customer's web ledger — print the bank and nothing after it.
 *
 * The real invoicesRepository writes to a fake Invoices sheet, and every
 * printed string comes from the code path the PDF / web copy draw through.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');

const fake = createFakeSheets({
  Invoices: [],
  Settings: [['key', 'value', 'notes']],
});
installFakeSheets(fake);

const invoicesRepository = require(path.join(SRC, 'repositories/invoicesRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
const invoiceService = require(path.join(SRC, 'services/invoiceService'));
const extLedgerService = require(path.join(SRC, 'services/extLedgerService'));
const bankEntry = require(path.join(SRC, 'utils/bankEntry'));
const { renderHtml } = require(path.join(SRC, 'controllers/invoiceWebController'))._internals;

customersRepository.getAll = async () => [
  { customer_id: 'CUST-1', name: 'ABBA', status: 'Active', aliases: [] },
];
accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 0 });

const { renderText } = invoiceService._internals;
const { _scopeLedger } = extLedgerService._internals;

const SALE = {
  requestId: 'R-BANK4',
  actionJSON: {
    action: 'sale_bundle', customer: 'ABBA', salesDate: '2026-11-17', warehouse: 'Lagos', salesPerson: 'Abdul',
    items: [{ type: 'package', design: '9006', shade: 1, yards: 100, packageNo: '771' }],
  },
};
async function issue(paymentMode) {
  fake._store.set('Invoices', []);
  invoicesRepository._resetHeaderGuard();
  return invoiceService.createForSale({
    item: SALE, enrichment: { ratePerUnitByDesign: { 9006: 10 }, paymentMode, amountPaid: 400 }, approvedBy: '777',
  });
}

/* ── the pure boundary ───────────────────────────────────────────────── */

test('publicBank: the bank alone', () => {
  assert.equal(bankEntry.publicBank('Zenith — AFP'), 'Zenith');
  assert.equal(bankEntry.publicBank('ZENITH - BLACK PANTHER'), 'ZENITH');
  assert.equal(bankEntry.publicBank('GTBank'), 'GTBank');
  assert.equal(bankEntry.publicBank(''), '');
  assert.equal(bankEntry.publicBank(null), '');
});

test('publicMode: the account half goes; everything else is as stored', () => {
  assert.equal(bankEntry.publicMode('Paid to Zenith — AFP'), 'Paid to Zenith');
  assert.equal(bankEntry.publicMode('Bank — Zenith — BP'), 'Bank — Zenith');
  assert.equal(bankEntry.publicMode('Paid to GTBank'), 'Paid to GTBank');
  assert.equal(bankEntry.publicMode('Bank — GTBank'), 'Bank — GTBank');
  for (const same of ['Cash', 'Not yet paid', 'Credit', 'Transfer', '']) {
    assert.equal(bankEntry.publicMode(same), same, same);
  }
  assert.equal(bankEntry.publicMode(null), '');
});

test('publicNarration: the two ledger templates lose the account; anything else is untouched', () => {
  assert.equal(
    bankEntry.publicNarration('Payment received from ABBA: NGN 50000 via Bank · Zenith — AFP'),
    'Payment received from ABBA: NGN 50000 via Bank');
  assert.equal(
    bankEntry.publicNarration('Payment received from ABBA: NGN 50000 via Bank · GTBank'),
    'Payment received from ABBA: NGN 50000 via Bank', 'exactly the wording before BANK-4');
  assert.equal(
    bankEntry.publicNarration('Sale: 100 yds 9006 1 pkg 771 to ABBA | Paid to Zenith — AFP NGN 400'),
    'Sale: 100 yds 9006 1 pkg 771 to ABBA | Paid to Zenith NGN 400');
  assert.equal(
    bankEntry.publicNarration('Sale: 100 yds 9006 1 pkg 771 to ABBA | Paid to Zenith — AFP'),
    'Sale: 100 yds 9006 1 pkg 771 to ABBA | Paid to Zenith');
  // rows written before BANK-4, and rows that name no account, read as they always did
  for (const same of [
    'Payment received from ABBA: NGN 500 via Bank',
    'Payment received from ABBA: NGN 500 via Cash',
    'Sale: 100 yds 9006 1 pkg 771 to ABBA | Not yet paid',
    'Sale: 100 yds 9006 1 pkg 771 to ABBA | Paid to GTBank NGN 400',
    'Sale: 100 yds 9006 1 pkg 771 to ABBA | Cash NGN 1,000.50',
    'Sale: 100 yds 9006 1 pkg 771 to ABBA',
    'Return: 30 yds 9006 1 pkg 771 from ABBA',
    '',
  ]) {
    assert.equal(bankEntry.publicNarration(same), same, same);
  }
  assert.equal(bankEntry.publicNarration(null), '');
});

test('publicNarration keeps the customer name the statement readers extract', () => {
  const pay = bankEntry.publicNarration('Payment received from Alhaji Musa: NGN 100 via Bank · Zenith — AFP');
  assert.equal(/^Payment received from\s+(.+?):/i.exec(pay)[1], 'Alhaji Musa');
  const sale = bankEntry.publicNarration('Sale: 30 yds 9006 1 pkg 5 to Alhaji Musa | Paid to Zenith — AFP NGN 5');
  assert.equal(/\sto\s+(.+?)\s*\|/i.exec(sale)[1], 'Alhaji Musa');
});

/* ── the invoice ─────────────────────────────────────────────────────── */

test('invoice ROW keeps the account for the record; the PDF prints the bank alone', async () => {
  const inv = await issue('Paid to Zenith — AFP');
  // the record
  assert.equal(inv.paymentMode, 'Paid to Zenith — AFP');
  assert.equal(inv.bank, 'Zenith — AFP');
  const row = fake._store.get('Invoices').at(-1);
  assert.ok(row.includes('Paid to Zenith — AFP'), 'the sheet row holds the full mode');
  assert.ok(row.includes('Zenith — AFP'), 'and the receiving account');
  // the customer's paper
  const txt = renderText(inv);
  assert.ok(txt.includes('2026-11-17 paid to Zenith account'), txt.join(' | '));
  assert.ok(!/AFP/.test(txt.join('\n')), 'the account appears nowhere on the PDF');
});

test('invoice web copy prints the bank alone — in the bank AND in the bracketed mode', async () => {
  const inv = await issue('Paid to Zenith — AFP');
  const html = renderHtml(inv);
  assert.match(html, /Payment received 17-Nov-2026 — Zenith \(Paid to Zenith\)/);
  assert.ok(!/AFP/.test(html), 'the account appears nowhere on the web copy');
});

test('an invoice paid to a plain bank prints exactly what it printed before BANK-4', async () => {
  const inv = await issue('Paid to GTBank');
  assert.ok(renderText(inv).includes('2026-11-17 paid to GTBank account'));
  assert.match(renderHtml(inv), /Payment received 17-Nov-2026 — GTBank \(Paid to GTBank\)/);
});

test('an invoice ALREADY issued with the account on its row is read back without it', () => {
  // the stored shape of a row issued between the BANK-4 deploy and this fix
  const stored = {
    invoiceNo: 'INV-2026-0099', token: 'tok_abcdefghijklmnopqrstuvwx', customerName: 'ABBA',
    issueDate: '2026-11-17', saleDate: '2026-11-17',
    lines: [{ design: '9006', yards: 100, qty: 1, shades: ['1'], rate: 10, amount: 1000 }],
    subtotal: 1000, total: 1000, amountPaidAtIssue: 400,
    paymentMode: 'Paid to Zenith — BP', bank: 'Zenith — BP',
  };
  assert.deepEqual(invoiceService.customerCopyPayment(stored), { bank: 'Zenith', mode: 'Paid to Zenith' });
  assert.ok(!/BP\b/.test(renderHtml(stored).replace(/tok_[a-z]+/g, '')), 'no account on the web copy');
  assert.ok(renderText(stored).includes('2026-11-17 paid to Zenith account'));
});

test('customerCopyPayment: cash and unpaid invoices are unchanged', () => {
  assert.deepEqual(invoiceService.customerCopyPayment({ paymentMode: 'Cash', bank: '' }), { bank: '', mode: 'Cash' });
  assert.deepEqual(invoiceService.customerCopyPayment({ paymentMode: 'Not yet paid', bank: '' }), { bank: '', mode: 'Not yet paid' });
  assert.deepEqual(invoiceService.customerCopyPayment({}), { bank: '', mode: '' });
  assert.deepEqual(invoiceService.customerCopyPayment(null), { bank: '', mode: '' });
});

/* ── the customer's web ledger ───────────────────────────────────────── */

test('customer web ledger: narrations cross the boundary without the account; amounts and balance untouched', () => {
  const ledger = { entries: [
    { date: '2026-11-17', narration: 'Sale: 100 yds 9006 1 pkg 771 to ABBA | Paid to Zenith — AFP NGN 400', debit: 1000, credit: 0, created_by: '777', entry_id: 'LE-1' },
    { date: '2026-11-17', narration: 'Payment received from ABBA: NGN 400 via Bank · Zenith — AFP', debit: 0, credit: 400, created_by: '777', entry_id: 'LE-2', bank_account: 'Zenith — AFP' },
    { date: '2026-11-17', narration: 'Payment received from Someone Else: NGN 9 via Bank · Zenith — BP', debit: 0, credit: 9 },
  ] };
  const out = _scopeLedger(ledger, 'ABBA');
  assert.deepEqual(out.entries, [
    { date: '2026-11-17', narration: 'Sale: 100 yds 9006 1 pkg 771 to ABBA | Paid to Zenith NGN 400', debit: 1000, credit: 0, running: 1000 },
    { date: '2026-11-17', narration: 'Payment received from ABBA: NGN 400 via Bank', debit: 0, credit: 400, running: 600 },
  ], 'only this customer, only the whitelisted fields, no account');
  assert.equal(out.outstanding, 600);
  assert.ok(!JSON.stringify(out).includes('AFP'));
  assert.ok(!JSON.stringify(out).includes('bank_account'), 'column L never crosses the boundary');
});
