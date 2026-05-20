/**
 * Data access for the `Attendance` sheet (ATT-C1).
 *
 * Columns:
 *   A date            (YYYY-MM-DD in attendance timezone)
 *   B telegram_id     (string)
 *   C employee_name   (snapshot at log time)
 *   D status          ('present' | 'not_logged' | 'absent' | 'on_leave' — V1 writes only 'present')
 *   E location        (one of admin-configured ATTENDANCE_LOCATIONS)
 *   F logged_at       (ISO timestamp)
 *   G logged_via      ('self' | 'admin' | 'auto')
 *   H marked_by       (telegram_id of admin if logged_via=admin)
 *   I reason          (optional free text)
 *
 * Primary key: (date, telegram_id). Idempotency is enforced by the
 * service layer via `findByDateUser()`; the repo itself only appends.
 */

'use strict';

const sheets = require('./sheetsClient');

const SHEET = 'Attendance';
const HEADERS = [
  'date', 'telegram_id', 'employee_name', 'status',
  'location', 'logged_at', 'logged_via', 'marked_by', 'reason',
];

function str(v) { return (v ?? '').toString().trim(); }

function parse(r, rowIndex) {
  return {
    rowIndex,
    date: str(r[0]),
    telegram_id: str(r[1]),
    employee_name: str(r[2]),
    status: str(r[3]) || 'present',
    location: str(r[4]),
    logged_at: str(r[5]),
    logged_via: str(r[6]) || 'self',
    marked_by: str(r[7]),
    reason: str(r[8]),
  };
}

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:I1');
  if (!rows.length || rows[0].length < HEADERS.length) {
    await sheets.updateRange(SHEET, 'A1:I1', [HEADERS]);
  }
}

async function getAll() {
  try {
    const rows = await sheets.readRange(SHEET, 'A2:I');
    return rows.map((r, i) => parse(r, i + 2)).filter((e) => e.date && e.telegram_id);
  } catch (_) {
    return [];
  }
}

async function getByDate(date) {
  const all = await getAll();
  return all.filter((e) => e.date === String(date));
}

async function findByDateUser(date, telegramId) {
  const all = await getAll();
  return all.find((e) => e.date === String(date) && e.telegram_id === String(telegramId)) || null;
}

async function append(entry) {
  await ensureHeader();
  await sheets.appendRows(SHEET, [[
    str(entry.date),
    String(entry.telegram_id),
    str(entry.employee_name),
    str(entry.status) || 'present',
    str(entry.location),
    entry.logged_at || new Date().toISOString(),
    str(entry.logged_via) || 'self',
    str(entry.marked_by),
    str(entry.reason),
  ]]);
}

async function getRange(startDate, endDate) {
  const all = await getAll();
  return all.filter((e) => e.date >= startDate && e.date <= endDate);
}

module.exports = {
  getAll,
  getByDate,
  findByDateUser,
  append,
  getRange,
  SHEET,
  HEADERS,
};
