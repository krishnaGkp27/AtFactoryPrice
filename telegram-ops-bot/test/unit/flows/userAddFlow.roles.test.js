'use strict';

/**
 * MKT-1 — Add Employee role picker now offers Marketer / Salesman so an admin
 * can onboard a field-role user from the bot (no sheet edit).
 *
 * Drives the real userAddFlow.handleCallback against an in-memory session +
 * fake bot. No sheets are touched on the role/confirm paths.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');
const sessionStore = require('../../../src/utils/sessionStore');
const userAddFlow = require('../../../src/flows/userAddFlow');

const UID = '900900';

function seedSession(step, data) {
  sessionStore.set(UID, {
    type: 'user_add_flow',
    step,
    flowMessageId: 555,
    data: Object.assign({
      telegram_id: '12345678', name: 'Field Person', department: 'Sales',
      warehouses: [], role: '', prefillSource: null,
    }, data || {}),
    startedAt: new Date().toISOString(),
    ttlMs: 30 * 60 * 1000,
  });
}

function query(data) {
  return { id: 'cb', from: { id: UID }, data, message: { chat: { id: UID }, message_id: 555 } };
}

/** All callback_data from the most recent render (sendMessage or editMessageText). */
function lastKeyboardCallbacks(bot) {
  const renders = bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  const last = renders[renders.length - 1];
  const kb = (last && last.args.opts && last.args.opts.reply_markup && last.args.opts.reply_markup.inline_keyboard) || [];
  return kb.flat().map((b) => b.callback_data);
}

test('role step offers Marketer and Salesman (plus Employee/Manager)', async () => {
  seedSession('warehouses', { warehouses: ['Lagos'] });
  const bot = createFakeBot();
  await userAddFlow.handleCallback(bot, query('usr:wh_done')); // advances to role step
  const cbs = lastKeyboardCallbacks(bot);
  assert.deepEqual(
    ['employee', 'manager', 'marketer', 'salesman'].map((r) => `usr:role:${r}`).filter((c) => cbs.includes(c)),
    ['usr:role:employee', 'usr:role:manager', 'usr:role:marketer', 'usr:role:salesman'],
  );
});

test('picking Marketer is accepted and advances to confirm', async () => {
  seedSession('role', { warehouses: ['Lagos'] });
  const bot = createFakeBot();
  await userAddFlow.handleCallback(bot, query('usr:role:marketer'));
  const s = sessionStore.get(UID);
  assert.equal(s.data.role, 'marketer');
  assert.equal(s.step, 'confirm');
});

test('picking Salesman is accepted and advances to confirm', async () => {
  seedSession('role', { warehouses: ['Lagos'] });
  const bot = createFakeBot();
  await userAddFlow.handleCallback(bot, query('usr:role:salesman'));
  const s = sessionStore.get(UID);
  assert.equal(s.data.role, 'salesman');
  assert.equal(s.step, 'confirm');
});

test('confirm card warns when a field role has no warehouse', async () => {
  seedSession('role', { warehouses: [] });
  const bot = createFakeBot();
  await userAddFlow.handleCallback(bot, query('usr:role:marketer'));
  assert.match(bot.allText(), /No warehouse selected/i);
});

test('confirm card has no warning when a field role has a warehouse', async () => {
  seedSession('role', { warehouses: ['Lagos'] });
  const bot = createFakeBot();
  await userAddFlow.handleCallback(bot, query('usr:role:salesman'));
  assert.doesNotMatch(bot.allText(), /No warehouse selected/i);
});

test('an invalid role is rejected (stays on role step)', async () => {
  seedSession('role', { warehouses: ['Lagos'] });
  const bot = createFakeBot();
  await userAddFlow.handleCallback(bot, query('usr:role:banana'));
  const s = sessionStore.get(UID);
  assert.equal(s.data.role, '');
  assert.equal(s.step, 'role');
});
