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

// PAY-ID (owner hard rule, 23-Aug-2026) — an employee account only becomes
// payable when its linked Telegram ID is an ACTIVE Users-sheet employee, so
// these fixtures carry the identity a real row carries.
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
// PAY-2 — the two admins, so the pair stamp resolves NAMES, never ids.
const USERS = {
  4242: { user_id: '4242', name: 'Abdul', status: 'active' },
  777: { user_id: '777', name: 'Ajeet', status: 'active', role: 'admin' },
  888: { user_id: '888', name: 'John', status: 'active', role: 'admin' },
};
usersRepository.findByUserId = async (id) => USERS[String(id)] || null;

// PAY-2 §1 — the Postgres trail, stubbed: what the executor records.
const paymentEventsRepo = require(path.join(SRC, 'repositories/paymentEventsRepository'));
let events = [];
paymentEventsRepo.record = async (args) => { events.push(args); return events.length; };

test('PAY-1: approving a registration makes the account payable', async () => {
  const rows = [{ account_id: 'PAC-1', owner_name: 'Abdul', owner_type: 'employee', owner_telegram_id: '4242', bank: 'GTBank', account_number: '0123456789', status: 'pending' }];
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
  const row = { account_id: 'PAC-1', owner_name: 'Abdul', owner_type: 'employee', owner_telegram_id: '4242', bank: 'GTBank', account_number: '1', status: 'active' };
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
  events = [];
  requestsRepo.findByApprovalRequestId = async () => row;
  requestsRepo.update = async (id, patch) => { patches.push({ id, patch }); Object.assign(row, patch); return row; };

  // PAY-2 §2 C — Ajeet signed first (parked on the payload); John decides.
  approvalQueueRepository.getAllPending = async () => ([{
    requestId: 'R2', user: '4242', status: 'pending',
    actionJSON: { action: 'request_payment', payment_id: 'PAY-1', approvals: ['777'] },
  }]);
  const res = await inventoryService.executeApprovedAction('R2', '888');
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].patch, { status: 'approved', approved_by: 'Ajeet ‖ John' },
    'approved_by stores the PAIR, names not ids, ‖-joined as column L promises');
  assert.equal(row.status, 'approved', 'approved — NOT done');
  assert.ok(!row.done_by, 'nobody has moved money yet');
  const line = '✅ Payment of ₦45,000 to Abdul approved by Ajeet ‖ John — now with finance to pay.';
  assert.equal(res.message, line, 'the message says who approved and what still has to happen');
  assert.equal(res.note, line, 'and rides back as `note` for approvalEvents to deliver on both sides');
  assert.ok(!/\*/.test(res.note), 'plain text — it is appended to plain-text replies');
  // The trail row: after the sheet write, carrying ids AND the label.
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'approved');
  assert.equal(events[0].paymentId, 'PAY-1');
  assert.equal(events[0].approvalRequestId, 'R2');
  assert.equal(events[0].actorId, '888');
  assert.deepEqual(events[0].detail, { approverIds: ['777', '888'], approverLabel: 'Ajeet ‖ John' });
});

// Owner ruling 10-Sep-2026: the sheet row is the complete record of an
// approved request. A row raised before column S existed gets its reason
// backfilled from the queue payload in the approval write; a row that
// already carries one is left as raised.
test('PAY-2/S: approval backfills a BLANK reason cell from the payload — in the same write', async () => {
  const row = { payment_id: 'PAY-5', payee_name: 'Abdul', amount_ngn: 4000, status: 'pending_approval', reason: '' };
  const patches = [];
  events = [];
  requestsRepo.findByApprovalRequestId = async () => row;
  requestsRepo.update = async (id, patch) => { patches.push({ id, patch }); Object.assign(row, patch); return row; };
  approvalQueueRepository.getAllPending = async () => ([{
    requestId: 'R5', user: '4242', status: 'pending',
    actionJSON: { action: 'request_payment', payment_id: 'PAY-5', approvals: ['777'], reason: 'Transport to Idumota' },
  }]);
  const res = await inventoryService.executeApprovedAction('R5', '888');
  assert.equal(res.ok, true);
  assert.equal(patches.length, 1, 'ONE write — the backfill rides the approval patch');
  assert.deepEqual(patches[0].patch, { status: 'approved', approved_by: 'Ajeet ‖ John', reason: 'Transport to Idumota' });
  assert.equal(row.reason, 'Transport to Idumota');
});

test('PAY-2/S: a row that already carries its reason is not rewritten at approval', async () => {
  const row = { payment_id: 'PAY-6', payee_name: 'Abdul', amount_ngn: 4000, status: 'pending_approval', reason: 'As raised' };
  const patches = [];
  events = [];
  requestsRepo.findByApprovalRequestId = async () => row;
  requestsRepo.update = async (id, patch) => { patches.push({ id, patch }); Object.assign(row, patch); return row; };
  approvalQueueRepository.getAllPending = async () => ([{
    requestId: 'R6', user: '4242', status: 'pending',
    actionJSON: { action: 'request_payment', payment_id: 'PAY-6', approvals: ['777'], reason: 'Payload says otherwise' },
  }]);
  await inventoryService.executeApprovedAction('R6', '888');
  assert.equal(patches.length, 1);
  assert.ok(!('reason' in patches[0].patch), 'no reason in the patch — the raise-time cell stands');
  assert.equal(row.reason, 'As raised');

  // And a payload with no reason (pre-PAY-2 request) backfills nothing.
  const bare = { payment_id: 'PAY-7', payee_name: 'Abdul', amount_ngn: 4000, status: 'pending_approval', reason: '' };
  patches.length = 0;
  requestsRepo.findByApprovalRequestId = async () => bare;
  approvalQueueRepository.getAllPending = async () => ([{
    requestId: 'R7', user: '4242', status: 'pending',
    actionJSON: { action: 'request_payment', payment_id: 'PAY-7', approvals: ['777'] },
  }]);
  await inventoryService.executeApprovedAction('R7', '888');
  assert.deepEqual(patches[0].patch, { status: 'approved', approved_by: 'Ajeet ‖ John' }, 'nothing to backfill from');
});

