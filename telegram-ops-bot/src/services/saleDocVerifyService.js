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
 * VRF-1 accuracy (owner 23-Jul, precision over cost — the real 11-page
 * bill scored 0 confirmed / 8 differ / 3 missing / 3 extra, ALL false):
 *   - shades normalize through an alias table (BK→BLACK…) and, when the
 *     design's DesignAssets catalog maps shade numbers to names, a
 *     numeric COLOUR NO. on the bill matches the request's shade name;
 *     numeric-vs-name with NO catalog softens to a note, not a differ;
 *   - a design read as a strict prefix (≥4 leading digits, 4420 vs
 *     44200) of the other counts as matching WITH a note when the bale
 *     number anchored the match;
 *   - a leftover missing request bale and an extra bill label whose
 *     details agree and whose bale numbers are within edit distance 2
 *     are ONE physical bale misread — paired as differ-with-note, never
 *     double-counted as 1 missing + 1 extra.
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
const designAssetsRepository = require('../repositories/designAssetsRepository');

const SALE_ACTIONS = ['sell_than', 'sell_package', 'sale_bundle'];
const QTY_TOLERANCE = 0.15; // OCR + meters→yards rounding slack

function norm(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

/* ── VRF-1 accuracy helpers (owner 23-Jul: precision over cost) ── */

/**
 * Shade alias table — labels abbreviate COLOUR NO. ("BK", "WHT") while
 * requests store full names ("BLACK"). Keys/values are norm()-shaped
 * (A–Z0–9 only). Extend as new shorthand shows up on real bills.
 */
const SHADE_ALIASES = {
  BK: 'BLACK', BLK: 'BLACK',
  WH: 'WHITE', WHT: 'WHITE',
  GRAY: 'GREY', GRY: 'GREY', GY: 'GREY',
  NV: 'NAVY', NVY: 'NAVY',
  BRN: 'BROWN', GRN: 'GREEN', BLU: 'BLUE',
  RD: 'RED', YLW: 'YELLOW', PNK: 'PINK',
  CRM: 'CREAM', ORG: 'ORANGE', PRP: 'PURPLE', MRN: 'MAROON',
};
function normShade(s) { const n = norm(s); return SHADE_ALIASES[n] || n; }

/**
 * Compare a bill shade against a request shade.
 * @param {Array<{number:number,name:string}>} [catalogShades] the design's
 *        DesignAssets shade map (shade number → name), when one exists.
 * @returns {'ok'|'differs'|'unverifiable'}
 *        'ok' — same shade (exact, alias, or catalog number↔name);
 *        'differs' — provably different;
 *        'unverifiable' — numeric vs name with no catalog to translate
 *        (the bill writes COLOUR NO. "1" where the request says "BLACK").
 */
function compareShades(billShade, reqShade, catalogShades) {
  const b = normShade(billShade);
  const r = normShade(reqShade);
  if (!b || !r || b === r) return 'ok';
  const bNum = /^\d+$/.test(b);
  const rNum = /^\d+$/.test(r);
  if (bNum === rNum) return 'differs';
  const shadeNo = parseInt(bNum ? b : r, 10);
  const name = bNum ? r : b;
  const hits = (catalogShades || []).filter((s) => Number(s.number) === shadeNo);
  if (!hits.length) return 'unverifiable';
  return hits.some((s) => normShade(s.name) === name) ? 'ok' : 'differs';
}

/**
 * True when one normalized design is a STRICT prefix of the other with at
 * least 4 shared leading characters — a dropped trailing digit (4420 vs
 * 44200, the real bill's misread). Only ever applied when something else
 * anchors the row (a matching / near-matching bale number); never alone,
 * so 9060 vs 9060A stays distinct unless the number agrees too.
 */
function designPrefixMisread(a, b) {
  const A = norm(a);
  const B = norm(b);
  if (!A || !B || A === B) return false;
  const short = A.length < B.length ? A : B;
  const long = A.length < B.length ? B : A;
  return short.length >= 4 && long.startsWith(short);
}

/** Levenshtein distance (substitute/insert/delete) over two strings. */
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

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
 * @param {object} [opts]
 * @param {Map<string, Array<{number:number,name:string}>>} [opts.shadeCatalog]
 *        norm(design) → DesignAssets shade entries, for numeric↔name shades.
 * @returns {{results: Array<{item, status: 'ok'|'differs'|'missing', diffs?: string[], notes?: string[], label?}>, extras: object[]}}
 */
function compareItemsToLabels(items, labels, opts = {}) {
  const shadeCatalog = opts.shadeCatalog instanceof Map ? opts.shadeCatalog : new Map();
  const catalogFor = (design) => shadeCatalog.get(norm(design)) || [];
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
      // (9060-A vs 9060-B must stay distinct). Shade compatibility runs
      // through the normalizer so "BK" still rescues a "BLACK" item; an
      // unverifiable numeric-vs-name shade does NOT rescue (too loose for
      // a match with no anchoring number) — the pairing pass below covers
      // that case with the extra pcs/qty/edit-distance guards.
      const fused = norm(String(it.design ?? '') + String(it.shade ?? ''));
      idx = labels.findIndex((l, i) => !used.has(i) && norm(l.design)
        && ((norm(l.design) === norm(it.design)
          && (!norm(l.shade) || !norm(it.shade)
            || compareShades(l.shade, it.shade, catalogFor(it.design)) === 'ok'))
          || (fused && norm(l.design) === fused)));
      via = 'details';
    }
    if (idx === -1) { results.push({ item: it, status: 'missing' }); continue; }
    used.add(idx);
    const l = labels[idx];
    const diffs = [];
    const notes = [];
    const fusedOk = norm(l.design) === norm(String(it.design ?? '') + String(it.shade ?? ''));
    if (norm(l.design) && norm(it.design) && norm(l.design) !== norm(it.design) && !fusedOk) {
      if (via === 'number' && designPrefixMisread(l.design, it.design)) {
        // 4420 read where the request says 44200: the bale number matched,
        // so a strict ≥4-digit prefix is the same design with a dropped digit.
        notes.push(`design: bill reads "${l.design}" — leading digits match ${it.design}`);
      } else {
        diffs.push(`design: bill says ${l.design}, request says ${it.design}`);
      }
    }
    if (norm(l.shade) && norm(it.shade)) {
      const sc = compareShades(l.shade, it.shade, catalogFor(it.design || l.design));
      if (sc === 'differs') {
        diffs.push(`shade: bill says ${l.shade}, request says ${it.shade}`);
      } else if (sc === 'unverifiable') {
        notes.push(`shade: could not verify shade notation (bill says ${l.shade}, request says ${it.shade})`);
      }
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
    results.push({ item: it, status: diffs.length ? 'differs' : 'ok', diffs, notes, label: l });
  }

  // VRF-1 misread pairing: a leftover missing request bale and a leftover
  // bill label whose details agree (design, shade, pcs, qty) and whose
  // bale numbers are within edit distance 2 (digit substitutions/inserts)
  // are ONE physical bale with a misread number — the real bill's 604 was
  // read as 634 and double-counted as 1 missing + 1 extra. Paired rows
  // become differ-with-note; only truly unpairable rows stay ❌/➕.
  for (const r of results) {
    if (r.status !== 'missing') continue;
    const it = r.item;
    const itD = digits(it.packageNo);
    if (!itD) continue;
    const idx = labels.findIndex((l, i) => {
      if (used.has(i)) return false;
      const lD = digits(l.packageNo);
      if (!lD || editDistance(lD, itD) > 2) return false;
      const fusedOk = norm(l.design)
        && norm(l.design) === norm(String(it.design ?? '') + String(it.shade ?? ''));
      const designOk = norm(l.design) && norm(it.design)
        && (norm(l.design) === norm(it.design) || fusedOk
          || designPrefixMisread(l.design, it.design));
      if (!designOk) return false;
      if (!fusedOk && compareShades(l.shade, it.shade, catalogFor(it.design)) === 'differs') return false;
      if (Number(l.thanNo) && Number(it.thans) && Number(l.thanNo) !== Number(it.thans)) return false;
      const lYds = Number(l.yards) || 0;
      if (lYds && Number(it.yards)
          && Math.abs(lYds - it.yards) / Number(it.yards) > QTY_TOLERANCE) return false;
      return true;
    });
    if (idx === -1) continue;
    used.add(idx);
    const l = labels[idx];
    r.status = 'differs';
    r.label = l;
    r.diffs = [`bale no: bill reads "${l.packageNo}" — matched by details`];
    r.notes = [];
  }

  const extras = labels.filter((l, i) => !used.has(i) && (digits(l.packageNo) || norm(l.design)));
  return { results, extras };
}

