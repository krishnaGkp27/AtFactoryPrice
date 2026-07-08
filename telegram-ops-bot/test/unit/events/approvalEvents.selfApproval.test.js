'use strict';

/**
 * SEC-P1 (H1): an admin must not approve their OWN queued request when a
 * second admin exists to review it. This pins the dual-admin gate at the
 * EXECUTION boundary (previously the requester was only excluded from the
 * notification, so a forged `approve:<id>` still went through).
 *
 * Env is seeded with TWO admins before the require chain loads config/auth,
 * so a second reviewer always exists in these cases.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const approvalEvents = require('../../../src/events/approvalEvents');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const inventoryService = require('../../../src/services/inventoryService');

const REQUESTER_ADMIN = '777';
const OTHER_ADMIN = '888';

const item = {
  requestId: 'REQ1',
  user: REQUESTER_ADMIN,
  actionJSON: { action: 'add_contact', name: 'ACME' },
  status: 'pending',
};

// Offline stubs on the singletons approvalEvents holds references to.
approvalQueueRepository.getByRequestId = async () => item;

let executeCalls = [];
inventoryService.executeApprovedAction = async (requestId, adminId) => {
  executeCalls.push({ requestId, adminId });
  return { ok: true };
};

function cbq(fromId) {
  return {
    id: 'cbq-1',
    data: 'approve:REQ1',
    from: { id: fromId },
    message: { chat: { id: fromId }, message_id: 7 },
  };
}

test('H1: the requesting admin cannot approve their own request', async () => {
  executeCalls = [];
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq(Number(REQUESTER_ADMIN)), 'approve');

  const acks = bot.callsTo('answerCallbackQuery');
  assert.ok(acks.some((a) => /cannot approve your own request/i.test(a.args.opts?.text || '')),
    'expected a self-approval rejection alert');
  assert.equal(executeCalls.length, 0, 'executeApprovedAction must NOT run for self-approval');
});

test('H1: a DIFFERENT admin can still approve the request (gate is not over-broad)', async () => {
  executeCalls = [];
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq(Number(OTHER_ADMIN)), 'approve');

  assert.equal(executeCalls.length, 1, 'a second admin approving should execute the action');
  assert.equal(executeCalls[0].adminId, OTHER_ADMIN);
  const acks = bot.callsTo('answerCallbackQuery');
  assert.ok(!acks.some((a) => /cannot approve your own request/i.test(a.args.opts?.text || '')),
    'a non-self approval must not be blocked');
});
