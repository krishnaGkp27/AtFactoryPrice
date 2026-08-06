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
 *   sbl:d:<idx>          pick date     (→ SBL-2 compact supply card)
 *   sbl:doc              SBL-2: deliver the day's sale doc(s) (ephemeral)
 *   sbl:rec              SBL-2: OCR the sale doc(s), 🟢-dot matched bales
 *   sbl:full             SBL-2: open the bale-by-bale detail card
 *   sbl:noop             no-op
 *
 * SBL-2 (owner, 02-Aug): pick_date now lands on a COMPACT supply card in
 * the transfer-card grammar (design → "Shade X ×N (bale numbers)"), with
 * the in-depth thans/yards/₦ view demoted behind 🔎 Full details. The 🧮
 * chip reads the sale doc(s) via vision OCR and re-renders the SAME card
 * with a 🟢 in front of every bale number the document contains —
 * digit-exact matches only, never a guessed near-miss. Unmatched card
 * bales are listed (the owner's narrowing shortlist); doc numbers not on
 * the card are listed separately, never attached to a bale. Read-only:
 * dots live in the session, nothing is written anywhere.
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
const { baleGroupKey } = require('../utils/inventoryPickers');
const saleDocReconcile = require('../services/saleDocReconcile');
const unitDisplayService = require('../services/unitDisplayService');

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
  // TV-8 — the chip label follows the goods, not a fixed unit: the whole
  // Inventory feeds the bale roster so a part-taken bale reads as thans.
  const all = await inventoryRepository.getAll();
  const label = await unitDisplayService.createQtyLabeller(all);
  const sold = await inventoryRepository.getSoldRows();
  const byCust = new Map();
  for (const r of sold) {
    const name = r.soldTo;
    if (!byCust.has(name)) byCust.set(name, { name, lastDate: '', rows: [], yards: 0, bales: new Set() });
    const e = byCust.get(name);
    e.rows.push(r);
    e.yards += r.yards;
    e.bales.add(baleGroupKey(r));
    const day = normDay(r.soldDate);
    if (day > String(e.lastDate)) e.lastDate = day;
  }
  return Array.from(byCust.values())
    .map((e) => ({
      name: e.name, lastDate: e.lastDate, thans: e.rows.length,
      yards: e.yards, bales: e.bales.size, qty: label(e.rows),
    }))
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
    text: `👤 ${c.name} · ${c.qty}`,
    callback_data: `sbl:c:${i}`,
  }));
  const rows = chunkButtons(tiles, TILES_PER_ROW);
  if (!showAll && customers.length > CUSTOMERS_TOP) {
    rows.push([{ text: `⬇ Show all (${customers.length})`, callback_data: 'sbl:all' }]);
  }
  rows.push(closeRow());
  rows.push([{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]);
  await render(bot, chatId, userId,
    `📒 *Customer Supplies*\n\nPick a customer to see their supply history`
    + (showAll ? ` (all ${customers.length}):` : ` (top ${shown.length}):`),
    rows);
}

/* ───────────────────────────── date list ───────────────────────────── */

/**
 * Dates the current customer bought on, newest first, each with a summary.
 * @returns {Promise<Array<{date:string,thans:number,bales:number,yards:number}>>}
 */
