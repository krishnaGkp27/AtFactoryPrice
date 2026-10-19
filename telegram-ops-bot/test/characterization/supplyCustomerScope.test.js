'use strict';
// CUS-3 — the supply request's customer step offers the STORE's customers
// (Customers column N), buyers first, 🆕 last, 🌐 All customers as the door out.
process.env.ADMIN_IDS = '777';
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

const CUST_HEADER = ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases', 'stores', 'first_sale_at'];
const cust = (id, name, stores, first) => [id, name, '', '', 'Retail', 0, 0, 'COD', '', 'Active', '', '', '[]', stores, first];
installFakeSheets(createFakeSheets({
  Customers: [CUST_HEADER,
    cust('c1', 'Kafaya', 'Lagos, IDUMOTA', '2026-08-01'),
    cust('c2', 'ABBA', 'Kano office', '2026-07-03'),
    cust('c3', 'Musa Textiles', 'Kano office', ''),
    cust('c4', 'Unplaced Ltd', '', ''),
  ],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
inventoryRepository.getAll = async () => [];

function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  return withKb.length ? withKb[withKb.length - 1].args.opts.reply_markup.inline_keyboard.flat().map((b) => b.text) : [];
}
const lastText = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).pop().args.text;

test('at Kano office: ABBA, then 🆕 Musa Textiles and the unplaced one; Kafaya absent; 🌐 All customers brings everyone', async () => {
  sessionStore.set('777', { type: 'supply_req_flow', step: 'cart', warehouse: 'Kano office', arrivalBatch: '', cart: [{ design: '9006', shade: '2', quantity: 1 }], _scopeWarehouses: [], flowMessageId: 50 });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:customer', '777', 50));
  assert.match(lastText(bot), /^👤 Select customer · 🏭 Kano office$/);
  const chips = lastKb(bot);
  assert.deepEqual(chips.slice(0, 3), ['👤 ABBA', '🆕 Musa Textiles', '🆕 Unplaced Ltd']);
  assert.ok(!chips.some((t) => /Kafaya/.test(t)), `Kafaya buys in Lagos, not offered at Kano: ${chips}`);
  assert.ok(chips.includes('🌐 All customers'));

  await controller.handleCallbackQuery(bot, cb('srf_cu:__all__', '777', 50));
  assert.match(lastText(bot), /every store/);
  const all = lastKb(bot);
  assert.deepEqual(all.slice(0, 4), ['👤 ABBA', '👤 Kafaya', '🆕 Musa Textiles', '🆕 Unplaced Ltd'], `everyone, buyers first: ${all}`);
});

test('at Lagos: Kafaya and the unplaced one; nobody from Kano', async () => {
  sessionStore.set('777', { type: 'supply_req_flow', step: 'cart', warehouse: 'Lagos', arrivalBatch: '', cart: [{ design: '9006', shade: '2', quantity: 1 }], _scopeWarehouses: [], flowMessageId: 50 });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:customer', '777', 50));
  const chips = lastKb(bot);
  assert.deepEqual(chips.slice(0, 2), ['👤 Kafaya', '🆕 Unplaced Ltd'], String(chips));
  assert.ok(!chips.some((t) => /ABBA|Musa/.test(t)));
});
