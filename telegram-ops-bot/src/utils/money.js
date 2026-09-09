'use strict';

/**
 * CUR-1 — the one money module (BUSINESS_RULES §17, CUR-1 §4.1).
 *
 * Every caller states which SIDE of the books it is printing for, so the
 * S-CUR smoke lint can prove the two sides cannot drift into each other:
 *
 *   Side A — money LEAVING the office (cash book, payment requests, task
 *            incentives, the finance reports). Always the naira symbol,
 *            never the env:                     expense(12345) → '₦12,345'
 *   Side B — a SALE document or the printed result of an approval that
 *            writes the Inventory sheet (rates, stock values, credits at a
 *            booked rate). Bare number, no symbol, no unit:
 *                                              sale(12345)    → '12,345'
 *                                              saleRate(1450) → '1,450/yd'
 *
 * The symbol `₦` appears in `src/` in exactly this file and the side-A
 * allowlist (see `scripts/smoke.js` S-CUR). Side B never prints a unit at
 * all: the owner's 09-Sep-2026 multiplier ruling superseded the once-printed
 * label (CUR-1 R14) — a customer copy is converted by the CUR-2 rate
 * multiplier, not labelled. `saleHeader()` / `saleLegend()` stay as the one
 * seam every table header and report legend goes through, so a label could
 * be reintroduced in one place; today they print no unit.
 *
 * Grouping is `en-NG` on both sides — a digit style, not a currency label.
 * `fraction` is the exact number of decimals printed (fixed, not "up to"):
 * integers by default; `fraction: 2` where a caller prints kobo / a
 * fractional rate (landed cost, the 2-dp customer-copy rate of CUR-2).
 *
 * `code()` is the accounting CODE (`CURRENCY`, default `NGN`) — for ledger
 * narrations, the FX pair's quote leg and incentive rows only. It is never
 * a display unit.
 */

const config = require('../config');

const LOCALE = 'en-NG';

/** The naira symbol — the only place it is spelled outside the side-A files. */
const NAIRA = '₦';

/** Clamp `fraction` to a sane fixed-decimal count. */
function _dp(fraction) {
  const f = Number(fraction);
  if (!Number.isFinite(f) || f < 0) return 0;
  return Math.min(20, Math.floor(f));
}

/**
 * Locale digits with a FIXED number of decimals; garbage → 0. A figure
 * that rounds to zero at `fraction` prints unsigned: `-0` (Math.round of a
 * small negative balance) and `-0.4` at 0 dp both print `0`, never `-0`.
 */
function _digits(n, fraction) {
  const v = Number(n);
  const safe = Number.isFinite(v) ? v : 0;
  const dp = _dp(fraction);
  const s = safe.toLocaleString(LOCALE, { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return /^-0(?:\.0+)?$/.test(s) ? s.slice(1) : s;
}

/**
 * Side A — an expense figure: literal `₦`, `en-NG` grouping.
 *   expense(12345)                 → '₦12,345'
 *   expense(1512.5, { fraction: 2 }) → '₦1,512.50'
 */
function expense(n, opts = {}) {
  const { fraction = 0 } = opts || {};
  return `${NAIRA}${_digits(n, fraction)}`;
}

/**
 * Side B — a sale / inventory figure: bare, `en-NG` grouping, no unit.
 *   sale(12345)                    → '12,345'
 *   sale(4000, { fraction: 2 })    → '4,000.00'
 */
function sale(n, opts = {}) {
  const { fraction = 0 } = opts || {};
  return _digits(n, fraction);
}

/**
 * Side B — a rate with its divisor named, bare.
 *   saleRate(1450)                 → '1,450/yd'
 *   saleRate(4000, { fraction: 2 }) → '4,000.00/yd'
 * `per` names the divisor (default `yd`).
 */
function saleRate(n, opts = {}) {
  const { fraction = 0, per = 'yd' } = opts || {};
  return `${_digits(n, fraction)}/${per}`;
}

/**
 * Column-header composer for side-B tables (invoice `COST` / `PAYMENTS`,
 * the web copy's `Rate` / `Cost`). Returns the bare word: no unit is printed
 * on the sales side (owner, 09-Sep-2026). Kept so every header goes through
 * one seam.
 *   saleHeader('COST') → 'COST'
 */
function saleHeader(word) {
  return String(word ?? '').trim();
}

/**
 * The one legend line a side-B report may carry. Empty: side B carries no
 * unit (owner, 09-Sep-2026). Callers must omit the fragment when it is ''.
 *   saleLegend() → ''
 */
function saleLegend() {
  return '';
}

/**
 * The accounting code — `CURRENCY` from the env, `NGN` when unset or blank.
 * For narrations, the FX pair and incentive rows; never printed as a unit.
 *   code() → 'NGN'
 */
function code() {
  const c = config && config.currency;
  const s = (c == null ? '' : String(c)).trim();
  return s || 'NGN';
}

module.exports = { NAIRA, expense, sale, saleRate, saleHeader, saleLegend, code };
