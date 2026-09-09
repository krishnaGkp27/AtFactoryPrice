/**
 * Centralized number / quantity formatting.
 *
 * CUR-1 (09-Sep-2026): money has ONE home, `src/utils/money.js`, with a
 * side-A (`expense` → `₦12,345`) and a side-B (`sale` → `12,345`,
 * `saleRate` → `1,450/yd`) entry point. The currency shims that lived here
 * during the sweep (`fmtMoneyShort`, `currencySymbol`, `DEFAULT_CURRENCY`)
 * were deleted at the sweep's last step; `fmtMoney` survives for the two
 * R5a reports only. `fmtQty` (bare digits, ≈230 callers) is untouched.
 */

const money = require('./money');

function _localeNumber(n, maxFraction = 0) {
  return Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: maxFraction });
}

/**
 * Long form: "NGN 1,500" — the accounting code + locale digits.
 *
 * CUR-1 step 9: kept ONLY for the two book-keeping reports the owner ruled
 * stay as today (R5a — the daybook and the trial balance in the controller).
 * Every other money surface uses `money.sale` / `money.saleRate` (side B,
 * bare) or `money.expense` (side A, ₦). Do not add callers.
 */
function fmtMoney(n, currency = money.code()) {
  return `${currency} ${money.sale(n)}`;
}

/** Generic quantity formatter; integer by default, set maxFraction for decimals. */
function fmtQty(n, opts = {}) {
  const { maxFraction = 0 } = opts;
  return _localeNumber(n, maxFraction);
}

module.exports = {
  fmtMoney,
  fmtQty,
};
