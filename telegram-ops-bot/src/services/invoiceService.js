'use strict';

/**
 * INV-1a — customer invoices (specs/INV-1_CUSTOMER_INVOICES.md, decisions
 * locked 14-Jul-2026).
 *
 * Issued for every APPROVED sale (sell_* family + sale_bundle) from the
 * executor's success path. Statement-style per the owner's samples: the
 * header is the CUSTOMER's account (no business name / registration
 * anywhere), costs and payments in separate columns, payments in red with
 * the receiving account named, DEBIT BALANCE at the bottom.
 *
 * Numbering: INV-<year>-NNNN, minted from the Invoices sheet MAX+1 under a
 * process mutex — restart-safe; voided numbers are never reused.
 */

const crypto = require('crypto');
const { todayInLagos } = require('../utils/dates');
const path = require('path');
const PDFDocument = require('pdfkit');

const invoicesRepository = require('../repositories/invoicesRepository');
const mutex = require('../utils/asyncMutex');
const config = require('../config');
const logger = require('../utils/logger');
// CUR-1 / BUSINESS_RULES §17 — the invoice is a SALE document (side B):
// every figure prints bare through money.sale / money.saleRate; no symbol,
// no unit, anywhere on the paper. The column headers go through
// money.saleHeader so a label could only ever be reintroduced in one seam.
const money = require('../utils/money');

