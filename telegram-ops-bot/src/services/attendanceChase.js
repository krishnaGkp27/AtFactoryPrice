'use strict';

/**
 * attendanceChase — ATT-R1 (owner, 28-Oct-2026).
 *
 * "I want to bring in a feature where the admin can give a constant alert or
 * notification to the departments or employee group in a case where they
 * don't mark the attendance. Sending card messages as it will affect their
 * transportation and salary payment. You can also give them a button to mark
 * it now so that they can do it on a single tap."
 *
 * Rulings (28-Oct-2026): the card wording as proposed · automatic mode OFF at
 * launch (a Settings switch) · every 30 or 60 minutes until the 🕒 Cutoff ·
 * scope = departments AND a per-person pick.
 *
 * A CHASE is one admin decision: "these people, this often, until the
 * cutoff". Each person in it holds exactly ONE live card —
 *
 *   ⏰ Attendance not marked · 2nd reminder
 *   Abdul, your attendance for 28-Oct-2026 is not marked yet.
 *   The deadline was 09:30.
 *
 *   Unmarked days count against your transport allowance and your salary
 *   payment.                                          [📍 Mark now]
 *
 * — the previous card is deleted when the next one is sent (never a stack),
 * the moment they mark the live card is rewritten to ✅ and they drop out,
 * and the chase ends at the cutoff, at ⏹ Stop, or when the last person
 * marks. A person belongs to at most one live chase (the newest wins).
 *
 * In-memory by design (storage rule 5b: operational state is not a sheet;
 * a chase is a morning's worth of viewer state, not a business record) —
 * a redeploy ends a running manual chase and the admin re-taps; the
 * automatic mode re-arms itself after the restart. Every start and end is
 * an AuditLog row. Never throws — a failed DM must not break the scheduler.
 *
 * Settings: ATTENDANCE_CHASE_TEXT (the consequence sentence),
 * ATTENDANCE_CHASE_AUTO (1 = start a chase for everyone missing at the
 * deadline on working days, no admin tap), ATTENDANCE_CHASE_EVERY_MIN (the
 * automatic interval). The cutoff is the existing ATTENDANCE_CUTOFF_TIME.
 */

