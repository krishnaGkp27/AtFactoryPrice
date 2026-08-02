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
 * YARDS GRANULARITY (owner, 25-Jul-2026): yards are a DETAIL figure and
 * appear ONLY on level 4 — one customer, one date, one design. Levels 1-3
 * are aggregates (a design, a whole date, a list of customers), where a
 * yard total answers no question and only crowds the button. Those levels
 * carry bales (and thans on the day total) instead.
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
 * SDG-2 (owner, 02-Aug-2026) — CONTAINER BIFURCATION. The business now runs
 * several containers at once, so a design's "215B / 416B" clubbed every
 * arrival together and answered nothing. A container step now sits BEFORE
 * the design list; every level below it is scoped to the picked container
 * (including the "total" side of the pair). "🌍 All containers" keeps the
 * old clubbed view one tap away, and the picked container rides every
 * header so a screenshot is never ambiguous.
 *
 * SDG-2 also brings the level-4 card in line with the transfer-card
 * grammar (owner-approved layout): bale numbers ride each shade row in
 * brackets, the flat "Bale numbers (N)" list is gone, and 📄 / 🧮 chips
 * deliver + reconcile the day's sale document (shared saleDocReconcile
 * engine, 🟢 dots in place). This card is NARROWER than a sale document
 * (one design), so doc-only numbers are deliberately not listed.
 *
 * Callback namespace `sdg:*`:
 *   sdg:close          end the flow → menu
 *   sdg:back           step back one level
 *   sdg:ct:<idx>       pick container (index into session._containers)
 *   sdg:pg:<n>         design list page
 *   sdg:d:<idx>        pick design   (index into session._designs)
 *   sdg:t:<idx>        pick date     (index into session._dates)
 *   sdg:c:<idx>        pick customer (index into session._custs)
 *   sdg:doc            deliver the day's sale doc(s) (ephemeral)
 *   sdg:rec            reconcile the sale doc → 🟢 dots in place
 *   sdg:recstop        abort a long read, restore the card
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, rowsFor } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const { baleGroupKey } = require('../utils/inventoryPickers');
const config = require('../config');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');
const saleDocReconcile = require('../services/saleDocReconcile');
const unitDisplayService = require('../services/unitDisplayService');

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

/* ── SDG-2 container scoping ─────────────────────────────────────── */

const ALL_CONTAINERS = '__all__';
const UNLABELLED = inventoryRepository.UNLABELLED_BATCH;

/** A row's container bucket ('' → the synthetic unlabelled bucket). */
function batchOf(r) {
  return String((r && r.arrivalBatch) || '').trim() || UNLABELLED;
}

/** Case-insensitive container match; ALL passes everything through. */
function inContainer(r, picked) {
  if (!picked || picked === ALL_CONTAINERS) return true;
  return batchOf(r).toUpperCase() === String(picked).toUpperCase();
}

/** Scope any row list to the session's picked container. */
function scoped(rows, session) {
  return rows.filter((r) => inContainer(r, session.container));
}

/** "🚢 Jul26 · " header prefix; empty when browsing all containers. */
function containerTag(session) {
  const c = session && session.container;
  if (!c || c === ALL_CONTAINERS) return '';
  return `🚢 *${c}* · `;
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
    step: 'pick_container',
    flowMessageId: messageId || null,
    startedAt: new Date().toISOString(),
    ttlMs: 15 * 60 * 1000, // read-only browsing, comfortable clock
    // Same money gate as the flat report it replaces (env admins only).
    showMoney: config.access.adminIds.includes(String(userId)),
    page: 0,
    container: '', design: '', day: '', customer: '',
    _containers: [], _designs: [], _dates: [], _custs: [],
  });
  await renderContainers(bot, chatId, userId);
}

/* ─────────────────────── level 0: containers ────────────────────── */

/**
 * SDG-2 — the bifurcation the owner asked for: which arrival container
 * are we reading? Counts come from SUPPLIED (sold) rows, because this is
 * a supply report; a container with nothing supplied yet still lists, at
 * 0B, so its existence is never hidden.
 */
