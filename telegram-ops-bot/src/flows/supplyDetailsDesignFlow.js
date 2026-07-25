'use strict';

/**
 * src/flows/supplyDetailsDesignFlow.js — SDG-1 📦 Supply Details, Design wise.
 *
 * Owner request (25-Jul-2026): the flat "Design Wise (Date-wise)" text dump
 * becomes a tappable drill. Four levels:
 *
 *   1. pick_design   — designs, MOST SUPPLIED FIRST, each showing the
 *                      owner-specified pair "supplied / total bales"
 *                      (no yards at this level — owner, 25-Jul).
 *   2. pick_date     — that design's supply dates, newest first.
 *   3. pick_customer — customers supplied on that date.
 *   4. view_detail   — that customer's shade breakdown, quantities, value
 *                      and the actual BALE NUMBERS (the reconciliation list).
 *
 * The pair at level 1 reads like the stock browse's "remaining / opening":
 *   supplied = distinct physical bales of the design actually SOLD
 *   total    = every bale of that design ever recorded, any status
 *              (sold + available + in_transit), across ALL warehouses —
 *              this report is deliberately not warehouse-scoped, because a
 *              design lives in several at once.
 * So "31B / 96B" = 31 supplied, 65 still sitting somewhere. A design whose
 * two numbers match is fully supplied and carries a ✅.
 *
 * Bale counting uses inventoryPickers.baleGroupKey throughout, so a bale
 * sold as loose thans counts ONCE, not once per than.
 *
 * MONEY: ₦ figures render only for env admins — the same gate the flat
 * report used (config.access.adminIds), deliberately unchanged so this
 * rewrite cannot widen who sees value.
 *
 * Replaces ONLY the Date-wise sub-view. The Design "Summary" sub-view and
 * the Customer-wise view on the same tile are untouched.
 *
 * Callback namespace `sdg:*`:
 *   sdg:close          end the flow → menu
 *   sdg:back           step back one level
 *   sdg:pg:<n>         design list page
 *   sdg:d:<idx>        pick design   (index into session._designs)
 *   sdg:t:<idx>        pick date     (index into session._dates)
 *   sdg:c:<idx>        pick customer (index into session._custs)
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, rowsFor } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const { baleGroupKey } = require('../utils/inventoryPickers');
const config = require('../config');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');

const SESSION_TYPE = 'supply_details_design_flow';
const { closeRow, backRow } = rowsFor('sdg');
const render = makeRenderer();

const DESIGNS_PER_PAGE = 8;

/* ───────────────────────────── helpers ───────────────────────────── */

