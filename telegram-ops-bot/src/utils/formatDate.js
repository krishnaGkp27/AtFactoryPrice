// The business timezone. Declared here rather than imported so this file
// stays dependency-free (it is required by ~40 modules, including dates.js
// consumers). Same value as dates.js LAGOS_TZ.
const LAGOS_TZ = 'Africa/Lagos';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Format any date string/object to short display: 26-Mar-2026
 *
 * Internal storage stays YYYY-MM-DD; this is display-only. Used across
 * approval cards, sale summaries, supply requests, notifications, ledger
 * views, follow-ups, etc. — single source of truth for "how dates appear
 * in Telegram messages".
 *
 * Output format: DD-MMM-YYYY (2-digit day, 3-letter month, 4-digit year).
 * The 4-digit year is intentional — avoids ambiguity between 2026 and 2126,
 * and matches the format the operator confirmed for production use.
 */
function fmtDate(raw) {
  if (!raw) return '—';
  const s = String(raw).trim();
  // TIME-1 (owner, 12-Aug-2026) — a full TIMESTAMP is an instant, not a
  // calendar day. The ymd branch below would take its leading YYYY-MM-DD,
  // which for a stored `toISOString()` is the UTC day: an instant recorded
  // at 23:30 UTC is already the NEXT day in Lagos and used to render one day
  // early on ~20 cards, chips and reports. Resolve the Lagos calendar day
  // first, then format it exactly as before.
  //
  // Only strings that carry an explicit zone (`Z` or ±hh:mm) are treated as
  // instants — a bare date, or a naive `YYYY-MM-DDTHH:MM` with no offset,
  // keeps the old byte-identical path because there is no zone to convert.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && /(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const inst = new Date(s);
    if (!isNaN(inst.getTime())) return fmtDate(fmtDate.lagosDay(inst));
  }
  let dt;
  const ymd = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (ymd) { dt = new Date(+ymd[1], +ymd[2] - 1, +ymd[3]); }
  else {
    const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
    if (dmy) { dt = new Date(+dmy[3], +dmy[2] - 1, +dmy[1]); }
    else { dt = new Date(s); }
  }
  if (!dt || isNaN(dt.getTime())) return s;
  const dd = String(dt.getDate()).padStart(2, '0');
  const mon = MONTHS[dt.getMonth()];
  const yyyy = String(dt.getFullYear());
  return `${dd}-${mon}-${yyyy}`;
}

/**
 * Same date, 2-digit year: 22-Jul-26.
 *
 * For INLINE-KEYBOARD BUTTONS, where the label shares a line with other text
 * and Telegram truncates rather than wraps — the audit checklist chip reads
 * `✅ 408/204 (done 22-Jul-26)`. Message bodies keep fmtDate's 4-digit year;
 * that stays the default everywhere, per the operator's confirmed format.
 *
 * @param {string|Date} raw any date fmtDate accepts
 * @returns {string} DD-MMM-YY, or fmtDate's own fallback when unparseable
 */
fmtDate.short = function short(raw) {
  const full = fmtDate(raw);
  // Only trim a year we actually produced — an unparseable input comes back
  // as the caller's raw string and must not be sliced.
  return /^\d{2}-[A-Z][a-z]{2}-\d{4}$/.test(full)
    ? `${full.slice(0, 7)}${full.slice(9)}` // '22-Jul-' + '26'
    : full;
};

/**
 * TIME-1 (owner, 12-Aug-2026) — "make the time in human readable format".
 *
 * An INSTANT (a stored `new Date().toISOString()`) rendered as the Lagos
 * wall-clock the business actually runs on: `12-Aug-2026, 16:58`.
 *
 * Why both halves come out of ONE formatter: a 23:30 UTC instant is already
 * 00:30 the NEXT day in Lagos. Formatting the date with fmtDate and the time
 * with a separate Intl call would print yesterday's date beside today's
 * clock. One `formatToParts` pass over Africa/Lagos means the two halves
 * cannot disagree.
 *
 * 24-hour, matching every other clock the bot prints (attendance, morning
 * digest, the 20:00 expense report).
 *
 * @param {string|Date} raw an ISO timestamp (or anything Date can parse)
 * @param {{dateOnly?:boolean}} [opts] dateOnly drops the clock half
 * @returns {string} 'DD-MMM-YYYY, HH:MM', or fmtDate's fallback when unparseable
 */
fmtDate.withTime = function withTime(raw, opts = {}) {
  if (!raw) return '\u2014';
  // A DATE-ONLY string carries no clock. Parsing it would invent one (UTC
  // midnight reads as 01:00 in Lagos), so hand it to fmtDate untouched
  // rather than printing an hour nobody recorded.
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return fmtDate(raw);
  const dt = raw instanceof Date ? raw : new Date(String(raw).trim());
  if (isNaN(dt.getTime())) return fmtDate(raw);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LAGOS_TZ,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(dt).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const day = `${parts.day}-${parts.month}-${parts.year}`;
  if (opts.dateOnly) return day;
  return `${day}, ${parts.hour}:${parts.minute}`;
};

/**
 * The Lagos CALENDAR DAY of an instant, as YYYY-MM-DD.
 *
 * The counterpart to withTime for code that needs to compare or store a day
 * rather than show one. `todayInLagos()` answers "what day is it now"; this
 * answers "what Lagos day was this stored instant".
 *
 * @param {string|Date} raw
 * @returns {string} 'YYYY-MM-DD', or '' when unparseable
 */
fmtDate.lagosDay = function lagosDay(raw) {
  if (!raw) return '';
  const dt = raw instanceof Date ? raw : new Date(String(raw).trim());
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-CA', { timeZone: LAGOS_TZ });
};

module.exports = fmtDate;
