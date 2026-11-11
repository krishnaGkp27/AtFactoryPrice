'use strict';

/**
 * FIX-BANKLEDGER — a sale paid into a bank, END TO END through fakeSheets.
 *
 * The sale approval wizard's bank chip stores `Paid to <bank>` (pinned in
 * test/unit/events/approvalEvents.enrichmentChips.test.js). When the sale was
 * booked, the payment reached the Bank ledger only if that text contained the
 * word "bank": `Paid to Zenith` landed in Cash (request R-9BF6, 3,750).
 *
 * This runs approved sales through the REAL executor, the real
 * crmService.recordPayment and the real accountingService against the
 * in-memory sheets and reads the Ledger_Entries and Transactions rows that
 * came out — every sale door that books a payment (bundle, whole bale, one
 * than) and the Payment Received door's `record_payment`.
 *
 * What must hold: the payment's debit leg is on the Bank account; the mode
 * text on the Transactions row is exactly what the wizard stored; Cash is
 * still Cash; Not yet paid books no payment.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, SRC } = require('../helpers/controllerHarness');

const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));

const INV_HEADER = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status',
  'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];

function invRow(pkg, thanNo, design) {
  return inventoryRepository.toRow({
    packageNo: pkg, indent: '', csNo: '', design, shade: 'Red', thanNo, yards: 30, status: 'available',
    warehouse: 'IDUMOTA', pricePerYard: 100, dateReceived: '2026-01-01', soldTo: '', soldDate: '',
    netMtrs: '', netWeight: '', updatedAt: '2026-01-01',
    baleUid: `BAL-${pkg}-${thanNo}`, addedAt: '2026-01-01', grnId: '', arrivalBatch: '', designCategory: '',
  });
}

const seed = [];
for (const pkg of ['B1', 'B2', 'B3', 'B4', 'B5', 'B6']) for (let t = 1; t <= 2; t += 1) seed.push(invRow(pkg, t, '9006'));

const fake = createFakeSheets({
  Inventory: [INV_HEADER, ...seed],
  BaleMovements: [],
  Transactions: [],
  Ledger_Entries: [['entry_id', 'txn_id', 'date', 'account_code', 'ledger_name', 'debit', 'credit', 'narration', 'created_by', 'created_at', 'customer_id']],
  Chart_of_Accounts: [
    ['account_code', 'account_name', 'account_type', 'parent_code', 'is_active'],
    ['1001', 'Cash', 'Asset', '1000', 'TRUE'],
    ['1002', 'Bank', 'Asset', '1000', 'TRUE'],
    ['1100', 'Customer Receivable', 'Asset', '1000', 'TRUE'],
  ],
  Customers: [
    ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases', 'stores', 'first_sale_at'],
    ['CUST-1', 'ABBA', '', '', 'Retail', '0', '500000', 'COD', '', 'Active', '2026-01-01', '2026-01-01', '', '', ''],
  ],
  // The wizard draws one chip per entry; none of these names carries the word "bank".
  Settings: [['Key', 'Value', 'UpdatedAt'], ['BANK_LIST', 'Zenith,GTB,Opay', '2026-01-01']],
});
installFakeSheets(fake);

const inventoryService = require(path.join(SRC, 'services/inventoryService'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const auditService = require(path.join(SRC, 'services/auditService'));
const invoiceService = require(path.join(SRC, 'services/invoiceService'));

invoiceService.createForSale = async () => null;
auditService.log = async () => true;
auditLogRepository.append = async () => {};

const base = { user: '888', status: 'pending', createdAt: '2026-09-25T09:00:00.000Z' };
const ROWS = {
  'R-BUNDLE': { ...base, requestId: 'R-BUNDLE', actionJSON: { action: 'sale_bundle', customer: 'ABBA', customerId: 'CUST-1', salesDate: '2026-09-25', warehouse: 'IDUMOTA', items: [{ type: 'package', packageNo: 'B1', warehouse: 'IDUMOTA' }] } },
  'R-BALE': { ...base, requestId: 'R-BALE', actionJSON: { action: 'sell_package', customer: 'ABBA', customerId: 'CUST-1', salesDate: '2026-09-25', warehouse: 'IDUMOTA', packageNo: 'B2', design: '9006', shade: 'Red', yards: 60, thans: 2 } },
  'R-THAN': { ...base, requestId: 'R-THAN', actionJSON: { action: 'sell_than', customer: 'ABBA', customerId: 'CUST-1', salesDate: '2026-09-25', warehouse: 'IDUMOTA', packageNo: 'B3', thanNo: 1, design: '9006', shade: 'Red', yards: 30 } },
  'R-CASH': { ...base, requestId: 'R-CASH', actionJSON: { action: 'sale_bundle', customer: 'ABBA', customerId: 'CUST-1', salesDate: '2026-09-25', warehouse: 'IDUMOTA', items: [{ type: 'package', packageNo: 'B4', warehouse: 'IDUMOTA' }] } },
  'R-CREDIT': { ...base, requestId: 'R-CREDIT', actionJSON: { action: 'sale_bundle', customer: 'ABBA', customerId: 'CUST-1', salesDate: '2026-09-25', warehouse: 'IDUMOTA', items: [{ type: 'package', packageNo: 'B5', warehouse: 'IDUMOTA' }] } },
  'R-PRC': { ...base, requestId: 'R-PRC', actionJSON: { action: 'record_payment', customer: 'ABBA', customerId: 'CUST-1', amount: 5000, method: 'Bank — Zenith', source: 'payment_received_door' } },
  'R-TYPED': { ...base, requestId: 'R-TYPED', actionJSON: { action: 'sale_bundle', customer: 'ABBA', customerId: 'CUST-1', salesDate: '2026-09-25', warehouse: 'IDUMOTA', items: [{ type: 'package', packageNo: 'B6', warehouse: 'IDUMOTA' }] } },
  'R-BARE': { ...base, requestId: 'R-BARE', actionJSON: { action: 'record_payment', customer: 'ABBA', customerId: 'CUST-1', amount: 700, method: 'zenith' } },
  'R-OFFLIST': { ...base, requestId: 'R-OFFLIST', actionJSON: { action: 'record_payment', customer: 'ABBA', customerId: 'CUST-1', amount: 800, method: 'Kuda' } },
};
const resolved = new Set();
const copy = (r) => JSON.parse(JSON.stringify(r));
approvalQueueRepository.getAllPending = async () => Object.values(ROWS).filter((r) => !resolved.has(r.requestId)).map(copy);
approvalQueueRepository.getByRequestId = async (id) => (ROWS[id] ? copy(ROWS[id]) : null);
approvalQueueRepository.getAll = async () => Object.values(ROWS).map((r) => ({ ...copy(r), status: resolved.has(r.requestId) ? 'approved' : 'pending' }));
approvalQueueRepository.updateStatus = async (id, status) => { if (status === 'approved') resolved.add(id); return true; };
approvalQueueRepository.updateActionJSON = async () => true;

const LEDGER_COLS = ['entry_id', 'txn_id', 'date', 'account_code', 'ledger_name', 'debit', 'credit', 'narration', 'created_by', 'created_at', 'customer_id'];
const ledgerRows = () => fake._store.get('Ledger_Entries').slice(1)
  .map((r) => Object.fromEntries(LEDGER_COLS.map((c, i) => [c, r[i]])));
/** The payment pairs (debit leg + receivable credit leg) booked since `from`. */
const paymentsSince = (from) => ledgerRows().slice(from).filter((r) => /^Payment received from /.test(r.narration));
/** Transactions column N (index 13) is PaymentMode, O (14) the sale ref. */
const txnFor = (requestId) => fake._store.get('Transactions').find((r) => r[14] === requestId);

