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
const locationService = require('./locationService');

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

/**
 * Is this line a LOOSE THAN rather than a whole bale?
 *
 * VRF-3 — the distinction decides whether a bill can be machine-read at
 * all, so it is drawn the same way the sales inbox chips draw it
 * (approvalsInboxFlow.saleGoods): an explicit `type`, else the presence
 * of a than number on the line.
 */
function itemIsThan(i) {
  if (!i) return false;
  if (i.type) return String(i.type).toLowerCase() === 'than';
  return i.thanNo !== undefined && i.thanNo !== null && String(i.thanNo).trim() !== '';
}

/**
 * VRF-3 — does this request sell any bale ENTIRELY, even though its lines
 * are written as thans?
 *
 * The bundle-sale door offers "📦 Take whole bale", and
 * `bundleSaleService.buildApprovalPayload` writes every cart line as
 * `type: 'than'` regardless — so a complete bale reaches the queue looking
 * exactly like ten loose pieces. Judging on the line shape alone would
 * skip the check on the very case the owner carved out ("unless you find
 * that there is a complete bale sold in the approval card").
 *
 * So the lines are counted against the bale's real size in Inventory: a
 * bale whose every than is in this request is being sold whole.
 *
 * @returns {Promise<Set<string>>} digits of the bales sold complete
 */
async function completeBalesAmongThans(thanItems) {
  const wanted = new Map(); // bale digits → thans in THIS request
  for (const it of thanItems) {
    const k = digits(it.packageNo);
    if (!k) continue;
    wanted.set(k, (wanted.get(k) || 0) + 1);
  }
  if (!wanted.size) return new Set();
  let inv;
  try {
    inv = await inventoryRepository.getAll();
  } catch (e) {
    // Cannot tell — fall back to the shape, which is the owner's own
    // description of the problem case ("the sale which is made in thans").
    // A rare Inventory outage must not resurrect the noise he asked us to
    // remove; the bill still rides the card for his own eyes.
    logger.warn(`saleDocVerify: Inventory read failed, judging goods by shape alone: ${e.message}`);
    return new Set();
  }
  const size = new Map(); // bale digits → how many thans the bale has
  for (const r of inv || []) {
    const k = digits(r.packageNo);
    if (!k || !wanted.has(k)) continue;
    size.set(k, (size.get(k) || 0) + 1);
  }
  const complete = new Set();
  for (const [k, n] of wanted) {
    const total = size.get(k) || 0;
    if (total && n >= total) complete.add(k);
  }
  return complete;
}

/**
 * Request items in a uniform shape, whatever the sale action stores.
 * Each carries `isThan` so VRF-3 can tell goods a bill can name from
 * goods it cannot.
 */
