'use strict';

/** RET-3 — the backfill LISTING pairs returns with their ledger credits and prices the gap. Read-only. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { findUncredited } = require('../../../scripts/list-uncredited-returns');

const inventory = [
  { packageNo: '9037', warehouse: 'Kano office', yards: 30, pricePerYard: 2500 },
  { packageNo: '9037', warehouse: 'Kano office', yards: 30, pricePerYard: 2500 },
  { packageNo: '9040', warehouse: 'IDUMOTA', yards: 40, pricePerYard: 0 },
];
const movements = [
  { kind: 'return', movedOn: '2026-08-20', baleNo: '9037', design: 'D1', shade: 'Blue', thans: 1, toState: 'available @ Kano office', ref: 'ABBA', user: '555' },
  { kind: 'return', movedOn: '2026-08-21', baleNo: '9037', design: 'D1', shade: 'Blue', thans: 2, toState: 'available @ Kano office', ref: 'ABBA', user: '555' },
  { kind: 'return', movedOn: '2026-08-22', baleNo: '9040', design: 'D2', shade: 'Red', thans: 1, toState: 'available @ IDUMOTA', ref: 'CHIMA', user: '556' },
  { kind: 'correction', movedOn: '2026-08-23', baleNo: '9041', design: 'D3', shade: '', thans: 1, toState: 'available @ IDUMOTA', ref: '', user: '777' },
  { kind: 'sale', movedOn: '2026-08-24', baleNo: '9037', design: 'D1', shade: 'Blue', thans: 1, toState: 'sold @ Kano office', ref: 'ABBA', user: '555' },
];

test('a credited return is skipped; uncredited ones are priced from the bale; corrections and sales ignored', () => {
  const ledger = [{ txn_id: 'RT-9037-1', credit: 75000 }];
  const rows = findUncredited({ movements, ledger, inventory });
  // Bale 9037 has an RT- credit → both its return rows count as credited (the movement row cannot name the than).
  assert.deepEqual(rows.map((r) => r.baleNo), ['9040']);
  assert.equal(rows[0].rate, 0, 'no price on that bale');
  assert.equal(rows[0].credit, 0);
  assert.equal(rows[0].warehouse, 'IDUMOTA');
  assert.equal(rows[0].buyer, 'CHIMA');
});

test('with no ledger credits at all, every return is listed with an estimated credit', () => {
  const rows = findUncredited({ movements, ledger: [], inventory });
  assert.equal(rows.length, 3);
  const two = rows.find((r) => r.thans === 2);
  assert.equal(two.yards, 60, 'bale average 30 yds × 2 thans');
  assert.equal(two.rate, 2500);
  assert.equal(two.credit, 150000);
});

test('RET-4: an RN-<bale>-<requestId> credit counts as credited, like RT-/RP-', () => {
  // The multi-than return card posts ONE credit for the whole ticked set,
  // keyed by the request id (two returns of one bale must stay distinct).
  // Without RN- in the credited shapes every new return would be listed here.
  const ledger = [{ txn_id: 'RN-9037-REQ-1', credit: 150000 }];
  const rows = findUncredited({ movements, ledger, inventory });
  assert.deepEqual(rows.map((r) => r.baleNo), ['9040'], 'bale 9037 is credited by the RN- txn');
});

test('RET-4: an RN- row with no credit amount does not count as credited', () => {
  const ledger = [{ txn_id: 'RN-9037-REQ-1', credit: 0 }];
  const rows = findUncredited({ movements, ledger, inventory });
  assert.deepEqual(rows.map((r) => r.baleNo), ['9037', '9037', '9040']);
});