const FONT = path.join(__dirname, '../assets/fonts/DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '../assets/fonts/DejaVuSans-Bold.ttf');

/** The document's own word for a figure it cannot state (rule 12). */
const DASH = '—';
const INK = '#20242a';
const GOLD = '#c9a24b';
const RED = '#c0392b';
const MUTED = '#8a8578';

// TIME-1 — the invoice's issue date is a business fact shown to the customer.
function todayIso() { return todayInLagos(); }

/**
 * CARD-5 — a line's packaging in customer words: "28 thans", "4 bales +
 * 8 thans", '' when the line predates the packaging fields. Shared by the
 * PDF and the web statement so the two can never disagree.
 */
function packagingWords(l) {
  const bits = [];
  const b = Number(l && l.bales);
  const t = Number(l && l.thans);
  if (Number.isFinite(b) && b > 0) bits.push(`${b} bale${b === 1 ? '' : 's'}`);
  if (Number.isFinite(t) && t > 0) bits.push(`${t} than${t === 1 ? '' : 's'}`);
  return bits.join(' + ');
}

/** "Paid to GTBank" / "GTBank transfer" → "GTBank"; plain modes → ''. */
function bankFromPaymentMode(paymentMode) {
  const m = /paid to (.+)/i.exec(paymentMode || '');
  if (m) return m[1].trim();
  return '';
}

/**
 * Per-design invoice lines from a sale's actionJSON + admin enrichment.
 * Sources in priority order: yardsByDesign (ST-1 controller path) →
 * items[] aggregation (bundle path) → single-design fields (sell_than/pkg).
 */
function buildLines(aj, enrichment) {
  const rateFor = (design) => {
    const map = (enrichment && enrichment.ratePerUnitByDesign) || aj.ratePerUnitByDesign || {};
    const r = Number(map[design] ?? map[String(design).toUpperCase()] ?? enrichment?.pricePerYard);
    return Number.isFinite(r) && r > 0 ? r : 0;
  };

  let perDesign = [];
  if (aj.yardsByDesign && Object.keys(aj.yardsByDesign).length) {
    perDesign = Object.entries(aj.yardsByDesign).map(([design, yards]) => ({ design, yards: Number(yards) || 0, count: null, shades: null }));
  } else if (Array.isArray(aj.items) && aj.items.length) {
    const agg = new Map();
    for (const it of aj.items) {
      const d = it.design || aj.design || '';
      if (!agg.has(d)) agg.set(d, { design: d, yards: 0, count: 0, shades: new Set(), thans: 0, balePkgs: new Set() });
      const g = agg.get(d);
      g.yards += Number(it.yards) || 0;
      g.count += 1;
      if (it.shade !== undefined && it.shade !== '') g.shades.add(String(it.shade));
      // CARD-5 grammar (owner, 29-Aug-2026) — the item's OWN packaging:
      // a than item counts thans, anything else is a whole bale counted by
      // its DISTINCT printed number (five thans out of three bales must
      // never read "5 bales" — and 28 thans must never read "28 bales",
      // which is exactly what the ABBA statement did).
      if (it.type === 'than') g.thans += Number(it.thans) || 1;
      else g.balePkgs.add(String(it.packageNo ?? ''));
    }
    perDesign = [...agg.values()].map((g) => ({
      design: g.design, yards: g.yards, count: g.count,
      shades: [...g.shades].sort((a, b) => Number(a) - Number(b)),
      bales: g.balePkgs.size, thans: g.thans,
    }));
  } else {
    perDesign = [{ design: aj.design || '', yards: Number(aj.yards) || 0, count: null, shades: aj.shade ? [String(aj.shade)] : null }];
  }

  return perDesign.filter((l) => l.design || l.yards).map((l) => {
    const rate = rateFor(l.design);
    return {
      design: l.design,
      yards: l.yards,
      qty: l.count,
      // CARD-5 — packaging frozen at issue; older invoices lack these and
      // every renderer must fall back to a neutral word, never guess "bales".
      bales: Number.isFinite(l.bales) ? l.bales : null,
      thans: Number.isFinite(l.thans) ? l.thans : null,
      shades: l.shades && l.shades.length ? l.shades : null,
      rate,
      amount: Math.round(l.yards * rate),
    };
  });
}

/** Mint the next INV-<year>-NNNN under a mutex (restart-safe, no reuse). */
async function mintInvoiceNo(now = new Date()) {
  const year = now.getFullYear();
  return mutex.runExclusive('invoice_no_mint', async () => {
    const max = await invoicesRepository.maxSeqForYear(year);
    return `INV-${year}-${String(max + 1).padStart(4, '0')}`;
  });
}

/**
 * Create + persist the invoice for an approved sale. Called from the
 * executor's success path; throws are caught there (best-effort — a failed
 * invoice never fails the sale).
 */
async function createForSale({ item, enrichment, approvedBy }) {
  const aj = item.actionJSON || {};
  let customerName = aj.customer || aj.customerName || '';
  // BOOKED figures — variable 1, exactly what the ledger / Transactions /
  // statement hold. Nothing below this line is ever multiplied.
  const lines = buildLines(aj, enrichment);
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const amountPaid = Number(enrichment?.amountPaid ?? aj.amountPaid) || 0;
  // CUR-2 §7 freeze rule (D3) — the customer-copy multiplier is resolved
  // ONCE, here, and frozen on the row; a later Settings change never
  // touches an issued invoice.
  const rateMultiplier = await resolveRateMultiplier(enrichment);

  // CUS-2 — the approval assignment step stamps aj.customerId; prefer it,
  // then fall back to entity resolution (alias-aware, husk-excluding).
  // The invoice carries the CANONICAL name so merged spellings never
  // propagate onto customer-facing paper.
  let customerId = '';
  try {
    const customerEntity = require('./customerEntity');
    const row = await customerEntity.resolve({ id: aj.customerId, name: customerName });
    if (row) {
      customerId = row.customer_id || '';
      if (row.name) customerName = row.name;
    }
  } catch (e) { logger.warn(`invoice: customer_id lookup failed: ${e.message}`); }

  // Issue-time balance snapshot (customer-level, ledger-derived). Best
  // effort — the web view recomputes live; null means "not captured".
  let balanceAfter = null;
  try {
    const accountingService = require('./accountingService');
    const ledger = await accountingService.getCustomerLedger(customerName);
    const out = ledger && (ledger.outstandingAsOfToday ?? ledger.outstanding);
    if (Number.isFinite(Number(out))) balanceAfter = Number(out);
  } catch (e) { logger.warn(`invoice: balance snapshot failed: ${e.message}`); }

  const paymentMode = enrichment?.paymentMode || aj.paymentMode || '';
  const invoice = {
    invoiceNo: await mintInvoiceNo(),
    token: crypto.randomBytes(12).toString('base64url'),
    requestId: item.requestId,
    customerId,
    customerName,
    issueDate: todayIso(),
    saleDate: aj.salesDate || todayIso(),
    lines,
    subtotal,
    vatRate: 0, vatAmount: 0,
    total: subtotal,
    amountPaidAtIssue: amountPaid,
    balanceAfterIssue: balanceAfter,
    paymentMode,
    bank: bankFromPaymentMode(paymentMode),
    salesperson: aj.salesPerson || aj.salesperson || '',
    warehouse: aj.warehouse || '',
    status: 'issued',
    pdfDriveId: '',
    createdBy: approvedBy,
    createdAt: new Date().toISOString(),
    // CUR-2 — the factor the customer copy multiplies the booked rate by;
    // null = none (the repository writes a blank cell, never `1`).
    rateMultiplier,
  };
  await invoicesRepository.append(invoice);
  return invoice;
}

/**
 * CUR-2 §7 / §8 rule 11 — the multiplier in force at issue, PRESENCE-based:
 *   key `rateMultiplier` PRESENT on the enrichment (the wizard's Step 5 ran,
 *     release B; `1` = the admin tapped "No multiplier") → that value, put
 *     through the ONE range check, and Settings is NEVER consulted — a
 *     hand-edited value that is 1, ≤ 0, non-finite or > 1,000,000 means none;
 *   key ABSENT (the Settings-fulfilled path of release A, old rows) → the
 *     Settings cell INVOICE_RATE_MULTIPLIER if it is a number > 0 and ≠ 1
 *     (getAll() reads a blank cell as 0 — none), else none.
 * Returns a number or null. Best-effort on the Settings read: a sheet
 * failure means none, never a failed sale.
 */
async function resolveRateMultiplier(enrichment) {
  const { normaliseRateMultiplier } = invoicesRepository;
  if (enrichment && Object.prototype.hasOwnProperty.call(enrichment, 'rateMultiplier')
      && enrichment.rateMultiplier !== undefined) {
    return normaliseRateMultiplier(enrichment.rateMultiplier);
  }
  try {
    const settingsRepository = require('../repositories/settingsRepository');
    const settings = await settingsRepository.getAll();
    const raw = settings && settings.INVOICE_RATE_MULTIPLIER;
    const m = normaliseRateMultiplier(raw);
    // A cell the owner filled that does not parse must not fail silently:
    // the invoice still goes out (unconverted), but the log says why.
    const rawText = (raw == null ? '' : String(raw)).trim();
    if (m === null && rawText !== '' && rawText !== '0' && rawText !== '1') {
      logger.warn(`invoice: INVOICE_RATE_MULTIPLIER cell ${JSON.stringify(rawText)} is not a usable factor — issuing unconverted`);
    }
    return m;
  } catch (e) {
    logger.warn(`invoice: rate multiplier settings read failed: ${e.message}`);
    return null;
  }
}

/**
 * CUR-2 §7 — the ONE place the document's printed numbers come from, so the
 * PDF, the web copy and any future renderer cannot disagree. Everything
 * here is derived from the STORED row: booked lines × the STORED factor
 * (`invoice.rateMultiplier`; null / blank column = none → the booked figures,
 * unconverted). Settings is never read at render time (rule 13).
 *
 * Arithmetic (§2, §8, Q5 "recompute"):
 *   factor m   — the frozen multiplier, or 1 when none;
 *   rate       — `rate × m`, printed to 2 dp whenever m ≠ 1 (Q1: always
 *                2 dp on a converted copy); unconverted, an integer entered
 *                rate prints as entered (`1,450/yd`) and a fractional one to
 *                2 dp (`3.20/yd`, never truncated to `3` — rule 8);
 *   line       — `round(yards × rate × m)`; with no multiplier the BOOKED
 *                line amount, untouched;
 *   total      — Σ document lines when converted (the column always adds
 *                up); the booked total when not;
 *   paid       — `round(paid × m)` (D2: the payment row converts at the
 *                same factor);
 *   balance    — document total − document paid, floored at 0;
 *   status     — PAID / PART-PAID / UNPAID from the BOOKED total and paid
 *                (rule 17: a factor < 1 may round a live debt to 0 on the
 *                paper; the strip must never say PAID over a debt), or
 *                RATE NOT RECORDED when any line's rate never resolved
 *                (rule 12: no money is derived from a missing rate; the
 *                cost, total and balance print `—`, the payment still
 *                prints in the document's unit).
 * Every text field is bare — no symbol, no unit, no "× m" note (rule 10).
 */
function docFigures(invoice) {
  const inv = invoice || {};
  const m = invoicesRepository.normaliseRateMultiplier(inv.rateMultiplier);
  const converted = m !== null;
  const factor = converted ? m : 1;
  const bookedTotal = Number(inv.total) || 0;
  const bookedPaid = Number(inv.amountPaidAtIssue) || 0;
  const bookedBalance = bookedTotal - bookedPaid;
  const srcLines = Array.isArray(inv.lines) ? inv.lines : [];

  const lines = srcLines.map((l) => {
    const rate = Number(l.rate) || 0;
    const yards = Number(l.yards) || 0;
    const resolved = rate > 0;
    const docRate = rate * factor;
    const rateDp = converted || !Number.isInteger(rate) ? 2 : 0;
    const docAmount = converted ? Math.round(yards * rate * factor) : (Number(l.amount) || 0);
    return {
      ...l,
      resolved,
      docRate,
      docRateText: resolved ? money.saleRate(docRate, { fraction: rateDp }) : '',
      docAmount,
      docAmountText: resolved ? money.sale(docAmount) : DASH,
    };
  });
  const rateUnresolved = lines.some((l) => !l.resolved);

  const total = converted ? lines.reduce((s, l) => s + l.docAmount, 0) : bookedTotal;
  const paid = converted ? Math.round(bookedPaid * factor) : bookedPaid;
  const balance = Math.max(total - paid, 0);

  let status;
  if (rateUnresolved) status = 'RATE NOT RECORDED';
  else if (bookedBalance <= 0) status = 'PAID';
  else if (bookedPaid > 0) status = 'PART-PAID';
  else status = 'UNPAID';

  const totalText = rateUnresolved ? DASH : money.sale(total);
  const paidText = money.sale(paid);
  const balanceText = rateUnresolved ? DASH : money.sale(balance);
  const stripText = status === 'RATE NOT RECORDED'
    ? 'RATE NOT RECORDED'
    : (status === 'PAID'
      ? `PAID · ${totalText} settled`
      : (status === 'PART-PAID'
        ? `PART-PAID · ${paidText} received of ${totalText}`
        : `UNPAID · ${totalText} due`));

  return {
    multiplier: m, converted, factor, rateUnresolved,
    lines, total, paid, balance, status,
    totalText, paidText, balanceText, stripText,
  };
}

/**
 * The Telegram caption on the delivered PDF — a STAFF message (approving
 * admin + requester), not the paper the customer holds: it prints the
 * BOOKED figures the ledger moves by (the RET-3 card discipline) and names
 * the frozen multiplier in ONE extra line when a factor applies (§4b, §5).
 * Rate unresolved → `Total — · Paid 400 · Balance —` (rule 12).
 */
/**
 * The frozen factor as staff read it: grouped, at ITS OWN precision (up
 * to 6 dp), never a fixed 2 dp — a factor below 0.005 (rule 17 allows
 * any finite factor > 0) must not print as `× 0.00`, and `1250.125` must
 * not print as `× 1,250.13`. The line's one job is to name the factor in
 * column W exactly.
 *   1250 → '1,250' · 1.5 → '1.5' · 0.0004 → '0.0004'
 */
function factorText(m) {
  const n = Number(m) || 0;
  const dp = Number.isInteger(n) ? 0 : Math.min(6, (String(n).split('.')[1] || '').length);
  return money.sale(n, { fraction: dp });
}

function caption(invoice) {
  const fig = docFigures(invoice);
  const total = Number(invoice.total) || 0;
  const paid = Number(invoice.amountPaidAtIssue) || 0;
  const totalTxt = fig.rateUnresolved ? DASH : money.sale(total);
  const balTxt = fig.rateUnresolved ? DASH : money.sale(Math.max(total - paid, 0));
  const base = config.baseUrl || '';
  const webLine = base && invoice.token ? `\n🔗 Live copy: ${base}/i/${invoice.token}` : '';
  const multLine = fig.converted ? `\nCustomer copy × ${factorText(fig.multiplier)}` : '';
  return `🧾 ${invoice.invoiceNo} — ${invoice.customerName}\nTotal ${totalTxt} · Paid ${money.sale(paid)} · Balance ${balTxt}${multLine}${webLine}\nForward this PDF (or the link) to the customer on WhatsApp.`;
}

/**
 * Draw the statement onto a pdfkit-shaped `doc` (A5 portrait, margin 0).
 * Layout mirrors specs/inv1-mockups/template-final-hybrid.html and the
 * CUR-2 §4a / §4b drawings. Every money string comes from docFigures —
 * this function never touches a booked figure directly.
 */
function paint(doc, invoice) {
  const fig = docFigures(invoice);
  const W = doc.page.width;              // 420pt
  const M = 28;                          // side margin
  const status = fig.status;

  // Header band — customer account, no business identity (owner rule).
  doc.rect(0, 0, W, 96).fill(INK);
  doc.font(FONT_BOLD).fontSize(15).fillColor('#ffffff')
    .text(`${(invoice.customerName || '').toUpperCase()} `, M, 22, { continued: true })
    .fillColor(GOLD).text('— ACCOUNT');
  const meta = [
    ['INVOICE', invoice.invoiceNo],
    ['SALE DATE', invoice.saleDate],
    ['WAREHOUSE', invoice.warehouse || DASH],
  ];
  meta.forEach(([lbl, val], i) => {
    const x = M + i * ((W - 2 * M) / 3);
    doc.font(FONT).fontSize(6.5).fillColor('#8f97a3').text(lbl, x, 58);
    doc.font(FONT_BOLD).fontSize(9).fillColor('#ffffff').text(val, x, 68);
  });

  // Status strip — the word from the BOOKED figures, the numbers from the
  // document's (rule 17); RATE NOT RECORDED names the hole (rule 12).
  doc.rect(0, 96, W, 24).fill(status === 'PAID' ? '#e8f0e4' : '#f7ead0');
  doc.font(FONT_BOLD).fontSize(9).fillColor(status === 'PAID' ? '#3c6e35' : '#7d5f1d')
    .text(fig.stripText, 0, 103, { width: W, align: 'center' });

  // Table header — bare words (R12b): no symbol, no unit.
  let y = 140;
  const colCost = W - M - 150, colPay = W - M - 70;
  doc.font(FONT).fontSize(6.5).fillColor(MUTED);
  doc.text('DESCRIPTION', M, y);
  doc.text(money.saleHeader('COST'), colCost, y, { width: 70, align: 'right' });
  doc.text(money.saleHeader('PAYMENTS'), colPay, y, { width: 70, align: 'right' });
  y += 11;
  doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1.4).strokeColor(INK).stroke();
  y += 8;

  // Line items.
  for (const l of fig.lines) {
    const descBits = [];
    if (l.shades) descBits.push(`Shades ${l.shades.join(', ')}`);
    // CARD-5 — the item's own packaging on every sale surface. Customer
    // documents spell the words out ("28 thans", "4 bales + 8 thans");
    // the compact B/t form stays on the internal Telegram cards. Lines
    // frozen before the packaging fields existed say a neutral "items"
    // rather than guessing a word that may be wrong.
    const pkg = packagingWords(l);
    if (pkg) descBits.push(pkg);
    else if (l.qty) descBits.push(`${l.qty} item${l.qty === 1 ? '' : 's'}`);
    descBits.push(`${money.sale(l.yards)} yds${l.docRateText ? ` @ ${l.docRateText}` : ''}`);
    doc.font(FONT_BOLD).fontSize(9.5).fillColor(INK).text(`Design ${l.design}`, M, y);
    doc.font(FONT).fontSize(9.5).fillColor(INK)
      .text(l.docAmountText, colCost, y, { width: 70, align: 'right' });
    y += 12;
    doc.font(FONT).fontSize(7.5).fillColor(MUTED).text(descBits.join(' · '), M, y, { width: colCost - M - 8 });
    y += doc.heightOfString(descBits.join(' · '), { width: colCost - M - 8 }) + 6;
    doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.5).strokeColor('#ece8dd').stroke();
    y += 8;
  }

  // Total row.
  doc.font(FONT).fontSize(8.5).fillColor(MUTED).text('Total', M, y);
  doc.font(FONT).fontSize(9.5).fillColor(INK).text(fig.totalText, colCost, y, { width: 70, align: 'right' });
  y += 16;

  // Payment row (red, with date + receiving account) — owner's sample style.
  // Printed in the document's unit (D2: the same factor as every other cell).
  if (fig.paid > 0) {
    const payLbl = `${invoice.saleDate} paid${invoice.bank ? ` to ${invoice.bank} account` : (invoice.paymentMode ? ` (${invoice.paymentMode})` : '')}`;
    doc.font(FONT).fontSize(8.5).fillColor(RED).text(payLbl, M, y, { width: colPay - M - 8 });
    doc.font(FONT_BOLD).fontSize(9.5).fillColor(RED).text(fig.paidText, colPay, y, { width: 70, align: 'right' });
    y += 18;
  }

  // Debit balance.
  doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).strokeColor(INK).stroke();
  y += 10;
  doc.font(FONT_BOLD).fontSize(12).fillColor(INK).text('DEBIT BALANCE', M, y);
  doc.font(FONT_BOLD).fontSize(12).fillColor(INK)
    .text(fig.balanceText, colCost, y, { width: 140, align: 'right' });

  // Footer — link only (no business identity).
  doc.font(FONT).fontSize(6.5).fillColor('#a49d8e')
    .text('Secured with WhatsApp code · Live copy & PDF at the link shared with you', 0, doc.page.height - 30, { width: W, align: 'center' });
}

