'use strict';

/**
 * src/flows/storeSalesFlow.js — 🏬 STORE SALES (SFS-1, owner go 22-Sep-2026).
 *
 * "I want to see all the sales which have taken place from selected
 * warehouses / stores / office." Three read-only screens, nothing else:
 *
 *   1. pick_place  — one plain chip per warehouse / store that has sold
 *                    anything (alphabetical, two per row). A place with no
 *                    sales is not listed.
 *   2. pick_date   — the days that place sold on, newest first, in the
 *                    Customer Supplies grammar: header total + one wide
 *                    tile per day "DD MMM YYYY — 5t (149 yds)", 8 per page.
 *   3. view_day    — who bought what from that place on that day:
 *                    customer → design → "Shade X ×N (bale numbers)".
 *                    Quantities and bale numbers only — no value line, no
 *                    doc buttons, no full-details chip (owner: "no more
 *                    functionalities, no more unnecessary items").
 *
 * Source of truth is the Inventory sheet: every sold than keeps the
 * `warehouse` it was sold FROM (markThanSold / markPackageSold copy the
 * than's own warehouse back into the row), so all three screens are
 * read-time groupings of `inventoryRepository.getSoldRows()`. Nothing is
 * written, no new column, no Settings knob.
 *
 * A than that was later returned is no longer 'sold' and drops off its
 * sale day — the same behaviour as 📒 Customer Supplies.
 *
 * Callback namespace `sfs:*`:
 *   sfs:close        end the flow → menu
 *   sfs:back         step back one screen
 *   sfs:w:<idx>      pick a place  (index into session._places)
 *   sfs:d:<idx>      pick a day    (index into session._dates)
 *   sfs:pg:<n>       day-tile page (0-based)
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, rowsFor, chunk, mdEscape } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const unitDisplayService = require('../services/unitDisplayService');
const auth = require('../middlewares/auth');
const { baleGroupKey, cmpNumericAware } = require('../utils/inventoryPickers');

const SESSION_TYPE = 'store_sales_flow';
const NS = 'sfs';
const TILES_PER_ROW = 2;   // place chips per row
const DATES_PER_PAGE = 8;  // the Customer Supplies page size (CSUP-1)
const DAY_CARD_MAX_CHARS = 3600; // Telegram caps a message at 4,096
/** Label for sold rows whose warehouse cell is blank (LOC-1: a place is never hidden). */
const NO_PLACE_LABEL = '❔ No place recorded';

const render = makeRenderer();
const { backRow, closeRow, menuRow } = rowsFor(NS);

/* ───────────────────────────── helpers ───────────────────────────── */

function fmtQty(n) { return (Math.round((n || 0) * 100) / 100).toLocaleString('en-NG'); }

/** Grouping key for a warehouse cell: trimmed, case-folded; '' when blank. */
function placeKey(name) { return String(name || '').trim().toUpperCase(); }

/**
 * Human-friendly date label ("25 Jun 2026"); passes an unparseable value
 * through unchanged. Mirrors soldBalesFlow.prettyDate.
 * @param {string} s
 * @returns {string}
 */
