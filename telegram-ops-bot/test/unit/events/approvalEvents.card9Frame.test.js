'use strict';

/**
 * CARD-9 (owner, 20-Nov-2026) — the shorter approval message, on every
 * request type.
 *
 * Before:
 *   🔔 Approval required / (blank) / Ref: / <raw uuid> / From: Abdul /
 *   <card> / <reason, or "Sent for approval"> / Use buttons below to approve or reject.
 * After:
 *   🔔 Approval required · R-C677
 *   From: Abdul
 *
 *   <card>
 *
 *   <the reason line — only when it says something about THIS request>
 *
 * Pinned here:
 *  - the short reference on the header (UUID → R-C677; TR- id → 24Jul·03),
 *    the full id only in callback_data;
 *  - no reason line for boilerplate (the return doors' two-admin sentence
 *    included); a real fact still printed exactly;
 *  - the MarkdownV2 text escapes every reserved character, and the plain
 *    fallback reads the same;
 *  - the possible-duplicate line names short refs;
 *  - the add-contact triage card's header;
 *  - the two one-line messages after a FIRST signature.
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

const NAMES = { 555: 'Abdul', 777: 'Musa', 888: 'Krishna', 999: 'John' };
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);

let pending = [];
let item = null;
approvalQueueRepository.getAllPending = async () => pending;
approvalQueueRepository.getByRequestId = async () => item;
approvalQueueRepository.updateActionJSON = async (requestId, patch) => {
  item.actionJSON = { ...item.actionJSON, ...patch };
  return true;
};
auditLogRepository.append = async () => {};
inventoryService.executeApprovedAction = async () => ({ ok: true });
inventoryService.rejectApproval = async () => ({ ok: true });
paymentCards.sendFinanceCard = async () => ({ sent: 1, failed: 0 });
require('../../../src/repositories/settingsRepository').getAllStrict = async () => ({});
require('../../../src/repositories/paymentRequestsRepository').findByApprovalRequestId = async () => null;

const UUID = 'c677c134-c1c2-4c3b-a889-789fd73a15bf';
const RETURN_REASON = 'All return operations require two-admin approval.';
const RESERVED = '_*[]()~`>#+-=|{}.!';

const textsTo = (bot, chatId) => bot.calls
  .filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === String(chatId))
  .map((c) => c.args.text);

/** Every reserved MarkdownV2 character outside the named entity markers is escaped. */
function unescapedReserved(text) {
  const bad = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') { i += 1; continue; }
    if (RESERVED.includes(ch)) bad.push(`${ch}@${i}`);
  }
  return bad;
}

/** The MarkdownV2 text with its intended entity markers taken off. */
function stripEntities(text) {
  return text
    .replace('🔔 *Approval required*', '🔔 Approval required')
    .replace('⚠️ *Possible duplicate*', '⚠️ Possible duplicate')
    .replace(/\n\n_((?:\\.|[^_\\])+)_$/, '\n\n$1');
}
const unescape = (t) => t.replace(/\\(.)/g, '$1');

async function notify(requestId, summary, reason, bot = createFakeBot()) {
  await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, 'Abdul', summary, reason, '555');
  return bot;
}

test('a UUID request: the short ref on the header, From next, no raw id, no Ref:, no footer — buttons keep the full id', async () => {
  pending = [];
  const bot = await notify(UUID, 'Return goods\nCustomer: CJE', RETURN_REASON);
  const [text] = textsTo(bot, '777');
  assert.equal(text, '🔔 *Approval required* · R\\-C677\nFrom: Abdul\n\nReturn goods\nCustomer: CJE');
  assert.ok(!text.includes(UUID) && !/c677c134/i.test(text), 'no raw id on the screen');
  assert.ok(!/Ref:/.test(text));
  assert.ok(!/Use buttons below/.test(text));
  const call = bot.calls.find((c) => c.method === 'sendMessage' && String(c.args.chatId) === '777');
  assert.equal(call.args.opts.parse_mode, 'MarkdownV2');
  assert.deepEqual(call.args.opts.reply_markup.inline_keyboard[0].map((b) => b.callback_data),
    [`approve:${UUID}`, `reject:${UUID}`]);
});