/** Render the statement-style PDF (A5 portrait) → Buffer. */
function renderPdf(invoice) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 0, info: { Title: invoice.invoiceNo } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    paint(doc, invoice);
    doc.end();
  });
}

/**
 * Test seam (CUR-1 §6) — the strings the PDF draws, in draw order, from a
 * recording doc that mirrors the pdfkit surface `paint` uses. Same code
 * path as renderPdf, so a pin here is a pin on the paper.
 */
function renderText(invoice) {
  const out = [];
  const rec = {
    page: { width: 419.53, height: 595.28 },
    text(str) { out.push(String(str)); return rec; },
    heightOfString() { return 10; },
  };
  for (const k of ['rect', 'fill', 'font', 'fontSize', 'fillColor', 'moveTo', 'lineTo', 'lineWidth', 'strokeColor', 'stroke']) {
    rec[k] = () => rec;
  }
  paint(rec, invoice);
  return out;
}

/** Send the invoice PDF to Telegram chat(s). Best-effort per recipient. */
async function deliver(bot, invoice, chatIds) {
  const pdf = await renderPdf(invoice);
  // INV-1b: the caption carries the live web copy link when a public base
  // URL is configured (BASE_URL env); CUR-2: booked figures + the
  // `Customer copy × m` line — see caption().
  const text = caption(invoice);
  const seen = new Set();
  for (const chatId of chatIds.filter(Boolean)) {
    if (seen.has(String(chatId))) continue;
    seen.add(String(chatId));
    try {
      await bot.sendDocument(chatId, pdf, { caption: text }, { filename: `${invoice.invoiceNo}.pdf`, contentType: 'application/pdf' });
    } catch (e) {
      logger.warn(`invoice deliver to ${chatId} failed: ${e.message}`);
    }
  }
}

module.exports = {
  packagingWords, // CARD-5 — shared with the web statement renderer
  docFigures,     // CUR-2 — the one source of the document's printed numbers
  caption,        // CUR-2 — the staff caption on the delivered PDF
  createForSale, buildLines, mintInvoiceNo, renderPdf, deliver, bankFromPaymentMode,
  _internals: { renderText, resolveRateMultiplier, DASH },
};
