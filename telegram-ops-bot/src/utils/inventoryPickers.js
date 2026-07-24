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

/**
 * TV-4 — opening-stock aggregation for the supply-request browse screens.
 *
 * "Opening" = EVERY Inventory row ever recorded for a warehouse slice,
 * regardless of status (available + sold + in_transit), so than-visible
 * warehouses can show "remaining / opening" and keep fully-sold designs
 * on screen. Filters mirror getAdjustedAvailability exactly (strict
 * warehouse equality, arrival-batch incl. the unlabelled sentinel,
 * optional design predicate) MINUS the status filter. Bale counts are
 * distinct physical bales via baleGroupKey; thans = row count (one row
 * per than). Pure + side-effect free.
 *
 * @param {Array<Object>} rows all inventory rows (any status)
 * @param {{warehouse:string, arrivalBatch?:string|null, unlabelledBatch?:string,
 *          designMatch?:(design:string)=>boolean}} opts
 * @returns {{totals:{bales:number,thans:number},
 *            designs:Map<string,{bales:number,thans:number}>,
 *            shades:Map<string,Map<string,{bales:number,thans:number}>>}}
 *   designs keyed by String(design); shades keyed design → String(shade||'DEFAULT').
 */
function aggregateOpeningStock(rows, { warehouse, arrivalBatch = null, unlabelledBatch = '', designMatch = null } = {}) {
  const ab = arrivalBatch ? String(arrivalBatch).toUpperCase() : null;
  const isUnlabelled = ab !== null && ab === String(unlabelledBatch).toUpperCase();
  const totalKeys = new Set();
  let totalThans = 0;
  const designs = new Map(); // design → {keys:Set, thans}
  const shades = new Map(); // design → Map<shadeKey, {keys:Set, thans}>
  for (const r of rows || []) {
    if (!r || r.warehouse !== warehouse) continue;
    if (ab) {
      const rab = (r.arrivalBatch || '').toUpperCase();
      if (isUnlabelled ? rab !== '' : rab !== ab) continue;
    }
    const design = String(r.design ?? '');
    if (designMatch && !designMatch(design)) continue;
    const key = baleGroupKey(r);
    totalKeys.add(key);
    totalThans += 1;
    if (!designs.has(design)) designs.set(design, { keys: new Set(), thans: 0 });
    const d = designs.get(design);
    d.keys.add(key);
    d.thans += 1;
    if (!shades.has(design)) shades.set(design, new Map());
    const byShade = shades.get(design);
    const shadeKey = String(r.shade || 'DEFAULT');
    if (!byShade.has(shadeKey)) byShade.set(shadeKey, { keys: new Set(), thans: 0 });
    const s = byShade.get(shadeKey);
    s.keys.add(key);
    s.thans += 1;
  }
  const fin = (e) => ({ bales: e.keys.size, thans: e.thans });
  return {
    totals: { bales: totalKeys.size, thans: totalThans },
    designs: new Map(Array.from(designs, ([k, e]) => [k, fin(e)])),
    shades: new Map(Array.from(shades, ([k, m]) => [k, new Map(Array.from(m, ([sk, e]) => [sk, fin(e)]))])),
  };
}

module.exports = { baleGroupKey, cmpNumericAware, aggregateDesigns, aggregateOpeningStock };