test('a TR- transfer id reads as its own short form, never R-TR20', async () => {
  pending = [];
  const bot = await notify('TR-20260724-003', 'Transfer', '');
  const [text] = textsTo(bot, '777');
  assert.equal(text.split('\n')[0], '🔔 *Approval required* · 24Jul·03');
  assert.ok(!/R\\?-TR20/.test(text));
});

test('boilerplate reasons print no reason line — "Sent for approval" is gone too', async () => {
  for (const reason of [
    RETURN_REASON,
    'All return operations require admin approval.',
    'All payment operations require two-admin approval.',
    'All office expense operations require two-admin approval.',
    'Anything requires 2-admin approval.',
    'All sale operations require admin approval.',
    'Sample requires admin approval',
    '',
  ]) {
    pending = [];
    assert.equal(approvalCards.reasonFact(reason), '', reason);
    const [text] = textsTo(await notify(UUID, 'Card', reason), '777');
    assert.equal(text, '🔔 *Approval required* · R\\-C677\nFrom: Abdul\n\nCard', reason);
    assert.ok(!/Sent for approval/.test(text));
  }
  // shortReason keeps its old fallback for any other reader
  assert.equal(approvalCards.shortReason(RETURN_REASON), 'Sent for approval');
});

test('a real fact still prints, exactly as before', async () => {
  const kept = [
    'Backdated sale (4 days in the past).',
    'Contact detail changes are reviewed by an admin.',
    'Contact-network changes are reviewed by an admin.',
    '2nd admin approval required for price update',
    'All landed cost finalization operations require 2nd admin approval.',
    'All sale operations require 2nd admin approval.',
    'Merging customers moves ledger identity — dual-admin.',
    'Warehouse transfer — dispatcher + receiver confirmation chain.',
    'Shade photos must be approved before they appear to customers, marketers and sales.',
    'Product-photo asset must be approved before it appears to consumers.',
    'Admin approval required',
  ];
  for (const reason of kept) {
    assert.equal(approvalCards.reasonFact(reason), reason, reason);
    assert.equal(approvalCards.shortReason(reason), reason, reason);
  }
  // the fact half of a mixed reason survives; the boilerplate half does not
  assert.equal(approvalCards.reasonFact('Backdated sale (4 days in past). All sale operations require admin approval.'),
    'Backdated sale (4 days in past).');
  pending = [];
  const [text] = textsTo(await notify(UUID, 'Sale', 'Backdated sale (4 days in the past).'), '777');
  assert.equal(text, '🔔 *Approval required* · R\\-C677\nFrom: Abdul\n\nSale\n\n_Backdated sale \\(4 days in the past\\)\\._');
});

test('the MarkdownV2 text escapes every reserved character, and the plain fallback reads the same', async () => {
  pending = [];
  const summary = 'Sale · 2B + 1t · 300 yd\nCustomer: A_B (Kano) [x] {y} #1 =2 |3 ~4 >5 !6 `7`.';
  const label = 'Abdul_O. (Lagos)';
  const reason = 'Backdated sale (4 days in the past). All sale operations require admin approval.';
  const bot = createFakeBot();
  bot.sendMessage = async function sendMessage(chatId, text, opts) {
    bot.calls.push({ method: 'sendMessage', args: { chatId, text, opts } });
    if (opts && opts.parse_mode === 'MarkdownV2') throw new Error('400: can\'t parse entities');
    return { message_id: bot.calls.length };
  };
  await approvalEvents.notifyAdminsApprovalRequest(bot, UUID, label, summary, reason, '555');
  const to777 = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '777');
  assert.equal(to777.length, 2, 'MarkdownV2 first, the plain fallback second');
  const md = to777[0].args.text;
  const plain = to777[1].args.text;
  assert.equal(to777[1].args.opts.parse_mode, undefined);
  assert.deepEqual(unescapedReserved(stripEntities(md)), [], 'every reserved character is escaped');
  assert.equal(unescape(stripEntities(md)), plain, 'the fallback says what the card says');
  assert.equal(plain,
    `🔔 Approval required · R-C677\nFrom: ${label}\n\n${summary}\n\nBackdated sale (4 days in the past).`);
  assert.deepEqual(to777[1].args.opts.reply_markup.inline_keyboard[0].map((b) => b.callback_data),
    [`approve:${UUID}`, `reject:${UUID}`]);
});

