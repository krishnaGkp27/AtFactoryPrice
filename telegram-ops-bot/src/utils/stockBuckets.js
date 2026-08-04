'use strict';

/**
 * STK-B1 — the one place that decides which bucket an Inventory row falls in
 * (owner ruling, 04-Aug-2026: "Goods in transit should be counted as a
 * separate bucket … keep in transit in a separate bucket").
 *
 * WHY THIS EXISTS. Five reporting sites independently wrote
 *
 *     if (r.status === 'available') { available++ } else { sold++ }
 *
 * which silently books a bale as SOLD the moment it is anything else — a bale
 * mid-transfer, or a row whose Status was mistyped in the sheet. That is how
 * one design read "12 sold" on Stock Summary and "8 supplied" on Supply
 * Details: the four in transit had been counted as revenue. Meanwhile a
 * different site used `else { onHand++ }`, counting the same bales as stock
 * on the shelf. Three answers for one bale.
 *
 * A whitelist cannot drift the way an else-branch does: an unrecognised
 * status lands in `other` and is reported as itself, never silently added to
 * a number the owner reads as money.
 *
 * The buckets are deliberately NOT summed for the caller — each surface
 * decides what to show, but none of them can accidentally merge in-transit
 * into sold or into available.
 */

const AVAILABLE = 'available';
const IN_TRANSIT = 'in_transit';
const SOLD = 'sold';
const OTHER = 'other';

/**
 * Which bucket a row belongs to.
 *
 * parseRow already lower-cases Status and defaults a blank to 'available',
 * but this normalises again so the function is safe on a raw sheet row too.
 *
 * @param {object|string} row an Inventory row, or a status string
 * @returns {'available'|'in_transit'|'sold'|'other'}
 */
function bucketOf(row) {
  const raw = (row && typeof row === 'object') ? row.status : row;
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (s === AVAILABLE) return AVAILABLE;
  if (s === IN_TRANSIT) return IN_TRANSIT;
  if (s === SOLD) return SOLD;
  return OTHER;
}

/** True for rows that are physically ours and unsold — shelf plus truck. */
function isLive(row) {
  const b = bucketOf(row);
  return b === AVAILABLE || b === IN_TRANSIT;
}

/**
 * Tally a set of rows into the four buckets, counting THAN ROWS and the
 * distinct printed bale numbers behind them.
 *
 * Bale identity is design + printed number: BUSINESS_RULES §1 makes the
 * printed number the only user-facing key, and §5 lets a sold number be
 * re-intaken, so the number alone would collapse two physical bales.
 *
 * @param {Array<object>} rows Inventory rows
 * @returns {{available:object, in_transit:object, sold:object, other:object}}
 *          each `{ thans, yards, bales }` (bales = distinct design|number)
 */
function tally(rows) {
  const mk = () => ({ thans: 0, yards: 0, _pkgs: new Set() });
  const out = {
    [AVAILABLE]: mk(), [IN_TRANSIT]: mk(), [SOLD]: mk(), [OTHER]: mk(),
  };
  for (const r of rows || []) {
    const g = out[bucketOf(r)];
    g.thans += 1;
    g.yards += Number(r && r.yards) || 0;
    if (r && r.packageNo) g._pkgs.add(`${r.design}|${r.packageNo}`);
  }
  for (const k of Object.keys(out)) {
    out[k].bales = out[k]._pkgs.size;
    delete out[k]._pkgs;
  }
  return out;
}

module.exports = {
  bucketOf, isLive, tally,
  AVAILABLE, IN_TRANSIT, SOLD, OTHER,
};