/** Human verdict message. Long batches collapse the ✅ list to a count. */
function buildVerdictMessage(requestId, results, extras) {
  const ok = results.filter((r) => r.status === 'ok');
  const okPlain = ok.filter((r) => !(r.notes && r.notes.length));
  const okNoted = ok.filter((r) => r.notes && r.notes.length);
  const differs = results.filter((r) => r.status === 'differs');
  const missing = results.filter((r) => r.status === 'missing');
  const lines = [`🔬 Bill check — request ${requestId}`];
  if (results.length > 15 && okPlain.length) {
    lines.push(`✅ ${okPlain.length} item(s) confirmed on the bill`);
  } else {
    for (const r of okPlain) lines.push(`✅ Bale ${r.item.packageNo} — on the bill`);
  }
  // Confirmed-with-note rows always render individually — the note is the point.
  for (const r of okNoted) lines.push(`✅ Bale ${r.item.packageNo} — on the bill (⚠️ ${r.notes.join('; ')})`);
  for (const r of differs) lines.push(`⚠️ Bale ${r.item.packageNo} — ${r.diffs.concat(r.notes || []).join('; ')}`);
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
 * DesignAssets shade catalogs for the request's designs — lets the compare
 * translate a numeric COLOUR NO. on the bill ("1") into the request's
 * shade name ("BLACK") when the design's catalog maps that number.
 * Best-effort: a read failure just means numeric-vs-name shades soften
 * to a "could not verify shade notation" note instead of translating.
 */
async function loadShadeCatalog(items) {
  const catalog = new Map();
  const wanted = new Set(items.map((i) => norm(i.design)).filter(Boolean));
  if (!wanted.size) return catalog;
  let assets;
  try { assets = await designAssetsRepository.getAll(); } catch { return catalog; }
  for (const a of assets) {
    const k = norm(a.design);
    if (!k || !wanted.has(k) || !Array.isArray(a.shades) || !a.shades.length) continue;
    if (!catalog.has(k)) catalog.set(k, []);
    catalog.get(k).push(...a.shades);
  }
  return catalog;
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
    // VRF-1 accuracy (owner 23-Jul: precision over cost for verification):
    // verification bills are per-bale photo PDFs of rotated handwriting —
    // ALWAYS read them with the strong photo model + thinking, whatever
    // the page count. The fast model turned the owner's clean 11-page
    // bill into 0 confirmed / 8 differ / 3 missing / 3 extra.
    const ocr = await vision.extractBales(dl.buffer, mime, { forceStrongModel: true });

    const admins = (opts.adminIds && opts.adminIds.length ? opts.adminIds : config.access.adminIds);
    if (!ocr.ok || !Array.isArray(ocr.bales) || !ocr.bales.length) {
      const msg = `🔬 Bill check — request ${requestId}\n⚠️ Could not read the attached bill (${ocr.error || 'no labels recognised'}). Compare it manually before approving.`;
      for (const a of admins) { try { await bot.sendMessage(a, msg); } catch (_) { /* best-effort */ } }
      return true;
    }

    const items = await enrichItems(itemsFromActionJSON(aj));
    const shadeCatalog = await loadShadeCatalog(items);
    const { results, extras } = compareItemsToLabels(items, ocr.bales, { shadeCatalog });
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
  _internals: {
    compareItemsToLabels, itemsFromActionJSON, enrichItems, buildVerdictMessage, SALE_ACTIONS,
    compareShades, normShade, designPrefixMisread, editDistance, loadShadeCatalog,
  },
};
