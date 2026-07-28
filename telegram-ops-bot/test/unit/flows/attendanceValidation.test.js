'use strict';

/**
 * ATT-V1 — the employee always learns where they stand.
 *
 * Two failures on 27-Jul motivated this file:
 *
 *  1. A Sheets error on the location-tap and GPS paths escaped to the
 *     webhook. The employee tapped their location and received NOTHING —
 *     no error, no retry, no clue whether they were marked.
 *
 *  2. A mark was written and confirmed with "✅ Attendance Recorded" while
 *     being invisible to every report (ATT-DATE1). The confirmation card
 *     was the only signal anyone had, and it lied.
 *
 * The rule these tests enforce: the bot never tells someone they are marked
 * unless it has read the row back, and never leaves them with silence.
 */

process.env.ADMIN_IDS = '777';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '../../..');
const attendanceService = require(path.join(ROOT, 'src/services/attendanceService'));
const attendanceFlow = require(path.join(ROOT, 'src/flows/attendanceFlow'));
const sessionStore = require(path.join(ROOT, 'src/utils/sessionStore'));
const usersRepo = require(path.join(ROOT, 'src/repositories/usersRepository'));

const EMP = '4242';

const CFG = {
  locations: ['Kano Office'],
  timezone: 'Africa/Lagos',
  verificationMode: 'none',
  requiredUsers: [],
  deadlineTime: '09:30',
  workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
};

function fakeBot() {
  const sent = [];
  return {
    sent,
    sendMessage: async (c, t) => { sent.push(t); return { message_id: 1 }; },
    editMessageText: async (t) => { sent.push(t); return {}; },
    answerCallbackQuery: async () => ({}),
    all: () => sent.join('\n---\n'),
  };
}

function stubService({ today = null, mark, todayThrows = false }) {
  attendanceService.getConfig = async () => CFG;
  attendanceService.isRequired = async () => true;
  attendanceService.getTodayEntry = async () => {
    if (todayThrows) throw new Error('Sheets 503');
    return today;
  };
  attendanceService.markPresent = mark;
}

usersRepo.findByUserId = async () => ({ user_id: EMP, name: 'Yarima' });

const ENTRY = {
  date: '2026-07-28', telegram_id: EMP, employee_name: 'Yarima',
  status: 'present', location: 'Kano Office', logged_at: '2026-07-28T08:10:00.000Z',
  logged_via: 'self',
};

async function tapLocation(bot) {
  sessionStore.set(EMP, { type: 'attendance_flow', step: 'pick' });
  await attendanceFlow.handleCallback(bot, {
    id: 'q', data: 'atd:pick:Kano%20Office',
    from: { id: EMP }, message: { chat: { id: EMP }, message_id: 9 },
  });
}

test('a failed write NEVER leaves the employee in silence', async () => {
  const bot = fakeBot();
  stubService({ mark: async () => ({ ok: false, reason: 'write_failed', error: 'Sheets 503' }) });
  await tapLocation(bot);
  assert.ok(bot.sent.length >= 1, 'the employee must get an answer');
  assert.match(bot.all(), /NOT marked yet/i, 'and must be told plainly they are not covered');
  assert.match(bot.all(), /Try again/i, 'with a way forward');
  sessionStore.clear(EMP);
});

test('an exception thrown by the service is caught, not swallowed by the webhook', async () => {
  const bot = fakeBot();
  stubService({ mark: async () => { throw new Error('Google Sheets 503'); } });
  await assert.doesNotReject(() => tapLocation(bot), 'must not propagate out of the flow');
  assert.match(bot.all(), /Could not mark/i);
  assert.match(bot.all(), /NOT marked yet/i);
  sessionStore.clear(EMP);
});

test('a row that cannot be read back is NOT reported as recorded', async () => {
  const bot = fakeBot();
  stubService({ mark: async () => ({ ok: true, entry: ENTRY, alreadyLogged: false, verified: false }) });
  await tapLocation(bot);
  const txt = bot.all();
  assert.match(txt, /needs checking/i, 'the header must not claim success');
  assert.match(txt, /could not read it back/i, 'and must say why');
  assert.ok(!/Saved and confirmed/.test(txt), 'never claim confirmation it does not have');
  sessionStore.clear(EMP);
});

