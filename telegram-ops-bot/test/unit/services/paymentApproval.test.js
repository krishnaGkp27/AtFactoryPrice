'use strict';

/**
 * PAY-1 — what the SECOND admin's signature actually does.
 *
 * Two doors, and the difference between them is the whole design:
 *   register_payment_account → the account becomes payable. Nothing has
 *      moved; a destination has been authorised.
 *   request_payment → the payment becomes PAYABLE, not paid. It goes to
 *      the finance head's hands; the money leaves the bank only when a
 *      human transfers it and marks it done.
 *
 * Pinned: both are idempotent (a double-approve must not double-anything),
 * both fail loudly when their row is missing rather than reporting a
 * success that did not happen, and approving a payment is never mistaken
 * for paying it.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_IDS = '777,888';

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

installFakeSheets(createFakeSheets({}));
const accountsRepo = require(path.join(SRC, 'repositories/paymentAccountsRepository'));
const requestsRepo = require(path.join(SRC, 'repositories/paymentRequestsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const inventoryService = require(path.join(SRC, 'services/inventoryService'));
const riskEvaluate = require(path.join(SRC, 'risk/evaluate'));

auditLogRepository.append = async () => {};
approvalQueueRepository.updateStatus = async () => true;
approvalQueueRepository.setStatus = async () => true;

/** Reach the executor the way approvalEvents does: by request id. */
async function execute(action, requestId, aj = {}) {
  approvalQueueRepository.getAllPending = async () => ([{
    requestId, user: '7430648262', status: 'pending',
    actionJSON: { action, ...aj },
  }]);
  return inventoryService.executeApprovedAction(requestId, 'Ajeet ‖ John');
}

test('PAY-1: both money actions are ALWAYS dual-admin, whatever the amount', () => {
  // This test used to assert ALWAYS membership only, and its name did the
  // rest — which is how the gap survived a shipped feature: both actions
  // were ALWAYS-gated but absent from DUAL_ADMIN_ACTIONS, so a SINGLE
  // admin tap registered a payee account or released a payment. Assert the
  // number of taps, not the list membership that is supposed to cause it.
  for (const action of ['register_payment_account', 'request_payment']) {
    assert.ok(riskEvaluate.ALWAYS_APPROVAL_ACTIONS.includes(action), `${action} ALWAYS-gated`);
    assert.ok(riskEvaluate.DUAL_ADMIN_ACTIONS.includes(action), `${action} dual-admin`);
    // An employee raises it → two DISTINCT admins must tap.
    assert.equal(
      riskEvaluate.requiredAdminApprovals({ action, requesterIsAdmin: false, adminCount: 3 }), 2,
      `${action}: an employee request needs two admin taps`);
    // An admin raises it → they count as the first signature, so one OTHER
    // admin approves (self-approval is blocked by the SEC-P1 guard).
    assert.equal(
      riskEvaluate.requiredAdminApprovals({ action, requesterIsAdmin: true, adminCount: 3 }), 1,
      `${action}: an admin requester still needs a second pair of eyes`);
  }
});

test('PAY-1: approving a registration makes the account payable', async () => {
  const rows = [{ account_id: 'PAC-1', owner_name: 'Abdul', bank: 'GTBank', account_number: '0123456789', status: 'pending' }];
  const writes = [];
  accountsRepo.findByApprovalRequestId = async () => rows[0];
  accountsRepo.setStatus = async (id, status, by) => { writes.push({ id, status, by }); rows[0].status = status; return rows[0]; };

  const res = await execute('register_payment_account', 'R1');
  assert.equal(res.ok !== false, true);
  assert.deepEqual(writes, [{ id: 'PAC-1', status: 'active', by: 'Ajeet ‖ John' }]);
  assert.match(res.message || '', /Account registered for \*Abdul\*/);
  assert.match(res.message || '', /Payments may now be raised against it/);
});

test('PAY-1: re-approving a registration changes nothing', async () => {
  const row = { account_id: 'PAC-1', owner_name: 'Abdul', bank: 'GTBank', account_number: '1', status: 'active' };
  let wrote = false;
  accountsRepo.findByApprovalRequestId = async () => row;
  accountsRepo.setStatus = async () => { wrote = true; };
  const res = await execute('register_payment_account', 'R1');
  assert.equal(wrote, false);
  assert.match(res.message || '', /already active/);
});

test('PAY-1: a missing account row fails loudly, never silently "succeeds"', async () => {
  accountsRepo.findByApprovalRequestId = async () => null;
  const res = await execute('register_payment_account', 'R-GONE');
  assert.equal(res.ok, false);
  assert.match(res.message, /Payment account row not found/);
});

test('PAY-1: approving a payment AUTHORISES it — it does not pay it', async () => {
  const row = {
    payment_id: 'PAY-1', payee_name: 'Abdul', amount_ngn: 45000, status: 'pending_approval',
  };
  const patches = [];
  requestsRepo.findByApprovalRequestId = async () => row;
  requestsRepo.update = async (id, patch) => { patches.push({ id, patch }); Object.assign(row, patch); return row; };

  const res = await execute('request_payment', 'R2', { payment_id: 'PAY-1' });
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].patch, { status: 'approved', approved_by: 'Ajeet ‖ John' });
  assert.equal(row.status, 'approved', 'approved — NOT done');
  assert.ok(!row.done_by, 'nobody has moved money yet');
  assert.match(res.message || '', /now with finance to pay/,
    'the message says what still has to happen');
});

test('PAY-1: a payment already past approval is not re-approved', async () => {
  const row = { payment_id: 'PAY-1', payee_name: 'A', amount_ngn: 1, status: 'done' };
  let wrote = false;
  requestsRepo.findByApprovalRequestId = async () => row;
  requestsRepo.update = async () => { wrote = true; };
  const res = await execute('request_payment', 'R2', { payment_id: 'PAY-1' });
  assert.equal(wrote, false, 'a paid payment must never be reopened by a late approval');
  assert.match(res.message || '', /already done/);
});

test('PAY-1: a missing payment row fails loudly too', async () => {
  requestsRepo.findByApprovalRequestId = async () => null;
  const res = await execute('request_payment', 'R-GONE', { payment_id: 'NOPE' });
  assert.equal(res.ok, false);
  assert.match(res.message, /Payment request row not found/);
});
