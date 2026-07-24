'use strict';

/**
 * WH-SUM — warehouse totals under the Supply Request design-picker header.
 *
 *   📦 Warehouse: Lagos
 *   📊 Total: 3B / 4B · 💰 ₦45,000     ← value part ADMIN-ONLY
 *
 * - unit total for everyone as the "remaining / opening" pair (TV-4/TV-5):
 *   TV-1 warehouses pair both counts ("3B=9t / 4B=12t", TV-4b compact),
 *   every other warehouse pairs the bale figures only ("3B / 4B", TV-5)
 * - stock value (yards × price of the listed AVAILABLE bales) only for admins
 *
 * Fixture: 3 bales / 9 thans available, every than 50 yd @ 100 → value
 * 45,000; plus one SOLD bale (3 thans) → opening 4B = 12t, value unchanged.
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
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const unitDisplayService = require(path.join(SRC, 'services/unitDisplayService'));

productTypesRepo.getLabels = async () => ({
  container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards',
});
designAssetsRepo.findActive = async () => null;
settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: 'Kano office' });
unitDisplayService.invalidateCache();

function fixtureRows(warehouse) {
  const mk = (pkg, shade, n, status = 'available') => Array.from({ length: n }, () => ({
    design: '9043B', shade, warehouse, status, packageNo: pkg,
    productType: 'fabric', yards: 50, pricePerYard: 100,
  }));
  return [
    ...mk('P1', 'cream', 3), ...mk('P2', 'cream', 2), ...mk('P3', 'ash', 4),
    // Sold bale: counts toward OPENING only — never bales, value, or the
    // unflagged-warehouse totals.
    ...mk('P4', 'cream', 3, 'sold'),
  ];
}
function seed(uid, warehouse) {
  sessionStore.set(uid, { type: 'supply_req_flow', warehouse, cart: [], step: 'design', productType: 'fabric', flowMessageId: 50 });
}
function headerText(bot) {
  const edits = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)
    && /Warehouse:/.test(c.args.text || ''));
  return edits.length ? edits[edits.length - 1].args.text : '';
}

test('admin on Lagos: header shows bales remaining / opening AND stock value (TV-5)', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Lagos');
  seed('777', 'Lagos');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design', 777));
  const text = headerText(bot);
  assert.match(text, /Total: 3B \/ 4B/, `bales-only pair (sold bale counted in opening), got: ${text}`);
  assert.match(text, /45,000/, `value shown for admin, got: ${text}`);
});

test('employee on Lagos: header shows bales remaining / opening, NO value', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Lagos');
  seed('4242', 'Lagos');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design', 4242));
  const text = headerText(bot);
  assert.match(text, /Total: 3B \/ 4B/, `got: ${text}`);
  assert.ok(!/45,000|💰/.test(text), `value hidden from employee, got: ${text}`);
});

test('Kano office (TV-1 warehouse): header total is remaining / opening B = t', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Kano office');
  seed('777', 'Kano office');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design', 777));
  const text = headerText(bot);
  assert.match(text, /Total: 3B=9t \/ 4B=12t/, `remaining / opening pair (TV-4b compact), got: ${text}`);
  assert.match(text, /45,000/, `admin value still shown (available rows only), got: ${text}`);
  assert.match(text, /_\(remaining \/ opening\)_/, `legend shown, got: ${text}`);
});

test('Lagos (bales-only): sold bale counts in OPENING only; legend + value stay correct (TV-5)', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Lagos');
  seed('777', 'Lagos');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design', 777));
  const text = headerText(bot);
  // remaining excludes the sold bale; opening includes it; no than figures.
  assert.match(text, /Total: 3B \/ 4B/, `remaining excludes sold, opening includes it, got: ${text}`);
  assert.ok(!/=\d+t/.test(text), `no than figures on a bales-only warehouse, got: ${text}`);
  assert.match(text, /_\(remaining \/ opening\)_/, `legend shown on bales-only warehouse too, got: ${text}`);
  assert.match(text, /45,000/, `admin value still computed from AVAILABLE rows only, got: ${text}`);
});
