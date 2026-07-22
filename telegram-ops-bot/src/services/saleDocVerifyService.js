/**
 * VRF-1 — bill-vs-request verification for approving admins (owner 22-Jul).
 *
 * When a sale request arrives with a sales bill attached (photo/PDF), the
 * bot OCRs the bill and compares what the PAPER says against what the
 * REQUEST claims, then sends the admins a per-item ✅/⚠️/❌ verdict as a
 * follow-up to the approval card. Advisory only — approve/reject stays
 * entirely human; a ⚠️/❌ means "open the attached bill and look".
 *
 * Owner cost rule: SNAP-sourced requests are skipped — their items were
 * POPULATED from this same document, so the one OCR read per sale was
 * already spent at intake. Both paths converge on one read, one check.
 *
 * Matching mirrors SNAP-6: bale number first (digits, suffix-tolerant),
 * then design+shade rescue (hyphen/space-insensitive) so an indent
 * misread never produces a false ❌; quantities compare with tolerance.
 *
 * Settings: PDF_VERIFY_ENABLED (default 1) switches the whole check off
 * without a deploy. The OCR read counts inside the daily OCR cap.
 */

'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const settingsRepository = require('../repositories/settingsRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const inventoryRepository = require('../repositories/inventoryRepository');

const SALE_ACTIONS = ['sell_than', 'sell_package', 'sale_bundle'];
const QTY_TOLERANCE = 0.15; // OCR + meters→yards rounding slack