async function loadDatesForCustomer(customer) {
  const all = await inventoryRepository.getAll();
  const label = await unitDisplayService.createQtyLabeller(all);
  const sold = await inventoryRepository.getSoldRows();
  const byDate = new Map();
  const mine = [];
  for (const r of sold) {
    if (r.soldTo !== customer) continue;
    mine.push(r);
    const day = normDay(r.soldDate);
    if (!byDate.has(day)) byDate.set(day, { date: day, rows: [], yards: 0, bales: new Set() });
    const e = byDate.get(day);
    e.rows.push(r);
    e.yards += r.yards;
    e.bales.add(baleGroupKey(r));
  }
  const out = Array.from(byDate.values())
    .map((e) => ({
      date: e.date, thans: e.rows.length, yards: e.yards,
      bales: e.bales.size, qty: label(e.rows),
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  // TV-8 — the header total is the customer's whole history in one label,
  // not the sum of per-day bale counts (a bale split across days would
  // otherwise be counted twice).
  out.totalQty = label(mine);
  return out;
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
  const page = Math.max(0, Math.min(session._datePage || 0, Math.ceil(dates.length / DATES_PER_PAGE) - 1));
  session._datePage = page;
  sessionStore.set(userId, session);
  // CSUP-1 (owner-approved layout): summary header + one wide tile per day,
  // newest first, "DD-MMM-YYYY — N bales (Y yds)", 8 per page.
  const totYards = dates.reduce((s, d) => s + d.yards, 0);
  const first = dates[dates.length - 1];
  const slice = dates.slice(page * DATES_PER_PAGE, (page + 1) * DATES_PER_PAGE);
  const rows = slice.map((d, i) => ([{
    text: `${prettyDate(d.date)} — ${d.qty} (${d.yards ? `${fmtQty(d.yards)} yds` : '— yds'})`,
    callback_data: `sbl:d:${page * DATES_PER_PAGE + i}`,
  }]));
  const nav = [];
  if ((page + 1) * DATES_PER_PAGE < dates.length) {
    nav.push({ text: `⬇ Older (${dates.length - (page + 1) * DATES_PER_PAGE} more)`, callback_data: `sbl:pg:${page + 1}` });
  }
  if (page > 0) nav.push({ text: '⬆ Newer', callback_data: `sbl:pg:${page - 1}` });
  if (nav.length) rows.push(nav);
  rows.push(backRow('👤 Change customer'));
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `📒 *Supplies — ${session.customer}*\n\n`
    + `Total: *${dates.totalQty}* · *${fmtQty(totYards)}* yds\n`
    + `across *${dates.length}* supply day${dates.length === 1 ? '' : 's'} · first: ${prettyDate(first.date)}\n\n`
    + `_Tap a date for the day's detail._`, rows);
}

/* ───────────────────────────── supply card (SBL-2) ───────────────────────────── */

/**
 * Group the day's sold rows for the compact card: design → shade → unique
 * bale numbers (bale identity via baleGroupKey, same as the detail view).
 */
async function loadSummary(session) {
  const all = await inventoryRepository.getAll();
  const label = await unitDisplayService.createQtyLabeller(all);
  const sold = await inventoryRepository.getSoldRows();
  const rows = sold.filter((r) => r.soldTo === session.customer && normDay(r.soldDate) === session.soldDate);
  const designs = new Map();
  const seen = new Set();
  let baleCount = 0;
  for (const r of rows) {
    if (!designs.has(r.design)) designs.set(r.design, new Map());
    const shades = designs.get(r.design);
    const sk = String(r.shade || '');
    // TV-8 — every than row rides the shade bucket (the label decides the
    // unit); the printed numbers stay one entry per physical bale.
    if (!shades.has(sk)) shades.set(sk, { bales: [], rows: [] });
    const e = shades.get(sk);
    e.rows.push(r);
    const k = baleGroupKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      baleCount += 1;
      e.bales.push(String(r.packageNo));
    }
  }
  return { designs, baleCount, label, dayQty: label(rows), rows };
}

/** Render the compact supply card, in place. opts.reading → ⏳ status. */
async function renderSummary(bot, chatId, userId, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const { designs, baleCount, label, dayQty } = await loadSummary(session);
  if (!baleCount) {
    await render(bot, chatId, userId,
      `🧾 *${session.customer}* · ${prettyDate(session.soldDate)}\n\n_Nothing found — it may have been returned._`,
      [backRow('⬅ Dates'), closeRow()]);
    return;
  }
  if (!Array.isArray(session._docs)) {
    session._docs = await saleDocReconcile.docsFor(session.customer, session.soldDate);
    sessionStore.set(userId, session);
  }
  const verified = new Set(session._verified || []);
  let body = `🧾 *${session.customer}* · ${prettyDate(session.soldDate)}\n`
    + `_${dayQty} supplied_\n`;
  if (opts.reading) {
    const prog = opts.of > 1 ? ` (doc ${opts.at}/${opts.of})` : '';
    body += `\n⏳ _Reading sale doc…${prog}_\n`;
  } else if (session._recDone) {
    body += `\n📑 Doc check: *${session._recMatched}/${baleCount}* matched\n`;
    if ((session._recMissing || []).length) {
      const miss = session._recMissing;
      body += `⚠️ Not in doc: ${miss.slice(0, 8).join(', ')}${miss.length > 8 ? ` +${miss.length - 8} more` : ''}\n`;
    }
    if ((session._docOnly || []).length) {
      const extra = session._docOnly;
      body += `_Doc-only numbers: ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ` +${extra.length - 8} more` : ''}_\n`;
    }
    if (session._recError) body += `_${session._recError}_\n`;
  } else if (session._recError) {
    body += `\n⚠️ _Doc check failed: ${session._recError}_\n`;
  }
  for (const [design, shades] of designs) {
    const cat = designCategoriesRepository.categoryOfSync(design);
    body += `\n🧵 *${design}*${cat ? ` · ${cat}` : ''}\n`;
    for (const [shade, e] of shades) {
      const nums = saleDocReconcile.dotted(e.bales, [...verified]);
      body += ` • Shade ${shade || '—'} ×${label(e.rows)} (${nums})\n`;
    }
  }
  const rows = [];
  if (opts.reading) {
    // SBL-2b (owner, 02-Aug) — a long OCR must never strand the card
    // buttonless: Stop restores it instantly and orphans the read.
    rows.push([{ text: '✖ Stop check', callback_data: 'sbl:recstop' }]);
  } else {
    if ((session._docs || []).length) {
      const n = session._docs.length;
      rows.push([{ text: `📄 Sale doc${n > 1 ? ` (${n})` : ''}`, callback_data: 'sbl:doc' }]);
      rows.push([{ text: session._recDone ? '🔁 Re-check sale doc' : '🧮 Reconcile sale doc', callback_data: 'sbl:rec' }]);
    }
    rows.push([{ text: session.showMoney ? '🔎 Full details — thans, yards & value' : '🔎 Full details — thans & yards', callback_data: 'sbl:full' }]);
    rows.push(backRow('⬅ Dates'));
    rows.push(closeRow());
  }
  await render(bot, chatId, userId, body, rows);
}

/** SBL-2 — deliver the day's sale doc(s) as ephemeral views (TRF-9b). */
async function sendSaleDocs(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  await saleDocReconcile.sendDocs(bot, chatId, userId, session._docs || [],
    `📄 Sale doc — ${session.customer} · ${prettyDate(session.soldDate)}`);
}

/**
 * SBL-2 — 🧮 reconcile: OCR every sale doc, collect the bale numbers the
 * document actually contains, and re-render the SAME card with 🟢 dots on
 * digit-exact matches. Never mutates any sheet.
 */
async function runReconcile(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !(session._docs || []).length || session._recRunning) return;
  // SBL-2b — generation counter: ✖ Stop (or switching day) bumps it, so a
  // read still in flight becomes an orphan whose result is discarded — it
  // can never overwrite a card the user has already taken back.
  const gen = (session._recGen || 0) + 1;
  session._recGen = gen;
  session._recRunning = true;
  session._recError = null;
  sessionStore.set(userId, session);

  const stillMine = () => {
    const s = sessionStore.get(userId);
    return s && s.type === SESSION_TYPE && s._recGen === gen;
  };
  const { digits: docDigits, error: readErr, aborted } = await saleDocReconcile.readBaleDigits(
    bot, session._docs, {
      onProgress: async (at, of) => { if (stillMine()) await renderSummary(bot, chatId, userId, { reading: true, at, of }); },
      shouldAbort: () => !stillMine(),
    });
  if (aborted) return;

  // Only the summary card of the SAME customer+day AND the same
  // (un-stopped) run gets the result.
  const s2 = sessionStore.get(userId);
  if (!s2 || s2.type !== SESSION_TYPE || s2.step !== 'view_summary' || s2._recGen !== gen) return;
  const { designs } = await loadSummary(s2);
  const cardBales = [];
  for (const shades of designs.values()) {
    for (const e of shades.values()) for (const p of e.bales) cardBales.push(String(p));
  }
  if (!docDigits.size) {
    s2._recRunning = false;
    s2._recDone = false;
    s2._recError = readErr || 'no bale numbers found in the document';
    sessionStore.set(userId, s2);
    await renderSummary(bot, chatId, userId);
    return;
  }
  const res = saleDocReconcile.reconcile(cardBales, docDigits);
  s2._verified = res.verified;
  s2._recMatched = res.matched;
  s2._recMissing = res.missing;
  s2._docOnly = res.docOnly;
  s2._recDone = true;
  s2._recError = readErr ? `partial read (${readErr})` : null;
  s2._recRunning = false;
  sessionStore.set(userId, s2);
  await renderSummary(bot, chatId, userId);
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
  const rows = sold.filter((r) => r.soldTo === session.customer && normDay(r.soldDate) === session.soldDate);
  if (!rows.length) {
    await render(bot, chatId, userId,
      `🔎 *${session.customer}* · ${prettyDate(session.soldDate)}\n\n_Nothing found — it may have been returned._`,
      [backRow('⬅ Summary'), closeRow()]);
    return;
  }
  // TV-8 — header/total follow the goods; the per-bale lines below stay a
  // than-by-than breakdown, which is what this deep view is for.
  const dayQty = (await unitDisplayService.createQtyLabeller(await inventoryRepository.getAll()))(rows);

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
    + `_${dayQty} sold this day_\n`;
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
  body += `\n──────────\n*Total:* ${dayQty} · ${fmtQty(totYards)} yd`;
  if (showMoney) body += ` · *${fmtNgn(totAmount)}*`;

  await render(bot, chatId, userId, body, [backRow('⬅ Summary'), closeRow()]);
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
      // SBL-2 — detail steps back to the compact supply card, dots intact.
      session.step = 'view_summary';
      sessionStore.set(userId, session);
      await renderSummary(bot, chatId, userId);
      break;
    case 'view_summary':
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
  // SBL-2/TRF-9b — a delivered sale doc is a peek, not a chat resident:
  // any sbl tap sweeps this user's fetched doc views first (the sbl:doc
  // tap itself included, so re-fetching REPLACES instead of stacking).
  try { await require('../services/ephemeralDocs').sweep(bot, userId); } catch (_) { /* viewer state only */ }
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
      session.step = 'view_summary';
      // SBL-2 — a fresh day starts clean: docs re-resolved, dots cleared.
      // SBL-2b — bump the generation: a read still running for the
      // PREVIOUS day becomes an orphan and can't dot this day's card.
      session._recGen = (session._recGen || 0) + 1;
      delete session._docs;
      delete session._verified;
      delete session._recDone; delete session._recMatched;
      delete session._recMissing; delete session._docOnly;
      delete session._recError; delete session._recRunning;
      sessionStore.set(userId, session);
      await renderSummary(bot, chatId, userId);
    }
    return true;
  }

  if (data === 'sbl:doc') {
    if (session.step !== 'view_summary' && session.step !== 'view_detail') return true;
    await sendSaleDocs(bot, chatId, userId);
    return true;
  }

  if (data === 'sbl:rec') {
    if (session.step !== 'view_summary') return true;
    await runReconcile(bot, chatId, userId);
    return true;
  }

  if (data === 'sbl:recstop') {
    // SBL-2b — instantly take the card back; the in-flight read is
    // orphaned by the generation bump and its result discarded.
    if (session.step !== 'view_summary') return true;
    session._recGen = (session._recGen || 0) + 1;
    session._recRunning = false;
    sessionStore.set(userId, session);
    await renderSummary(bot, chatId, userId);
    return true;
  }

  if (data === 'sbl:full') {
    if (session.step !== 'view_summary') return true;
    session.step = 'view_detail';
    sessionStore.set(userId, session);
    await renderDetail(bot, chatId, userId);
    return true;
  }

  return false;
}

module.exports = {
  start,
  handleCallback,
  _internals: {
    // SLG-1 — the Supply Ledger's day chips open THIS card (one detail
    // surface everywhere, per the owner's no-duplication order).
    renderSummary,
    renderCustomerPicker, renderDatePicker, renderDetail, stepBack,
    loadCustomers, loadDatesForCustomer, prettyDate, baleGroupKey, chunkButtons,
    SESSION_TYPE,
  },
};
