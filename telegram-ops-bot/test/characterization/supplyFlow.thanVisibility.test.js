'use strict';

/**
 * TV-1 — than-count visibility for configured warehouses (Supply Request).
 *
 * Warehouses listed in Settings THAN_VISIBILITY_WAREHOUSES (default
 * "Kano office") show THAN counts in the design list, the shade buttons
 * and the "Take ALL" shortcut; every other warehouse keeps bale counts.
 * Display-only: srf_sh callback payloads stay in bales.
 *
 * Fixture: design 9043B in two shades —
 *   cream: bale P1 (3 thans) + bale P2 (2 thans)  → 2 bales / 5 thans
 *   ash:   bale P3 (4 thans)                      → 1 bale  / 4 thans
 *
 * Drives the real controller; sheets/intent/bot are faked.
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
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const unitDisplayService = require(path.join(SRC, 'services/unitDisplayService'));

const UID = '4242';

productTypesRepo.getLabels = async () => ({
  container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards',
});
designAssetsRepo.findActive = async () => null;
settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: 'Kano office' });
unitDisplayService.invalidateCache();

/** One row per than; thans of the same bale share a packageNo. */
function fixtureRows(warehouse) {
  const mk = (pkg, shade, n) => Array.from({ length: n }, () => ({
    design: '9043B', shade, warehouse, status: 'available', packageNo: pkg, productType: 'fabric',
  }));
  return [...mk('P1', 'cream', 3), ...mk('P2', 'cream', 2), ...mk('P3', 'ash', 4)];
}
function seed(warehouse) {
  sessionStore.set(UID, { type: 'supply_req_flow', warehouse, cart: [], step: 'design', productType: 'fabric', flowMessageId: 50 });
}
function cb(data) { return { id: 'cb', data, from: { id: UID }, message: { chat: { id: UID }, message_id: 50 } }; }
function lastKeyboardTexts(bot) {
  const withKb = bot.calls.filter((c) => ['sendPhoto', 'sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  const kb = last ? last.args.opts.reply_markup.inline_keyboard : [];
  return kb.flat().map((b) => b.text);
}
function lastKeyboardCallbacks(bot) {
  const withKb = bot.calls.filter((c) => ['sendPhoto', 'sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  const kb = last ? last.args.opts.reply_markup.inline_keyboard : [];
  return kb.flat().map((b) => b.callback_data);
}

test('Kano office: shade buttons + Take ALL show THAN counts', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Kano office');
  seed('Kano office');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:9043B'));
  const texts = lastKeyboardTexts(bot);
  assert.ok(texts.some((t) => t.includes('cream (5 thans)')), `cream shows 5 thans, got: ${texts}`);
  assert.ok(texts.some((t) => t.includes('ash (4 thans)')), `ash shows 4 thans, got: ${texts}`);
  assert.ok(texts.some((t) => t.includes('Take ALL 2 shades (9 thans)')), `Take ALL shows 9 thans, got: ${texts}`);
  // Display-only: the shade callback payload still carries the BALE count.
  const cbs = lastKeyboardCallbacks(bot);
  assert.ok(cbs.includes('srf_sh:9043B|cream|2'), 'cream callback still carries 2 bales');
  assert.ok(cbs.includes('srf_sh:9043B|ash|1'), 'ash callback still carries 1 bale');
});

test('Kano office: design list shows THAN totals', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Kano office');
  seed('Kano office');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design'));
  const texts = lastKeyboardTexts(bot);
  assert.ok(texts.some((t) => t.includes('9043B (9 thans)')), `design tile shows 9 thans, got: ${texts}`);
});

test('Lagos (unflagged): everything stays in BALES', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Lagos');
  seed('Lagos');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:9043B'));
  const texts = lastKeyboardTexts(bot);
  assert.ok(texts.some((t) => t.includes('cream (2 bales)')), `cream shows 2 bales, got: ${texts}`);
  assert.ok(texts.some((t) => t.includes('ash (1 bale)')), `ash shows 1 bale, got: ${texts}`);
  assert.ok(texts.some((t) => t.includes('Take ALL 2 shades (3 bales)')), `Take ALL shows 3 bales, got: ${texts}`);

  const bot2 = createFakeBot();
  seed('Lagos');
  await controller.handleCallbackQuery(bot2, cb('srf_back:design'));
  const designTexts = lastKeyboardTexts(bot2);
  assert.ok(designTexts.some((t) => t.includes('9043B (3 bls)')), `design tile shows 3 bls, got: ${designTexts}`);
});