async function renderContainers(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const all = await inventoryRepository.getAll();
  const byBatch = new Map();
  for (const r of all) {
    const key = batchOf(r).toUpperCase();
    if (!byBatch.has(key)) byBatch.set(key, { label: batchOf(r), sold: [], all: [] });
    const e = byBatch.get(key);
    e.all.push(r);
    if (r.status === 'sold' && r.soldTo && r.soldDate) e.sold.push(r);
  }
  const containers = [...byBatch.values()]
    .map((e) => ({ label: e.label, supplied: baleCount(e.sold), total: baleCount(e.all) }))
    .sort((a, b) => b.supplied - a.supplied
      || String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));

  if (!containers.length) {
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      '📦 *Supply Details — Design wise*\n\n_No stock recorded yet._',
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return;
  }

  session._containers = containers;
  session.step = 'pick_container';
  sessionStore.set(userId, session);

  const rows = containers.map((c, i) => ([{
    text: `🚢 ${c.label} — ${c.supplied}B / ${c.total}B`,
    callback_data: `sdg:ct:${i}`,
  }]));
  // One container is the normal case now, but the clubbed view stays one
  // tap away — it is the only way to see a design across arrivals.
  if (containers.length > 1) {
    const totSupplied = containers.reduce((s, c) => s + c.supplied, 0);
    const totAll = containers.reduce((s, c) => s + c.total, 0);
    rows.push([{ text: `🌍 All containers — ${totSupplied}B / ${totAll}B`, callback_data: 'sdg:ct:all' }]);
  }
  rows.push(closeRow());
  rows.push([{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]);

  await render(bot, chatId, userId,
    '📦 *Supply Details — Design wise*\n\nWhich container?\n_(supplied / total bales)_',
    rows);
}

/* ──────────────────────── level 1: designs ──────────────────────── */

