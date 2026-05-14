/**
 * Centralized number / money / quantity formatting.
 *
 * Replaces seven duplicate `fmtMoney` (and four `fmtQty`) definitions that
 * had drifted across controllers, services, AI helpers, and commands.
 *
 * Two presentation forms are exposed so the same number can be rendered
 * for both reports (long form) and DMs / inline rows (compact form):
 *
 *   fmtMoney(1500)         → "NGN 1,500"   ← code + space + locale digits
 *   fmtMoneyShort(1500)    → "₦1,500"      ← symbol + locale digits, no gap
 *
 * Both accept an optional currency code so per-user currency preferences
 * (ROADMAP §7 Decision 12) can flow through later without a second sweep.
 */

const config = require('../config');

const DEFAULT_CURRENCY = (config && config.currency) || 'NGN';

const SYMBOLS = {
  NGN: '₦',
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
 */
function currencySymbol(code) {
  return SYMBOLS[code] || `${code} `;
}

function _localeNumber(n, maxFraction = 0) {
  return Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: maxFraction });
}

/** Long form: "NGN 1,500" — used for reports, list rows, financial summaries. */
function fmtMoney(n, currency = DEFAULT_CURRENCY) {
  return `${currency} ${_localeNumber(n)}`;
}

/**
 * Compact form: "₦1,500" — used for DMs, inline status lines, and any spot
 * where horizontal space is at a premium. Falls back to "USD 1,500" style
 * when no symbol is registered for the code.
 */
function fmtMoneyShort(n, currency = DEFAULT_CURRENCY) {
  return `${currencySymbol(currency)}${_localeNumber(n)}`;
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
