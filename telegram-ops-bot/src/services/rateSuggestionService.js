'use strict';

/**
 * rateSuggestionService — small read-only helper that powers the
 * "suggested rate" chips on the bundle-sale rate-entry card.
 *
 * The bundle-sale flow needs four numbers when the manager is about
 * to type a per-yard rate:
 *
 *   1. lastCustomerRate  — most recent APPROVED sale rate this customer
 *                          paid for this design (anchors negotiation).
 *   2. lastAnyRate       — most recent APPROVED sale rate ANY customer
 *                          paid for this design (fallback when customer
 *                          is new).
 *   3. median30dRate     — median of the last 30 days of approved
 *                          per-yard rates for this design (market signal).
 *   4. floorRate         — the cost-recovery floor derived from
 *                          landed-cost: highest lc_ngn_per_yard across
 *                          GRNs that still have AVAILABLE stock for this
 *                          design. Selling below this means a loss.
 *
 * Each number is independent; callers render whatever they have and
 * gracefully skip nulls. The shape never throws — a missing sheet or
 * misformatted row just leaves the corresponding field as null.
 *
 * No writes. No side effects. Safe to call from a tight UI loop.
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const goodsReceiptsRepository = require('../repositories/goodsReceiptsRepository');

let _sheetsClient = null;
function sheets() {
  if (!_sheetsClient) _sheetsClient = require('../repositories/sheetsClient');
  return _sheetsClient;
}

function num(v) { return parseFloat(v) || 0; }
function str(v) { return (v ?? '').toString().trim(); }
function upper(v) { return str(v).toUpperCase(); }

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Pull recent approved sales for a design from Transactions sheet.
 * Returns array of { ts, customer, pricePerYard, qty } sorted newest-first.
 * Empty array on any read error (graceful degradation).
 */
async function recentSalesForDesign(design, { limit = 200 } = {}) {
  if (!design) return [];
  try {
    const rows = await sheets().readRange('Transactions', 'A2:Q');
    const d = upper(design);
    const matches = [];
    for (const r of rows) {
      const action = str(r[2]).toLowerCase();
      if (action !== 'sale_bundle' && action !== 'sale_than' && action !== 'sale_package') continue;
      const rowDesign = upper(r[3]);
      if (rowDesign && rowDesign !== d) continue;
      const status = str(r[8]).toLowerCase();
      if (status && status !== 'approved' && status !== 'completed') continue;
      const ppy = num(r[15]);
      if (ppy <= 0) continue;
      matches.push({
        ts: str(r[0]),
        customer: str(r[11]),
        pricePerYard: ppy,
        qty: num(r[5]),
      });
    }
    matches.sort((a, b) => (b.ts > a.ts ? 1 : -1));
    return matches.slice(0, limit);
  } catch (_) {
    return [];
  }
}

/**
 * Compute the cost-recovery floor for a design: the maximum
 * lc_ngn_per_yard across GRNs that still hold available stock for this
 * design. Returns null when no finalised landed cost is reachable
 * (caller should hint "set landed cost first").
 */
async function computeFloorRate(design, warehouse = null) {
  if (!design) return null;
  try {
    const grouped = await inventoryRepository.groupByBaleAndShade(design, warehouse);
    const grnIds = new Set();
    for (const shade of grouped.shades) {
      for (const bale of shade.bales) {
        for (const than of bale.thans) {
          // groupByBaleAndShade doesn't carry grn_id — re-look it up from
          // the full Inventory list. For now we'll do the cheap thing
          // and trust that bale-uid maps 1:1 to a single grn_id. Pull
          // the underlying rows once.
        }
      }
    }
    // Cheaper path: read Inventory once + join in-memory.
    const allInv = await inventoryRepository.getAll();
    const d = upper(design);
    const w = warehouse ? upper(warehouse) : null;
    for (const row of allInv) {
      if (row.status !== 'available') continue;
      if (upper(row.design) !== d) continue;
      if (w && upper(row.warehouse) !== w) continue;
      if (row.grnId) grnIds.add(row.grnId);
    }
    if (!grnIds.size) return null;
    const allGrns = await goodsReceiptsRepository.getAll();
    let floor = 0;
    for (const grn of allGrns) {
      if (!grnIds.has(grn.grn_id)) continue;
      if (grn.lc_status !== 'finalized') continue;
      const ngn = num(grn.lc_ngn_per_yard);
      if (ngn > floor) floor = ngn;
    }
    return floor > 0 ? floor : null;
  } catch (_) {
    return null;
  }
}

/**
 * Headline: gather all four suggestion numbers for a design+customer.
 * 30-day window is anchored on UTC date math; close enough for textile
 * pricing where prices don't move hourly.
 */
async function suggestFor({ design, customer = '', warehouse = null }) {
  const [recent, floor] = await Promise.all([
    recentSalesForDesign(design),
    computeFloorRate(design, warehouse),
  ]);
  const cust = upper(customer);
  const customerRow = cust ? recent.find((s) => upper(s.customer) === cust) : null;
  const anyRow = recent[0] || null;
  const cutoff = Date.now() - 30 * 86400000;
  const last30 = recent
    .filter((s) => {
      const t = Date.parse(s.ts || '');
      return isFinite(t) && t >= cutoff;
    })
    .map((s) => s.pricePerYard);
  return {
    lastCustomerRate: customerRow ? customerRow.pricePerYard : null,
    lastCustomerAt:   customerRow ? customerRow.ts : null,
    lastAnyRate:      anyRow ? anyRow.pricePerYard : null,
    lastAnyCustomer:  anyRow ? anyRow.customer : null,
    lastAnyAt:        anyRow ? anyRow.ts : null,
    median30dRate:    median(last30),
    median30dCount:   last30.length,
    floorRate:        floor,
  };
}

/**
 * Render the suggestion block as a few short Telegram-friendly lines.
 * Returns '' when nothing is known. Caller decides where to splice it
 * into the rate-entry card.
 */
function formatSuggestionLines(s) {
  if (!s) return '';
  const lines = [];
  const fmt = (n) => `₦${Math.round(n).toLocaleString('en-NG')}`;
  if (s.lastCustomerRate) lines.push(`• Last to this customer: ${fmt(s.lastCustomerRate)}/yd`);
  if (s.lastAnyRate && !s.lastCustomerRate) lines.push(`• Last sale (any customer): ${fmt(s.lastAnyRate)}/yd`);
  if (s.median30dRate) lines.push(`• 30-day median: ${fmt(s.median30dRate)}/yd (${s.median30dCount} sales)`);
  if (s.floorRate) lines.push(`• Floor (landed cost): ${fmt(s.floorRate)}/yd`);
  else lines.push('• Floor: _set landed cost first_');
  return lines.join('\n');
}

module.exports = {
  suggestFor,
  formatSuggestionLines,
  recentSalesForDesign,
  computeFloorRate,
  median,
};
