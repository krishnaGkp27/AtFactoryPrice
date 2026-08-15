'use strict';

/**
 * PAY-1 — 💳 Payments must be reachable by everyone who can be owed money.
 *
 * Caught while writing the owner's test steps: menu tiles are drawn from
 * each department's `allowed_activities` CSV, and the live sheet lists
 * Sales as supply_request, upload_receipt, my_orders, … — no payments.
 * Abdul, the very person meant to test this, would never have seen the
 * tile, and neither would any future employee until somebody edited a
 * sheet.
 *
 * Asking to be paid is not a departmental duty — the owner's own system
 * design names "Abdul, Yarima, Shreya, John, other employees or
 * contractor" as the raisers — so the tile is injected for every user,
 * the way Mark Attendance is. Safety is unaffected: every write behind it
 * is dual-admin, and the picker shows a person only their own account.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '7430648262,8700676816';

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
const userPrefsRepo = require(path.join(SRC, 'repositories/userPrefsRepository'));

const ABDUL = '7430648262';

// The live sheet, as exported 14-Aug-2026: Sales does NOT list payments.
usersRepository.getAll = async () => [
  { user_id: ABDUL, name: 'Abdul', role: 'employee', departments: ['Sales', 'Dispatch'], department: 'Sales', status: 'active' },
  { user_id: '8700676816', name: 'Office', role: 'marketer', departments: ['Sales', 'Finance'], department: 'Sales', status: 'active' },
];
usersRepository.findByUserId = async (id) => (await usersRepository.getAll()).find((u) => u.user_id === String(id)) || null;
departmentsRepo.findByName = async (name) => ({
  Sales: { dept_id: 'DEPT-001', dept_name: 'Sales', status: 'active', allowed_activities: ['supply_request', 'my_orders'] },
  Dispatch: { dept_id: 'DEPT-002', dept_name: 'Dispatch', status: 'active', allowed_activities: ['my_orders'] },
}[name] || null);
userPrefsRepo.getCountsForUser = async () => ({});

/** Every callback_data the bot offered this user, across all messages. */
function offeredTo(bot) {
  return bot.calls
    .filter((c) => c.args && c.args.opts && c.args.opts.reply_markup)
    .flatMap((c) => (c.args.opts.reply_markup.inline_keyboard || []).flat())
    .map((b) => b.callback_data);
}

/** The menu exactly as the user reaches it — the bot's own greeting word. */
async function menuFor(uid) {
  const bot = createFakeBot();
  await controller.handleMessage(bot, { chat: { id: uid }, from: { id: uid, first_name: 'X' }, text: 'hi' });
  return offeredTo(bot);
}

test('PAY-1: an employee whose departments never mention payments still sees the tile', async () => {
  // The tile may sit at top level or inside the Finance hub depending on
  // how many finance activities this user has — either is reachable.
  const cbs = await menuFor(ABDUL);
  assert.ok(cbs.includes('act:payments') || cbs.includes('act:__hub__:finance'),
    `Abdul must be able to ask to be paid. Offered: ${JSON.stringify(cbs)}`);
});

test('PAY-1: a field-role user can ask to be paid too', async () => {
  // Marketers/salesmen are otherwise view-only, but they are still people
  // the business owes money to.
  const cbs = await menuFor('8700676816');
  assert.ok(cbs.includes('act:payments') || cbs.includes('act:__hub__:finance'),
    `Offered: ${JSON.stringify(cbs)}`);
});

test('PAY-1: opening the Finance hub still shows Payments, not an empty section', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, {
    id: 'q1', data: 'act:__hub__:finance',
    from: { id: ABDUL }, message: { chat: { id: ABDUL }, message_id: 5 },
  });
  const edits = bot.calls.filter((c) => c.method === 'editMessageText');
  const last = edits[edits.length - 1];
  assert.ok(last, 'the hub rendered');
  assert.ok(!/No actions available/.test(String(last.args.text)),
    'the hub must not be a dead end for someone who can raise a payment');
  const cbs = ((last.args.opts.reply_markup || {}).inline_keyboard || []).flat().map((b) => b.callback_data);
  assert.ok(cbs.includes('act:payments'), `Finance hub offered: ${JSON.stringify(cbs)}`);
});
