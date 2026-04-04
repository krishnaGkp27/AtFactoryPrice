const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Format any date string/object to short display: 25-Mar-26
 * Internal storage stays YYYY-MM-DD; this is display-only.
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
  const yy = String(dt.getFullYear()).slice(-2);
  return `${dd}-${mon}-${yy}`;
}

module.exports = fmtDate;
