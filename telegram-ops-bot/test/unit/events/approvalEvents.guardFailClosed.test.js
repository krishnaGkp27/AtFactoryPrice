'use strict';

/**
 * SEC — the dual-admin guards must fail CLOSED.
 *
 * The self-approval refusal used to be sent from INSIDE the guard's own
 * try/catch, immediately before its `return`. So if Telegram failed while
 * showing "you cannot approve your own request" — a transient network error,
 * an expired callback query — the catch swallowed it and execution fell
 * through and APPROVED the request. Same shape on the super-admin guard.
 *
 * These tests drive the real handler with a bot whose answerCallbackQuery
 * always throws, and assert the request is still refused: the toast is a
 * courtesy, never the thing that enforces the rule.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '';
// SUPER_ADMIN_IDS defaults to ADMIN_IDS when unset, which would make 888 a
// super-admin and the restricted-action guard correctly inapplicable. Pin it
// so 888 is a PLAIN admin and the guard is actually under test.
process.env.SUPER_ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');

const approvalEvents = require('../../../src/events/approvalEvents');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const inventoryService = require('../../../src/services/inventoryService');

const REQUESTER_ADMIN = '777';

let item;
approvalQueueRepository.getByRequestId = async () => item;

let executeCalls = [];
inventoryService.executeApprovedAction = async (requestId, adminId) => {
  executeCalls.push({ requestId, adminId });
  return { ok: true };
};

/** A bot whose every outbound call rejects, simulating a Telegram outage. */
function createBrokenBot() {
  const fail = async () => { throw new Error('ETELEGRAM: 400 Bad Request: query is too old'); };
  return {
    answerCallbackQuery: fail,
    sendMessage: fail,
    editMessageText: fail,
    editMessageReplyMarkup: fail,
    editMessageCaption: fail,
  };
}

function cbq(fromId) {
  return {
    id: 'cbq-broken',
    data: 'approve:REQ-FC',
    from: { id: fromId },
    message: { chat: { id: fromId }, message_id: 7 },
  };
}

test('self-approval is still refused when the refusal toast fails to send', async () => {
  executeCalls = [];
  item = {
    requestId: 'REQ-FC',
    user: REQUESTER_ADMIN,
    actionJSON: { action: 'add_contact', name: 'ACME' },
    status: 'pending',
  };

  await approvalEvents.handleApprovalCallback(createBrokenBot(), cbq(Number(REQUESTER_ADMIN)), 'approve');

  assert.equal(executeCalls.length, 0,
    'a failed refusal message must NOT let an admin approve their own request');
});

test('a restricted action is still refused when the super-admin alert fails to send', async () => {
  executeCalls = [];
  // Requested by someone else, so the self-approval guard does not apply —
  // this exercises the SUPER_ADMIN_APPROVAL_ACTIONS guard on its own.
  item = {
    requestId: 'REQ-FC',
    user: '999',
    actionJSON: { action: 'promote_admin', target: '555' },
    status: 'pending',
  };

  const riskMod = require('../../../src/risk/evaluate');
  if (!Array.isArray(riskMod.SUPER_ADMIN_APPROVAL_ACTIONS)
      || !riskMod.SUPER_ADMIN_APPROVAL_ACTIONS.includes('promote_admin')) {
    // The guard only applies to actions on that list; if the policy ever
    // changes, this test should be revisited rather than silently passing.
    assert.fail('promote_admin is expected to be a SUPER_ADMIN_APPROVAL_ACTION');
  }

  // '888' is a plain admin (ADMIN_IDS) and not in SUPER_ADMIN_IDS.
  await approvalEvents.handleApprovalCallback(createBrokenBot(), cbq(888), 'approve');

  assert.equal(executeCalls.length, 0,
    'a failed super-admin alert must NOT let a restricted action execute');
});
