'use strict';

/**
 * APG-1 — what the REQUESTER is told, on the real decision path.
 *
 * Owner, 10-Nov-2026: "make sure that the requester who raised the request
 * gets the notification back as and when approved by the admin, one by one,
 * with the name and number of approvers required."
 *
 * Pinned:
 *  - the FIRST of two signatures: the requester gets the card naming the
 *    signer, the time and "1 of 2", and the name + time ride the row
 *    (`signoffs`) beside the ids the dual-admin counter keeps using;
 *  - the SECOND: every signer by name and time, "2 of 2", the executor's
 *    closing line;
 *  - a REJECTION: who and when, and — for a one-tap duplicate — which
 *    request is still open;
 *  - the other admins are still pinged for the second signature, as before.
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
const approvalCards = require('../../../src/services/approvalCards');
const paymentCards = require('../../../src/services/paymentCards');

const EMPLOYEE = '555';
const NAMES = { 555: 'Muhammad', 777: 'Musa', 888: 'Krishna', 999: 'John' };
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);

let item;
approvalQueueRepository.getByRequestId = async () => item;
approvalQueueRepository.getAllPending = async () => (item && item.status === 'pending' ? [item] : []);
approvalQueueRepository.updateActionJSON = async (requestId, patch) => {
  item.actionJSON = { ...item.actionJSON, ...patch };
  return true;
};
auditLogRepository.append = async () => {};
let execResult = { ok: true };
let executed = 0;
inventoryService.executeApprovedAction = async () => { executed += 1; return execResult; };
inventoryService.rejectApproval = async () => ({ ok: true });
paymentCards.sendFinanceCard = async () => ({ sent: 1, failed: 0 });
// PAY-6 — no company paying account is configured (the world these pins
// were written for). The completing payment approval reads the list through
// the STRICT Settings reader, which fails closed on a sheet it cannot read.
require('../../../src/repositories/settingsRepository').getAllStrict = async () => ({});
require('../../../src/repositories/paymentRequestsRepository').findByApprovalRequestId = async () => null;

const cbq = (fromId, data) => ({ id: 'q', data, from: { id: Number(fromId) }, message: { chat: { id: Number(fromId) }, message_id: 3 } });
const textsTo = (bot, chatId) => bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === String(chatId)).map((c) => c.args.text);
const TIME = '\\d{2}-[A-Z][a-z]{2} \\d{2}:\\d{2}';
const PAY = { action: 'request_payment', payment_id: 'PAY-7', payee_name: 'Muhammad', payee_type: 'employee', amount_ngn: 70000, account_number: '7044196792', bank: 'OPAY', reason: 'Salary · Nov-2026' };

test('first of two: the requester is told who signed, when, and that it is 1 of 2 — and the row keeps the name', async () => {
  item = { requestId: 'REQ-7', user: EMPLOYEE, status: 'pending', actionJSON: { ...PAY } };
  executed = 0;
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq('777', 'approve:REQ-7'), 'approve');

  assert.equal(executed, 0, 'one signature never executes a dual-admin request');
  assert.deepEqual(item.actionJSON.approvals, ['777'], 'the id list the counter and the four-eyes gate read is unchanged');
  assert.equal(item.actionJSON.signoffs.length, 1);
  assert.equal(item.actionJSON.signoffs[0].id, '777');
  assert.equal(item.actionJSON.signoffs[0].name, 'Musa');
  assert.ok(Date.parse(item.actionJSON.signoffs[0].at) > 0);

  const mine = textsTo(bot, EMPLOYEE);
  assert.equal(mine.length, 1, 'one card to the requester');
  assert.match(mine[0], new RegExp(`^🔏 Approval 1 of 2\\n💳 Payment request · ₦70,000 → Muhammad · Salary · Nov-2026\\n✅ Musa · ${TIME}\\n⏳ Waiting on 1 more admin\\nRef R-REQ7$`));
  // plain text: a name with _ or * cannot blank the notice
  const sent = bot.calls.find((c) => c.method === 'sendMessage' && String(c.args.chatId) === EMPLOYEE);
  assert.equal(sent.args.opts && sent.args.opts.parse_mode, undefined);
  // while it still waits, the requester's push is a reminder — never a second request
  const kb = sent.args.opts.reply_markup.inline_keyboard.flat().map((b) => `${b.text}|${b.callback_data}`);
  assert.deepEqual(kb, ['🔔 Remind approvers|apg:nudge:REQ-7', '📋 Status|apg:st:REQ-7']);
  // the others are still pinged for the second signature (as before)
  assert.ok(textsTo(bot, '888').some((t) => /needs a SECOND/.test(t)));
  assert.ok(textsTo(bot, '999').some((t) => /needs a SECOND/.test(t)));
  assert.ok(textsTo(bot, '777').some((t) => /your approval is recorded \(1 of 2\)/.test(t)));
});

test('second of two: every signer by name and time, 2 of 2, then the executor\'s closing line', async () => {
  // continues from the row the first test left: Musa has signed
  execResult = { ok: true, approver: 'Musa + Krishna', note: '✅ Payment of ₦70,000 to Muhammad approved by Musa ‖ Krishna — now with finance to pay.' };
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq('888', 'approve:REQ-7'), 'approve');
  assert.equal(executed, 1);
  const mine = textsTo(bot, EMPLOYEE);
  assert.equal(mine.length, 1);
  assert.match(mine[0], new RegExp(`^✅ Approved · 2 of 2\\n💳 Payment request · ₦70,000 → Muhammad · Salary · Nov-2026\\n✅ Musa · ${TIME}\\n✅ Krishna · ${TIME}\\n✅ Payment of ₦70,000 to Muhammad approved by Musa ‖ Krishna — now with finance to pay\\.\\nRef R-REQ7$`));
});

test('an admin cannot give both signatures — nothing is sent to the requester for the refused tap', async () => {
  item = { requestId: 'REQ-8', user: EMPLOYEE, status: 'pending', actionJSON: { ...PAY, approvals: ['777'], signoffs: [{ id: '777', name: 'Musa', at: '2026-11-10T09:20:00.000Z' }] } };
  executed = 0;
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq('777', 'approve:REQ-8'), 'approve');
  assert.equal(executed, 0);
  assert.equal(textsTo(bot, EMPLOYEE).length, 0);
  assert.equal(item.actionJSON.signoffs.length, 1);
});

test('a signature recorded before APG-1 (id only) is still named on the closing card', async () => {
  item = { requestId: 'REQ-9', user: EMPLOYEE, status: 'pending', actionJSON: { ...PAY, approvals: ['999'] } };
  execResult = { ok: true };
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq('888', 'approve:REQ-9'), 'approve');
  const mine = textsTo(bot, EMPLOYEE)[0];
  assert.match(mine, new RegExp(`^✅ Approved · 2 of 2\\n[^\\n]+\\n✅ John\\n✅ Krishna · ${TIME}\\nChanges applied\\.\\nRef R-REQ9$`), mine);
});

test('rejection: named and dated; a one-tap duplicate says which request is still open', async () => {
  item = { requestId: 'REQ-10', user: EMPLOYEE, status: 'pending', actionJSON: { ...PAY, rejectNote: 'Duplicate of R-B118, which is still open' } };
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cbq('888', 'reject:REQ-10'), 'reject');
  const mine = textsTo(bot, EMPLOYEE);
  assert.equal(mine.length, 1);
  assert.match(mine[0], new RegExp(`^❌ Rejected by Krishna · ${TIME}\\n💳 Payment request · ₦70,000 → Muhammad · Salary · Nov-2026\\n📝 Duplicate of R-B118, which is still open\\nRef R-REQ1$`));

  // a plain rejection carries no reason line
  item = { requestId: 'REQ-11', user: EMPLOYEE, status: 'pending', actionJSON: { action: 'add_user', name: 'Sani' } };
  const bot2 = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot2, cbq('777', 'reject:REQ-11'), 'reject');
  assert.match(textsTo(bot2, EMPLOYEE)[0], new RegExp(`^❌ Rejected by Musa · ${TIME}\\nAdd user · Sani\\nRef R-REQ1$`));
});

test('the admin card of a flagged twin carries ⧉ Reject as duplicate; a clean card and the gate\'s reminder do not misfire', async () => {
  const twinA = { requestId: 'REQ-A', user: EMPLOYEE, status: 'pending', createdAt: '2026-11-10T09:04:00.000Z', actionJSON: { ...PAY, payment_id: 'PAY-A' } };
  const twinB = { requestId: 'REQ-B', user: EMPLOYEE, status: 'pending', createdAt: '2026-11-10T09:04:03.000Z', actionJSON: { ...PAY, payment_id: 'PAY-B' } };
  const savedPending = approvalQueueRepository.getAllPending;
  approvalQueueRepository.getAllPending = async () => [twinA, twinB];
  try {
    const bot = createFakeBot();
    await approvalEvents.notifyAdminsApprovalRequest(bot, 'REQ-B', 'Muhammad', 'Payment request: ₦70,000', 'dual_admin_required', undefined, { excludeIds: ['999'] });
    const cards = bot.calls.filter((c) => c.method === 'sendMessage');
    assert.deepEqual(cards.map((c) => String(c.args.chatId)).sort(), ['777', '888'], 'excludeIds keeps the card from an admin');
    assert.match(cards[0].args.text, /Possible duplicate/);
    const kb = cards[0].args.opts.reply_markup.inline_keyboard;
    assert.deepEqual(kb[1], [{ text: '⧉ Reject as duplicate', callback_data: 'apg:dup:REQ-B' }]);
    // alone in the queue → the standard pair only
    approvalQueueRepository.getAllPending = async () => [twinB];
    const bot2 = createFakeBot();
    await approvalEvents.notifyAdminsApprovalRequest(bot2, 'REQ-B', 'Muhammad', 'Payment request: ₦70,000', 'dual_admin_required', undefined);
    const kb2 = bot2.calls.find((c) => c.method === 'sendMessage').args.opts.reply_markup.inline_keyboard;
    assert.equal(kb2.length, 1);
    assert.ok(!/Possible duplicate/.test(bot2.calls.find((c) => c.method === 'sendMessage').args.text));
    // a row FLAGGED at raise against a twin the detector cannot see
    // (approved and unpaid) still offers the admin the one-tap refusal
    const flagged = { ...twinB, requestId: 'REQ-F', actionJSON: { ...twinB.actionJSON, twinFlag: { requestId: 'REQ-OLD', raisedBy: '556', raisedByName: 'Abdul', state: 'approved' } } };
    approvalQueueRepository.getAllPending = async () => [flagged];
    const bot3 = createFakeBot();
    await approvalEvents.notifyAdminsApprovalRequest(bot3, 'REQ-F', 'Muhammad', 'Payment request: ₦70,000', 'dual_admin_required', undefined);
    const kb3 = bot3.calls.find((c) => c.method === 'sendMessage').args.opts.reply_markup.inline_keyboard;
    assert.deepEqual(kb3[1], [{ text: '⧉ Reject as duplicate', callback_data: 'apg:dup:REQ-F' }]);
  } finally { approvalQueueRepository.getAllPending = savedPending; }
});

// DUAL-1b (11-Nov-2026) — a first signature that cannot be saved must not
// fall through to a one-signature execution of a two-signature request.
test('first of two: when the signature cannot be SAVED nothing is approved and the admin is told to tap again', async () => {
  item = { requestId: 'REQ-8', user: EMPLOYEE, status: 'pending', actionJSON: { ...PAY } };
  executed = 0;
  const orig = approvalQueueRepository.updateActionJSON;
  approvalQueueRepository.updateActionJSON = async () => { throw new Error('Quota exceeded'); };
  const bot = createFakeBot();
  try {
    await approvalEvents.handleApprovalCallback(bot, cbq('777', 'approve:REQ-8'), 'approve');
  } finally {
    approvalQueueRepository.updateActionJSON = orig;
  }
  assert.equal(executed, 0, 'one unsaved signature never executes a dual-admin request');
  assert.equal(item.actionJSON.approvals, undefined, 'nothing was recorded');
  const alert = bot.calls.find((c) => c.method === 'answerCallbackQuery' && /Could not record your approval/.test(String((c.args.opts || c.args.options || c.args).text || '')));
  assert.ok(alert, 'the admin is told nothing was approved');
  assert.equal(textsTo(bot, EMPLOYEE).length, 0, 'the requester is not told of a signature that does not exist');
});
