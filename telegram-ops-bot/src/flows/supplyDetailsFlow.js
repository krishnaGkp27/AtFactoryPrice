'use strict';

/**
 * src/flows/supplyDetailsFlow.js — SDD-1 📦 Supply Details drill-down.
 *
 * Owner sketch (24-Jul-2026): replaces the flat "Warehouse wise" text dump
 * with a four-level tappable drill over goods supplied to customers:
 *
 *   1. pick_warehouse — warehouses that have supplied (most recent first)
 *   2. pick_date      — supply dates for that warehouse, newest first
 *   3. pick_customer  — customers supplied on that day
 *   4. view_detail    — that customer's design breakdown for the day
 *
 * UNITS (owner-locked): than-visible warehouses (Kano office — supplies in
 * thans) show "21t"; every other warehouse supplies whole bales and shows
 * bales ONLY ("4B", distinct physical bales via baleGroupKey). One unit per
 * warehouse — no pairs, no '=' (the pair notation confused supplied-vs-
 * converted quantities).
 *
 * Source of truth: sold Inventory rows (status='sold', one row per than,
 * soldTo/soldDate/warehouse retained). Read-only; computed at tap time.
 * The tile's other views (Design wise / Customer wise) are untouched.
 *
 * Callback namespace `sdd:*`:
 *   sdd:close        end the flow → menu
 *   sdd:back         step back one level (detail→customers→dates→warehouses)
 *   sdd:w:<idx>      pick warehouse (index into session._whs)
 *   sdd:d:<idx>      pick date      (index into session._dates)
 *   sdd:c:<idx>      pick customer  (index into session._custs)
 *   sdd:doc          SDD-2: deliver the day's sale doc(s) (ephemeral)
 *   sdd:rec          SDD-2: reconcile the sale doc → 🟢 dots in place
 *   sdd:recstop      SDD-2: abort a long read, restore the card
 *
 * SDD-2 (owner-approved, 02-Aug): the level-4 card now carries the printed
 * BALE NUMBERS in brackets on each design row (it had none), plus the
 * shared 📄 / 🧮 sale-doc chips. This card is narrower than a sale
 * document (one warehouse), so doc-only numbers are not listed.
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, rowsFor } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const unitDisplayService = require('../services/unitDisplayService');
const { baleGroupKey } = require('../utils/inventoryPickers');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');
const saleDocReconcile = require('../services/saleDocReconcile');

const SESSION_TYPE = 'supply_details_flow';
const { closeRow, backRow } = rowsFor('sdd');
const render = makeRenderer();

/**
 * Normalize a soldDate to ISO YYYY-MM-DD for grouping/sorting (the sheet
 * holds mixed formats — ISO, DD-MM-YYYY, DD/MM/YYYY). Mirrors the
 * convention established in soldBalesFlow/salesBrowserFlow.
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

function prettyDate(iso) {
  const ms = Date.parse(iso);
  if (!isFinite(ms)) return iso || '—';
  return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Quantity label in the warehouse's own supply unit (owner-locked), now
 * whole/loose aware (TV-8, owner 02-Aug): a than-visible warehouse counts
 * thans; a bale-only one counts WHOLE bales and reports part-taken bales
 * as loose thans — "3B + 2t" — for when a store starts breaking bales.
 * `roster` (bale key → total than rows) comes from unitDisplayService;
 * without it the label degrades to whole-bale counting, as before.
 */
function qtyLabel(rows, useThans, roster) {
  if (useThans) return `${rows.length}t`;
  return unitDisplayService.formatQty(rows, { roster });
}

/* ───────────────────────────── entry ───────────────────────────── */

async function start(bot, chatId, userId, messageId = null) {
  if (!auth.isAdmin(userId) && !auth.isEmployee(userId)) {
    try { await bot.sendMessage(chatId, '📦 Supply Details is available to employees and admins.'); } catch (_) {}
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'pick_warehouse',
    flowMessageId: messageId || null,
    startedAt: new Date().toISOString(),
    ttlMs: 15 * 60 * 1000, // read-only browsing, comfortable clock
    warehouse: '', useThans: false, day: '', customer: '',
    _whs: [], _dates: [], _custs: [],
  });
  await renderWarehouses(bot, chatId, userId);
}

/* ─────────────────────────── level 1: warehouses ─────────────────────────── */

