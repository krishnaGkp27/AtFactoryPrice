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
 * sale day — the same behaviour as 📒 Customer Supplies. A sold row whose
 * warehouse cell is blank belongs to no place and forms no chip (locked
 * layout; the row is still listed by 📒 Customer Supplies).
 *
 * Callback namespace `sfs:*`:
 *   sfs:menu         screen 1's 🏠 Back to menu — ends the flow, then the
 *                    controller's own act:__back__ path draws the menu
 *   sfs:close        end the flow → the card becomes "Closed." + menu
 *   sfs:back         step back one screen
 *   sfs:w:<idx>      pick a place  (index into session._places)
 *   sfs:d:<idx>      pick a day    (index into session._dates)
 *   sfs:pg:<n>       day-tile page (0-based)
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, rowsFor, chunk, disposeAux } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const unitDisplayService = require('../services/unitDisplayService');
const auth = require('../middlewares/auth');
const { baleGroupKey, cmpNumericAware } = require('../utils/inventoryPickers');
const { normalizeSalesDate } = require('../utils/dates');
const salesAccessService = require('../services/salesAccessService');

const SESSION_TYPE = 'store_sales_flow';
const NS = 'sfs';
const TILES_PER_ROW = 2;   // place chips per row
const DATES_PER_PAGE = 8;  // the Customer Supplies page size (CSUP-1)
const DAY_CARD_MAX_CHARS = 3600; // Telegram caps a message at 4,096

const render = makeRenderer();
const { backRow, closeRow, menuRow } = rowsFor(NS);

/* ───────────────────────────── helpers ───────────────────────────── */

function fmtQty(n) { return (Math.round((n || 0) * 100) / 100).toLocaleString('en-NG'); }

/** Grouping key for a warehouse cell: trimmed, case-folded; '' when blank. */
function placeKey(name) { return String(name || '').trim().toUpperCase(); }

/**
 * Legacy-Markdown escape for sheet text OUTSIDE an entity: `* _ \` [` —
 * never `]` (legacy Markdown has no `\]` escape and prints that backslash;
 * the same rule as the controller's supplyCartRowsMd).
 */
