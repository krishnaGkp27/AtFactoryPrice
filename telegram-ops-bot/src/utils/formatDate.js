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

module.exports = fmtDate;
