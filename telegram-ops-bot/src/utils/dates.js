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

module.exports = { todayInLagos, compareWithToday, daysBeforeToday, LAGOS_TZ };
