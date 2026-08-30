'use strict';

/**
 * INV-1a — invoice creation, numbering, and PDF rendering.
 * Repos are stubbed; pdf output only sanity-checked (header + size).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const invoicesRepository = require(path.join(SRC, 'repositories/invoicesRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
const invoiceService = require(path.join(SRC, 'services/invoiceService'));

let stored = [];
invoicesRepository.getAll = async () => stored;
invoicesRepository.maxSeqForYear = async (year) => {
  const re = new RegExp(`^INV-${year}-(\\d+)$`);
  return stored.reduce((m, r) => { const x = re.exec(r.invoiceNo); return x ? Math.max(m, +x[1]) : m; }, 0);
};
invoicesRepository.append = async (rec) => { stored.push(rec); return rec; };
// CUS-2 — createForSale resolves through customerEntity, which reads getAll.
customersRepository.getAll = async () => [
  { customer_id: 'CUST-20260601-001', name: 'Alabi Johnson', status: 'Active', aliases: ['Alabi J.'] },
  { customer_id: 'CUST-20260601-002', name: 'Alabi J.', status: 'Merged', aliases: [] },
];
accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 209000 });

const YEAR = new Date().getFullYear();

test('numbering: first invoice of the year is 0001, then increments', async () => {
  stored = [];
  assert.equal(await invoiceService.mintInvoiceNo(), `INV-${YEAR}-0001`);
  stored.push({ invoiceNo: `INV-${YEAR}-0007` });
  assert.equal(await invoiceService.mintInvoiceNo(), `INV-${YEAR}-0008`);
});

test('buildLines: bundle items aggregate per design with shades sorted', () => {
  const aj = { items: [
    { type: 'than', design: '77019', shade: 3, yards: 60 },
    { type: 'than', design: '77019', shade: 1, yards: 60 },
    { type: 'package', design: '9037', shade: 8, yards: 120 },
  ] };
  const lines = invoiceService.buildLines(aj, { ratePerUnitByDesign: { 77019: 1450, 9037: 1200 } });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].shades, ['1', '3']);
  assert.equal(lines[0].amount, 120 * 1450);
  assert.equal(lines[1].amount, 120 * 1200);
});

test('buildLines: ST-1 yardsByDesign path and single-design fallback', () => {
  const st1 = invoiceService.buildLines({ yardsByDesign: { 44200: 300 } }, { ratePerUnitByDesign: { 44200: 1500 } });
  assert.equal(st1[0].amount, 450000);
  const single = invoiceService.buildLines({ design: '201', shade: '4', yards: 55 }, { pricePerYard: 1000 });
  assert.equal(single[0].amount, 55000);
  assert.deepEqual(single[0].shades, ['4']);
});

test('bankFromPaymentMode extracts the receiving account', () => {
  assert.equal(invoiceService.bankFromPaymentMode('Paid to GTBank'), 'GTBank');
  assert.equal(invoiceService.bankFromPaymentMode('Cash'), '');
});

test('CUS-2: an alias spelling resolves to the canonical customer on the invoice', async () => {
  stored = [];
  const item = { requestId: 'req-inv-2', actionJSON: {
    action: 'sale_bundle', customer: 'Alabi J.', salesDate: '2026-07-15',
    items: [{ type: 'than', design: '77019', shade: 1, yards: 60 }],
  } };
  const inv = await invoiceService.createForSale({ item, enrichment: { ratePerUnitByDesign: { 77019: 1450 } }, approvedBy: '777' });
  assert.equal(inv.customerId, 'CUST-20260601-001', 'alias lands on the canonical id, not the merged husk');
  assert.equal(inv.customerName, 'Alabi Johnson', 'invoice paper carries the canonical name');
});

test('createForSale persists a complete row and renderPdf produces a PDF', async () => {
  stored = [];
  const item = { requestId: 'req-inv-1', actionJSON: {
    action: 'sale_bundle', customer: 'Alabi Johnson', salesDate: '2026-07-15', warehouse: 'IDUMOTA', salesPerson: 'Yarima',
    items: [1, 2, 3, 4, 6, 7, 8].map((s) => ({ type: 'than', design: '77019', shade: s, yards: 60 })),
  } };
  const inv = await invoiceService.createForSale({ item, enrichment: { ratePerUnitByDesign: { 77019: 1450 }, paymentMode: 'Paid to GTBank', amountPaid: 400000 }, approvedBy: '777' });
  assert.equal(inv.invoiceNo, `INV-${YEAR}-0001`);
  assert.equal(inv.customerId, 'CUST-20260601-001');
  assert.equal(inv.total, 420 * 1450);
  assert.equal(inv.amountPaidAtIssue, 400000);
  assert.equal(inv.balanceAfterIssue, 209000);
  assert.equal(inv.bank, 'GTBank');
  assert.ok(inv.token.length >= 12, 'unguessable token minted');
  assert.equal(stored.length, 1, 'row persisted');

  const pdf = await invoiceService.renderPdf(inv);
  assert.ok(Buffer.isBuffer(pdf) && pdf.length > 2000, 'non-trivial PDF buffer');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', 'valid PDF header');
});

test('CARD-5: lines carry the item packaging, and words never guess', () => {
  // 2 than items (3 thans total) + 1 whole bale of the same design.
  const aj = { items: [
    { design: '77014', shade: '1', yards: 30, type: 'than', thans: 1, packageNo: '900' },
    { design: '77014', shade: '2', yards: 30, type: 'than', thans: 2, packageNo: '900' },
    { design: '77014', shade: '3', yards: 120, packageNo: '901' },
  ] };
  const [l] = invoiceService.buildLines(aj, { ratePerUnitByDesign: { 77014: 3900 } });
  assert.equal(l.bales, 1, 'whole bales counted by DISTINCT printed number');
  assert.equal(l.thans, 3, 'than items counted by their thans');
  assert.equal(invoiceService.packagingWords(l), '1 bale + 3 thans');

  // The ABBA shape: 28 than items must never be worded as bales.
  const thans = Array.from({ length: 28 }, (_, i) => (
    { design: '77014', shade: String(1 + (i % 7)), yards: 29.6, type: 'than', thans: 1, packageNo: `P${i}` }));
  const [only] = invoiceService.buildLines({ items: thans }, { ratePerUnitByDesign: { 77014: 3900 } });
  assert.equal(invoiceService.packagingWords(only), '28 thans');

  // A line frozen before the packaging fields → no word is guessed.
  assert.equal(invoiceService.packagingWords({ qty: 28 }), '', 'legacy lines fall back to neutral wording at the renderer');
});