function prettyDate(s) {
  const raw = String(s || '').trim();
  if (!raw) return '—';
  const ms = Date.parse(raw);
  if (!isFinite(ms)) return raw;
  return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Normalise a soldDate to ISO YYYY-MM-DD for grouping/sorting. The sheet
 * holds mixed formats (ISO, DD-MM-YYYY, DD/MM/YYYY). Mirrors
 * soldBalesFlow.normDay.
 * @param {string} sRaw
 * @returns {string}
 */
function normDay(sRaw) {
  const raw = String(sRaw || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const dmy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const ms = Date.parse(raw);
  if (isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  return raw;
}

/** Every sold row plus the quantity labeller (bales ⇄ thans per warehouse setting). */
async function loadSold() {
  const all = await inventoryRepository.getAll();
  const label = await unitDisplayService.createQtyLabeller(all);
  const sold = await inventoryRepository.getSoldRows();
  return { sold, label };
}

/* ───────────────────────────── pure grouping ───────────────────────────── */

/**
 * The places that have sold anything, alphabetical. Rows with a blank
 * warehouse cell are grouped under NO_PLACE_LABEL (sorted last) so a data
 * defect shows up as a chip instead of vanishing from the totals.
 * @param {Array<object>} sold
 * @returns {Array<{key:string,label:string,rows:number}>}
 */
function groupPlaces(sold) {
  const byKey = new Map();
  for (const r of sold) {
    const key = placeKey(r.warehouse);
    if (!byKey.has(key)) byKey.set(key, { key, label: key ? String(r.warehouse).trim() : NO_PLACE_LABEL, rows: 0 });
    byKey.get(key).rows += 1;
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (!a.key) return 1;
    if (!b.key) return -1;
    return a.label.localeCompare(b.label, 'en', { sensitivity: 'base' });
  });
}

/**
 * The days a place sold on, newest first, each with thans / yards / bales
 * and its display quantity. `totalQty` is the place's whole history in
 * one label (TV-8: not the sum of per-day bale counts).
 * @param {Array<object>} sold
 * @param {string} key   placeKey of the chosen place ('' = blank cell)
 * @param {function(Array<object>):string} label
 * @returns {Array<{date:string,thans:number,yards:number,bales:number,qty:string}> & {totalQty:string, totalYards:number}}
 */
function groupDays(sold, key, label) {
  const byDate = new Map();
  const mine = [];
  for (const r of sold) {
    if (placeKey(r.warehouse) !== key) continue;
    mine.push(r);
    const day = normDay(r.soldDate);
    if (!byDate.has(day)) byDate.set(day, { date: day, rows: [], yards: 0, bales: new Set() });
    const e = byDate.get(day);
    e.rows.push(r);
    e.yards += Number(r.yards) || 0;
    e.bales.add(baleGroupKey(r));
  }
  const out = Array.from(byDate.values())
    .map((e) => ({ date: e.date, thans: e.rows.length, yards: e.yards, bales: e.bales.size, qty: label(e.rows) }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  out.totalQty = label(mine);
  out.totalYards = mine.reduce((s, r) => s + (Number(r.yards) || 0), 0);
  return out;
}

/**
 * One day at one place: customer → design → shade → unique bale numbers.
 * Customers alphabetical; designs and shades in numeric-aware order.
 * @param {Array<object>} sold
 * @param {string} key
 * @param {string} day   ISO day
 * @param {function(Array<object>):string} label
 * @returns {{customers:Array<{name:string,rows:Array<object>,yards:number,designs:Array<{design:string,shades:Array<{shade:string,rows:Array<object>,bales:string[]}>}>}>, rows:Array<object>, dayQty:string, yards:number}}
 */
function groupDay(sold, key, day, label) {
  const rows = sold.filter((r) => placeKey(r.warehouse) === key && normDay(r.soldDate) === day);
  const byCust = new Map();
  for (const r of rows) {
    const name = String(r.soldTo || '').trim() || '—';
    if (!byCust.has(name)) byCust.set(name, { name, rows: [], yards: 0, designs: new Map() });
    const c = byCust.get(name);
    c.rows.push(r);
    c.yards += Number(r.yards) || 0;
    const dk = String(r.design || '').trim() || '—';
    if (!c.designs.has(dk)) c.designs.set(dk, new Map());
    const shades = c.designs.get(dk);
    const sk = String(r.shade || '').trim();
    if (!shades.has(sk)) shades.set(sk, { shade: sk, rows: [], bales: [], seen: new Set() });
    const s = shades.get(sk);
    s.rows.push(r);
    const bk = baleGroupKey(r);
    if (!s.seen.has(bk)) { s.seen.add(bk); s.bales.push(String(r.packageNo || '').trim() || '?'); }
  }
  const customers = Array.from(byCust.values())
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
    .map((c) => ({
      name: c.name, rows: c.rows, yards: c.yards,
      designs: Array.from(c.designs.entries())
        .sort(([a], [b]) => cmpNumericAware(a, b))
        .map(([design, shades]) => ({
          design,
          shades: Array.from(shades.values())
            .sort((a, b) => cmpNumericAware(a.shade, b.shade))
            .map((s) => ({ shade: s.shade, rows: s.rows, bales: s.bales.slice().sort(cmpNumericAware) })),
        })),
    }));
  return {
    customers, rows, dayQty: label(rows),
    yards: rows.reduce((s, r) => s + (Number(r.yards) || 0), 0),
  };
}

/* ───────────────────────────── entry ───────────────────────────── */

/**
 * Start the Store Sales flow (admin-only).
 * @param {object} bot
 * @param {number|string} chatId
 * @param {string} userId
 * @param {number|null} messageId  message to edit in place, when known
 */
async function start(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId, '🏬 Store Sales is admin-only.');
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'pick_place',
    flowMessageId: messageId || null,
    startedAt: new Date().toISOString(),
    placeKey: null,
    placeLabel: '',
    soldDate: '',
    _places: [],
    _dates: [],
    _datePage: 0,
  });
  await renderPlacePicker(bot, chatId, userId);
}

/* ───────────────────────────── screen 1 — places ───────────────────────────── */

async function renderPlacePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const { sold } = await loadSold();
  const places = groupPlaces(sold);
  if (!places.length) {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '🏬 *Store Sales*\n\n_No sales recorded yet._', [menuRow()]);
    return;
  }
  session._places = places.map((p) => ({ key: p.key, label: p.label }));
  sessionStore.set(userId, session);
  const tiles = places.map((p, i) => ({ text: p.label, callback_data: `${NS}:w:${i}` }));
  const rows = chunk(tiles, TILES_PER_ROW);
  rows.push(menuRow());
  await render(bot, chatId, userId, '🏬 *Store Sales*\n\nTap a place to see its sales.', rows);
}

