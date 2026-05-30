'use strict';

/**
 * pricingService — Phase 1 foundation for layered price visibility.
 *
 * Two independent predicates so we can move sale-price and base-price
 * visibility on different schedules. Phase 1 keeps both admin-only and
 * matches the owner rule "right now only admin can see the price set".
 *
 *   canSeeSalePrice(userId) — should this user see the SELLING price?
 *     (PricePerYard in Check Stock, package detail, free-text stock
 *      summary, etc.) Phase 1: admin only. Phase 2 will widen via
 *      Departments.permissions (`see_sale_price` capability) so
 *      Sales/Marketing departments can be granted with 2nd-admin
 *      approval.
 *
 *   canSeeBasePrice(userId) — should this user see the BASE / LANDED
 *     cost (lc_ngn_per_yard, the import cost shown in Inventory
 *     Details to Design Wise)? Phase 1: admin only. Stays restrictive
 *     forever; Phase 3 may grant finance/management dept only.
 *
 * No external dependencies beyond `auth`. Importing this service has
 * effectively zero cost and the helpers are sync; safe to call inside
 * tight rendering loops.
 *
 * Phase 2 / Phase 3 — both functions accept an optional `ctx` arg
 * (reserved) so callers can pass {department, surface, design} once we
 * need fine-grained gating without churning every callsite again.
 */

const auth = require('../middlewares/auth');

function canSeeSalePrice(userId /* , ctx */) {
  return auth.isAdmin(String(userId));
}

function canSeeBasePrice(userId /* , ctx */) {
  return auth.isAdmin(String(userId));
}

// ---------------------------------------------------------------------------
// Pure data helpers (no I/O, smoke-testable)
// ---------------------------------------------------------------------------

/**
 * Resolve latest non-zero PricePerYard for a (design, shade?) view.
 *
 * Convention: take the inventory rows in repository order, drop zeros,
 * return the LAST non-zero. update_price rewrites all matching rows
 * uniformly so in the common case every non-zero is identical; `mixed`
 * is the defensive flag for the rare case they aren't.
 *
 * @returns {{price:number, mixed:boolean}}
 */
function resolveSalePrice(rows, design, shade /* optional — when omitted matches any shade */) {
  const designUC = String(design || '').trim().toUpperCase();
  const shadeUC = (shade == null || shade === '') ? null : String(shade).trim().toUpperCase();
  const prices = [];
  for (const r of rows) {
    if (String(r.design || '').trim().toUpperCase() !== designUC) continue;
    if (shadeUC != null && String(r.shade || '').trim().toUpperCase() !== shadeUC) continue;
    const p = Number(r.pricePerYard);
    if (Number.isFinite(p) && p > 0) prices.push(p);
  }
  if (!prices.length) return { price: 0, mixed: false };
  return { price: prices[prices.length - 1], mixed: new Set(prices).size > 1 };
}

/**
 * For each design, resolve the BASE (= landed cost) NGN/yard from the
 * most-recent FINALIZED GRN attached to that design's inventory rows.
 *
 * @param {Array<{design:string, grn_id?:string}>} items   inventory rows
 * @param {Array<{grn_id:string, lc_status:string, lc_ngn_per_yard:number, received_at:string}>} grns
 * @returns {Map<string, {lcNgn:number, receivedAt:string, grnId:string}|null>}  keyed by UPPER(design)
 */
function resolveBasePriceByDesign(items, grns) {
  const finalizedById = new Map();
  for (const g of grns) {
    if (g.lc_status !== 'finalized') continue;
    const lc = Number(g.lc_ngn_per_yard);
    if (!(lc > 0)) continue;
    finalizedById.set(g.grn_id, {
      lcNgn: lc,
      receivedAt: g.received_at || '',
      grnId: g.grn_id,
    });
  }
  const byDesign = new Map();
  for (const r of items) {
    const key = String(r.design || 'Unknown').toUpperCase();
    if (!byDesign.has(key)) byDesign.set(key, null);
    const fg = r.grn_id ? finalizedById.get(r.grn_id) : null;
    if (!fg) continue;
    const cur = byDesign.get(key);
    if (!cur || (fg.receivedAt && fg.receivedAt > cur.receivedAt)) {
      byDesign.set(key, fg);
    }
  }
  return byDesign;
}

module.exports = {
  canSeeSalePrice,
  canSeeBasePrice,
  resolveSalePrice,
  resolveBasePriceByDesign,
};
