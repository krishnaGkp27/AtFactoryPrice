'use strict';

/**
 * WH-SUM — warehouse totals under the Supply Request design-picker header.
 *
 *   📦 Warehouse: Lagos
 *   📊 Total: 3 bales · 💰 ₦45,000     ← value part ADMIN-ONLY
 *
 * - unit total for everyone (thans on TV-1 warehouses, bales elsewhere)
 * - stock value (yards × price of the listed bales) only for admins
 *
 * Fixture: 3 bales / 9 thans, every than 50 yd @ 100 → total value 45,000.
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

productTypesRepo.getLabels = async () => ({
  container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards',
});
designAssetsRepo.findActive = async () => null;
settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: 'Kano office' });
unitDisplayService.invalidateCache();

function fixtureRows(warehouse) {
  const mk = (pkg, shade, n) => Array.from({ length: n }, () => ({
    design: '9043B', shade, warehouse, status: 'available', packageNo: pkg,
    productType: 'fabric', yards: 50, pricePerYard: 100,
  }));
  return [...mk('P1', 'cream', 3), ...mk('P2', 'cream', 2), ...mk('P3', 'ash', 4)];
}
function seed(uid, warehouse) {
  sessionStore.set(uid, { type: 'supply_req_flow', warehouse, cart: [], step: 'design', productType: 'fabric', flowMessageId: 50 });
}
function cb(data, uid) {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 50 } };
}
function headerText(bot) {
  const edits = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)
    && /Warehouse:/.test(c.args.text || ''));
  return edits.length ? edits[edits.length - 1].args.text : '';
}

test('admin on Lagos: header shows total bales AND stock value', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Lagos');
  seed('777', 'Lagos');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design', 777));
  const text = headerText(bot);
  assert.match(text, /Total: 3 bales/, `got: ${text}`);
  assert.match(text, /45,000/, `value shown for admin, got: ${text}`);
});

test('employee on Lagos: header shows total bales, NO value', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Lagos');
  seed('4242', 'Lagos');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design', 4242));
  const text = headerText(bot);
  assert.match(text, /Total: 3 bales/, `got: ${text}`);
  assert.ok(!/45,000|💰/.test(text), `value hidden from employee, got: ${text}`);
});

test('Kano office (TV-1 warehouse): header total is in THANS', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Kano office');
  seed('777', 'Kano office');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design', 777));
  const text = headerText(bot);
  assert.match(text, /Total: 9 thans/, `got: ${text}`);
  assert.match(text, /45,000/, `admin value still shown, got: ${text}`);
});
