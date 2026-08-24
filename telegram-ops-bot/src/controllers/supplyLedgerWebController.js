'use strict';

/**
 * supplyLedgerWebController — SLG-1 web face (owner's hand-drawn format,
 * "like excel sheet", black background, white text).
 *
 * Access model: the signed token IS the capability (shareLinkService's
 * signer, `k:'SL'` payload — a design-share token can never open a ledger).
 * Anything invalid is a plain 404 with no hints; docs are proxied through
 * the bot so no Telegram file URL or bot token ever reaches the visitor.
 *
 * Option B (owner, 07-Aug-2026): DEBIT / CREDIT / BALANCE columns render
 * EMPTY — reserved for the finance portal — and every entry is followed by
 * a blank reserved row where an in-between payment will sit. Goods only;
 * not one naira on the page.
 */

const supplyLedgerService = require('../services/supplyLedgerService');
const fmtDate = require('../utils/formatDate');
const logger = require('../utils/logger');

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d0d0f; color: #f2f2f2; font: 15px/1.5 'Segoe UI', Arial, sans-serif; padding: 24px 12px; }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 22px; letter-spacing: 2px; margin-bottom: 2px; }
  h1 .accent { color: #d4af5f; }
  .sub { color: #9a9a9a; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 18px; }
  table { width: 100%; border-collapse: collapse; background: #121215; }
  th { background: #1c1c22; color: #d4af5f; text-transform: uppercase; font-size: 11px; letter-spacing: 1.5px; padding: 10px 8px; border: 1px solid #2c2c33; text-align: left; }
  td { padding: 9px 8px; border: 1px solid #26262d; vertical-align: top; }
  tr.reserved td { height: 30px; background: #0f0f12; }
  td.money { color: #55555f; text-align: center; width: 90px; }
  a.pt { color: #7fb8ff; text-decoration: none; border-bottom: 1px dotted #7fb8ff55; }
  .detail { display: none; }
  .detail.open { display: table-row; }
  .detail td { background: #17171c; padding: 12px 14px; }
  .design { color: #d4af5f; font-weight: 600; margin: 6px 0 2px; }
  .shade { margin-left: 12px; color: #cfcfcf; }
  .nums { color: #8fd18f; }
  .docs img { max-width: 320px; border: 1px solid #2c2c33; border-radius: 4px; margin: 8px 8px 0 0; display: inline-block; }
  .docs a { color: #7fb8ff; }
  .net { margin-top: 16px; font-size: 16px; }
  .net b { color: #d4af5f; }
  .foot { margin-top: 26px; color: #6a6a72; font-size: 11px; }
`;

const JS = `
  function tg(id){ var r=document.getElementById(id); if(r) r.classList.toggle('open'); return false; }
`;

/**
 * Sale-doc counts per day for one customer — ONE ApprovalQueue read for the
 * whole page, matched against every spelling the customer files under.
 */
async function docCountsByDay(customer, days) {
  const out = new Map(days.map((d) => [d, 0]));
  try {
    const supplyLedger = require('../services/supplyLedgerService');
    const approvalQueueRepository = require('../repositories/approvalQueueRepository');
    const { normDay } = require('../utils/dates');
    const wants = new Set(await supplyLedger.namesFor(customer));
    const want = new Set(days);
    const seen = new Set();
    for (const r of await approvalQueueRepository.getResolved()) {
      if (String(r.status || '').toLowerCase() !== 'approved') continue;
      const aj = r.actionJSON || {};
      if (!aj.sale_doc_file_id || seen.has(aj.sale_doc_file_id)) continue;
      if (!wants.has(String(aj.customer || '').trim().toLowerCase())) continue;
      const d = normDay(aj.salesDate);
      if (!want.has(d)) continue;
      seen.add(aj.sale_doc_file_id);
      out.set(d, (out.get(d) || 0) + 1);
    }
  } catch (_) { /* no doc chips rather than no page */ }
  return out;
}

/** The docs for ONE day, alias-aware — the proxy's own lookup. */
async function docsForDay(customer, day) {
  const supplyLedger = require('../services/supplyLedgerService');
  const approvalQueueRepository = require('../repositories/approvalQueueRepository');
  const { normDay } = require('../utils/dates');
  const wants = new Set(await supplyLedger.namesFor(customer));
  const seen = new Set();
  const docs = [];
  for (const r of await approvalQueueRepository.getResolved()) {
    if (String(r.status || '').toLowerCase() !== 'approved') continue;
    const aj = r.actionJSON || {};
    if (!aj.sale_doc_file_id || seen.has(aj.sale_doc_file_id)) continue;
    if (!wants.has(String(aj.customer || '').trim().toLowerCase())) continue;
    if (normDay(aj.salesDate) !== String(day)) continue;
    seen.add(aj.sale_doc_file_id);
    docs.push({ fileId: aj.sale_doc_file_id, kind: aj.action === 'sale_bundle' ? 'document' : 'photo' });
  }
  return docs;
}

/** GET /sl/:token — the ledger page. */
async function viewPage(req, res) {
  const p = supplyLedgerService.verifyLedgerToken(req.params.token);
  if (!p) return res.status(404).send('Not found');
  try {
    const customer = p.customerName;
    // SUP-2 — this page is name-keyed exactly like /api/ext/supply, and a
    // ledger token carries only the NAME. Two live customers sharing a
    // display name would render BOTH their days, bale numbers and sale
    // documents to whoever holds the link. Same refusal as every other
    // door: uniqueness unverified is never a reason to serve.
    const refusal = await require('../services/extLedgerService').accessRefusalFor(customer);
    if (refusal) return res.status(refusal.status).send(esc(refusal.error));
    const { entries, net } = await supplyLedgerService.buildLedger(customer);
    const supplyDays = entries.filter((e) => e.kind === 'supply').map((e) => e.day);
    const details = new Map();
    for (const day of supplyDays) {
      details.set(day, await supplyLedgerService.dayDetail(customer, day));
    }
    // One read for the whole page. docsFor() re-reads the ApprovalQueue
    // sheet on EVERY call and has no cache, so the first cut cost one
    // uncached full-sheet read per supply day — a long-standing customer's
    // page alone could exhaust the project's Sheets quota and stall the bot
    // for everyone (adversarial review, 07-Aug-2026). And it matched the
    // token's single spelling while the ledger resolves aliases, so an
    // alias-spelled sale showed goods but no documents.
    const docCounts = await docCountsByDay(customer, supplyDays);

    let rows = '';
    entries.forEach((e, i) => {
      const rid = `d${i}`;
      const particular = e.kind === 'supply'
        ? `<a class="pt" href="#" onclick="return tg('${rid}')">${esc(e.label)}</a>`
        : `↩ ${esc(e.label)}`;
      rows += `<tr><td>${esc(fmtDate.short(e.day))}</td><td>${particular}</td>`
        + '<td class="money"></td><td class="money"></td><td class="money"></td></tr>\n';
      if (e.kind === 'supply') {
        const det = details.get(e.day) || [];
        let inner = '';
        for (const d of det) {
          inner += `<div class="design">${esc(d.design)}${d.category ? ` · ${esc(d.category)}` : ''}</div>`;
          for (const sh of d.shades) {
            inner += `<div class="shade">Shade ${esc(sh.shade)} ×${sh.bales.length}B `
              + `<span class="nums">(${esc(sh.bales.join(', '))})</span> — ${sh.thans} thans</div>`;
          }
        }
        const n = docCounts.get(e.day) || 0;
        if (n) {
          inner += '<div class="docs">';
          for (let k = 0; k < n; k += 1) {
            // ABSOLUTE — a relative href resolves against /sl/ and drops the
            // token, so every document 404'd while onerror disguised it as a
            // PDF placeholder.
            const href = `/sl/${encodeURIComponent(req.params.token)}/doc/${encodeURIComponent(e.day)}/${k}`;
            inner += `<a href="${href}" target="_blank">`
              + `<img src="${href}" alt="Sale doc ${k + 1}" `
              + `onerror="this.outerHTML='📄 Sale doc ${k + 1} (PDF)'"></a>`;
          }
          inner += '</div>';
        }
        rows += `<tr class="detail" id="${rid}"><td colspan="5">${inner || '—'}</td></tr>\n`;
      }
      // Option B — the reserved blank row for an in-between payment.
      rows += '<tr class="reserved"><td></td><td></td><td class="money"></td><td class="money"></td><td class="money"></td></tr>\n';
    });

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Supply Ledger</title><style>${CSS}</style><script>${JS}</script></head><body>
<div class="wrap">
  <h1>SUPPLY LEDGER <span class="accent">— ${esc(customer).toUpperCase()}</span></h1>
  <div class="sub">Goods record · quantities only</div>
  <table>
    <tr><th>Date</th><th>Particular</th><th>Debit</th><th>Credit</th><th>Balance</th></tr>
    ${rows}
  </table>
  <div class="net">Net with customer: <b>${net.thans} than${net.thans === 1 ? '' : 's'}</b>
    <span style="color:#8a8a92;font-size:13px">· ${net.bales} bale${net.bales === 1 ? '' : 's'} currently held</span></div>
  <div class="foot">Debit · Credit · Balance are maintained by the finance portal. Tap a particular for the goods detail and documents.</div>
</div></body></html>`);
  } catch (e) {
    logger.warn(`supplyLedgerWeb: render failed: ${e.message}`);
    res.status(500).send('Something went wrong.');
  }
}

/** GET /sl/:token/doc/:day/:i — proxy one sale doc through the bot. */
async function viewDoc(req, res, bot) {
  const p = supplyLedgerService.verifyLedgerToken(req.params.token);
  if (!p) return res.status(404).send('Not found');
  try {
    // SUP-2 — the document proxy is the same door by another name; guard it
    // too, or the page refuses while its attachments still stream.
    const refusal = await require('../services/extLedgerService').accessRefusalFor(p.customerName);
    if (refusal) return res.status(refusal.status).send('Not found');
    const docs = await docsForDay(p.customerName, String(req.params.day));
    const idx = parseInt(req.params.i, 10);
    const d = Number.isInteger(idx) && idx >= 0 ? docs[idx] : null;
    if (!d || !d.fileId || !bot) return res.status(404).send('Not found');
    const telegramFiles = require('../utils/telegramFiles');
    const dl = await telegramFiles.downloadTelegramFile(bot, d.fileId);
    res.set('Content-Type', dl.mimeType || (d.kind === 'document' ? 'application/pdf' : 'image/jpeg'));
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(dl.buffer);
  } catch (e) {
    logger.warn(`supplyLedgerWeb: doc proxy failed: ${e.message}`);
    res.status(404).send('Not found');
  }
}

module.exports = { viewPage, viewDoc, _internals: { docCountsByDay, docsForDay } };
