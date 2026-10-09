'use strict';
/**
 * SRP-1 — 📊 Sales Report period: 📅 Weekly or 📆 Pick dates.
 *
 * Owner (03-Oct-2026): "Make it very simple. Just add a calendar to pick the
 * date. That's all." — "Remove the chips of monthly, quarterly, and yearly.
 * Just make it weekly and pick dates, and back to menu."
 *
 * Screens: period card → start-date grid → end-date grid (days before the
 * start inert) → the existing Group by card → the existing report, titled
 * with the range. The grid is the shared `dateCalendar` one.
 *
 * Period keys ride the existing `sr:` / `srg:` / `rxw:sales_*` callbacks:
 *   '7'         the last 7 Lagos days (the Weekly chip, unchanged)
 *   'D<a>.<b>'  an inclusive day range, both ends as base-36 days since
 *               2000-01-01 — 8 chars, so the report's "show all" callback
 *               (which carries the key AND a customer name) stays under
 *               Telegram's 64 bytes.
 *
 * Callbacks: srd:start · srd:dm:<YYYY-MM> · srd:dd:<ISO> · srd:back · srd:noop
 */
const sessionStore = require('../utils/sessionStore');
const menuNav = require('../utils/menuNav');
const { editOrSend } = require('../utils/telegramUI');
const { calendarRows, lagosISO } = require('../utils/dateCalendar');
const { fmtQty } = require('../utils/format');
const config = require('../config');

const SESSION_TYPE = 'sales_report_dates';
const MAX_DAYS_BACK = 366; // as far back as the retired Yearly chip reached
const EPOCH = Date.UTC(2000, 0, 1);
const dayNo = (iso) => Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - EPOCH) / 86400000);
const isoOf = (n) => new Date(EPOCH + n * 86400000).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso, withYear) => `${iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]}${withYear ? ` ${iso.slice(0, 4)}` : ''}`;

/** `D<from>.<to>` — the range's period key. */
function rangeKey(from, to) { return `D${dayNo(from).toString(36)}.${dayNo(to).toString(36)}`; }

/** @returns {{from:string,to:string}|{days:number}} */
function parseKey(key) {
  const m = /^D([0-9a-z]+)\.([0-9a-z]+)$/.exec(String(key || ''));
  if (m) return { from: isoOf(parseInt(m[1], 36)), to: isoOf(parseInt(m[2], 36)) };
  const days = parseInt(key, 10);
  return { days: Number.isFinite(days) && days > 0 ? days : 30 };
}

/** The range as people read it: `12 Sep – 03 Oct 2026` (the year once, twice when they differ). */
function rangeLabel(from, to) {
  return `${day(from, from.slice(0, 4) !== to.slice(0, 4))} – ${day(to, true)}`;
}

/** The report's title fragment: `Last 7 Days` or the range. */
function periodLabel(key) {
  const p = parseKey(key);
  return p.days ? `Last ${p.days} Days` : rangeLabel(p.from, p.to);
}

/** The Group-by card's title fragment: `Weekly` or the range. */
function titleLabel(key) {
  const p = parseKey(key);
  return p.days ? (p.days === 7 ? 'Weekly' : `Last ${p.days} days`) : rangeLabel(p.from, p.to);
}

/** Sold rows inside the period — a day count is counted back from the Lagos day (TIME-1); a range is inclusive at both ends. */
function filterByPeriod(sold, key) {
  const p = parseKey(key);
  if (p.days) { const cutoff = lagosISO(p.days); return sold.filter((r) => r.soldDate >= cutoff); }
  return sold.filter((r) => r.soldDate >= p.from && r.soldDate <= p.to);
}

/** The period card, for the tile and the typed door alike. */
function periodCard() {
  return {
    text: '📊 *Sales Report*\n\nSelect period:',
    opts: { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '📅 Weekly (7 days)', callback_data: 'sr:7' }],
      [{ text: '📆 Pick dates', callback_data: 'srd:start' }],
      [{ text: '⬅ Back to menu', callback_data: 'act:__back__' }],
    ] } },
  };
}

/** The month grid for one step: the start pick, or the end pick with the days before the start inert. */
function gridRows(ym, from) {
  const rows = calendarRows('srd', ym, { maxDaysBack: MAX_DAYS_BACK, highlight: from || undefined });
  rows.pop(); // the shared grid's "⬅ Quick dates" row — this picker has no quick chips
  if (from) {
    for (const row of rows) {
      row.forEach((cell, i) => {
        if (cell.callback_data.startsWith('srd:dd:') && cell.callback_data.slice(7) < from) row[i] = { text: '·', callback_data: 'srd:noop' };
      });
    }
  }
  rows.push([{ text: '⬅ Back', callback_data: 'srd:back' }, { text: '🏠 Menu', callback_data: 'act:__back__' }]);
  return rows;
}

async function showCalendar(bot, chatId, messageId, s) {
  const text = s.from
    ? `📊 *Sales Report*\n\nFrom ${day(s.from, true)} — to which date? Tap a day.`
    : '📊 *Sales Report*\n\nFrom which date? Tap a day.';
  await editOrSend(bot, chatId, messageId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: gridRows(s.ym, s.from) } });
}

