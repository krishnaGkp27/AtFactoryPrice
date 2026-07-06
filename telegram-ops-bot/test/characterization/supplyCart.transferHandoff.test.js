'use strict';

/**
 * Supply cart → TRF-2 transfer wizard handoff, through the real controller:
 *   admin sees a 🚚 Transfer button on the cart; tapping it clears the
 *   supply session and starts the transfer wizard prefilled from the cart
 *   (warehouse always; design/shade/qty when the cart has exactly one line).
 *   Non-admins never see the button and are rejected on a direct tap.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,5555';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
productTypesRepo.pluralize = (label, n) => (n === 1 ? label : `${label}s`);
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
];

function invRow(pkg, wh = 'Lagos') {
  return { packageNo: pkg, design: '9006', shade: '3', warehouse: wh, status: 'available', productType: 'fabric', yards: 100, pricePerYard: 0 };
}
inventoryRepository.getAll = async () => [
  invRow('P1'), invRow('P2'), invRow('P3'),
  invRow('P9', 'Kano office'),
];

function cartLine(quantity, shade = '3') {
  return { design: '9006', shade, shadeName: '', quantity };
}
function seedCartSession(uid, cart) {
  sessionStore.clear(uid);
  sessionStore.set(uid, { type: 'supply_req_flow', step: 'cart', warehouse: 'Lagos', productType: 'fabric', cart });
}
function cb(data, uid) { return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 60 } }; }
function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat().map((b) => `${b.text}|${b.callback_data}`) : [];
}

test('admin cart summary shows the 🚚 Transfer button', async () => {
  seedCartSession('777', [cartLine(2)]);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cart:back', 777));
  assert.ok(lastKb(bot).includes('🚚 Transfer|srf_cart:transfer'), 'admin sees Transfer button');
});

test('non-admin cart summary hides the 🚚 Transfer button', async () => {
  seedCartSession('4242', [cartLine(2)]);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cart:back', 4242));
  const kb = lastKb(bot);
  assert.ok(kb.length, 'cart keyboard rendered');
  assert.ok(!kb.some((b) => b.includes('srf_cart:transfer')), 'no Transfer button for non-admin');
});

test('single-line cart: handoff lands on destination with design/shade/qty prefilled', async () => {
  seedCartSession('777', [cartLine(2)]);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cart:transfer', 777));
  const session = sessionStore.get('777');
  assert.equal(session.type, 'transfer_flow');
  assert.deepEqual(
    { from: session.from, design: session.design, shade: session.shade, qty: session.qty, step: session.step },
    { from: 'Lagos', design: '9006', shade: '3', qty: 2, step: 'dest' },
  );
  assert.match(bot.allText(), /To which warehouse\?/);
  assert.ok(lastKb(bot).some((b) => b.includes('trf:dest:')), 'destination picker shown');
});

test('multi-line cart: handoff prefills warehouse only and lands on design picker', async () => {
  seedCartSession('777', [cartLine(1), cartLine(1, '5')]);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cart:transfer', 777));
  const session = sessionStore.get('777');
  assert.equal(session.type, 'transfer_flow');
  assert.equal(session.from, 'Lagos');
  assert.equal(session.step, 'design');
  assert.match(bot.allText(), /Pick a design/);
});

test('cart qty above availability falls back to the qty screen', async () => {
  seedCartSession('777', [cartLine(99)]);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cart:transfer', 777));
  const session = sessionStore.get('777');
  assert.equal(session.type, 'transfer_flow');
  assert.equal(session.step, 'qty');
  assert.match(bot.allText(), /How many bales to transfer\?/);
});

test('non-admin direct tap on srf_cart:transfer is rejected, cart re-shown', async () => {
  seedCartSession('4242', [cartLine(2)]);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cart:transfer', 4242));
  assert.match(bot.allText(), /admins only/i);
  const session = sessionStore.get('4242');
  assert.equal(session && session.type, 'supply_req_flow', 'supply session preserved');
});