const attendanceService = require('./attendanceService');
const usersRepository = require('../repositories/usersRepository');
const settingsRepository = require('../repositories/settingsRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const logger = require('../utils/logger');
const fmtDate = require('../utils/formatDate');
const { mdEscape } = require('../utils/flowKit');

const DEFAULT_TEXT = 'Unmarked days count against your transport allowance and your salary payment.';
// `atd:now` (attendanceFlow): the card comes down and the mark flow opens;
// with ONE configured location it goes straight to the next step.
const MARK_NOW = { inline_keyboard: [[{ text: '📍 Mark now', callback_data: 'atd:now' }]] };
const KEEP_ENDED_MS = 36 * 60 * 60 * 1000;

const _chases = new Map(); // id → chase
let _seq = 0;
let _autoDay = null;

function timeInTz(now, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  } catch (_) { return now.toISOString().slice(11, 16); }
}
function dayInTz(now, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); }
  catch (_) { return now.toISOString().slice(0, 10); }
}
function weekdayInTz(now, tz) {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(now); }
  catch (_) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getUTCDay()]; }
}
function hhmm(s, fallback) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  return `${String(Math.min(23, Number(m[1]))).padStart(2, '0')}:${m[2]}`;
}
function ordinal(n) {
  const r = n % 100;
  if (r >= 11 && r <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

async function consequenceText() {
  try {
    const all = await settingsRepository.getAll();
    const t = all && String(all.ATTENDANCE_CHASE_TEXT || '').trim();
    return t || DEFAULT_TEXT;
  } catch (_) { return DEFAULT_TEXT; }
}

/**
 * The employee's card. Pure.
 * @returns {string} Markdown v1
 */
function cardText({ name, date, deadline, nth, text }) {
  const head = nth > 1
    ? `⏰ *Attendance not marked* · ${ordinal(nth)} reminder`
    : '⏰ *Attendance not marked*';
  return `${head}\n${mdEscape(String(name || ''))}, your attendance for ${fmtDate(date)} is not marked yet.\n`
    + `The deadline was ${deadline}.\n\n${mdEscape(String(text || DEFAULT_TEXT))}`;
}

/**
 * Who is required today and has not marked. "Required" is the attendance
 * AUDIENCE (ATT-C3: every active department member plus the manual
 * Required-Users list — the same people the 09:00 nudge reaches), so the
 * owner's "departments or employee group" is covered; each person carries
 * their departments for the scope chips.
 * @returns {Promise<Array<{id:string, name:string, departments:string[]}>>}
 */
async function missingNow() {
  const cfg = await attendanceService.getConfig();
  const { rows } = await attendanceService.getTodayAll(cfg.timezone);
  const marked = new Set(rows.map((r) => String(r.telegram_id)));
  const audience = await attendanceService.getAudience();
  let users = [];
  try { users = await usersRepository.getAll(); } catch (_) { users = []; }
  const byId = new Map(users.map((u) => [String(u.user_id), u]));
  return audience
    .filter((a) => !marked.has(String(a.user_id)))
    .map((a) => {
      const u = byId.get(String(a.user_id));
      return {
        id: String(a.user_id),
        name: a.name || (u && u.name) || `User ${String(a.user_id).slice(-4)}`,
        departments: (u && Array.isArray(u.departments)) ? u.departments.filter(Boolean) : [],
      };
    });
}

function pending(chase) { return [...chase.targets.values()].filter((t) => !t.markedAt); }
function marked(chase) { return [...chase.targets.values()].filter((t) => t.markedAt); }

async function audit(kind, data, by) {
  try { await auditLogRepository.append(kind, data, by || 'system'); } catch (e) { logger.warn(`attendanceChase: audit ${kind} failed: ${e.message}`); }
}

function endChase(chase, reason) {
  if (!chase.live) return;
  chase.live = false;
  chase.endedReason = reason;
  chase.endedAt = Date.now();
  audit('attendance.chase_ended', {
    chaseId: chase.id, reason, scope: chase.scopeLabel,
    marked: marked(chase).map((t) => t.id), pending: pending(chase).map((t) => t.id),
  }, chase.by).catch(() => {});
}

/** Send (or re-send) one person's card; the previous copy comes down first. Never throws. */
async function sendCard(bot, chase, target) {
  if (target.msgId) {
    try { await bot.deleteMessage(target.id, target.msgId); } catch (_) { /* already gone */ }
    target.msgId = null;
  }
  const text = cardText({ name: target.name, date: chase.date, deadline: chase.deadline, nth: target.sent + 1, text: chase.text });
  try {
    let m;
    try { m = await bot.sendMessage(target.id, text, { parse_mode: 'Markdown', reply_markup: MARK_NOW }); }
    catch (_) { m = await bot.sendMessage(target.id, text.replace(/\*/g, ''), { reply_markup: MARK_NOW }); }
    target.msgId = (m && m.message_id) || null;
    target.sent += 1;
    target.lastAt = Date.now();
    return true;
  } catch (e) {
    logger.warn(`attendanceChase: card to ${target.id} failed: ${e.message}`);
    target.failed += 1;
    return false;
  }
}

/**
 * Start a chase. People already marked today are dropped; a person in an
 * older live chase moves to this one. Sends the first card at once.
 * @param {object} bot
 * @param {object} p
 * @param {string} p.by           admin id ('auto' for the automatic mode)
 * @param {Array<{id:string,name:string}>} p.targets
 * @param {string} p.scopeLabel   'Sales (3)' · 'Everyone missing (6)' · 'Abdul, Musa'
 * @param {number} p.intervalMin  0 = once
 * @param {Date}   [p.now]
 * @returns {Promise<{ok:boolean, reason?:string, chase?:object}>}
 */
async function startChase(bot, { by, targets, scopeLabel, intervalMin = 0, auto = false, now = new Date() } = {}) {
  try {
    const cfg = await attendanceService.getConfig();
    const tz = cfg.timezone;
    // The attendance day as the service defines it (the sheet's today).
    const { date, rows } = await attendanceService.getTodayAll(tz);
    const done = new Set(rows.map((r) => String(r.telegram_id)));
    const seen = new Set();
    const list = (targets || []).filter((t) => t && t.id && !done.has(String(t.id)) && !seen.has(String(t.id)) && seen.add(String(t.id)));
    if (!list.length) return { ok: false, reason: 'nobody_missing' };
    for (const c of _chases.values()) {
      if (!c.live) continue;
      for (const t of list) c.targets.delete(String(t.id));
      if (!c.targets.size || !pending(c).length) endChase(c, 'superseded');
    }
    _seq += 1;
    const chase = {
      id: `${date}-${_seq}`, date, tz, by: String(by || ''), auto: !!auto,
      scopeLabel: String(scopeLabel || ''), intervalMin: Number(intervalMin) || 0,
      until: hhmm(cfg.cutoffTime, '23:59'), deadline: hhmm(cfg.deadlineTime, '09:30'),
      text: await consequenceText(),
      startedAt: now.getTime(), nextAt: Number(intervalMin) ? now.getTime() + Number(intervalMin) * 60000 : null,
      live: true, endedReason: '', endedAt: null,
      targets: new Map(list.map((t) => [String(t.id), {
        id: String(t.id), name: String(t.name || t.id), msgId: null, sent: 0, lastAt: 0, markedAt: '', failed: 0,
      }])),
    };
    _chases.set(chase.id, chase);
    for (const t of chase.targets.values()) await sendCard(bot, chase, t); // eslint-disable-line no-await-in-loop
    await audit('attendance.chase_started', {
      chaseId: chase.id, scope: chase.scopeLabel, intervalMin: chase.intervalMin, until: chase.until,
      auto: chase.auto, targets: [...chase.targets.keys()],
    }, chase.by);
    logger.info(`attendanceChase: ${chase.id} started by ${chase.by} — ${chase.scopeLabel}, every ${chase.intervalMin || 'once'} until ${chase.until}`);
    return { ok: true, chase };
  } catch (e) {
    logger.error(`attendanceChase.startChase failed: ${e.message}`);
    return { ok: false, reason: 'error' };
  }
}

/** Stop a live chase (admin ⏹). Pending people keep their last card. */
function stopChase(chaseId, by) {
  const chase = _chases.get(String(chaseId));
  if (!chase || !chase.live) return false;
  chase.stoppedBy = String(by || '');
  endChase(chase, 'stopped');
  return true;
}

/**
 * Someone marked: rewrite their live card to ✅ and drop them from any chase.
 * Called by the mark flows next to the ATT-N1 broadcast. Never throws.
 */
async function onMarked(bot, telegramId, { loggedAt } = {}) {
  const id = String(telegramId || '');
  if (!id) return 0;
  let n = 0;
  for (const chase of _chases.values()) {
    if (!chase.live) continue;
    const t = chase.targets.get(id);
    if (!t || t.markedAt) continue;
    t.markedAt = loggedAt || new Date().toISOString();
    n += 1;
    if (t.msgId) {
      const at = timeInTz(new Date(t.markedAt), chase.tz);
      try {
        await bot.editMessageText(`✅ *Marked at ${at}* · thank you, ${mdEscape(t.name)}.`,
          { chat_id: id, message_id: t.msgId, parse_mode: 'Markdown' });
      } catch (_) { /* card gone or unchanged */ }
    }
    if (!pending(chase).length) endChase(chase, 'all_marked');
  }
  return n;
}

/**
 * One scheduler pass (every minute from attendanceReminder): re-sends on
 * due chases, ends them at the cutoff, and runs the automatic mode. Never
 * throws.
 * @returns {Promise<number>} cards sent this pass
 */
async function tick(bot, now = new Date()) {
  let sent = 0;
  try {
    const cfg = await attendanceService.getConfig();
    const tz = cfg.timezone;
    const day = dayInTz(now, tz);
    const clock = timeInTz(now, tz);
    for (const chase of _chases.values()) {
      if (!chase.live) {
        if (chase.endedAt && now.getTime() - chase.endedAt > KEEP_ENDED_MS) _chases.delete(chase.id);
        continue;
      }
      if (chase.date !== day || clock >= chase.until) { endChase(chase, 'cutoff'); continue; }
      if (!pending(chase).length) { endChase(chase, 'all_marked'); continue; }
      if (!chase.intervalMin || !chase.nextAt || now.getTime() < chase.nextAt) continue;
      // A mark that reached the sheet without the hook (restart, hand edit)
      // still counts — re-read before re-sending.
      const { rows } = await attendanceService.getTodayAll(tz);
      const done = new Set(rows.map((r) => String(r.telegram_id)));
      for (const t of pending(chase)) {
        if (done.has(t.id)) { t.markedAt = t.markedAt || now.toISOString(); continue; }
        if (await sendCard(bot, chase, t)) sent += 1; // eslint-disable-line no-await-in-loop
      }
      chase.nextAt = now.getTime() + chase.intervalMin * 60000;
      if (!pending(chase).length) endChase(chase, 'all_marked');
    }
    const settings = await settingsRepository.getAll().catch(() => ({}));
    if (Number(settings.ATTENDANCE_CHASE_AUTO ?? 0) === 1 && _autoDay !== day
      && clock >= hhmm(cfg.deadlineTime, '09:30')) {
      _autoDay = day; // before sending — a hung send must not double-fire
      const weekday = weekdayInTz(now, tz);
      const working = (cfg.workingDays || []).some((d) => String(d).toLowerCase() === weekday.toLowerCase());
      if (working && clock < hhmm(cfg.cutoffTime, '23:59')) {
        const every = Number(settings.ATTENDANCE_CHASE_EVERY_MIN ?? 30) || 30;
        const targets = await missingNow();
        if (targets.length) {
          const r = await startChase(bot, { by: 'auto', targets, scopeLabel: `Everyone missing (${targets.length})`, intervalMin: every, auto: true, now });
          if (r.ok) sent += targets.length;
        }
      }
    }
  } catch (e) {
    logger.error(`attendanceChase tick failed: ${e.message}`);
  }
  return sent;
}

/** Live chases for a day (newest first). */
function liveChases(date) {
  return [..._chases.values()].filter((c) => c.live && (!date || c.date === date)).sort((a, b) => b.startedAt - a.startedAt);
}
/** The most recently ended chase of a day, for the status screen. */
function lastEnded(date) {
  return [..._chases.values()].filter((c) => !c.live && (!date || c.date === date)).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))[0] || null;
}

/** A plain-object view for screens. */
function summary(chase) {
  if (!chase) return null;
  return {
    id: chase.id, date: chase.date, by: chase.by, auto: chase.auto, scopeLabel: chase.scopeLabel,
    intervalMin: chase.intervalMin, until: chase.until, live: chase.live, endedReason: chase.endedReason,
    nextAt: chase.nextAt, nextLabel: chase.nextAt ? timeInTz(new Date(chase.nextAt), chase.tz) : '',
    total: chase.targets.size,
    marked: marked(chase).map((t) => ({ id: t.id, name: t.name, at: timeInTz(new Date(t.markedAt), chase.tz) })),
    pending: pending(chase).map((t) => ({ id: t.id, name: t.name, sent: t.sent, lastAt: t.lastAt ? timeInTz(new Date(t.lastAt), chase.tz) : '', failed: t.failed })),
  };
}

/** Test hook. */
function _resetForTests() { _chases.clear(); _seq = 0; _autoDay = null; }

module.exports = {
  startChase, stopChase, onMarked, tick, missingNow, liveChases, lastEnded, summary, cardText,
  DEFAULT_TEXT, _resetForTests,
  _internals: { ordinal, hhmm, timeInTz, dayInTz },
};
