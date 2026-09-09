/**
 * Centralized number / money / quantity formatting.
 *
 * Replaces seven duplicate `fmtMoney` (and four `fmtQty`) definitions that
 * had drifted across controllers, services, AI helpers, and commands.
 *
 * CUR-1 (09-Sep-2026): money now has ONE home, `src/utils/money.js`, with a
 * side-A (`expense` → `₦12,345`) and a side-B (`sale` → `12,345`,
 * `saleRate` → `1,450/yd`) entry point. The three currency helpers here are
 * behaviour-identical SHIMS over that module for the duration of the sweep
 * and are deleted in its last step (CUR-1 §8 step 9):
 *
 *   fmtMoney(1500)         → "NGN 1,500"   ← code + space + locale digits
 *   fmtMoneyShort(1500)    → "₦1,500"      ← symbol + locale digits, no gap
 *
 * `fmtQty` (bare digits, ≈230 callers) stays here and is untouched.
 */

const money = require('./money');

/** @deprecated CUR-1 — use `money.code()`; deleted with the shims. */
const DEFAULT_CURRENCY = money.code();

// CUR-1: the naira symbol is NOT spelled here — it comes from money.js, the
// one file on the sales side that may carry it. The other symbols only ever
// served a per-user currency idea that never shipped (ROADMAP §7 D12).
const SYMBOLS = {
  NGN: money.NAIRA,
  USD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
  KES: 'KSh',
  ZAR: 'R',
};

/**
 * Return the visual symbol for a currency code. Unknown codes fall back to
 * `"<CODE> "` (trailing space) so concatenation still produces a readable
 * "USD 1,500" / "AED 1,500" style instead of "USD1,500".
 *
 * @deprecated CUR-1 — the sales side prints no symbol (`money.sale`), the
 * expense side prints `₦` (`money.expense`). Deleted with the sweep.
 */
function currencySymbol(code) {
  return SYMBOLS[code] || `${code} `;
}

function _localeNumber(n, maxFraction = 0) {
  return Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: maxFraction });
}

/**
 * Long form: "NGN 1,500" — used for reports, list rows, financial summaries.
 *
 * @deprecated CUR-1 — side B is `money.sale(n)` (bare); the accounting code
 * is `money.code()` for narrations only. Shim: `<code> <money.sale(n)>`.
 */
function fmtMoney(n, currency = DEFAULT_CURRENCY) {
  return `${currency} ${money.sale(n)}`;
}

/**
 * Compact form: "₦1,500" — used for DMs, inline status lines, and any spot
 * where horizontal space is at a premium. Falls back to "USD 1,500" style
 * when no symbol is registered for the code.
 *
 * @deprecated CUR-1 — side A is `money.expense(n)` (`₦1,500`), side B is
 * `money.sale(n)` (`1,500`). Shim: for the naira code this IS
 * `money.expense(n)`; other codes keep the symbol table above.
 */
function fmtMoneyShort(n, currency = DEFAULT_CURRENCY) {
  if (currency === 'NGN') return money.expense(n);
  return `${currencySymbol(currency)}${money.sale(n)}`;
}

/** Generic quantity formatter; integer by default, set maxFraction for decimals. */
function fmtQty(n, opts = {}) {
  const { maxFraction = 0 } = opts;
  return _localeNumber(n, maxFraction);
}

module.exports = {
  DEFAULT_CURRENCY,
  CURRENCY: DEFAULT_CURRENCY,
  currencySymbol,
  fmtMoney,
  fmtMoneyShort,
  fmtQty,
};
