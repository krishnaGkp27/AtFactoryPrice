/**
 * ATT-C3 — morning attendance reminder (the scheduler ATT-C1/C2 left
 * dormant; owner mandate 19-Jul-2026: everyone with an assigned department
 * reports attendance by 09:30).
 *
 * Scheduler = morningDigest pattern: minute tick, catch-up semantics
 * (fires on the first tick at/after the configured time, so a redeploy
 * that overlaps the send time still fires), in-memory once-per-day guard
 * set BEFORE sending so a hung send can't double-fire. State sheets are
 * banned (storage rule 5b) — a mid-morning redeploy may re-remind, which
 * is acceptable for a nudge.
 *
 * At ATTENDANCE_REMINDER_TIME (default 09:00, admin-editable in the 🗓
 * Attendance hub) on working days, every audience member (see
 * attendanceService.getAudience — department members by default) who has
 * NOT yet marked today gets a DM: report by ATTENDANCE_DEADLINE_TIME
 * (default 09:30) with a tappable 📍 Mark Attendance button. Employees
 * already marked get nothing. Best-effort per recipient — a blocked DM
 * never stops the rest.
 *
 * The 10:00 admin digest closes the loop with a 🕘 Attendance category
 * (who's still missing after the deadline) — see morningDigest.js.
 */

'use strict';

const attendanceService = require('./attendanceService');
const settingsRepository = require('../repositories/settingsRepository');
const logger = require('../utils/logger');

const CHECK_INTERVAL_MS = 60 * 1000;

let _timer = null;
let _lastSentDay = null;

function timeInTz(now, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  } catch (_) {
    return now.toISOString().slice(11, 16);
  }
}

// Day + weekday derive from the INJECTED now (not the wall clock) so the
// once-per-day and working-day gates stay testable and consistent with
// the time gate.
function dayInTz(now, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); }
  catch (_) { return now.toISOString().slice(0, 10); }
}
function weekdayInTz(now, tz) {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(now); }
  catch (_) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getUTCDay()]; }
}

/**
 * One scheduler pass. Returns the number of reminders sent (0 when not
 * due / disabled / non-working day / everyone already marked). Never throws.
 */
async function tick(bot, now = new Date()) {
  try {
    const settings = await settingsRepository.getAll().catch(() => ({}));
    if (Number(settings.ATTENDANCE_REMINDER_ENABLED ?? 1) !== 1) return 0;
    const cfg = await attendanceService.getConfig();
    const day = dayInTz(now, cfg.timezone);
    if (_lastSentDay === day) return 0;
    if (timeInTz(now, cfg.timezone) < String(cfg.reminderTime || '09:00').padStart(5, '0')) return 0;
    const weekday = weekdayInTz(now, cfg.timezone);
    if (!cfg.workingDays.some((d) => d.toLowerCase() === weekday.toLowerCase())) { _lastSentDay = day; return 0; }
    _lastSentDay = day; // before sending — a hung send must not double-fire

    const audience = await attendanceService.getAudience();
    if (!audience.length) return 0;
    const { rows } = await attendanceService.getTodayAll(cfg.timezone);
    const marked = new Set(rows.map((r) => String(r.telegram_id)));
    const pendingUsers = audience.filter((a) => !marked.has(a.user_id));

    let sent = 0;
    for (const person of pendingUsers) {
      try {
        await bot.sendMessage(person.user_id,
          `⏰ Good morning, ${person.name}!\n\nPlease mark your attendance before *${cfg.deadlineTime}*.`,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '📍 Mark Attendance', callback_data: 'act:mark_attendance' }]] },
          });
        sent += 1;
      } catch (e) {
        logger.warn(`attendanceReminder: DM to ${person.user_id} failed: ${e.message}`);
      }
    }
    if (sent) logger.info(`attendanceReminder: nudged ${sent}/${pendingUsers.length} unmarked of ${audience.length} required`);
    return sent;
  } catch (e) {
    logger.error('attendanceReminder tick failed:', e.message);
    return 0;
  }
}

function start(bot) {
  if (_timer) return;
  tick(bot).catch(() => {});
  _timer = setInterval(() => tick(bot).catch(() => {}), CHECK_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  logger.info('attendanceReminder scheduler started (minute tick)');
}

/** Test hook — reset the once-per-day guard and timer. */
function _resetForTests() {
  _lastSentDay = null;
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, tick, _resetForTests };
