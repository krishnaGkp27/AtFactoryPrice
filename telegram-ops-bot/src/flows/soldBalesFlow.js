'use strict';

/**
 * src/flows/soldBalesFlow.js — SOLD-BALES LOOKUP (SBL-1).
 *
 * Read-only drill-down to inspect what bales/thans were sold:
 *
 *   1. pick_customer  — tappable list of customers who have bought (most
 *                       recent buyer first); "Show all" expands the list.
 *   2. pick_design    — CSUP-2 (owner sketch: customer → design → dates →
 *                       bale numbers with yards): one tile per design the
 *                       customer bought, biggest first, plus an
 *                       "All designs by date" combined view.
 *   3. pick_date      — tappable list of the dates that customer bought on
 *                       (newest first), scoped to the chosen design unless
 *                       'ALL', each with a one-line summary.
 *   4. view_detail    — for a single design: compact "Bales (yards)" card
 *                       (one entry per physical bale). For 'ALL': the
 *                       bale-by-bale breakdown (than numbers, yards, and —
 *                       for price-visible roles — rate + value).
 *
 * Source of truth is the Inventory sheet (one row per than, kept as
 * status='sold' with soldTo + soldDate retained). Transactions only stores
 * aggregated totals, so it is intentionally NOT used here. No writes.
 *
 * Sale price + value are gated behind pricingService.canSeeSalePrice; other
 * roles see quantities (thans/yards) without ₦ figures.
 *
 * Callback namespace `sbl:*`:
 *   sbl:close            end the flow → menu
 *   sbl:back             step back one level (detail→dates→designs→customers)
 *   sbl:cust             jump straight back to the customer list
 *   sbl:all              re-render the customer list expanded (show all)
 *   sbl:c:<idx>          pick customer (index into session._customers)
 *   sbl:g:<idx>          pick design   (index into session._designs)
 *   sbl:g:all            combined "all designs" date view
 *   sbl:d:<idx>          pick date     (index into session._dates)
 *   sbl:pg:<n>           date-list page
 *   sbl:noop             no-op
 */

const sessionStore        = require('../utils/sessionStore');
const { makeRenderer, rowsFor } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const designAssetsRepository = require('../repositories/designAssetsRepository');
const designCategoriesRepository = require('../repositories/designCategoriesRepository');
const pricingService      = require('../services/pricingService');
const auth                = require('../middlewares/auth');
const logger              = require('../utils/logger');
const { buildShadeNameMap, formatShadeRef } = require('../utils/shadeButtons');
const { baleGroupKey, aggregateDesigns } = require('../utils/inventoryPickers');

const SESSION_TYPE   = 'sold_bales_flow';
const TILES_PER_ROW  = 2;
const CUSTOMERS_TOP  = 16;   // first page of the customer list
const MAX_DETAIL_BALES = 40; // safety cap on a single detail card
const DATES_PER_PAGE = 8;    // CSUP-1 approved layout: 8 day-tiles per page

/* ───────────────────────────── helpers ───────────────────────────── */

function fmtQty(n) { return (Math.round((n || 0) * 100) / 100).toLocaleString('en-NG'); }
function fmtNgn(n) { return `₦${Math.round(n || 0).toLocaleString('en-NG')}`; }
const { closeRow, backRow } = rowsFor('sbl');

function chunkButtons(buttons, perRow) {
  const out = [];
  for (let i = 0; i < buttons.length; i += perRow) out.push(buttons.slice(i, i + perRow));
  return out;
}

/**
 * Human-friendly date label. soldDate is normally an ISO 'YYYY-MM-DD'
 * string; render it as e.g. "25 Jun 2026" when parseable, else pass through.
 * @param {string} s
 * @returns {string}
 */
