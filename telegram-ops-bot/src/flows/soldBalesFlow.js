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
  const sold = await inventoryRepository.getSoldRows();
  const byDate = new Map();
  for (const r of sold) {
    if (r.soldTo !== customer) continue;
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
  rows.push(backRow('👤 Change customer'));
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `📒 *Supplies — ${session.customer}*\n\n`
    + `Total: *${totBales}* bales · *${fmtQty(totYards)}* yds\n`
    + `across *${dates.length}* supply day${dates.length === 1 ? '' : 's'} · first: ${prettyDate(first.date)}\n\n`
    + `_Tap a date for the day's detail._`, rows);
}

/* ───────────────────────────── supply card (SBL-2) ───────────────────────────── */

function digitsOf(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

/**
 * The day's sale documents: resolved (approved) sale approvals for this
 * customer + date that carry a bill photo/PDF (`sale_doc_file_id`, written
 * by the snap flows). Deduped by file id.
 * @returns {Promise<Array<{fileId:string, kind:'photo'|'document'}>>}
 */
async function saleDocsFor(customer, soldDate) {
  try {
    const approvalQueueRepository = require('../repositories/approvalQueueRepository');
    const cust = String(customer || '').trim().toLowerCase();
    const seen = new Set();
    const docs = [];
    for (const r of await approvalQueueRepository.getResolved()) {
      if (String(r.status || '').toLowerCase() !== 'approved') continue;
      const aj = r.actionJSON || {};
      if (!aj.sale_doc_file_id || seen.has(aj.sale_doc_file_id)) continue;
      if (String(aj.customer || '').trim().toLowerCase() !== cust) continue;
      if (normDay(aj.salesDate) !== soldDate) continue;
      seen.add(aj.sale_doc_file_id);
      docs.push({
        fileId: aj.sale_doc_file_id,
        // snap PDF batches ride as documents; snap bill photos as photos.
        kind: aj.action === 'sale_bundle' ? 'document' : 'photo',
      });
    }
    return docs;
  } catch (_) { return []; }
}

/**
 * Group the day's sold rows for the compact card: design → shade → unique
 * bale numbers (bale identity via baleGroupKey, same as the detail view).
 */
async function loadSummary(session) {
  const sold = await inventoryRepository.getSoldRows();
  const rows = sold.filter((r) => r.soldTo === session.customer && normDay(r.soldDate) === session.soldDate);
  const designs = new Map();
  const seen = new Set();
  let baleCount = 0;
  for (const r of rows) {
    const k = baleGroupKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    baleCount += 1;
    if (!designs.has(r.design)) designs.set(r.design, new Map());
    const shades = designs.get(r.design);
    const sk = String(r.shade || '');
    if (!shades.has(sk)) shades.set(sk, []);
    shades.get(sk).push(String(r.packageNo));
  }
  return { designs, baleCount };
}

/** Render the compact supply card, in place. opts.reading → ⏳ status. */
async function renderSummary(bot, chatId, userId, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const { designs, baleCount } = await loadSummary(session);
  if (!baleCount) {
    await render(bot, chatId, userId,
      `🧾 *${session.customer}* · ${prettyDate(session.soldDate)}\n\n_Nothing found — it may have been returned._`,
      [backRow('⬅ Dates'), closeRow()]);
    return;
  }
  if (!Array.isArray(session._docs)) {
    session._docs = await saleDocsFor(session.customer, session.soldDate);
    sessionStore.set(userId, session);
  }
  const verified = new Set(session._verified || []);
  let body = `🧾 *${session.customer}* · ${prettyDate(session.soldDate)}\n`
    + `_${baleCount} bale(s) supplied_\n`;
  if (opts.reading) {
    body += '\n⏳ _Reading sale doc…_\n';
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
    for (const [shade, pkgs] of shades) {
      const nums = pkgs.map((p) => (verified.has(digitsOf(p)) ? `🟢${p}` : p)).join(', ');
      body += ` • Shade ${shade || '—'} ×${pkgs.length} (${nums})\n`;
    }
  }
  const rows = [];
  if ((session._docs || []).length && !opts.reading) {
    const n = session._docs.length;
    rows.push([{ text: `📄 Sale doc${n > 1 ? ` (${n})` : ''}`, callback_data: 'sbl:doc' }]);
    rows.push([{ text: session._recDone ? '🔁 Re-check sale doc' : '🧮 Reconcile sale doc', callback_data: 'sbl:rec' }]);
  }
  if (!opts.reading) {
    rows.push([{ text: session.showMoney ? '🔎 Full details — thans, yards & value' : '🔎 Full details — thans & yards', callback_data: 'sbl:full' }]);
    rows.push(backRow('⬅ Dates'));
    rows.push(closeRow());
  }
  await render(bot, chatId, userId, body, rows);
}

/** SBL-2 — deliver the day's sale doc(s) as ephemeral views (TRF-9b). */
async function sendSaleDocs(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !(session._docs || []).length) return;
  const ephemeralDocs = require('../services/ephemeralDocs');
  for (const d of session._docs) {
    const caption = `📄 Sale doc — ${session.customer} · ${prettyDate(session.soldDate)}`;
    let sent = null;
    try {
      sent = d.kind === 'document'
        ? await bot.sendDocument(chatId, d.fileId, { caption })
        : await bot.sendPhoto(chatId, d.fileId, { caption });
    } catch (_) {
      // Stored kind can mislie (photo ids can't go out as documents and
      // vice versa) — retry the other way before giving up.
      try {
        sent = d.kind === 'document'
          ? await bot.sendPhoto(chatId, d.fileId, { caption })
          : await bot.sendDocument(chatId, d.fileId, { caption });
      } catch (e2) {
        logger.warn(`soldBalesFlow: sale doc send failed: ${e2.message}`);
      }
    }
    if (sent && sent.message_id) ephemeralDocs.track(bot, userId, chatId, sent.message_id);
  }
}