async function approve(requestId, enrichment) {
  const from = ledgerRows().length;
  const res = await inventoryService.executeApprovedAction(requestId, '777', enrichment);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.erpFailures || [], [], 'the books were written');
  return paymentsSince(from);
}

test('bundle sale, bank chip `Paid to Zenith` (the R-9BF6 shape): the 3,750 is debited to Bank, not Cash', async () => {
  const pay = await approve('R-BUNDLE', { ratePerUnitByDesign: { 9006: 1500 }, paymentMode: 'Paid to Zenith', amountPaid: 3750 });
  assert.equal(pay.length, 2, 'one debit leg + one receivable credit leg');
  const [debit, credit] = pay;
  assert.deepEqual([debit.ledger_name, debit.account_code, Number(debit.debit)], ['Bank', '1002', 3750]);
  assert.deepEqual([credit.ledger_name, credit.account_code, Number(credit.credit)], ['Customer Receivable', '1100', 3750]);
  assert.equal(debit.txn_id, 'R-BUNDLE-PAY', 'still keyed to the request (QTA-2)');
  assert.equal(debit.customer_id, 'CUST-1');
  assert.equal(debit.narration, 'Payment received from ABBA: NGN 3750 via Bank');
  assert.ok(!ledgerRows().some((r) => r.ledger_name === 'Cash'), 'nothing reached the Cash account');
  // The stored mode text is exactly what the wizard wrote.
  assert.equal(txnFor('R-BUNDLE')[13], 'Paid to Zenith');
});