function norm(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

/** Request items in a uniform shape, whatever the sale action stores. */
function itemsFromActionJSON(aj) {
  if (Array.isArray(aj.items) && aj.items.length) {
    return aj.items.map((i) => ({
      packageNo: String(i.packageNo ?? ''), design: String(i.design ?? ''),
      shade: String(i.shade ?? ''), thans: Number(i.thans) || 0, yards: Number(i.yards) || 0,
    }));
  }
  if (aj.packageNo) {
    return [{
      packageNo: String(aj.packageNo), design: String(aj.design ?? ''),
      shade: String(aj.shade ?? ''), thans: Number(aj.thans) || 0, yards: Number(aj.yards) || 0,
    }];
  }
  return [];
}

/**
 * Thin bundle items ({packageNo} only) get their identity from the live
 * Inventory sheet so the compare has design/shade/quantities to work with.
 * Best-effort — unknown bales stay thin and still compare by number.
 */
async function enrichItems(items) {
  if (!items.some((i) => !i.design)) return items;
  let inv = [];
  try { inv = await inventoryRepository.getAll(); } catch { return items; }
  const byPkg = new Map();
  for (const r of inv) {
    const k = digits(r.packageNo);
    if (!k) continue;
    if (!byPkg.has(k)) byPkg.set(k, { design: r.design, shade: r.shade, thans: 0, yards: 0 });
    const e = byPkg.get(k);
    if (r.status === 'available') { e.thans += 1; e.yards += Number(r.yards) || 0; }
  }
  return items.map((i) => {
    if (i.design) return i;
    const e = byPkg.get(digits(i.packageNo));
    return e ? { ...i, design: e.design || '', shade: e.shade || '', thans: i.thans || e.thans, yards: i.yards || e.yards } : i;
  });
}

/**
 * Pure compare: request items vs OCR'd bill labels.
 * @returns {{results: Array<{item, status: 'ok'|'differs'|'missing', diffs?: string[], label?}>, extras: object[]}}
 */
function compareItemsToLabels(items, labels) {
  const used = new Set();
  const results = [];
  for (const it of items) {
    const itD = digits(it.packageNo);
    let idx = labels.findIndex((l, i) => {
      if (used.has(i)) return false;
      const lD = digits(l.packageNo);
      return itD && lD && (lD === itD || lD.endsWith(itD) || itD.endsWith(lD));
    });
    let via = 'number';
    if (idx === -1) {
      // Bills sometimes fuse design and shade ("77014-3" for design 77014
      // shade 3) — accept that exact concatenation, never a loose prefix
      // (9060-A vs 9060-B must stay distinct).
      const fused = norm(String(it.design ?? '') + String(it.shade ?? ''));
      idx = labels.findIndex((l, i) => !used.has(i) && norm(l.design)
        && ((norm(l.design) === norm(it.design)
          && (!norm(l.shade) || !norm(it.shade) || norm(l.shade) === norm(it.shade)))
          || (fused && norm(l.design) === fused)));
      via = 'details';
    }
    if (idx === -1) { results.push({ item: it, status: 'missing' }); continue; }
    used.add(idx);
    const l = labels[idx];
    const diffs = [];
    const fusedOk = norm(l.design) === norm(String(it.design ?? '') + String(it.shade ?? ''));
    if (norm(l.design) && norm(it.design) && norm(l.design) !== norm(it.design) && !fusedOk) {
      diffs.push(`design: bill says ${l.design}, request says ${it.design}`);
    }
    if (norm(l.shade) && norm(it.shade) && norm(l.shade) !== norm(it.shade)) {
      diffs.push(`shade: bill says ${l.shade}, request says ${it.shade}`);
    }
    if (Number(l.thanNo) && Number(it.thans) && Number(l.thanNo) !== Number(it.thans)) {
      diffs.push(`pcs: bill says ${l.thanNo}, request says ${it.thans}`);
    }
    const lYds = Number(l.yards) || 0; // mapParsedBales already converts meters
    if (lYds && Number(it.yards)
        && Math.abs(lYds - it.yards) / Number(it.yards) > QTY_TOLERANCE) {
      diffs.push(`qty: bill ~${Math.round(lYds)} yds, request ${Math.round(it.yards)} yds`);
    }
    if (via === 'details') diffs.push(`bale no: bill reads "${l.packageNo || '?'}" — matched by details`);
    results.push({ item: it, status: diffs.length ? 'differs' : 'ok', diffs, label: l });
  }
  const extras = labels.filter((l, i) => !used.has(i) && (digits(l.packageNo) || norm(l.design)));
  return { results, extras };
}

/** Human verdict message. Long batches collapse the ✅ list to a count. */
function buildVerdictMessage(requestId, results, extras) {
  const ok = results.filter((r) => r.status === 'ok');
  const differs = results.filter((r) => r.status === 'differs');
  const missing = results.filter((r) => r.status === 'missing');
  const lines = [`🔬 Bill check — request ${requestId}`];
  if (results.length > 15 && ok.length) {
    lines.push(`✅ ${ok.length} item(s) confirmed on the bill`);
  } else {
    for (const r of ok) lines.push(`✅ Bale ${r.item.packageNo} — on the bill`);
  }
  for (const r of differs) lines.push(`⚠️ Bale ${r.item.packageNo} — ${r.diffs.join('; ')}`);
  for (const r of missing) lines.push(`❌ Bale ${r.item.packageNo} — NOT found on the bill`);
  for (const l of extras.slice(0, 8)) {
    lines.push(`➕ On the bill but NOT in the request: ${l.packageNo || '(no number)'}${l.design ? ` (${l.design}${l.shade ? ` ${l.shade}` : ''})` : ''}`);
  }
  if (extras.length > 8) lines.push(`➕ …and ${extras.length - 8} more extra label(s)`);
  lines.push('');
  lines.push(`Verdict: ${ok.length} confirmed · ${differs.length} differ · ${missing.length} missing · ${extras.length} extra`);
  if (differs.length || missing.length || extras.length) {
    lines.push('⚠️ Open the attached bill and compare before approving.');
  } else {
    lines.push('The bill and the request agree.');
  }
  return lines.join('\n');
}

/**
 * Verify one queued request's attached sale document, if applicable.
 * Fire-and-forget safe: never throws; returns true when a verdict was sent.
 */
async function maybeVerify(bot, requestId, opts = {}) {
  try {
    const row = await approvalQueueRepository.getByRequestId(requestId);
    if (!row || !row.actionJSON) return false;
    const aj = row.actionJSON;
    if (!SALE_ACTIONS.includes(aj.action)) return false;
    if (!aj.sale_doc_file_id) return false;
    // Owner cost rule: snap items came FROM this document — already read once.
    if (/^snap/i.test(String(aj.source || ''))) return false;
    let settings = {};
    try { settings = await settingsRepository.getAll(); } catch { settings = {}; }
    if (Number(settings.PDF_VERIFY_ENABLED ?? 1) !== 1) return false;

    const { downloadTelegramFile } = require('../utils/telegramFiles');
    const vision = require('./vision');
    const dl = await downloadTelegramFile(bot, aj.sale_doc_file_id);
    const mime = aj.sale_doc_type === 'document' ? 'application/pdf' : (dl.mimeType || 'image/jpeg');
    const ocr = await vision.extractBales(dl.buffer, mime);

    const admins = (opts.adminIds && opts.adminIds.length ? opts.adminIds : config.access.adminIds);
    if (!ocr.ok || !Array.isArray(ocr.bales) || !ocr.bales.length) {
      const msg = `🔬 Bill check — request ${requestId}\n⚠️ Could not read the attached bill (${ocr.error || 'no labels recognised'}). Compare it manually before approving.`;
      for (const a of admins) { try { await bot.sendMessage(a, msg); } catch (_) { /* best-effort */ } }
      return true;
    }

    const items = await enrichItems(itemsFromActionJSON(aj));
    const { results, extras } = compareItemsToLabels(items, ocr.bales);
    const msg = buildVerdictMessage(requestId, results, extras);
    // Persist the verdict on the queue row so pending views can surface it.
    try {
      await approvalQueueRepository.updateActionJSON(requestId, {
        docVerify: {
          ok: results.filter((r) => r.status === 'ok').length,
          differs: results.filter((r) => r.status === 'differs').length,
          missing: results.filter((r) => r.status === 'missing').length,
          extra: extras.length,
          at: new Date().toISOString(),
        },
      });
    } catch (e) { logger.warn(`saleDocVerify persist ${requestId}: ${e.message}`); }
    for (const a of admins) { try { await bot.sendMessage(a, msg); } catch (_) { /* best-effort */ } }
    return true;
  } catch (e) {
    logger.warn(`saleDocVerify ${requestId}: ${e.message}`);
    return false;
  }
}

module.exports = {
  maybeVerify,
  _internals: { compareItemsToLabels, itemsFromActionJSON, enrichItems, buildVerdictMessage, SALE_ACTIONS },
};
