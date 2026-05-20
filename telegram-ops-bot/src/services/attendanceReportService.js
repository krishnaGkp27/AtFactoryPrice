/**
 * Attendance Report aggregator (ATT-RPT-1).
 *
 * Read-only summaries built on top of attendanceRepository + attendanceService.
 * Three windows: 7d (rolling), This Week (Mon–today, working days only),
 * This Month (1st of month → today).
 *
 * Design notes:
 * - All dates are computed in the admin's attendance timezone so "today"
 *   means today *for them*, not UTC.
 * - Per-employee stats are restricted to a scoped userIds list when the
 *   caller passes one — leaves the door open for the future
 *   "manager sees only their team" hierarchy without re-architecting.
 * - Working-day awareness: percentages divide by working-day count in
 *   the window, not raw 7. So a Sunday with no logs doesn't drag down
 *   coverage when Sunday isn't a working day.
 */

'use strict';

const attendanceRepo = require('../repositories/attendanceRepository');
const attendanceService = require('./attendanceService');
const usersRepo = require('../repositories/usersRepository');

// ---- date helpers (timezone-aware) -----------------------------------------

function ymdInTz(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch (_) { return date.toISOString().slice(0, 10); }
}

function weekdayInTz(date, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
  } catch (_) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()];
  }
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return ymdInTz(dt, 'UTC');
}

function shortLabel(ymd) {
  // "2026-05-20" -> "Wed 20 May"
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wk = weekdayInTz(dt, 'UTC');
  const mon = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' }).format(dt);
  return `${wk} ${String(d).padStart(2, '0')} ${mon}`;
}

