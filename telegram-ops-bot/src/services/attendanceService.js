/**
 * Attendance business logic (ATT-C1 / ATT-C2).
 *
 * Owns:
 *   - timezone-aware "today" date math
 *   - parsing/serialising the Settings keys
 *   - markPresent() — the single mutation employees can perform
 *   - getRequiredUsers(), getLocations(), isRequired()
 *
 * All settings live in the existing `Settings` sheet (key/value pairs).
 * Defaults below are returned when a key isn't set yet.
 */

'use strict';

const settingsRepo = require('../repositories/settingsRepository');
const attendanceRepo = require('../repositories/attendanceRepository');
const usersRepo = require('../repositories/usersRepository');
const auditLogRepo = require('../repositories/auditLogRepository');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Settings keys + defaults
// ---------------------------------------------------------------------------

const KEYS = {
  REQUIRED_USERS:        'ATTENDANCE_REQUIRED_USERS',     // CSV of telegram_ids
  LOCATIONS:             'ATTENDANCE_LOCATIONS',          // CSV of location names
  TIMEZONE:              'ATTENDANCE_TIMEZONE',           // IANA tz (e.g. Africa/Lagos)
  REMINDER_TIME:         'ATTENDANCE_REMINDER_TIME',      // HH:MM (24h)
  ESCALATE_AFTER_HOURS:  'ATTENDANCE_ESCALATE_AFTER_HOURS', // integer
  REPORT_TIME:           'ATTENDANCE_REPORT_TIME',        // HH:MM (24h)
  CUTOFF_TIME:           'ATTENDANCE_CUTOFF_TIME',        // HH:MM (24h)
  WORKING_DAYS:          'ATTENDANCE_WORKING_DAYS',       // CSV of Mon..Sun
};

const DEFAULTS = {
  [KEYS.REQUIRED_USERS]:       '',
  // Seed locations from the user's marketing-team list. Editable by admin
  // from inside the bot (USR-C2 Locations editor) — this seed is just the
  // first-deploy value when the Settings cell is still empty.
  [KEYS.LOCATIONS]:            'Lagos Office,House,Kano Office,Chinos Store,Idumota Store',
  [KEYS.TIMEZONE]:             'Africa/Lagos',
  [KEYS.REMINDER_TIME]:        '09:00',
  [KEYS.ESCALATE_AFTER_HOURS]: '3',
  [KEYS.REPORT_TIME]:          '22:00',
  [KEYS.CUTOFF_TIME]:          '23:30',
  [KEYS.WORKING_DAYS]:         'Mon,Tue,Wed,Thu,Fri,Sat',
};

function parseCsv(v) {
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

async function getConfig() {
  const all = await settingsRepo.getAll();
  const get = (k) => {
    const raw = all[k];
    if (raw === undefined || raw === null || raw === '') return DEFAULTS[k];
    return String(raw);
  };
  return {
    requiredUsers: parseCsv(get(KEYS.REQUIRED_USERS)),
    locations:     parseCsv(get(KEYS.LOCATIONS)),
    timezone:      get(KEYS.TIMEZONE),
    reminderTime:  get(KEYS.REMINDER_TIME),
    escalateAfterHours: Number(get(KEYS.ESCALATE_AFTER_HOURS)) || 3,
    reportTime:    get(KEYS.REPORT_TIME),
    cutoffTime:    get(KEYS.CUTOFF_TIME),
    workingDays:   parseCsv(get(KEYS.WORKING_DAYS)),
  };
}

async function setConfigKey(key, value) {
  // Validate the key exists in our known set to prevent typos polluting Settings.
  if (!Object.values(KEYS).includes(key)) {
    throw new Error(`attendanceService.setConfigKey: unknown key "${key}"`);
  }
  return settingsRepo.set(key, value);
}

/**
 * ATT-C2-LITE — write REQUIRED_USERS, auto-dropping any IDs that don't
 * correspond to an active user. Prevents the "Currently required: 7 /
 * 3 active" mismatch from accumulating ghost IDs over time (smoke-test
 * leftovers, typos, deactivated employees).
 *
 * @param {string[]} ids                 Telegram IDs the admin wants required
 * @returns {Promise<{saved:string[], dropped:string[]}>}
 */
async function setRequiredUsers(ids) {
  const wanted = Array.from(new Set((ids || []).map((x) => String(x).trim()).filter(Boolean)));
  const allUsers = await usersRepo.getAll();
  const activeSet = new Set(
    allUsers
      .filter((u) => (u.status || 'active') === 'active' && u.user_id)
      .map((u) => String(u.user_id)),
  );
  const saved = wanted.filter((id) => activeSet.has(id));
  const dropped = wanted.filter((id) => !activeSet.has(id));
  await settingsRepo.set(KEYS.REQUIRED_USERS, saved.join(','));
  if (dropped.length) {
    try {
      await auditLogRepo.append('attendance.ghost_ids_cleaned', { dropped }, 'system');
    } catch (_) {}
  }
  return { saved, dropped };
}

/**
 * Return a structured snapshot of the required-users list for display:
 * which IDs match real active users vs. which are ghosts. The picker UI
 * uses this to show a clean "(N of M active)" count and to surface a
 * one-tap cleanup CTA when ghosts exist.
 */
async function getRequiredUsersDetailed() {
  const cfg = await getConfig();
  const allUsers = await usersRepo.getAll();
  const activeMap = new Map(
    allUsers
      .filter((u) => (u.status || 'active') === 'active' && u.user_id)
      .map((u) => [String(u.user_id), u]),
  );
  const active = [];
  const ghost = [];
  for (const id of cfg.requiredUsers) {
    if (activeMap.has(id)) {
      active.push({ id, user: activeMap.get(id) });
    } else {
      ghost.push(id);
    }
  }
  return { active, ghost, totalActiveUsers: activeMap.size };
}

// ---------------------------------------------------------------------------
// Timezone-aware "today"
// ---------------------------------------------------------------------------

/**
 * Get today's date string (YYYY-MM-DD) in the given IANA timezone.
 * Uses Intl.DateTimeFormat which is built-in and handles DST.
 */
function todayInTz(timezone) {
  const tz = timezone || DEFAULTS[KEYS.TIMEZONE];
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    return parts;
  } catch (e) {
    // Bad tz string — fall back to UTC date.
    logger.warn(`attendanceService.todayInTz: bad timezone "${tz}", using UTC`);
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
}

/**
 * 3-letter weekday code (Mon..Sun) for "now" in the given timezone.
 */
function weekdayInTz(timezone) {
  const tz = timezone || DEFAULTS[KEYS.TIMEZONE];
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
      .format(new Date());
  } catch (_) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[new Date().getUTCDay()];
  }
}

