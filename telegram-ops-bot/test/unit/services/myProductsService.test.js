'use strict';

/**
 * MYP-2 — the linked view is ALLOCATION-DRIVEN (owner, 23-Aug-2026): items
 * are exactly the admin's allocation rows, shade-grained where the matrix
 * set shades; purchase history feeds only the SUPPLIED numbers; legacy '*'
 * mode rows are ignored; no availability figure exists in the result the
 * renderer shows.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const allocRepo = require('../../../src/repositories/marketerAllocationsRepository');

const ROWS = [
  { packageNo: '601', design: '9037', shade: '1', warehouse: 'Kano office', status: 'sold', soldTo: 'Owaibula', soldDate: '2026-07-10' },
  { packageNo: '601', design: '9037', shade: '1', warehouse: 'Kano office', status: 'sold', soldTo: 'Owaibula', soldDate: '2026-07-10' },
  { packageNo: '602', design: '9037', shade: '3', warehouse: 'Kano office', status: 'sold', soldTo: 'Owaibula', soldDate: '2026-07-11' },
  { packageNo: '660', design: '77016', shade: '2', warehouse: 'Kano office', status: 'sold', soldTo: 'Benduku', soldDate: '2026-07-21' },
  { packageNo: '701', design: '9037', shade: '1', warehouse: 'Kano office', status: 'available' },
  { packageNo: '702', design: '9037', shade: '3', warehouse: 'Kano office', status: 'available' },
  { packageNo: '801', design: '9037', shade: '1', warehouse: 'Lagos office', status: 'available' },
];
inventoryRepository.getAll = async () => ROWS;
inventoryRepository.getSoldRows = async () => ROWS.filter((r) => r.status === 'sold');

let ALLOC = [];
allocRepo.getAll = async () => ALLOC;

const myProductsService = require('../../../src/services/myProductsService');
const info = { telegramId: '900', type: 'marketer', linkId: 'MK-1', linkName: 'Owaibula' };

test('the view is exactly the allocation: shade rows grained, design pair summed', async () => {
  ALLOC = [
    { marketer_id: '900', design: '9037', shade: '1', allocated_qty: 13, notes: '' },
    { marketer_id: '900', design: '9037', shade: '3', allocated_qty: 9, notes: '' },
    { marketer_id: '900', design: '*', shade: '', allocated_qty: 5, notes: 'curated' }, // legacy — ignored
    { marketer_id: '901', design: '9045', shade: '', allocated_qty: 4, notes: '' },     // someone else
  ];
  const v = await myProductsService.buildFor(info);
  assert.equal(v.items.length, 1, 'only THEIR allocated designs; * and other people ignored');
  const it = v.items[0];
  assert.equal(it.design, '9037');
  assert.equal(it.allocatedB, 22, 'design pair sums the shade allocations');
  assert.equal(it.suppliedB, 2, 'distinct bales supplied to them');
  assert.deepEqual(it.shades.map((s) => [s.shade, s.suppliedB, s.allocatedB]),
    [['1', 1, 13], ['3', 1, 9]], 'per-shade pairs, biggest allocation first');
  assert.equal(v.warehouse, 'Kano office', 'source warehouse computed internally for routing');
});

test('zero allocation = empty view, whatever they purchased', async () => {
  ALLOC = [];
  const v = await myProductsService.buildFor(info);
  assert.equal(v.items.length, 0, 'purchase history alone renders nothing (allocation-driven)');
});

test('the cap source is shade-aware', async () => {
  assert.equal(await myProductsService.availableForDesign('9037', 'Kano office', '1'), 1);
  assert.equal(await myProductsService.availableForDesign('9037', 'Kano office', null), 2);
  assert.equal(await myProductsService.availableForDesign('9037', null, '1'), 2, 'no warehouse scope = all');
});
