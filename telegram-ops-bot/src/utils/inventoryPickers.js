'use strict';

/**
 * src/utils/inventoryPickers.js — shared inventory-row aggregation helpers.
 *
 * Canonical home for the design-aggregation pattern (group inventory-shaped
 * rows by design, count distinct PHYSICAL bales, sum yards) that is currently
 * duplicated inline in bundleSaleFlow / warehouseAuditFlow / sellBaleFlow /
 * transferFlow. Migration of those flows is deferred — do NOT touch them as
 * part of edits here; new call-sites should import from this module.
 *
 * First consumer: soldBalesFlow (CSUP-2 design level in Customer Supplies).
 */

/**
 * Stable per-PHYSICAL-bale group key. The bale/package number is the
 * business identity of a bale; legacy rows carry synthetic per-ROW
 * baleUids (BAL-LEGACY-<rowIndex>), which made every than count as its
 * own bale (CSUP-1b owner report: "223 bales" on one day). Prefer
 * design+packageNo; fall back to baleUid only when no package number.
 * @param {{design?:string, packageNo?:string, baleUid?:string}} r
 * @returns {string}
 */
function baleGroupKey(r) {
  return r.packageNo ? `pkg:${r.design}|${r.packageNo}` : (r.baleUid || 'row');
}

/** Numeric-aware string compare (CARD-2 style: '9006' < '80045'). */
function cmpNumericAware(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true });
}

/**
 * Aggregate inventory-shaped rows ({design, packageNo, baleUid, yards})
 * by design.
 * @param {Array<{design?:string, packageNo?:string, baleUid?:string, yards?:number}>} rows
 * @returns {Array<{design:string, bales:number, thans:number, yards:number}>}
 *   One entry per design: bales = distinct physical bales (baleGroupKey),
 *   thans = row count, yards = summed yards. Sorted biggest first
 *   (bales desc), ties by design asc (numeric-aware).
 */
function aggregateDesigns(rows) {
  const byDesign = new Map();
  for (const r of rows || []) {
    const design = String(r.design ?? '');
    if (!byDesign.has(design)) byDesign.set(design, { design, baleKeys: new Set(), thans: 0, yards: 0 });
    const e = byDesign.get(design);
    e.baleKeys.add(baleGroupKey(r));
    e.thans += 1;
    e.yards += r.yards || 0;
  }
  return Array.from(byDesign.values())
    .map((e) => ({ design: e.design, bales: e.baleKeys.size, thans: e.thans, yards: e.yards }))
    .sort((a, b) => (b.bales - a.bales) || cmpNumericAware(a.design, b.design));
}

module.exports = { baleGroupKey, aggregateDesigns };
