'use strict';

/**
 * Stale-ack hardening (live incident 14-Jul-2026): taps that arrive while
 * the bot is redeploying get redelivered by Telegram with EXPIRED callback
 * ids — answerCallbackQuery throws "query is too old". The tap is still a
 * valid admin decision:
 *   - non-dual approvals must STILL EXECUTE;
 *   - DUAL-1 first signoffs must STILL RECORD AND RETURN (never fall
 *     through to single-approval execution because a DM failed).
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

let item;
approvalQueueRepository.getByRequestId = async () => item;
let patches = [];
approvalQueueRepository.updateActionJSON = async (requestId, patch) => {
  patches.push(patch);
  item.actionJSON = { ...item.actionJSON, ...patch };
  return true;
};
auditLogRepository.append = async () => {};
let executeCalls = [];
inventoryService.executeApprovedAction = async (requestId, adminId) => {
  executeCalls.push({ requestId, adminId });
  return { ok: true };
};

function staleBot() {
  const bot = createFakeBot();
  bot.answerCallbackQuery = async () => { throw new Error('ETELEGRAM: 400 Bad Request: query is too old and response timeout expired or query ID is invalid'); };
  bot.editMessageReplyMarkup = async () => { throw new Error('ETELEGRAM: 400 Bad Request: message to edit not found'); };
  return bot;
}

const cbq = { id: 'x', data: 'approve:REQ7', from: { id: 888 }, message: { chat: { id: 1 }, message_id: 2 } };

test('stale ack: non-dual approval still executes', async () => {
  item = { requestId: 'REQ7', user: '555', actionJSON: { action: 'add_contact' }, status: 'pending', createdAt: new Date().toISOString() };
  executeCalls = []; patches = [];
  await approvalEvents.handleApprovalCallback(staleBot(), cbq, 'approve');
  assert.equal(executeCalls.length, 1, 'approval must execute despite stale ack');
});

test('stale ack: DUAL first signoff records and does NOT execute', async () => {
  item = { requestId: 'REQ7', user: '555', actionJSON: { action: 'receive_goods' }, status: 'pending', createdAt: new Date().toISOString() };
  executeCalls = []; patches = [];
  await approvalEvents.handleApprovalCallback(staleBot(), cbq, 'approve');
  assert.equal(executeCalls.length, 0, 'one signoff must never execute a dual action');
  assert.equal(patches.length, 1, 'signoff must still be recorded');
  assert.deepEqual(patches[0].approvals, ['888']);
});

test('stale ack: rejection still processes', async () => {
  item = { requestId: 'REQ7', user: '555', actionJSON: { action: 'add_contact' }, status: 'pending', createdAt: new Date().toISOString() };
  const bot = staleBot();
  let rejected = null;
  inventoryService.rejectApproval = async (requestId) => { rejected = requestId; return { ok: true }; };
  await approvalEvents.handleApprovalCallback(bot, cbq, 'reject');
  assert.equal(rejected, 'REQ7', 'rejection must persist despite stale ack');
});
