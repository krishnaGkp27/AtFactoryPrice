'use strict';

/**
 * MKT-1 — Change Role flow: admin changes an existing user's role from the bot.
 * Drives the real roleEditFlow with a fake bot + stubbed usersRepo. Verifies
 * the picker excludes admins, the role buttons, the direct write, the
 * no-warehouse nudge for field roles, and the admin-protection guard.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');
const sessionStore = require('../../../src/utils/sessionStore');
const usersRepo = require('../../../src/repositories/usersRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const auth = require('../../../src/middlewares/auth');
const roleEditFlow = require('../../../src/flows/roleEditFlow');

const ADMIN = '777';

// Make the actor an admin and neutralize side-effecting deps.
auth.isAdmin = (id) => String(id) === ADMIN;
auth.invalidate = () => {};
auditLogRepository.append = async () => {};

const USERS = [
  { user_id: '101', name: 'Aisha', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: '102', name: 'Bola', role: 'salesman', status: 'active', warehouses: [] },
  { user_id: '999', name: 'BigBoss', role: 'admin', status: 'active', warehouses: [] },
];
usersRepo.getAll = async () => USERS.map((u) => ({ ...u }));
usersRepo.findByUserId = async (id) => USERS.find((u) => u.user_id === String(id)) || null;

let lastUpdate = null;
usersRepo.updateRole = async (id, role) => { lastUpdate = { id: String(id), role }; return true; };

function query(data) {
  return { id: 'cb', from: { id: ADMIN }, data, message: { chat: { id: ADMIN }, message_id: 5 } };
}
function callbacks(bot) {
  const renders = bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  const last = renders[renders.length - 1];
  const kb = (last && last.args.opts && last.args.opts.reply_markup && last.args.opts.reply_markup.inline_keyboard) || [];
  return kb.flat().map((b) => b.callback_data);
}

test('picker lists active non-admin users only', async () => {
  sessionStore.clear(ADMIN);
  const bot = createFakeBot();
  await roleEditFlow.handleCallback(bot, query('rol:start'));
  const cbs = callbacks(bot);
  assert.ok(cbs.includes('rol:pick:101'));
  assert.ok(cbs.includes('rol:pick:102'));
  assert.ok(!cbs.includes('rol:pick:999'), 'admin must not be listed');
});

test('selecting a user shows the four assignable roles (no admin)', async () => {
  sessionStore.clear(ADMIN);
  const bot = createFakeBot();
  await roleEditFlow.handleCallback(bot, query('rol:start'));
  await roleEditFlow.handleCallback(bot, query('rol:pick:101'));
  const cbs = callbacks(bot);
  for (const r of ['employee', 'manager', 'marketer', 'salesman']) {
    assert.ok(cbs.includes(`rol:set:101|${r}`), `expected role button ${r}`);
  }
  assert.ok(!cbs.some((c) => /rol:set:101\|admin/.test(c)), 'admin must not be assignable');
});

test('applying a role writes directly and confirms', async () => {
  sessionStore.clear(ADMIN);
  lastUpdate = null;
  const bot = createFakeBot();
  await roleEditFlow.handleCallback(bot, query('rol:start'));
  await roleEditFlow.handleCallback(bot, query('rol:pick:101'));
  await roleEditFlow.handleCallback(bot, query('rol:set:101|marketer'));
  assert.deepEqual(lastUpdate, { id: '101', role: 'marketer' });
  assert.match(bot.allText(), /Role updated/i);
  assert.match(bot.allText(), /employee → \*marketer\*/);
});

test('field role with no warehouse triggers the assign-warehouse nudge', async () => {
  sessionStore.clear(ADMIN);
  const bot = createFakeBot();
  await roleEditFlow.handleCallback(bot, query('rol:start'));
  await roleEditFlow.handleCallback(bot, query('rol:pick:102')); // Bola, no warehouses
  await roleEditFlow.handleCallback(bot, query('rol:set:102|marketer'));
  assert.match(bot.allText(), /no warehouse assigned/i);
  assert.ok(callbacks(bot).includes('adm:assign_wh'));
});

test('changing TO employee (non-field) shows no warehouse nudge', async () => {
  sessionStore.clear(ADMIN);
  const bot = createFakeBot();
  await roleEditFlow.handleCallback(bot, query('rol:start'));
  await roleEditFlow.handleCallback(bot, query('rol:pick:102'));
  await roleEditFlow.handleCallback(bot, query('rol:set:102|employee'));
  assert.doesNotMatch(bot.allText(), /no warehouse assigned/i);
});

test('cannot change an admin via this flow', async () => {
  sessionStore.clear(ADMIN);
  lastUpdate = null;
  const bot = createFakeBot();
  await roleEditFlow.handleCallback(bot, query('rol:start'));
  // Force-pick the admin id even though it is not offered as a button.
  await roleEditFlow.handleCallback(bot, query('rol:pick:999'));
  assert.match(bot.allText(), /Promote\/Deactivate/i);
  assert.equal(lastUpdate, null);
});

test('non-admin cannot start the flow', async () => {
  sessionStore.clear('555');
  const bot = createFakeBot();
  await roleEditFlow.handleCallback(bot, { id: 'cb', from: { id: '555' }, data: 'rol:start', message: { chat: { id: '555' }, message_id: 1 } });
  assert.match(bot.allText(), /Admin only/i);
});