async function renderWarehouses(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const sold = await inventoryRepository.getSoldRows();
  const byWh = new Map();
  for (const r of sold) {
    const wh = r.warehouse || '—';
    if (!byWh.has(wh)) byWh.set(wh, { wh, lastDay: '' });
    const e = byWh.get(wh);
    const day = normDay(r.soldDate);
    if (day > e.lastDay) e.lastDay = day;
  }
  const whs = Array.from(byWh.values())
    .sort((a, b) => b.lastDay.localeCompare(a.lastDay) || a.wh.localeCompare(b.wh))
    .map((e) => e.wh);
  if (!whs.length) {
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      '📦 *Supply Details*\n\n_No supplies recorded yet._',
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return;
  }
  session._whs = whs;
  session.step = 'pick_warehouse';
  sessionStore.set(userId, session);
  const rows = whs.map((w, i) => ([{ text: `🏭 ${w}`, callback_data: `sdd:w:${i}` }]));
  rows.push(closeRow());
  rows.push([{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]);
  await render(bot, chatId, userId,
    '📦 *Supply Details*\n\n_Pick a warehouse to see its supply dates._', rows);
}

/* ─────────────────────────── level 2: dates ─────────────────────────── */

async function renderDates(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const sold = await inventoryRepository.getSoldRows();
  const mine = sold.filter((r) => (r.warehouse || '—') === session.warehouse);
  const byDay = new Map();
  for (const r of mine) {
    const day = normDay(r.soldDate);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const days = Array.from(byDay.keys()).sort((a, b) => b.localeCompare(a));
  session._dates = days;
  session.step = 'pick_date';
  sessionStore.set(userId, session);
  const roster = unitDisplayService.buildBaleRoster(await inventoryRepository.getAll());
  const rows = days.map((d, i) => ([{
    text: `${prettyDate(d)} — ${qtyLabel(byDay.get(d), session.useThans, roster)}`,
    callback_data: `sdd:d:${i}`,
  }]));
  rows.push(backRow('⬅ Warehouses'));
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `📦 *Supply Details — ${session.warehouse}*\n\n_Tap a supply date:_`, rows);
}

/* ─────────────────────────── level 3: customers ─────────────────────────── */

async function renderCustomers(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const sold = await inventoryRepository.getSoldRows();
  const mine = sold.filter((r) => (r.warehouse || '—') === session.warehouse
    && normDay(r.soldDate) === session.day);
  const byCust = new Map();
  for (const r of mine) {
    const c = r.soldTo || '—';
    if (!byCust.has(c)) byCust.set(c, []);
    byCust.get(c).push(r);
  }
  const custs = Array.from(byCust.keys())
    .sort((a, b) => byCust.get(b).length - byCust.get(a).length || a.localeCompare(b));
  session._custs = custs;
  session.step = 'pick_customer';
  sessionStore.set(userId, session);
  const roster = unitDisplayService.buildBaleRoster(await inventoryRepository.getAll());
  const rows = custs.map((c, i) => ([{
    text: `👤 ${c} — ${qtyLabel(byCust.get(c), session.useThans, roster)}`,
    callback_data: `sdd:c:${i}`,
  }]));
  rows.push(backRow('⬅ Dates'));
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `📦 *${session.warehouse} — ${prettyDate(session.day)}*\n\n_Who was supplied that day:_`, rows);
}

/* ─────────────────────────── level 4: designs ─────────────────────────── */

/** The rows behind this card (warehouse + day + customer). */
async function detailRows(session) {
  const sold = await inventoryRepository.getSoldRows();
  return sold.filter((r) => (r.warehouse || '—') === session.warehouse
    && normDay(r.soldDate) === session.day
    && (r.soldTo || '—') === session.customer);
}

async function renderDetail(bot, chatId, userId, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const mine = await detailRows(session);
  const roster = unitDisplayService.buildBaleRoster(await inventoryRepository.getAll());
  const byDesign = new Map();
  for (const r of mine) {
    const d = r.design || '—';
    if (!byDesign.has(d)) byDesign.set(d, { rows: [], bales: [] });
    const e = byDesign.get(d);
    e.rows.push(r);
    const pkg = String(r.packageNo || '').trim();
    if (pkg && !e.bales.includes(pkg)) e.bales.push(pkg);
  }
  const designs = Array.from(byDesign.keys())
    .sort((a, b) => byDesign.get(b).rows.length - byDesign.get(a).rows.length
      || String(a).localeCompare(String(b), undefined, { numeric: true }));
  // SDD-2 (owner-approved) — the printed bale numbers ride each design row
  // in brackets, so this card is a reconciliation list too. Kano-style
  // than-visible warehouses keep their `t` unit; the numbers are the bales
  // those thans came out of.
  const lines = designs.map((d) => {
    const e = byDesign.get(d);
    e.bales.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    const nums = e.bales.length ? ` (${saleDocReconcile.dotted(e.bales, session._verified)})` : '';
    return `🧵 ${d}: ${qtyLabel(e.rows, session.useThans, roster)}${nums}`;
  });

  if (!session._docsLoaded) {
    session._docs = await saleDocReconcile.docsFor(session.customer, session.day);
    session._docsLoaded = true;
  }
  session.step = 'view_detail';
  sessionStore.set(userId, session);

  const cardBaleCount = new Set(mine.map((r) => String(r.packageNo || '').trim()).filter(Boolean)).size;
  // One warehouse out of the customer's day → partial: doc-only hidden.
  const status = saleDocReconcile.statusLines(
    opts.reading ? { reading: true, at: opts.at, of: opts.of } : session._rec,
    cardBaleCount, { partial: true });

  const rows = [];
  if (opts.reading) {
    rows.push([{ text: '✖ Stop check', callback_data: 'sdd:recstop' }]);
  } else {
    if ((session._docs || []).length) {
      const n = session._docs.length;
      rows.push([{ text: `📄 Sale doc${n > 1 ? ` (${n})` : ''}`, callback_data: 'sdd:doc' }]);
      rows.push([{ text: (session._rec && session._rec.done) ? '🔁 Re-check sale doc' : '🧮 Reconcile sale doc', callback_data: 'sdd:rec' }]);
    }
    rows.push(backRow('⬅ Customers'));
    rows.push(closeRow());
  }

  await render(bot, chatId, userId,
    `📦 *${session.warehouse} — ${prettyDate(session.day)} — ${session.customer}*\n`
    + status
    + `\n${lines.join('\n')}\n\n`
    + `Total: *${qtyLabel(mine, session.useThans, roster)}*`,
    rows);
}

