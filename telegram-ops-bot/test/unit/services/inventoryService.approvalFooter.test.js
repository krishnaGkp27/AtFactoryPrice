'use strict';

/**
 * SEC-P2 (H7): record_office_expense and finalize_landed_cost used to
 * `return { ok: true }` BEFORE the shared footer, leaving the ApprovalQueue
 * row 'pending' (re-approvable) and skipping the approval_approved audit.
 * They now fall through to the footer, so the row is marked approved + audited
 * exactly like every other action.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryService = require('../../../src/services/inventoryService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const branchOpsService = require('../../../src/services/branchOpsService');
const landedCostService = require('../../../src/services/landedCostService');

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
  return calls;
}

test('H7: record_office_expense marks the queue row approved + audits', async () => {
  const item = { requestId: 'OE1', user: 'mgr1', status: 'pending', actionJSON: { action: 'record_office_expense', branch: 'Lagos' } };
  const calls = harness(item);
  branchOpsService.applyExpenseBatch = async () => ({ ok: true, count: 2, branch: 'Lagos', total: 5000 });

  const res = await inventoryService.executeApprovedAction('OE1', 'admin1');
  assert.equal(res.ok, true);
  assert.match(res.message, /Approved 2 item/);
  assert.deepEqual(calls.statusUpdates, [{ id: 'OE1', status: 'approved' }]);
  assert.ok(calls.audits.includes('approval_approved'), 'approval_approved audit written');
});

test('H7: a failed expense apply leaves the row pending (no approved-mark)', async () => {
  const item = { requestId: 'OE2', user: 'mgr1', status: 'pending', actionJSON: { action: 'record_office_expense', branch: 'Lagos' } };
  const calls = harness(item);
  branchOpsService.applyExpenseBatch = async () => ({ ok: false, message: 'boom' });

  const res = await inventoryService.executeApprovedAction('OE2', 'admin1');
  assert.equal(res.ok, false);
  assert.equal(calls.statusUpdates.length, 0, 'row stays pending for retry/reject');
  assert.ok(!calls.audits.includes('approval_approved'));
});

test('H7: finalize_landed_cost marks the queue row approved + audits', async () => {
  const item = { requestId: 'LC1', user: 'admin1', status: 'pending', actionJSON: { action: 'finalize_landed_cost', grn_id: 'GRN1' } };
  const calls = harness(item);
  landedCostService.applyApproved = async () => ({ grnId: 'GRN1', allocation: { ngnLandedPerYard: 12.34 } });

  const res = await inventoryService.executeApprovedAction('LC1', 'admin1');
  assert.equal(res.ok, true);
  assert.match(res.message, /Landed cost finalized/);
  assert.deepEqual(calls.statusUpdates, [{ id: 'LC1', status: 'approved' }]);
  assert.ok(calls.audits.includes('approval_approved'));
});