test('whole-bale sale, `Paid to GTB`: Bank', async () => {
  const pay = await approve('R-BALE', { ratePerUnitByDesign: { 9006: 1500 }, paymentMode: 'Paid to GTB', amountPaid: 90000 });
  assert.deepEqual([pay[0].ledger_name, pay[0].account_code, Number(pay[0].debit)], ['Bank', '1002', 90000]);
  assert.equal(txnFor('R-BALE')[13], 'Paid to GTB');
});

test('one-than sale, `Paid to Opay`: Bank', async () => {
  const pay = await approve('R-THAN', { ratePerUnitByDesign: { 9006: 1500 }, paymentMode: 'Paid to Opay', amountPaid: 45000 });
  assert.deepEqual([pay[0].ledger_name, pay[0].account_code, Number(pay[0].debit)], ['Bank', '1002', 45000]);
  assert.equal(txnFor('R-THAN')[13], 'Paid to Opay');
});

test('Cash stays on the Cash account', async () => {
  const pay = await approve('R-CASH', { ratePerUnitByDesign: { 9006: 1500 }, paymentMode: 'Cash', amountPaid: 20000 });
  assert.deepEqual([pay[0].ledger_name, pay[0].account_code, Number(pay[0].debit)], ['Cash', '1001', 20000]);
  assert.equal(pay[0].narration, 'Payment received from ABBA: NGN 20000 via Cash');
  assert.equal(txnFor('R-CASH')[13], 'Cash');
});

test('Not yet paid books the sale and NO payment', async () => {
  const from = ledgerRows().length;
  const pay = await approve('R-CREDIT', { ratePerUnitByDesign: { 9006: 1500 }, paymentMode: 'Not yet paid', amountPaid: 0 });
  assert.equal(pay.length, 0);
  const added = ledgerRows().slice(from);
  assert.equal(added.length, 1, 'only the sale\'s receivable debit');
  assert.deepEqual([added[0].ledger_name, Number(added[0].debit)], ['Customer Receivable', 90000]);
  assert.equal(txnFor('R-CREDIT')[13], 'Not yet paid');
});

test('the Payment Received door\'s `Bank — Zenith` still reaches Bank', async () => {
  const pay = await approve('R-PRC');
  assert.deepEqual([pay[0].ledger_name, pay[0].account_code, Number(pay[0].debit)], ['Bank', '1002', 5000]);
});

test('a typed mode naming no listed bank and not shaped `Paid to …` stays where it went before: Cash', async () => {
  const pay = await approve('R-TYPED', { ratePerUnitByDesign: { 9006: 1500 }, paymentMode: 'Transfer', amountPaid: 1000 });
  assert.deepEqual([pay[0].ledger_name, pay[0].account_code], ['Cash', '1001']);
  assert.equal(txnFor('R-TYPED')[13], 'Transfer');
});

test('a bare bank name is recognised from the Settings BANK_LIST cell, in any case; a bank not on the list is not', async () => {
  const listed = await approve('R-BARE');
  assert.deepEqual([listed[0].ledger_name, listed[0].account_code, Number(listed[0].debit)], ['Bank', '1002', 700]);
  const unlisted = await approve('R-OFFLIST');
  assert.deepEqual([unlisted[0].ledger_name, unlisted[0].account_code, Number(unlisted[0].debit)], ['Cash', '1001', 800]);
});
