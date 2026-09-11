'use strict';

/**
 * SRF-PAY (owner, 11-Sep-2026) — where the requester's payment mode really
 * travels. ✅ Confirm & Submit stores the VALUE 'Not yet paid' on the queue
 * row and prints it on the requester's sealed card and on the admin's
 * approval card ("💳 Not yet paid") — that card is where the admin reads
 * the requester's choice while deciding.
 *
 * Approving a supply request never opens the sale wizard (Steps 1–5): the
 * admin lands on the warehouse-boy picker. So the wizard's Step 3 is NOT a
 * place a requester's mode can be shown, and none is drawn there (see
 * test/unit/events/approvalEvents.paymentStepTypedList.test.js).
 *
 * Drives the REAL controller: srf_conf:yes → queue row → admin card →
 * approve:<id> → picker; no wizard state, no "Step 3", no requester hint.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));

const UID = '4242';
const ADMIN = '777';
const FLOW_MSG = 50;

usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `U${id}` });
auditLogRepository.append = async () => {};
productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'B', subunit_label: 'Than', measure_unit: 'yards' });

// One queue row, kept in memory the way the sheet would hold it.
let queueRow = null;
const statusUpdates = [];
approvalQueueRepository.append = async (row) => { queueRow = { ...row, actionJSON: { ...row.actionJSON } }; return true; };
approvalQueueRepository.getByRequestId = async (id) => (queueRow && queueRow.requestId === id ? queueRow : null);
approvalQueueRepository.getAllPending = async () => (queueRow && queueRow.status === 'pending' ? [queueRow] : []);
approvalQueueRepository.updateActionJSON = async (id, patch) => {
  if (queueRow && queueRow.requestId === id) queueRow.actionJSON = { ...queueRow.actionJSON, ...patch };
  return true;
};
approvalQueueRepository.updateStatus = async (id, status) => { statusUpdates.push({ id, status }); return true; };

function seedAtConfirm(paymentMode) {
  sessionStore.set(UID, {
    type: 'supply_req_flow', warehouse: 'Lagos', productType: 'fabric', step: 'confirm',
    cart: [{ design: '202/201', shade: '1', quantity: 2 }], customer: 'Chima', salesperson: 'Musa',
    paymentMode, supplyDate: '2026-09-11', flowMessageId: FLOW_MSG,
  });
}
const sentTo = (bot, chatId) => bot.callsTo('sendMessage').filter((c) => String(c.args.chatId) === String(chatId));
const { pendingEnrichment } = approvalEvents._internals;

test.beforeEach(() => {
  queueRow = null;
  statusUpdates.length = 0;
  pendingEnrichment.clear();
  sessionStore.clear(UID);
});

test('Confirm & Submit queues the VALUE "Not yet paid" and prints it to the requester and on the admin card', async () => {
  seedAtConfirm('Not yet paid');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_conf:yes', UID, FLOW_MSG));

  assert.ok(queueRow, 'a row was queued');
  assert.equal(queueRow.actionJSON.action, 'supply_request');
  assert.equal(queueRow.actionJSON.paymentMode, 'Not yet paid', 'the value, never the chip label');
  assert.equal(queueRow.status, 'pending');
  assert.equal(sessionStore.get(UID), null, 'the flow session is gone');

  // No Dispatch members in the fake Users sheet → the request falls
  // straight to the admins, with the requester's mode on the card.
  const adminCards = sentTo(bot, ADMIN);
  assert.ok(adminCards.length >= 1, 'the admin got the approval card');
  const card = adminCards.find((c) => /Supply Request/.test(c.args.text || ''));
  assert.ok(card, 'the supply approval card reached the admin');
  assert.match(card.args.text, /💳 Not yet paid\n/, 'the requester\'s mode is on the card the admin decides from');
  assert.ok(!/💳 Credit/.test(bot.allText()), 'nowhere does the old word print');
  assert.ok(card.args.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === `approve:${queueRow.requestId}`),
    'the card carries the approve chip for this request');

  // The requester's own sealed card reads the same word.
  const sealed = bot.callsTo('editMessageText').find((c) => /Supply request submitted/.test(c.args.text || ''));
  assert.ok(sealed, 'the confirm card was sealed into the receipt');
  assert.match(sealed.args.text, /💳 Not yet paid\n/);
});

test('approve on a queued supply request never opens the sale wizard — the admin lands on the warehouse-boy picker', async () => {
  seedAtConfirm('Not yet paid');
  const submitBot = createFakeBot();
  await controller.handleCallbackQuery(submitBot, cb('srf_conf:yes', UID, FLOW_MSG));
  assert.equal(queueRow.actionJSON.stage, 'admin_review', 'no Dispatch members → straight to admin review');

  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`approve:${queueRow.requestId}`, ADMIN, 9));

  const text = bot.allText();
  assert.match(text, /Supply request approved\./, 'the supply approval summary');
  assert.match(text, /Assign to a warehouse boy:/, 'the picker, not a wizard');
  assert.ok(!/Step \d — /.test(text), 'no wizard step card of any kind');
  assert.ok(!/Confirm sale/.test(text), 'no wizard header');
  assert.ok(!/🗒|Requester:/.test(text), 'no requester hint exists on this route');
  assert.equal(pendingEnrichment.size, 0, 'no wizard state was opened for the admin');
  assert.ok(!statusUpdates.some((u) => u.status === 'approved'),
    'the row is not resolved yet — assignment and dispatch acceptance still follow');
});

test('a Cash supply request travels the same way, value intact', async () => {
  seedAtConfirm('Cash');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_conf:yes', UID, FLOW_MSG));
  assert.equal(queueRow.actionJSON.paymentMode, 'Cash');
  const card = sentTo(bot, ADMIN).find((c) => /Supply Request/.test(c.args.text || ''));
  assert.match(card.args.text, /💳 Cash\n/);
});
