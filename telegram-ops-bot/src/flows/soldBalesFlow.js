'use strict';

/**
 * src/flows/soldBalesFlow.js — SOLD-BALES LOOKUP (SBL-1).
 *
 * Read-only drill-down to inspect what bales/thans were sold:
 *
 *   1. pick_customer  — tappable list of customers who have bought (most
 *                       recent buyer first); "Show all" expands the list.
 *   2. pick_date      — tappable list of the dates that customer bought on
 *                       (newest first), each with a one-line summary.
 *   3. view_detail    — bale-by-bale breakdown of everything sold to that
 *                       customer on that date (than numbers, yards, and —
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
 *   sbl:back             step back one level
 *   sbl:all              re-render the customer list expanded (show all)
 *   sbl:c:<idx>          pick customer (index into session._customers)
 *   sbl:d:<idx>          pick date     (index into session._dates)
 *   sbl:noop             no-op
 */

const sessionStore        = require('../utils/sessionStore');
const inventoryRepository = require('../repositories/inventoryRepository');
const designAssetsRepository = require('../repositories/designAssetsRepository');
const pricingService      = require('../services/pricingService');
const auth                = require('../middlewares/auth');
const logger              = require('../utils/logger');
const { buildShadeNameMap, formatShadeRef } = require('../utils/shadeButtons');

const SESSION_TYPE   = 'sold_bales_flow';
const TILES_PER_ROW  = 2;
const CUSTOMERS_TOP  = 16;   // first page of the customer list
const MAX_DETAIL_BALES = 40; // safety cap on a single detail card

/* ───────────────────────────── helpers ───────────────────────────── */

function fmtQty(n) { return (Math.round((n || 0) * 100) / 100).toLocaleString('en-NG'); }
function fmtNgn(n) { return `₦${Math.round(n || 0).toLocaleString('en-NG')}`; }
function closeRow() { return [{ text: '❌ Close', callback_data: 'sbl:close' }]; }
function backRow(label) { return [{ text: label || '⬅ Back', callback_data: 'sbl:back' }]; }

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

/** Stable per-bale group key (prefer baleUid, fall back to packageNo). */
function baleGroupKey(r) { return r.baleUid || `pkg:${r.packageNo}`; }

/* ───────────────────────────── render helper ───────────────────────────── */

async function render(bot, chatId, userId, text, rows) {
  const session = sessionStore.get(userId);
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  const mid = session && session.flowMessageId;
  if (mid) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...opts });
      return;
    } catch (_) { /* fall through to fresh send */ }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  if (session) {
    session.flowMessageId = sent.message_id;
    sessionStore.set(userId, session);
  }
}

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
    await bot.sendMessage(chatId, '🔎 Sold Bales Lookup is available to employees and admins.');
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'pick_customer',
    flowMessageId: messageId || null,
    startedAt: new Date().toISOString(),
    showMoney: pricingService.canSeeSalePrice(String(userId)),
    customer: '',
    soldDate: '',
    showAllCustomers: false,
    _customers: [],
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
    if (String(r.soldDate) > String(e.lastDate)) e.lastDate = r.soldDate;
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
      '🔎 *Sold Bales Lookup*\n\n_No sold bales recorded yet._',
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
    `🔎 *Sold Bales Lookup*\n\nPick a customer to see their purchase dates`
    + (showAll ? ` (all ${customers.length}):` : ` (top ${shown.length}):`),
    rows);
}

/* ───────────────────────────── date list ───────────────────────────── */

/**
 * Dates the current customer bought on, newest first, each with a summary.
 * @returns {Promise<Array<{date:string,thans:number,bales:number,yards:number}>>}
 */
async function loadDatesForCustomer(customer) {
  const sold = await inventoryRepository.getSoldRows();
  const byDate = new Map();
  for (const r of sold) {
    if (r.soldTo !== customer) continue;
    if (!byDate.has(r.soldDate)) byDate.set(r.soldDate, { date: r.soldDate, thans: 0, yards: 0, bales: new Set() });
    const e = byDate.get(r.soldDate);
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
  const dates = await loadDatesForCustomer(session.customer);
  if (!dates.length) {
    await render(bot, chatId, userId,
      `🔎 *${session.customer}*\n\n_No sold bales found for this customer._`,
      [backRow('⬅ Customers'), closeRow()]);
    return;
  }
  session._dates = dates.map((d) => d.date);
  sessionStore.set(userId, session);
  // One date per row — the summary makes each tile wide.
  const rows = dates.map((d, i) => ([{
    text: `📅 ${prettyDate(d.date)} · ${d.bales}b · ${d.thans}t · ${fmtQty(d.yards)}y`,
    callback_data: `sbl:d:${i}`,
  }]));
  rows.push(backRow('⬅ Customers'));
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `🔎 *${session.customer}*\n\nPick a date to see the bales sold:`, rows);
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
  const sold = await inventoryRepository.getSoldRows();
  const rows = sold.filter((r) => r.soldTo === session.customer && r.soldDate === session.soldDate);
  if (!rows.length) {
    await render(bot, chatId, userId,
      `🔎 *${session.customer}* · ${prettyDate(session.soldDate)}\n\n_Nothing found — it may have been returned._`,
      [backRow('⬅ Dates'), closeRow()]);
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
    let line = `\n📦 *Bale ${g.packageNo}* — ${g.design} · ${shadeRef}\n`
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
    case 'pick_date':
      session.step = 'pick_customer';
      session.customer = '';
      sessionStore.set(userId, session);
      await renderCustomerPicker(bot, chatId, userId);
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

  if (data === 'sbl:all') {
    session.showAllCustomers = true;
    sessionStore.set(userId, session);
    await renderCustomerPicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('sbl:c:')) {
    const i = parseInt(data.slice('sbl:c:'.length), 10);
    const name = (session._customers || [])[i];
    if (name) {
      session.customer = name;
      session.step = 'pick_date';
      sessionStore.set(userId, session);
      await renderDatePicker(bot, chatId, userId);
    }
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
    renderCustomerPicker, renderDatePicker, renderDetail, stepBack,
    loadCustomers, loadDatesForCustomer, prettyDate, baleGroupKey, chunkButtons,
    SESSION_TYPE,
  },
};
