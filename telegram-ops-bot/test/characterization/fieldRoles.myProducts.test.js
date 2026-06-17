'use strict';

/**
 * Characterization (golden) suite for the marketer/salesman "My Products"
 * feature, driving the real telegramController offline.
 *
 * Pins:
 *   - a field-role user's greeting menu = ONLY the My Products tile;
 *   - salesman's My Products shows today's selling price;
 *   - marketer's My Products shows the same designs WITHOUT price;
 *   - warehouse scoping (other-warehouse stock excluded).
 *
 * EMPLOYEE_IDS makes the test users authorized; their field-role behavior
 * comes from Users.role in the faked sheet. inventoryRepository.getAll is
 * stubbed with parsed fixture rows (simpler than seeding 21 raw columns).
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '101,102';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

const MARKETER_ID = 101;
const SALESMAN_ID = 102;

// Users sheet columns: 0 id,1 name,2 role,3 branch,4 access,5 status,
// 6 created,7 departments,8 warehouses,9 manages,10 prefs.
function userRow(id, role) {
  return [String(id), `U${id}`, role, '', '', 'active', '', '', 'Lagos', '', ''];
}

installFakeSheets(createFakeSheets({
  Users: [
    ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'departments', 'warehouses', 'manages', 'notification_prefs'],
    userRow(MARKETER_ID, 'marketer'),
    userRow(SALESMAN_ID, 'salesman'),
  ],
  AuditLog: [['timestamp', 'type', 'data', 'user_id']],
  UserPrefs: [['user_id', 'activity', 'count']],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();

// Stub inventory with parsed rows: available stock in Lagos (two designs)
// plus one Kano row that must NOT appear for a Lagos-scoped user.
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
inventoryRepository.getAll = async () => [
  { status: 'available', design: '44200', shade: 'BLACK', packageNo: '5801', thanNo: 1, yards: 25, warehouse: 'Lagos', pricePerYard: 1500 },
  { status: 'available', design: '44200', shade: 'BLACK', packageNo: '5801', thanNo: 2, yards: 25, warehouse: 'Lagos', pricePerYard: 1500 },
  { status: 'available', design: '9006', shade: 'RED', packageNo: '7001', thanNo: 1, yards: 40, warehouse: 'Lagos', pricePerYard: 2000 },
  { status: 'available', design: '44200', shade: 'BLACK', packageNo: '9901', thanNo: 1, yards: 25, warehouse: 'Kano', pricePerYard: 1500 },
];

function message(fromId, text) {
  return { chat: { id: fromId }, from: { id: fromId, first_name: 'T' }, text };
}
function callback(fromId, data) {
  return { id: 'cb', data, from: { id: fromId }, message: { chat: { id: fromId }, message_id: 7 } };
}
function menuCallbacks(bot) {
  const send = bot.callsTo('sendMessage')[0];
  const kb = (send.args.opts && send.args.opts.reply_markup && send.args.opts.reply_markup.inline_keyboard) || [];
  return kb.flat().map((b) => b.callback_data);
}

test('field-role greeting menu = only My Products', async () => {
  const bot = createFakeBot();
  await controller.handleMessage(bot, message(MARKETER_ID, ''));
  const cbs = menuCallbacks(bot);
  assert.ok(cbs.includes('act:my_products'), 'expected the My Products tile');
  assert.ok(!cbs.includes('act:supply_request'), 'field role must not see supply_request');
  assert.ok(!cbs.some((c) => c.startsWith('act:__hub__')), 'field role should not get department hubs');
});

test('salesman My Products shows designs + selling price (Lagos only)', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, callback(SALESMAN_ID, 'act:my_products'));
  const out = bot.allText();
  assert.match(out, /44200/);
  assert.match(out, /9006/);
  assert.match(out, /₦1,500\/yd/);
  assert.match(out, /₦2,000\/yd/);
  assert.doesNotMatch(out, /9901/); // Kano bale excluded
});

test('marketer My Products shows the same designs WITHOUT price', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, callback(MARKETER_ID, 'act:my_products'));
  const out = bot.allText();
  assert.match(out, /44200/);
  assert.match(out, /9006/);
  assert.doesNotMatch(out, /\/yd/);
  assert.doesNotMatch(out, /₦/);
});
