'use strict';

/**
 * dateCalendar — the shared "pick a past date" keyboard (SELL-T2 grammar).
 *
 * Sell Bale grew a quick-chip row + month grid in July; Sales Browser has
 * its own copy. Rather than add a third for transfers (TRF-16), the
 * geometry lives here and each flow supplies its own callback prefix.
 *
 * Callback shapes produced (given prefix 'trf'):
 *   trf:dd:<YYYY-MM-DD>   a day pick (chip or grid cell)
 *   trf:dm:<YYYY-MM>      month navigation
 *   trf:dq                back to the quick chips
 *   trf:noop              inert cell
 *
 * Bounds are the caller's: no future days, and no further back than
 * `maxDaysBack`. Out-of-range grid cells render as inert dots so the
 * limits are visible rather than silently enforced.
 */

const { LAGOS_TZ } = require('./dates');
const fmtDate = require('./formatDate');

/** ISO day in Lagos, `daysBack` days ago. */
function lagosISO(daysBack = 0) {
  return new Date(Date.now() - daysBack * 86400000)
    .toLocaleDateString('en-CA', { timeZone: LAGOS_TZ });
}

/**
 * Quick chips: Today, Yesterday, then the next five days back, plus a
 * calendar door.
 * @param {string} p callback prefix (e.g. 'trf')
 * @param {{days?:number}} [opts]
 * @returns {Array<Array<object>>} keyboard rows
 */
function quickChipRows(p, opts = {}) {
  const n = opts.days || 7;
  const days = Array.from({ length: n }, (_, i) => lagosISO(i));
  const rows = [
    [{ text: `📅 Today (${fmtDate(days[0])})`, callback_data: `${p}:dd:${days[0]}` }],
    [{ text: `Yesterday (${fmtDate(days[1])})`, callback_data: `${p}:dd:${days[1]}` }],
  ];
  for (let i = 2; i < n; i += 2) {
    const row = [{ text: fmtDate(days[i]), callback_data: `${p}:dd:${days[i]}` }];
    if (days[i + 1]) row.push({ text: fmtDate(days[i + 1]), callback_data: `${p}:dd:${days[i + 1]}` });
    rows.push(row);
  }
  rows.push([{ text: '📆 Older date — calendar', callback_data: `${p}:dm:${days[0].slice(0, 7)}` }]);
  return rows;
}

/**
 * Month grid for `ym` ('YYYY-MM').
 * @param {string} p callback prefix
 * @param {string} ym
 * @param {{maxDaysBack?:number, highlight?:string}} [opts]
 *        highlight renders that ISO day as [D] — a TYPED date only marks
 *        the day; the TAP stays the sole commit (owner rule, 21-Jul).
 * @returns {Array<Array<object>>} keyboard rows
 */
function calendarRows(p, ym, opts = {}) {
  const maxBack = opts.maxDaysBack || 90;
  const todayIso = lagosISO(0);
  const oldestIso = lagosISO(maxBack);
  const [y, m] = String(ym).split('-').map(Number);
  const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=Sun
  const inert = { text: ' ', callback_data: `${p}:noop` };

  const prevYm = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;
  const nextYm = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
  const rows = [[
    prevYm >= oldestIso.slice(0, 7) ? { text: '◀', callback_data: `${p}:dm:${prevYm}` } : inert,
    { text: `${monthName} ${y}`, callback_data: `${p}:noop` },
    nextYm <= todayIso.slice(0, 7) ? { text: '▶', callback_data: `${p}:dm:${nextYm}` } : inert,
  ]];
  rows.push(['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => ({ text: d, callback_data: `${p}:noop` })));

  let week = new Array(firstDow).fill(inert);
  for (let d = 1; d <= daysInMonth; d += 1) {
    const iso = `${ym}-${String(d).padStart(2, '0')}`;
    const pickable = iso <= todayIso && iso >= oldestIso;
    week.push(pickable
      ? { text: opts.highlight === iso ? `[${d}]` : String(d), callback_data: `${p}:dd:${iso}` }
      : { text: '·', callback_data: `${p}:noop` });
    if (week.length === 7) { rows.push(week); week = []; }
  }
  if (week.length) { while (week.length < 7) week.push(inert); rows.push(week); }
  rows.push([{ text: '⬅ Quick dates', callback_data: `${p}:dq` }]);
  return rows;
}

/**
 * Range check shared by every entry point (chip, grid, typed).
 * @returns {{ok:true}|{ok:false, reason:'future'|'too_old'}}
 */
function checkRange(iso, maxDaysBack = 90) {
  if (iso > lagosISO(0)) return { ok: false, reason: 'future' };
  if (iso < lagosISO(maxDaysBack)) return { ok: false, reason: 'too_old' };
  return { ok: true };
}

module.exports = { lagosISO, quickChipRows, calendarRows, checkRange };
