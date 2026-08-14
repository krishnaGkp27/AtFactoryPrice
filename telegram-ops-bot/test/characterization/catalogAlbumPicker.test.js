'use strict';

/**
 * CAT-P1 (owner, 14-Aug-2026) — "2 product images are present for design
 * 9037. I want to see this 2 back to back for this design number."
 *
 * Drives the REAL shade picker. The layout the owner approved:
 *
 *   ┌──────────────────────────┐
 *   │ [ page 1 ] [ page 2 ]    │  one album bubble, back to back
 *   │ 📷 9037 — IDUMOTA · 2 pages│
 *   └──────────────────────────┘
 *   ┌──────────────────────────┐
 *   │ 📦 9037 in IDUMOTA        │  the picker, directly beneath
 *   │ Select shade:  [ … ]     │
 *   └──────────────────────────┘
 *
 * The split is forced by Telegram: an album cannot carry an inline
 * keyboard. So the pins that matter are that the buttons SURVIVE the split
 * (a picker with no shade buttons is a dead end), that a one-page design
 * keeps its tighter single-bubble combo, and that a failed album still
 * leaves the owner a working picker rather than an empty screen.
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
const ASSET = { design: '9037', shadeCount: 12, shades: [{ number: 1, name: 'White' }, { number: 2, name: 'Sky' }] };

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', subunit_label: 'Than', measure_unit: 'yards' });
designAssetsService.cacheTelegramFileId = async () => {};
designAssetsRepo.findActive = async () => ASSET;

/** 9037 in IDUMOTA with two shades in stock, so the picker is a real one. */
function seedStock() {
  const rows = [];
  for (const shade of ['1', '2']) {
    for (let i = 0; i < 3; i += 1) {
      rows.push({
        design: '9037', shade, warehouse: 'IDUMOTA', status: 'available',
        packageNo: `${shade}${i}`, productType: 'fabric', yards: 30,
      });
    }
  }
  inventoryRepository.getAll = async () => rows;
  sessionStore.set(UID, {
    type: 'supply_req_flow', warehouse: 'IDUMOTA', cart: [], step: 'design',
    productType: 'fabric', flowMessageId: 50,
  });
}

const pagePhoto = (n) => ({
  photo: `FILE_${n}`, photoSource: 'telegram_file_id', rowIndex: n + 1, design: '9037', page: n,
});

function shadeButtons(bot) {
  const withKb = bot.calls.filter((c) => ['sendPhoto', 'sendMessage', 'editMessageText'].includes(c.method)
    && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}

test('CAT-P1: a 2-page design sends ONE album, then the picker beneath it', async () => {
  seedStock();
  designAssetsService.getPhotosForSend = async () => [pagePhoto(1), pagePhoto(2)];
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:9037'));

  const albums = bot.calls.filter((c) => c.method === 'sendMediaGroup');
  assert.equal(albums.length, 1, 'both pages travel as one bubble');
  const media = albums[0].args.media || albums[0].args[1];
  assert.equal(media.length, 2, 'page 1 and page 2, back to back');
  assert.deepEqual(media.map((m) => m.media), ['FILE_1', 'FILE_2'], 'in page order');
  assert.match(String(media[0].caption), /9037.*IDUMOTA.*2 pages/,
    'the caption names the design, the place and how many pages');

  // The picker follows as its own message — and it MUST still carry buttons.
  const btns = shadeButtons(bot);
  assert.ok(btns.some((b) => b.callback_data.startsWith('srf_sh:9037|1')), 'shade 1 still tappable');
  assert.ok(btns.some((b) => b.callback_data.startsWith('srf_sh:9037|2')), 'shade 2 still tappable');
  assert.ok(btns.some((b) => b.callback_data === 'srf_back:design'), 'Back to designs survives');
  const texts = bot.callsTo('sendMessage');
  assert.match(String(texts[texts.length - 1].args.text), /Select shade/,
    'the picker keeps its prompt');
});

test('CAT-P1: the album ids are remembered so the pages get cleaned up', async () => {
  seedStock();
  designAssetsService.getPhotosForSend = async () => [pagePhoto(1), pagePhoto(2)];
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:9037'));
  const session = sessionStore.get(UID);
  assert.ok(Array.isArray(session._auxMsgIds) && session._auxMsgIds.length >= 2,
    'without this the album is stranded on screen when the flow moves on');
});

test('CAT-P1: a ONE-page design keeps the single photo+buttons bubble', async () => {
  seedStock();
  designAssetsService.getPhotosForSend = async () => [pagePhoto(1)];
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:9037'));

  assert.equal(bot.calls.filter((c) => c.method === 'sendMediaGroup').length, 0,
    'a one-item album would be a worse-looking version of what already works');
  const photos = bot.callsTo('sendPhoto');
  assert.equal(photos.length, 1);
  assert.ok(photos[0].args.opts.reply_markup, 'buttons ride ON the photo, as before');
});

test('CAT-P1: if the album send fails the owner still gets a usable picker', async () => {
  seedStock();
  designAssetsService.getPhotosForSend = async () => [pagePhoto(1), pagePhoto(2)];
  const bot = createFakeBot();
  bot.sendMediaGroup = async () => { throw new Error('Bad Request: media group failed'); };
  await controller.handleCallbackQuery(bot, cb('srf_dg:9037'));

  const btns = shadeButtons(bot);
  assert.ok(btns.some((b) => b.callback_data.startsWith('srf_sh:9037|')),
    'falls back to the single-photo combo rather than leaving a dead screen');
});
