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
 * TV-6 — GRN-anchored stock model for the supply-request browse screens.
 * Replaces the TV-4/5 "opening = every row ever, any status" semantics
 * (aggregateOpeningStock) with the flow-shaped, owner-approved model.
 *
 * Three buckets per warehouse slice:
 *
 *   opening    what was INTAKEN here: rows whose grnId resolves through
 *              `grnWarehouseById` (bale → grnId → GoodsReceipts.warehouse)
 *              to THIS warehouse — wherever the bale sits today, so a
 *              transferred-away bale stays in its source's opening.
 *              LEGACY fallback (owner-approved): rows with no grnId — or a
 *              grnId that doesn't resolve — count at their CURRENT
 *              warehouse. Rows with status 'in_transit' NEVER count.
 *   hasOpening false when the slice has zero GRN-attributed AND zero
 *              legacy openings (a purely transfer-fed warehouse) — the
 *              browse then shows remaining-only: no pair, no legend.
 *   incoming   rows pointed at this warehouse with status 'in_transit'
 *              (transfer dispatch stamps the DESTINATION on the row),
 *              grouped by design — the 🚚 "In transit" bucket.
 *
 * The non-warehouse filters mirror getAdjustedAvailability exactly
 * (arrival-batch incl. the unlabelled sentinel, optional design
 * predicate) and apply to every bucket. Warehouse matching is
 * trimmed/case-insensitive (GRN headers and Inventory rows may disagree
 * on casing). Bale counts are distinct physical bales via baleGroupKey;
 * thans = row count (one row per than). Pure + side-effect free.
 *
 * @param {Array<Object>} rows all inventory rows (any status)
 * @param {{warehouse:string, arrivalBatch?:string|null, unlabelledBatch?:string,
 *          designMatch?:(design:string)=>boolean,
 *          grnWarehouseById?:Map<string,string>|null}} opts
 *        grnWarehouseById maps GoodsReceipts.grn_id → receiving warehouse;
 *        null/absent degrades every row to the legacy (current-warehouse)
 *        attribution.
 * @returns {{opening:{totals:{bales:number,thans:number},
 *                     designs:Map<string,{bales:number,thans:number}>,
 *                     shades:Map<string,Map<string,{bales:number,thans:number}>>},
 *            hasOpening:boolean,
 *            incoming:{totals:{bales:number,thans:number},
 *                      designs:Map<string,{bales:number,thans:number}>}}}
 *   designs keyed by String(design); shades keyed design → String(shade||'DEFAULT').
 */
function aggregateStockModel(rows, {
  warehouse, arrivalBatch = null, unlabelledBatch = '', designMatch = null, grnWarehouseById = null,
} = {}) {
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
  const w = norm(warehouse);
  const ab = arrivalBatch ? String(arrivalBatch).toUpperCase() : null;
  const isUnlabelled = ab !== null && ab === String(unlabelledBatch).toUpperCase();
  const bucket = () => ({ keys: new Set(), thans: 0 });
  const add = (b, key) => { b.keys.add(key); b.thans += 1; };
  const openTotals = bucket();
  const designs = new Map(); // design → {keys:Set, thans}
  const shades = new Map(); // design → Map<shadeKey, {keys:Set, thans}>
  const inTotals = bucket();
  const inDesigns = new Map(); // design → {keys:Set, thans}
  for (const r of rows || []) {
    if (!r) continue;
    if (ab) {
      const rab = (r.arrivalBatch || '').toUpperCase();
      if (isUnlabelled ? rab !== '' : rab !== ab) continue;
    }
    const design = String(r.design ?? '');
    if (designMatch && !designMatch(design)) continue;
    const key = baleGroupKey(r);
    if (String(r.status).toLowerCase() === 'in_transit') {
      // In-transit rows never count toward opening (or remaining) anywhere;
      // they ARE the destination's incoming bucket.
      if (norm(r.warehouse) !== w) continue;
      add(inTotals, key);
      if (!inDesigns.has(design)) inDesigns.set(design, bucket());
      add(inDesigns.get(design), key);
      continue;
    }
    // Opening attribution: the GRN's receiving warehouse when the row's
    // grnId resolves; otherwise (legacy / unresolvable) its CURRENT one.
    const grnWh = r.grnId && grnWarehouseById ? grnWarehouseById.get(r.grnId) : null;
    if (norm(grnWh || r.warehouse) !== w) continue;
    add(openTotals, key);
    if (!designs.has(design)) designs.set(design, bucket());
    add(designs.get(design), key);
    if (!shades.has(design)) shades.set(design, new Map());
    const byShade = shades.get(design);
    const shadeKey = String(r.shade || 'DEFAULT');
    if (!byShade.has(shadeKey)) byShade.set(shadeKey, bucket());
    add(byShade.get(shadeKey), key);
  }
  const fin = (e) => ({ bales: e.keys.size, thans: e.thans });
  return {
    opening: {
      totals: fin(openTotals),
      designs: new Map(Array.from(designs, ([k, e]) => [k, fin(e)])),
      shades: new Map(Array.from(shades, ([k, m]) => [k, new Map(Array.from(m, ([sk, e]) => [sk, fin(e)]))])),
    },
    hasOpening: openTotals.thans > 0,
    incoming: {
      totals: fin(inTotals),
      designs: new Map(Array.from(inDesigns, ([k, e]) => [k, fin(e)])),
    },
  };
}

module.exports = { baleGroupKey, cmpNumericAware, aggregateDesigns, aggregateStockModel };