function prettyDate(s) {
  const raw = String(s || '').trim();
  if (!raw) return '—';
  const ms = Date.parse(raw);
  if (!isFinite(ms)) return raw;
  const d = new Date(ms);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Normalize a soldDate to ISO YYYY-MM-DD for grouping/sorting. The sheet
 * holds mixed formats (ISO, DD-MM-YYYY, DD/MM/YYYY) — raw string grouping
 * split the same real day in two and scrambled newest-first order.
 */
function normDay(sRaw) {
  const raw = String(sRaw || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const dmy = raw.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const ms = Date.parse(raw);
  if (isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  return raw;
}

/* ───────────────────────────── render helper ───────────────────────────── */

// Anchored edit-else-send renderer — shared flowKit implementation.
const render = makeRenderer();

/* ───────────────────────────── entry ───────────────────────────── */

/**
 * Start the Sold Bales Lookup flow.
 * @param {object} bot Telegram bot instance.
 * @param {number|string} chatId Chat id.
 * @param {string} userId Telegram user id.
 * @param {number|null} messageId Optional message id to edit in place.
 * @returns {Promise<void>}
 */
async function start(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId) && !auth.isEmployee(userId)) {
    await bot.sendMessage(chatId, '📒 Customer Supplies is available to employees and admins.');
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'pick_customer',
    flowMessageId: messageId || null,
    startedAt: new Date().toISOString(),
    showMoney: pricingService.canSeeSalePrice(String(userId)),
    customer: '',
    design: '',      // CSUP-2: '' = not chosen yet, 'ALL' = combined view
    soldDate: '',
    showAllCustomers: false,
    _customers: [],
    _designs: [],
    _dates: [],
  });
  await renderCustomerPicker(bot, chatId, userId);
}

/* ───────────────────────────── customer list ───────────────────────────── */

/**
 * Build a customer → {lastDate, thans, bales, yards} aggregate from all
 * sold rows, sorted by most-recent purchase first.
 * @returns {Promise<Array<{name:string,lastDate:string,thans:number,bales:number,yards:number}>>}
 */
async function loadCustomers() {
  const sold = await inventoryRepository.getSoldRows();
  const byCust = new Map();
  for (const r of sold) {
    const name = r.soldTo;
    if (!byCust.has(name)) byCust.set(name, { name, lastDate: '', thans: 0, yards: 0, bales: new Set() });
    const e = byCust.get(name);
    e.thans += 1;
    e.yards += r.yards;
    e.bales.add(baleGroupKey(r));
    const day = normDay(r.soldDate);
    if (day > String(e.lastDate)) e.lastDate = day;
  }
  return Array.from(byCust.values())
    .map((e) => ({ name: e.name, lastDate: e.lastDate, thans: e.thans, yards: e.yards, bales: e.bales.size }))
    .sort((a, b) => String(b.lastDate).localeCompare(String(a.lastDate)) || a.name.localeCompare(b.name));
}

async function renderCustomerPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const customers = await loadCustomers();
  if (!customers.length) {
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      '📒 *Customer Supplies*\n\n_No supplies recorded yet._',
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return;
  }
  session._customers = customers.map((c) => c.name);
  sessionStore.set(userId, session);

  const showAll = session.showAllCustomers;
  const shown = showAll ? customers : customers.slice(0, CUSTOMERS_TOP);
  const tiles = shown.map((c, i) => ({
    text: `👤 ${c.name} · ${c.thans}t`,
    callback_data: `sbl:c:${i}`,
  }));
  const rows = chunkButtons(tiles, TILES_PER_ROW);
  if (!showAll && customers.length > CUSTOMERS_TOP) {
    rows.push([{ text: `⬇ Show all (${customers.length})`, callback_data: 'sbl:all' }]);
  }
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `📒 *Customer Supplies*\n\nPick a customer to see their supply history`
    + (showAll ? ` (all ${customers.length}):` : ` (top ${shown.length}):`),
    rows);
}

/* ───────────────────────────── design list (CSUP-2) ───────────────────────────── */

/**
 * Designs the current customer bought, biggest first (bales desc, then
 * design asc numeric-aware) — same soldTo filtering as loadDatesForCustomer.
 * @param {string} customer
 * @returns {Promise<Array<{design:string,bales:number,thans:number,yards:number}>>}
 */
async function loadDesignsForCustomer(customer) {
  const sold = await inventoryRepository.getSoldRows();
  return aggregateDesigns(sold.filter((r) => r.soldTo === customer));
}

async function renderDesignPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const designs = await loadDesignsForCustomer(session.customer);
  if (!designs.length) {
    await render(bot, chatId, userId,
      `🔎 *${session.customer}*\n\n_No sold bales found for this customer._`,
      [backRow('⬅ Customers'), closeRow()]);
    return;
  }
  session._designs = designs.map((d) => d.design);
  sessionStore.set(userId, session);
  const totBales = designs.reduce((s, d) => s + d.bales, 0);
  const totYards = designs.reduce((s, d) => s + d.yards, 0);
  // Owner sketch: ONE tile per design — "🧵 <design> — N bales (Y yds)".
  const rows = designs.map((d, i) => ([{
    text: `🧵 ${d.design} — ${d.bales} ${d.bales === 1 ? 'bale' : 'bales'} (${fmtQty(d.yards)} yds)`,
    callback_data: `sbl:g:${i}`,
  }]));
  rows.push([{ text: '📅 All designs by date', callback_data: 'sbl:g:all' }]);
  rows.push(backRow('👤 Change customer'));
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `📒 *Supplies — ${session.customer}*\n\n`
    + `Total: *${totBales}* bales · *${fmtQty(totYards)}* yds · *${designs.length}* design${designs.length === 1 ? '' : 's'}\n\n`
    + `_Tap a design to see its supply dates._`, rows);
}

