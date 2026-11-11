'use strict';
/**
 * FIX-SUPPLY2 (4) — CON-1 renamed the CRM tile to ➕ Add Contact, but six
 * sentences that send people to that tile still called it `Add Customer`,
 * a name no screen carries any more. Each is pinned here through the path
 * that prints it, together with the tile's real label.
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
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
const ordersRepository = require(path.join(SRC, 'repositories/ordersRepository'));
const ledgerCache = require(path.join(SRC, 'repositories/ledgerBalanceCacheRepository'));
const activityRegistry = require(path.join(SRC, 'services/activityRegistry'));
const salesWorkflowView = require(path.join(SRC, 'flows/salesWorkflowView'));

const EMP = '4242';
const ADMIN = '777';
const CUSTOMERS = [
  { rowIndex: 2, customer_id: 'CUST-1', name: 'CJE', phone: '0801', status: 'Active', aliases: [] },
  { rowIndex: 3, customer_id: 'CUST-2', name: 'Ketu madam', phone: '0802', status: 'Active', aliases: [] },
];
let customers = CUSTOMERS;
customersRepository.getAll = async () => customers.map((c) => ({ ...c }));
transactionsRepository.getLast = async () => [];

const texts = (bot) => bot.calls
  .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).map((c) => c.args.text);
const saleItem = () => ({
  requestId: 'R-1', user: EMP, status: 'pending',
  actionJSON: { action: 'sell_package', packageNo: '896', design: '77016', warehouse: 'IDUMOTA', yards: 60, customer: '' },
});

test('the CRM tile these sentences point at is ➕ Add Contact', () => {
  const tile = activityRegistry.getActivity('add_customer');
  assert.ok(tile, 'the activity code is unchanged');
  assert.equal(`${tile.icon} ${tile.label}`, '➕ Add Contact');
  assert.equal(tile.hub, 'crm');
});

test('a typed customer name that matches nobody (order flow) names ➕ Add Contact', async () => {
  const bot = createFakeBot();
  sessionStore.set(EMP, { type: 'order_flow', step: 'customer_new' });
  await controller.handleMessage(bot, { from: { id: EMP }, chat: { id: EMP }, text: 'NOBODY LTD' });
  assert.ok(texts(bot).includes(
    'No customer matches “NOBODY LTD”. Type again to search, or ask an admin to add them via 👥 CRM → ➕ Add Contact first.'),
  `got: ${texts(bot).join(' | ')}`);
  sessionStore.clear(EMP);
});

test('the sale approval wizard: an unmatched typed name names ➕ Add Contact', async () => {
  const bot = createFakeBot();
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-1', saleItem(), EMP);
  await approvalEvents.handleEnrichmentMessage(bot, ADMIN, ADMIN, 'NOBODY LTD');
  assert.ok(texts(bot).includes(
    'No customer matches “NOBODY LTD”. Type again to search, or ask an admin to add them via 👥 CRM → ➕ Add Contact first.'),
  `got: ${texts(bot).join(' | ')}`);
});

test('the sale approval wizard: an empty customer list names ➕ Add Contact', async () => {
  const bot = createFakeBot();
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-1', saleItem(), EMP);
  const kb = bot.calls.filter((c) => c.method === 'sendMessage' && c.args.opts && c.args.opts.reply_markup)
    .pop().args.opts.reply_markup.inline_keyboard.flat();
  const all = kb.find((b) => b.callback_data.endsWith(':cust:all:0'));
  assert.ok(all, 'the full list is reachable');
  customers = [];
  try {
    await approvalEvents.handleEnrichmentCallback(bot, {
      id: 'q1', data: all.callback_data, from: { id: ADMIN }, message: { chat: { id: ADMIN } },
    });
  } finally { customers = CUSTOMERS; }
  assert.ok(texts(bot).includes('No customers on file yet — an admin can add them via 👥 CRM → ➕ Add Contact.'),
    `got: ${texts(bot).join(' | ')}`);
});

test('Supply Catalog: the stale ➕ New Customer button names ➕ Add Contact', async () => {
  sessionStore.set(EMP, { type: 'catalog_supply_flow', step: 'recipient', flowPrefix: 'csf', flowMessageId: 50 });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('csf:newcust', EMP, 50));
  assert.ok(texts(bot).includes(
    '➕ New customers are added by an admin via 👥 CRM → ➕ Add Contact.\nSearch here finds every existing customer.'),
  `got: ${texts(bot).join(' | ')}`);
  sessionStore.clear(EMP);
});

test('Supply Catalog: a stale "new customer name" step names ➕ Add Contact', async () => {
  sessionStore.set(EMP, { type: 'catalog_supply_flow', step: 'new_cust_name', flowPrefix: 'csf', flowMessageId: 50 });
  const bot = createFakeBot();
  await controller.handleMessage(bot, { from: { id: EMP }, chat: { id: EMP }, text: 'Brand New Ltd' });
  assert.ok(texts(bot).includes('➕ New customers are added via 👥 CRM → ➕ Add Contact. Pick an existing customer:'),
    `got: ${texts(bot).join(' | ')}`);
  assert.equal(sessionStore.get(EMP).step, 'customer', 'the session is put back on the picker step, as before');
  sessionStore.clear(EMP);
});

test('🚚 Pending Supply order card: a customer not on the Customers sheet names Add Contact', async () => {
  const o1 = ordersRepository.getAll; const o3 = ledgerCache.getAll;
  ordersRepository.getAll = async () => [{
    order_id: 'ORD-9', design: '9043', shade: 'A', quantity: '3 bales',
    customer: 'Stranger', status: 'pending', created_at: '2026-09-01T10:00:00Z',
  }];
  ledgerCache.getAll = async () => [];
  try {
    const bot = createFakeBot();
    await salesWorkflowView.showOrderDetail(bot, ADMIN, ADMIN, null, 'ORD-9');
    const card = texts(bot).pop();
    assert.ok(card.includes('   _Not yet in the Customers sheet — add via Add Contact._'), `got: ${card}`);
  } finally {
    ordersRepository.getAll = o1; ledgerCache.getAll = o3;
  }
});
