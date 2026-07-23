'use strict';

/**
 * TV-2 — Warehouse Display Units flow (bales ⇄ thans behind admin approval).
 *
 * Drives the real controller:
 *   act:display_units → warehouse list with current modes
 *   udf:wh:<i>        → confirm card with from/to
 *   udf:req           → queues set_unit_display approval + notifies admins
 * Gate: admins + managers may request; employees are refused.
 * Duplicate pending requests for the same warehouse are blocked.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,5555';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, lastKb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const unitDisplayService = require(path.join(SRC, 'services/unitDisplayService'));

inventoryRepository.getWarehouses = async () => ['Lagos', 'Kano office'];
settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: 'Kano office' });
auditLogRepository.append = async () => {};


/** Reset stubs + capture queue/notify per test. */
function arm({ pending = [] } = {}) {
  unitDisplayService.invalidateCache();
  const captured = { queued: [], notified: [] };
  approvalQueueRepository.getAllPending = async () => pending;
  approvalQueueRepository.append = async (rec) => { captured.queued.push(rec); };
  approvalEvents.notifyAdminsApprovalRequest = async (bot, requestId, userLabel, summary, reason, excludeId) => {
    captured.notified.push({ requestId, userLabel, summary, excludeId });
  };
  return captured;
}

test('admin: list shows current modes, confirm proposes the inverse, request queues + notifies (self excluded)', async () => {
  const captured = arm();
  sessionStore.clear('777');
  const bot = createFakeBot();

  await controller.handleCallbackQuery(bot, cb('act:display_units', 777));
  const tiles = lastKb(bot).map((b) => b.text);
  assert.ok(tiles.some((t) => t.includes('Lagos — bales')), `Lagos listed as bales, got ${tiles}`);
  assert.ok(tiles.some((t) => t.includes('Kano office — thans')), `Kano listed as thans, got ${tiles}`);

  // Kano office is index 1 (list order from getWarehouses stub).
  await controller.handleCallbackQuery(bot, cb('udf:wh:1', 777));
  assert.match(bot.allText(), /Current display: \*THANS\*/);
  assert.match(bot.allText(), /Switch to: \*BALES\*/);

  await controller.handleCallbackQuery(bot, cb('udf:req', 777));
  assert.equal(captured.queued.length, 1, 'one approval queued');
  assert.deepEqual(captured.queued[0].actionJSON, { action: 'set_unit_display', warehouse: 'Kano office', mode: 'bales', mode_before: 'thans' });
  assert.equal(captured.queued[0].status, 'pending');
  assert.equal(captured.notified.length, 1, 'admins notified');
  assert.equal(captured.notified[0].excludeId, '777', 'admin requester excluded from own approval');
});

test('manager: may request; requester NOT excluded from admin broadcast', async () => {
  const captured = arm();
  usersRepository.findByUserId = async (id) => (String(id) === '4242'
    ? { user_id: '4242', name: 'Manager M', role: 'manager', status: 'active' }
    : null);
  sessionStore.clear('4242');
  const bot = createFakeBot();

  await controller.handleCallbackQuery(bot, cb('act:display_units', 4242));
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'udf:wh:0'), 'manager sees the warehouse list');

  await controller.handleCallbackQuery(bot, cb('udf:wh:0', 4242)); // Lagos: bales → thans
  await controller.handleCallbackQuery(bot, cb('udf:req', 4242));
  assert.deepEqual(captured.queued[0].actionJSON, { action: 'set_unit_display', warehouse: 'Lagos', mode: 'thans', mode_before: 'bales' });
  assert.equal(captured.notified[0].excludeId, undefined, 'all admins get a manager request');
});

test('employee: refused at the gate', async () => {
  arm();
  usersRepository.findByUserId = async () => ({ user_id: '5555', name: 'Emp', role: 'employee', status: 'active' });
  sessionStore.clear('5555');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:display_units', 5555));
  assert.match(bot.allText(), /admins and managers only/i);
});

test('duplicate pending switch for the same warehouse is blocked', async () => {
  const captured = arm({
    pending: [{ requestId: 'R-DUP', actionJSON: { action: 'set_unit_display', warehouse: 'kano office', mode: 'bales' } }],
  });
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:display_units', 777));
  await controller.handleCallbackQuery(bot, cb('udf:wh:1', 777));
  await controller.handleCallbackQuery(bot, cb('udf:req', 777));
  assert.equal(captured.queued.length, 0, 'no second request queued');
  assert.match(bot.allText(), /already awaiting approval/);
});