function mdEsc(v) { return String(v == null ? '' : v).replace(/[*_`[]/g, '\\$&'); }

/**
 * A sheet string inside a `*bold*` entity. Legacy Markdown honours NO
 * escapes inside an entity (the parser copies bytes verbatim until the
 * closing `*`), so `_ \` [` are literal there and a backslash would show;
 * only `*` matters, handled the way the Bot API prescribes — close and
 * reopen: `*2*\**2*` → 2*2.
 */
function bold(v) {
  const s = String(v == null ? '' : v).trim() || '—';
  return `*${s.replace(/\*/g, '*\\**')}*`;
}

/**
 * "25 Jun 2026" for an ISO day key; any other key (a cell the normaliser
 * rejected) is shown as it is — never rolled or re-ordered.
 * @param {string} s
 * @returns {string}
 */
function prettyDate(s) {
  const raw = String(s || '').trim();
  if (!raw) return '—';
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return raw;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Grouping key for a soldDate cell. parseRow has already normalised every
 * valid spelling to ISO; a value that is still not ISO here is one the
 * normaliser REJECTED (impossible month/day, two-digit year, stray words),
 * so it keeps its raw text as the key instead of being re-converted into
 * a fabricated date.
 * @param {string} sRaw
 * @returns {string}
 */
function dayKey(sRaw) {
  const raw = String(sRaw || '').trim();
  if (!raw) return '';
  return normalizeSalesDate(raw) || raw;
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
 * The places that have sold anything, alphabetical, case-folded (the first
 * spelling seen is the label). Rows with a blank warehouse cell form no
 * chip.
 * @param {Array<object>} sold
 * @returns {Array<{key:string,label:string,rows:number}>}
 */
function groupPlaces(sold) {
  const byKey = new Map();
  for (const r of sold) {
    const key = placeKey(r.warehouse);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { key, label: String(r.warehouse).trim(), rows: 0 });
    byKey.get(key).rows += 1;
  }
  return Array.from(byKey.values())
    .sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
}

/**
 * The days a place sold on, newest first, each with thans / yards / bales
 * and its display quantity. `totalQty` is the place's whole history in
 * one label (TV-8: not the sum of per-day bale counts).
 * @param {Array<object>} sold
 * @param {string} key   placeKey of the chosen place
 * @param {function(Array<object>):string} label
 * @returns {Array<{date:string,thans:number,yards:number,bales:number,qty:string}> & {totalQty:string, totalYards:number}}
 */
function groupDays(sold, key, label) {
  const byDate = new Map();
  const mine = [];
  for (const r of sold) {
    if (placeKey(r.warehouse) !== key) continue;
    mine.push(r);
    const day = dayKey(r.soldDate);
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
 * Design and shade buckets are case-folded like baleIdentity.baleKey, so
 * a bale whose than rows spell the shade two ways lands in ONE bucket
 * (ISC-1 C11) and prints once; the first spelling seen is the label.
 * Customers alphabetical; designs and shades in numeric-aware order.
 * @param {Array<object>} sold
 * @param {string} key
 * @param {string} day   the dayKey
 * @param {function(Array<object>):string} label
 * @returns {{customers:Array<{name:string,rows:Array<object>,yards:number,designs:Array<{design:string,shades:Array<{shade:string,rows:Array<object>,bales:string[]}>}>}>, rows:Array<object>, dayQty:string, yards:number}}
 */
function groupDay(sold, key, day, label) {
  const rows = sold.filter((r) => placeKey(r.warehouse) === key && dayKey(r.soldDate) === day);
  const byCust = new Map();
  for (const r of rows) {
    const name = String(r.soldTo || '').trim() || '—';
    if (!byCust.has(name)) byCust.set(name, { name, rows: [], yards: 0, designs: new Map() });
    const c = byCust.get(name);
    c.rows.push(r);
    c.yards += Number(r.yards) || 0;
    const design = String(r.design || '').trim() || '—';
    const dk = design.toUpperCase();
    if (!c.designs.has(dk)) c.designs.set(dk, { design, shades: new Map() });
    const { shades } = c.designs.get(dk);
    const shade = String(r.shade || '').trim();
    const sk = shade.toUpperCase();
    if (!shades.has(sk)) shades.set(sk, { shade, rows: [], bales: [], seen: new Set() });
    const s = shades.get(sk);
    s.rows.push(r);
    const bk = baleGroupKey(r);
    if (!s.seen.has(bk)) { s.seen.add(bk); s.bales.push(String(r.packageNo || '').trim() || '?'); }
  }
  const customers = Array.from(byCust.values())
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
    .map((c) => ({
      name: c.name, rows: c.rows, yards: c.yards,
      designs: Array.from(c.designs.values())
        .sort((a, b) => cmpNumericAware(a.design, b.design))
        .map(({ design, shades }) => ({
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
  // SSA-1 — an admin sees every place; anyone else only the places an
  // admin ticked for them in 🔐 Sales Access, and with nothing ticked,
  // nothing (owner ruling 24-Sep-2026). The Departments sheet can show the
  // tile but never widen this.
  const scope = await salesAccessService.scopeFor(userId);
  if (!scope.admin && !scope.keys.size) {
    await bot.sendMessage(chatId, '🏬 No store is assigned to you — ask an admin.');
    return;
  }
  // SJ-4 handoff — a tile tapped over another live flow abandons that flow:
  // take its auxiliary messages down and end it deliberately (the janitor's
  // instant cleanup and ANL-2 both hear the clear) instead of overwriting
  // its session silently.
  const prev = sessionStore.get(userId);
  if (prev && prev.type !== SESSION_TYPE) {
    await disposeAux(bot, chatId, userId);
    sessionStore.clear(userId, 'cancelled');
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
    /** SSA-1 — null = every place (admin); else the granted placeKeys. */
    scope: scope.admin ? null : [...scope.keys],
    /** SSA-1 — one granted place: screen 1 is skipped and has no way back. */
    single: !scope.admin && scope.keys.size === 1,
  });
  if (!scope.admin && scope.keys.size === 1) {
    const session = sessionStore.get(userId);
    session.placeKey = scope.places[0].toUpperCase();
    session.placeLabel = scope.places[0];
    session.step = 'pick_date';
    sessionStore.set(userId, session);
    await renderDatePicker(bot, chatId, userId);
    return;
  }
  await renderPlacePicker(bot, chatId, userId);
}

/* ───────────────────────────── screen 1 — places ───────────────────────────── */

async function renderPlacePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const { sold } = await loadSold();
  const scoped = Array.isArray(session.scope) ? new Set(session.scope) : null;
  const places = groupPlaces(sold).filter((p) => !scoped || scoped.has(p.key));
  if (!places.length) {
    // Render BEFORE clearing: the renderer anchors on session.flowMessageId.
    await render(bot, chatId, userId, '🏬 *Store Sales*\n\n_No sales recorded yet'
      + (scoped ? ' for your places' : '') + '._', [menuRow()]);
    sessionStore.clear(userId, 'completed');
    return;
  }
  session._places = places.map((p) => ({ key: p.key, label: p.label }));
  sessionStore.set(userId, session);
  const tiles = places.map((p, i) => ({ text: p.label, callback_data: `${NS}:w:${i}` }));
  const rows = chunk(tiles, TILES_PER_ROW);
  // The flow's own menu exit: it must END the session before the message
  // becomes the greeting menu, or the janitor would later delete the menu
  // as this flow's abandoned card.
  rows.push([{ text: '🏠 Back to menu', callback_data: `${NS}:menu` }]);
  await render(bot, chatId, userId, '🏬 *Store Sales*\n\nTap a place to see its sales.', rows);
}

/* ───────────────────────────── screen 2 — days ───────────────────────────── */

async function renderDatePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const { sold, label } = await loadSold();
  const dates = groupDays(sold, session.placeKey, label);
  const exitRows = session.single ? [closeRow()] : [backRow('🏬 Change place'), closeRow()];
  const title = `🏬 ${bold(`Sales — ${session.placeLabel}`)}`;
  if (!dates.length) {
    await render(bot, chatId, userId, `${title}\n\n_No sales found for this place._`, exitRows);
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
  rows.push(...exitRows);
  await render(bot, chatId, userId,
    `${title}\n\n`
    + `Total: *${dates.totalQty}* · *${fmtQty(dates.totalYards)}* yds\n`
    + `across *${dates.length}* sale day${dates.length === 1 ? '' : 's'} · first: ${prettyDate(first.date)}\n\n`
    + '_Tap a date for the day\'s detail._', rows);
}

/* ───────────────────────────── screen 3 — one day ───────────────────────────── */

/**
 * Body lines for the day card. Pure so the cut rule is testable.
 * @param {ReturnType<typeof groupDay>} day
 * @param {function(Array<object>):string} label
 * @returns {string[]}
 */
function dayCardLines(day, label) {
  const lines = [];
  for (const c of day.customers) {
    lines.push(`👤 ${bold(c.name)}`);
    for (const d of c.designs) {
      lines.push(` 🧵 ${bold(d.design)}`);
      for (const s of d.shades) {
        lines.push(`  • Shade ${mdEsc(s.shade || '—')} ×${label(s.rows)} (${s.bales.map(mdEsc).join(', ')})`);
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
 * a customer or design header with nothing under it. Never cuts silently.
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
  const head = `🧾 ${bold(session.placeLabel)} · ${prettyDate(session.soldDate)}\n`;
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

/** The card becomes "Closed." in place, then the session ends. */
async function closeFlow(bot, chatId, userId, outcome) {
  await render(bot, chatId, userId, '🏬 Closed.', [menuRow()]);
  sessionStore.clear(userId, outcome);
}

async function stepBack(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  switch (session.step) {
    case 'pick_date':
      if (session.single) { await closeFlow(bot, chatId, userId, 'cancelled'); break; }
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
      await closeFlow(bot, chatId, userId, 'cancelled');
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
  const messageId = query.message && query.message.message_id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);

  if (data === `${NS}:menu`) {
    // End the flow first, then let the controller's own menu path draw the
    // greeting menu into this message (it answers the callback itself).
    if (session && session.type === SESSION_TYPE) sessionStore.clear(userId, 'cancelled');
    await require('../controllers/telegramController').handleCallbackQuery(bot, { ...query, data: 'act:__back__' });
    return true;
  }

  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
  if (!session || session.type !== SESSION_TYPE) {
    // An old card after the session ended: take its buttons down so the
    // notice fires at most once, then say so instead of doing nothing.
    if (chatId && messageId) {
      try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }); } catch (_) { /* gone */ }
    }
    if (chatId) {
      try {
        await bot.sendMessage(chatId, '🏬 That Store Sales screen has expired — open 🏬 Store Sales again.',
          { reply_markup: { inline_keyboard: [menuRow()] } });
      } catch (_) { /* ignore */ }
    }
    return true;
  }

  if (data === `${NS}:close`) {
    await closeFlow(bot, chatId, userId, 'completed');
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
    SESSION_TYPE, NS, DATES_PER_PAGE, DAY_CARD_MAX_CHARS,
    placeKey, prettyDate, dayKey, mdEsc, bold,
    groupPlaces, groupDays, groupDay, dayCardLines, fitLines,
    renderPlacePicker, renderDatePicker, renderDay, stepBack,
  },
};