function enumerateDates(startYmd, endYmd) {
  // inclusive on both ends
  const out = [];
  let cur = startYmd;
  while (cur <= endYmd) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

// ---- window selectors -------------------------------------------------------

function windowFor(kind, tz) {
  const today = ymdInTz(new Date(), tz);
  if (kind === '7d') {
    return { startYmd: addDays(today, -6), endYmd: today, label: 'Last 7 days (rolling)' };
  }
  if (kind === 'week') {
    // Monday → today, treating Mon as the week start (Western/ISO).
    const dt = new Date();
    const wk = weekdayInTz(dt, tz); // Sun/Mon/Tue/...
    const offsetToMon = { Mon: 0, Tue: -1, Wed: -2, Thu: -3, Fri: -4, Sat: -5, Sun: -6 }[wk] ?? 0;
    return { startYmd: addDays(today, offsetToMon), endYmd: today, label: 'This week (Mon–today)' };
  }
  // 'month'
  return { startYmd: today.slice(0, 7) + '-01', endYmd: today, label: 'This month' };
}

// ---- core aggregator --------------------------------------------------------

/**
 * Build a structured summary for the given window.
 *
 * @param {object} opts
 * @param {'7d'|'week'|'month'} opts.kind
 * @param {string[]} [opts.scopedUserIds]  If passed, restrict per-employee
 *                                         stats to this subset (useful for
 *                                         hierarchical "manager sees team"
 *                                         later).
 */
async function buildReport(opts) {
  const kind = opts && opts.kind ? opts.kind : '7d';
  const cfg = await attendanceService.getConfig();
  const tz = cfg.timezone;
  const win = windowFor(kind, tz);

  // Pull all attendance rows in window. attendanceRepo.getRange uses
  // string compare which is safe because dates are zero-padded YYYY-MM-DD.
  let rows = [];
  try { rows = await attendanceRepo.getRange(win.startYmd, win.endYmd); }
  catch (_) {}

  // Resolve user names + filter to scoped + active users.
  let allUsers = [];
  try { allUsers = await usersRepo.getAll(); } catch (_) {}
  const activeMap = new Map(
    allUsers
      .filter((u) => (u.status || 'active') === 'active' && u.user_id)
      .map((u) => [String(u.user_id), u]),
  );

  // Required set = ghost-filtered required users (intersected with active).
  // We only count people who are *required* to log attendance — anyone else
  // who happened to log is surfaced separately, not folded into coverage.
  const requiredIds = cfg.requiredUsers.filter((id) => activeMap.has(id));
  const requiredSet = new Set(requiredIds);
  const scopeSet = opts && Array.isArray(opts.scopedUserIds) && opts.scopedUserIds.length
    ? new Set(opts.scopedUserIds.map(String))
    : null;
  const inScope = (id) => (scopeSet ? scopeSet.has(String(id)) : true);

  // Build per-date map: date -> Map<telegram_id, row>
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    byDate.get(r.date).set(r.telegram_id, r);
  }

  // Working-day filter — percentages divide by working-day count.
  const allDates = enumerateDates(win.startYmd, win.endYmd);
  const workingDays = new Set(cfg.workingDays); // ['Mon','Tue',...]
  const workingDates = allDates.filter((d) => {
    const [y, m, dd] = d.split('-').map(Number);
    const wk = weekdayInTz(new Date(Date.UTC(y, m - 1, dd)), 'UTC');
    return workingDays.has(wk);
  });

  // ---- Daily breakdown -----------------------------------------------------
  const daily = workingDates.map((date) => {
    const present = byDate.get(date) || new Map();
    const presentCount = requiredIds.filter((id) => present.has(id) && inScope(id)).length;
    const requiredCount = requiredIds.filter(inScope).length;
    const pct = requiredCount ? Math.round((presentCount / requiredCount) * 100) : 0;
    return { date, label: shortLabel(date), present: presentCount, required: requiredCount, pct };
  });

  // ---- Per-employee summary ------------------------------------------------
  const perEmployee = requiredIds
    .filter(inScope)
    .map((id) => {
      const u = activeMap.get(id);
      const name = (u && u.name) || `User ${id.slice(-4)}`;
      const daysPresent = workingDates.filter((d) => byDate.get(d) && byDate.get(d).has(id)).length;
      const totalDays = workingDates.length;
      const pct = totalDays ? Math.round((daysPresent / totalDays) * 100) : 0;
      return { id, name, daysPresent, totalDays, pct };
    })
    .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));

  // ---- Today (same as embedded hub panel, kept for the report card) --------
  const todayDate = ymdInTz(new Date(), tz);
  const todayPresentMap = byDate.get(todayDate) || new Map();
  const todayPresent = requiredIds
    .filter((id) => todayPresentMap.has(id) && inScope(id))
    .map((id) => {
      const u = activeMap.get(id);
      const row = todayPresentMap.get(id);
      return {
        id,
        name: (u && u.name) || `User ${id.slice(-4)}`,
        location: row.location,
        loggedAt: row.logged_at,
        viaAdmin: row.logged_via === 'admin',
      };
    });
  const todayMissing = requiredIds
    .filter((id) => !todayPresentMap.has(id) && inScope(id))
    .map((id) => {
      const u = activeMap.get(id);
      return { id, name: (u && u.name) || `User ${id.slice(-4)}` };
    });

  return {
    kind,
    label: win.label,
    timezone: tz,
    startYmd: win.startYmd,
    endYmd: win.endYmd,
    requiredCount: requiredIds.filter(inScope).length,
    workingDateCount: workingDates.length,
    daily,
    perEmployee,
    today: {
      date: todayDate,
      present: todayPresent,
      missing: todayMissing,
    },
  };
}

/**
 * Format report -> CSV string (one row per employee per working day, plus
 * a header row). Used by [📥 Export CSV] button to send the admin a file.
 */
function toCsv(report) {
  const lines = ['date,telegram_id,name,present,location,logged_at,via'];
  // Reconstruct from perEmployee + daily wouldn't preserve location/via.
  // Re-pull rows via attendanceRepo? Caller can do that; for now we
  // serialise the *summary* shape so the export reflects what's shown.
  for (const emp of report.perEmployee) {
    lines.push(`# ${emp.name},${emp.id},,${emp.daysPresent}/${emp.totalDays} (${emp.pct}%),,,`);
  }
  lines.push('');
  lines.push('day_summary_date,present,required,pct');
  for (const d of report.daily) {
    lines.push(`${d.date},${d.present},${d.required},${d.pct}%`);
  }
  return lines.join('\n');
}

module.exports = {
  buildReport,
  toCsv,
  // exposed for tests
  _internals: { ymdInTz, weekdayInTz, addDays, shortLabel, windowFor, enumerateDates },
};