/** The Group by card (was inline in the controller's `sr:` branch); the key waits in the session for `srg:`. */
async function showGroupBy(bot, chatId, messageId, uid, key) {
  sessionStore.set(uid, { type: 'sales_report_period', key });
  await editOrSend(bot, chatId, messageId, `📊 *${titleLabel(key)} Sales Report*\n\nGroup by:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '📦 Design wise', callback_data: 'srg:design' }],
      [{ text: '👤 Customer wise', callback_data: 'srg:customer' }],
      menuNav.backToMenuRow(),
    ] },
  });
}

async function handleCallback(bot, cq) {
  const data = cq.data;
  const uid = String(cq.from.id);
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  if (!config.access.adminIds.includes(uid)) { await bot.answerCallbackQuery(cq.id, { text: 'Admin only.' }); return; }
  await bot.answerCallbackQuery(cq.id);
  if (data === 'srd:noop') return;
  if (data === 'srd:start') {
    const s = { type: SESSION_TYPE, ym: lagosISO(0).slice(0, 7), from: null, flowMessageId: messageId };
    sessionStore.set(uid, s);
    await showCalendar(bot, chatId, messageId, s);
    return;
  }
  const s = sessionStore.get(uid);
  const card = periodCard();
  if (!s || s.type !== SESSION_TYPE) { await editOrSend(bot, chatId, messageId, card.text, card.opts); return; }
  if (data === 'srd:back') {
    if (s.from) { s.from = null; sessionStore.set(uid, s); await showCalendar(bot, chatId, messageId, s); return; }
    sessionStore.clear(uid, 'cancelled');
    await editOrSend(bot, chatId, messageId, card.text, card.opts);
    return;
  }
  if (data.startsWith('srd:dm:')) { s.ym = data.slice(7); sessionStore.set(uid, s); await showCalendar(bot, chatId, messageId, s); return; }
  if (data.startsWith('srd:dd:')) {
    const iso = data.slice(7);
    if (!s.from) { s.from = iso; sessionStore.set(uid, s); await showCalendar(bot, chatId, messageId, s); return; }
    if (iso < s.from) return;
    sessionStore.clear(uid, 'completed');
    await showGroupBy(bot, chatId, messageId, uid, rangeKey(s.from, iso));
  }
}

/**
 * SRP-2 (owner, 09-Oct-2026: "multiple times a single design is shown …
 * show the design with how many are sold written in brackets, first showing
 * the bales (suffix B) + thans (suffix T) from all the stores or warehouses";
 * then "remove shade-wise view"; then "remove the value of the goods").
 *
 * Design Wise = ONE line per design, every store and warehouse summed, the
 * bracket in the rule-6c grammar (`39B` · `4B + 4t` · `12t` — whole bales
 * first, every loose than after, never both units for the same goods), then
 * yards. No shade, no money. Ranked by yards (the value no longer prints, so
 * it cannot rank). Every design is listed — one line each needs no cut and
 * no 🔍 Show all.
 *
 * @param {Array<object>} sold Inventory rows already filtered to the period
 * @param {string} periodLabel as `periodLabel()` prints it
 * @param {function(Array<object>):string} qty the SYNC labeller from
 *   `unitDisplayService.createQtyLabeller(allRows)` — the roster decides
 *   whole vs loose, Settings decides the than-visible stores
 * @returns {{text:string, keyboard:null}}
 */
function designReport(sold, periodLabel, qty) {
  const byDesign = new Map();
  let totalYards = 0;
  for (const r of sold || []) {
    const design = String(r.design == null ? '' : r.design).trim() || '(no design)';
    if (!byDesign.has(design)) byDesign.set(design, { design, rows: [], yards: 0 });
    const g = byDesign.get(design);
    const y = Number(r.yards) || 0;
    g.rows.push(r); g.yards += y; totalYards += y;
  }
  const sorted = [...byDesign.values()].sort((a, b) => (b.yards - a.yards) || a.design.localeCompare(b.design));
  let text = `📊 *Sales Report — ${periodLabel} — Design Wise*\n`;
  text += '_B = whole bales · t = loose thans · yds_\n\n';
  if (!sorted.length) return { text: text + 'No sales in this period.', keyboard: null };
  const yds = (n) => fmtQty(n, { maxFraction: 2 });
  sorted.forEach((g, i) => {
    text += `${i + 1}. *${g.design}* (${qty(g.rows)}) · ${yds(g.yards)} yds\n`;
  });
  text += `\n🧮 *Grand Total: ${qty(sold)} · ${yds(totalYards)} yds*`;
  return { text, keyboard: null };
}

module.exports = {
  SESSION_TYPE, handleCallback, periodCard, showGroupBy, filterByPeriod, periodLabel, titleLabel, designReport,
  _internals: { rangeKey, parseKey, rangeLabel, gridRows, MAX_DAYS_BACK },
};
