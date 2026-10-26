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
 *
 * ATT-N2 (owner, 26-Oct-2026 — "I am not able to see the picture attached
 * by the employee. Can you give me a chip where I can tap, and it will show
 * the image attached?"): when the mark carried a photo the card ends with
 * `📷 Show photo` (`atn:p:<telegram_id>:<date>` — session-free, date-bound,
 * so it fetches THAT day's photo for years). The tap sends the photo under
 * its card as a reply with a `🗑 Hide photo` chip; tapping Show again
 * REPLACES the earlier picture (ephemeralDocs, kind 'attn' — a peek, never
 * a chat resident, ATT-E1 03-Aug-2026). Anyone the broadcast could reach
 * may tap: the admin pool or an ATTENDANCE_NOTIFY_IDS holder. No position
 * chip, deliberately: the 03-Aug ruling is distance only, never coordinates.
 */

const logger = require('../utils/logger');
const settingsRepository = require('../repositories/settingsRepository');
const usersRepository = require('../repositories/usersRepository');
const adminFeed = require('./adminFeed');
const attendanceRepository = require('../repositories/attendanceRepository');
const ephemeralDocs = require('./ephemeralDocs');
const auth = require('../middlewares/auth');
const fmtDate = require('../utils/formatDate');
const { mdEscape } = require('../utils/flowKit');

const EVENT_TYPE = 'attendance.marked';
const PREFIX = 'atn:';
const PHOTO_KIND = 'attn';
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

/**
 * ATT-N2 — the card's keyboard: one `📷 Show photo` chip when the mark
 * carried a photo, else nothing. Pure.
 * @param {object} entry the saved attendance row
 * @returns {object|null} Telegram reply_markup or null
 */
function keyboardFor(entry) {
  const e = entry || {};
  if (!e.photo_file_id || !e.telegram_id || !e.date) return null;
  return { inline_keyboard: [[{ text: '📷 Show photo', callback_data: `${PREFIX}p:${e.telegram_id}:${e.date}` }]] };
}

async function sendDirect(bot, ids, text, excludeUserId, extraOpts = {}) {
  let sent = 0;
  let skipped = 0;
  for (const id of ids) {
    if (excludeUserId && String(id) === String(excludeUserId)) { skipped += 1; continue; }
    try {
      await bot.sendMessage(id, text, { parse_mode: 'Markdown', ...extraOpts });
      sent += 1;
    } catch (_) {
      try { await bot.sendMessage(id, text, { ...extraOpts }); sent += 1; } catch (e2) {
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
    const kb = keyboardFor(p.entry);
    const extra = kb ? { reply_markup: kb } : {};
    const ids = await overrideIds();
    if (ids.length) {
      const r = await sendDirect(bot, ids, text, p.excludeUserId, extra);
      return { ...r, reason: 'override' };
    }
    const r = await adminFeed.notify(bot, EVENT_TYPE, text, { parse_mode: 'Markdown', ...extra },
      p.excludeUserId ? { excludeUserId: p.excludeUserId } : {});
    return { sent: r.sent || 0, skipped: r.skipped || 0, reason: 'admin_pool' };
  } catch (e) {
    logger.warn(`attendanceNotify.notifyMarked failed: ${e.message}`);
    return { sent: 0, skipped: 0, reason: 'error' };
  }
}

/** True for anyone the broadcast could have reached (admin pool or a named holder). */
async function mayView(userId) {
  if (auth.isAdmin(userId)) return true;
  const ids = await overrideIds();
  return ids.includes(String(userId));
}

/**
 * ATT-N2 — the `atn:*` taps. Session-free. Never throws.
 *   atn:p:<telegram_id>:<date>  send that day's photo under the card
 *   atn:x                        hide the photo the chip sits under
 * @returns {Promise<boolean>} true when the tap was ours
 */
async function handleCallback(bot, query) {
  const data = String((query && query.data) || '');
  if (!data.startsWith(PREFIX)) return false;
  const userId = String(query.from && query.from.id);
  const msg = query.message || {};
  const chatId = msg.chat && msg.chat.id;
  const toast = (text, alert) => bot.answerCallbackQuery(query.id, { text, show_alert: !!alert }).catch(() => {});
  try {
    if (data === `${PREFIX}x`) {
      try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) { /* already gone */ }
      await toast('Hidden');
      return true;
    }
    const m = data.match(/^atn:p:([^:]+):(\d{4}-\d{2}-\d{2})$/);
    if (!m) { await toast('Unknown tap'); return true; }
    if (!(await mayView(userId))) { await toast('Admins only.', true); return true; }
    let entry = null;
    try { entry = await attendanceRepository.findByDateUser(m[2], m[1]); } catch (_) { entry = null; }
    if (!entry || !entry.photo_file_id) { await toast('No photo on record for that mark.', true); return true; }
    // A peek, never a resident: Show again REPLACES the earlier picture.
    await ephemeralDocs.sweep(bot, userId, { kind: PHOTO_KIND });
    const tz = await timezone();
    const caption = `📷 ${String(entry.employee_name || entry.telegram_id).trim()} · ${entry.location || '—'}`
      + ` · ${fmtTime(entry.logged_at, tz)} · ${fmtDate(entry.date)}`;
    try {
      const sent = await bot.sendPhoto(chatId, entry.photo_file_id, {
        caption,
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true,
        reply_markup: { inline_keyboard: [[{ text: '🗑 Hide photo', callback_data: `${PREFIX}x` }]] },
      });
      if (sent && sent.message_id) ephemeralDocs.track(bot, userId, chatId, sent.message_id, PHOTO_KIND);
      await toast('Photo sent below');
    } catch (e) {
      logger.warn(`attendanceNotify: photo send failed: ${e.message}`);
      await toast('Telegram could not return that photo — the file may have expired.', true);
    }
    return true;
  } catch (e) {
    logger.warn(`attendanceNotify.handleCallback failed: ${e.message}`);
    await toast('Could not open that photo right now.');
    return true;
  }
}

module.exports = {
  notifyMarked,
  buildText,
  keyboardFor,
  handleCallback,
  EVENT_TYPE,
  PREFIX,
  _internals: { overrideIds, fmtTime, mayView },
};
