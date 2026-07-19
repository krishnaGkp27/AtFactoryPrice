/**
 * INV-1b — public invoice web view (token test mode).
 *
 * Routes (mounted in server.js):
 *   GET /i/:token       HTML statement view of one invoice
 *   GET /i/:token.pdf   the same invoice as a downloadable PDF
 *
 * Access model (owner-locked INV-1 decisions):
 *   - The token is the capability: a long random string minted per invoice
 *     and shared only with that customer. Wrong/unknown token → plain 404
 *     with no hints. WhatsApp-OTP login hardens this in the next phase
 *     (blocked on Meta onboarding); until then this is the agreed
 *     "token-only test mode".
 *   - NO business name/registration anywhere (owner rule) — the page is a
 *     customer-account statement, same as the PDF.
 *
 * The HTML mirrors the statement PDF: dark account header, line items,
 *   payments in red with the receiving account, DEBIT BALANCE footer.
 * Rendering is a self-contained string template — no template engine, no
 * external assets, so the page works from any phone browser instantly.
 */

'use strict';

const invoicesRepository = require('../repositories/invoicesRepository');
const invoiceService = require('../services/invoiceService');
const logger = require('../utils/logger');

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtMoney(n) {
  return `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

function fmtDate(iso) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return esc(iso || '—');
  return `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}`;
}

function renderHtml(inv) {
  const paid = inv.amountPaidAtIssue || 0;
  const balance = inv.total - paid;
  const status = balance <= 0 ? 'PAID' : (paid > 0 ? 'PART-PAID' : 'UNPAID');
  const statusColor = balance <= 0 ? '#1e7d32' : (paid > 0 ? '#b26a00' : '#b3261e');
  const lineRows = (inv.lines || []).map((l) => {
    const descBits = [l.design ? `Design ${l.design}` : 'Goods'];
    if (l.shades && l.shades.length) descBits.push(`Shade${l.shades.length > 1 ? 's' : ''} ${l.shades.join(', ')}`);
    if (l.qty) descBits.push(`${l.qty} bale${l.qty > 1 ? 's' : ''}`);
    return `
      <tr>
        <td>${esc(descBits.join(' · '))}</td>
        <td class="num">${l.yards ? `${esc(l.yards)} yds` : ''}</td>
        <td class="num">${l.rate ? `${fmtMoney(l.rate)}/yd` : ''}</td>
        <td class="num">${fmtMoney(l.amount || 0)}</td>
      </tr>`;
  }).join('');
  const paymentRow = paid > 0 ? `
      <tr class="payment">
        <td>Payment received${inv.bank ? ` — ${esc(inv.bank)}` : ''}${inv.paymentMode ? ` (${esc(inv.paymentMode)})` : ''}</td>
        <td class="num"></td><td class="num"></td>
        <td class="num">− ${fmtMoney(paid)}</td>
      </tr>` : '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(inv.invoiceNo)}</title>
<style>
  :root { --ink:#171717; --gold:#c9a227; --red:#b3261e; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; background:#f2f2f0; color:#222; }
  .sheet { max-width: 560px; margin: 0 auto; background:#fff; min-height: 100vh; }
  header { background: var(--ink); color:#fff; padding: 26px 24px 20px; }
  header h1 { font-size: 19px; letter-spacing: .4px; }
  header h1 span { color: var(--gold); font-weight: 600; }
  .meta { margin-top: 10px; font-size: 12.5px; color:#cfcfcf; display:flex; gap:18px; flex-wrap:wrap; }
  .meta b { color:#fff; font-weight:600; }
  .status { display:inline-block; margin-top:12px; padding:3px 12px; border-radius: 3px; font-size:12px; font-weight:700; letter-spacing:1px; background:#fff; }
  main { padding: 18px 24px 28px; }
  table { width:100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align:left; font-size:11px; letter-spacing:.8px; text-transform:uppercase; color:#888; border-bottom: 2px solid var(--ink); padding: 8px 6px; }
  td { padding: 9px 6px; border-bottom: 1px solid #e8e8e6; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  th.num { text-align: right; }
  tr.payment td { color: var(--red); font-weight: 600; }
  .totals { margin-top: 14px; margin-left:auto; width: 100%; max-width: 300px; font-size: 14px; }
  .totals .row { display:flex; justify-content: space-between; padding: 5px 6px; }
  .totals .grand { border-top: 2px solid var(--ink); margin-top: 4px; padding-top: 9px; font-weight: 700; font-size: 15.5px; }
  .grand .label { letter-spacing: .5px; }
  .debit { color: var(--red); }
  footer { padding: 0 24px 30px; }
  .btn { display:block; text-align:center; background: var(--ink); color:#fff; text-decoration:none; padding: 13px; border-radius: 6px; font-size: 14.5px; font-weight: 600; }
  .note { margin-top: 14px; font-size: 11.5px; color:#999; text-align:center; }
</style></head>
<body><div class="sheet">
  <header>
    <h1>${esc((inv.customerName || '').toUpperCase())} <span>— ACCOUNT</span></h1>
    <div class="meta">
      <span>Invoice <b>${esc(inv.invoiceNo)}</b></span>
      <span>Date <b>${fmtDate(inv.saleDate || inv.issueDate)}</b></span>
      ${inv.salesperson ? `<span>Salesperson <b>${esc(inv.salesperson)}</b></span>` : ''}
    </div>
    <span class="status" style="color:${statusColor}">${status}</span>
  </header>
  <main>
    <table>
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Cost</th></tr></thead>
      <tbody>${lineRows}${paymentRow}</tbody>
    </table>
    <div class="totals">
      <div class="row"><span>Total cost</span><span>${fmtMoney(inv.total)}</span></div>
      <div class="row" style="color:var(--red)"><span>Payments</span><span>− ${fmtMoney(paid)}</span></div>
      <div class="row grand ${balance > 0 ? 'debit' : ''}">
        <span class="label">${balance > 0 ? 'DEBIT BALANCE' : 'BALANCE'}</span>
        <span>${fmtMoney(Math.max(balance, 0))}</span>
      </div>
    </div>
  </main>
  <footer>
    <a class="btn" href="/i/${esc(inv.token)}.pdf">⬇ Download PDF copy</a>
    <p class="note">This is a private statement link — do not forward it.</p>
  </footer>
</div></body></html>`;
}

async function resolveToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!TOKEN_RE.test(token)) return null;
  try {
    return await invoicesRepository.getByToken(token);
  } catch (e) {
    logger.warn(`invoiceWeb: lookup failed: ${e.message}`);
    return null;
  }
}

async function viewInvoice(req, res) {
  const inv = await resolveToken(req.params.token);
  if (!inv) return res.status(404).type('text/plain').send('Not found');
  res.type('html').send(renderHtml(inv));
}

async function viewInvoicePdf(req, res) {
  const inv = await resolveToken(req.params.token);
  if (!inv) return res.status(404).type('text/plain').send('Not found');
  try {
    const pdf = await invoiceService.renderPdf(inv);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${inv.invoiceNo}.pdf"`);
    res.send(pdf);
  } catch (e) {
    logger.error(`invoiceWeb: pdf render failed for ${inv.invoiceNo}: ${e.message}`);
    res.status(500).type('text/plain').send('Could not render the PDF — try again shortly.');
  }
}

module.exports = { viewInvoice, viewInvoicePdf, _internals: { renderHtml, TOKEN_RE } };
