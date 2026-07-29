'use strict';

/**
 * CUS-1 Phase B — every manual-entry door stays closed.
 *
 * The 28-Jul audit found 12 places where a typed string could become a
 * customer name on a record. This file pins the closures: typing anywhere
 * is a SEARCH over the official list; selection is a tap; creation happens
 * through exactly one gated door (CRM ➕ Add Customer).
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
let intentResult = { action: 'unknown', confidence: 0 };
installFakeIntent(() => intentResult);
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const erpBusModule = require(path.join(SRC, 'events/erpEventBus'));

const CUSTOMERS = [
  { rowIndex: 2, customer_id: 'CUST-1', name: 'CJE', phone: '0801', status: 'Active', aliases: ['C.J.E'] },
  { rowIndex: 3, customer_id: 'CUST-2', name: 'CJEBU STORES', phone: '0803', status: 'Active', aliases: [] },
  { rowIndex: 4, customer_id: 'CUST-3', name: 'Ketu madam', phone: '0802', status: 'Active', aliases: [] },
];
customersRepository.getAll = async () => CUSTOMERS.map((c) => ({ ...c }));
const appended = [];
customersRepository.append = async (c) => { appended.push(c); };

function msg(text, id = '4242') {
  return { from: { id }, chat: { id } };
}
function texts(bot) {
  return bot.calls.filter((c) => c.method === 'sendMessage').map((c) => c.args.text).join('\n');
}

test('sample flow: a typed EXACT name selects the canonical customer, never raw text', async () => {
  const bot = createFakeBot();
  sessionStore.set('4242', { type: 'sample_flow', step: 'customer_new' });
  await controller.handleMessage(bot, { ...msg(), text: 'cje' });
  const s = sessionStore.get('4242');
  assert.equal(s.customer, 'CJE', 'canonical spelling, not the typed lowercase');
  assert.equal(s.customerId, 'CUST-1', 'the entity id rides along');
  assert.equal(s.step, 'quantity', 'flow continues exactly as before');
  sessionStore.clear('4242');
});

test('sample flow: an AMBIGUOUS name becomes tappable chips, and the tap resumes the flow', async () => {
  const bot = createFakeBot();
  sessionStore.set('4242', { type: 'sample_flow', step: 'customer_new' });
  await controller.handleMessage(bot, { ...msg(), text: 'cj' });
  const kbCall = bot.calls.find((c) => c.method === 'sendMessage' && c.args.opts && c.args.opts.reply_markup);
  assert.ok(kbCall, 'chips offered');
  const chips = kbCall.args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(chips.every((b) => b.callback_data.startsWith('cpk:')), 'shared cpk: namespace');
  assert.ok(chips.some((b) => /CJEBU STORES/.test(b.text)));
  const s1 = sessionStore.get('4242');
  assert.equal(s1.step, 'customer_new', 'still waiting — nothing selected yet');

  await controller.handleCallbackQuery(bot, cb(chips.find((b) => /CJEBU/.test(b.text)).callback_data, '4242'));
  const s2 = sessionStore.get('4242');
  assert.equal(s2.customer, 'CJEBU STORES');
  assert.equal(s2.step, 'quantity', 'the tap resumed the sample flow');
  sessionStore.clear('4242');
});

test('order flow: an UNKNOWN name is refused — no order for a typo', async () => {
  const bot = createFakeBot();
  sessionStore.set('4242', { type: 'order_flow', step: 'customer_new' });
  await controller.handleMessage(bot, { ...msg(), text: 'NOBODY LTD' });
  const s = sessionStore.get('4242');
  assert.ok(!s.customer, 'nothing selected');
  assert.equal(s.step, 'customer_new', 'still at the step — retype or go add via CRM');
  assert.match(texts(bot), /No customer matches/);
  assert.match(texts(bot), /CRM/, 'the single door is named');
  sessionStore.clear('4242');
});

test('receipt flow: an ALIAS resolves to the canonical customer', async () => {
  const bot = createFakeBot();
  sessionStore.set('4242', { type: 'receipt_flow', step: 'customer_new' });
  await controller.handleMessage(bot, { ...msg(), text: 'C.J.E' });
  const s = sessionStore.get('4242');
  assert.equal(s.customer, 'CJE', 'the typo spelling lands on the real customer');
  assert.equal(s.step, 'amount');
  sessionStore.clear('4242');
});

test('NLP "add customer" is tap-only now — nothing is created from free text', async () => {
  const bot = createFakeBot();
  intentResult = { action: 'add_customer', customer: 'BRAND NEW LTD', confidence: 0.95 };
  appended.length = 0;
  await controller.handleMessage(bot, { ...msg('4242'), text: 'Add customer BRAND NEW LTD phone 0801' });
  assert.equal(appended.length, 0, 'no row written');
  assert.match(texts(bot), /tap-only/i);
  intentResult = { action: 'unknown', confidence: 0 };
});

test('NLP record_payment with an unknown name offers CANDIDATES, never a ledger row', async () => {
  const bot = createFakeBot();
  intentResult = { action: 'record_payment', customer: 'CJEB', price: 50000, confidence: 0.95 };
  await controller.handleMessage(bot, { ...msg('4242'), text: 'Record payment 50000 from CJEB via cash' });
  const kbCall = bot.calls.find((c) => c.method === 'sendMessage' && c.args.opts && c.args.opts.reply_markup);
  assert.ok(kbCall, 'candidate chips offered');
  const chips = kbCall.args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(chips.every((b) => b.callback_data.startsWith('rpk:')));
  assert.ok(chips.some((b) => /CJEBU STORES/.test(b.text)), 'closest real customers offered');
  sessionStore.clear('4242');
  intentResult = { action: 'unknown', confidence: 0 };
});

test('the CRM door respects the CUSTOMER_CREATION_ENABLED freeze', async () => {
  const bot = createFakeBot();
  const orig = settingsRepository.getAll;
  settingsRepository.getAll = async () => ({ CUSTOMER_CREATION_ENABLED: 0 });
  try {
    await controller.handleCallbackQuery(bot, cb('act:add_customer', '777'));
    assert.match(texts(bot), /frozen/i, 'the single door closes during cleanup');
  } finally {
    settingsRepository.getAll = orig;
  }
  sessionStore.clear('777');
});

test('a sale for an unknown customer POSTS but alerts the admins — never creates', async () => {
  const accountingService = require(path.join(SRC, 'services/accountingService'));
  const stockLedgerService = require(path.join(SRC, 'services/stockLedgerService'));
  const auditService = require(path.join(SRC, 'services/auditService'));
  let salePosted = false;
  accountingService.recordSale = async () => { salePosted = true; };
  stockLedgerService.recordSaleOut = async () => {};
  auditService.log = async () => {};
  appended.length = 0;

  const dms = [];
  erpBusModule.registerListeners({ sendMessage: async (chatId, text) => { dms.push({ chatId: String(chatId), text }); } });
  erpBusModule.bus.emit('sale', { customer: 'GHOST BUYER', userId: '4242', txnId: 'T-1' });
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(salePosted, true, 'the ledger entry is never sacrificed');
  assert.equal(appended.length, 0, 'door #1: findOrCreate is GONE — nothing created');
  assert.ok(dms.some((d) => d.chatId === '777' && /GHOST BUYER/.test(d.text)),
    'the admin hears about the unknown name in real time');
});
