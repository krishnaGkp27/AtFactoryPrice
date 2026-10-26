'use strict';

/**
 * attendanceNotify — ATT-N1 (owner, 26-Oct-2026).
 *
 * "I want the Black Panther bot to send a notification of attendance marked
 * by the employees as soon as they submit. It should be broadcast to all
 * the admins." … "For now, all the marks from the employees will go to all
 * the admins in the admin pool, which I have created from the Railway ID.
 * Later, I will make a separate holder for this required responsibility,
 * where this notification will go to only that person."
 *
 * One DM per successful mark, the moment the row is saved:
 *
 *   🕘 Attendance · Abdul marked Present
 *   📍 Kano office · 08:42 · 26-Oct-2026
 *   📡 Position verified · 38 m from site · 📷 Photo
 *
 * Who receives it, in order:
 *   1. Settings `ATTENDANCE_NOTIFY_IDS` (CSV of Telegram ids) when set — the
 *      owner's future "holder of this responsibility". One cell, no deploy.
 *   2. Otherwise the Railway admin pool (`ADMIN_IDS`), through the Admin
 *      Activity Feed (`adminFeed.notify`, event `attendance.marked`), so each
 *      admin can still switch it off for their own phone on 🔔 Notifications.
 *
 * What is NOT sent: a repeat tap on the same day (nothing new was recorded),
 * a mark that failed or could not be read back (ATT-V2 already alerts the
 * admins about those — a second DM would be a duplicate). The person who
 * tapped is never told twice: they hold the receipt already.
 *
 * Never throws — a notification failure must not break a mark that saved.
 */

const logger = require('../utils/logger');
const settingsRepository = require('../repositories/settingsRepository');
const usersRepository = require('../repositories/usersRepository');
const adminFeed = require('./adminFeed');
const fmtDate = require('../utils/formatDate');
const { mdEscape } = require('../utils/flowKit');

const EVENT_TYPE = 'attendance.marked';
const DEFAULT_TZ = 'Africa/Lagos';

function fmtTime(iso, timezone) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || DEFAULT_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch (_) { return String(iso).slice(11, 16); }
}

/**
 * The ids named in Settings `ATTENDANCE_NOTIFY_IDS`; [] when the cell is
 * blank or unreadable (→ the admin pool).
 * @returns {Promise<string[]>}
 */
async function overrideIds() {
  try {
    const all = await settingsRepository.getAll();
    const raw = all && all.ATTENDANCE_NOTIFY_IDS;
    return String(raw == null ? '' : raw).split(',').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    logger.warn(`attendanceNotify: Settings read failed (${e.message}); using the admin pool`);
    return [];
  }
}

async function timezone() {
  try {
    const all = await settingsRepository.getAll();
    return (all && String(all.ATTENDANCE_TIMEZONE || '').trim()) || DEFAULT_TZ;
  } catch (_) { return DEFAULT_TZ; }
}

async function nameOf(userId) {
  if (!userId) return '';
  try {
    const u = await usersRepository.findByUserId(String(userId));
    if (u && u.name) return u.name;
  } catch (_) { /* fall through */ }
  return String(userId);
}

/**
 * The three-line card. Pure: no I/O.
 * @param {object} p
 * @param {object} p.entry           the saved attendance row
 * @param {string} [p.tz]            IANA timezone for the time of day
 * @param {string} [p.markedByName]  set when an admin marked on behalf
 * @returns {string} Markdown v1
 */
function buildText({ entry, tz, markedByName }) {
  const e = entry || {};
  const who = mdEscape(String(e.employee_name || e.telegram_id || 'Someone').trim());
  const by = markedByName ? ` · marked by ${mdEscape(markedByName)}` : '';
  const lines = [`🕘 *Attendance* · *${who}* marked Present${by}`];
  const when = [fmtTime(e.logged_at, tz), e.date ? fmtDate(e.date) : ''].filter(Boolean).join(' · ');
  lines.push(`📍 ${mdEscape(String(e.location || '—'))}${when ? ` · ${when}` : ''}`);
  const facts = [];
  const dist = e.distance_m;
  if (dist !== undefined && dist !== null && String(dist) !== '') facts.push(`📡 Position verified · ${dist} m from site`);
  else if (e.geo) facts.push('📡 Position recorded');
  if (e.photo_file_id) facts.push('📷 Photo');
  if (facts.length) lines.push(facts.join(' · '));
  return lines.join('\n');
}

async function sendDirect(bot, ids, text, excludeUserId) {
  let sent = 0;
  let skipped = 0;
  for (const id of ids) {
    if (excludeUserId && String(id) === String(excludeUserId)) { skipped += 1; continue; }
    try {
      await bot.sendMessage(id, text, { parse_mode: 'Markdown' });
      sent += 1;
    } catch (_) {
      try { await bot.sendMessage(id, text); sent += 1; } catch (e2) {
        logger.warn(`attendanceNotify: send to ${id} failed: ${e2.message}`);
        skipped += 1;
      }
    }
  }
  return { sent, skipped };
}

/**
 * Tell the audience about a mark that just saved. Never throws.
 * @param {object} bot
 * @param {object} p
 * @param {object} p.entry            the saved row (markPresent's result.entry)
 * @param {boolean} [p.alreadyLogged] true = a repeat tap; nothing is sent
 * @param {boolean} [p.verified]      false = could not be read back; ATT-V2 alerts instead
 * @param {string} [p.markedById]     the admin who marked on behalf (if any)
 * @param {string} [p.excludeUserId]  the actor — never told twice
 * @returns {Promise<{sent:number, skipped:number, reason?:string}>}
 */
async function notifyMarked(bot, p = {}) {
  try {
    if (!p.entry) return { sent: 0, skipped: 0, reason: 'no_entry' };
    if (p.alreadyLogged) return { sent: 0, skipped: 0, reason: 'already_logged' };
    if (p.verified === false) return { sent: 0, skipped: 0, reason: 'unverified' };
    const [tz, markedByName] = await Promise.all([
      timezone(), p.markedById ? nameOf(p.markedById) : Promise.resolve(''),
    ]);
    const text = buildText({ entry: p.entry, tz, markedByName });
    const ids = await overrideIds();
    if (ids.length) {
      const r = await sendDirect(bot, ids, text, p.excludeUserId);
      return { ...r, reason: 'override' };
    }
    const r = await adminFeed.notify(bot, EVENT_TYPE, text, { parse_mode: 'Markdown' },
      p.excludeUserId ? { excludeUserId: p.excludeUserId } : {});
    return { sent: r.sent || 0, skipped: r.skipped || 0, reason: 'admin_pool' };
  } catch (e) {
    logger.warn(`attendanceNotify.notifyMarked failed: ${e.message}`);
    return { sent: 0, skipped: 0, reason: 'error' };
  }
}

module.exports = {
  notifyMarked,
  buildText,
  EVENT_TYPE,
  _internals: { overrideIds, fmtTime },
};