test('a verified row is confirmed, with the date on the receipt', async () => {
  const bot = fakeBot();
  stubService({ mark: async () => ({ ok: true, entry: ENTRY, alreadyLogged: false, verified: true }) });
  await tapLocation(bot);
  const txt = bot.all();
  assert.match(txt, /Attendance Recorded/);
  assert.match(txt, /Saved and confirmed/);
  assert.match(txt, /2026-07-28/, 'the date is the thing that went wrong before — show it');
  assert.match(txt, /Kano Office/);
  sessionStore.clear(EMP);
});

test('opening the tile when already marked shows the confirmation, not the picker', async () => {
  const bot = fakeBot();
  stubService({ today: ENTRY, mark: async () => { throw new Error('should not be called'); } });
  await attendanceFlow.start(bot, EMP, EMP, 1);
  const txt = bot.all();
  assert.match(txt, /Already marked/i);
  assert.match(txt, /2026-07-28/);
  assert.ok(!/Where are you marking from/.test(txt), 'no second mark offered');
  sessionStore.clear(EMP);
});

test('opening the tile when NOT marked says so before offering locations', async () => {
  const bot = fakeBot();
  stubService({ today: null, mark: async () => ({ ok: true, entry: ENTRY }) });
  await attendanceFlow.start(bot, EMP, EMP, 1);
  const txt = bot.all();
  assert.match(txt, /have not marked attendance today/i, 'state the status explicitly');
  assert.match(txt, /Where are you marking from/);
  sessionStore.clear(EMP);
});

test('if the status lookup fails the picker is NOT shown — a duplicate is worse', async () => {
  const bot = fakeBot();
  stubService({ todayThrows: true, mark: async () => { throw new Error('should not be called'); } });
  await attendanceFlow.start(bot, EMP, EMP, 1);
  const txt = bot.all();
  assert.match(txt, /could not check/i);
  assert.ok(!/Where are you marking from/.test(txt),
    'marking blind could create the duplicate row the guard exists to prevent');
  sessionStore.clear(EMP);
});

/* ── ATT-V2: admins hear about it too ─────────────────────────────────── */

test('a failed write DMs the admins, not just the employee', async () => {
  const alerts = require(path.join(ROOT, 'src/services/attendanceAlerts'));
  const settingsRepository = require(path.join(ROOT, 'src/repositories/settingsRepository'));
  alerts._reset();
  settingsRepository.getAll = async () => ({ ATTENDANCE_ALERT_COOLDOWN_MIN: 15 });

  const bot = fakeBot();
  const dms = [];
  const origSend = bot.sendMessage;
  bot.sendMessage = async (chatId, text) => {
    if (String(chatId) === '777') dms.push(text);
    return origSend(chatId, text);
  };
  stubService({ mark: async () => ({ ok: false, reason: 'write_failed', error: 'Sheets 503' }) });
  await tapLocation(bot);

  assert.equal(dms.length, 1, 'the admin is told in real time');
  assert.match(dms[0], /Attendance NOT saving/);
  assert.match(dms[0], /Yarima/, 'and who it happened to');
  sessionStore.clear(EMP);
});

test('an unverified write also reaches the admins', async () => {
  const alerts = require(path.join(ROOT, 'src/services/attendanceAlerts'));
  alerts._reset();
  const bot = fakeBot();
  const dms = [];
  const origSend = bot.sendMessage;
  bot.sendMessage = async (chatId, text) => {
    if (String(chatId) === '777') dms.push(text);
    return origSend(chatId, text);
  };
  stubService({ mark: async () => ({ ok: true, entry: ENTRY, alreadyLogged: false, verified: false }) });
  await tapLocation(bot);

  assert.equal(dms.length, 1);
  assert.match(dms[0], /saved but unreadable/i);
  sessionStore.clear(EMP);
});

test('a healthy mark alerts nobody', async () => {
  const alerts = require(path.join(ROOT, 'src/services/attendanceAlerts'));
  alerts._reset();
  const bot = fakeBot();
  const dms = [];
  const origSend = bot.sendMessage;
  bot.sendMessage = async (chatId, text) => {
    if (String(chatId) === '777') dms.push(text);
    return origSend(chatId, text);
  };
  stubService({ mark: async () => ({ ok: true, entry: ENTRY, alreadyLogged: false, verified: true }) });
  await tapLocation(bot);
  assert.equal(dms.length, 0, 'no noise on the happy path');
  sessionStore.clear(EMP);
});
