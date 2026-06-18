'use strict';

/**
 * Supply flow — single-shade designs (a) show the catalog photo on the quantity
 * step, and (b) offer "Back to designs" (not the looping "Back to shades").
 * Multi-shade designs keep "Back to shades".
 *
 * Bug history: single-shade designs auto-skip the shade picker, so they were
 * photo-less AND their "Back to shades" button looped to the same page.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

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
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const designAssetsRepo = require(path.join(SRC, 'repositories/designAssetsRepository'));
const designAssetsService = require(path.join(SRC, 'services/designAssetsService'));

const UID = '4242';

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', subunit_label: 'Than', measure_unit: 'yards' });
designAssetsRepo.findActive = async () => null;
designAssetsService.cacheTelegramFileId = async () => {};

function inv(rows) { inventoryRepository.getAll = async () => rows; }
function rowsFor(design, shades) {
  const out = [];
  for (const [shade, n] of Object.entries(shades)) {
    for (let i = 0; i < n; i += 1) out.push({ design, shade, warehouse: 'Lagos', status: 'available', packageNo: `${shade}${i}`, productType: 'fabric' });
  }
  return out;
}
function seed() {
  sessionStore.set(UID, { type: 'supply_req_flow', warehouse: 'Lagos', cart: [], step: 'design', productType: 'fabric', flowMessageId: 50 });
}
function cb(data) { return { id: 'cb', data, from: { id: UID }, message: { chat: { id: UID }, message_id: 50 } }; }
function lastKeyboardCallbacks(bot) {
  const withKb = bot.calls.filter((c) => ['sendPhoto', 'sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  const kb = last ? last.args.opts.reply_markup.inline_keyboard : [];
  return kb.flat().map((b) => b.callback_data);
}

test('single-shade design: photo on quantity step + "Back to designs"', async () => {
  inv(rowsFor('16040', { Black: 8 }));
  designAssetsService.getPhotoForSend = async () => ({ photo: 'FAKE_FILE_ID', photoSource: 'telegram_file_id', rowIndex: 2 });
  seed();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:16040'));
  const photos = bot.callsTo('sendPhoto');
  assert.equal(photos.length, 1, 'expected the catalog photo');
  assert.match(photos[0].args.opts.caption, /16040/);
  assert.match(photos[0].args.opts.caption, /How many .*to supply/i);
  const cbs = lastKeyboardCallbacks(bot);
  assert.ok(cbs.includes('srf_back:design'), 'single-shade must offer Back to designs');
  assert.ok(!cbs.includes('srf_back:shade'), 'single-shade must NOT loop via Back to shades');
});

test('single-shade design with no photo: text picker + "Back to designs"', async () => {
  inv(rowsFor('16040', { Black: 8 }));
  designAssetsService.getPhotoForSend = async () => null;
  seed();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:16040'));
  assert.equal(bot.callsTo('sendPhoto').length, 0);
  assert.match(bot.allText(), /How many .*to supply/i);
  const cbs = lastKeyboardCallbacks(bot);
  assert.ok(cbs.includes('srf_back:design'));
  assert.ok(!cbs.includes('srf_back:shade'));
});

test('tapping "Back to designs" from a single-shade quantity step shows the design picker', async () => {
  inv(rowsFor('16040', { Black: 8 }));
  designAssetsService.getPhotoForSend = async () => null;
  seed();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:16040'));     // → single-shade quantity
  await controller.handleCallbackQuery(bot, cb('srf_back:design'));  // → design picker
  // The design picker lists designs as srf_dg:* buttons.
  assert.ok(lastKeyboardCallbacks(bot).some((c) => /^srf_dg:/.test(c)), 'should land on the design picker');
});

test('multi-shade design keeps "Back to shades" on the quantity step', async () => {
  inv(rowsFor('20000', { Red: 2, Blue: 1 }));
  designAssetsService.getPhotoForSend = async () => null;
  seed();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:20000'));       // → shade picker (2 shades)
  await controller.handleCallbackQuery(bot, cb('srf_sh:20000|Red|2')); // pick a shade → quantity
  const cbs = lastKeyboardCallbacks(bot);
  assert.ok(cbs.includes('srf_back:shade'), 'multi-shade quantity offers Back to shades');
  assert.ok(!cbs.includes('srf_back:design'), 'multi-shade should not use Back to designs here');
});
