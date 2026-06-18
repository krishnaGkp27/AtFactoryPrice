'use strict';

/**
 * Supply flow — single-shade designs must show the catalog photo too.
 *
 * Bug: multi-shade designs render the photo on the shade picker, but a
 * single-shade design auto-skips that step and landed on a TEXT-only quantity
 * picker — so its image never showed (reported for design 16040, 1 shade).
 * Fix: the single-shade branch asks the quantity picker to carry the photo.
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
designAssetsRepo.findActive = async () => null; // name map empty; photo comes via getPhotoForSend

// One design, ONE shade, 8 bales available in Lagos.
inventoryRepository.getAll = async () => {
  const rows = [];
  for (let i = 1; i <= 8; i += 1) {
    rows.push({ design: '16040', shade: 'Black', warehouse: 'Lagos', status: 'available', packageNo: `B${i}`, productType: 'fabric' });
  }
  return rows;
};

function seedSupplySession() {
  sessionStore.set(UID, {
    type: 'supply_req_flow', warehouse: 'Lagos', cart: [],
    step: 'design', productType: 'fabric', flowMessageId: 50,
  });
}
function tapDesign() {
  return { id: 'cb', data: 'srf_dg:16040', from: { id: UID }, message: { chat: { id: UID }, message_id: 50 } };
}

test('single-shade design shows the catalog photo on the quantity step', async () => {
  designAssetsService.getPhotoForSend = async () => ({ photo: 'FAKE_FILE_ID', photoSource: 'telegram_file_id', rowIndex: 2 });
  designAssetsService.cacheTelegramFileId = async () => {};
  seedSupplySession();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, tapDesign());
  const photos = bot.callsTo('sendPhoto');
  assert.equal(photos.length, 1, 'expected the catalog photo on a single-shade quantity step');
  assert.equal(photos[0].args.photo, 'FAKE_FILE_ID');
  assert.match(photos[0].args.opts.caption, /16040/);
  assert.match(photos[0].args.opts.caption, /How many .*to supply/i);
});

test('single-shade design with NO catalog photo falls back to the text picker', async () => {
  designAssetsService.getPhotoForSend = async () => null;
  seedSupplySession();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, tapDesign());
  assert.equal(bot.callsTo('sendPhoto').length, 0, 'no photo when there is no asset');
  assert.match(bot.allText(), /How many .*to supply/i);
});
