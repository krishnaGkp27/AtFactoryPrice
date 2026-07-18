'use strict';

/**
 * APU-1 Phase 3 — broken-path fixes in the approval pipeline:
 *  3.1 flows queue 'new_customer' (the executable action), approve
 *      activates the Pending customer row, reject flips it to Rejected.
 *  3.2 srf_acc: only accepts a pending supply_request at stage
 *      'dispatch_acceptance', tapped by the assigned dispatch person —
 *      it can no longer flip arbitrary queue rows to approved.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242,5555';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `U${id}` });
auditLogRepository.append = async () => {};

let queueRow = null;
const statusUpdates = [];
const ajUpdates = [];
const customerUpdates = [];
approvalQueueRepository.getByRequestId = async (id) => (queueRow && queueRow.requestId === id ? queueRow : null);
approvalQueueRepository.getAllPending = async () => (queueRow ? [queueRow] : []);
approvalQueueRepository.updateStatus = async (id, status, ts) => { statusUpdates.push({ id, status, ts }); };
approvalQueueRepository.updateActionJSON = async (id, patch) => { ajUpdates.push({ id, patch }); };
customersRepository.updateRow = async (custId, patch) => { customerUpdates.push({ custId, patch }); };

function cb(data, uid) {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 42 } };
}

test('3.1 approve on a flow-queued new_customer activates the Pending row', async () => {
  const bot = createFakeBot();
  queueRow = {
    requestId: 'REQ-NC-1', user: '4242', status: 'pending',
    actionJSON: { action: 'new_customer', customer_id: 'C-XYZ', customer_name: 'OKESON', phone: '0803', requesterUserId: '4242', from: 'sample_flow' },
  };
  await controller.handleCallbackQuery(bot, cb('approve:REQ-NC-1', '777'));
  assert.deepEqual(customerUpdates.at(-1), { custId: 'C-XYZ', patch: { status: 'Active' } }, 'customer activated');
  assert.ok(statusUpdates.some((u) => u.id === 'REQ-NC-1' && u.status === 'approved'), 'queue row approved');
  assert.match(bot.allText(), /approved and activated/);
});

test('3.1 reject flips the eagerly-written Pending customer row to Rejected', async () => {
  const bot = createFakeBot();
  queueRow = {
    requestId: 'REQ-NC-2', user: '4242', status: 'pending',
    actionJSON: { action: 'new_customer', customer_id: 'C-ABC', customer_name: 'CJE', phone: '', requesterUserId: '4242', from: 'order_flow' },
  };
  await controller.handleCallbackQuery(bot, cb('reject:REQ-NC-2', '777'));
  assert.deepEqual(customerUpdates.at(-1), { custId: 'C-ABC', patch: { status: 'Rejected' } }, 'no orphaned Pending row');
  assert.ok(statusUpdates.some((u) => u.id === 'REQ-NC-2' && u.status === 'rejected'));
});

test('3.2 srf_acc cannot flip a non-supply row, wrong stage, or wrong tapper', async () => {
  const bot = createFakeBot();
  statusUpdates.length = 0;

  // (a) not a supply_request
  queueRow = { requestId: 'REQ-S1', user: '4242', status: 'pending', actionJSON: { action: 'sale_bundle' } };
  await controller.handleCallbackQuery(bot, cb('srf_acc:REQ-S1', '5555'));
  // (b) supply_request but not at dispatch_acceptance
  queueRow = { requestId: 'REQ-S2', user: '4242', status: 'pending', actionJSON: { action: 'supply_request', stage: 'admin_review' } };
  await controller.handleCallbackQuery(bot, cb('srf_acc:REQ-S2', '5555'));
  // (c) right stage, wrong tapper
  queueRow = {
    requestId: 'REQ-S3', user: '4242', status: 'pending',
    actionJSON: { action: 'supply_request', stage: 'dispatch_acceptance', assignedDispatch: { user_id: '5555', name: 'U5555' } },
  };
  await controller.handleCallbackQuery(bot, cb('srf_acc:REQ-S3', '4242'));

  assert.equal(statusUpdates.length, 0, 'no status flip happened in any invalid case');
});

test('review: stale reject cannot corrupt an already-decided new_customer', async () => {
  const bot = createFakeBot();
  customerUpdates.length = 0;
  statusUpdates.length = 0;
  queueRow = {
    requestId: 'REQ-NC-3', user: '4242', status: 'approved',
    actionJSON: { action: 'new_customer', customer_id: 'C-LIVE', customer_name: 'OKESON', requesterUserId: '4242' },
  };
  await controller.handleCallbackQuery(bot, cb('reject:REQ-NC-3', '888'));
  assert.equal(customerUpdates.length, 0, 'live customer NOT flipped to Rejected');
  assert.equal(statusUpdates.length, 0, 'queue row NOT re-decided');
  assert.match(bot.allText(), /already approved — no change made/);
});

test('review: srf_dec is validated like srf_acc — forged declines are inert', async () => {
  const bot = createFakeBot();
  ajUpdates.length = 0;
  // A pending sale_bundle must not be routable through the decline path.
  queueRow = { requestId: 'REQ-S5', user: '4242', status: 'pending', actionJSON: { action: 'sale_bundle', customer: 'CJE' } };
  await controller.handleCallbackQuery(bot, cb('srf_dec:REQ-S5', '5555'));
  // Wrong tapper on a real assignment is also blocked.
  queueRow = {
    requestId: 'REQ-S6', user: '4242', status: 'pending',
    actionJSON: { action: 'supply_request', stage: 'dispatch_acceptance', assignedDispatch: { user_id: '5555' } },
  };
  await controller.handleCallbackQuery(bot, cb('srf_dec:REQ-S6', '4242'));
  assert.equal(ajUpdates.length, 0, 'no actionJSON mutations from invalid declines');
  const alerts = bot.calls.filter((c) => c.method === 'answerCallbackQuery' && c.args.opts && c.args.opts.show_alert);
  assert.ok(alerts.length >= 2, 'both invalid declines got blocking alerts');
});

test('3.5 receipts: rejected receipts cannot be approved; self-decisions blocked; audit written', async () => {
  const receiptsRepo = require(path.join(SRC, 'repositories/receiptsRepository'));
  const rcStatusUpdates = [];
  const audits = [];
  auditLogRepository.append = async (event, payload, uid) => { audits.push({ event, payload, uid }); };
  let receipt = null;
  receiptsRepo.getById = async () => receipt;
  receiptsRepo.updateStatus = async (id, status) => { rcStatusUpdates.push({ id, status }); };
  receiptsRepo.updateDriveInfo = async () => { throw new Error('should not reach drive upload in these guard tests'); };

  const bot = createFakeBot();
  // (a) rejected → approve blocked
  receipt = { receipt_id: 'R-1', status: 'rejected', customer: 'OKESON', amount: 5000, uploaded_by_id: '4242', uploaded_by_name: 'U4242' };
  await controller.handleCallbackQuery(bot, cb('rcapr:R-1', '777'));
  assert.match(bot.allText(), /already REJECTED/);
  // (b) admin's own upload → approve blocked while another admin exists
  receipt = { receipt_id: 'R-2', status: 'pending', customer: 'CJE', amount: 100, uploaded_by_id: '777', uploaded_by_name: 'U777' };
  await controller.handleCallbackQuery(bot, cb('rcapr:R-2', '777'));
  assert.match(bot.allText(), /different admin must approve/);
  // (c) already-approved receipt cannot be re-rejected
  receipt = { receipt_id: 'R-3', status: 'approved', customer: 'CJE', amount: 100, uploaded_by_id: '4242' };
  await controller.handleCallbackQuery(bot, cb('rcrej:R-3', '777'));
  assert.match(bot.allText(), /already approved — no change made/);
  assert.equal(rcStatusUpdates.length, 0, 'no status writes in any blocked case');
  // (d) legit reject works and is audited
  receipt = { receipt_id: 'R-4', status: 'pending', customer: 'CJE', amount: 100, uploaded_by_id: '4242' };
  await controller.handleCallbackQuery(bot, cb('rcrej:R-4', '777'));
  assert.deepEqual(rcStatusUpdates.at(-1), { id: 'R-4', status: 'rejected' });
  assert.ok(audits.some((a) => a.event === 'receipt_rejected' && a.uid === '777'), 'audit trail written');
  auditLogRepository.append = async () => {};
});

test('3.2 the assigned dispatch person CAN accept at the right stage', async () => {
  const bot = createFakeBot();
  statusUpdates.length = 0;
  queueRow = {
    requestId: 'REQ-S4', user: '4242', status: 'pending',
    actionJSON: { action: 'supply_request', stage: 'dispatch_acceptance', assignedDispatch: { user_id: '5555', name: 'U5555' } },
  };
  await controller.handleCallbackQuery(bot, cb('srf_acc:REQ-S4', '5555'));
  assert.ok(statusUpdates.some((u) => u.id === 'REQ-S4' && u.status === 'approved'), 'legit accept still works');
  assert.ok(ajUpdates.some((u) => u.id === 'REQ-S4' && u.patch.stage === 'completed'));
  assert.match(bot.allText(), /You accepted supply request/);
});