/* ───────────────────────────── screen 2 — days ───────────────────────────── */

async function renderDatePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const { sold, label } = await loadSold();
  const dates = groupDays(sold, session.placeKey, label);
  const title = `🏬 *Sales — ${mdEscape(session.placeLabel)}*`;
  if (!dates.length) {
    await render(bot, chatId, userId, `${title}\n\n_No sales found for this place._`,
      [backRow('🏬 Change place'), closeRow()]);
    return;
  }
  session._dates = dates.map((d) => d.date);
  const pages = Math.ceil(dates.length / DATES_PER_PAGE);
  const page = Math.max(0, Math.min(session._datePage || 0, pages - 1));
  session._datePage = page;
  sessionStore.set(userId, session);
  const first = dates[dates.length - 1];
  const slice = dates.slice(page * DATES_PER_PAGE, (page + 1) * DATES_PER_PAGE);
  const rows = slice.map((d, i) => ([{
    text: `${prettyDate(d.date)} — ${d.qty} (${d.yards ? `${fmtQty(d.yards)} yds` : '— yds'})`,
    callback_data: `${NS}:d:${page * DATES_PER_PAGE + i}`,
  }]));
  const nav = [];
  if ((page + 1) * DATES_PER_PAGE < dates.length) {
    nav.push({ text: `⬇ Older (${dates.length - (page + 1) * DATES_PER_PAGE} more)`, callback_data: `${NS}:pg:${page + 1}` });
  }
  if (page > 0) nav.push({ text: '⬆ Newer', callback_data: `${NS}:pg:${page - 1}` });
  if (nav.length) rows.push(nav);
  rows.push(backRow('🏬 Change place'));
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `${title}\n\n`
    + `Total: *${dates.totalQty}* · *${fmtQty(dates.totalYards)}* yds\n`
    + `across *${dates.length}* sale day${dates.length === 1 ? '' : 's'} · first: ${prettyDate(first.date)}\n\n`
    + '_Tap a date for the day\'s detail._', rows);
}

/* ───────────────────────────── screen 3 — one day ───────────────────────────── */

/**
 * Body lines for the day card. Pure so the cut rule is testable: when the
 * lines would overrun Telegram's message cap the tail is replaced by one
 * italic "…and N more lines" — never cut silently.
 * @param {ReturnType<typeof groupDay>} day
 * @param {function(Array<object>):string} label
 * @returns {string[]}
 */
