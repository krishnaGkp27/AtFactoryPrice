/**
 * Lagos-timezone date helpers for sale-date gating.
 *
 * Uses Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }) which
 * returns YYYY-MM-DD — same format our date pickers already produce, so
 * string comparison works correctly.
 */

const LAGOS_TZ = 'Africa/Lagos';

function todayInLagos() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: LAGOS_TZ }).format(new Date());
}

/**
 * Compare YYYY-MM-DD strings against today (Lagos).
 * Returns:
 *   < 0  : saleDate is before today (backdated)
 *   0    : saleDate is today
 *   > 0  : saleDate is in the future
 * Invalid input returns NaN (caller must handle).
 */
function compareWithToday(saleDateYMD) {
  if (!saleDateYMD || typeof saleDateYMD !== 'string') return NaN;
  const m = saleDateYMD.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return NaN;
  const today = todayInLagos();
  if (saleDateYMD.slice(0, 10) === today) return 0;
  return saleDateYMD.slice(0, 10) < today ? -1 : 1;
}

/**
 * How many days before today is this saleDate (Lagos)?
 * Returns 0 if same day or future, positive integer if in the past.
 */
function daysBeforeToday(saleDateYMD) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(saleDateYMD || '');
  if (!m) return 0;
  const sale = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const todayStr = todayInLagos();
  const t = /^(\d{4})-(\d{2})-(\d{2})/.exec(todayStr);
  const today = Date.UTC(+t[1], +t[2] - 1, +t[3]);
  const diff = Math.round((today - sale) / (24 * 60 * 60 * 1000));
  return diff > 0 ? diff : 0;
}

// ─── salesDate normalisation (SDN-1) ──────────────────────────────────────
//
// Sales people enter dates in many shapes (typed natural-language, AI-parsed
// strings, calendar pickers). Persisting whatever shape they typed produces
// a sheet with mixed formats (`28-March-2026`, `2026-04-07`, `07 April 2026`)
// AND breaks reports that rely on ISO lexical comparison (queryEngine sales
// filters, compareWithToday backdated-sale gate, cold-stock cutoff).
//
// `normalizeSalesDate(input)` converts ANY of the observed input shapes to
// ISO `YYYY-MM-DD` (Lagos calendar day). Unparseable input returns `null`
// so callers can fall back to their default (usually `todayInLagos()`).
//
// Convention assumed: Nigerian DMY (day-month-year). Ambiguous numeric
// inputs like `03/04/2026` are interpreted as 3 April 2026, NEVER 4 March.

const MONTHS = {
  jan: '01', january: '01',
  feb: '02', february: '02',
  mar: '03', march: '03',
  apr: '04', april: '04',
  may: '05',
  jun: '06', june: '06',
  jul: '07', july: '07',
  aug: '08', august: '08',
  sep: '09', sept: '09', september: '09',
  oct: '10', october: '10',
  nov: '11', november: '11',
  dec: '12', december: '12',
};

function _pad2(n) { return String(n).padStart(2, '0'); }
function _validYmd(y, m, d) {
  const yi = parseInt(y, 10), mi = parseInt(m, 10), di = parseInt(d, 10);
  if (!yi || !mi || !di) return null;
  if (mi < 1 || mi > 12) return null;
  if (di < 1 || di > 31) return null;
  // Use UTC to avoid TZ drift; we're only validating calendar plausibility.
  const dt = new Date(Date.UTC(yi, mi - 1, di));
  if (dt.getUTCFullYear() !== yi || dt.getUTCMonth() !== mi - 1 || dt.getUTCDate() !== di) {
    return null; // e.g. 31-Feb caught here
  }
  return `${yi}-${_pad2(mi)}-${_pad2(di)}`;
}

/**
 * Normalise any common sale-date shape to ISO YYYY-MM-DD (Lagos day).
 *
 * Accepted inputs (case-insensitive, leading/trailing whitespace OK):
 *   - ISO:                "2026-04-07", "2026/04/07"
 *   - DMY numeric:        "07-04-2026", "7/4/2026", "07.04.2026"
 *   - DMY with monthname: "7 April 2026", "07-April-2026", "7-Apr-2026"
 *   - MonthName-D-YYYY:   "April 7, 2026", "April-7-2026"
 *   - Relative words:     "today", "yesterday"
 *
 * Returns:
 *   - ISO string `YYYY-MM-DD` on success
 *   - `null` for empty/null input or any unparseable string
 *
 * Never throws.
 */
function normalizeSalesDate(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;

  if (s === 'today') return todayInLagos();
  if (s === 'yesterday') {
    const t = todayInLagos();
    const [y, m, d] = t.split('-').map((v) => parseInt(v, 10));
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    return `${prev.getUTCFullYear()}-${_pad2(prev.getUTCMonth() + 1)}-${_pad2(prev.getUTCDate())}`;
  }

  // ISO YYYY-MM-DD or YYYY/MM/DD (with optional time tail).
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[t\s].*)?$/);
  if (m) return _validYmd(m[1], m[2], m[3]);

  // DMY numeric: DD-MM-YYYY / D/M/YYYY / D.M.YYYY
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return _validYmd(m[3], m[2], m[1]);

  // DMY with month name: "7 April 2026", "07-April-2026", "7-Apr-2026"
  m = s.match(/^(\d{1,2})[\s\-/](\p{L}+)[\s\-/](\d{4})$/u);
  if (m) {
    const mm = MONTHS[m[2]];
    if (mm) return _validYmd(m[3], mm, m[1]);
  }

  // MonthName-D-YYYY: "April 7, 2026", "April-7-2026"
  m = s.match(/^(\p{L}+)[\s\-/](\d{1,2}),?[\s\-/](\d{4})$/u);
  if (m) {
    const mm = MONTHS[m[1]];
    if (mm) return _validYmd(m[3], mm, m[2]);
  }

  return null;
}

module.exports = { todayInLagos, compareWithToday, daysBeforeToday, normalizeSalesDate, LAGOS_TZ };
