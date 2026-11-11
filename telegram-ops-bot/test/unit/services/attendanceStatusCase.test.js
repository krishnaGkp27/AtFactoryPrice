'use strict';

/**
 * Users sheet `status` in the attendance audience — compared trimmed and
 * lower-cased, as auth already does.
 *
 * A cell reading `Active` (capital A, or with a stray space) let the person
 * use the bot — auth normalises — but the attendance code compared the cell
 * letter for letter, so that person had no 📍 Mark Attendance tile, was not
 * nudged, could not be chased, was missing from the 👥 Required Users picker
 * and counted as a ghost id. Pinned here for the service (who must mark /
 * who is chased), the admin screens that list the same people, and the
 * report's required set — they must agree with each other.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const { createFakeBot } = require(path.join(__dirname, '..', '..', 'helpers', 'fakeBot'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const attendanceRepository = require(path.join(SRC, 'repositories/attendanceRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const attendanceService = require(path.join(SRC, 'services/attendanceService'));
const attendanceReportService = require(path.join(SRC, 'services/attendanceReportService'));
const adminFlow = require(path.join(SRC, 'flows/attendanceAdminFlow'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));

const ADMIN = '777';

let settings = {};
const settingsWrites = [];
settingsRepository.getAll = async () => ({ ...settings });
settingsRepository.set = async (key, value) => { settingsWrites.push([key, value]); settings[key] = value; return { key, value }; };
auditLogRepository.append = async () => {};
attendanceRepository.getByDate = async () => [];
attendanceRepository.getRange = async () => [];

usersRepository.getAll = async () => [
  { user_id: '4242', name: 'Abdul', role: 'employee', status: 'Active', departments: ['Sales'] },
  { user_id: '5555', name: 'Musa', role: 'employee', status: ' ACTIVE ', departments: ['Dispatch'] },
  { user_id: '6666', name: 'Fatima', role: 'employee', status: 'active', departments: ['Sales'] },
  { user_id: '6667', name: 'Blank', role: 'employee', status: '', departments: ['Sales'] },
  { user_id: '7777', name: 'Gone', role: 'employee', status: 'Inactive', departments: ['Sales'] },
  { user_id: '7778', name: 'Left', role: 'employee', status: 'inactive', departments: ['Sales'] },
  { user_id: '777', name: 'Boss', role: 'admin', status: 'Active', departments: ['Sales'] },
];

const q = (data) => ({ id: 'q', data, from: { id: ADMIN }, message: { chat: { id: ADMIN }, message_id: 12 } });
function lastScreen(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c[c.length - 1];
}
const lastText = (bot) => String((lastScreen(bot) || { args: {} }).args.text || '');
function lastButtons(bot) {
  const c = lastScreen(bot);
  const kb = c && c.args.opts && c.args.opts.reply_markup;
  return kb ? kb.inline_keyboard.flat().map((b) => `${b.text}|${b.callback_data}`) : [];
}

test.beforeEach(() => { settings = {}; settingsWrites.length = 0; sessionStore.clear(ADMIN); });

test('who must mark: `Active` and ` ACTIVE ` are in the audience; `Inactive` is still out', async () => {
  const a = await attendanceService.getAudience();
  assert.deepEqual(a.map((x) => x.user_id).sort(), ['4242', '5555', '6666', '6667']);
  assert.equal(await attendanceService.isRequired('4242'), true, 'the 📍 Mark Attendance tile and the chase follow the audience');
  assert.equal(await attendanceService.isRequired('7777'), false);
});

test('list mode: a required id on an `Active` row is a person, not a ghost', async () => {
  settings = { ATTENDANCE_AUDIENCE: 'list', ATTENDANCE_REQUIRED_USERS: '4242,7777,9999' };
  const a = await attendanceService.getAudience();
  assert.deepEqual(a.map((x) => x.user_id), ['4242']);
  const d = await attendanceService.getRequiredUsersDetailed();
  assert.deepEqual(d.active.map((r) => r.id), ['4242']);
  assert.deepEqual(d.ghost, ['7777', '9999'], 'an inactive row and an unknown id stay ghosts');
  assert.equal(d.totalActiveUsers, 5, 'every active row, whatever the spelling (the admin row included)');
});

test('saving the required list keeps an `Active` person and still drops an inactive one', async () => {
  const r = await attendanceService.setRequiredUsers(['4242', '5555', '7777']);
  assert.deepEqual(r, { saved: ['4242', '5555'], dropped: ['7777'] });
  assert.deepEqual(settingsWrites, [['ATTENDANCE_REQUIRED_USERS', '4242,5555']]);
});

test('admin screens agree with the service: the Required Users picker lists the `Active` people', async () => {
  settings = { ATTENDANCE_REQUIRED_USERS: '4242' };
  const bot = createFakeBot();
  await adminFlow.handleCallback(bot, q('atd_adm:req'));
  const names = lastButtons(bot).filter((b) => b.includes('atd_adm:req_toggle:'));
  assert.deepEqual(names, [
    '✅ Abdul|atd_adm:req_toggle:4242',
    '⬜ Blank|atd_adm:req_toggle:6667',
    '⬜ Boss|atd_adm:req_toggle:777',
    '⬜ Fatima|atd_adm:req_toggle:6666',
    '⬜ Musa|atd_adm:req_toggle:5555',
  ]);
  assert.match(lastText(bot), /\*1\* of \*5\* active employees/);
});

test('admin hub: the Today panel counts the same required people as the Required Users chip', async () => {
  settings = { ATTENDANCE_REQUIRED_USERS: '4242,5555' };
  const bot = createFakeBot();
  await adminFlow.handleCallback(bot, q('atd_adm:home'));
  assert.match(lastText(bot), /\*0\/2\* marked/, 'the panel');
  assert.match(lastText(bot), /⏳ Abdul/);
  assert.match(lastText(bot), /⏳ Musa/);
  assert.ok(lastButtons(bot).includes('👥 Required Users (2)|atd_adm:req'), 'the chip');
});

test('Mark on Behalf offers a required person whose row reads `Active`', async () => {
  settings = { ATTENDANCE_REQUIRED_USERS: '4242,7777' };
  const bot = createFakeBot();
  await adminFlow.handleCallback(bot, q('atd_adm:behalf'));
  assert.deepEqual(lastButtons(bot).filter((b) => b.includes('atd_adm:behalf_pick:')), ['👤 Abdul|atd_adm:behalf_pick:4242']);
});

test('the attendance report counts a required person whose row reads `Active`', async () => {
  settings = { ATTENDANCE_REQUIRED_USERS: '4242,7777' };
  const report = await attendanceReportService.buildReport({ kind: '7d' });
  assert.equal(report.requiredCount, 1);
  assert.deepEqual(report.perEmployee.map((e) => e.id), ['4242']);
  assert.deepEqual(report.today.missing.map((m) => m.name), ['Abdul']);
});
