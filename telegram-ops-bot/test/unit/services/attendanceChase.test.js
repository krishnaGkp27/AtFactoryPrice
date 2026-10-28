'use strict';

/**
 * ATT-R1 (owner, 28-Oct-2026) — chase the missing.
 *
 *  - a chase sends one card per missing person, skipping anyone marked;
 *  - re-sends on the interval, deleting the previous card ("2nd reminder");
 *  - a mark flips the live card to ✅ and drops the person; the last one
 *    ends the chase; once = no re-sends but the ✅ flip still lands;
 *  - the cutoff and ⏹ Stop end it; the newest chase takes a person over;
 *  - automatic mode: deadline, working days, once a day, off by default;
 *  - the Settings sentence replaces the default; audit rows at start/end.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const attendanceService = require(path.join(SRC, 'services/attendanceService'));
const chase = require(path.join(SRC, 'services/attendanceChase'));

// Lagos = UTC+1. Monday 26-Oct-2026.
const T = (hhmmUtc) => new Date(`2026-10-26T${hhmmUtc}:00Z`);
const SUNDAY = (hhmmUtc) => new Date(`2026-10-25T${hhmmUtc}:00Z`);

let settings = {};
let rows = [];
let audience = [
  { user_id: '1', name: 'Abdul' }, { user_id: '2', name: 'Musa' }, { user_id: '3', name: 'Fatima' },
];
settingsRepository.getAll = async () => ({ ...settings });
usersRepository.getAll = async () => [
  { user_id: '1', name: 'Abdul', status: 'active', departments: ['Sales'] },
  { user_id: '2', name: 'Musa', status: 'active', departments: ['Dispatch'] },
  { user_id: '3', name: 'Fatima', status: 'active', departments: ['Sales', 'Accounts'] },
];
attendanceService.getConfig = async () => ({
  timezone: 'Africa/Lagos', cutoffTime: '12:00', deadlineTime: '09:30',
  workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], requiredUsers: [], locations: ['Kano Office'],
});
attendanceService.getTodayAll = async () => ({ date: '2026-10-26', rows });
attendanceService.getAudience = async () => audience;
let audits = [];
auditLogRepository.append = async (kind, data, by) => { audits.push({ kind, data, by }); };

function recBot() {
  const calls = [];
  let n = 100;
  const rec = (method) => async (...args) => { calls.push({ method, args }); return { message_id: ++n }; };
  return {
    calls,
    sendMessage: rec('sendMessage'), editMessageText: rec('editMessageText'), deleteMessage: rec('deleteMessage'),
    of: (m) => calls.filter((c) => c.method === m),
    reset() { calls.length = 0; },
  };
}
function fresh() { chase._resetForTests(); settings = {}; rows = []; audits = []; }

test('the card: name, date, deadline, the consequence sentence, 📍 Mark now; ordinals from the 2nd reminder', () => {
  const t1 = chase.cardText({ name: 'Abdul', date: '2026-10-26', deadline: '09:30', nth: 1, text: chase.DEFAULT_TEXT });
  assert.match(t1, /^⏰ \*Attendance not marked\*\n/);
  assert.match(t1, /Abdul, your attendance for 26-Oct-2026 is not marked yet\.\nThe deadline was 09:30\./);
  assert.match(t1, /transport allowance and your salary payment\./);
  assert.ok(!/reminder/.test(t1.split('\n')[0]));
  const t2 = chase.cardText({ name: 'Abdul', date: '2026-10-26', deadline: '09:30', nth: 2, text: 'x' });
  assert.match(t2, /· 2nd reminder/);
  assert.equal(chase._internals.ordinal(3), '3rd');
  assert.equal(chase._internals.ordinal(11), '11th');
});

test('missingNow: the audience minus today\'s rows, with departments', async () => {
  fresh();
  rows = [{ telegram_id: '2' }];
  const m = await chase.missingNow();
  assert.deepEqual(m.map((x) => x.id), ['1', '3']);
  assert.deepEqual(m[1].departments, ['Sales', 'Accounts']);
});

test('start: one card each, marked people skipped, button is the mark tile, audit row', async () => {
  fresh();
  rows = [{ telegram_id: '3' }];
  const bot = recBot();
  const r = await chase.startChase(bot, { by: '777', targets: await chase.missingNow(), scopeLabel: 'Everyone missing (2)', intervalMin: 30, now: T('09:00') });
  assert.equal(r.ok, true);
  assert.equal(bot.of('sendMessage').length, 2);
  assert.deepEqual(bot.of('sendMessage').map((c) => c.args[0]).sort(), ['1', '2']);
  const [, text, opts] = bot.of('sendMessage')[0].args;
  assert.match(text, /Attendance not marked/);
  assert.equal(opts.reply_markup.inline_keyboard[0][0].text, '📍 Mark now');
  assert.equal(opts.reply_markup.inline_keyboard[0][0].callback_data, 'atd:now');
  assert.equal(audits[0].kind, 'attendance.chase_started');
  assert.deepEqual(audits[0].data.targets, ['1', '2']);
  assert.equal(audits[0].by, '777');
  // Fatima was already marked — never chased.
  assert.ok(!bot.of('sendMessage').some((c) => c.args[0] === '3'));
  const s = chase.summary(r.chase);
  assert.equal(s.until, '12:00');
  assert.equal(s.pending.length, 2);
});

test('nothing to chase → ok:false; nothing sent', async () => {
  fresh();
  rows = [{ telegram_id: '1' }, { telegram_id: '2' }, { telegram_id: '3' }];
  const bot = recBot();
  const r = await chase.startChase(bot, { by: '777', targets: [{ id: '1', name: 'Abdul' }], scopeLabel: 'x', intervalMin: 30, now: T('09:00') });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'nobody_missing');
  assert.equal(bot.calls.length, 0);
});

test('re-send on the interval: previous card deleted, "2nd reminder"; nothing before it is due', async () => {
  fresh();
  const bot = recBot();
  await chase.startChase(bot, { by: '777', targets: [{ id: '1', name: 'Abdul' }], scopeLabel: 'Abdul', intervalMin: 30, now: T('09:00') });
  bot.reset();
  assert.equal(await chase.tick(bot, T('09:20')), 0);
  assert.equal(bot.calls.length, 0);
  assert.equal(await chase.tick(bot, T('09:31')), 1);
  assert.equal(bot.of('deleteMessage').length, 1, 'the first card came down');
  assert.deepEqual(bot.of('deleteMessage')[0].args, ['1', 101]);
  assert.match(bot.of('sendMessage')[0].args[1], /2nd reminder/);
  bot.reset();
  assert.equal(await chase.tick(bot, T('09:45')), 0, 'not due again yet');
  assert.equal(await chase.tick(bot, T('10:02')), 1);
  assert.match(bot.of('sendMessage')[0].args[1], /3rd reminder/);
});

test('a mark flips the live card to ✅ and drops the person; the last one ends the chase', async () => {
  fresh();
  const bot = recBot();
  const r = await chase.startChase(bot, { by: '777', targets: [{ id: '1', name: 'Abdul' }, { id: '2', name: 'Musa' }], scopeLabel: 'two', intervalMin: 30, now: T('09:00') });
  bot.reset();
  assert.equal(await chase.onMarked(bot, '1', { loggedAt: '2026-10-26T08:41:00.000Z' }), 1);
  const ed = bot.of('editMessageText')[0];
  assert.match(ed.args[0], /✅ \*Marked at 09:41\* · thank you, Abdul\./);
  assert.equal(ed.args[1].chat_id, '1');
  assert.equal(r.chase.live, true, 'Musa still pending');
  bot.reset();
  await chase.tick(bot, T('09:31'));
  assert.deepEqual(bot.of('sendMessage').map((c) => c.args[0]), ['2'], 'only Musa is chased again');
  await chase.onMarked(bot, '2', { loggedAt: '2026-10-26T08:50:00.000Z' });
  assert.equal(r.chase.live, false);
  assert.equal(r.chase.endedReason, 'all_marked');
  assert.equal(audits.at(-1).kind, 'attendance.chase_ended');
  bot.reset();
  assert.equal(await chase.tick(bot, T('10:02')), 0, 'an ended chase sends nothing');
  assert.equal(chase.liveChases('2026-10-26').length, 0);
  assert.equal(chase.lastEnded('2026-10-26').id, r.chase.id);
});

test('a mark that reached the sheet without the hook still counts at the next tick', async () => {
  fresh();
  const bot = recBot();
  const r = await chase.startChase(bot, { by: '777', targets: [{ id: '1', name: 'Abdul' }], scopeLabel: 'Abdul', intervalMin: 30, now: T('09:00') });
  rows = [{ telegram_id: '1' }];
  bot.reset();
  assert.equal(await chase.tick(bot, T('09:31')), 0);
  assert.equal(bot.of('sendMessage').length, 0);
  assert.equal(r.chase.live, false);
  assert.equal(r.chase.endedReason, 'all_marked');
});

test('once: no re-sends, but the ✅ flip and the ending still happen', async () => {
  fresh();
  const bot = recBot();
  const r = await chase.startChase(bot, { by: '777', targets: [{ id: '1', name: 'Abdul' }], scopeLabel: 'Abdul', intervalMin: 0, now: T('09:00') });
  assert.equal(bot.of('sendMessage').length, 1);
  bot.reset();
  assert.equal(await chase.tick(bot, T('10:30')), 0);
  assert.equal(bot.calls.length, 0);
  await chase.onMarked(bot, '1', { loggedAt: '2026-10-26T09:40:00.000Z' });
  assert.equal(bot.of('editMessageText').length, 1);
  assert.equal(r.chase.endedReason, 'all_marked');
});

test('the cutoff ends a chase; ⏹ Stop ends it; pending people keep their last card', async () => {
  fresh();
  const bot = recBot();
  const r = await chase.startChase(bot, { by: '777', targets: [{ id: '1', name: 'Abdul' }], scopeLabel: 'Abdul', intervalMin: 30, now: T('09:00') });
  bot.reset();
  await chase.tick(bot, T('11:00')); // 12:00 Lagos = cutoff
  assert.equal(r.chase.live, false);
  assert.equal(r.chase.endedReason, 'cutoff');
  assert.equal(bot.of('deleteMessage').length, 0, 'the last card stays');
  const r2 = await chase.startChase(bot, { by: '777', targets: [{ id: '2', name: 'Musa' }], scopeLabel: 'Musa', intervalMin: 60, now: T('09:00') });
  assert.equal(chase.stopChase(r2.chase.id, '777'), true);
  assert.equal(r2.chase.endedReason, 'stopped');
  assert.equal(chase.stopChase(r2.chase.id, '777'), false, 'already ended');
  assert.equal(chase.stopChase('nope', '777'), false);
});

test('the newest chase takes a person over from an older one', async () => {
  fresh();
  const bot = recBot();
  const a = await chase.startChase(bot, { by: '777', targets: [{ id: '1', name: 'Abdul' }, { id: '2', name: 'Musa' }], scopeLabel: 'two', intervalMin: 30, now: T('09:00') });
  const b = await chase.startChase(bot, { by: '777', targets: [{ id: '1', name: 'Abdul' }], scopeLabel: 'Abdul', intervalMin: 60, now: T('09:05') });
  assert.ok(!a.chase.targets.has('1'));
  assert.ok(a.chase.targets.has('2'));
  assert.equal(a.chase.live, true);
  assert.ok(b.chase.targets.has('1'));
  const c = await chase.startChase(bot, { by: '777', targets: [{ id: '2', name: 'Musa' }], scopeLabel: 'Musa', intervalMin: 30, now: T('09:06') });
  assert.equal(a.chase.live, false, 'emptied → ended');
  assert.equal(a.chase.endedReason, 'superseded');
  assert.equal(c.ok, true);
});

test('automatic mode: off by default; on → at the deadline on a working day, once a day; Sunday → nothing', async () => {
  fresh();
  const bot = recBot();
  assert.equal(await chase.tick(bot, T('08:35')), 0, 'AUTO=0 → nothing');
  settings = { ATTENDANCE_CHASE_AUTO: '1', ATTENDANCE_CHASE_EVERY_MIN: '45' };
  assert.equal(await chase.tick(bot, T('08:20')), 0, 'before the 09:30 deadline');
  assert.equal(await chase.tick(bot, T('08:35')), 3, 'everyone missing chased');
  const live = chase.liveChases('2026-10-26');
  assert.equal(live.length, 1);
  assert.equal(live[0].auto, true);
  assert.equal(live[0].intervalMin, 45);
  assert.equal(live[0].by, 'auto');
  bot.reset();
  assert.equal(await chase.tick(bot, T('08:36')), 0, 'once a day');
  chase._resetForTests();
  settings = { ATTENDANCE_CHASE_AUTO: '1' };
  bot.reset();
  assert.equal(await chase.tick(bot, SUNDAY('08:35')), 0, 'not a working day');
  assert.equal(chase.liveChases('2026-10-25').length, 0);
});

test('the Settings sentence replaces the default; a Markdown failure retries plain; a dead chat never throws', async () => {
  fresh();
  settings = { ATTENDANCE_CHASE_TEXT: 'No mark, no transport money.' };
  const calls = [];
  const bot = {
    async sendMessage(id, text, opts) {
      calls.push({ id, text, md: !!(opts && opts.parse_mode) });
      if (id === '2') throw new Error('chat not found');
      if (opts && opts.parse_mode) throw new Error("can't parse entities");
      return { message_id: 5 };
    },
    async editMessageText() { return {}; }, async deleteMessage() { return true; },
  };
  const r = await chase.startChase(bot, { by: '777', targets: [{ id: '1', name: 'Abdul' }, { id: '2', name: 'Musa' }], scopeLabel: 'two', intervalMin: 30, now: T('09:00') });
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c.id === '1' && !c.md && /No mark, no transport money\./.test(c.text)), 'plain retry carried the sentence');
  const s = chase.summary(r.chase);
  assert.equal(s.pending.find((p) => p.id === '2').failed, 1);
  assert.equal(s.pending.find((p) => p.id === '1').sent, 1);
});
