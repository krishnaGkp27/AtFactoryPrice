'use strict';

/**
 * BANK-4 (owner, 17-Nov-2026) — "I have 2 accounts in zenith bank whose
 * abbreviation needs to be used to capture the payment in particular
 * account for accounting."
 *
 * The pure half: Settings BANK_LIST grouped by bank, what a bank chip means,
 * how a typed destination is read, and which account a stored payment mode
 * names for the ledger's `bank_account` cell. Never a guess: an account the
 * text does not name is never invented.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const bankEntry = require('../../../src/utils/bankEntry');

// The list as the owner will keep it: plain banks, two accounts at Zenith,
// one bank that exists ONLY as a named account, and a BANK-3 "X — X" entry.
const LIST = ['GTBank', 'Zenith', 'Zenith — AFP', 'ZENITH — BP', 'FirstBank', 'OPAY — OPAY', 'UBA — MAIN'];

test('group: banks in first-appearance order, accounts under their bank whatever the case', () => {
  const g = bankEntry.group(LIST);
  assert.deepEqual(g.map((x) => x.bank), ['GTBank', 'Zenith', 'FirstBank', 'OPAY', 'UBA']);
  const zenith = g[1];
  assert.equal(zenith.plain, true, 'the bank is also listed on its own');
  assert.deepEqual(zenith.accounts, [
    { account: 'AFP', entry: 'Zenith — AFP' },
    { account: 'BP', entry: 'ZENITH — BP' },
  ], 'the entry is kept exactly as registered');
  assert.deepEqual(g[3], { bank: 'OPAY', plain: true, accounts: [] }, '"OPAY — OPAY" is the plain bank (BANK-3)');
  assert.deepEqual(g[4], { bank: 'UBA', plain: false, accounts: [{ account: 'MAIN', entry: 'UBA — MAIN' }] });
});

test('group: a repeated account is one account; blanks and junk are dropped', () => {
  const g = bankEntry.group(['Zenith — AFP', 'zenith  —  afp', '', '   ', null, 'Zenith - BP']);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].accounts.map((a) => a.account), ['AFP', 'BP'], 'a hyphen separator is read too');
  assert.deepEqual(bankEntry.group(undefined), []);
  assert.deepEqual(bankEntry.group('Zenith'), [], 'not an array = no banks, never a throw');
});

test('banksOnly: each bank once — the payee-bank picker never lists a company account', () => {
  assert.deepEqual(bankEntry.banksOnly(LIST), ['GTBank', 'Zenith', 'FirstBank', 'OPAY', 'UBA']);
});

test('choiceFor: no account = the bank; one account = that account unasked; two or more = ask', () => {
  const [gt, zenith, , , uba] = bankEntry.group(LIST);
  assert.deepEqual(bankEntry.choiceFor(gt), { dest: 'GTBank' });
  assert.deepEqual(bankEntry.choiceFor(uba), { dest: 'UBA — MAIN' });
  assert.deepEqual(bankEntry.choiceFor(zenith), { ask: true });
  assert.deepEqual(bankEntry.choiceFor(undefined), { dest: '' });
});

test('resolve: a typed destination is read against the list', () => {
  assert.equal(bankEntry.resolve('zenith afp', LIST).entry, 'Zenith — AFP', 'no dash needed');
  assert.equal(bankEntry.resolve('ZENITH — bp', LIST).entry, 'ZENITH — BP', 'returned as registered');
  assert.equal(bankEntry.resolve('Zenith', LIST).ask, true, 'a bank holding accounts must be asked');
  assert.equal(bankEntry.resolve('Zenith', LIST).group.bank, 'Zenith');
  assert.equal(bankEntry.resolve('uba', LIST).entry, 'UBA — MAIN', 'one account: stamped unasked');
  assert.equal(bankEntry.resolve('gtbank', LIST).entry, 'GTBank');
  assert.deepEqual(bankEntry.resolve('Moniepoint', LIST), {}, 'not on the list');
  assert.deepEqual(bankEntry.resolve('', LIST), {});
});

test('destinationOf: the account a bank payment landed in, read from the stored mode', () => {
  const cases = [
    ['Paid to Zenith — AFP', 'Zenith — AFP'],          // the wizard's account chip
    ['Bank — Zenith — BP', 'ZENITH — BP'],             // the Payment Received door
    ['Paid to zenith afp', 'Zenith — AFP'],            // typed, no dash
    ['Paid to GTBank', 'GTBank'],                      // a bank with no account under it
    ['Bank — UBA — MAIN', 'UBA — MAIN'],
    ['Paid to Zenith', 'Zenith'],                      // bank known, account not: never guessed
    ['Zenith transfer', 'Zenith'],                     // free text naming a bank
    ['Paid to Moniepoint', 'Moniepoint'],              // not on the list: as written
    ['bank transfer', ''],                             // names nothing
    ['Cash', ''],
    ['', ''],
    [null, ''],
  ];
  for (const [mode, want] of cases) {
    assert.equal(bankEntry.destinationOf(mode, LIST), want, String(mode));
  }
});

test('destinationOf: whole words only — "Zenithal" is not Zenith; an empty list still reads `Paid to X`', () => {
  assert.equal(bankEntry.destinationOf('Paid to Zenithal Trust', LIST), 'Zenithal Trust');
  assert.equal(bankEntry.destinationOf('Paid to Zenith — AFP', []), 'Zenith — AFP');
  assert.equal(bankEntry.destinationOf('Paid to Zenith — AFP', undefined), 'Zenith — AFP');
});

test('destinationOf: a long typed destination is capped, never dropped', () => {
  const long = `Paid to ${'X'.repeat(200)}`;
  assert.equal(bankEntry.destinationOf(long, LIST).length, 60);
});
