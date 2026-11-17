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

/**
 * BANK-4 (owner, 17-Nov-2026: "I have 2 accounts in zenith bank whose
 * abbreviation needs to be used to capture the payment in particular
 * account for accounting") — the list GROUPED BY BANK, banks in the order
 * they first appear, each with the accounts registered under it.
 *
 * `plain` says the bank is also listed on its own (`Zenith`), which is what
 * the payee-bank picker needs; `entry` is the account's registered text
 * (`Zenith — AFP`), which is what a payment mode stores.
 *
 * Pure. @param {string[]} entries  the Settings BANK_LIST as an array
 * @returns {Array<{bank:string, plain:boolean, accounts:Array<{account:string, entry:string}>}>}
 */
function group(entries) {
  const out = [];
  const byBank = new Map();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = normalize(raw);
    if (!entry) continue;
    const { bank, account } = parse(entry);
    let g = byBank.get(key(bank));
    if (!g) {
      g = { bank, plain: false, accounts: [] };
      byBank.set(key(bank), g);
      out.push(g);
    }
    if (!account) { g.plain = true; continue; }
    if (!g.accounts.some((a) => key(a.account) === key(account))) g.accounts.push({ account, entry });
  }
  return out;
}

/** Each bank once, by name — for a screen that asks "which bank?" of a payee. */
function banksOnly(entries) {
  return group(entries).map((g) => g.bank);
}

/**
 * What tapping a bank's chip means: nothing registered under it → the bank
 * itself; ONE account → that account, without asking (one-option rule);
 * two or more → the caller must ask which.
 * @returns {{dest:string}|{ask:true}}
 */
function choiceFor(g) {
  if (!g) return { dest: '' };
  if (g.accounts.length >= 2) return { ask: true };
  return { dest: g.accounts.length === 1 ? g.accounts[0].entry : g.bank };
}

/** Upper-cased words, for whole-word comparison ("ZENITH — AFP" → "ZENITH AFP"). */
function words(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A mode's destination text: `Paid to X` / `Bank — X` → { rest: 'X', stripped: true }. */
function destText(method) {
  const raw = String(method == null ? '' : method).trim();
  const m = /^(?:paid\s+to\s+|bank\s*[—:-]\s*)(.+)$/i.exec(raw);
  return m ? { rest: m[1].trim(), stripped: true } : { rest: raw, stripped: false };
}

/**
 * Read a typed destination against the registered list.
 *   { entry }  it names one registered destination (returned as registered)
 *   { ask }    it names a bank that holds two or more accounts and no account
 *   {}         it names nothing on the list
 * "Zenith AFP" (no dash) and "zenith — afp" both find `Zenith — AFP`.
 */
function resolve(text, entries) {
  const want = words(text);
  if (!want) return {};
  const groups = group(entries);
  for (const g of groups) {
    for (const a of g.accounts) {
      if (words(a.entry) === want) return { entry: a.entry, group: g };
    }
  }
  const g = groups.find((x) => words(x.bank) === want);
  if (!g) return {};
  const c = choiceFor(g);
  return c.ask ? { ask: true, group: g } : { entry: c.dest, group: g };
}

/**
 * BANK-4 — the account a BANK payment landed in, for the ledger's
 * `bank_account` cell. Reads the stored mode; never rewrites it and never
 * guesses an account the text does not name:
 *
 *   `Paid to Zenith — AFP`, `Bank — Zenith — AFP`  → `Zenith — AFP`
 *   `Paid to GTBank`                               → `GTBank`
 *   `Paid to Zenith` (two accounts under it)       → `Zenith` (bank known,
 *                                                    account not)
 *   free text naming a registered account / bank   → that account / bank
 *   `Paid to <anything else>`                      → the text as written
 *   anything else (`bank transfer`)                → ''
 *
 * Pure. @param {string} method  @param {string[]} entries
 */
function destinationOf(method, entries) {
  const { rest, stripped } = destText(method);
  if (!rest) return '';
  const groups = group(entries);
  const want = words(rest);
  const padded = ` ${want} `;
  // an account named in full wins over its bank alone; longest name first
  const named = groups.flatMap((g) => g.accounts.map((a) => a.entry))
    .sort((a, b) => words(b).length - words(a).length);
  for (const e of named) {
    if (padded.includes(` ${words(e)} `)) return e;
  }
  const banks = groups.map((g) => g.bank).sort((a, b) => words(b).length - words(a).length);
  for (const b of banks) {
    if (words(b) && padded.includes(` ${words(b)} `)) return b;
  }
  return stripped ? rest.replace(/\s+/g, ' ').slice(0, 60) : '';
}

/*
 * ── The CUSTOMER'S copy ──────────────────────────────────────────────────
 *
 * Owner, 17-Nov-2026, on the invoice naming the account ("paid to Zenith —
 * AFP account"): "No need for customer copy to show bank account details.
 * Let it be same as before, plain and simple."
 *
 * Which of the company's accounts received a payment is an ACCOUNTING fact
 * (the ledger's narration and `bank_account` cell, the Transactions row,
 * the admin's cards). Anything a customer reads — the invoice PDF, its web
 * copy, the customer's web ledger — names the BANK alone, exactly as it did
 * before BANK-4. These three helpers are that boundary. They read the SHAPE
 * of the text (`BANK — ACCOUNT`), never the current bank list, so a
 * document issued today still hides the account after the list changes.
 */

/** `Zenith — AFP` → `Zenith`; a plain bank is returned as it is. */
function publicBank(entry) {
  return parse(entry).bank;
}

/**
 * A stored payment mode in the customer's words:
 *   `Paid to Zenith — AFP` → `Paid to Zenith`
 *   `Bank — Zenith — AFP`  → `Bank — Zenith`
 *   `Cash`, `Not yet paid`, `Paid to GTBank`, free text → unchanged
 */
function publicMode(mode) {
  const raw = String(mode == null ? '' : mode).trim();
  const m = /^(paid\s+to\s+|bank\s*[—:-]\s*)(.+)$/i.exec(raw);
  if (!m) return raw;
  return `${m[1]}${publicBank(m[2])}`;
}

/**
 * A ledger narration in the customer's words — the two templates
 * accountingService writes, anchored on the entry type:
 *   `Payment received from ABBA: NGN 50000 via Bank · Zenith — AFP`
 *       → `Payment received from ABBA: NGN 50000 via Bank`
 *   `Sale: … to ABBA | Paid to Zenith — AFP NGN 5000`
 *       → `Sale: … to ABBA | Paid to Zenith NGN 5000`
 * Anything else is returned untouched.
 */
function publicNarration(narration) {
  const s = String(narration == null ? '' : narration);
  if (/^Payment received from/i.test(s)) return s.replace(/(\svia\s+Bank)\s+·\s.*$/i, '$1');
  if (/^Sale:/i.test(s)) {
    const cut = s.lastIndexOf(' | ');
    if (cut === -1) return s;
    const m = /^(.*?)(\s+[A-Z]{3}\s+[\d.,]+)?$/.exec(s.slice(cut + 3));
    return `${s.slice(0, cut)} | ${publicMode(m[1])}${m[2] || ''}`;
  }
  return s;
}

module.exports = {
  parse, normalize, same, key, group, banksOnly, choiceFor, resolve, destinationOf, words,
  publicBank, publicMode, publicNarration,
};
