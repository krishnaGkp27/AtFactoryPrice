'use strict';

/**
 * ATT-R1 — the admin's chase screens on 📊 Today: the chip with the
 * audience's missing count, who (everyone · department · picked people),
 * how often, the status card, ⏹ Stop. The cards themselves are pinned in
 * services/attendanceChase.test.js; here we pin the screens and the wiring.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const { createFakeBot } = require(path.join(__dirname, '..', '..', 'helpers', 'fakeBot'));
const flow = require(path.join(SRC, 'flows/attendanceAdminFlow'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const usersRepo = require(path.join(SRC, 'repositories/usersRepository'));
const attendanceService = require(path.join(SRC, 'services/attendanceService'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const chase = require(path.join(SRC, 'services/attendanceChase'));
const empFlow = require(path.join(SRC, 'flows/attendanceFlow'));

const ADMIN = '777';
const TODAY = '2026-10-26';
let rows = [];
settingsRepository.getAll = async () => ({});
auditLogRepository.append = async () => {};
usersRepo.getAll = async () => [
  { user_id: '1', name: 'Abdul', status: 'active', departments: ['Sales'] },
  { user_id: '2', name: 'Musa', status: 'active', departments: ['Dispatch'] },
  { user_id: '3', name: 'Fatima', status: 'active', departments: ['Sales'] },
];
attendanceService.getConfig = async () => ({
  timezone: 'Africa/Lagos', locations: ['Kano Office'], locationCoords: new Map(), verifyMode: 'none',
  requiredUsers: [], cutoffTime: '12:00', deadlineTime: '09:30', reminderTime: '09:00', reportTime: '22:00',
  workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
});
attendanceService.getTodayAll = async () => ({ date: TODAY, rows });
attendanceService.getAudience = async () => [{ user_id: '1', name: 'Abdul' }, { user_id: '2', name: 'Musa' }, { user_id: '3', name: 'Fatima' }];
attendanceService.getRequiredUsersDetailed = async () => ({ active: [], ghost: [] });
usersRepo.findByUserId = async (id) => ({ user_id: String(id), name: ({ 1: 'Abdul', 2: 'Musa', 3: 'Fatima' })[id] || `U${id}` });
attendanceService.isRequired = async () => true;
attendanceService.getTodayEntry = async () => null;

const q = (data) => ({ id: 'q', data, from: { id: ADMIN }, message: { chat: { id: ADMIN }, message_id: 12 } });
function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}
function lastKb(bot) {
  const c = bot.calls.filter((x) => x.args && x.args.opts && x.args.opts.reply_markup && (x.method === 'sendMessage' || x.method === 'editMessageText'));
  const kb = c.length ? c[c.length - 1].args.opts.reply_markup.inline_keyboard : [];
  return kb.flat().map((b) => `${b.text}|${b.callback_data}`);
}
const toEmployees = (bot) => bot.calls.filter((c) => c.method === 'sendMessage' && ['1', '2', '3'].includes(String(c.args.chatId)));

test('📊 Today offers 📣 Chase the missing with the audience count; none when everyone marked', async () => {
  chase._resetForTests(); sessionStore.clear(ADMIN);
  rows = [{ telegram_id: '2', location: 'Kano Office', logged_at: `${TODAY}T08:00:00.000Z` }];
  const bot = createFakeBot();
  await flow.handleCallback(bot, q('atd_adm:today'));
  assert.ok(lastKb(bot).includes('📣 Chase the missing (2)|atd_adm:chase'), lastKb(bot).join('\n'));
  rows = ['1', '2', '3'].map((id) => ({ telegram_id: id, location: 'Kano Office', logged_at: `${TODAY}T08:00:00.000Z` }));
  const bot2 = createFakeBot();
  await flow.handleCallback(bot2, q('atd_adm:today'));
  assert.ok(!lastKb(bot2).some((b) => b.startsWith('📣 Chase the missing')));
});

test('who → a department → how often → the cards go out → status; ⏹ Stop', async () => {
  chase._resetForTests(); sessionStore.clear(ADMIN);
  rows = [];
  const bot = createFakeBot();
  await flow.handleCallback(bot, q('atd_adm:chase'));
  const kb = lastKb(bot);
  assert.ok(kb.includes('👥 Everyone missing (3)|atd_adm:chase:all'));
  assert.ok(kb.includes('🏭 Dispatch (1)|atd_adm:chase:d:0'));
  assert.ok(kb.includes('🏭 Sales (2)|atd_adm:chase:d:1'));
  assert.ok(kb.includes('👤 Pick people|atd_adm:chase:pp'));
  assert.match(lastText(bot), /3 not marked · 26-Oct-2026 · deadline was 09:30/);

  await flow.handleCallback(bot, q('atd_adm:chase:d:1'));
  assert.match(lastText(bot), /Chase Sales \(2\)\* — how often\?/);
  assert.ok(lastKb(bot).includes('🔁 Every 30 min until 12:00|atd_adm:chase:c:30'));
  assert.ok(lastKb(bot).includes('🔔 Once, now|atd_adm:chase:c:0'));

  await flow.handleCallback(bot, q('atd_adm:chase:c:30'));
  const sent = toEmployees(bot);
  assert.deepEqual(sent.map((c) => String(c.args.chatId)).sort(), ['1', '3'], 'Sales only — Musa (Dispatch) untouched');
  assert.match(sent[0].args.text, /Attendance not marked/);
  assert.equal(sent[0].args.opts.reply_markup.inline_keyboard[0][0].text, '📍 Mark now');
  assert.match(lastText(bot), /✅ Sent to 2 — again every 30 min until 12:00/);
  assert.match(lastText(bot), /📣 \*Chasing Sales \(2\)\* · 2 people · every 30 min until 12:00/);
  assert.match(lastText(bot), /⏳ Abdul · 1st reminder/);
  const stop = lastKb(bot).find((b) => b.startsWith('⏹ Stop'));
  assert.ok(stop, 'stop chip');

  // Today now carries the live line and the status chip.
  await flow.handleCallback(bot, q('atd_adm:today'));
  assert.match(lastText(bot), /📣 Chasing \*Sales \(2\)\* · 2 pending · every 30 min/);
  assert.ok(lastKb(bot).includes('📣 Chase status (1 live)|atd_adm:chase:st'));

  await flow.handleCallback(bot, q(stop.split('|')[1]));
  assert.match(lastText(bot), /Chase stopped/);
  assert.match(lastText(bot), /🏁 \*Chased Sales \(2\)\* .* ended: stopped by an admin/);
  assert.equal(chase.liveChases(TODAY).length, 0);
});

test('per-person pick: tick two names → Continue → once → exactly those two get a card', async () => {
  chase._resetForTests(); sessionStore.clear(ADMIN);
  rows = [];
  const bot = createFakeBot();
  await flow.handleCallback(bot, q('atd_adm:chase'));
  await flow.handleCallback(bot, q('atd_adm:chase:pp'));
  assert.ok(lastKb(bot).includes('☐ Abdul|atd_adm:chase:t:0'));
  assert.ok(!lastKb(bot).some((b) => b.startsWith('✅ Continue')), 'nothing ticked yet');
  await flow.handleCallback(bot, q('atd_adm:chase:t:0'));
  await flow.handleCallback(bot, q('atd_adm:chase:t:2'));
  assert.ok(lastKb(bot).includes('☑ Abdul|atd_adm:chase:t:0'));
  assert.ok(lastKb(bot).includes('✅ Continue (2)|atd_adm:chase:go'));
  await flow.handleCallback(bot, q('atd_adm:chase:t:2'));
  await flow.handleCallback(bot, q('atd_adm:chase:t:1'));
  await flow.handleCallback(bot, q('atd_adm:chase:go'));
  assert.match(lastText(bot), /Chase Abdul, Musa\* — how often\?/);
  await flow.handleCallback(bot, q('atd_adm:chase:c:0'));
  assert.deepEqual(toEmployees(bot).map((c) => String(c.args.chatId)).sort(), ['1', '2']);
  assert.match(lastText(bot), /✅ Sent to 2 — once\./);
});

test('everyone marked already → the who screen says so and offers nothing to start', async () => {
  chase._resetForTests(); sessionStore.clear(ADMIN);
  rows = ['1', '2', '3'].map((id) => ({ telegram_id: id, location: 'Kano Office', logged_at: `${TODAY}T08:00:00.000Z` }));
  const bot = createFakeBot();
  await flow.handleCallback(bot, q('atd_adm:chase'));
  assert.match(lastText(bot), /nobody to chase/);
  assert.ok(!lastKb(bot).some((b) => b.includes('atd_adm:chase:all')));
});

test('📍 Mark now: the chase card comes down, the flow opens, one location → no location step → marked → ✅ ended', async () => {
  chase._resetForTests(); sessionStore.clear(ADMIN); sessionStore.clear('1');
  rows = [];
  let markedWith = null;
  attendanceService.markPresent = async (p) => {
    markedWith = p;
    return { ok: true, alreadyLogged: false, verified: true, entry: {
      telegram_id: '1', employee_name: 'Abdul', date: TODAY, location: p.location,
      logged_at: `${TODAY}T08:41:00.000Z`, status: 'present', logged_via: 'self',
    } };
  };
  const bot = createFakeBot();
  const r = await chase.startChase(bot, { by: ADMIN, targets: [{ id: '1', name: 'Abdul' }], scopeLabel: 'Abdul', intervalMin: 30 });
  const cardId = r.chase.targets.get('1').msgId;
  assert.ok(cardId, 'Abdul holds a chase card');
  await empFlow.handleCallback(bot, { id: 'q', data: 'atd:now', from: { id: '1' }, message: { chat: { id: '1' }, message_id: cardId } });
  assert.ok(bot.calls.some((c) => c.method === 'deleteMessage' && String(c.args.chatId) === '1' && c.args.messageId === cardId), 'the chase card came down');
  assert.ok(markedWith && markedWith.location === 'Kano Office', 'the only location was taken without a tap');
  const toAbdul = bot.calls.filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && String(c.args.chatId || (c.args.opts && c.args.opts.chat_id)) === '1');
  assert.ok(toAbdul.some((c) => /Attendance Recorded/.test(String(c.args.text))), 'Abdul got the receipt');
  assert.equal(r.chase.live, false, 'the mark ended the one-person chase');
  assert.equal(r.chase.endedReason, 'all_marked');
  // The ATT-N1 broadcast still went to the admin pool.
  assert.ok(bot.calls.some((c) => c.method === 'sendMessage' && String(c.args.chatId) === ADMIN && /🕘 \*Attendance\*/.test(c.args.text)));
});
