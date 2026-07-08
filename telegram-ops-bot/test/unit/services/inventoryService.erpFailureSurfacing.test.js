'use strict';

/**
 * H6 — silent ERP hook failures. When a sale's inventory mutation succeeds
 * but the ledger/book hook (accounting, stock ledger, CRM, audit) throws,
 * executeApprovedAction used to swallow it in `catch (_) {}` and report a
 * clean success. It now returns `erpFailures` (and writes an
 * `erp_hook_failed` audit row) so approvalEvents can warn the admin that
 * BOOKS ≠ STOCK.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryService = require('../../../src/services/inventoryService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const crmService = require('../../../src/services/crmService');
const accountingService = require('../../../src/services/accountingService');
const stockLedgerService = require('../../../src/services/stockLedgerService');
const auditService = require('../../../src/services/auditService');

function harness(item) {
  const calls = { statusUpdates: [], audits: [] };
  let resolved = false;
  approvalQueueRepository.getAllPending = async () => (resolved ? [] : [JSON.parse(JSON.stringify(item))]);
  approvalQueueRepository.updateStatus = async (id, status) => {
    calls.statusUpdates.push({ id, status });
    if (status === 'approved' || status === 'rejected') resolved = true;
    return true;
  };
  auditLogRepository.append = async (event) => { calls.audits.push(event); };
  inventoryRepository.markThanSold = async () => ({ packageNo: 'P1', thanNo: '1' });
  inventoryRepository.updatePrice = async () => 1;
  transactionsRepository.append = async () => true;
  return calls;
}

function sellThanItem(requestId) {
  return {
    requestId, user: 'emp1', status: 'pending',
    actionJSON: { action: 'sell_than', packageNo: 'P1', thanNo: '1', design: '44200', shade: 'cream', yards: 50, customer: 'ACME' },
  };
}

test('H6: ledger hook failure is returned, audited, and does NOT block the approval', async () => {
  const calls = harness(sellThanItem('H6A'));
  // crmService is the first call inside the ERP 'sale' handler — make it blow up.
  crmService.findOrCreateCustomer = async () => { throw new Error('Sheets quota exceeded'); };

  const res = await inventoryService.executeApprovedAction('H6A', 'admin1');
  assert.equal(res.ok, true, 'inventory apply still succeeds');
  assert.equal(res.erpFailures.length, 1, 'exactly one surfaced failure');
  assert.match(res.erpFailures[0].stage, /sell_than/);
  assert.match(res.erpFailures[0].error, /quota exceeded/);
  assert.ok(calls.audits.includes('erp_hook_failed'), 'erp_hook_failed audit written');
  assert.ok(calls.audits.includes('approval_approved'), 'approval still marked approved');
  assert.deepEqual(calls.statusUpdates, [{ id: 'H6A', status: 'approved' }]);
});

test('H6: healthy hooks return an empty erpFailures array', async () => {
  const calls = harness(sellThanItem('H6B'));
  crmService.findOrCreateCustomer = async () => ({ name: 'ACME' });
  accountingService.recordSale = async () => true;
  stockLedgerService.recordSaleOut = async () => true;
  auditService.log = async () => true;

  const res = await inventoryService.executeApprovedAction('H6B', 'admin1');
  assert.equal(res.ok, true);
  assert.deepEqual(res.erpFailures, [], 'no failures surfaced');
  assert.ok(!calls.audits.includes('erp_hook_failed'));
});
