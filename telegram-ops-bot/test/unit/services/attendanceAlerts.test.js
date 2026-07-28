'use strict';

/**
 * ATT-V2 — admins are DMed when attendance fails to save (owner, 28-Jul).
 *
 * The design tension: these failures are systemic. When Sheets is down every
 * employee marking that morning fails, so alerting per failure would send the
 * owner twenty identical DMs before breakfast and teach them to swipe it
 * away. The alert is therefore throttled per reason, and reports how many it
 * suppressed so nothing is lost — only compressed.
 */

process.env.ADMIN_IDS = '777,888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '../../..');
const alerts = require(path.join(ROOT, 'src/services/attendanceAlerts'));
const settingsRepository = require(path.join(ROOT, 'src/repositories/settingsRepository'));

function fakeBot(failFor = null) {
  const sent = [];
  return {
    sent,
    sendMessage: async (chatId, text) => {
      if (failFor && String(chatId) === String(failFor)) throw new Error('blocked');
      sent.push({ chatId: String(chatId), text });
      return { message_id: 1 };
    },
  };
}

function setCooldown(min) {
  settingsRepository.getAll = async () => ({ ATTENDANCE_ALERT_COOLDOWN_MIN: min });
}

test('a write failure DMs every admin, naming the employee and the error', async () => {
  alerts._reset(); setCooldown(15);
  const bot = fakeBot();
  const n = await alerts.alertAdmins(bot, {
    reason: 'write_failed', employee: 'Yarima', date: '2026-07-28',
    location: 'Kano Office', error: 'Sheets 503',
  });
  assert.equal(n, 2, 'both admins');
  assert.deepEqual(bot.sent.map((s) => s.chatId).sort(), ['777', '888']);
  const t = bot.sent[0].text;
  assert.match(t, /Attendance NOT saving/);
  assert.match(t, /Yarima/);
  assert.match(t, /Sheets 503/);
  assert.match(t, /2026-07-28/);
});

test('an unverified write gets its OWN message — different cause, different fix', async () => {
  alerts._reset(); setCooldown(15);
  const bot = fakeBot();
  await alerts.alertAdmins(bot, { reason: 'unverified', employee: 'Yarima', date: '2026-07-28' });
  const t = bot.sent[0].text;
  assert.match(t, /saved but unreadable/i);
  assert.match(t, /date column format/i, 'points at the actual cause we hit on 27-Jul');
});

test('a Sheets outage does not storm the admins — one alert, the rest counted', async () => {
  alerts._reset(); setCooldown(15);
  const bot = fakeBot();
  for (const who of ['Yarima', 'Abdul', 'Musa', 'Ada']) {
    await alerts.alertAdmins(bot, { reason: 'write_failed', employee: who, error: 'Sheets 503' });
  }
  assert.equal(bot.sent.length, 2, 'exactly one alert per admin, not four');
});

test('the next alert after the cooldown reports what was suppressed', async () => {
  alerts._reset(); setCooldown(0); // 0 = no cooldown, but suppression still counts within the same ms
  const bot = fakeBot();
  await alerts.alertAdmins(bot, { reason: 'write_failed', employee: 'Yarima' });
  setCooldown(15);
  await alerts.alertAdmins(bot, { reason: 'write_failed', employee: 'Abdul' });
  await alerts.alertAdmins(bot, { reason: 'write_failed', employee: 'Musa' });
  setCooldown(0);
  await alerts.alertAdmins(bot, { reason: 'write_failed', employee: 'Ada' });
  const last = bot.sent[bot.sent.length - 1].text;
  assert.match(last, /2 more since the last alert/, 'suppressed failures are reported, not dropped');
  assert.match(last, /Abdul/, 'and named');
  assert.match(last, /Musa/);
});

test('the two reasons throttle independently', async () => {
  alerts._reset(); setCooldown(15);
  const bot = fakeBot();
  await alerts.alertAdmins(bot, { reason: 'write_failed', employee: 'Yarima' });
  await alerts.alertAdmins(bot, { reason: 'unverified', employee: 'Yarima' });
  assert.equal(bot.sent.length, 4, 'a different failure mode is a different alert');
});

test('the acting admin is excluded — they are already looking at the error', async () => {
  alerts._reset(); setCooldown(15);
  const bot = fakeBot();
  const n = await alerts.alertAdmins(bot, { reason: 'write_failed', employee: 'Yarima', excludeUserId: '777' });
  assert.equal(n, 1);
  assert.deepEqual(bot.sent.map((s) => s.chatId), ['888']);
});

test('a total send failure does NOT start the cooldown — the next real alert still goes', async () => {
  alerts._reset(); setCooldown(15);
  const dead = { sendMessage: async () => { throw new Error('blocked'); } };
  assert.equal(await alerts.alertAdmins(dead, { reason: 'write_failed', employee: 'Yarima' }), 0);
  const bot = fakeBot();
  const n = await alerts.alertAdmins(bot, { reason: 'write_failed', employee: 'Abdul' });
  assert.equal(n, 2, 'muting an hour of alerts because one send failed would be the worst outcome');
});

test('alerting never throws, whatever it is handed', async () => {
  alerts._reset(); setCooldown(15);
  await assert.doesNotReject(() => alerts.alertAdmins(null, { reason: 'write_failed' }));
  await assert.doesNotReject(() => alerts.alertAdmins(fakeBot(), {}));
  await assert.doesNotReject(() => alerts.alertAdmins(fakeBot(), { reason: 'nonsense' }));
  assert.equal(await alerts.alertAdmins(fakeBot(), { reason: 'nonsense' }), 0, 'unknown reasons are ignored');
});