test('the possible-duplicate line names the other requests by short ref', async () => {
  const twin = (id) => ({
    requestId: id, user: '555', status: 'pending', createdAt: new Date().toISOString(),
    actionJSON: { action: 'sale_bundle', items: [{ packageNo: '6306', thanNo: '1' }], customer: '' },
  });
  const OTHER = '9a1b2c3d-0000-4000-8000-000000000001';
  pending = [twin(OTHER), twin('TR-20260724-003'), twin(UUID)];
  const [text] = textsTo(await notify(UUID, 'Sale card', ''), '777');
  const first = text.split('\n')[0];
  assert.match(first, /^⚠️ \*Possible duplicate\* — same request also pending as /);
  assert.ok(first.includes('R\\-9A1B'), 'a UUID twin reads R-9A1B');
  assert.ok(first.includes('24Jul·03'), 'a TR- twin reads its short form');
  assert.ok(!text.includes('9a1b2c3d') && !text.includes('…'), 'no raw id slice');
  assert.deepEqual(unescapedReserved(stripEntities(text)), []);
  assert.match(text, /\n\n🔔 \*Approval required\* · R\\-C677\nFrom: Abdul\n\nSale card$/);
});

test('the add-contact triage card carries the same short header', async () => {
  item = {
    requestId: UUID, user: '555', status: 'pending',
    actionJSON: { action: 'add_contact', name: 'Amib International', kind: 'customer', phone: '08062562752' },
  };
  const bot = createFakeBot();
  await approvalEvents.handleContactTriageCallback(bot, {
    id: 'q', data: `ctg:${UUID}:x`, from: { id: 777 }, message: { chat: { id: 777 }, message_id: 5 },
  });
  const edit = bot.calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'the triage card is redrawn');
  assert.match(edit.args.text, /^🔔 \*Approval required\* · R\\-C677\n\n/);
  assert.ok(!/Ref:/.test(edit.args.text) && !edit.args.text.includes(UUID));
});

test('the two messages after a FIRST signature carry the short ref, not the raw id', async () => {
  item = {
    requestId: UUID, user: '555', status: 'pending',
    actionJSON: { action: 'request_payment', payment_id: 'PAY-7', payee_name: 'Abdul', payee_type: 'employee', amount_ngn: 70000, account_number: '7044196792', bank: 'OPAY', reason: 'Fuel' },
  };
  pending = [item];
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, {
    id: 'q', data: `approve:${UUID}`, from: { id: 777 }, message: { chat: { id: 777 }, message_id: 3 },
  }, 'approve');
  assert.ok(textsTo(bot, '777').includes('🔏 Request R-C677: your approval is recorded (1 of 2). Waiting for a second admin.'));
  for (const other of ['888', '999']) {
    const pings = textsTo(bot, other).filter((t) => /needs a SECOND/.test(t));
    assert.equal(pings.length, 1, other);
    assert.match(pings[0], /^🔔 Request R-C677 \(.+\) has its first admin approval and needs a SECOND\. Use the approval card in your chat\.$/);
  }
  for (const id of ['777', '888', '999']) {
    assert.ok(textsTo(bot, id).every((t) => !t.includes(UUID)), `no raw id to ${id}`);
  }
});
