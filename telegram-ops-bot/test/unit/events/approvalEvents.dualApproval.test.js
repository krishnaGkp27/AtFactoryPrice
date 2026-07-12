'use strict';

/**
 * DUAL-1 (specs/DUAL-1_TWO_ADMIN_APPROVAL.md): inventory + finance actions
 * must involve TWO admins before execution.
 *
 * Pins the approve-branch gate in approvalEvents.handleApprovalCallback:
 *   - employee request → 1st admin tap records a signoff, does NOT execute;
 *   - the same admin cannot give both signoffs;
 *   - a 2nd distinct admin tap executes;
 *   - an admin requester counts as the 1st admin → one other admin executes
 *     on the first tap;
 *   - non-dual actions keep single-approval behavior.
 *
 * Env seeds THREE admins + one employee before the require chain loads
 * config/auth, so a second reviewer always exists.
 */

process.env.ADMIN_IDS = '777,888,999';
process.env.EMPLOYEE_IDS = '555';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const approvalEvents = require('../../../src/events/approvalEvents');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const inventoryService = require('../../../src/services/inventoryService');

const EMPLOYEE = '555';
const ADMIN_1 = '777';
const ADMIN_2 = '888';

// Mutable per-test queue row; stubs on the singletons approvalEvents holds.
let item;
approvalQueueRepository.getByRequestId = async () => item;

let patches = [];
approvalQueueRepository.updateActionJSON = async (requestId, patch) => {
  patches.push({ requestId, patch });
  item.actionJSON = { ...item.actionJSON, ...patch };
  return true;
};

auditLogRepository.append = async () => {};

let executeCalls = [];
inventoryService.executeApprovedAction = async (requestId, adminId) => {
  executeCalls.push({ requestId, adminId });
  return { ok: true };
};

function makeItem(user, action) {
  return { requestId: 'REQ9', user, actionJSON: { action }, status: 'pending' };
}

function cbq(fromId) {
  return {
    id: 'cbq-9',
    data: 'approve:REQ9',
    from: { id: fromId },
    message: { chat: { id: fromId }, message_id: 3 },
  };
}

function reset(user, action) {
  item = makeItem(user, action);
  patches = [];
  executeCalls = [];
}

test('DUAL-1: 1st admin tap on an employee request records a signoff, does not execute', async () => {
  reset(EMPLOYEE, 'receive_goods');
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq(Number(ADMIN_1)), 'approve');

  assert.equal(executeCalls.length, 0, 'must NOT execute on the first signoff');
  assert.equal(patches.length, 1, 'signoff must be persisted to ActionJSON');
  assert.deepEqual(patches[0].patch.approvals, [ADMIN_1]);
  const acks = bot.callsTo('answerCallbackQuery');
  assert.ok(acks.some((a) => /1 of 2/.test(a.args.opts?.text || '')),
    'expected a "1 of 2 recorded" ack');
});

test('DUAL-1: the same admin cannot give the second signoff', async () => {
  reset(EMPLOYEE, 'receive_goods');
  item.actionJSON.approvals = [ADMIN_1];
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq(Number(ADMIN_1)), 'approve');

  assert.equal(executeCalls.length, 0, 'must NOT execute on a repeat tap');
  assert.equal(patches.length, 0, 'no new signoff may be recorded');
  const acks = bot.callsTo('answerCallbackQuery');
  assert.ok(acks.some((a) => /different admin/i.test(a.args.opts?.text || '')),
    'expected a "different admin must give the second" alert');
});

test('DUAL-1: a second distinct admin executes the request', async () => {
  reset(EMPLOYEE, 'receive_goods');
  item.actionJSON.approvals = [ADMIN_1];
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq(Number(ADMIN_2)), 'approve');

  assert.equal(executeCalls.length, 1, 'second signoff must execute');
  assert.equal(executeCalls[0].adminId, ADMIN_2);
});

test('DUAL-1: an admin requester counts as the 1st admin — one other admin executes', async () => {
  reset(ADMIN_1, 'transfer_than');
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq(Number(ADMIN_2)), 'approve');

  assert.equal(executeCalls.length, 1, 'admin-raised dual action executes on the first OTHER-admin tap');
  assert.equal(patches.length, 0, 'no signoff bookkeeping needed when required = 1');
});

test('DUAL-1: non-dual actions keep single-approval behavior', async () => {
  reset(EMPLOYEE, 'add_contact');
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq(Number(ADMIN_1)), 'approve');

  assert.equal(executeCalls.length, 1, 'non-dual action executes on the first admin tap');
  assert.equal(patches.length, 0);
});
