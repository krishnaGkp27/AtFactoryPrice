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
const path = require('path');
const PDFDocument = require('pdfkit');

const invoicesRepository = require('../repositories/invoicesRepository');
const mutex = require('../utils/asyncMutex');
const logger = require('../utils/logger');

const FONT = path.join(__dirname, '../assets/fonts/DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '../assets/fonts/DejaVuSans-Bold.ttf');

const NGN = '₦';
const INK = '#20242a';
const GOLD = '#c9a24b';
const RED = '#c0392b';
const MUTED = '#8a8578';

function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-NG', { maximumFractionDigits: 0 });
}

function todayIso() { return new Date().toISOString().slice(0, 10); }

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
      if (!agg.has(d)) agg.set(d, { design: d, yards: 0, count: 0, shades: new Set() });
      const g = agg.get(d);
      g.yards += Number(it.yards) || 0;
      g.count += 1;
      if (it.shade !== undefined && it.shade !== '') g.shades.add(String(it.shade));
    }
    perDesign = [...agg.values()].map((g) => ({ design: g.design, yards: g.yards, count: g.count, shades: [...g.shades].sort((a, b) => Number(a) - Number(b)) }));
  } else {
    perDesign = [{ design: aj.design || '', yards: Number(aj.yards) || 0, count: null, shades: aj.shade ? [String(aj.shade)] : null }];
  }

  return perDesign.filter((l) => l.design || l.yards).map((l) => {
    const rate = rateFor(l.design);
    return {
      design: l.design,
      yards: l.yards,
      qty: l.count,
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
  const customerName = aj.customer || aj.customerName || '';
  const lines = buildLines(aj, enrichment);
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const amountPaid = Number(enrichment?.amountPaid ?? aj.amountPaid) || 0;

  let customerId = '';
  try {
    const customersRepository = require('../repositories/customersRepository');
    const row = await customersRepository.findByName(customerName);
    if (row) customerId = row.customer_id || '';
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
  };
  await invoicesRepository.append(invoice);
  return invoice;
}

/**
 * Render the statement-style PDF (A5 portrait) → Buffer.
 * Layout mirrors specs/inv1-mockups/template-final-hybrid.html.
 */
function renderPdf(invoice) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 0, info: { Title: invoice.invoiceNo } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;              // 420pt
    const M = 28;                          // side margin
    const paidSoFar = invoice.amountPaidAtIssue || 0;
    const balance = invoice.total - paidSoFar;
    const status = balance <= 0 ? 'PAID' : (paidSoFar > 0 ? 'PART-PAID' : 'UNPAID');

    // Header band — customer account, no business identity (owner rule).
    doc.rect(0, 0, W, 96).fill(INK);
    doc.font(FONT_BOLD).fontSize(15).fillColor('#ffffff')
      .text(`${(invoice.customerName || '').toUpperCase()} `, M, 22, { continued: true })
      .fillColor(GOLD).text('— ACCOUNT');
    const meta = [
      ['INVOICE', invoice.invoiceNo],
      ['SALE DATE', invoice.saleDate],
      ['WAREHOUSE', invoice.warehouse || '—'],
    ];
    meta.forEach(([lbl, val], i) => {
      const x = M + i * ((W - 2 * M) / 3);
      doc.font(FONT).fontSize(6.5).fillColor('#8f97a3').text(lbl, x, 58);
      doc.font(FONT_BOLD).fontSize(9).fillColor('#ffffff').text(val, x, 68);
    });

    // Status strip.
    doc.rect(0, 96, W, 24).fill(status === 'PAID' ? '#e8f0e4' : '#f7ead0');
    const stripTxt = status === 'PAID'
      ? `PAID · ${NGN}${fmtMoney(invoice.total)} settled`
      : (status === 'PART-PAID'
        ? `PART-PAID · ${NGN}${fmtMoney(paidSoFar)} received of ${NGN}${fmtMoney(invoice.total)}`
        : `UNPAID · ${NGN}${fmtMoney(invoice.total)} due`);
    doc.font(FONT_BOLD).fontSize(9).fillColor(status === 'PAID' ? '#3c6e35' : '#7d5f1d')
      .text(stripTxt, 0, 103, { width: W, align: 'center' });

    // Table header.
    let y = 140;
    const colCost = W - M - 150, colPay = W - M - 70;
    doc.font(FONT).fontSize(6.5).fillColor(MUTED);
    doc.text('DESCRIPTION', M, y);
    doc.text(`COST ${NGN}`, colCost, y, { width: 70, align: 'right' });
    doc.text(`PAYMENTS ${NGN}`, colPay, y, { width: 70, align: 'right' });
    y += 11;
    doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1.4).strokeColor(INK).stroke();
    y += 8;

    // Line items.
    for (const l of invoice.lines) {
      const descBits = [];
      if (l.shades) descBits.push(`Shades ${l.shades.join(', ')}`);
      if (l.qty) descBits.push(`${l.qty} ${l.qty === 1 ? 'bale/than' : 'items'}`);
      descBits.push(`${fmtMoney(l.yards)} yds${l.rate ? ` @ ${NGN}${fmtMoney(l.rate)}/yd` : ''}`);
      doc.font(FONT_BOLD).fontSize(9.5).fillColor(INK).text(`Design ${l.design}`, M, y);
      doc.font(FONT).fontSize(9.5).fillColor(INK)
        .text(l.amount ? fmtMoney(l.amount) : '—', colCost, y, { width: 70, align: 'right' });
      y += 12;
      doc.font(FONT).fontSize(7.5).fillColor(MUTED).text(descBits.join(' · '), M, y, { width: colCost - M - 8 });
      y += doc.heightOfString(descBits.join(' · '), { width: colCost - M - 8 }) + 6;
      doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.5).strokeColor('#ece8dd').stroke();
      y += 8;
    }

    // Total row.
    doc.font(FONT).fontSize(8.5).fillColor(MUTED).text('Total', M, y);
    doc.font(FONT).fontSize(9.5).fillColor(INK).text(fmtMoney(invoice.total), colCost, y, { width: 70, align: 'right' });
    y += 16;

    // Payment row (red, with date + receiving account) — owner's sample style.
    if (paidSoFar > 0) {
      const payLbl = `${invoice.saleDate} paid${invoice.bank ? ` to ${invoice.bank} account` : (invoice.paymentMode ? ` (${invoice.paymentMode})` : '')}`;
      doc.font(FONT).fontSize(8.5).fillColor(RED).text(payLbl, M, y, { width: colPay - M - 8 });
      doc.font(FONT_BOLD).fontSize(9.5).fillColor(RED).text(fmtMoney(paidSoFar), colPay, y, { width: 70, align: 'right' });
      y += 18;
    }

    // Debit balance.
    doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).strokeColor(INK).stroke();
    y += 10;
    doc.font(FONT_BOLD).fontSize(12).fillColor(INK).text('DEBIT BALANCE', M, y);
    doc.font(FONT_BOLD).fontSize(12).fillColor(INK)
      .text(`${NGN}${fmtMoney(Math.max(balance, 0))}`, colCost, y, { width: 140, align: 'right' });

    // Footer — link only (no business identity).
    doc.font(FONT).fontSize(6.5).fillColor('#a49d8e')
      .text('Secured with WhatsApp code · Live copy & PDF at the link shared with you', 0, doc.page.height - 30, { width: W, align: 'center' });

    doc.end();
  });
}

/** Send the invoice PDF to Telegram chat(s). Best-effort per recipient. */
async function deliver(bot, invoice, chatIds) {
  const pdf = await renderPdf(invoice);
  const caption = `🧾 ${invoice.invoiceNo} — ${invoice.customerName}\nTotal ${NGN}${fmtMoney(invoice.total)} · Paid ${NGN}${fmtMoney(invoice.amountPaidAtIssue)} · Balance ${NGN}${fmtMoney(Math.max(invoice.total - invoice.amountPaidAtIssue, 0))}\nForward this PDF to the customer on WhatsApp.`;
  const seen = new Set();
  for (const chatId of chatIds.filter(Boolean)) {
    if (seen.has(String(chatId))) continue;
    seen.add(String(chatId));
    try {
      await bot.sendDocument(chatId, pdf, { caption }, { filename: `${invoice.invoiceNo}.pdf`, contentType: 'application/pdf' });
    } catch (e) {
      logger.warn(`invoice deliver to ${chatId} failed: ${e.message}`);
    }
  }
}

module.exports = { createForSale, buildLines, mintInvoiceNo, renderPdf, deliver, bankFromPaymentMode };
