'use strict';

/**
 * FIX-BANKLEDGER — which money account a received payment is booked to.
 *
 * The sale approval wizard's bank chip stores `Paid to <bank>` (one chip per
 * bank in Settings BANK_LIST). The ledger used to send a payment to the Bank
 * account only when its mode text contained the word "bank", so
 * `Paid to Zenith`, `Paid to GTB`, `Paid to Opay` were booked to Cash
 * (request R-9BF6: 3,750 landed in Cash; bale-yards check item A6).
 *
 * The rule, in `accountingService.paymentAccountFor` — the one place a mode
 * becomes Cash or Bank:
 *   - the word "bank" anywhere            → Bank (the rule before, kept)
 *   - `Cash` (also `Paid to cash`)        → Cash
 *   - the wizard's `Paid to <bank>` shape → Bank
 *   - names a bank on Settings BANK_LIST  → Bank (case-insensitive, whole words)
 *   - anything else                       → Cash (the rule before, kept)
 *
 * The stored mode text is never changed and no existing row is rewritten.
 * Every repository reached is monkeypatched — no sheet, no Telegram.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const accountingService = require('../../../src/services/accountingService');
const ledgerRepo = require('../../../src/repositories/ledgerRepository');
const chartRepo = require('../../../src/repositories/chartOfAccountsRepository');
const settingsRepository = require('../../../src/repositories/settingsRepository');

// The Settings cell as the owner keeps it: bare banks, one bank whose own
// name carries the word, and a BANK-2 "BANK — ACCOUNT" entry.
const BANK_LIST = 'Zenith,GTB,Opay,Access Bank,Moniepoint — AFP LTD';
const BANKS = BANK_LIST.split(',').map((b) => b.trim());

const CHART = { cash: '1001', bank: '1002', 'customer receivable': '1100' };

let appended;
test.beforeEach(() => {
  appended = [];
  chartRepo.findByName = async (name) => {
    const code = CHART[String(name).toLowerCase()];
    return code ? { account_code: code, account_name: name } : null;
  };
  ledgerRepo.appendPair = async (debit, credit) => { appended.push(debit, credit); };
  ledgerRepo.append = async (row) => { appended.push(row); };
  settingsRepository.getAll = async () => ({ BANK_LIST });
});

const account = (mode, banks = BANKS) => accountingService.paymentAccountFor(mode, banks);

test('a mode naming a bank on BANK_LIST is Bank: Zenith, GTB, Opay, Access Bank', () => {
  for (const mode of ['Zenith', 'GTB', 'Opay', 'Access Bank']) {
    assert.equal(account(mode), 'Bank', mode);
  }
});

test('the wizard chip\'s stored shape `Paid to <bank>` is Bank', () => {
  for (const mode of ['Paid to Zenith', 'Paid to GTB', 'Paid to Opay', 'Paid to Access Bank', 'Paid to Moniepoint — AFP LTD']) {
    assert.equal(account(mode), 'Bank', mode);
  }
});

test('the Payment Received door\'s stored shape `Bank — <name>` stays Bank', () => {
  assert.equal(account('Bank — Zenith'), 'Bank');
  assert.equal(account('Bank — Moniepoint — AFP LTD'), 'Bank');
});

test('Cash stays Cash, however it is cased or wrapped', () => {
  for (const mode of ['Cash', 'cash', 'CASH', '  Cash  ', 'Paid to cash']) {
    assert.equal(account(mode), 'Cash', mode);
  }
});

test('Not yet paid / Credit / an empty mode are never Bank', () => {
  for (const mode of ['Not yet paid', 'not yet paid', 'Credit', '', null, undefined]) {
    assert.equal(account(mode), 'Cash', String(mode));
  }
});

test('mixed case and extra spaces still name the bank', () => {
  for (const mode of ['zenith', 'ZENITH', 'pAiD  tO   zEnItH', 'opay', 'gtb', 'access bank', 'PAID TO OPAY']) {
    assert.equal(account(mode), 'Bank', mode);
  }
});

test('a "BANK — ACCOUNT" entry is named by its bank half or the whole entry', () => {
  assert.equal(account('Moniepoint'), 'Bank');
  assert.equal(account('moniepoint — afp ltd'), 'Bank');
  assert.equal(account('Moniepoint transfer'), 'Bank', 'the bank named inside a longer free text');
});

test('a bank NOT on the list: bare free text keeps the rule before (Cash); the wizard shape is Bank', () => {
  assert.equal(account('Kuda'), 'Cash');
  assert.equal(account('Transfer'), 'Cash');
  assert.equal(account('transfer'), 'Cash', 'the typed line\'s third word, as before');
  assert.equal(account('Paid to Kuda'), 'Bank');
  assert.equal(account('Kuda Bank'), 'Bank', 'the word bank, as before');
  assert.equal(account('bank'), 'Bank', 'the typed line\'s first word, as before');
});

test('a listed bank matches whole words only', () => {
  assert.equal(account('Cuba', ['UBA']), 'Cash');
  assert.equal(account('UBA', ['UBA']), 'Bank');
  assert.equal(account('GTBx', ['GTB']), 'Cash');
});

test('with no readable BANK_LIST the rule before stands; the wizard shape needs no list', () => {
  // Called directly: the helper above would default a missing list to BANKS.
  const bare = accountingService.paymentAccountFor;
  for (const banks of [[], null, undefined, 'Zenith']) {
    assert.equal(bare('Zenith', banks), 'Cash');
    assert.equal(bare('GTBank', banks), 'Bank');
    assert.equal(bare('Paid to Zenith', banks), 'Bank');
    assert.equal(bare('Cash', banks), 'Cash');
  }
  assert.equal(bare('Zenith'), 'Cash', 'no list argument at all');
});

test('recordPaymentReceived: the R-9BF6 shape — `Paid to Zenith` 3,750 is debited to Bank (1002), credited to the receivable', async () => {
  await accountingService.recordPaymentReceived({ customer: 'Ayubal Ansari', customerId: 'CUST-9', amount: 3750, method: 'Paid to Zenith', userId: '777', txnId: 'R-9BF6-PAY' });
  assert.equal(appended.length, 2);
  const [debit, credit] = appended;
  assert.deepEqual([debit.ledger_name, debit.account_code, debit.debit], ['Bank', '1002', 3750]);
  assert.deepEqual([credit.ledger_name, credit.account_code, credit.credit], ['Customer Receivable', '1100', 3750]);
  assert.equal(debit.txn_id, 'R-9BF6-PAY');
  assert.equal(debit.customer_id, 'CUST-9');
  assert.match(debit.narration, /^Payment received from Ayubal Ansari: NGN 3750 via Bank$/);
});

test('recordPaymentReceived: each bank chip on BANK_LIST reaches Bank; Cash reaches Cash (1001)', async () => {
  for (const mode of ['Paid to GTB', 'Paid to Opay', 'Opay', 'Bank — Zenith', 'Access Bank']) {
    appended = [];
    await accountingService.recordPaymentReceived({ customer: 'ABBA', amount: 100, method: mode });
    assert.deepEqual([appended[0].ledger_name, appended[0].account_code], ['Bank', '1002'], mode);
  }
  appended = [];
  await accountingService.recordPaymentReceived({ customer: 'ABBA', amount: 100, method: 'Cash' });
  assert.deepEqual([appended[0].ledger_name, appended[0].account_code], ['Cash', '1001']);
  assert.match(appended[0].narration, /via Cash$/);
});

test('recordPaymentReceived: Not yet paid carries no amount and books nothing', async () => {
  await accountingService.recordPaymentReceived({ customer: 'ABBA', amount: 0, method: 'Not yet paid' });
  await accountingService.recordPaymentReceived({ customer: 'ABBA', method: 'Not yet paid' });
  assert.equal(appended.length, 0);
});

test('recordPaymentReceived: a BANK_LIST read that throws falls back to the rule before — it never throws', async () => {
  settingsRepository.getAll = async () => { throw new Error('Sheets unavailable'); };
  await accountingService.recordPaymentReceived({ customer: 'ABBA', amount: 100, method: 'Zenith' });
  assert.equal(appended[0].ledger_name, 'Cash', 'a bare name cannot be recognised without the list');
  appended = [];
  await accountingService.recordPaymentReceived({ customer: 'ABBA', amount: 100, method: 'GTBank' });
  assert.equal(appended[0].ledger_name, 'Bank');
  appended = [];
  await accountingService.recordPaymentReceived({ customer: 'ABBA', amount: 100, method: 'Paid to Zenith' });
  assert.equal(appended[0].ledger_name, 'Bank', 'the wizard shape needs no list');
});

test('recordPaymentReceived: a Settings map without BANK_LIST (or a null map) is an empty list, not a crash', async () => {
  for (const all of [{}, null, { BANK_LIST: '' }]) {
    settingsRepository.getAll = async () => all;
    appended = [];
    await accountingService.recordPaymentReceived({ customer: 'ABBA', amount: 100, method: 'Opay' });
    assert.equal(appended[0].ledger_name, 'Cash');
  }
});

test('recordPaymentReceived: a chart with no Bank row still gives a Bank payment the Bank code, never the Cash code', async () => {
  chartRepo.findByName = async () => null;
  await accountingService.recordPaymentReceived({ customer: 'ABBA', amount: 100, method: 'Paid to Zenith' });
  assert.deepEqual([appended[0].ledger_name, appended[0].account_code], ['Bank', '1002']);
  appended = [];
  await accountingService.recordPaymentReceived({ customer: 'ABBA', amount: 100, method: 'Cash' });
  assert.deepEqual([appended[0].ledger_name, appended[0].account_code], ['Cash', '1001']);
});
