'use strict';

/**
 * RET-3 — an approved customer return credits the buyer at a real rate.
 *
 * Pins: the credit rides the propagating emitter with the sold row's own
 * price (the sale executor stamped the enriched rate there); an explicit
 * rate on the request wins; a whole-bale return of differently priced thans
 * credits the exact sum; no rate on record is reported as a book failure
 * instead of a silent ₦0; the request's `returnedOn` reaches the movement
 * row; and the approve result carries a human credit note.
 */

process.env.ADMIN_IDS = '777,888';

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryService = require('../../../src/services/inventoryService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const accountingService = require('../../../src/services/accountingService');
const auditService = require('../../../src/services/auditService');
const customerEntity = require('../../../src/services/customerEntity');
const ledgerRepo = require('../../../src/repositories/ledgerRepository');
const stockEngine = require('../../../src/services/stockEngine');

auditService.log = async () => true;
customerEntity.resolve = async ({ name }) => (name === 'ABBA' ? { name: 'ABBA', customer_id: 'CUS-ABBA' } : null);
// The stock_events shadow is fail-open in prod; keep it inert here.
if (stockEngine._internals && stockEngine._internals.shadow) stockEngine._internals.shadow = async () => {};

function harness({ aj, thanRows }) {
  const item = { requestId: 'REQ-RET', user: '555', actionJSON: aj, status: 'pending' };
  const calls = { markThanAvailable: [], markPackageAvailable: [], recordReturn: [], txn: [], audit: [] };
  let resolved = false;
  approvalQueueRepository.getAllPending = async () => (resolved ? [] : [JSON.parse(JSON.stringify(item))]);
  approvalQueueRepository.updateStatus = async (id, status) => { if (status !== 'pending') resolved = true; return true; };
  auditLogRepository.append = async (kind, payload) => { calls.audit.push({ kind, payload }); };
  transactionsRepository.append = async (rec) => { calls.txn.push(rec); return true; };
  accountingService.recordReturn = async (data) => { calls.recordReturn.push(data); };
  inventoryRepository.findThan = async () => ({ ...thanRows[0], status: 'sold', soldTo: 'ABBA' });
  inventoryRepository.findByPackage = async () => thanRows.map((t) => ({ ...t, status: 'sold', soldTo: 'ABBA' }));
  inventoryRepository.markThanAvailable = async (packageNo, thanNo, opts) => {
    calls.markThanAvailable.push({ packageNo, thanNo, opts });
    return { ...thanRows[0], status: 'available', soldToPrior: 'ABBA' };
  };
  inventoryRepository.markPackageAvailable = async (packageNo, opts) => {
    calls.markPackageAvailable.push({ packageNo, opts });
    return thanRows.map((t) => ({ ...t, status: 'available', soldToPrior: 'ABBA' }));
  };
  return calls;
}

const THAN = { packageNo: '9037', thanNo: 1, yards: 30, pricePerYard: 2500, design: 'D1', shade: 'Blue', warehouse: 'Kano office' };

test('return_than credits yards × the sold row price to the resolved buyer', async () => {
  const calls = harness({ aj: { action: 'return_than', packageNo: '9037', thanNo: 1, warehouse: 'Kano office' }, thanRows: [THAN] });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true);
  assert.deepEqual(res.erpFailures, []);
  assert.equal(calls.recordReturn.length, 1);
  const c = calls.recordReturn[0];
  assert.equal(c.yards, 30);
  assert.equal(c.pricePerYard, 2500);
  assert.equal(c.customerId, 'CUS-ABBA');
  assert.equal(c.customer, 'ABBA');
  assert.equal(c.txnId, 'RT-9037-1');
  assert.match(res.creditNote, /Credited ₦75,000 to ABBA/);
  // The Transactions row now carries the rate and the customer too.
  assert.equal(calls.txn[0].pricePerYard, 2500);
  assert.equal(calls.txn[0].customerId, 'CUS-ABBA');
});

test('an explicit rate on the request wins over the row price', async () => {
  const calls = harness({ aj: { action: 'return_than', packageNo: '9037', thanNo: 1, warehouse: 'Kano office', pricePerYard: 3000 }, thanRows: [THAN] });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(calls.recordReturn[0].pricePerYard, 3000);
  assert.match(res.creditNote, /₦90,000/);
});

test('return_package with mixed than prices credits the exact sum', async () => {
  const rows = [THAN, { ...THAN, thanNo: 2, yards: 20, pricePerYard: 3000 }];
  const calls = harness({ aj: { action: 'return_package', packageNo: '9037', warehouse: 'Kano office' }, thanRows: rows });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true);
  const c = calls.recordReturn[0];
  assert.equal(c.yards, 50);
  assert.ok(Math.abs(c.yards * c.pricePerYard - 135000) < 1e-6, 'weighted rate reproduces 30×2500 + 20×3000');
  assert.match(res.creditNote, /₦135,000/);
});

test('no rate on record: stock returns, the missing credit is reported, never a silent ₦0', async () => {
  const calls = harness({ aj: { action: 'return_than', packageNo: '9037', thanNo: 1, warehouse: 'Kano office' }, thanRows: [{ ...THAN, pricePerYard: 0 }] });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true, 'the stock flip still happens');
  assert.equal(calls.markThanAvailable.length, 1);
  assert.equal(res.erpFailures.length, 1);
  assert.match(res.erpFailures[0].error, /no rate on record for Bale 9037/);
  assert.equal(res.creditNote, null);
  assert.ok(calls.audit.some((a) => a.kind === 'erp_hook_failed'), 'AuditLog carries the uncredited return');
});

test('a ledger failure is surfaced, not swallowed', async () => {
  const calls = harness({ aj: { action: 'return_than', packageNo: '9037', thanNo: 1, warehouse: 'Kano office' }, thanRows: [THAN] });
  accountingService.recordReturn = async () => { throw new Error('sheet quota'); };
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true);
  assert.equal(res.erpFailures.length, 1);
  assert.match(res.erpFailures[0].error, /sheet quota/);
  assert.equal(calls.recordReturn.length, 0);
});

test('returnedOn on the request reaches the movement row date', async () => {
  const calls = harness({ aj: { action: 'return_package', packageNo: '9037', warehouse: 'Kano office', returnedOn: '2026-08-28' }, thanRows: [THAN] });
  await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(calls.markPackageAvailable[0].opts.on, '2026-08-28');
  assert.equal(calls.markPackageAvailable[0].opts.warehouse, 'Kano office');
});

test('recordReturn itself writes a Customer Receivable credit of yards × rate', async () => {
  delete require.cache[require.resolve('../../../src/services/accountingService')];
  const fresh = require('../../../src/services/accountingService');
  require('../../../src/repositories/chartOfAccountsRepository').findByName = async () => ({ code: '1100' });
  const rows = [];
  ledgerRepo.append = async (e) => { rows.push(e); };
  await fresh.recordReturn({ yards: 30, pricePerYard: 2500, packageNo: '9037', design: 'D1', shade: 'Blue', userId: '555', txnId: 'RT-9037-1', customer: 'ABBA', customerId: 'CUS-ABBA' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].credit, 75000);
  assert.equal(rows[0].debit, 0);
  assert.equal(rows[0].customer_id, 'CUS-ABBA');
  assert.match(rows[0].narration, /Return: 30 yds D1 Blue pkg 9037 from ABBA/);
});
