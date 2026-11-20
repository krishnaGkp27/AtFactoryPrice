'use strict';

/**
 * rateInput — the one reader of a typed rate per yard.
 *
 * Shared by the sale approval wizard's Step 2 (a single number typed for
 * every design) and RET-8's rate step on a return. A rate here may carry
 * decimals (`3.20` is a real rate when the invoice multiplier is in use),
 * so the reader keeps them. Digits and one optional decimal part only:
 * `1,450`, `1450/yd`, `-5` and words are not a rate.
 *
 * @param {string} text the typed message
 * @returns {number|null} the number, or null when the text is not one
 */
function parseRateNumber(text) {
  const t = String(text == null ? '' : text).trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

module.exports = { parseRateNumber };
