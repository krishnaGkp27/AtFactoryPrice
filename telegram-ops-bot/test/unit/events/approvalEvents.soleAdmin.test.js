'use strict';

/**
 * SEC-P1 (H1) — sole-admin escape hatch: when the requester is the ONLY admin
 * in the system, self-approval is permitted (otherwise nothing they raise
 * could ever be approved). Seeded with a single admin so no second reviewer
 * exists.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const approvalEvents = require('../../../src/events/approvalEvents');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const inventoryService = require('../../../src/services/inventoryService');

const SOLE_ADMIN = '777';

const item = {
  requestId: 'REQ9',
  user: SOLE_ADMIN,
  actionJSON: { action: 'add_contact', name: 'ACME' },
  status: 'pending',
};

approvalQueueRepository.getByRequestId = async () => item;

let executeCalls = [];
inventoryService.executeApprovedAction = async (requestId, adminId) => {
  executeCalls.push({ requestId, adminId });
  return { ok: true };
};

test('H1: the only admin may approve their own request', async () => {
  executeCalls = [];
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, {
    id: 'cbq-9',
    data: 'approve:REQ9',
    from: { id: Number(SOLE_ADMIN) },
    message: { chat: { id: Number(SOLE_ADMIN) }, message_id: 3 },
  }, 'approve');

  const acks = bot.callsTo('answerCallbackQuery');
  assert.ok(!acks.some((a) => /cannot approve your own request/i.test(a.args.opts?.text || '')),
    'sole admin must not be blocked from self-approval');
  assert.equal(executeCalls.length, 1, 'sole-admin self-approval should execute');
});