test('PAY-2: a failing trail write never costs the approval (fail-open)', async () => {
  const row = { payment_id: 'PAY-2', payee_name: 'Abdul', amount_ngn: 4000, status: 'pending_approval' };
  requestsRepo.findByApprovalRequestId = async () => row;
  requestsRepo.update = async (id, patch) => { Object.assign(row, patch); return row; };
  const orig = paymentEventsRepo.record;
  paymentEventsRepo.record = async () => { throw new Error('pg down'); };
  try {
    const res = await execute('request_payment', 'R2b', { payment_id: 'PAY-2' });
    assert.notEqual(res.ok, false);
    assert.equal(row.status, 'approved');
    assert.match(res.note || '', /now with finance to pay/);
  } finally { paymentEventsRepo.record = orig; }
});

test('PAY-2: `note` is null for every other action', async () => {
  accountsRepo.findByApprovalRequestId = async () => ({
    account_id: 'PAC-N', owner_name: 'Abdul', owner_type: 'employee', owner_telegram_id: '4242',
    bank: 'GTBank', account_number: '0123456789', status: 'pending',
  });
  accountsRepo.setStatus = async () => {};
  const res = await execute('register_payment_account', 'R-N');
  assert.notEqual(res.ok, false);
  assert.equal(res.note, null);
});

// PAY-2 §2 F — an admin's Reject flips the PaymentRequests row too, so
// 📋 My requests stops saying "waiting for approval".
async function reject(requestId, aj, rejectedBy = '777') {
  approvalQueueRepository.getAllPending = async () => ([{
    requestId, user: '4242', status: 'pending', actionJSON: { action: 'request_payment', ...aj },
  }]);
  return inventoryService.rejectApproval(requestId, rejectedBy);
}

test('PAY-2: rejecting a payment request flips its row to rejected and logs who', async () => {
  const row = { payment_id: 'PAY-3', payee_name: 'Abdul', amount_ngn: 4000, status: 'pending_approval' };
  const patches = [];
  events = [];
  requestsRepo.findByApprovalRequestId = async (id) => (id === 'R3' ? row : null);
  requestsRepo.update = async (id, patch) => { patches.push({ id, patch }); Object.assign(row, patch); return row; };
  const res = await reject('R3', { payment_id: 'PAY-3' });
  assert.equal(res.ok, true);
  assert.deepEqual(patches, [{ id: 'PAY-3', patch: { status: 'rejected', decline_reason: '' } }],
    'the standard reject prompt asks no reason, so the column stays blank');
  assert.ok(requestsRepo.STATUSES.includes('rejected'), 'the repository knows the status');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'rejected');
  assert.equal(events[0].paymentId, 'PAY-3');
  assert.equal(events[0].actorId, '777');
  assert.equal(events[0].actorName, 'Ajeet', 'the rejecting admin, by name');
});

test('PAY-2: a reject never reopens a payment that is past approval', async () => {
  const row = { payment_id: 'PAY-4', payee_name: 'Abdul', amount_ngn: 4000, status: 'done' };
  let wrote = false;
  requestsRepo.findByApprovalRequestId = async () => row;
  requestsRepo.update = async () => { wrote = true; };
  const res = await reject('R4', { payment_id: 'PAY-4' });
  assert.equal(res.ok, true, 'the queue row is still rejected');
  assert.equal(wrote, false, 'a paid payment is not rewritten by a late reject');
});

test('PAY-2: a failing PaymentRequests write does not block the reject itself', async () => {
  requestsRepo.findByApprovalRequestId = async () => { throw new Error('sheet down'); };
  const res = await reject('R5', { payment_id: 'PAY-5' });
  assert.equal(res.ok, true);
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

test('PAY-ID: an employee account with NO linked Telegram ID is refused at approval', async () => {
  // The exact shape of the owner's OPAY card: a typed name, no identity.
  accountsRepo.findByApprovalRequestId = async () => ({
    account_id: 'PAC-9', owner_name: 'Muhammad', owner_type: 'employee',
    owner_telegram_id: '', bank: 'OPAY', account_number: '7044196792', status: 'pending',
  });
  let wrote = false;
  accountsRepo.setStatus = async () => { wrote = true; };
  const res = await execute('register_payment_account', 'R-NOID');
  assert.equal(res.ok, false, 'money is never registered against an unverified name');
  assert.match(res.message, /Not registered/);
  assert.equal(wrote, false);
});

test('PAY-ID: a CONTRACTOR account still registers — an admin vouches for it', async () => {
  const writes = [];
  accountsRepo.findByApprovalRequestId = async () => ({
    account_id: 'PAC-C', owner_name: 'Musa Welder', owner_type: 'contractor',
    owner_telegram_id: '', bank: 'GTB', account_number: '0123456789', status: 'pending',
  });
  accountsRepo.setStatus = async (id, status) => { writes.push([id, status]); };
  const res = await execute('register_payment_account', 'R-CON');
  assert.notEqual(res.ok, false, 'contractors have no Telegram identity by design');
  assert.deepEqual(writes, [['PAC-C', 'active']]);
});
