'use strict';

/**
 * CART-PEEK (owner, 16-Sep-2026): "When I am selecting the design → shade →
 * quantity from the supply request, I am not able to see what I have
 * selected in the cart already. … keep on selecting the quantity, looking
 * at what I already have in my basket."
 *
 * Pinned: the basket block rides the DESIGN list, the SHADE picker (text
 * and photo-caption forms) and the QUANTITY card; it is the cart card's own
 * lines under a tally header; it is absent when the cart is empty; and on
 * the quantity card it sits above the question, never below it.
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

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', subunit_label: 'Than', measure_unit: 'yards' });
designAssetsRepo.findActive = async () => null;
designAssetsService.getPhotoForSend = async () => null;
designAssetsService.getPhotosForSend = async () => [];
designAssetsService.cacheTelegramFileId = async () => {};

function rowsFor(design, shades) {
  const out = [];
  for (const [shade, n] of Object.entries(shades)) {
    for (let i = 0; i < n; i += 1) out.push({ design, shade, warehouse: 'Lagos', status: 'available', packageNo: `${design}-${shade}-${i}`, productType: 'fabric' });
  }
  return out;
}
const CART = [{ design: '202/201', shade: '3', shadeName: 'Navy Blue', quantity: 2 }, { design: '9037', shade: '3', shadeName: '', quantity: 1 }];

function seed(step, cart) {
  sessionStore.set(UID, {
    type: 'supply_req_flow', warehouse: 'Lagos', cart: JSON.parse(JSON.stringify(cart)), step, productType: 'fabric',
    flowMessageId: 50, currentDesign: '202/201',
  });
}
/** Every text a screen could have been drawn with: message text or photo caption. */
function screens(bot) {
  return bot.calls
    .filter((c) => ['sendMessage', 'editMessageText', 'sendPhoto', 'editMessageCaption'].includes(c.method))
    .map((c) => c.args.text || c.args.caption || (c.args.opts && c.args.opts.caption) || '');
}
const last = (bot) => screens(bot).filter(Boolean).pop() || '';

test('CART-PEEK: the shade picker (text form) shows the basket under the shade list', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 }).concat(rowsFor('9037', { 3: 3 }));
  seed('design', CART);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:202/201'));
  const text = last(bot);
  assert.match(text, /Select shade:/, 'it is the shade picker');
  assert.match(text, /🛒 In cart · Σ 3B/, `tally header, got:\n${text}`);
  assert.match(text, /3 - Navy Blue · 2B/, 'the line already chosen, with its shade name');
  assert.match(text, /9037\n {2}• 3 · 1B/, 'the other design too');
});

test('CART-PEEK: the shade picker as a PHOTO carries the basket in its caption', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  designAssetsRepo.findActive = async () => ({ design: '202/201', shades: [] });
  designAssetsService.getPhotoForSend = async () => ({ photo: 'FAKE_FILE_ID', photoSource: 'telegram_file_id', rowIndex: 2 });
  try {
    seed('design', CART);
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('srf_dg:202/201'));
    const photo = bot.callsTo('sendPhoto').pop();
    assert.ok(photo, 'the picker went out as a photo combo');
    const caption = photo.args.opts.caption;
    assert.match(caption, /📷 \*202\/201\* — \*Lagos\*/, 'the header is untouched');
    assert.match(caption, /🛒 In cart · Σ 3B/, `caption carries the basket, got:\n${caption}`);
    assert.ok(caption.length <= 1024, `Telegram caption budget: ${caption.length}`);
  } finally {
    designAssetsRepo.findActive = async () => null;
    designAssetsService.getPhotoForSend = async () => null;
  }
});

test('CART-PEEK: the quantity card shows the basket ABOVE the question', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  seed('shade', CART);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_sh:202/201|1|5'));
  const text = last(bot);
  assert.match(text, /How many bales\?/, 'it is the quantity card');
  const peekAt = text.indexOf('🛒 In cart');
  const askAt = text.indexOf('How many');
  assert.ok(peekAt > -1, `basket on the quantity card, got:\n${text}`);
  assert.ok(peekAt < askAt, 'the question stays nearest the chips');
  assert.match(text, /3 - Navy Blue · 2B/, 'you can see what you already have of this design');
});

test('CART-PEEK: the design list shows the block, not a bare "N in cart"', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 }).concat(rowsFor('9037', { 3: 3 }));
  seed('shade', CART);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design'));
  const text = last(bot);
  assert.match(text, /Select design/, 'it is the design list');
  assert.match(text, /🛒 In cart · Σ 3B/, `got:\n${text}`);
  assert.doesNotMatch(text, /\d+ in cart/, 'the old count line is gone');
});

test('CART-PEEK: an empty cart shows nothing — no header, no "in cart"', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  seed('design', []);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:202/201'));
  assert.doesNotMatch(last(bot), /In cart/i);
  await controller.handleCallbackQuery(bot, cb('srf_sh:202/201|1|5'));
  assert.doesNotMatch(last(bot), /In cart/i);
});

test('CART-PEEK: the basket grows as lines are added, and the quantity card reflects it', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  seed('quantity', []);
  const s = sessionStore.get(UID); s.currentShade = '3'; s.currentShadeName = 'Navy Blue'; s.currentAvailPkgs = 4; sessionStore.set(UID, s);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_qty:2'));          // cart: 202/201 shade 3 ×2 → cart card
  await controller.handleCallbackQuery(bot, cb('srf_cart:add'));       // Add More → same design's shade picker
  assert.match(last(bot), /🛒 In cart · Σ 2B/, 'the picker now shows the line just added');
  await controller.handleCallbackQuery(bot, cb('srf_sh:202/201|1|5')); // pick shade 1 → quantity card
  const text = last(bot);
  assert.match(text, /How many bales\?/);
  assert.match(text, /3 - Navy Blue · 2B/, 'while choosing shade 1\'s quantity, shade 3\'s line is in view');
});

test('CART-PEEK: the typed Custom Quantity prompt keeps the basket in view too', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  seed('quantity', CART);
  const s = sessionStore.get(UID); s.currentShade = '1'; s.currentShadeName = 'White'; s.currentAvailPkgs = 5; sessionStore.set(UID, s);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_qty:__custom__'));
  const text = last(bot);
  assert.match(text, /Type the number of bales \(max 5\):/);
  assert.match(text, /🛒 In cart · Σ 3B/, `got:\n${text}`);
});
