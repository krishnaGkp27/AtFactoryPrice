'use strict';

/**
 * ATT-V2 — tell the admins, in real time, when attendance does not save.
 *
 * ATT-V1 made the failure visible to the EMPLOYEE. That is necessary but not
 * sufficient: the employee sees one card and moves on, and the person who
 * needs to act on a broken sheet is the admin. Owner asked for the DM.
 *
 * Why this is throttled rather than fire-per-failure: the failures worth
 * alerting on are almost always systemic — Sheets is down, the quota is
 * spent, the credentials rotated. In that state EVERY employee marking that
 * morning fails, so a naive implementation sends the owner twenty identical
 * DMs in five minutes and trains them to swipe the alert away. One alert per
 * reason per cooldown, carrying a count of what it suppressed, keeps the
 * signal honest.
 *
 * Never throws: an alerting failure must not break the attendance flow that
 * is already having a bad time.
 */

const config = require('../config');
const settingsRepository = require('../repositories/settingsRepository');
const logger = require('../utils/logger');

/** reason -> { lastSentMs, suppressed, names:Set } */
const _state = new Map();

const REASONS = {
  write_failed: {
    icon: '🔴',
    title: 'Attendance NOT saving',
    advice: 'Employees are being told they are not marked. Check the Attendance sheet and the Google credentials.',
  },
  unverified: {
    icon: '⚠️',
    title: 'Attendance saved but unreadable',
    advice: 'The row was written but could not be read back — reports and the reminder sweep will miss it. Check the date column format.',
  },
};

async function cooldownMs() {
  const fallback = settingsRepository.DEFAULTS.ATTENDANCE_ALERT_COOLDOWN_MIN;
  try {
    const v = Number((await settingsRepository.getAll()).ATTENDANCE_ALERT_COOLDOWN_MIN);
    return (Number.isFinite(v) && v >= 0 ? v : fallback) * 60000;
  } catch (_) {
    return fallback * 60000;
  }
}

/**
 * DM every admin about an attendance failure, at most once per cooldown per
 * reason. Suppressed failures are counted and reported on the next alert, so
 * nothing is lost — only compressed.
 *
 * @param {object} bot Telegram bot
 * @param {object} p
 * @param {string} p.reason 'write_failed' | 'unverified'
 * @param {string} [p.employee] display name of the affected employee
 * @param {string} [p.date] attendance day (ISO)
 * @param {string} [p.location]
 * @param {string} [p.error] underlying error message
 * @param {string} [p.excludeUserId] admin who already saw the error on screen
 * @returns {Promise<number>} admins actually messaged
 */
async function alertAdmins(bot, p = {}) {
  try {
    const reason = String(p.reason || '');
    const meta = REASONS[reason];
    if (!meta || !bot) return 0;

    const now = Date.now();
    const st = _state.get(reason) || { lastSentMs: 0, suppressed: 0, names: new Set() };
    const gap = await cooldownMs();

    if (st.lastSentMs && now - st.lastSentMs < gap) {
      st.suppressed += 1;
      if (p.employee) st.names.add(String(p.employee));
      _state.set(reason, st);
      return 0;
    }

    const alsoAffected = st.suppressed
      ? `\n\n_…and ${st.suppressed} more since the last alert${st.names.size ? `: ${[...st.names].slice(0, 8).join(', ')}` : ''}._`
      : '';

    const lines = [
      `${meta.icon} *${meta.title}*`,
      '',
      p.employee ? `Employee: *${p.employee}*` : null,
      p.date ? `Date: ${p.date}` : null,
      p.location ? `Location: ${p.location}` : null,
      p.error ? `Error: \`${String(p.error).slice(0, 160)}\`` : null,
      '',
      `_${meta.advice}_`,
    ].filter((l) => l !== null);

    const text = lines.join('\n') + alsoAffected;

    let sent = 0;
    for (const adminId of config.access.adminIds) {
      if (p.excludeUserId && String(adminId) === String(p.excludeUserId)) continue;
      try {
        await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' });
        sent += 1;
      } catch (e) {
        logger.warn(`attendanceAlerts: DM to admin ${adminId} failed: ${e.message}`);
      }
    }

    // Only start the cooldown once an alert actually landed — otherwise a
    // total send failure would mute the next hour of real alerts too.
    if (sent) _state.set(reason, { lastSentMs: now, suppressed: 0, names: new Set() });
    return sent;
  } catch (e) {
    logger.warn(`attendanceAlerts.alertAdmins failed (ignored): ${e.message}`);
    return 0;
  }
}

/** Test seam — clear throttle state between cases. */
function _reset() { _state.clear(); }

module.exports = { alertAdmins, _reset, _internals: { REASONS } };
