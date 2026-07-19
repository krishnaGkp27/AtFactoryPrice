'use strict';

/**
 * ATT-C3 — 09:00 attendance nudge: department-based audience, deadline
 * copy, skip-already-marked, once-per-day, working-day and toggle gates.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const { createFakeBot } = require('../../helpers/fakeBot');
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const attendanceRepository = require(path.join(SRC, 'repositories/attendanceRepository'));
const attendanceService = require(path.join(SRC, 'services/attendanceService'));
const reminder = require(path.join(SRC, 'services/attendanceReminder'));

let settings = {};
settingsRepository.getAll = async () => ({ ...settings });

usersRepository.getAll = async () => [
  { user_id: '4242', name: 'Yarima', role: 'employee', status: 'active', departments: ['Sales'] },
  { user_id: '5555', name: 'Abdul', role: 'employee', status: 'active', departments: ['Dispatch'] },
  { user_id: '6666', name: 'NoDept', role: 'employee', status: 'active', departments: [] },
  { user_id: '7777', name: 'Gone', role: 'employee', status: 'inactive', departments: ['Sales'] },
  { user_id: '777', name: 'Boss', role: 'admin', status: 'active', departments: ['Sales'] },
];

let todayRows = [];
attendanceRepository.getByDate = async () => todayRows;

// Monday 09:05 Lagos (=08:05 UTC) / Sunday same clock time.
const MONDAY = new Date('2026-07-20T08:05:00Z');
const SUNDAY = new Date('2026-07-19T08:05:00Z');
const MONDAY_EARLY = new Date('2026-07-20T07:30:00Z'); // 08:30 Lagos

test('audience = active department members (admins/inactive/no-dept out) + manual list union', async () => {
  settings = {};
  let a = await attendanceService.getAudience();
  assert.deepEqual(a.map((x) => x.user_id).sort(), ['4242', '5555']);
  settings = { ATTENDANCE_REQUIRED_USERS: '6666' };
  a = await attendanceService.getAudience();
  assert.deepEqual(a.map((x) => x.user_id).sort(), ['4242', '5555', '6666'], 'manual CSV adds on top');
  settings = { ATTENDANCE_AUDIENCE: 'list', ATTENDANCE_REQUIRED_USERS: '6666' };
  a = await attendanceService.getAudience();
  assert.deepEqual(a.map((x) => x.user_id), ['6666'], 'legacy list mode = CSV only');
});

test('nudges only unmarked members at/after 09:00 on a working day, with deadline + tap button', async () => {
  reminder._resetForTests();
  settings = {};
  todayRows = [{ telegram_id: '5555', status: 'present' }]; // Abdul already marked
  const bot = createFakeBot();
  assert.equal(await reminder.tick(bot, MONDAY_EARLY), 0, 'quiet before 09:00');
  const sent = await reminder.tick(bot, MONDAY);
  assert.equal(sent, 1, 'only Yarima is nudged');
  const msg = bot.calls.find((c) => c.method === 'sendMessage');
  assert.equal(String(msg.args.chatId), '4242');
  assert.match(msg.args.text, /Yarima/);
  assert.match(msg.args.text, /before \*09:30\*/, 'default deadline 09:30 in the copy');
  const kb = msg.args.opts.reply_markup.inline_keyboard.flat();
  assert.equal(kb[0].callback_data, 'act:mark_attendance', 'tappable mark button');
  assert.equal(await reminder.tick(bot, new Date(MONDAY.getTime() + 3600e3)), 0, 'once per day');
});

test('Sunday (non-working) and the master toggle both silence the nudge', async () => {
  reminder._resetForTests();
  settings = {};
  todayRows = [];
  const bot = createFakeBot();
  assert.equal(await reminder.tick(bot, SUNDAY), 0, 'default working days exclude Sun');
  reminder._resetForTests();
  settings = { ATTENDANCE_REMINDER_ENABLED: 0 };
  assert.equal(await reminder.tick(bot, MONDAY), 0, 'toggle off');
  assert.equal(bot.calls.length, 0);
});

test('digest 🕘 Attendance: summary counts and missing/reported drill-down', async () => {
  settings = {};
  todayRows = [{ telegram_id: '5555', status: 'present', location: 'Kano Office', logged_at: '2026-07-20T08:01:00.000Z', logged_via: 'self' }];
  const digest = require(path.join(SRC, 'services/morningDigest'));
  const cat = digest.CATEGORIES.find((c) => c.key === 'DIGEST_ATTENDANCE');
  assert.ok(cat, 'category registered');
  const { line } = await cat.summarize({}, '2026-07-20');
  assert.match(line, /1\/2.*marked.*1.*missing/);
  const detail = await cat.detail({}, '2026-07-20');
  assert.match(detail, /report-by 09:30/);
  assert.match(detail, /⏳ Yarima/, 'missing person listed');
  assert.match(detail, /✅ Abdul — Kano Office/, 'reported person with location');
});
