'use strict';

/**
 * BANK-3 (owner 23-Aug-2026) — one place that decides what a BANK_LIST
 * entry means.
 *
 * BANK-2 made "BANK — ACCOUNT" one entry so two accounts at one bank stay
 * distinguishable at sale approval. Skipping the account step needed the
 * typed word `skip`, so the Office user typed the bank name twice and the
 * list gained "OPAY — OPAY": a bank pretending to be an account under
 * itself. Owner: "OPAY is a Bank addition, not an account under a bank."
 *
 * Rules, applied wherever an entry is written or compared:
 *   - "X — X" (any spacing/case) IS the plain bank "X".
 *   - An empty account half is the plain bank.
 *   - Comparison is case/space-insensitive so "Zenith — AFP" equals
 *     "ZENITH — AFP".
 */

/** Case/space-insensitive comparison key. */
function key(v) {
  return String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, ' ');
}

/** Split an entry into { bank, account } — account '' for a plain bank. */
function parse(entry) {
  const raw = String(entry == null ? '' : entry).trim();
  // The separator BANK-2 writes is an em dash; tolerate a hyphen too.
  const m = raw.match(/^(.*?)\s+[—-]\s+(.*)$/);
  if (!m) return { bank: raw, account: '' };
  return { bank: m[1].trim(), account: m[2].trim() };
}

/**
 * Canonical stored form: collapses "X — X" and an empty account half to
 * the plain bank; otherwise returns the entry trimmed as written.
 */
function normalize(entry) {
  const { bank, account } = parse(entry);
  if (!bank) return '';
  if (!account || key(account) === key(bank)) return bank;
  return `${bank} — ${account}`;
}

/** Do two entries mean the same destination? */
function same(a, b) {
  return key(normalize(a)) === key(normalize(b)) && key(normalize(a)) !== '';
}

module.exports = { parse, normalize, same, key };
