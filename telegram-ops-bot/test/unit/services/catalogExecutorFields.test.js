'use strict';
/**
 * CAT-F1 (03-Oct-2026) — the catalogue executors read the stock and ledger
 * rows under the repositories' own (snake_case) field names. Before this
 * test the camelCase reads saw `undefined`: the "insufficient stock" guard
 * never fired, every approved supply/loan rewrote the CatalogStock row with
 * zeros, and a return never found its ledger row.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryService = require('../../../src/services/inventoryService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const catalogStockRepo = require('../../../src/repositories/catalogStockRepository');
const catalogLedgerRepo = require('../../../src/repositories/catalogLedgerRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');

function arm(aj, stockRow, ledgerRows = []) {
  const calls = { updateQty: [], ledgerAppend: [], markReturned: [], status: [] };
  const item = { requestId: 'R-CAT-1', user: 'abdul', status: 'pending', actionJSON: aj };
  approvalQueueRepository.getAllPending = async () => [item];
  approvalQueueRepository.getByRequestId = async () => item;
  approvalQueueRepository.updateStatus = async (id, status) => { calls.status.push(status); return true; };
  approvalQueueRepository.updateActionJSON = async () => true;
  catalogStockRepo.find = async () => (stockRow ? { ...stockRow } : null);
  catalogStockRepo.updateQty = async (...a) => { calls.updateQty.push(a); };
  catalogStockRepo.invalidateCache = () => {};
  catalogLedgerRepo.append = async (r) => { calls.ledgerAppend.push(r); };
  catalogLedgerRepo.getAll = async () => ledgerRows;
  catalogLedgerRepo.markReturned = async (...a) => { calls.markReturned.push(a); };
  catalogLedgerRepo.invalidateCache = () => {};
  auditLogRepository.append = async () => {};
  transactionsRepository.append = async () => {};
  return calls;
}
const STOCK = { rowIndex: 7, design: '9006', catalog_size: 'Big', warehouse: 'Lagos', total_qty: 12, in_office_qty: 9, with_customers_qty: 1, with_marketers_qty: 2 };

test('catalog_supply debits in-office and credits with-customers by the approved quantity', async () => {
  const calls = arm({ action: 'catalog_supply', design: '9006', catalogSize: 'Big', warehouse: 'Lagos', quantity: 2, recipientName: 'ABBA' }, STOCK);
  const res = await inventoryService.executeApprovedAction('R-CAT-1', '777', {});
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(calls.updateQty[0], [7, 7, 3, 2], 'office 9→7, customers 1→3, marketers unchanged');
  assert.equal(calls.ledgerAppend[0].recipientType, 'customer');
  assert.equal(calls.ledgerAppend[0].quantity, 2);
  assert.deepEqual(calls.status, ['approved']);
});

test('catalog_loan credits with-marketers; a short office count is refused BEFORE any write', async () => {
  const calls = arm({ action: 'catalog_loan', design: '9006', catalogSize: 'Big', warehouse: 'Lagos', quantity: 3, recipientName: 'Musa' }, STOCK);
  const res = await inventoryService.executeApprovedAction('R-CAT-1', '777', {});
  assert.equal(res.ok, true);
  assert.deepEqual(calls.updateQty[0], [7, 6, 1, 5]);
  const short = arm({ action: 'catalog_loan', design: '9006', catalogSize: 'Big', warehouse: 'Lagos', quantity: 10, recipientName: 'Musa' }, STOCK);
  const refused = await inventoryService.executeApprovedAction('R-CAT-1', '777', {});
  assert.equal(refused.ok, false);
  assert.match(refused.message, /Insufficient stock: only 9 available/);
  assert.equal(short.updateQty.length, 0, 'nothing written');
  assert.equal(short.status.length, 0, 'row stays pending');
});

test('catalog_return finds the ledger row by its own id, marks it returned and credits the office', async () => {
  const ledger = [{ rowIndex: 4, ledger_id: 'L1', design: '9006', catalog_size: 'Big', warehouse: 'Lagos', quantity: 2, action: 'loan', recipient_type: 'marketer', recipient_name: 'Musa', status: 'active' }];
  const calls = arm({ action: 'catalog_return', recipientType: 'marketer', recipientName: 'Musa', returnItems: [{ ledgerId: 'L1' }] }, STOCK, ledger);
  const res = await inventoryService.executeApprovedAction('R-CAT-1', '777', {});
  assert.equal(res.ok, true, res.message);
  assert.equal(calls.markReturned.length, 1, 'the ledger row was found');
  assert.equal(calls.markReturned[0][0], 4);
  assert.deepEqual(calls.updateQty[0], [7, 11, 1, 0], 'office 9→11, marketers 2→0');
});