async function renderDesigns(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;

  // Two sources: sold rows drive "supplied", ALL rows drive "total".
  // SDG-2 — both sides are container-scoped, so the pair answers "of THIS
  // arrival, how much has gone out?" instead of clubbing every container.
  const all = scoped(await inventoryRepository.getAll(), session);
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
    session.step = 'pick_design';
    sessionStore.set(userId, session);
    await render(bot, chatId, userId,
      `📦 *Supply Details — Design wise*\n${containerTag(session)}\n_Nothing supplied from this container yet._`,
      [backRow('⬅ Containers'), closeRow()]);
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
  rows.push(backRow('⬅ Containers'));
  rows.push(closeRow());
  rows.push([{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]);

  await render(bot, chatId, userId,
    `📦 *Supply Details — Design wise*\n${containerTag(session)}\n`
    + 'Tap a design to see its supply dates:\n_(supplied / total bales)_',
    rows);
}

/* ───────────────────────── level 2: dates ───────────────────────── */

async function renderDates(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const sold = await inventoryRepository.getSoldRows();
  const mine = scoped(sold, session).filter((r) => (r.design || '—') === session.design);

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

  // Yards are a DETAIL figure (owner, 25-Jul): they appear only on the
  // level that shows one customer, on one date, for one design. A date is
  // an aggregate over customers, so bales only here.
  const rows = days.map((d, i) => ([{
    text: `📅 ${prettyDate(d)} — ${baleCount(byDay.get(d))}B`,
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
    `${containerTag(session)}📦 *${session.design}*${shadeNote}${pair}\n\n_Tap a supply date:_`, rows);
}

/* ─────────────────────── level 3: customers ─────────────────────── */

async function renderCustomers(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const sold = await inventoryRepository.getSoldRows();
  const mine = scoped(sold, session).filter((r) => (r.design || '—') === session.design
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

  // TV-8 — these describe what a CUSTOMER received, so they follow the
  // goods: thans from a than-visible store or a broken bale, else bales.
  const label = await unitDisplayService.createQtyLabeller(await inventoryRepository.getAll());
  const rows = custs.map((c, i) => ([{
    text: `👤 ${c} — ${label(byCust.get(c))}`,
    callback_data: `sdg:c:${i}`,
  }]));
  rows.push(backRow('⬅ Dates'));
  rows.push(closeRow());

  await render(bot, chatId, userId,
    `${containerTag(session)}📦 *${session.design}* · 📅 *${prettyDate(session.day)}*\n\n_Who was supplied:_\n\n`
    + `Day total: ${label(mine)}${money(mine, session.showMoney)}`,
    rows);
}

/* ───────────────────────── level 4: detail ──────────────────────── */

/** The day's rows for this card (design + day + customer, container-scoped). */
async function detailRows(session) {
  const sold = await inventoryRepository.getSoldRows();
  return scoped(sold, session).filter((r) => (r.design || '—') === session.design
    && normDay(r.soldDate) === session.day
    && (r.soldTo || '—') === session.customer);
}

/** Per-shade grouping: rows + the shade's distinct printed bale numbers. */
function byShadeOf(mine) {
  const byShade = new Map();
  for (const r of mine) {
    const sh = r.shade || '—';
    if (!byShade.has(sh)) byShade.set(sh, { rows: [], bales: [] });
    const e = byShade.get(sh);
    e.rows.push(r);
    const pkg = String(r.packageNo || '').trim();
    if (pkg && !e.bales.includes(pkg)) e.bales.push(pkg);
  }
  for (const e of byShade.values()) {
    e.bales.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  }
  return [...byShade.entries()].sort((a, b) => baleCount(b[1].rows) - baleCount(a[1].rows));
}

async function renderDetail(bot, chatId, userId, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const mine = await detailRows(session);
  // TV-8 — one unit per figure; the old card printed bales AND thans for
  // the same goods, which counted them twice.
  const label = await unitDisplayService.createQtyLabeller(await inventoryRepository.getAll());

  // SDG-2 (owner-approved) — the bale numbers ride each shade row in
  // brackets (TRF-12 grammar) and the flat bottom list is gone; the money
  // figures sit on a second line so a wide row never wraps into mush.
  const shadeBlocks = byShadeOf(mine).map(([sh, e]) => {
    const yards = e.rows.reduce((s, r) => s + (Number(r.yards) || 0), 0);
    const nums = e.bales.length ? ` (${saleDocReconcile.dotted(e.bales, session._verified)})` : '';
    return ` • Shade ${sh} ×${label(e.rows)}${nums}\n   ${fmtQty(yards)} yds${money(e.rows, session.showMoney)}`;
  });

  if (!session._docsLoaded) {
    session._docs = await saleDocReconcile.docsFor(session.customer, session.day);
    session._docsLoaded = true;
  }
  session.step = 'view_detail';
  sessionStore.set(userId, session);

  const yards = mine.reduce((s, r) => s + (Number(r.yards) || 0), 0);
  const total = baleCount(mine);
  // This card is ONE design out of the customer's day, so the document
  // legitimately holds other designs' numbers — partial hides doc-only.
  const status = saleDocReconcile.statusLines(
    opts.reading ? { reading: true, at: opts.at, of: opts.of } : session._rec,
    total, { partial: true });

  const rows = [];
  if (opts.reading) {
    rows.push([{ text: '✖ Stop check', callback_data: 'sdg:recstop' }]);
  } else {
    if ((session._docs || []).length) {
      const n = session._docs.length;
      rows.push([{ text: `📄 Sale doc${n > 1 ? ` (${n})` : ''}`, callback_data: 'sdg:doc' }]);
      rows.push([{ text: (session._rec && session._rec.done) ? '🔁 Re-check sale doc' : '🧮 Reconcile sale doc', callback_data: 'sdg:rec' }]);
    }
    rows.push(backRow('⬅ Customers'));
    rows.push(closeRow());
  }

  await render(bot, chatId, userId,
    `${containerTag(session)}📦 *${session.design}* · 📅 *${prettyDate(session.day)}*\n👤 *${session.customer}*\n`
    + status
    + `\n${shadeBlocks.join('\n')}\n\n`
    + `*Total: ${label(mine)} · ${fmtQty(yards)} yds${money(mine, session.showMoney)}*`,
    rows);
}

/** SDG-2 — 🧮 read the day's sale doc(s) and dot this card in place. */
async function runReconcile(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !(session._docs || []).length) return;
  // Generation counter: ✖ Stop (or moving to another card) orphans a read
  // still in flight, so a late result can never dot a card taken back.
  const gen = (session._recGen || 0) + 1;
  session._recGen = gen;
  sessionStore.set(userId, session);
  const stillMine = () => {
    const s = sessionStore.get(userId);
    return s && s.type === SESSION_TYPE && s._recGen === gen;
  };

  const { digits, error, aborted } = await saleDocReconcile.readBaleDigits(bot, session._docs, {
    onProgress: async (at, of) => { if (stillMine()) await renderDetail(bot, chatId, userId, { reading: true, at, of }); },
    shouldAbort: () => !stillMine(),
  });
  if (aborted || !stillMine()) return;

  const s2 = sessionStore.get(userId);
  if (!s2 || s2.step !== 'view_detail') return;
  const mine = await detailRows(s2);
  const cardBales = [...new Set(mine.map((r) => String(r.packageNo || '').trim()).filter(Boolean))];
  if (!digits.size) {
    s2._rec = { done: false, error: error || 'no bale numbers found in the document' };
    s2._verified = [];
  } else {
    const res = saleDocReconcile.reconcile(cardBales, digits);
    s2._rec = {
      done: true, matched: res.matched, missing: res.missing,
      docOnly: res.docOnly, error: error ? `partial read (${error})` : null,
    };
    s2._verified = res.verified;
  }
  sessionStore.set(userId, s2);
  await renderDetail(bot, chatId, userId);
}

/** Clear any doc/dot state when the card's subject changes. */
function resetDocState(session) {
  session._recGen = (session._recGen || 0) + 1;
  delete session._docs; delete session._docsLoaded;
  delete session._rec; delete session._verified;
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
      type: SESSION_TYPE, step: 'pick_container',
      flowMessageId: query.message.message_id,
      ttlMs: 15 * 60 * 1000,
      showMoney: config.access.adminIds.includes(userId),
      page: 0, container: '', design: '', day: '', customer: '',
      _containers: [], _designs: [], _dates: [], _custs: [],
    });
    await renderContainers(bot, chatId, userId);
    return true;
  }

  // SDG-2/TRF-9b — any tap sweeps this user's fetched doc views first.
  try { await require('../services/ephemeralDocs').sweep(bot, userId); } catch (_) { /* viewer state only */ }

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
    if (session.step === 'view_detail') { resetDocState(session); sessionStore.set(userId, session); await renderCustomers(bot, chatId, userId); return true; }
    if (session.step === 'pick_customer') { await renderDates(bot, chatId, userId); return true; }
    if (session.step === 'pick_date') { await renderDesigns(bot, chatId, userId); return true; }
    await renderContainers(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('sdg:ct:')) {
    const rest = data.slice('sdg:ct:'.length);
    if (rest === 'all') {
      session.container = ALL_CONTAINERS;
    } else {
      const c = (session._containers || [])[parseInt(rest, 10)];
      if (!c) { await renderContainers(bot, chatId, userId); return true; }
      session.container = c.label;
    }
    session.page = 0;
    session.design = ''; session.day = ''; session.customer = '';
    resetDocState(session);
    sessionStore.set(userId, session);
    await renderDesigns(bot, chatId, userId);
    return true;
  }

  if (data === 'sdg:doc') {
    if (session.step !== 'view_detail') return true;
    await saleDocReconcile.sendDocs(bot, chatId, userId, session._docs || [],
      `📄 Sale doc — ${session.customer} · ${prettyDate(session.day)}`);
    return true;
  }

  if (data === 'sdg:rec') {
    if (session.step !== 'view_detail') return true;
    await runReconcile(bot, chatId, userId);
    return true;
  }

  if (data === 'sdg:recstop') {
    if (session.step !== 'view_detail') return true;
    session._recGen = (session._recGen || 0) + 1; // orphan the in-flight read
    sessionStore.set(userId, session);
    await renderDetail(bot, chatId, userId);
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
    resetDocState(session); // a new card starts with no docs and no dots
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
