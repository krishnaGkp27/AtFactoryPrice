'use strict';

/**
 * PAY-2 §2 C + §2 G — the two surgical spots in approvalEvents:
 *
 *   1. the executor's `note` ("approved by Ajeet ‖ John — now with finance
 *      to pay") is appended to the deciding admin's approved reply AND the
 *      requester's notice, next to the RET-3 credit tail, as plain text;
 *   2. a payment request's bill (`bill_file_id` on the queue payload) is
 *      forwarded to the admins with the approval card — photo first,
 *      document when the recorded kind says so — never to the excluded
 *      admin requester, and never for another action's payload.
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
const paymentCards = require('../../../src/services/paymentCards');

const EMPLOYEE = '555';
const ADMIN_2 = '888';
const NOTE = '✅ Payment of ₦4,000 to Abdul approved by Ajeet ‖ John — now with finance to pay.';

let item;
approvalQueueRepository.getByRequestId = async () => item;
approvalQueueRepository.getAllPending = async () => (item ? [item] : []);
approvalQueueRepository.updateActionJSON = async (requestId, patch) => {
  item.actionJSON = { ...item.actionJSON, ...patch };
  return true;
};
auditLogRepository.append = async () => {};

let execResult = { ok: true };
inventoryService.executeApprovedAction = async () => execResult;
let financeCards = [];
paymentCards.sendFinanceCard = async (bot, paymentId, opts) => { financeCards.push({ paymentId, opts }); return { sent: 1, failed: 0 }; };

function cbq(fromId, requestId) {
  return {
    id: 'cbq-p', data: `approve:${requestId}`, from: { id: Number(fromId) },
    message: { chat: { id: Number(fromId) }, message_id: 3 },
  };
}

function textsTo(bot, chatId) {
  return bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === String(chatId))
    .map((c) => c.args.text);
}

test('PAY-2 §2 C: the executor note reaches the deciding admin AND the requester, plain text', async () => {
  // Ajeet (777) signed first; John (888) decides — the executor runs.
  item = { requestId: 'REQ-P', user: EMPLOYEE, status: 'pending', actionJSON: { action: 'request_payment', payment_id: 'PAY-1', approvals: ['777'] } };
  execResult = { ok: true, approver: 'Ajeet + John', note: NOTE };
  financeCards = [];
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq(ADMIN_2, 'REQ-P'), 'approve');

  const admin = textsTo(bot, ADMIN_2);
  const reply = admin.find((t) => /approved by Ajeet \+ John/.test(t));
  assert.ok(reply, `admin got the approved reply, got: ${JSON.stringify(admin)}`);
  assert.ok(reply.endsWith(`\n${NOTE}`), `note appended to the admin reply, got: ${reply}`);
  const employee = textsTo(bot, EMPLOYEE);
  assert.equal(employee.length, 1, 'one notice to the requester');
  assert.ok(employee[0].startsWith('✅ Your request'), employee[0]);
  assert.ok(employee[0].endsWith(`\n${NOTE}`), `note appended to the requester notice, got: ${employee[0]}`);
  // The notice is sent without parse_mode — a payee named a_b or *x* can't break it.
  const sent = bot.calls.find((c) => c.method === 'sendMessage' && String(c.args.chatId) === EMPLOYEE);
  assert.equal(sent.args.opts && sent.args.opts.parse_mode, undefined);
  assert.deepEqual(financeCards.map((f) => f.paymentId), ['PAY-1'], 'the finance card still goes out');
});

test('PAY-2 §2 C: no note → both messages unchanged (no dangling newline)', async () => {
  item = { requestId: 'REQ-Q', user: EMPLOYEE, status: 'pending', actionJSON: { action: 'add_user', name: 'Musa' } };
  execResult = { ok: true, approver: 'John' };
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq(ADMIN_2, 'REQ-Q'), 'approve');
  const reply = textsTo(bot, ADMIN_2).find((t) => /approved by John/.test(t));
  assert.equal(reply, '✅ Request REQ-Q approved by John. Changes applied.');
  assert.equal(textsTo(bot, EMPLOYEE)[0], '✅ Your request R-REQQ has been approved by admin. Changes applied.');
});

test('PAY-2 §2 C: the note rides beside the RET-3 credit tail, credit first', async () => {
  item = { requestId: 'REQ-R', user: EMPLOYEE, status: 'pending', actionJSON: { action: 'add_user', name: 'Musa' } };
  execResult = { ok: true, approver: 'John', creditNote: '↩️ Credited 1,000', note: 'ℹ️ tail' };
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq(ADMIN_2, 'REQ-R'), 'approve');
  const reply = textsTo(bot, ADMIN_2).find((t) => /approved by John/.test(t));
  assert.ok(reply.endsWith('\n↩️ Credited 1,000\nℹ️ tail'), reply);
});

test('PAY-2 §2 G: the bill is forwarded with the admin card — photo first', async () => {
  item = { requestId: 'REQ-B', user: EMPLOYEE, status: 'pending', actionJSON: { action: 'request_payment', payment_id: 'PAY-2', bill_file_id: 'bill-9' } };
  const bot = createFakeBot();
  await approvalEvents.notifyAdminsApprovalRequest(bot, 'REQ-B', 'Abdul', 'Payment request: ₦4,000', 'dual_admin_required', undefined);
  const photos = bot.calls.filter((c) => c.method === 'sendPhoto');
  assert.deepEqual(photos.map((c) => String(c.args.chatId)).sort(), ['777', '888', '999'], 'every env admin');
  assert.ok(photos.every((c) => c.args.photo === 'bill-9'));
  assert.equal(photos[0].args.opts.caption, '📎 Bill for payment request REQ-B');
  assert.equal(bot.calls.filter((c) => c.method === 'sendDocument').length, 0);
});

test('PAY-2 §2 G: a bill sent as a File goes out as a document; the admin requester is excluded', async () => {
  item = { requestId: 'REQ-D', user: '777', status: 'pending', actionJSON: { action: 'request_payment', payment_id: 'PAY-3', bill_file_id: 'doc-1', bill_file_type: 'document' } };
  const bot = createFakeBot();
  await approvalEvents.notifyAdminsApprovalRequest(bot, 'REQ-D', 'Ajeet', 'Payment request: ₦4,000', 'dual_admin_required', '777');
  const docs = bot.calls.filter((c) => c.method === 'sendDocument');
  assert.deepEqual(docs.map((c) => String(c.args.chatId)).sort(), ['888', '999']);
  assert.ok(docs.every((c) => c.args.doc === 'doc-1'));
  assert.equal(bot.calls.filter((c) => c.method === 'sendPhoto').length, 0);
});

test('PAY-2 §2 G: no bill, or another action carrying the key → nothing forwarded', async () => {
  item = { requestId: 'REQ-N', user: EMPLOYEE, status: 'pending', actionJSON: { action: 'request_payment', payment_id: 'PAY-4' } };
  let bot = createFakeBot();
  await approvalEvents.notifyAdminsApprovalRequest(bot, 'REQ-N', 'Abdul', 'Payment request: ₦4,000', 'dual', undefined);
  assert.equal(bot.calls.filter((c) => /^send(Photo|Document)$/.test(c.method)).length, 0);

  item = { requestId: 'REQ-O', user: EMPLOYEE, status: 'pending', actionJSON: { action: 'add_user', bill_file_id: 'stray' } };
  bot = createFakeBot();
  await approvalEvents.notifyAdminsApprovalRequest(bot, 'REQ-O', 'Abdul', 'add user', 'x', undefined);
  assert.equal(bot.calls.filter((c) => /^send(Photo|Document)$/.test(c.method)).length, 0);
  assert.equal(bot.calls.filter((c) => c.method === 'sendMessage').length, 3, 'the card itself still goes to all three');
});
