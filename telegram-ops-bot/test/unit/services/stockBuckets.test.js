'use strict';

/**
 * STK-B1 — goods in transit are their own bucket (owner, 04-Aug-2026:
 * "Goods in transit should be counted as a separate bucket … keep in transit
 * in a separate bucket").
 *
 * Five reporting sites shared one line — `if (available) … else { sold++ }` —
 * so a bale on a truck was booked as a SALE, and so was any row whose Status
 * had been mistyped in the sheet. These tests pin the four buckets and, more
 * importantly, pin that nothing falls into `sold` by default ever again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const stockBuckets = require(path.join(SRC, 'utils/stockBuckets'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const inventoryService = require(path.join(SRC, 'services/inventoryService'));
const analytics = require(path.join(SRC, 'ai/analytics'));

function row(pkg, status, over = {}) {
  return {
    packageNo: pkg, design: '9060', shade: '01', thanNo: 1, yards: 60,
    status, warehouse: 'IDUMOTA', pricePerYard: 10, indent: 'I1', ...over,
  };
}

const MIXED = [
  row('A', 'available'), row('B', 'in_transit'), row('C', 'sold'), row('D', 'weird_typo'),
];

test('every status lands in exactly one named bucket — none default to sold', () => {
  assert.equal(stockBuckets.bucketOf(row('A', 'available')), 'available');
  assert.equal(stockBuckets.bucketOf(row('B', 'in_transit')), 'in_transit');
  assert.equal(stockBuckets.bucketOf(row('C', 'sold')), 'sold');
  // The whole point: an unrecognised status is NOT a sale.
  assert.equal(stockBuckets.bucketOf(row('D', 'weird_typo')), 'other');
  assert.equal(stockBuckets.bucketOf(row('E', '')), 'other');
  assert.equal(stockBuckets.bucketOf(row('F', 'SOLD')), 'sold', 'case-insensitive');
  assert.equal(stockBuckets.bucketOf(row('G', ' in_transit ')), 'in_transit', 'trimmed');
  assert.equal(stockBuckets.bucketOf('available'), 'available', 'accepts a bare status');
});

test('live = ours and unsold, which is shelf PLUS truck', () => {
  assert.equal(stockBuckets.isLive(row('A', 'available')), true);
  assert.equal(stockBuckets.isLive(row('B', 'in_transit')), true);
  assert.equal(stockBuckets.isLive(row('C', 'sold')), false);
  assert.equal(stockBuckets.isLive(row('D', 'weird_typo')), false);
});

test('tally keeps the four buckets apart and counts bales by design+number', () => {
  const t = stockBuckets.tally([
    row('A', 'available'), row('A', 'available'), // 2 thans, 1 bale
    row('B', 'in_transit'),
    row('C', 'sold'),
    // Same printed number, different design — two physical bales (§1/§5).
    row('A', 'sold', { design: '77008' }),
  ]);
  assert.deepEqual(t.available, { thans: 2, yards: 120, bales: 1 });
  assert.deepEqual(t.in_transit, { thans: 1, yards: 60, bales: 1 });
  assert.equal(t.sold.thans, 2);
  assert.equal(t.sold.bales, 2, 'A|9060 and A|77008 are two bales, not one');
});

test('List Bales no longer books a travelling bale as sold', async () => {
  inventoryRepository.findByDesign = async () => MIXED;
  const pkgs = await inventoryService.listPackages('9060');
  const by = new Map(pkgs.map((p) => [p.packageNo, p]));
  assert.equal(by.get('A').available, 1);
  assert.equal(by.get('B').inTransit, 1, 'in transit counted as itself');
  assert.equal(by.get('B').sold, 0, 'and NOT as a sale');
  assert.equal(by.get('C').sold, 1);
  assert.equal(by.get('D').other, 1, 'a mistyped status is quarantined');
  assert.equal(by.get('D').sold, 0, 'never silently a sale');
});

test('Stock Summary / Fast Moving / Dead Stock stop inflating sold', async () => {
  inventoryRepository.getAll = async () => MIXED;
  const [g] = await analytics.stockByDesign();
  assert.equal(g.available, 1);
  assert.equal(g.inTransit, 1);
  assert.equal(g.sold, 1, 'only the genuinely sold than');
  assert.equal(g.other, 1);
  assert.equal(g.inTransitPkgs, 1, 'in-transit bales counted separately');
  assert.equal(g.soldPkgs, 1, 'the sold bale count no longer carries the truck');
  // The four buckets must account for every row — nothing lost, nothing double-counted.
  assert.equal(g.available + g.inTransit + g.sold + g.other, g.total);
});