function dayCardLines(day, label) {
  const lines = [];
  for (const c of day.customers) {
    lines.push(`👤 *${mdEscape(c.name)}*`);
    for (const d of c.designs) {
      lines.push(` 🧵 *${mdEscape(d.design)}*`);
      for (const s of d.shades) {
        lines.push(`  • Shade ${mdEscape(s.shade || '—')} ×${label(s.rows)} (${s.bales.map(mdEscape).join(', ')})`);
      }
    }
    lines.push('');
  }
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Keep as many leading lines as fit in `budget` chars (newlines counted),
 * leaving room for the pointer line itself, and never end the kept part on
 * a customer or design header with nothing under it.
 * @param {string[]} lines
 * @param {number} budget
 * @returns {string[]}
 */
function fitLines(lines, budget) {
  const total = lines.reduce((s, l) => s + l.length + 1, 0);
  if (total <= budget) return lines;
  const pointer = (n) => `_…and ${n} more line${n === 1 ? '' : 's'}_`;
  let used = 0;
  let cut = 0;
  for (; cut < lines.length; cut += 1) {
    const next = used + lines[cut].length + 1;
    if (next + pointer(lines.length - cut).length > budget) break;
    used = next;
  }
  while (cut > 0 && (lines[cut - 1] === '' || /^(👤 | 🧵 )/.test(lines[cut - 1]))) cut -= 1;
  return [...lines.slice(0, cut), pointer(lines.length - cut)];
}

async function renderDay(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const { sold, label } = await loadSold();
  const day = groupDay(sold, session.placeKey, session.soldDate, label);
  const head = `🧾 *${mdEscape(session.placeLabel)}* · ${prettyDate(session.soldDate)}\n`;
  if (!day.rows.length) {
    await render(bot, chatId, userId, `${head}\n_Nothing found — it may have been returned._`,
      [backRow('⬅ Dates'), closeRow()]);
    return;
  }
  const sub = `_${day.dayQty} sold · ${fmtQty(day.yards)} yds_\n\n`;
  const lines = fitLines(dayCardLines(day, label), DAY_CARD_MAX_CHARS - head.length - sub.length);
  await render(bot, chatId, userId, head + sub + lines.join('\n'), [backRow('⬅ Dates'), closeRow()]);
}

/* ───────────────────────────── navigation ───────────────────────────── */

async function stepBack(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  switch (session.step) {
    case 'pick_date':
      session.step = 'pick_place';
      session.placeKey = null;
      session.placeLabel = '';
      session._datePage = 0;
      sessionStore.set(userId, session);
      await renderPlacePicker(bot, chatId, userId);
      break;
    case 'view_day':
      session.step = 'pick_date';
      session.soldDate = '';
      sessionStore.set(userId, session);
      await renderDatePicker(bot, chatId, userId);
      break;
    default:
      sessionStore.clear(userId);
      await render(bot, chatId, userId, '🏬 Closed.', [menuRow()]);
  }
}

/**
 * Handle a `sfs:*` callback.
 * @param {object} bot
 * @param {object} query Telegram callback query
 * @returns {Promise<boolean>} true when handled
 */
async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith(`${NS}:`)) return false;
  const chatId = query.message && query.message.chat && query.message.chat.id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);
  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
  if (!session || session.type !== SESSION_TYPE) {
    // An old card after the session expired: say so instead of doing nothing.
    if (chatId) {
      try {
        await bot.sendMessage(chatId, '🏬 That Store Sales screen has expired — open 🏬 Store Sales again.',
          { reply_markup: { inline_keyboard: [menuRow()] } });
      } catch (_) { /* ignore */ }
    }
    return true;
  }

  if (data === `${NS}:close`) {
    sessionStore.clear(userId, 'completed');
    await render(bot, chatId, userId, '🏬 Closed.', [menuRow()]);
    return true;
  }

  if (data === `${NS}:back`) { await stepBack(bot, chatId, userId); return true; }

  if (data.startsWith(`${NS}:pg:`)) {
    if (session.step !== 'pick_date') return true;
    session._datePage = Math.max(0, parseInt(data.slice(`${NS}:pg:`.length), 10) || 0);
    sessionStore.set(userId, session);
    await renderDatePicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith(`${NS}:w:`)) {
    if (session.step !== 'pick_place') return true;
    const i = parseInt(data.slice(`${NS}:w:`.length), 10);
    const p = (session._places || [])[i];
    if (p) {
      session.placeKey = p.key;
      session.placeLabel = p.label;
      session.step = 'pick_date';
      session._datePage = 0;
      sessionStore.set(userId, session);
      await renderDatePicker(bot, chatId, userId);
    }
    return true;
  }

  if (data.startsWith(`${NS}:d:`)) {
    if (session.step !== 'pick_date') return true;
    const i = parseInt(data.slice(`${NS}:d:`.length), 10);
    const date = (session._dates || [])[i];
    if (date) {
      session.soldDate = date;
      session.step = 'view_day';
      sessionStore.set(userId, session);
      await renderDay(bot, chatId, userId);
    }
    return true;
  }

  return true;
}

module.exports = {
  start,
  handleCallback,
  _internals: {
    SESSION_TYPE, NS, NO_PLACE_LABEL, DATES_PER_PAGE, DAY_CARD_MAX_CHARS,
    placeKey, prettyDate, normDay,
    groupPlaces, groupDays, groupDay, dayCardLines, fitLines,
    renderPlacePicker, renderDatePicker, renderDay, stepBack,
  },
};
