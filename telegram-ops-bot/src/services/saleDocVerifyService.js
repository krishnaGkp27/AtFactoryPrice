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
const mutex = require('../utils/asyncMutex');

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
    // VRF-5 — `pos` is the bill row's position: the card follows the bill.
    results.push({ item: it, status: diffs.length ? 'differs' : 'ok', diffs, notes, label: l, pos: idx });
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
    r.pos = idx;
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

/* ── VRF-4 — the verdict's bale numbers outlive the chat scroll ── */

// Bounds on what one verdict may leave on the queue row. Real sales run to
// a few dozen bales; the caps exist so a pathological OCR read cannot bloat
// a Sheets cell, and a cap that bites is RECORDED (truncated), never silent.
const RECORD_ROW_CAP = 200;
const RECORD_TEXT_CAP = 160;
// The whole record, serialised, must stay a small fraction of a Sheets cell
// (50,000 chars) beside the actionJSON it rides in — otherwise a bloated
// record could make the write fail and lose the COUNTS too, which the
// counts-only persist before VRF-4 never risked.
const RECORD_BYTES_CAP = 12000;

/** Cap each string; reports through `flag.cut` whether anything was lost. */
function capStrings(arr, flag) {
  return (Array.isArray(arr) ? arr : []).map((s) => {
    const str = String(s);
    if (str.length > RECORD_TEXT_CAP && flag) flag.cut = true;
    return str.slice(0, RECORD_TEXT_CAP);
  });
}

/**
 * VRF-4 (owner 08-Sep-2026: "I cannot precisely see the exact bill number
 * where I need to find the ambiguity") — the persisted shape of one verdict.
 *
 * VRF-1 kept the four COUNTS, so every later view of the card could say how
 * many bales differed and not which; the numbers lived in a follow-up
 * message that had scrolled away by the time the admin opened the inbox.
 * The counts stay exactly as they were; beside them ride the rows the
 * verdict message itself prints — confirmed numbers, and for each flagged
 * row its number plus the checker's own reason strings — so the card can
 * NAME the bales and the inbox chip can replay the verdict without a
 * second OCR read.
 *
 * Only what the message prints is kept. Never a spread of a label or an
 * item: a bill row carries nothing the card should not show today, but the
 * whitelist is the lock against tomorrow.
 */
function docVerifyRecord(results, extras, opts = {}) {
  const ok = results.filter((r) => r.status === 'ok');
  const okPlain = ok.filter((r) => !(r.notes && r.notes.length));
  const okNoted = ok.filter((r) => r.notes && r.notes.length);
  const differs = results.filter((r) => r.status === 'differs');
  const missing = results.filter((r) => r.status === 'missing');
  const no = (r) => String(r.item && r.item.packageNo != null ? r.item.packageNo : '?');
  const flag = { cut: false };
  const rec = {
    ok: ok.length,
    differs: differs.length,
    missing: missing.length,
    extra: extras.length,
    // VRF-3 — carried so the approval card cannot render a clean ✅ for a
    // request whose than items were never compared.
    thanUnchecked: Number(opts.thanExcluded) || 0,
    at: new Date().toISOString(),
    okNos: okPlain.slice(0, RECORD_ROW_CAP).map(no),
    okNoted: okNoted.slice(0, RECORD_ROW_CAP).map((r) => ({ no: no(r), notes: capStrings(r.notes, flag) })),
    differRows: differs.slice(0, RECORD_ROW_CAP)
      .map((r) => ({ no: no(r), diffs: capStrings(r.diffs, flag), notes: capStrings(r.notes, flag) })),
    missingNos: missing.slice(0, RECORD_ROW_CAP).map(no),
    extraRows: extras.slice(0, RECORD_ROW_CAP).map((l) => ({
      no: l.packageNo != null ? String(l.packageNo) : '',
      design: l.design ? String(l.design) : '',
      shade: l.shade ? String(l.shade) : '',
    })),
    // VRF-5 — the request's bales in the order the bill lists them (matched
    // rows only; a missing bale has no bill row). The sale card follows it.
    billSeq: results.filter((r) => r.pos !== undefined && r.status !== 'missing')
      .sort((a, b) => a.pos - b.pos).slice(0, RECORD_ROW_CAP).map(no),
    // VRF-5 — who re-checked the bill and when: one tap per admin per request.
    rechecks: Array.isArray(opts.rechecks) ? opts.rechecks : [],
    truncated: flag.cut
      || [okPlain, okNoted, differs, missing, extras].some((l) => l.length > RECORD_ROW_CAP),
  };
  // Byte budget: shed the least useful rows first (plain confirmed numbers,
  // then noted ones, then extras), then the differ rows — they carry the
  // reason strings, so halving them is what actually frees bytes — and the
  // bare missing numbers last. One list halved per pass until the record
  // fits. The counts are never touched.
  const SHED_ORDER = ['billSeq', 'okNos', 'okNoted', 'extraRows', 'differRows', 'missingNos'];
  while (JSON.stringify(rec).length > RECORD_BYTES_CAP) {
    const key = SHED_ORDER.find((k) => rec[k].length);
    if (!key) break;
    rec[key] = rec[key].slice(0, Math.floor(rec[key].length / 2));
    rec.truncated = true;
  }
  return rec;
}

