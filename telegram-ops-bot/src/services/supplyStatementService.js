'use strict';

/**
 * SLED-1 — Customer Supply Statement (owner-confirmed 31-Jul-2026).
 *
 * A handover document listing WHAT was supplied to one customer —
 * chronological lines of date / design / shades / bales / thans / yards —
 * with the Rate-per-yd and Amount columns printed as BLANK RULED LINES on
 * purpose (owner decision: money is filled by hand or kept off-record;
 * the bot never prints prices here). Totals cover quantities only.
 *
 * Data source: sold Inventory rows, matched to the customer through
 * customerEntity.namesFor (alias-aware, so merged spellings consolidate).
 * The statement is NET AS OF TODAY: goods returned to stock have flipped
 * back to available and no longer appear.
 */

const path = require('path');
const PDFDocument = require('pdfkit');

const FONT = path.join(__dirname, '../assets/fonts/DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '../assets/fonts/DejaVuSans-Bold.ttf');

const INK = '#20242a';
const GOLD = '#c9a24b';
const MUTED = '#8a8578';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso || '—');
  return `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1].slice(2)}`;
}

function fmtQty(n) {
  return Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 1 });
}

/**
 * Pure: sold rows → chronological statement lines + quantity totals.
 * @param {Array<object>} soldRows Inventory rows (status sold).
 * @param {string[]} names Every spelling of the customer (namesFor).
 * @param {{fromDate?: string}} [opts] ISO lower bound on soldDate.
 * @returns {{lines: Array<object>, totals: {bales:number,thans:number,yards:number}}}
 */