/**
 * Normalize a sold date to ISO YYYY-MM-DD for grouping/sorting. The sheet
 * carries mixed formats (ISO, DD-MM-YYYY, DD/MM/YYYY) — same convention as
 * soldBalesFlow / salesBrowserFlow / supplyDetailsFlow.
 * @param {*} sRaw @returns {string}
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

/** "2026-02-12" → "12 Feb 2026". */
function prettyDate(iso) {
  const ms = Date.parse(iso);
  if (!isFinite(ms)) return iso || '—';
  return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Distinct physical bales in a row set. */
function baleCount(rows) {
  return new Set(rows.map(baleGroupKey)).size;
}

function fmtQty(n) {
  return (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-NG');
}

function fmtMoney(n) {
  return `₦${Math.round(Number(n) || 0).toLocaleString('en-NG')}`;
}

/** Value of a row slice (yards × price), used only behind the admin gate. */
function valueOf(rows) {
  return rows.reduce((s, r) => s + (Number(r.yards) || 0) * (Number(r.pricePerYard) || 0), 0);
}

/** Money suffix — empty string for non-admins, so nothing leaks. */
function money(rows, showMoney) {
  if (!showMoney) return '';
  return ` · ${fmtMoney(valueOf(rows))}`;
}

/* ───────────────────────────── entry ───────────────────────────── */

/**
 * Open the drill on its design list.
 * @param {object} bot @param {number|string} chatId
 * @param {string} userId @param {number|null} messageId anchor to edit
 */
async function start(bot, chatId, userId, messageId = null) {
  if (!auth.isAdmin(userId) && !auth.isEmployee(userId)) {
    try { await bot.sendMessage(chatId, '📦 Supply Details is available to employees and admins.'); } catch (_) { /* ignore */ }
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'pick_design',
    flowMessageId: messageId || null,
    startedAt: new Date().toISOString(),
    ttlMs: 15 * 60 * 1000, // read-only browsing, comfortable clock
    // Same money gate as the flat report it replaces (env admins only).
    showMoney: config.access.adminIds.includes(String(userId)),
    page: 0,
    design: '', day: '', customer: '',
    _designs: [], _dates: [], _custs: [],
  });
  await renderDesigns(bot, chatId, userId);
}

/* ──────────────────────── level 1: designs ──────────────────────── */

async function renderDesigns(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;

  // Two sources: sold rows drive "supplied", ALL rows drive "total".
  const all = await inventoryRepository.getAll();
  const soldByDesign = new Map();
  const allByDesign = new Map();
  for (const r of all) {
    const d = r.design || '—';
    if (!allByDesign.has(d)) allByDesign.set(d, []);
    allByDesign.get(d).push(r);
    if (r.status === 'sold' && r.soldTo && r.soldDate) {
      if (!soldByDesign.has(d)) soldByDesign.set(d, []);
      soldByDesign.get(d).push(r);
    }
  }

  const designs = [...soldByDesign.entries()]
    .map(([design, rows]) => ({
      design,
      supplied: baleCount(rows),
      total: baleCount(allByDesign.get(design) || rows),
    }))
    // Owner (25-Jul): MOST SUPPLIED FIRST; ties broken by design number so
    // the order is stable between renders.
    .sort((a, b) => b.supplied - a.supplied
      || String(a.design).localeCompare(String(b.design), undefined, { numeric: true }));

  if (!designs.length) {
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      '📦 *Supply Details — Design wise*\n\n_No supplies recorded yet._',
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return;
  }

  const pages = Math.max(1, Math.ceil(designs.length / DESIGNS_PER_PAGE));
  const page = Math.min(Math.max(0, session.page || 0), pages - 1);
  const slice = designs.slice(page * DESIGNS_PER_PAGE, (page + 1) * DESIGNS_PER_PAGE);

  session._designs = designs;
  session.page = page;
  session.step = 'pick_design';
  sessionStore.set(userId, session);

  const rows = slice.map((d) => {
    const i = designs.indexOf(d);
    // ✅ marks a design with nothing left anywhere.
    const done = d.supplied >= d.total ? ' ✅' : '';
    return [{ text: `📦 ${d.design} — ${d.supplied}B / ${d.total}B${done}`, callback_data: `sdg:d:${i}` }];
  });
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '◀ Prev', callback_data: `sdg:pg:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: 'sdg:noop' });
    if (page < pages - 1) nav.push({ text: 'Next ▶', callback_data: `sdg:pg:${page + 1}` });
    rows.push(nav);
  }
  rows.push(closeRow());
  rows.push([{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]);

  await render(bot, chatId, userId,
    '📦 *Supply Details — Design wise*\n\nTap a design to see its supply dates:\n_(supplied / total bales)_',
    rows);
}

/* ───────────────────────── level 2: dates ───────────────────────── */

async function renderDates(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const sold = await inventoryRepository.getSoldRows();
  const mine = sold.filter((r) => (r.design || '—') === session.design);

  const byDay = new Map();
  for (const r of mine) {
    const day = normDay(r.soldDate);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a));
  session._dates = days;
  session.step = 'pick_date';
  sessionStore.set(userId, session);

  const rows = days.map((d, i) => ([{
    text: `📅 ${prettyDate(d)} — ${baleCount(byDay.get(d))}B · ${fmtQty(byDay.get(d).reduce((s, r) => s + (Number(r.yards) || 0), 0))} yds`,
    callback_data: `sdg:t:${i}`,
  }]));
  rows.push(backRow('⬅ Designs'));
  rows.push(closeRow());

  // Shade context in the header when the design only ever sold in one shade —
  // the same "promote the constant" rule the flat report used.
  const shades = new Set(mine.map((r) => r.shade || '—'));
  const shadeNote = shades.size === 1 ? ` · Shade ${[...shades][0]}` : '';
  const entry = (session._designs || []).find((d) => d.design === session.design);
  const pair = entry ? `\nSupplied ${entry.supplied}B of ${entry.total}B` : '';

  await render(bot, chatId, userId,
    `📦 *${session.design}*${shadeNote}${pair}\n\n_Tap a supply date:_`, rows);
}

/* ─────────────────────── level 3: customers ─────────────────────── */

async function renderCustomers(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const sold = await inventoryRepository.getSoldRows();
  const mine = sold.filter((r) => (r.design || '—') === session.design
    && normDay(r.soldDate) === session.day);

  const byCust = new Map();
  for (const r of mine) {
    const c = r.soldTo || '—';
    if (!byCust.has(c)) byCust.set(c, []);
    byCust.get(c).push(r);
  }
  const custs = [...byCust.keys()]
    .sort((a, b) => baleCount(byCust.get(b)) - baleCount(byCust.get(a)) || a.localeCompare(b));
  session._custs = custs;
  session.step = 'pick_customer';
  sessionStore.set(userId, session);

  const rows = custs.map((c, i) => ([{
    text: `👤 ${c} — ${baleCount(byCust.get(c))}B · ${fmtQty(byCust.get(c).reduce((s, r) => s + (Number(r.yards) || 0), 0))} yds`,
    callback_data: `sdg:c:${i}`,
  }]));
  rows.push(backRow('⬅ Dates'));
  rows.push(closeRow());

  const yards = mine.reduce((s, r) => s + (Number(r.yards) || 0), 0);
  await render(bot, chatId, userId,
    `📦 *${session.design}* · 📅 *${prettyDate(session.day)}*\n\n_Who was supplied:_\n\n`
    + `Day total: ${baleCount(mine)}B · ${mine.length} thans · ${fmtQty(yards)} yds${money(mine, session.showMoney)}`,
    rows);
}

/* ───────────────────────── level 4: detail ──────────────────────── */

async function renderDetail(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const sold = await inventoryRepository.getSoldRows();
  const mine = sold.filter((r) => (r.design || '—') === session.design
    && normDay(r.soldDate) === session.day
    && (r.soldTo || '—') === session.customer);

  // Shade breakdown — one line per shade, so a multi-shade day is legible.
  const byShade = new Map();
  for (const r of mine) {
    const sh = r.shade || '—';
    if (!byShade.has(sh)) byShade.set(sh, []);
    byShade.get(sh).push(r);
  }
  const shadeLines = [...byShade.entries()]
    .sort((a, b) => baleCount(b[1]) - baleCount(a[1]))
    .map(([sh, rows]) => {
      const yards = rows.reduce((s, r) => s + (Number(r.yards) || 0), 0);
      const b = baleCount(rows);
      return `Shade ${sh} — ${b} ${b === 1 ? 'Bale' : 'Bales'} · ${rows.length} thans · ${fmtQty(yards)} yds${money(rows, session.showMoney)}`;
    });

  // The reconciliation list: the printed bale numbers actually supplied.
  const bales = [...new Set(mine.map((r) => r.packageNo).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));

  session.step = 'view_detail';
  sessionStore.set(userId, session);

  const yards = mine.reduce((s, r) => s + (Number(r.yards) || 0), 0);
  await render(bot, chatId, userId,
    `📦 *${session.design}* · 📅 *${prettyDate(session.day)}*\n👤 *${session.customer}*\n\n`
    + `${shadeLines.join('\n')}\n\n`
    + `*Total: ${baleCount(mine)} ${baleCount(mine) === 1 ? 'Bale' : 'Bales'} · ${mine.length} thans · ${fmtQty(yards)} yds${money(mine, session.showMoney)}*\n\n`
    + `📦 _Bale numbers (${bales.length})_\n${bales.join(', ') || '—'}`,
    [backRow('⬅ Customers'), closeRow()]);
}

/* ──────────────────────────── callbacks ─────────────────────────── */

/**
 * Route an `sdg:*` callback.
 * @param {object} bot @param {object} query
 * @returns {Promise<boolean>} true when handled
 */
async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('sdg:')) return false;
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;
  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }

  if (data === 'sdg:noop') return true;

  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    // Expired card — reseed from the tap so an old card self-heals rather
    // than sitting dead (same pattern as the warehouse drill).
    sessionStore.set(userId, {
      type: SESSION_TYPE, step: 'pick_design',
      flowMessageId: query.message.message_id,
      ttlMs: 15 * 60 * 1000,
      showMoney: config.access.adminIds.includes(userId),
      page: 0, design: '', day: '', customer: '',
      _designs: [], _dates: [], _custs: [],
    });
    await renderDesigns(bot, chatId, userId);
    return true;
  }

  if (data === 'sdg:close') {
    sessionStore.clear(userId);
    try {
      await bot.editMessageText('📦 Closed.', {
        chat_id: chatId, message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]] },
      });
    } catch (_) { /* ignore */ }
    return true;
  }

  if (data === 'sdg:back') {
    if (session.step === 'view_detail') { await renderCustomers(bot, chatId, userId); return true; }
    if (session.step === 'pick_customer') { await renderDates(bot, chatId, userId); return true; }
    await renderDesigns(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('sdg:pg:')) {
    session.page = parseInt(data.slice('sdg:pg:'.length), 10) || 0;
    sessionStore.set(userId, session);
    await renderDesigns(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('sdg:d:')) {
    const i = parseInt(data.slice('sdg:d:'.length), 10);
    const entry = (session._designs || [])[i];
    if (!entry) { await renderDesigns(bot, chatId, userId); return true; }
    session.design = entry.design;
    sessionStore.set(userId, session);
    await renderDates(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('sdg:t:')) {
    const i = parseInt(data.slice('sdg:t:'.length), 10);
    const day = (session._dates || [])[i];
    if (day === undefined) { await renderDates(bot, chatId, userId); return true; }
    session.day = day;
    sessionStore.set(userId, session);
    await renderCustomers(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('sdg:c:')) {
    const i = parseInt(data.slice('sdg:c:'.length), 10);
    const cust = (session._custs || [])[i];
    if (cust === undefined) { await renderCustomers(bot, chatId, userId); return true; }
    session.customer = cust;
    sessionStore.set(userId, session);
    await renderDetail(bot, chatId, userId);
    return true;
  }

  logger.warn(`supplyDetailsDesignFlow: unhandled callback ${data}`);
  return true;
}

module.exports = {
  start,
  handleCallback,
  SESSION_TYPE,
  _internals: { normDay, prettyDate, baleCount },
};