/* ───────────────────────────── date list ───────────────────────────── */

/**
 * Dates the current customer bought on, newest first, each with a summary.
 * CSUP-2: when `design` is truthy and not 'ALL', only rows of that design
 * are included.
 * @param {string} customer
 * @param {string} [design]
 * @returns {Promise<Array<{date:string,thans:number,bales:number,yards:number}>>}
 */
async function loadDatesForCustomer(customer, design) {
  const sold = await inventoryRepository.getSoldRows();
  const scoped = design && design !== 'ALL';
  const byDate = new Map();
  for (const r of sold) {
    if (r.soldTo !== customer) continue;
    if (scoped && String(r.design ?? '') !== design) continue;
    const day = normDay(r.soldDate);
    if (!byDate.has(day)) byDate.set(day, { date: day, thans: 0, yards: 0, bales: new Set() });
    const e = byDate.get(day);
    e.thans += 1;
    e.yards += r.yards;
    e.bales.add(baleGroupKey(r));
  }
  return Array.from(byDate.values())
    .map((e) => ({ date: e.date, thans: e.thans, yards: e.yards, bales: e.bales.size }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

async function renderDatePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const scoped = session.design && session.design !== 'ALL';
  const dates = await loadDatesForCustomer(session.customer, session.design);
  if (!dates.length) {
    await render(bot, chatId, userId,
      `🔎 *${session.customer}*\n\n_No sold bales found for this customer._`,
      [backRow('⬅ Back'), closeRow()]);
    return;
  }
  session._dates = dates.map((d) => d.date);
  const page = Math.max(0, Math.min(session._datePage || 0, Math.ceil(dates.length / DATES_PER_PAGE) - 1));
  session._datePage = page;
  sessionStore.set(userId, session);
  // CSUP-1 (owner-approved layout): summary header + one wide tile per day,
  // newest first, "DD-MMM-YYYY — N bales (Y yds)", 8 per page.
  const totBales = dates.reduce((s, d) => s + d.bales, 0);
  const totYards = dates.reduce((s, d) => s + d.yards, 0);
  const first = dates[dates.length - 1];
  const slice = dates.slice(page * DATES_PER_PAGE, (page + 1) * DATES_PER_PAGE);
  const rows = slice.map((d, i) => ([{
    text: `${prettyDate(d.date)} — ${d.bales} ${d.bales === 1 ? 'bale' : 'bales'} (${d.yards ? `${fmtQty(d.yards)} yds` : '— yds'})`,
    callback_data: `sbl:d:${page * DATES_PER_PAGE + i}`,
  }]));
  const nav = [];
  if ((page + 1) * DATES_PER_PAGE < dates.length) {
    nav.push({ text: `⬇ Older (${dates.length - (page + 1) * DATES_PER_PAGE} more)`, callback_data: `sbl:pg:${page + 1}` });
  }
  if (page > 0) nav.push({ text: '⬆ Newer', callback_data: `sbl:pg:${page - 1}` });
  if (nav.length) rows.push(nav);
  rows.push(backRow('🧵 Change design'));
  rows.push(closeRow());
  // CSUP-2: design-scoped header names the design; 'ALL' keeps the
  // original combined summary header unchanged.
  const header = scoped
    ? `📒 *${session.customer}* — 🧵 *${session.design}*\n\n`
      + `*${totBales}* bales · *${fmtQty(totYards)}* yds across *${dates.length}* supply day${dates.length === 1 ? '' : 's'}\n\n`
      + `_Tap a date for the day's detail._`
    : `📒 *Supplies — ${session.customer}*\n\n`
      + `Total: *${totBales}* bales · *${fmtQty(totYards)}* yds\n`
      + `across *${dates.length}* supply day${dates.length === 1 ? '' : 's'} · first: ${prettyDate(first.date)}\n\n`
      + `_Tap a date for the day's detail._`;
  await render(bot, chatId, userId, header, rows);
}

/* ───────────────────────────── detail card ───────────────────────────── */

/**
 * Best-effort catalog shade-name map for a design (number → name).
 * Returns an empty Map on any miss/error so callers degrade gracefully.
 */
async function shadeNameMapFor(design) {
  try {
    const asset = await designAssetsRepository.findActive(design);
    return buildShadeNameMap(asset);
  } catch (_) {
    return new Map();
  }
}

async function renderDetail(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const scoped = session.design && session.design !== 'ALL';
  const sold = await inventoryRepository.getSoldRows();
  const rows = sold.filter((r) => r.soldTo === session.customer
    && normDay(r.soldDate) === session.soldDate
    && (!scoped || String(r.design ?? '') === session.design));
  if (!rows.length) {
    await render(bot, chatId, userId,
      `🔎 *${session.customer}* · ${prettyDate(session.soldDate)}\n\n_Nothing found — it may have been returned._`,
      [backRow('⬅ Dates'), closeRow()]);
    return;
  }

  // CSUP-2 single-design view: compact owner-sketch notation — one entry
  // per PHYSICAL bale, "<baleNo> (<yards>)".
  if (scoped) {
    const groups = new Map();
    for (const r of rows) {
      const k = baleGroupKey(r);
      if (!groups.has(k)) groups.set(k, { label: String(r.packageNo || r.baleUid || '?'), yards: 0, amount: 0 });
      const g = groups.get(k);
      g.yards += r.yards || 0;
      g.amount += (r.yards || 0) * (r.pricePerYard || 0);
    }
    const list = Array.from(groups.values());
    const totYards = list.reduce((s, g) => s + g.yards, 0);
    const totAmount = list.reduce((s, g) => s + g.amount, 0);
    let entries = list.slice(0, MAX_DETAIL_BALES)
      .map((g) => `${g.label} (${fmtQty(g.yards)})`).join(', ');
    if (list.length > MAX_DETAIL_BALES) entries += `, +${list.length - MAX_DETAIL_BALES} more`;
    let body = `📒 *${session.customer}* — 🧵 *${session.design}* — ${prettyDate(session.soldDate)}\n\n`
      + `Bales (yards):\n${entries}\n\n`
      + `Day total: ${list.length} bale${list.length === 1 ? '' : 's'} · ${fmtQty(totYards)} yds`;
    if (session.showMoney) body += ` · *${fmtNgn(totAmount)}*`;
    await render(bot, chatId, userId, body, [
      backRow('⬅ Back to dates'),
      [{ text: '👤 Change customer', callback_data: 'sbl:cust' }],
      closeRow(),
    ]);
    return;
  }

  // Group by bale; cache shade-name maps per design.
  const groups = new Map();
  const nameMaps = new Map();
  for (const r of rows) {
    if (!nameMaps.has(r.design)) nameMaps.set(r.design, await shadeNameMapFor(r.design));
    const k = baleGroupKey(r);
    if (!groups.has(k)) {
      groups.set(k, {
        packageNo: r.packageNo, design: r.design, shade: r.shade,
        thans: [], yards: 0, amount: 0, prices: new Set(),
      });
    }
    const g = groups.get(k);
    g.thans.push(r.thanNo);
    g.yards += r.yards;
    g.amount += (r.yards || 0) * (r.pricePerYard || 0);
    g.prices.add(r.pricePerYard || 0);
  }

  const showMoney = !!session.showMoney;
  let totThans = 0; let totYards = 0; let totAmount = 0;
  const groupList = Array.from(groups.values());
  let body = `🧾 *${session.customer}* · ${prettyDate(session.soldDate)}\n`
    + `_${groupList.length} bale(s) sold this day_\n`;
  let shown = 0;
  for (const g of groupList) {
    totThans += g.thans.length;
    totYards += g.yards;
    totAmount += g.amount;
    if (shown >= MAX_DETAIL_BALES) continue;
    shown += 1;
    const nameMap = nameMaps.get(g.design) || new Map();
    const shadeRef = formatShadeRef(g.shade, nameMap.get(String(g.shade))) || (g.shade || '—');
    const thanNos = g.thans.slice().sort((a, b) => a - b).map((t) => `#${t}`).join(',');
    // DCAT-1: category label rides along with the design number.
    const cat = designCategoriesRepository.categoryOfSync(g.design);
    let line = `\n📦 *Bale ${g.packageNo}* — ${g.design}${cat ? ` · ${cat}` : ''} · ${shadeRef}\n`
      + `   ${g.thans.length} than (${thanNos}) · ${fmtQty(g.yards)} yd`;
    if (showMoney) {
      const uniform = g.prices.size === 1 ? [...g.prices][0] : null;
      line += uniform ? ` @ ${fmtNgn(uniform)} = ${fmtNgn(g.amount)}` : ` = ${fmtNgn(g.amount)}`;
    }
    body += line + '\n';
  }
  if (groupList.length > MAX_DETAIL_BALES) {
    body += `\n_…and ${groupList.length - MAX_DETAIL_BALES} more bale(s) not shown._\n`;
  }
  body += `\n──────────\n*Total:* ${totThans} than · ${fmtQty(totYards)} yd`;
  if (showMoney) body += ` · *${fmtNgn(totAmount)}*`;

  await render(bot, chatId, userId, body, [backRow('⬅ Dates'), closeRow()]);
}

/* ───────────────────────────── back navigation ───────────────────────────── */

async function stepBack(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  switch (session.step) {
    case 'pick_design':
      session.step = 'pick_customer';
      session.customer = '';
      session.design = '';
      sessionStore.set(userId, session);
      await renderCustomerPicker(bot, chatId, userId);
      break;
    case 'pick_date':
      session.step = 'pick_design';
      session.design = '';
      session._datePage = 0;
      sessionStore.set(userId, session);
      await renderDesignPicker(bot, chatId, userId);
      break;
    case 'view_detail':
      session.step = 'pick_date';
      session.soldDate = '';
      sessionStore.set(userId, session);
      await renderDatePicker(bot, chatId, userId);
      break;
    default:
      sessionStore.clear(userId);
      await render(bot, chatId, userId, '🔎 Closed.', [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
  }
}

/* ───────────────────────────── callback dispatcher ───────────────────────────── */

/**
 * Handle a `sbl:*` callback for the Sold Bales Lookup flow.
 * @param {object} bot Telegram bot instance.
 * @param {object} query Telegram callback query.
 * @returns {Promise<boolean>} true when handled.
 */
async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('sbl:')) return false;
  const chatId = query.message && query.message.chat && query.message.chat.id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return false;

  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }

  if (data === 'sbl:noop') return true;

  if (data === 'sbl:close') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '🔎 Closed.', [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return true;
  }

  if (data === 'sbl:back') { await stepBack(bot, chatId, userId); return true; }

  if (data.startsWith('sbl:pg:')) {
    const session = sessionStore.get(userId);
    if (!session || session.type !== SESSION_TYPE) return true;
    session._datePage = Math.max(0, parseInt(data.slice('sbl:pg:'.length), 10) || 0);
    sessionStore.set(userId, session);
    await renderDatePicker(bot, chatId, userId);
    return true;
  }

  if (data === 'sbl:all') {
    session.showAllCustomers = true;
    sessionStore.set(userId, session);
    await renderCustomerPicker(bot, chatId, userId);
    return true;
  }

  if (data === 'sbl:cust') {
    session.step = 'pick_customer';
    session.customer = '';
    session.design = '';
    session.soldDate = '';
    session._datePage = 0;
    sessionStore.set(userId, session);
    await renderCustomerPicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('sbl:c:')) {
    const i = parseInt(data.slice('sbl:c:'.length), 10);
    const name = (session._customers || [])[i];
    if (name) {
      session.customer = name;
      session.design = '';
      session.step = 'pick_design';
      sessionStore.set(userId, session);
      await renderDesignPicker(bot, chatId, userId);
    }
    return true;
  }

  if (data.startsWith('sbl:g:')) {
    const arg = data.slice('sbl:g:'.length);
    if (arg === 'all') {
      session.design = 'ALL';
    } else {
      const design = (session._designs || [])[parseInt(arg, 10)];
      if (!design) return true;
      session.design = design;
    }
    session.step = 'pick_date';
    session._datePage = 0; // reset paging whenever the design changes
    sessionStore.set(userId, session);
    await renderDatePicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('sbl:d:')) {
    const i = parseInt(data.slice('sbl:d:'.length), 10);
    const date = (session._dates || [])[i];
    if (date) {
      session.soldDate = date;
      session.step = 'view_detail';
      sessionStore.set(userId, session);
      await renderDetail(bot, chatId, userId);
    }
    return true;
  }

  return false;
}

module.exports = {
  start,
  handleCallback,
  _internals: {
    renderCustomerPicker, renderDesignPicker, renderDatePicker, renderDetail, stepBack,
    loadCustomers, loadDesignsForCustomer, loadDatesForCustomer,
    prettyDate, baleGroupKey, chunkButtons,
    SESSION_TYPE,
  },
};
