/**
 * WAU-3 — pure string parsers for blind stock-count entry.
 *
 * House pattern (see quickAddParser): pure functions in src/utils/,
 * `{ok:true, ...fields}` / `{ok:false, error}` results, never throw, no
 * controller imports — the smoke harness exercises them standalone.
 */

'use strict';

/**
 * Parse a count like `12` (bales only) or `12+5` (bales + loose bundles).
 * Zero is allowed on either side (`0+3`, `12+0`, `0`).
 *
 * @param {string} raw
 * @returns {{ok:true, bales:number, bundles:number} | {ok:false, error:string}}
 */
function parseCount(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!s) return { ok: false, error: 'Empty count.' };
  const m = s.match(/^(\d{1,4})(?:\+(\d{1,4}))?$/);
  if (!m) return { ok: false, error: `"${raw}" is not a count — use 12 or 12+5 (bales+bundles).` };
  return { ok: true, bales: Number(m[1]), bundles: m[2] === undefined ? 0 : Number(m[2]) };
}

/**
 * Parse an offline AUDIT batch message:
 *
 *   AUDIT Kano Office
 *   9032 = 12+5
 *   77016 = 8
 *   44200 =            ← blank value = not counted, skipped
 *
 * Lines tolerate a missing '=' (`9032 12+5`). The warehouse is matched
 * case-insensitively against knownWarehouses.
 *
 * @param {string} text
 * @param {string[]} knownWarehouses
 * @returns {{ok:true, warehouse:string, entries:Array<{design:string,bales:number,bundles:number}>, skipped:string[], errors:string[]}
 *         | {ok:false, error:string}}
 */
function parseAuditBatch(text, knownWarehouses) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, error: 'Empty message.' };
  const head = lines[0].match(/^AUDIT\s+(.+)$/i);
  if (!head) return { ok: false, error: 'First line must be: AUDIT <warehouse>' };
  const wanted = head[1].trim().toLowerCase();
  const warehouse = (knownWarehouses || []).find((w) => String(w).trim().toLowerCase() === wanted);
  if (!warehouse) {
    return { ok: false, error: `Unknown warehouse "${head[1].trim()}". Keep the first line exactly as it was in the count sheet.` };
  }
  const entries = [];
  const skipped = [];
  const errors = [];
  for (const line of lines.slice(1)) {
    // AUD-X2 — split on the LAST '=' when the line has one, so design codes
    // containing spaces survive ("402/9059 (08) = 12"). Falling back to the
    // first-token rule keeps the older "9032 12+5" shape working.
    let design;
    let value;
    const eq = line.lastIndexOf('=');
    if (eq >= 0) {
      design = line.slice(0, eq).trim();
      value = line.slice(eq + 1).trim();
      if (!design) { errors.push(`Unreadable line: "${line}"`); continue; }
    } else {
      const m = line.match(/^(\S+)\s*(.*)$/);
      if (!m) { errors.push(`Unreadable line: "${line}"`); continue; }
      design = m[1];
      value = m[2].trim();
    }
    if (!value) { skipped.push(design); continue; }
    const count = parseCount(value);
    if (!count.ok) { errors.push(`${design}: ${count.error}`); continue; }
    entries.push({ design, bales: count.bales, bundles: count.bundles });
  }
  return { ok: true, warehouse, entries, skipped, errors };
}

/**
 * WAU-4 (owner, 13-Aug-2026) — the opened-bale equivalence.
 *
 * Kano bales carry VARIABLE piece counts (6 in one, 4 in another), so the
 * auditor's rule is physical: sealed → count as a bale, opened → count its
 * pieces as loose. A bale opened for display with NOTHING sold then reads
 * differently on the two sides: the book still calls it a full bale, the
 * count reports its pieces loose. That is not a discrepancy — the pieces
 * are all there.
 *
 * This answers: can the counted shortfall of `missingBales` bales be
 * explained EXACTLY by `surplusThans` loose pieces, using the real piece
 * counts of this design's closed bales? Subset-sum with cardinality — is
 * there a set of exactly `missingBales` closed bales whose sizes sum to
 * exactly `surplusThans`? A shortfall is never forgiven: one missing piece
 * breaks the equality and stays a mismatch.
 *
 * Sizes come from the ledger's own per-bale rows (row-level truth), never
 * from an assumed pack size.
 *
 * @param {number[]} closedBaleSizes piece counts of the design's closed bales
 * @param {number} missingBales  book fullBales − counted bales (must be > 0)
 * @param {number} surplusThans  counted loose − book loose (must be > 0)
 * @returns {boolean}
 */
function openedBaleEquivalence(closedBaleSizes, missingBales, surplusThans) {
  const sizes = (closedBaleSizes || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const k = Number(missingBales);
  const sum = Number(surplusThans);
  if (!Number.isInteger(k) || !Number.isInteger(sum) || k <= 0 || sum <= 0) return false;
  if (k > sizes.length) return false;
  // DP over (bales used, pieces summed). Tiny inputs: a design rarely has
  // more than ~30 closed bales of ≤ ~20 pieces each.
  if (sum > sizes.reduce((a, b) => a + b, 0)) return false;
  let reachable = [new Set([0])]; // reachable[c] = sums achievable using c bales
  for (const size of sizes) {
    const next = reachable.map((set) => new Set(set));
    for (let c = 0; c < reachable.length && c < k; c += 1) {
      if (!next[c + 1]) next[c + 1] = new Set();
      for (const v of reachable[c]) {
        if (v + size <= sum) next[c + 1].add(v + size);
      }
    }
    reachable = next;
  }
  return Boolean(reachable[k] && reachable[k].has(sum));
}

module.exports = { parseCount, parseAuditBatch, openedBaleEquivalence };