/** A record written by VRF-4 (rows present), as opposed to counts alone. */
function recordHasRows(v) {
  return !!(v && Array.isArray(v.differRows));
}

/**
 * VRF-4 — rebuild the verdict message from a persisted record, through the
 * SAME builder that wrote the original, so the inbox chip can never tell a
 * different story from the message the admins received at OCR time.
 * Returns '' for a pre-VRF-4 record (counts only), which has nothing to
 * replay beyond the card's own line.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxChars] Telegram's message cap, minus margin. When
 *        the replay would pass it, body rows are dropped from the TOP (the
 *        confirmed lines come first; the flagged rows sit below them) and a
 *        marker says how many. The header and the Verdict footer always
 *        stay — cutting the tail would drop the one line that sums it up.
 */
function verdictMessageFromRecord(requestRef, v, opts = {}) {
  if (!recordHasRows(v)) return '';
  const results = [];
  for (const n of v.okNos || []) results.push({ item: { packageNo: n }, status: 'ok', diffs: [], notes: [] });
  for (const r of v.okNoted || []) results.push({ item: { packageNo: r.no }, status: 'ok', diffs: [], notes: r.notes || [] });
  for (const r of v.differRows) results.push({ item: { packageNo: r.no }, status: 'differs', diffs: r.diffs || [], notes: r.notes || [] });
  for (const n of v.missingNos || []) results.push({ item: { packageNo: n }, status: 'missing' });
  const extras = (v.extraRows || []).map((e) => ({ packageNo: e.no, design: e.design, shade: e.shade }));
  let msg = buildVerdictMessage(requestRef, results, extras, { thanExcluded: v.thanUnchecked });
  if (v.truncated) {
    // The rebuilt rows are fewer than the bales checked, so the builder's
    // own tally would under-count: the persisted counts are the truth.
    msg = msg.replace(/^Verdict: .*$/m,
      `Verdict: ${v.ok || 0} confirmed · ${v.differs || 0} differ · ${v.missing || 0} missing · ${v.extra || 0} extra`);
    msg += '\n⚠️ A very long bill — not every row was kept. The counts are complete; the list above is not.';
  }
  const max = Number(opts.maxChars) || 0;
  if (max && msg.length > max) {
    const lines = msg.split('\n');
    // The footer begins at the blank line the builder always emits before
    // its ℹ️ / Verdict / advice lines.
    let footAt = lines.lastIndexOf('');
    if (footAt < 1) footAt = lines.length;
    const head = lines[0];
    const foot = lines.slice(footAt);
    const body = lines.slice(1, footAt);
    const marker = (n) => `… ${n} line(s) not shown — tap 📄 Sales bill and compare the flagged rows above.`;
    const fixed = head.length + 1 + foot.join('\n').length + 1 + marker(body.length).length + 1;
    const kept = [];
    let used = fixed;
    for (let i = body.length - 1; i >= 0; i -= 1) {
      if (used + body[i].length + 1 > max) break;
      used += body[i].length + 1;
      kept.unshift(body[i]);
    }
    const dropped = body.length - kept.length;
    msg = [head, marker(dropped), ...kept, ...foot].join('\n');
  }
  return msg;
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
/**
 * The check itself — shared by the submit-time run (`maybeVerify`) and the
 * VRF-5 re-check door (`recheckBill`). Every early exit names its reason so
 * the re-check can tell the admin why nothing was read.
 * @returns {Promise<{status:'skipped'|'unreadable'|'done', reason?:string, record?:object}>}
 */
async function runCheck(bot, aj, requestId, { admins, recheck } = {}) {
  if (!SALE_ACTIONS.includes(aj.action)) return { status: 'skipped', reason: 'not a sale' };
  if (!aj.sale_doc_file_id) return { status: 'skipped', reason: 'no bill attached' };
  if (/^snap/i.test(String(aj.source || ''))) return { status: 'skipped', reason: 'a snap sale is not bill-checked' };
  let settings = {};
  try { settings = await settingsRepository.getAll(); } catch { settings = {}; }
  if (Number(settings.PDF_VERIFY_ENABLED ?? 1) !== 1) return { status: 'skipped', reason: 'the bill check is switched off in Settings' };
  let storeOnly = false;
  try {
    storeOnly = await locationService.shipsOnlyFromStores(aj);
  } catch (e) {
    logger.warn(`saleDocVerify ${requestId}: place lookup failed, checking anyway: ${e.message}`);
  }
  if (storeOnly) {
    logger.info(`saleDocVerify ${requestId}: store-origin sale — bill check skipped (VRF-2)`);
    return { status: 'skipped', reason: 'a store sale is not bill-checked' };
  }

  // VRF-3 — a loose than has no bale number on a bill, so the thans of a
  // mixed sale are left out of the compare; a bale whose EVERY than is in
  // the request is one whole bale to the bill and is compared as such.
  const allItems = itemsFromActionJSON(aj);
  const looseThans = allItems.filter((i) => i.isThan);
  const wholeFromThans = looseThans.length
    ? await completeBalesAmongThans(looseThans)
    : new Set();
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
    return { status: 'skipped', reason: 'a than-only sale is not bill-checked' };
  }

  const { downloadTelegramFile } = require('../utils/telegramFiles');
  const vision = require('./vision');
  const dl = await downloadTelegramFile(bot, aj.sale_doc_file_id);
  const mime = aj.sale_doc_type === 'document' ? 'application/pdf' : (dl.mimeType || 'image/jpeg');
  // VRF-1 — the verification read ALWAYS asks for the strong model (owner:
  // precision over cost on the one read that gates an approval).
  const ocr = await vision.extractBales(dl.buffer, mime, { forceStrongModel: true });

  const adminIds = (admins && admins.length ? admins : config.access.adminIds);
  const tell = async (text) => {
    for (const a of adminIds) { try { await bot.sendMessage(a, text); } catch (_) { /* best-effort */ } }
  };
  const ref = () => { try { return require('./approvalCards').shortRequestRef(requestId); } catch (_) { return requestId; } };
  const now = () => new Date().toISOString();
  if (!ocr.ok || !Array.isArray(ocr.bales) || !ocr.bales.length) {
    const why = ocr.error || 'no labels recognised';
    if (recheck) {
      // VRF-5 — a failed re-read keeps the earlier verdict (if any) and only
      // records the tap: the old rows are still the best the bot has.
      const prev = recheck.prev && typeof recheck.prev === 'object' ? recheck.prev : {};
      const record = {
        ...prev, readFailed: true, readFailedAt: now(),
        rechecks: [...(Array.isArray(prev.rechecks) ? prev.rechecks : []), { by: recheck.by, at: now(), ok: false }],
      };
      try { await approvalQueueRepository.updateActionJSON(requestId, { docVerify: record }); } catch (e) { logger.warn(`saleDocVerify persist ${requestId}: ${e.message}`); }
      await tell(`🔬 Bill of ${ref()} re-checked by ${recheck.byLabel || recheck.by} · could not read the bill (${why}) — compare by hand`);
      return { status: 'unreadable', record };
    }
    await tell(`🔬 Bill check — request ${requestId}\n⚠️ Could not read the attached bill (${why}). Compare it manually before approving.`);
    return { status: 'unreadable' };
  }

  const toCheck = baleItems.length ? baleItems : allItems;
  const items = await enrichItems(toCheck);
  const shadeCatalog = await loadShadeCatalog(items);
  const labels = baleItems.length
    ? dropLabelsFor(ocr.bales, thanItems.map((i) => i.packageNo))
    : ocr.bales;
  const { results, extras } = compareItemsToLabels(items, labels, { shadeCatalog });
  const thanExcluded = baleItems.length ? thanItems.length : 0;
  const prevRechecks = recheck && recheck.prev && Array.isArray(recheck.prev.rechecks) ? recheck.prev.rechecks : [];
  const record = docVerifyRecord(results, extras, {
    thanExcluded,
    rechecks: recheck ? [...prevRechecks, { by: recheck.by, at: now() }] : prevRechecks,
  });
  try {
    await approvalQueueRepository.updateActionJSON(requestId, { docVerify: record });
  } catch (e) { logger.warn(`saleDocVerify persist ${requestId}: ${e.message}`); }
  if (recheck) {
    // VRF-5 — one line to every admin, so nobody spends their own tap on a
    // bill that was just read; the cards all rebuild from the saved record.
    await tell(`🔬 Bill of ${ref()} re-checked by ${recheck.byLabel || recheck.by} · ${record.ok} confirmed · ${record.differs} differ · ${record.missing} missing · ${record.extra} extra`);
  } else {
    await tell(buildVerdictMessage(requestId, results, extras, { thanExcluded }));
  }
  return { status: 'done', record };
}