/** SDD-2 — 🧮 read the day's sale doc(s) and dot this card in place. */
async function runReconcile(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !(session._docs || []).length) return;
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

/** Clear doc/dot state when the card's subject changes. */
function resetDocState(session) {
  session._recGen = (session._recGen || 0) + 1;
  delete session._docs; delete session._docsLoaded;
  delete session._rec; delete session._verified;
}

/* ─────────────────────────── callbacks ─────────────────────────── */

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('sdd:')) return false;
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;
  try { await bot.answerCallbackQuery(query.id); } catch (_) {}
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    // Session expired — reseed from the tapped card so old cards self-heal.
    sessionStore.set(userId, {
      type: SESSION_TYPE, step: 'pick_warehouse',
      flowMessageId: query.message.message_id,
      ttlMs: 15 * 60 * 1000,
      warehouse: '', useThans: false, day: '', customer: '',
      _whs: [], _dates: [], _custs: [],
    });
    await renderWarehouses(bot, chatId, userId);
    return true;
  }

  // SDD-2/TRF-9b — any tap sweeps this user's fetched doc views first.
  try { await require('../services/ephemeralDocs').sweep(bot, userId); } catch (_) { /* viewer state only */ }

  if (data === 'sdd:close') {
    sessionStore.clear(userId, 'completed');
    try {
      await bot.editMessageText('📦 Closed.', {
        chat_id: chatId, message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]] },
      });
    } catch (_) {}
    return true;
  }

  if (data === 'sdd:back') {
    if (session.step === 'view_detail') { resetDocState(session); sessionStore.set(userId, session); await renderCustomers(bot, chatId, userId); return true; }
    if (session.step === 'pick_customer') { await renderDates(bot, chatId, userId); return true; }
    await renderWarehouses(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('sdd:w:')) {
    const i = parseInt(data.slice('sdd:w:'.length), 10);
    const wh = (session._whs || [])[i];
    if (wh === undefined) { await renderWarehouses(bot, chatId, userId); return true; }
    session.warehouse = wh;
    session.useThans = await unitDisplayService.isThanVisibilityWarehouse(wh);
    sessionStore.set(userId, session);
    await renderDates(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('sdd:d:')) {
    const i = parseInt(data.slice('sdd:d:'.length), 10);
    const day = (session._dates || [])[i];
    if (day === undefined) { await renderDates(bot, chatId, userId); return true; }
    session.day = day;
    sessionStore.set(userId, session);
    await renderCustomers(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('sdd:c:')) {
    const i = parseInt(data.slice('sdd:c:'.length), 10);
    const cust = (session._custs || [])[i];
    if (cust === undefined) { await renderCustomers(bot, chatId, userId); return true; }
    session.customer = cust;
    resetDocState(session); // a new card starts with no docs and no dots
    sessionStore.set(userId, session);
    await renderDetail(bot, chatId, userId);
    return true;
  }

  if (data === 'sdd:doc') {
    if (session.step !== 'view_detail') return true;
    await saleDocReconcile.sendDocs(bot, chatId, userId, session._docs || [],
      `📄 Sale doc — ${session.customer} · ${prettyDate(session.day)}`);
    return true;
  }

  if (data === 'sdd:rec') {
    if (session.step !== 'view_detail') return true;
    await runReconcile(bot, chatId, userId);
    return true;
  }

  if (data === 'sdd:recstop') {
    if (session.step !== 'view_detail') return true;
    session._recGen = (session._recGen || 0) + 1; // orphan the in-flight read
    sessionStore.set(userId, session);
    await renderDetail(bot, chatId, userId);
    return true;
  }

  logger.warn(`supplyDetailsFlow: unhandled callback ${data}`);
  return true;
}

module.exports = { start, handleCallback, SESSION_TYPE, _internals: { normDay, qtyLabel } };
