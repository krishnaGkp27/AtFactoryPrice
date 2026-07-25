'use strict';

/**
 * SEC (nav/SoC audit 24-Jul) — srf_wh: scope guard.
 *
 * Telegram clients can send arbitrary callback_data, and srf_wh: used to
 * REBUILD an expired supply session from nothing with whatever warehouse
 * name arrived — with no check that the user may see it. Combined with the
 * TV-4/5/6 display work that now exposes opening balances, sold-out
 * assortment and the in-transit pipeline, a replayed tap leaked another
 * warehouse's history. The handler now validates the warehouse against the
 * user's supply scope (marketing-group pin, else Users.warehouses); admins
 * stay unscoped.
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
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const designAssetsRepo = require(path.join(SRC, 'repositories/designAssetsRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const marketerOverlay = require(path.join(SRC, 'services/marketerOverlay'));

const EMPLOYEE = '4242';   // assigned to Lagos only
const ADMIN = '777';

productTypesRepo.getLabels = async () => ({
  container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards',
});
designAssetsRepo.findActive = async () => null;
settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: 'Kano office' });
marketerOverlay.getGroupWarehouses = async () => [];

usersRepository.findByUserId = async (uid) => (String(uid) === EMPLOYEE
  ? { user_id: EMPLOYEE, name: 'Abdul', role: 'employee', warehouses: ['Lagos'], status: 'active' }
  : { user_id: String(uid), name: 'Owner', role: 'admin', warehouses: [], status: 'active' });

inventoryRepository.getAll = async () => ([
  { design: '9006', shade: 'black', warehouse: 'Kano office', status: 'available', packageNo: 'K1', productType: 'fabric' },
  { design: '9043B', shade: 'cream', warehouse: 'Lagos', status: 'available', packageNo: 'L1', productType: 'fabric' },
]);

function texts(bot) {
  return bot.calls
    .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method))
    .map((c) => c.args.text)
    .join('\n');
}

test('SEC: replayed srf_wh: for a foreign warehouse is refused (no session)', async () => {
  sessionStore.clear(EMPLOYEE);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_wh:Kano office', EMPLOYEE));
  assert.match(texts(bot), /not in your supply scope/i, 'refusal shown');
  const s = sessionStore.get(EMPLOYEE);
  assert.ok(!s || s.warehouse !== 'Kano office', 'foreign warehouse never lands on the session');
  sessionStore.clear(EMPLOYEE);
});

test('SEC: the user\'s OWN warehouse still opens normally', async () => {
  sessionStore.clear(EMPLOYEE);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_wh:Lagos', EMPLOYEE));
  assert.doesNotMatch(texts(bot), /not in your supply scope/i, 'no refusal for an assigned warehouse');
  const s = sessionStore.get(EMPLOYEE);
  assert.equal(s && s.warehouse, 'Lagos', 'warehouse stamped on the session');
  sessionStore.clear(EMPLOYEE);
});

test('SEC: admins stay unscoped', async () => {
  sessionStore.clear(ADMIN);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_wh:Kano office', ADMIN));
  assert.doesNotMatch(texts(bot), /not in your supply scope/i, 'admin may browse any warehouse');
  const s = sessionStore.get(ADMIN);
  assert.equal(s && s.warehouse, 'Kano office');
  sessionStore.clear(ADMIN);
});