function buildStatement(soldRows, names, opts = {}) {
  const nameSet = new Set(names.map((n) => String(n).trim().toLowerCase()).filter(Boolean));
  const from = String(opts.fromDate || '');
  const byKey = new Map();
  for (const r of soldRows) {
    if (r.status !== 'sold') continue;
    if (!nameSet.has(String(r.soldTo || '').trim().toLowerCase())) continue;
    const day = String(r.soldDate || '').slice(0, 10);
    if (from && day && day < from) continue;
    const key = `${day}|${String(r.design || '').toUpperCase()}`;
    if (!byKey.has(key)) {
      byKey.set(key, { date: day, design: String(r.design || ''), shades: new Set(), bales: new Set(), thans: 0, yards: 0 });
    }
    const g = byKey.get(key);
    if (r.shade !== undefined && String(r.shade) !== '') g.shades.add(String(r.shade));
    g.bales.add(String(r.packageNo).trim() || r.baleUid);
    g.thans += 1;
    g.yards += r.yards || 0;
  }
  const lines = [...byKey.values()]
    .map((g) => ({
      date: g.date, design: g.design,
      shades: [...g.shades].sort((a, b) => Number(a) - Number(b)).join(', '),
      bales: g.bales.size, thans: g.thans, yards: g.yards,
    }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.design.localeCompare(b.design));
  const totals = lines.reduce((t, l) => ({
    bales: t.bales + l.bales, thans: t.thans + l.thans, yards: t.yards + l.yards,
  }), { bales: 0, thans: 0, yards: 0 });
  return { lines, totals };
}

/** Render the statement PDF (A4 portrait) → Buffer. */
function renderPdf({ customerName, periodLabel, lines, totals }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Supply Statement — ${customerName}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;
    const M = 40;
    // Column x-positions (Date, Design, Shades, Bales, Thans, Yards, Rate, Amount).
    const COLS = [M, M + 68, M + 140, M + 250, M + 295, M + 340, M + 400, M + 460];
    const RIGHT = W - M;

    function pageHeader() {
      doc.rect(0, 0, W, 86).fill(INK);
      doc.font(FONT_BOLD).fontSize(16).fillColor('#ffffff')
        .text(`${String(customerName || '').toUpperCase()} `, M, 22, { continued: true })
        .fillColor(GOLD).text('— SUPPLY STATEMENT');
      doc.font(FONT).fontSize(8).fillColor('#cfcfcf')
        .text(`Period: ${periodLabel}    ·    Statement date: ${fmtDate(new Date().toISOString().slice(0, 10))}    ·    Quantities net as of today (returned goods excluded)`, M, 52);
      let y0 = 108;
      doc.font(FONT).fontSize(7).fillColor(MUTED);
      ['DATE', 'DESIGN', 'SHADES', 'BALES', 'THANS', 'YARDS', 'RATE/YD', 'AMOUNT'].forEach((h, i) => {
        const align = i >= 3 ? { width: (COLS[i + 1] || RIGHT) - COLS[i] - 8, align: 'right' } : {};
        doc.text(h, COLS[i], y0, align);
      });
      y0 += 11;
      doc.moveTo(M, y0).lineTo(RIGHT, y0).lineWidth(1.2).strokeColor(INK).stroke();
      return y0 + 8;
    }

    let y = pageHeader();

    function ruledBlank(x, width, rowY) {
      doc.moveTo(x + 6, rowY + 8).lineTo(x + width - 4, rowY + 8).lineWidth(0.7).strokeColor('#b9b2a2').stroke();
    }

    if (!lines.length) {
      doc.font(FONT).fontSize(10).fillColor(MUTED).text('No supplies recorded in this period.', M, y + 10);
    }
    for (const l of lines) {
      if (y > doc.page.height - 110) {
        doc.addPage();
        y = pageHeader();
      }
      doc.font(FONT).fontSize(8.6).fillColor(INK);
      doc.text(fmtDate(l.date), COLS[0], y);
      doc.font(FONT_BOLD).text(l.design || '—', COLS[1], y, { width: COLS[2] - COLS[1] - 6 });
      doc.font(FONT).text(l.shades || '—', COLS[2], y, { width: COLS[3] - COLS[2] - 8 });
      doc.text(String(l.bales), COLS[3], y, { width: COLS[4] - COLS[3] - 8, align: 'right' });
      doc.text(String(l.thans), COLS[4], y, { width: COLS[5] - COLS[4] - 8, align: 'right' });
      doc.text(fmtQty(l.yards), COLS[5], y, { width: COLS[6] - COLS[5] - 8, align: 'right' });
      // Owner decision: money columns stay BLANK ruled lines.
      ruledBlank(COLS[6], COLS[7] - COLS[6], y);
      ruledBlank(COLS[7], RIGHT - COLS[7], y);
      y += 17;
    }

    // Totals (quantities only — deliberately no money total).
    y += 4;
    doc.moveTo(M, y).lineTo(RIGHT, y).lineWidth(1.2).strokeColor(INK).stroke();
    y += 8;
    doc.font(FONT_BOLD).fontSize(9.5).fillColor(INK).text('TOTAL', COLS[0], y);
    doc.text(String(totals.bales), COLS[3], y, { width: COLS[4] - COLS[3] - 8, align: 'right' });
    doc.text(String(totals.thans), COLS[4], y, { width: COLS[5] - COLS[4] - 8, align: 'right' });
    doc.text(fmtQty(totals.yards), COLS[5], y, { width: COLS[6] - COLS[5] - 8, align: 'right' });
    doc.font(FONT).fontSize(7).fillColor(MUTED)
      .text('(money columns left blank on purpose)', COLS[6], y + 1, { width: RIGHT - COLS[6], align: 'right' });

    // Signature block.
    y += 46;
    const half = (RIGHT - M) / 2;
    doc.moveTo(M, y).lineTo(M + half - 30, y).lineWidth(0.8).strokeColor(INK).stroke();
    doc.moveTo(M + half + 30, y).lineTo(RIGHT, y).lineWidth(0.8).strokeColor(INK).stroke();
    doc.font(FONT).fontSize(8).fillColor(MUTED);
    doc.text('Received & agreed (customer)', M, y + 4);
    doc.text('For AtFactoryPrice', M + half + 30, y + 4);

    doc.end();
  });
}

module.exports = { buildStatement, renderPdf, _internals: { fmtDate, fmtQty } };