/**
 * Submit-time entry point. Resolves false when nothing was checked (not a
 * sale, no bill, snap, store-only, than-only, switched off), true when a
 * read ran — readable or not — so the caller knows the admins were told.
 */
async function maybeVerify(bot, requestId, opts = {}) {
  try {
    const row = await approvalQueueRepository.getByRequestId(requestId);
    if (!row || !row.actionJSON) return false;
    const r = await runCheck(bot, row.actionJSON, requestId, { admins: opts.adminIds });
    return r.status !== 'skipped';
  } catch (e) {
    logger.warn(`saleDocVerify ${requestId}: ${e.message}`);
    return false;
  }
}

const RECHECK_FRESH_MS = 60 * 1000;

/**
 * VRF-5 (owner, 18-Oct-2026) — the re-check door. One tap per admin per
 * request, recorded on the request itself (`docVerify.rechecks`). A tap
 * that lands within a minute of another admin's completed re-check is
 * served that result without a second read and without spending the tap;
 * two taps at the same moment are serialised on the request, so the bill
 * is read once. Only a PENDING request is re-checked.
 * @returns {Promise<{status:'done'|'unreadable'|'fresh'|'used'|'skipped', reason?:string, record?:object}>}
 */
async function recheckBill(bot, requestId, { by, byLabel } = {}) {
  const who = String(by || '');
  const spent = (v) => Array.isArray(v && v.rechecks) && v.rechecks.some((r) => String(r.by) === who);
  const row0 = await approvalQueueRepository.getByRequestId(requestId);
  if (!row0 || !row0.actionJSON) return { status: 'skipped', reason: 'request not found' };
  if (String(row0.status || '').toLowerCase() !== 'pending') return { status: 'skipped', reason: 'the request is already decided' };
  if (spent(row0.actionJSON.docVerify)) return { status: 'used' };
  return mutex.runExclusive(`recheck:${requestId}`, async () => {
    const row = (await approvalQueueRepository.getByRequestId(requestId)) || row0;
    const aj = row.actionJSON || row0.actionJSON;
    const prev = (aj.docVerify && typeof aj.docVerify === 'object') ? aj.docVerify : {};
    if (spent(prev)) return { status: 'used' };
    const last = Array.isArray(prev.rechecks) && prev.rechecks.length ? prev.rechecks[prev.rechecks.length - 1] : null;
    if (last && Date.now() - Date.parse(last.at || 0) < RECHECK_FRESH_MS) return { status: 'fresh', record: prev };
    try {
      return await runCheck(bot, aj, requestId, { admins: config.access.adminIds, recheck: { by: who, byLabel, prev } });
    } catch (e) {
      logger.warn(`saleDocVerify recheck ${requestId}: ${e.message}`);
      return { status: 'skipped', reason: e.message };
    }
  });
}

module.exports = {
  maybeVerify,
  recheckBill,
  // VRF-4 — the inbox chip's replay, and the card's "does this row carry
  // detail" question, without reaching into _internals.
  verdictMessageFromRecord,
  recordHasRows,
  _internals: {
    compareItemsToLabels, itemsFromActionJSON, enrichItems, buildVerdictMessage, SALE_ACTIONS,
    itemIsThan, dropLabelsFor, completeBalesAmongThans,
    compareShades, normShade, designPrefixMisread, editDistance, loadShadeCatalog,
    docVerifyRecord, RECORD_ROW_CAP, runCheck, RECHECK_FRESH_MS,
  },
};