// ---------------------------------------------------------------------------
// Membership / state checks
// ---------------------------------------------------------------------------

async function isRequired(telegramId) {
  const cfg = await getConfig();
  return cfg.requiredUsers.includes(String(telegramId));
}

async function isWorkingDay(timezone) {
  const cfg = await getConfig();
  const today = weekdayInTz(timezone || cfg.timezone);
  return cfg.workingDays.some((d) => d.toLowerCase() === String(today).toLowerCase());
}

async function getTodayEntry(telegramId, timezone) {
  const cfg = await getConfig();
  const date = todayInTz(timezone || cfg.timezone);
  return attendanceRepo.findByDateUser(date, telegramId);
}

async function hasLoggedToday(telegramId, timezone) {
  return !!(await getTodayEntry(telegramId, timezone));
}

async function getTodayAll(timezone) {
  const cfg = await getConfig();
  const date = todayInTz(timezone || cfg.timezone);
  const rows = await attendanceRepo.getByDate(date);
  return { date, rows };
}

// ---------------------------------------------------------------------------
// Mutation — mark present
// ---------------------------------------------------------------------------

/**
 * Mark the user present for today with a chosen location.
 *
 * - Idempotent: returns the existing row if already marked today.
 * - Optional adminUserId (for ATT-C2 "mark on behalf").
 *
 * @returns {Promise<{ok: boolean, entry?: object, reason?: string}>}
 */
async function markPresent({ telegramId, name, location, adminUserId = null, when = null }) {
  if (!telegramId) return { ok: false, reason: 'missing_telegram_id' };
  if (!location) return { ok: false, reason: 'missing_location' };

  const cfg = await getConfig();
  if (!cfg.locations.includes(location)) {
    return { ok: false, reason: 'location_not_in_admin_list', allowed: cfg.locations };
  }

  const date = todayInTz(cfg.timezone);
  const existing = await attendanceRepo.findByDateUser(date, telegramId);
  if (existing) {
    return { ok: true, entry: existing, alreadyLogged: true };
  }

  // Resolve a display name. Prefer the caller-supplied name (snapshotted at
  // submit time), fall back to the Users sheet so admin-marked rows still
  // get a readable label.
  let resolvedName = (name || '').trim();
  if (!resolvedName) {
    try {
      const u = await usersRepo.findByUserId(telegramId);
      if (u && u.name) resolvedName = u.name;
    } catch (_) {}
  }
  if (!resolvedName) resolvedName = String(telegramId);

  const entry = {
    date,
    telegram_id: String(telegramId),
    employee_name: resolvedName,
    status: 'present',
    location,
    logged_at: when || new Date().toISOString(),
    logged_via: adminUserId ? 'admin' : 'self',
    marked_by: adminUserId ? String(adminUserId) : '',
    reason: '',
  };

  await attendanceRepo.append(entry);
  try {
    await auditLogRepo.append('attendance.marked', {
      date, telegram_id: telegramId, location, via: entry.logged_via,
      marked_by: entry.marked_by,
    }, adminUserId || telegramId);
  } catch (_) {}

  return { ok: true, entry, alreadyLogged: false };
}

module.exports = {
  KEYS,
  DEFAULTS,
  getConfig,
  setConfigKey,
  setRequiredUsers,
  getRequiredUsersDetailed,
  todayInTz,
  weekdayInTz,
  isRequired,
  isWorkingDay,
  getTodayEntry,
  hasLoggedToday,
  getTodayAll,
  markPresent,
  _internals: { parseCsv },
};
