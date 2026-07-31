'use strict';

/**
 * CUS-2 — customer-entity integrity fundamentals:
 *  - customersRepository.findByName is alias-aware and husk-excluding;
 *  - getCustomerLedger scopes by stamped customer_id first (including ids
 *    of merged-away rows), then by boundary-anchored narration match — the
 *    old raw substring let "Musa" pull "Alhaji Musa"'s rows into a
 *    customer-facing statement and went blind on merged aliases.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// findByName reads through the module-internal sheet cache — seed the fake
// sheets layer BEFORE the first read so both paths see the same customers.
const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets } = require('../../helpers/controllerHarness');
const CUS_HEADERS = ['customer_id', 'name', 'phone', 'address', 'category',
  'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status',
  'created_at', 'updated_at', 'aliases'];
installFakeSheets(createFakeSheets({
  Customers: [
    CUS_HEADERS,
    ['CUST-1', 'Musa', '', '', '', 0, 0, '', '', 'Active', '', '', '["Musa Old"]'],
    ['CUST-9', 'Musa Old', '', '', '', 0, 0, '', '', 'Merged', '', '', '[]'],
    ['CUST-2', 'Alhaji Musa', '', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
    ['CUST-3', 'Bello', '', '', '', 0, 0, '', '', 'Rejected', '', '', '[]'],
  ],
}));

const customersRepository = require('../../../src/repositories/customersRepository');
const ledgerRepository = require('../../../src/repositories/ledgerRepository');
const chartRepo = require('../../../src/repositories/chartOfAccountsRepository');
const accountingService = require('../../../src/services/accountingService');

const CUSTOMERS = [
  { customer_id: 'CUST-1', name: 'Musa', status: 'Active', aliases: ['Musa Old'] },
  { customer_id: 'CUST-9', name: 'Musa Old', status: 'Merged', aliases: [] },
  { customer_id: 'CUST-2', name: 'Alhaji Musa', status: 'Active', aliases: [] },
  { customer_id: 'CUST-3', name: 'Bello', status: 'Rejected', aliases: [] },
];
customersRepository.getAll = async () => CUSTOMERS;
chartRepo.findByName = async () => null;

const ENTRIES = [
  { entry_id: 'E1', date: '2026-07-01', debit: 100, credit: 0, customer_id: 'CUST-1', narration: 'Sale: 10 yds D1  pkg P1 to Musa | Cash' },
  { entry_id: 'E2', date: '2026-07-02', debit: 200, credit: 0, customer_id: 'CUST-9', narration: 'Sale: 20 yds D1  pkg P2 to Musa Old | Cash' },
  { entry_id: 'E3', date: '2026-07-03', debit: 300, credit: 0, customer_id: '', narration: 'Sale: 30 yds D1  pkg P3 to Musa | Not yet paid' },
  { entry_id: 'E4', date: '2026-07-04', debit: 400, credit: 0, customer_id: '', narration: 'Sale: 40 yds D1  pkg P4 to Alhaji Musa | Cash' },
  { entry_id: 'E5', date: '2026-07-05', debit: 0, credit: 50, customer_id: '', narration: 'Payment received from Musa: NGN 50 via Cash' },
  { entry_id: 'E6', date: '2026-07-06', debit: 0, credit: 60, customer_id: '', narration: 'Sale: 6 yds D2  pkg P6 to Musa Old' },
  { entry_id: 'E7', date: '2026-07-07', debit: 700, credit: 0, customer_id: 'CUST-2', narration: 'Sale: 70 yds D3  pkg P7 to Alhaji Musa | Cash' },
];
ledgerRepository.findByAccount = async () => ENTRIES;

test('findByName: alias resolves to the canonical customer', async () => {
  const hit = await customersRepository.findByName('musa old');
  assert.ok(hit, 'alias must match');
  assert.equal(hit.customer_id, 'CUST-1', 'the alias lands on the canonical row, not the merged husk');
});

test('findByName: merged and rejected husks never match', async () => {
  assert.equal(await customersRepository.findByName('Bello'), null, 'rejected registration is not an existing customer');
  const canonical = await customersRepository.findByName('Musa');
  assert.equal(canonical.customer_id, 'CUST-1');
});

test('getCustomerLedger: id-scoped, alias-aware, no substring bleed', async () => {
  const out = await accountingService.getCustomerLedger('Musa');
  const ids = out.entries.map((e) => e.entry_id).sort();
  assert.deepEqual(ids, ['E1', 'E2', 'E3', 'E5', 'E6'],
    'canonical id + merged-row id + boundary narration matches (incl. alias), never Alhaji Musa');
  assert.equal(out.outstandingAsOfToday, 100 + 200 + 300 - 50 - 60);
});

test('getCustomerLedger: the OTHER customer with a superstring name is untouched', async () => {
  const out = await accountingService.getCustomerLedger('Alhaji Musa');
  const ids = out.entries.map((e) => e.entry_id).sort();
  assert.deepEqual(ids, ['E4', 'E7'], 'Alhaji Musa sees only his own rows');
});

test('getCustomerLedger: an alias query resolves to the same consolidated statement', async () => {
  const out = await accountingService.getCustomerLedger('Musa Old');
  assert.deepEqual(out.entries.map((e) => e.entry_id).sort(), ['E1', 'E2', 'E3', 'E5', 'E6']);
});

test('getCustomerLedger: unknown name returns an empty statement (no bleed)', async () => {
  const out = await accountingService.getCustomerLedger('usa');
  assert.equal(out.entries.length, 0, 'a substring of other names must match nothing');
});