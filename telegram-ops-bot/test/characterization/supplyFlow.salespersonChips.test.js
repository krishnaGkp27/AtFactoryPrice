'use strict';

/**
 * SRF-SP (owner, 11-Sep-2026) — the supply request's "who sold it?" step
 * through the REAL controller. BUSINESS_RULES §9b: the seller is picked, the
 * submitter offered first.
 *
 *   row 1  🙋 Me · <name>   when the submitter is an admin or in Sales
 *   row 2  👤 Customer direct   stored as exactly 'Customer direct'
 *   then   the Sales list, without the submitter, + ⬅️ Back to customer
 *   header 🧑 Who sold it?
 *
 * Every door into the step shows the same card: the customer chip, the
 * typed customer, Back from the payment step, and the new-customer-approved
 * continuation in approvalEvents (which used to hand-roll a list of EVERY
 * Users row).
 */

process.env.ADMIN_IDS = '777,778';
process.env.EMPLOYEE_IDS = '4242,4343,5555';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, lastKb } = require('../helpers/charFixture');

const USERS_HEADER = ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'departments', 'warehouses', 'manages', 'notification_prefs'];
const userRow = (id, name, dept) => [id, name, 'employee', 'Lagos', 'branch_only', 'active', '', dept, '', '', ''];

installFakeSheets(createFakeSheets({
  Users: [
    USERS_HEADER,
    userRow('777', 'Owner', ''),        // admin by id, no department
    userRow('4242', 'Musa', 'Sales'),
    userRow('4343', 'Bello', 'Dispatch'),
    userRow('5555', 'Aisha', 'Sales'),
    // 778 is an admin with NO Users row
  ],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const customerEntity = require(path.join(SRC, 'services/customerEntity'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

auditLogRepository.append = async () => {};

const CART_MSG = 50;
const cart = [{ design: '202/201', shade: '1', shadeName: '1', quantity: 2 }];
function seedAtCustomer(uid, extra = {}) {
  sessionStore.set(uid, { type: 'supply_req_flow', warehouse: 'Lagos', cart, step: 'customer', productType: 'fabric', flowMessageId: CART_MSG, ...extra });
}
const msg = (uid, text) => ({ from: { id: uid }, chat: { id: uid }, text });
const lastText = (bot) => {
  const t = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
  return t.length ? t[t.length - 1].args.text : '';
};
const cbs = (bot) => lastKb(bot).map((b) => b.callback_data);
const btn = (bot, i) => { const b = lastKb(bot)[i]; return b ? [b.text, b.callback_data] : null; };

function assertPickerShape(bot, meRow) {
  assert.equal(lastText(bot), '🧑 Who sold it?');
  const k = cbs(bot);
  if (meRow) {
    assert.deepEqual(btn(bot, 0), meRow, 'Me first');
    assert.deepEqual(btn(bot, 1), ['👤 Customer direct', 'srf_sp:Customer direct'], 'Customer direct second');
    assert.equal(k.filter((c) => c === meRow[1]).length, 1, 'the submitter is on row 1 only, never repeated in the list');
  } else {
    assert.deepEqual(btn(bot, 0), ['👤 Customer direct', 'srf_sp:Customer direct'], 'no Me chip: Customer direct first');
    assert.ok(!lastKb(bot).some((b) => b.text.startsWith('🙋 Me')));
  }
  assert.ok(!k.includes('srf_sp:Bello'), `Dispatch-only user is not a seller: ${k}`);
  assert.equal(k[k.length - 1], 'srf_back:customer', 'Back to customer kept');
}

test('admin picks a customer: Me · Owner first, Customer direct, Sales list, Who sold it?; Customer direct → payment step', async () => {
  seedAtCustomer('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cu:OKESON', '777'));
  assert.equal(sessionStore.get('777').step, 'salesperson');
  assertPickerShape(bot, ['🙋 Me · Owner', 'srf_sp:Owner']);
  const k = cbs(bot);
  assert.ok(k.includes('srf_sp:Musa') && k.includes('srf_sp:Aisha'), `Sales users listed: ${k}`);

  await controller.handleCallbackQuery(bot, cb('srf_sp:Customer direct', '777'));
  const s = sessionStore.get('777');
  assert.equal(s.salesperson, 'Customer direct', 'stored value is exactly Customer direct');
  assert.equal(s.step, 'payment');
  assert.match(lastText(bot), /Select payment mode/);
  assert.ok(cbs(bot).includes('srf_back:salesperson'));
});

test('an admin with no Users row: Me · <id>', async () => {
  seedAtCustomer('778');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cu:OKESON', '778'));
  assertPickerShape(bot, ['🙋 Me · 778', 'srf_sp:778']);
});

test('a Sales-department submitter: Me · Musa first; admins and other sellers in the list', async () => {
  seedAtCustomer('4242');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cu:OKESON', '4242'));
  assertPickerShape(bot, ['🙋 Me · Musa', 'srf_sp:Musa']);
  const k = cbs(bot);
  assert.ok(k.includes('srf_sp:Owner') && k.includes('srf_sp:Aisha'), `others listed: ${k}`);

  await controller.handleCallbackQuery(bot, cb('srf_sp:Musa', '4242'));
  assert.equal(sessionStore.get('4242').salesperson, 'Musa', 'Me stores the name, like picking oneself from the list');
});

test('a Dispatch submitter: no Me chip, Customer direct is the first row', async () => {
  seedAtCustomer('4343');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cu:OKESON', '4343'));
  assertPickerShape(bot, null);
});

test('Back from the payment step re-opens the same card', async () => {
  seedAtCustomer('777', { step: 'payment', customer: 'OKESON', salesperson: 'Aisha' });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:salesperson', '777'));
  assert.equal(sessionStore.get('777').step, 'salesperson');
  assertPickerShape(bot, ['🙋 Me · Owner', 'srf_sp:Owner']);
});

test('the typed-customer door shows the same card', async () => {
  const origSearch = customerEntity.search;
  customerEntity.search = async () => [{ customer_id: 'C-1', name: 'OKESON', status: 'Active' }];
  try {
    seedAtCustomer('4242', { step: 'new_srf_customer_name' });
    const bot = createFakeBot();
    await controller.handleMessage(bot, msg('4242', 'OKESON'));
    const s = sessionStore.get('4242');
    assert.equal(s.customer, 'OKESON');
    assert.equal(s.step, 'salesperson');
    assertPickerShape(bot, ['🙋 Me · Musa', 'srf_sp:Musa']);
  } finally {
    customerEntity.search = origSearch;
  }
});

test('new-customer approved: the continuation card is the same chip set (was every Users row)', async () => {
  const queueRow = {
    requestId: 'REQ-NC-9', user: '4242', status: 'pending',
    actionJSON: { action: 'new_customer', customer_id: 'C-NEW', customer_name: 'OKESON', phone: '', requesterUserId: '4242', from: 'supply_req_flow' },
  };
  const origs = {
    getByRequestId: approvalQueueRepository.getByRequestId,
    getAllPending: approvalQueueRepository.getAllPending,
    updateStatus: approvalQueueRepository.updateStatus,
    updateActionJSON: approvalQueueRepository.updateActionJSON,
    updateRow: customersRepository.updateRow,
  };
  approvalQueueRepository.getByRequestId = async (id) => (id === queueRow.requestId ? queueRow : null);
  approvalQueueRepository.getAllPending = async () => [queueRow];
  approvalQueueRepository.updateStatus = async () => {};
  approvalQueueRepository.updateActionJSON = async () => {};
  customersRepository.updateRow = async () => {};
  try {
    sessionStore.set('4242', {
      type: 'supply_req_flow', warehouse: 'Lagos', cart, step: 'awaiting_customer_approval', productType: 'fabric',
      pendingCustomerId: 'C-NEW', pendingCustomerName: 'OKESON', customerApprovalId: 'REQ-NC-9',
    });
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('approve:REQ-NC-9', '777'));
    const s = sessionStore.get('4242');
    assert.equal(s.step, 'salesperson');
    assert.equal(s.customer, 'OKESON');
    assert.equal(s.customerId, 'C-NEW');

    const toRequester = bot.callsTo('sendMessage').filter((c) => String(c.args.chatId) === '4242');
    assert.match(toRequester[0].args.text, /has been approved/);
    assert.ok(!/Select salesperson/.test(toRequester[0].args.text), 'the notice no longer asks twice');
    const card = toRequester.find((c) => c.args.opts && c.args.opts.reply_markup);
    assert.ok(card, 'a picker card reached the requester');
    assert.equal(card.args.text, '🧑 Who sold it?');
    const flat = card.args.opts.reply_markup.inline_keyboard.flat();
    assert.deepEqual([flat[0].text, flat[0].callback_data], ['🙋 Me · Musa', 'srf_sp:Musa']);
    assert.deepEqual([flat[1].text, flat[1].callback_data], ['👤 Customer direct', 'srf_sp:Customer direct']);
    const k = flat.map((b) => b.callback_data);
    assert.ok(k.includes('srf_sp:Owner') && k.includes('srf_sp:Aisha'));
    assert.ok(!k.includes('srf_sp:Bello'), 'Dispatch is no longer offered as a seller');
    assert.equal(k.filter((c) => c === 'srf_sp:Musa').length, 1);
    assert.equal(k[k.length - 1], 'srf_back:customer');

    // The card is live: Customer direct advances the resumed flow.
    await controller.handleCallbackQuery(bot, cb('srf_sp:Customer direct', '4242'));
    assert.equal(sessionStore.get('4242').salesperson, 'Customer direct');
    assert.equal(sessionStore.get('4242').step, 'payment');
  } finally {
    Object.assign(approvalQueueRepository, {
      getByRequestId: origs.getByRequestId, getAllPending: origs.getAllPending,
      updateStatus: origs.updateStatus, updateActionJSON: origs.updateActionJSON,
    });
    customersRepository.updateRow = origs.updateRow;
  }
});

test('See All expands the list in place and keeps Me and Customer direct on top', async () => {
  seedAtCustomer('777', { step: 'salesperson', customer: 'OKESON' });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_sp:__more__', '777'));
  assert.equal(sessionStore.get('777').step, 'salesperson', 'See All does not advance the step');
  assertPickerShape(bot, ['🙋 Me · Owner', 'srf_sp:Owner']);
  assert.ok(!cbs(bot).includes('srf_sp:__more__'), 'expanded list carries no See All');
});
