'use strict';

/**
 * SRF-ADD (owner, 11-Sep-2026) — "➕ Add More" on the supply cart returns
 * to the shade picker of the design just added, so a second shade of the
 * same design is one tap away, instead of dropping the user on the
 * fifteen-button design list. The shade picker gains "🛒 Back to cart".
 *
 * Falls back to the design list (the old behaviour) when the design has
 * fewer than two shades left net of the cart — a single remaining shade
 * would auto-skip to its quantity card and read as a loop — and after
 * "Back to designs" (the user left that design on purpose).
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
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const designAssetsRepo = require(path.join(SRC, 'repositories/designAssetsRepository'));
const designAssetsService = require(path.join(SRC, 'services/designAssetsService'));

const UID = '4242';
const CART_MSG = 50;

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', subunit_label: 'Than', measure_unit: 'yards' });
designAssetsRepo.findActive = async () => null;
designAssetsService.getPhotoForSend = async () => null;
designAssetsService.getPhotosForSend = async () => [];
designAssetsService.cacheTelegramFileId = async () => {};

function inv(rows) { inventoryRepository.getAll = async () => rows; }
function rowsFor(design, shades) {
  const out = [];
  for (const [shade, n] of Object.entries(shades)) {
    for (let i = 0; i < n; i += 1) out.push({ design, shade, warehouse: 'Lagos', status: 'available', packageNo: `${design}-${shade}-${i}`, productType: 'fabric' });
  }
  return out;
}
function seedAtQuantity(design, shade, avail) {
  sessionStore.set(UID, {
    type: 'supply_req_flow', warehouse: 'Lagos', cart: [], step: 'quantity', productType: 'fabric',
    flowMessageId: CART_MSG, currentDesign: design, currentShade: shade, currentAvailPkgs: avail,
  });
}
const msg = (text) => ({ from: { id: UID }, chat: { id: UID }, text });
function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendPhoto', 'sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}
const cbs = (bot) => lastKb(bot).map((b) => b.callback_data);

test('Add More after adding a shade re-opens the SAME design\'s shade picker, cart-adjusted, with Back to cart', async () => {
  inv(rowsFor('202/201', { 1: 5, 3: 4 }));
  seedAtQuantity('202/201', '1', 5);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_qty:2'));
  assert.deepEqual(sessionStore.get(UID).cart.map((c) => [c.design, c.shade, c.quantity]), [['202/201', '1', 2]]);
  assert.match(bot.allText(), /Supply Cart/);

  await controller.handleCallbackQuery(bot, cb('srf_cart:add'));
  const k = cbs(bot);
  assert.ok(k.includes('srf_sh:202/201|3|4'), `shade 3 offered at full stock: ${k}`);
  assert.ok(k.includes('srf_sh:202/201|1|3'), `shade 1 offered net of the 2 in the cart: ${k}`);
  assert.ok(!k.some((c) => c.startsWith('srf_dg:')), 'must NOT be the design list');
  assert.ok(k.includes('srf_back:design'), 'Back to designs still there');
  assert.ok(k.includes('srf_back:cart'), 'Back to cart added because the cart has items');
  assert.equal(sessionStore.get(UID).step, 'shade');
  assert.ok(bot.callsTo('deleteMessage').some((c) => c.args.messageId === CART_MSG), 'the cart card is deleted, not stranded');
});

test('single-shade design: Add More falls back to the design list (no shade step to return to)', async () => {
  inv(rowsFor('16040', { Black: 8 }));
  seedAtQuantity('16040', 'Black', 8);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_qty:3'));
  await controller.handleCallbackQuery(bot, cb('srf_cart:add'));
  const k = cbs(bot);
  assert.ok(k.includes('srf_dg:16040'), `design list expected: ${k}`);
  assert.ok(!k.some((c) => c.startsWith('srf_sh:')), 'no shade picker for a single-shade design');
});

test('only one shade left after the add: design list, never a loop into the quantity card', async () => {
  inv(rowsFor('202/201', { 1: 5, 3: 1 }));
  seedAtQuantity('202/201', '3', 1);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_qty:1'));
  await controller.handleCallbackQuery(bot, cb('srf_cart:add'));
  const k = cbs(bot);
  assert.ok(k.includes('srf_dg:202/201'), `design list expected: ${k}`);
  assert.ok(!k.some((c) => c.startsWith('srf_sh:') || c.startsWith('srf_qty:')));
});

test('Back to designs forgets the design: a later Add More shows the design list', async () => {
  inv(rowsFor('202/201', { 1: 5, 3: 4 }));
  seedAtQuantity('202/201', '1', 5);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_qty:2'));
  await controller.handleCallbackQuery(bot, cb('srf_back:design'));
  await controller.handleCallbackQuery(bot, cb('srf_back:cart'));
  await controller.handleCallbackQuery(bot, cb('srf_cart:add'));
  const k = cbs(bot);
  assert.ok(k.includes('srf_dg:202/201'), `design list expected: ${k}`);
  assert.ok(!k.some((c) => c.startsWith('srf_sh:')));
});

test('typed custom quantity also remembers the design for Add More', async () => {
  inv(rowsFor('202/201', { 1: 5, 3: 4 }));
  seedAtQuantity('202/201', '3', 4);
  const s = sessionStore.get(UID); s.step = 'custom_quantity'; sessionStore.set(UID, s);
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('2'));
  assert.deepEqual(sessionStore.get(UID).cart.map((c) => [c.shade, c.quantity]), [['3', 2]]);
  await controller.handleCallbackQuery(bot, cb('srf_cart:add'));
  const k = cbs(bot);
  assert.ok(k.includes('srf_sh:202/201|3|2'), `shade 3 net of cart: ${k}`);
  assert.ok(k.includes('srf_sh:202/201|1|5'), `shade 1 untouched: ${k}`);
});

test('Back to cart from a photo shade picker deletes the combo and shows the cart', async () => {
  inv(rowsFor('202/201', { 1: 5, 3: 4 }));
  designAssetsRepo.findActive = async () => ({ design: '202/201', shades: [] });
  designAssetsService.getPhotoForSend = async () => ({ photo: 'FAKE_FILE_ID', photoSource: 'telegram_file_id', rowIndex: 2 });
  try {
    seedAtQuantity('202/201', '1', 5);
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('srf_qty:2'));
    await controller.handleCallbackQuery(bot, cb('srf_cart:add'));
    const combo = bot.callsTo('sendPhoto');
    assert.equal(combo.length, 1, 'shade picker is the photo combo');
    const comboId = sessionStore.get(UID).previewMessageId;
    assert.ok(comboId, 'combo tracked on the session');
    assert.ok(cbs(bot).includes('srf_back:cart'));

    await controller.handleCallbackQuery(bot, cb('srf_back:cart'));
    assert.ok(bot.callsTo('deleteMessage').some((c) => c.args.messageId === comboId), 'combo deleted before the cart card');
    assert.equal(sessionStore.get(UID).previewMessageId, null);
    assert.equal(sessionStore.get(UID).step, 'cart');
    const texts = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).map((c) => c.args.text);
    assert.match(texts[texts.length - 1], /Supply Cart/);
  } finally {
    designAssetsRepo.findActive = async () => null;
    designAssetsService.getPhotoForSend = async () => null;
  }
});

test('an empty cart: the shade picker carries no Back to cart', async () => {
  inv(rowsFor('202/201', { 1: 5, 3: 4 }));
  sessionStore.set(UID, { type: 'supply_req_flow', warehouse: 'Lagos', cart: [], step: 'design', productType: 'fabric', flowMessageId: CART_MSG });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:202/201'));
  const k = cbs(bot);
  assert.ok(k.includes('srf_back:design'));
  assert.ok(!k.includes('srf_back:cart'));
});
