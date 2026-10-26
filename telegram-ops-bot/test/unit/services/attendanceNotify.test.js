'use strict';

/**
 * ATT-N1 (owner, 26-Oct-2026) — every mark is broadcast the moment it saves.
 *
 *  - the card: who, where, when, what was verified; "marked by" on behalf;
 *  - the audience: the Railway admin pool through the feed by default,
 *    the Settings ATTENDANCE_NOTIFY_IDS people alone when the cell is set;
 *  - nothing on a repeat tap or an unconfirmed save; never throws.
 */

process.env.ADMIN_IDS = '111,222';

const test = require('node:test');
const assert = require('node:assert/strict');

const settingsRepository = require('../../../src/repositories/settingsRepository');
const usersRepository = require('../../../src/repositories/usersRepository');
const adminFeed = require('../../../src/services/adminFeed');
const svc = require('../../../src/services/attendanceNotify');

let settings = {};
settingsRepository.getAll = async () => ({ ...settings });
usersRepository.findByUserId = async (id) => (String(id) === '999' ? { user_id: '999', name: 'Krishna' } : { user_id: String(id), notification_prefs: null });

const ENTRY = {
  telegram_id: '4242', employee_name: 'Abdul', status: 'present', date: '2026-10-26',
  location: 'Kano office', logged_at: '2026-10-26T07:42:00.000Z', logged_via: 'self',
  distance_m: 38, geo: '12.0,8.5', photo_file_id: 'f1',
};

function recordingBot() {
  const calls = [];
  return { calls, async sendMessage(id, text, opts) { calls.push({ id: String(id), text, opts }); return { message_id: calls.length }; } };
}

test('the card: name, place, time in Lagos, date, verification facts', () => {
  const t = svc.buildText({ entry: ENTRY, tz: 'Africa/Lagos' });
  assert.equal(t.split('\n').length, 3);
  assert.match(t, /^🕘 \*Attendance\* · \*Abdul\* marked Present$/m);
  assert.match(t, /^📍 Kano office · 08:42 · 26-Oct-2026$/m);
  assert.match(t, /^📡 Position verified · 38 m from site · 📷 Photo$/m);
});

test('no verification → two lines; position-only → "recorded"; on behalf → marked by', () => {
  const bare = svc.buildText({ entry: { ...ENTRY, distance_m: '', geo: '', photo_file_id: '' } });
  assert.equal(bare.split('\n').length, 2);
  const geoOnly = svc.buildText({ entry: { ...ENTRY, distance_m: '', photo_file_id: '' } });
  assert.match(geoOnly, /📡 Position recorded$/m);
  assert.ok(!/Photo/.test(geoOnly));
  const by = svc.buildText({ entry: ENTRY, markedByName: 'Krishna' });
  assert.match(by, /marked Present · marked by Krishna$/m);
});

test('a name with Markdown characters is escaped, never swallowed', () => {
  const t = svc.buildText({ entry: { ...ENTRY, employee_name: 'Office_BPanther' } });
  assert.match(t, /Office\\_BPanther/);
});

test('default audience: the admin pool through the feed, actor excluded', async () => {
  settings = {};
  const bot = recordingBot();
  const seen = [];
  const orig = adminFeed.notify;
  adminFeed.notify = async (b, eventType, text, opts, extra) => { seen.push({ eventType, text, opts, extra }); return { sent: 2, skipped: 0 }; };
  try {
    const r = await svc.notifyMarked(bot, { entry: ENTRY, excludeUserId: '4242' });
    assert.equal(r.reason, 'admin_pool');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].eventType, 'attendance.marked');
    assert.equal(seen[0].extra.excludeUserId, '4242');
    assert.match(seen[0].text, /Abdul\* marked Present/);
    assert.equal(bot.calls.length, 0, 'nothing sent outside the feed');
  } finally { adminFeed.notify = orig; }
});

test('the real feed delivers to every Railway admin with the event ON by default', async () => {
  settings = {};
  const bot = recordingBot();
  const r = await svc.notifyMarked(bot, { entry: ENTRY, excludeUserId: '4242' });
  assert.equal(r.sent, 2);
  assert.deepEqual(bot.calls.map((c) => c.id).sort(), ['111', '222']);
  assert.equal(adminFeed.getCatalogEntry('attendance.marked').group, 'attendance');
  assert.ok(adminFeed.listGroups().some((g) => g.id === 'attendance' && g.label === 'Attendance'));
});

test('ATTENDANCE_NOTIFY_IDS set → only those people, the feed is bypassed, actor still excluded', async () => {
  settings = { ATTENDANCE_NOTIFY_IDS: ' 555, 4242 ,777 ' };
  const bot = recordingBot();
  const orig = adminFeed.notify;
  let fed = 0;
  adminFeed.notify = async () => { fed += 1; return { sent: 0, skipped: 0 }; };
  try {
    const r = await svc.notifyMarked(bot, { entry: ENTRY, excludeUserId: '4242' });
    assert.equal(r.reason, 'override');
    assert.deepEqual(bot.calls.map((c) => c.id), ['555', '777']);
    assert.equal(r.sent, 2);
    assert.equal(r.skipped, 1, 'the actor was in the list and was skipped');
    assert.equal(fed, 0, 'admins in the pool are NOT told when a holder is named');
  } finally { adminFeed.notify = orig; settings = {}; }
});

test('marked on behalf: the admin is named by their Users row', async () => {
  settings = { ATTENDANCE_NOTIFY_IDS: '555' };
  const bot = recordingBot();
  try {
    await svc.notifyMarked(bot, { entry: { ...ENTRY, logged_via: 'admin', marked_by: '999' }, markedById: '999', excludeUserId: '999' });
    assert.match(bot.calls[0].text, /marked by Krishna/);
  } finally { settings = {}; }
});

test('a repeat tap or an unconfirmed save sends nothing', async () => {
  const bot = recordingBot();
  assert.equal((await svc.notifyMarked(bot, { entry: ENTRY, alreadyLogged: true })).reason, 'already_logged');
  assert.equal((await svc.notifyMarked(bot, { entry: ENTRY, verified: false })).reason, 'unverified');
  assert.equal((await svc.notifyMarked(bot, {})).reason, 'no_entry');
  assert.equal(bot.calls.length, 0);
});

test('never throws: a Markdown failure retries plain, a dead chat is counted, a Settings error falls back', async () => {
  settings = { ATTENDANCE_NOTIFY_IDS: '555,666' };
  const calls = [];
  const bot = {
    async sendMessage(id, text, opts) {
      calls.push({ id: String(id), md: !!(opts && opts.parse_mode) });
      if (String(id) === '666') throw new Error('chat not found');
      if (opts && opts.parse_mode) throw new Error("can't parse entities");
      return { message_id: 1 };
    },
  };
  const r = await svc.notifyMarked(bot, { entry: ENTRY });
  assert.equal(r.sent, 1);
  assert.equal(r.skipped, 1);
  assert.ok(calls.some((c) => c.id === '555' && !c.md), 'plain-text retry for 555');
  const origGet = settingsRepository.getAll;
  settingsRepository.getAll = async () => { throw new Error('sheet down'); };
  try {
    const bot2 = recordingBot();
    const r2 = await svc.notifyMarked(bot2, { entry: ENTRY });
    assert.equal(r2.reason, 'admin_pool', 'a Settings error falls back to the pool, never throws');
  } finally { settingsRepository.getAll = origGet; settings = {}; }
});
