'use strict';

/**
 * baleIdentity — STK-E1 (owner-approved plan, specs/DATA-INTEGRITY_PLAN.md §3).
 *
 * THE one answer to "are these two rows the same physical bale?".
 *
 * The 07-Aug audit found NINETEEN separate definitions across five
 * families — some container-blind, some case-sensitive, some trimming,
 * some preferring baleUid (which is per-THAN on legacy rows, the "223
 * bales" inflation). Every divergence was a place two screens could
 * disagree about the same goods. They all collapse into this module.
 *
 * The canonical identity (BUSINESS_RULES §1/§5/§6d):
 *
 *     design | printed number | container   — trimmed, uppercased
 *
 * because the printed number is the only user-facing key, it legitimately
 * recycles across arrivals, and the container is what tells two such
 * physical bales apart. Rows with NO printed number fall back to their
 * baleUid (kept distinct, never merged into a phantom shared bale).
 *
 * WHAT THIS IS NOT: a lookup index. Typed-entry preloads that resolve a
 * BARE number the user typed ("sell package 507") key their maps by
 * warehouse|number on purpose — the user supplies no design or container
 * to look up by. Those are search indexes, not identity, and collisions
 * there are handled by disambiguation (12e), not by this key.
 */

const str = (v) => String(v == null ? '' : v).trim();
const upper = (v) => str(v).toUpperCase();

/**
 * Canonical key for one physical bale, from raw parts.
 * @param {string} design @param {string|number} packageNo
 * @param {string} [container] arrival batch label
 * @returns {string}
 */
function baleKeyOf(design, packageNo, container) {
  return `pkg:${upper(design)}|${upper(packageNo)}|${upper(container)}`;
}

/**
 * Canonical key for an Inventory-shaped row (one row = one than).
 * @param {{design?:string, packageNo?:string|number, arrivalBatch?:string, baleUid?:string}} r
 * @returns {string}
 */
function baleKey(r) {
  if (!r) return 'row';
  if (str(r.packageNo)) return baleKeyOf(r.design, r.packageNo, r.arrivalBatch);
  // No printed number: the per-row uid keeps unnumbered rows DISTINCT
  // (merging them into one phantom bale hides stock; splitting a real
  // bale is the lesser harm and matches the pre-STK-E1 fallback).
  return r.baleUid ? `uid:${str(r.baleUid)}` : 'row';
}

/**
 * Container-blind pair — design|number. ONLY for matching against records
 * whose container was frozen at write time and may lag a later backfill
 * (SEN-1 C1 does this); never for counting.
 */
function looseKey(design, packageNo) {
  return `${upper(design)}|${upper(packageNo)}`;
}

/** Canonical key for one than within its bale. */
function thanKey(r) {
  return `${baleKey(r)}|#${str(r && r.thanNo)}`;
}

/** Distinct physical bales in a row set. */
function baleCount(rows) {
  return new Set((rows || []).map(baleKey)).size;
}

module.exports = { baleKey, baleKeyOf, looseKey, thanKey, baleCount };
