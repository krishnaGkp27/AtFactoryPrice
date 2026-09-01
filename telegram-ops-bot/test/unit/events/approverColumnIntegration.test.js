'use strict';

/**
 * APR-1 end-to-end: a completed DUAL approval must land BOTH signatures in
 * the ApprovalQueue's Approver column.
 *
 * This is the failure the owner asked to fix, and it is easy to reproduce in
 * a new column: the first tap is written to ActionJSON.approvals, but the
 * FINAL tap never was — control leaves the bookkeeping branch the moment the
 * requirement is satisfied. A column filled only where `approvals` is written
 * would show admin #1 and silently lose admin #2.
 */

process.env.ADMIN_IDS = '777,888,999';
process.env.EMPLOYEE_IDS = '555';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// The executor reaches real sheets, so the fake must be installed before the
// require chain loads sheetsClient.
const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));

const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const inventoryService = require(path.join(SRC, 'services/inventoryService'));

// Names, not raw Telegram ids (LBL-1).
usersRepository.findByUserId = async (id) => ({
  777: { user_id: '777', name: 'Emin' },
  888: { user_id: '888', name: 'Boss' },
  555: { user_id: '555', name: 'Abdul' },
}[String(id)] || null);

let stamped = [];
approvalQueueRepository.updateStatus = async (requestId, status, resolvedAt, approver) => {
  stamped.push({ requestId, status, approver });
  return true;
};
auditLogRepository.append = async () => {};

test('a dual approval stamps BOTH admins into the Approver column', async () => {
  stamped = [];
  // The row as it stands at the final tap: admin 777 already signed.
  approvalQueueRepository.getAllPending = async () => ([{
    requestId: 'REQ-D', user: '555', status: 'pending',
    actionJSON: { action: 'set_unit_display', approvals: ['777'], warehouse: 'Kano office', mode: 'thans' },
  }]);
  // 888 gives the deciding signature.
  await inventoryService.executeApprovedAction('REQ-D', '888');

  const row = stamped.find((s) => s.requestId === 'REQ-D');
  assert.ok(row, 'the request was resolved');
  assert.equal(row.status, 'approved');
  assert.equal(row.approver, 'Emin + Boss',
    'the parked first signature and the deciding tap are both named');
});

test('a single-admin approval names the one admin who released it', async () => {
  stamped = [];
  approvalQueueRepository.getAllPending = async () => ([{
    requestId: 'REQ-S', user: '555', status: 'pending',
    actionJSON: { action: 'set_unit_display', warehouse: 'Kano office', mode: 'thans' },
  }]);
  await inventoryService.executeApprovedAction('REQ-S', '777');
  assert.equal(stamped.find((s) => s.requestId === 'REQ-S').approver, 'Emin');
});

test('a rejection records who rejected it', async () => {
  stamped = [];
  approvalQueueRepository.getAllPending = async () => ([{
    requestId: 'REQ-R', user: '555', status: 'pending',
    actionJSON: { action: 'set_unit_display', warehouse: 'Kano office', mode: 'thans' },
  }]);
  await inventoryService.rejectApproval('REQ-R', '888');
  const row = stamped.find((s) => s.requestId === 'REQ-R');
  assert.equal(row.status, 'rejected');
  assert.equal(row.approver, 'Boss', 'a refusal is a decision, and it names its decider');
});
