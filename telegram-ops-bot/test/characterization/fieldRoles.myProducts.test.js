'use strict';

/**
 * Characterization (golden) suite for the marketer/salesman "My Products"
 * feature, driving the real telegramController offline.
 *
 * Pins:
 *   - a field-role user's greeting menu = ONLY the My Products tile;
 *   - salesman's My Products shows today's selling price;
 *   - marketer's My Products = MKT-2 category-first view scoped to ADMIN
 *     ALLOCATIONS (not raw warehouse stock), no price anywhere;
 *   - warehouse scoping (other-warehouse stock excluded).
 *
 * EMPLOYEE_IDS makes the test users authorized; their field-role behavior
 * comes from Users.role in the faked sheet. inventoryRepository.getAll is
 * stubbed with parsed fixture rows (simpler than seeding 23 raw columns).
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
  // MKT-2 — the marketer's view is scoped to what an admin allocated.
  MarketerAllocations: [
    ['marketer_id', 'marketer_name', 'design', 'allocated_qty', 'updated_by', 'updated_at', 'notes'],
    [String(MARKETER_ID), 'U101', '44200', '5', '777', '', ''],
  ],
  AuditLog: [['timestamp', 'type', 'data', 'user_id']],
  UserPrefs: [['user_id', 'activity', 'count']],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();

// Stub inventory with parsed rows: available stock in Lagos (two designs)
// plus one Kano row that must NOT appear for a Lagos-scoped user.
// designCategory (Inventory col W) feeds the marketer's category chips.
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
inventoryRepository.getAll = async () => [
  { status: 'available', design: '44200', shade: 'BLACK', packageNo: '5801', thanNo: 1, yards: 25, warehouse: 'Lagos', pricePerYard: 1500, designCategory: 'Cashmere' },
  { status: 'available', design: '44200', shade: 'BLACK', packageNo: '5801', thanNo: 2, yards: 25, warehouse: 'Lagos', pricePerYard: 1500, designCategory: 'Cashmere' },
  { status: 'available', design: '9006', shade: 'RED', packageNo: '7001', thanNo: 1, yards: 40, warehouse: 'Lagos', pricePerYard: 2000, designCategory: '' },
  { status: 'available', design: '44200', shade: 'BLACK', packageNo: '9901', thanNo: 1, yards: 25, warehouse: 'Kano', pricePerYard: 1500, designCategory: 'Cashmere' },
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

test('marketer My Products = allocation-scoped category chips, then designs, no price (MKT-2)', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, callback(MARKETER_ID, 'act:my_products'));
  let out = bot.allText();
  assert.match(out, /Pick a category/);

  // Only the allocated design's category shows — 9006 was never allocated.
  const kb = bot.calls
    .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup)
    .pop().args.opts.reply_markup.inline_keyboard.flat();
  const cashmere = kb.find((b) => /Cashmere/.test(b.text));
  assert.ok(cashmere, 'Cashmere category chip expected');
  assert.ok(!kb.some((b) => /Others|9006/.test(b.text)), 'unallocated designs get no chip');

  // Tap the category → allocated qty + Lagos-scoped availability, no price.
  await controller.handleCallbackQuery(bot, callback(MARKETER_ID, cashmere.callback_data));
  out = bot.allText();
  assert.match(out, /44200/);
  assert.match(out, /Allocated to you: \*5 bales\*/);
  assert.match(out, /Available now: 1 bale/); // 5801 only — Kano 9901 excluded
  assert.doesNotMatch(out, /\/yd/);
  assert.doesNotMatch(out, /₦/);
});

test('marketer is view-only: free-text commands do not trigger actions', async () => {
  let intentCalls = 0;
  installFakeIntent(() => { intentCalls += 1; return { action: 'sell', confidence: 0.99 }; });
  const bot = createFakeBot();
  await controller.handleMessage(bot, message(MARKETER_ID, 'Sell 5801 to Ibrahim cash'));
  const out = bot.allText();
  // No sell flow / confirmation; just the view-only nudge + their menu tile.
  assert.match(out, /My Products/);
  assert.doesNotMatch(out, /[Ss]ell|[Cc]onfirm|[Ii]brahim/);
  assert.equal(intentCalls, 0, 'field-role text must never reach the intent parser');
  installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
});
