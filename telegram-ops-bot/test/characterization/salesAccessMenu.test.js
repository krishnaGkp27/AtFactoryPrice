'use strict';

/**
 * SSA-1 through the REAL controller: the grant decides the menu (both
 * doors appear for a granted employee, both vanish for an ungranted one
 * even when a department CSV lists Customer Supplies), the 🔐 Sales Access
 * tile opens for an admin, and the `ssa:` taps are routed.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,5151';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const departmentsRepo = require(path.join(SRC, 'repositories/departmentsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const salesAccessService = require(path.join(SRC, 'services/salesAccessService'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));

const USERS = [
  { user_id: '4242', name: 'Abdul', role: 'employee', departments: ['Sales'], department: 'Sales', status: 'active', store_sales_places: ['Kano office'] },
  { user_id: '5151', name: 'Musa', role: 'employee', departments: ['Sales'], department: 'Sales', status: 'active', store_sales_places: [] },
];
const writes = [];
usersRepository.getAll = async () => USERS;
usersRepository.findByUserId = async (id) => USERS.find((u) => u.user_id === String(id)) || null;
usersRepository.updateStoreSalesPlaces = async (id, places) => {
  const u = USERS.find((x) => x.user_id === String(id));
  if (!u) return false;
  u.store_sales_places = places.slice();
  writes.push([id, places]);
  return true;
};
auditLogRepository.append = async () => {};
salesAccessService.listPlaces = async () => ['IDUMOTA', 'Kano office'];
// The Sales department lists Customer Supplies for everyone — the grant overrides it.
departmentsRepo.findByName = async (name) => ({
  Sales: { dept_id: 'DEPT-001', dept_name: 'Sales', status: 'active', allowed_activities: ['supply_request', 'sold_bales_lookup'] },
}[name] || null);

function offered(bot) {
  return bot.calls
    .filter((c) => c.args && c.args.opts && c.args.opts.reply_markup)
    .flatMap((c) => (c.args.opts.reply_markup.inline_keyboard || []).flat())
    .map((b) => b.callback_data);
}
async function greet(uid) {
  const bot = createFakeBot();
  await controller.handleMessage(bot, { chat: { id: uid }, from: { id: uid, first_name: 'X' }, text: 'hi' });
  return { bot, cbs: offered(bot) };
}
async function hub(uid, hubId) {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, { id: `h-${uid}`, data: `act:__hub__:${hubId}`, from: { id: uid }, message: { chat: { id: uid }, message_id: 5 } });
  return offered(bot);
}
function cq(uid, data) {
  return { id: `cq-${data}`, data, from: { id: uid }, message: { chat: { id: 600 }, message_id: 88 } };
}
function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}

test.beforeEach(() => { sessionStore.clear('777'); sessionStore.clear('4242'); sessionStore.clear('5151'); });

test('a granted employee gets both doors in the Reporting hub; an ungranted one gets neither, CSV or not', async () => {
  const abdul = await greet('4242');
  assert.ok(abdul.cbs.includes('act:__hub__:reporting') || abdul.cbs.includes('act:store_sales'), JSON.stringify(abdul.cbs));
  const abdulHub = await hub('4242', 'reporting');
  assert.ok(abdulHub.includes('act:store_sales'), `Store Sales missing: ${JSON.stringify(abdulHub)}`);
  assert.ok(abdulHub.includes('act:sold_bales_lookup'), `Customer Supplies missing: ${JSON.stringify(abdulHub)}`);

  const musa = await greet('5151');
  assert.ok(!musa.cbs.includes('act:store_sales') && !musa.cbs.includes('act:sold_bales_lookup'), JSON.stringify(musa.cbs));
  assert.ok(!musa.cbs.includes('act:__hub__:reporting'), 'nothing left in Reporting, so no hub tile either');
});

test('admin: 🔐 Sales Access sits in the HR hub; tile → people → tick → Save writes the grant, all routed by the controller', async () => {
  const hr = await hub('777', 'hr');
  assert.ok(hr.includes('act:sales_access'), JSON.stringify(hr));

  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('777', 'act:sales_access'));
  assert.equal(lastText(bot), '🔐 *Sales Access*\n\nWho may see store sales? Tap a person.');
  assert.equal(sessionStore.get('777').type, 'sales_access_flow');
  await controller.handleCallbackQuery(bot, cq('777', 'ssa:u:1'));       // Musa
  assert.match(lastText(bot), /Sales Access — Musa/);
  await controller.handleCallbackQuery(bot, cq('777', 'ssa:p:0'));       // IDUMOTA
  await controller.handleCallbackQuery(bot, cq('777', 'ssa:save'));
  assert.deepEqual(writes, [['5151', ['IDUMOTA']]]);
  assert.match(lastText(bot), /✅ \*Musa\* now sees the sales of \*IDUMOTA\*\./);
  const dm = bot.calls.find((c) => c.method === 'sendMessage' && String(c.args.chatId) === '5151');
  assert.ok(dm && /You can now see the sales of IDUMOTA/.test(dm.args.text));

  // Musa's menu now carries both doors.
  const musaHub = await hub('5151', 'reporting');
  assert.ok(musaHub.includes('act:store_sales') && musaHub.includes('act:sold_bales_lookup'), JSON.stringify(musaHub));
});

test('a non-admin tapping the Sales Access tile is refused in one line', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('4242', 'act:sales_access'));
  assert.equal(lastText(bot), '🔐 Sales Access is admin-only.');
  assert.equal(sessionStore.get('4242'), null);
});
