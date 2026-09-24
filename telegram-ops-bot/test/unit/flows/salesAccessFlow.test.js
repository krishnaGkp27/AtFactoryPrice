'use strict';

/**
 * SSA-1 — 🔐 Sales Access: pick a person → tick places → Save. Admin-only,
 * immediate, the person is told what they gained, never what was removed
 * (owner rulings 24-Sep-2026).
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,5151';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const flow = require(path.join(SRC, 'flows/salesAccessFlow'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const salesAccessService = require(path.join(SRC, 'services/salesAccessService'));

let USERS;
let writes;
let audits;
function reset() {
  USERS = [
    { user_id: '777', name: 'Krishna', role: 'admin', status: 'active', store_sales_places: [] },
    { user_id: '5151', name: 'Musa', role: 'employee', status: 'active', store_sales_places: ['IDUMOTA', 'Ketu'] },
    { user_id: '4242', name: 'Abdul', role: 'employee', status: 'active', store_sales_places: [] },
    { user_id: '6161', name: 'Old Hand', role: 'employee', status: 'inactive', store_sales_places: [] },
  ];
  writes = []; audits = [];
}
usersRepository.getAll = async () => USERS;
usersRepository.findByUserId = async (id) => USERS.find((u) => u.user_id === String(id)) || null;
usersRepository.updateStoreSalesPlaces = async (id, places) => {
  const u = USERS.find((x) => x.user_id === String(id));
  if (!u) return false;
  u.store_sales_places = places.slice();
  writes.push([id, places]);
  return true;
};
auditLogRepository.append = async (type, payload, by) => { audits.push([type, payload, by]); };
salesAccessService.listPlaces = async () => ['Balogun', 'IDUMOTA', 'Kano office', 'Ketu'];

function textCalls(bot) { return bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText'); }
function lastText(bot) { const c = textCalls(bot); return c.length ? String(c[c.length - 1].args.text || '') : ''; }
function lastKb(bot) {
  const c = bot.calls.filter((x) => x.args && x.args.opts && x.args.opts.reply_markup);
  return c.length ? c[c.length - 1].args.opts.reply_markup.inline_keyboard : [];
}
function kbTexts(bot) { return lastKb(bot).flat().map((b) => `${b.text}|${b.callback_data}`); }
async function tap(bot, uid, data) {
  return flow.handleCallback(bot, { id: 'q', data, from: { id: uid }, message: { chat: { id: 1 }, message_id: 55 } });
}
function dmsTo(bot, id) {
  return bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === String(id)).map((c) => c.args.text);
}

test.beforeEach(() => { reset(); sessionStore.clear('777'); sessionStore.clear('4242'); });

test('screen A: admin-only; one chip per active non-admin person, alphabetical, showing what they hold', async () => {
  const bot = createFakeBot();
  await flow.start(bot, 1, '4242', 55);
  assert.equal(lastText(bot), '🔐 Sales Access is admin-only.');
  assert.equal(sessionStore.get('4242'), null);

  const bot2 = createFakeBot();
  await flow.start(bot2, 1, '777', 55);
  assert.equal(lastText(bot2), '🔐 *Sales Access*\n\nWho may see store sales? Tap a person.');
  assert.deepEqual(kbTexts(bot2), ['👤 Abdul · —|ssa:u:0', '👤 Musa · IDUMOTA, Ketu|ssa:u:1', '🏠 Back to menu|ssa:menu']);
  assert.equal(sessionStore.get('777').step, 'pick_user');
});

test('screen B: every known place as a tick chip, the person\'s grants pre-ticked; taps toggle in place', async () => {
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'ssa:u:1');
  assert.equal(lastText(bot), '🔐 *Sales Access — Musa*\n\nTick the places *Musa* may see, then Save.');
  assert.deepEqual(kbTexts(bot), [
    '⬜ Balogun|ssa:p:0', '✅ IDUMOTA|ssa:p:1',
    '⬜ Kano office|ssa:p:2', '✅ Ketu|ssa:p:3',
    '✅ Save|ssa:save',
    '👤 Change person|ssa:back', '❌ Close|ssa:close',
  ]);
  await tap(bot, '777', 'ssa:p:2');
  await tap(bot, '777', 'ssa:p:3');
  assert.deepEqual(kbTexts(bot).slice(0, 4), ['⬜ Balogun|ssa:p:0', '✅ IDUMOTA|ssa:p:1', '✅ Kano office|ssa:p:2', '⬜ Ketu|ssa:p:3']);
  assert.equal(writes.length, 0, 'nothing is written until Save');
});

test('Save: writes column L, logs, tells the person, and confirms; a no-change save sends nothing', async () => {
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'ssa:u:0');            // Abdul, nothing ticked
  await tap(bot, '777', 'ssa:p:2');            // Kano office
  await tap(bot, '777', 'ssa:save');
  assert.deepEqual(writes, [['4242', ['Kano office']]]);
  assert.equal(audits[0][0], 'sales_access_updated');
  assert.equal(audits[0][2], '777');
  assert.deepEqual(dmsTo(bot, '4242'), ['🏬 You can now see the sales of Kano office.\nOpen 📊 Reporting → 🏬 Store Sales or 📒 Customer Supplies.']);
  assert.equal(lastText(bot), '🔐 *Sales Access*\n\n✅ *Abdul* now sees the sales of *Kano office*.\n_They have been told._');
  assert.deepEqual(kbTexts(bot), ['👤 Change person|ssa:back', '❌ Close|ssa:close']);

  // Back to the list: the chip now shows the grant.
  await tap(bot, '777', 'ssa:back');
  assert.equal(kbTexts(bot)[0], '👤 Abdul · Kano office|ssa:u:0');

  // Save again without a change: written, not sent.
  await tap(bot, '777', 'ssa:u:0');
  await tap(bot, '777', 'ssa:save');
  assert.equal(dmsTo(bot, '4242').length, 1);
  assert.match(lastText(bot), /_No change — nothing sent\._$/);
});

test('Save with everything unticked revokes silently — the employee gets no removal message', async () => {
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'ssa:u:1');            // Musa: IDUMOTA + Ketu
  await tap(bot, '777', 'ssa:p:1');
  await tap(bot, '777', 'ssa:p:3');
  await tap(bot, '777', 'ssa:save');
  assert.deepEqual(writes, [['5151', []]]);
  assert.deepEqual(dmsTo(bot, '5151'), [], 'no removal DM');
  assert.equal(lastText(bot), '🔐 *Sales Access*\n\n✅ *Musa* no longer sees any store\'s sales.');
});

test('a granted place the register no longer lists is still shown ticked so it can be removed', async () => {
  USERS[1].store_sales_places = ['Old Store'];
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'ssa:u:1');
  assert.deepEqual(kbTexts(bot).slice(0, 5), ['⬜ Balogun|ssa:p:0', '⬜ IDUMOTA|ssa:p:1', '⬜ Kano office|ssa:p:2', '⬜ Ketu|ssa:p:3', '✅ Old Store|ssa:p:4']);
});

test('Close edits the card in place; a stale tap strips the old buttons and says so once', async () => {
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'ssa:close');
  const closed = textCalls(bot).pop();
  assert.equal(closed.method, 'editMessageText');
  assert.equal(closed.args.text, '🔐 Closed.');
  assert.equal(sessionStore.get('777'), null);
  const before = bot.calls.length;
  await tap(bot, '777', 'ssa:u:0');
  assert.deepEqual(bot.calls.slice(before).map((c) => c.method), ['answerCallbackQuery', 'editMessageReplyMarkup', 'sendMessage']);
  assert.equal(lastText(bot), '🔐 That Sales Access screen has expired — open 🔐 Sales Access again.');
});

test('guards: out-of-range and wrong-step taps are ignored; a foreign prefix is not handled', async () => {
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'ssa:u:9');
  assert.equal(sessionStore.get('777').step, 'pick_user');
  await tap(bot, '777', 'ssa:save');
  assert.equal(writes.length, 0);
  await tap(bot, '777', 'ssa:p:0');
  assert.equal(sessionStore.get('777').step, 'pick_user');
  assert.equal(await tap(bot, '777', 'sfs:close'), false);
});
