'use strict';

/**
 * baleNumberMatch — which bales a typed or label-read number stands for.
 *
 * BUSINESS_RULES §1: the printed bale number is the only key. A bale whose
 * number IS the number wins outright: when one is on record — any store,
 * any status — a longer number that merely ENDS in the same digits is never
 * considered, so 832 cannot stand for 1832 (the caller reports an exact
 * bale that is sold or on the road with its own reason instead). The
 * ending match stays as the fallback for a number no bale carries exactly.
 *
 * Pure: no sheet, no session. The list handed in must hold EVERY bale on
 * record, not only the available ones — a caller that pre-filters to
 * available stock hides the exact bale and lets the longer number back in.
 * Availability is the caller's filter, applied to what comes back.
 *
 * Shared by the typed transfer line (`transferFlow.typedHits`), the
 * label-photo sale door (`snapSaleFlow.matchBales`) and the typed Sell Bale
 * preload (`sellBaleFlow.startWithBales`).
 */

/** Digits only — how two bale numbers are compared (P832 is 832). */
function digitsOf(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

/**
 * The bales whose number IS the given one.
 * @param {Array<{packageNo:string}>} bales every bale on record
 * @param {string|number} number the number typed or read
 * @returns {Array<object>} in the order given
 */
function exactBales(bales, number) {
  const digits = digitsOf(number);
  if (!digits) return [];
  return (bales || []).filter((b) => digitsOf(b.packageNo) === digits);
}

/**
 * The bales one number stands for: the exact ones when any exist, else the
 * ones whose number ends in those digits.
 * @param {Array<{packageNo:string}>} bales every bale on record
 * @param {string|number} number the number typed or read
 * @returns {Array<object>} in the order given; empty when the number has no digits
 */
function balesForNumber(bales, number) {
  const digits = digitsOf(number);
  if (!digits) return [];
  const exact = exactBales(bales, digits);
  if (exact.length) return exact;
  return (bales || []).filter((b) => String(b.packageNo).toUpperCase().endsWith(digits));
}

module.exports = { balesForNumber, exactBales };