/**
 * SBL-2 — 🧮 reconcile: OCR every sale doc, collect the bale numbers the
 * document actually contains, and re-render the SAME card with 🟢 dots on
 * digit-exact matches. Never mutates any sheet.
 */
async function runReconcile(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !(session._docs || []).length || session._recRunning) return;
  session._recRunning = true;
  session._recError = null;
  sessionStore.set(userId, session);
  await renderSummary(bot, chatId, userId, { reading: true });

  const telegramFiles = require('../utils/telegramFiles');
  const vision = require('../services/vision');
  const docDigits = new Set();
  let readErr = null;
  for (const d of session._docs) {
    try {
      const dl = await telegramFiles.downloadTelegramFile(bot, d.fileId);
      const mime = dl.mimeType || (d.kind === 'document' ? 'application/pdf' : 'image/jpeg');
      const ocr = await vision.extractBales(dl.buffer, mime);
      if (!ocr.ok) { readErr = ocr.error || 'document unreadable'; continue; }
      for (const b of ocr.bales) {
        const dg = digitsOf(b.packageNo);
        if (dg) docDigits.add(dg);
      }
    } catch (e) { readErr = e.message; }
  }

  // The user may have navigated away while the OCR ran — only the summary
  // card of the SAME customer+day gets the result.
  const s2 = sessionStore.get(userId);
  if (!s2 || s2.type !== SESSION_TYPE || s2.step !== 'view_summary') return;
  const { designs } = await loadSummary(s2);
  const cardBales = [];
  for (const shades of designs.values()) {
    for (const pkgs of shades.values()) for (const p of pkgs) cardBales.push({ p, d: digitsOf(p) });
  }
  if (!docDigits.size) {
    s2._recRunning = false;
    s2._recDone = false;
    s2._recError = readErr || 'no bale numbers found in the document';
    sessionStore.set(userId, s2);
    await renderSummary(bot, chatId, userId);
    return;
  }
  const matched = cardBales.filter((x) => x.d && docDigits.has(x.d));
  const cardSet = new Set(cardBales.map((x) => x.d));
  s2._verified = [...new Set(matched.map((x) => x.d))];
  s2._recMatched = matched.length;
  s2._recMissing = cardBales.filter((x) => !docDigits.has(x.d)).map((x) => x.p);
  s2._docOnly = [...docDigits].filter((d) => !cardSet.has(d));
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
    renderCustomerPicker, renderDatePicker, renderDetail, stepBack,
    loadCustomers, loadDatesForCustomer, prettyDate, baleGroupKey, chunkButtons,
    SESSION_TYPE,
  },
};