function itemsFromActionJSON(aj) {
  if (Array.isArray(aj.items) && aj.items.length) {
    return aj.items.map((i) => ({
      packageNo: String(i.packageNo ?? ''), design: String(i.design ?? ''),
      shade: String(i.shade ?? ''), thans: Number(i.thans) || 0, yards: Number(i.yards) || 0,
      isThan: itemIsThan(i),
    }));
  }
  if (aj.packageNo) {
    // sell_than / sell_package carry their one line inline on the request.
    return [{
      packageNo: String(aj.packageNo), design: String(aj.design ?? ''),
      shade: String(aj.shade ?? ''), thans: Number(aj.thans) || 0, yards: Number(aj.yards) || 0,
      isThan: itemIsThan(aj),
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
    // VRF-1b (owner complaint 29-Jul: verdicts "still don't match") — the
    // PARTIAL-SALE false-mismatch class. The bill photo shows the bale
    // LABEL, which always carries the bale's FULL piece count and yardage;
    // the request sells what is being sold — which is less whenever thans
    // were sold before, or only part of the bale goes out. "pcs: bill says
    // 4, request says 2" flagged every partial sale as a mismatch when the
    // paper and the request agreed perfectly. Selling LESS than the label
    // is consistent (noted, not flagged); only a bill showing FEWER pieces
    // or fewer yards than the request claims is a real discrepancy.
    let partialPcs = false;
    if (Number(l.thanNo) && Number(it.thans) && Number(l.thanNo) !== Number(it.thans)) {
      if (Number(l.thanNo) > Number(it.thans)) {
        partialPcs = true;
        notes.push(`partial: selling ${it.thans} of the ${l.thanNo} pcs on the label`);
      } else {
        diffs.push(`pcs: bill says ${l.thanNo}, request says ${it.thans}`);
      }
    }
    const lYds = Number(l.yards) || 0; // mapParsedBales already converts meters
    if (lYds && Number(it.yards)
        && Math.abs(lYds - it.yards) / Number(it.yards) > QTY_TOLERANCE) {
      const sellingLess = it.yards < lYds && (partialPcs || !Number(l.thanNo) || !Number(it.thans));
      if (!sellingLess) {
        diffs.push(`qty: bill ~${Math.round(lYds)} yds, request ${Math.round(it.yards)} yds`);
      }
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

/**
 * VRF-3 — drop the bill rows that belong to goods this run is NOT
 * comparing (the loose thans of a mixed sale).
 *
 * Done BEFORE the compare, not after it, because such a row is not merely
 * an unwanted "extra": left in the pool it stays claimable, and the
 * misread-pairing pass can hand it to a bale that is genuinely absent
 * from the bill, turning a hard miss into a soft "matched by details".
 * Suppressing it at the end would hide the false alarm while leaving that
 * rescue in place.
 *
 * Numbers match the same suffix-tolerant way the primary matcher does
 * ("P896" on the bill IS bale 896); exact equality here would let a
 * prefixed row slip through and be reported anyway.
 */
function dropLabelsFor(labels, packageNos) {
  const keys = [...(packageNos || [])].map(digits).filter(Boolean);
  if (!keys.length) return labels;
  return labels.filter((l) => {
    const lD = digits(l.packageNo);
    if (!lD) return true;
    return !keys.some((k) => lD === k || lD.endsWith(k) || k.endsWith(lD));
  });
}


/**
 * Human verdict message. Long batches collapse the ✅ list to a count.
 *
 * @param {object} [opts]
 * @param {number} [opts.thanExcluded] VRF-3 — loose thans on a mixed sale
 *        that were deliberately left out of the compare. Named so the
 *        verdict never silently implies it covered the whole request.
 */
function buildVerdictMessage(requestId, results, extras, opts = {}) {
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
  const thanExcluded = Number(opts.thanExcluded) || 0;
  if (thanExcluded) {
    lines.push(`ℹ️ ${thanExcluded} than item(s) not machine-checked — a than has no bale number on the bill.`);
  }
  lines.push(`Verdict: ${ok.length} confirmed · ${differs.length} differ · ${missing.length} missing · ${extras.length} extra`);
  if (differs.length || missing.length || extras.length) {
    lines.push('⚠️ Open the attached bill and compare before approving.');
  } else if (thanExcluded) {
    // VRF-3 — the closing sentence must not out-claim the comparison. A
    // clean run on the bale lines of a MIXED sale has said nothing about
    // the thans, and "the bill and the request agree" would be read as
    // covering the whole request.
    lines.push('The bale lines and the bill agree — the than items above were not compared.');
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
    // VRF-2 (owner 14-Aug-2026): "stop giving the approval check from any
    // store, but keep it intact from warehouse supply." A STORE sells in
    // thans and its bill is a handwritten than-receipt with no bale rows
    // printed on it, so this bale-row OCR can only ever answer "No bale
    // rows recognised" — the identical false warning on every Kano office
    // sale, which trains the eye to ignore the one that matters. Warehouse
    // bills DO list bale numbers, so the check stays whole there.
    // The bill itself is still mandatory and still forwarded with the card;
    // only the automated read is dropped, and only where it cannot work.
    // Its own try, deliberately: this function's outer catch returns false,
    // so an exception escaping the lookup would SKIP the check — the exact
    // opposite of the rule. Only a positive answer may drop it.
    let storeOnly = false;
    try {
      storeOnly = await locationService.shipsOnlyFromStores(aj);
    } catch (e) {
      logger.warn(`saleDocVerify ${requestId}: place lookup failed, checking anyway: ${e.message}`);
    }
    if (storeOnly) {
      logger.info(`saleDocVerify ${requestId}: store-origin sale — bill check skipped (VRF-2)`);
      return false;
    }

    // VRF-3 (owner 15-Aug-2026, with a screenshot of ten false ❌ lines):
    // "Stop doing bill checks for the sale which is made in thans…
    // selling in thans doesn't have detailed information in the image
    // attached inside the PDF of the bill, therefore there is no use of
    // wasting the credit unless you find that there is a complete bale
    // sold in the approval card."
    //
    // A than sale's bill is a handwritten receipt: it names no bale
    // numbers, so this bale-row OCR can only ever report every line as
    // missing. Deciding on the GOODS rather than the place also makes the
    // rule work today — VRF-2's store skip waits on a Locations sheet
    // that is not seeded yet, so it never fired on the owner's Kano sale.
    //
    // The gate sits BEFORE the download and the vision call, so the OCR
    // credit is genuinely saved rather than spent and then discarded.
    const allItems = itemsFromActionJSON(aj);
    const looseThans = allItems.filter((i) => i.isThan);
    // A bale taken WHOLE through the bundle door still arrives as than
    // lines, so the shape alone would skip the case the owner carved out.
    // Inventory says which of those bales are going out complete.
    const wholeFromThans = looseThans.length
      ? await completeBalesAmongThans(looseThans)
      : new Set();
    // Those lines COLLAPSE to one item per bale: the bill carries a single
    // row for the bale, so leaving five than lines standing would match the
    // first and report the other four missing — the noise, rebuilt.
    const collapsed = [];
    for (const k of wholeFromThans) {
      const lines = looseThans.filter((i) => digits(i.packageNo) === k);
      if (!lines.length) continue;
      collapsed.push({
        packageNo: lines[0].packageNo,
        design: lines.find((l) => l.design)?.design || '',
        shade: lines.find((l) => l.shade)?.shade || '',
        thans: lines.length,
        yards: lines.reduce((s, l) => s + (Number(l.yards) || 0), 0),
        isThan: false,
      });
    }
    const baleItems = allItems.filter((i) => !i.isThan).concat(collapsed);
    const thanItems = looseThans.filter((i) => !wholeFromThans.has(digits(i.packageNo)));
    if (allItems.length && !baleItems.length) {
      logger.info(`saleDocVerify ${requestId}: than-only sale (${thanItems.length} than item(s)) — bill check skipped (VRF-3)`);
      return false;
    }
    // Goods that cannot be classified at all (a malformed actionJSON) still
    // get checked: uncertainty degrades TOWARDS verifying, never away.

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

    // VRF-3 — a MIXED sale (whole bales + loose thans) is checked on its
    // BALE lines only. A than's bill line carries no bale number, so
    // comparing it could only ever add a false "NOT found" beside real
    // findings, which is what taught the owner to distrust the whole
    // verdict. The thans are named once, quietly, so the reader knows
    // what the verdict does NOT cover.
    const toCheck = baleItems.length ? baleItems : allItems;
    const items = await enrichItems(toCheck);
    const shadeCatalog = await loadShadeCatalog(items);
    // The excluded thans' own bill rows leave the pool entirely — see
    // dropLabelsFor for why suppressing them later would not be enough.
    const labels = baleItems.length
      ? dropLabelsFor(ocr.bales, thanItems.map((i) => i.packageNo))
      : ocr.bales;
    const { results, extras } = compareItemsToLabels(items, labels, { shadeCatalog });
    const msg = buildVerdictMessage(requestId, results, extras,
      { thanExcluded: baleItems.length ? thanItems.length : 0 });
    // Persist the verdict on the queue row so pending views can surface it.
    try {
      await approvalQueueRepository.updateActionJSON(requestId, {
        docVerify: {
          ok: results.filter((r) => r.status === 'ok').length,
          differs: results.filter((r) => r.status === 'differs').length,
          missing: results.filter((r) => r.status === 'missing').length,
          extra: extras.length,
          // VRF-3 — carried so the approval card cannot render a clean ✅
          // for a request whose than items were never compared.
          thanUnchecked: baleItems.length ? thanItems.length : 0,
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
    itemIsThan, dropLabelsFor, completeBalesAmongThans,
    compareShades, normShade, designPrefixMisread, editDistance, loadShadeCatalog,
  },
};
