'use strict';

/**
 * FIX-SETTINGS2 — empty attendance Settings cells, through the real
 * controller, the real settingsRepository and the real attendance admin hub
 * over a fake workbook.
 *
 * The reader used to hand every empty value cell over as the number 0, so:
 *  - an empty ATTENDANCE_LOCATIONS row gave ONE location, named `0`;
 *  - an empty ATTENDANCE_WORKING_DAYS row gave the working days `0` — no
 *    working day at all, so the 09:00 nudge and the automatic chase never
 *    fired;
 *  - 🔘 Clear all on 👥 Required Users (or unticking the last person) wrote
 *    an empty ATTENDANCE_REQUIRED_USERS, which read back as the id `0`: the
 *    screens then warned about `1 ghost ID(s)` that the cleanup could never
 *    clear, because the cleanup writes the same empty cell again.
 *
 * Nothing here depends on today's date or weekday: the test never asserts
 * on the "Today" panel and never marks attendance.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,5555';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, kbTexts } = require('../helpers/charFixture');

const USERS_HEADER = ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'departments', 'warehouses', 'manages', 'notification_prefs'];
const fake = createFakeSheets({
  Users: [
    USERS_HEADER,
    ['777', 'Boss', 'admin', '', '', 'active', '', 'Management', '', '', ''],
    ['4242', 'Abdul', 'employee', '', '', 'active', '', 'Sales', '', '', ''],
    ['5555', 'Musa', 'employee', '', '', 'active', '', 'Dispatch', '', '', ''],
  ],
  Settings: [
    ['Key', 'Value', 'UpdatedAt'],
    ['ATTENDANCE_REQUIRED_USERS', '4242', ''],
    ['ATTENDANCE_LOCATIONS', '', ''],
    ['ATTENDANCE_WORKING_DAYS', '', ''],
    ['ATTENDANCE_AUDIENCE', 'list', ''],
  ],
});
installFakeSheets(fake);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const attendanceService = require(path.join(SRC, 'services/attendanceService'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
auditLogRepository.append = async () => {};

const ADMIN = '777';
const tap = (bot, data) => controller.handleCallbackQuery(bot, cb(data, ADMIN, 9));
function screenText(bot) {
  const c = bot.calls.filter((x) => x.method === 'editMessageText' || x.method === 'sendMessage').pop();
  return c ? String(c.args.text || '') : '';
}
/** The Settings value cell of `key` as stored (last matching row). */
function cell(key) {
  const rows = fake._store.get('Settings').filter((r) => r[0] === key);
  return rows.length ? rows[rows.length - 1][1] : undefined;
}

test.beforeEach(() => {
  sessionStore.clear(ADMIN);
  // Every test starts from the same workbook: Abdul alone is required.
  fake._store.get('Settings').find((r) => r[0] === 'ATTENDANCE_REQUIRED_USERS')[1] = '4242';
  settingsRepository.invalidateCache();
  usersRepository.invalidateCache();
});

test('the hub: empty LOCATIONS and WORKING_DAYS rows show the built-in five locations and Mon–Sat', async () => {
  const bot = createFakeBot();
  await tap(bot, 'act:attendance_admin');
  const hub = screenText(bot);
  assert.match(hub, /\*Required:\* 1 active employees {2}· {2}\*Locations:\* 5\n/, 'it used to read Locations: 1 (the location `0`)');
  assert.match(hub, /\*Working days:\* Mon, Tue, Wed, Thu, Fri, Sat\n/, 'it used to read Working days: 0');
  assert.ok(kbTexts(bot).includes('📍 Locations (5)|atd_adm:loc'));

  await tap(bot, 'atd_adm:loc');
  const locs = kbTexts(bot).filter((b) => b.startsWith('📍 '));
  assert.deepEqual(locs, ['Lagos Office', 'House', 'Kano Office', 'Chinos Store', 'Idumota Store'].map((l) => `📍 ${l}|atd_adm:noop`));

  await tap(bot, 'atd_adm:days');
  assert.deepEqual(kbTexts(bot).filter((b) => b.includes('atd_adm:day:')), [
    '✅ Mon|atd_adm:day:Mon', '✅ Tue|atd_adm:day:Tue', '✅ Wed|atd_adm:day:Wed', '✅ Thu|atd_adm:day:Thu',
    '✅ Fri|atd_adm:day:Fri', '✅ Sat|atd_adm:day:Sat', '⬜ Sun|atd_adm:day:Sun',
  ]);

  const cfg = await attendanceService.getConfig();
  assert.deepEqual(cfg.workingDays, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], 'the nudge and the automatic chase have working days again');
  assert.ok(!cfg.locations.includes('0') && !cfg.workingDays.includes('0'));
});

test('👥 Required Users → 🔘 Clear all: nobody is required and no ghost id is reported, on the picker or the hub', async () => {
  const bot = createFakeBot();
  await tap(bot, 'act:attendance_admin');
  await tap(bot, 'atd_adm:req');
  assert.match(screenText(bot), /_Currently required:_ \*1\* of \*3\* active employees\.\n/);
  assert.ok(kbTexts(bot).includes('✅ Abdul|atd_adm:req_toggle:4242'));

  await tap(bot, 'atd_adm:req_clear');
  assert.ok(['', "'"].includes(cell('ATTENDANCE_REQUIRED_USERS')), 'the bot wrote an empty value cell');
  const picker = screenText(bot);
  assert.match(picker, /_Currently required:_ \*0\* of \*3\* active employees\.\n/);
  assert.doesNotMatch(picker, /ghost/i, 'it used to add "⚠️ 1 ghost ID(s) detected in your settings…"');
  assert.ok(kbTexts(bot).includes('⬜ Abdul|atd_adm:req_toggle:4242'));

  await tap(bot, 'atd_adm:home');
  const hub = screenText(bot);
  assert.match(hub, /\*Required:\* 0 active employees/);
  assert.doesNotMatch(hub, /ghost/i, 'it used to add "⚠️ 1 ghost ID(s) found in your required-users list…"');
  assert.ok(kbTexts(bot).includes('👥 Required Users (0)|atd_adm:req'));

  assert.deepEqual((await attendanceService.getRequiredUsersDetailed()).ghost, []);
  assert.deepEqual(await attendanceService.getAudience(), [], 'list mode with a cleared list = nobody must mark');
});

test('unticking the last required person leaves no ghost either; ticking one back works', async () => {
  const bot = createFakeBot();
  await tap(bot, 'act:attendance_admin');
  await tap(bot, 'atd_adm:req_toggle:4242'); // Abdul off — he was the last one
  assert.ok(['', "'"].includes(cell('ATTENDANCE_REQUIRED_USERS')), 'the bot wrote an empty value cell');
  assert.match(screenText(bot), /_Currently required:_ \*0\* of \*3\* active employees\./);
  assert.doesNotMatch(screenText(bot), /ghost/i);

  await tap(bot, 'atd_adm:req_toggle:5555'); // Musa on
  assert.match(screenText(bot), /_Currently required:_ \*1\* of \*3\* active employees\./);
  assert.equal(String(cell('ATTENDANCE_REQUIRED_USERS')).replace(/^'/, ''), '5555', 'no stray `0` is carried into the saved list');
  assert.deepEqual((await attendanceService.getAudience()).map((a) => a.user_id), ['5555']);
});
