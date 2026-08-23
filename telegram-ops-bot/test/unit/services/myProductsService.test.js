'use strict';

/**
 * MYP-1 — the auto product set derives from PURCHASE HISTORY: designs the
 * person bought, supplied counted in distinct bales, availability from the
 * SOURCE warehouse (their most recent purchase), curated mode narrows to
 * the allocated set, and the sdg chip pair (suppliedB / availableB) holds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const allocRepo = require('../../../src/repositories/marketerAllocationsRepository');

const ROWS = [
  { packageNo: '601', design: '9037', warehouse: 'Kano office', status: 'sold', soldTo: 'Owaibula', soldDate: '2026-07-10' },
  { packageNo: '601', design: '9037', warehouse: 'Kano office', status: 'sold', soldTo: 'Owaibula', soldDate: '2026-07-10' },
  { packageNo: '602', design: '9037', warehouse: 'Kano office', status: 'sold', soldTo: 'Owaibula', soldDate: '2026-07-11' },
  { packageNo: '650', design: '9045', warehouse: 'Kano office', status: 'sold', soldTo: 'OWAIBULA ', soldDate: '2026-07-20' },
  { packageNo: '660', design: '77016', warehouse: 'Kano office', status: 'sold', soldTo: 'Benduku', soldDate: '2026-07-21' },
  { packageNo: '701', design: '9037', warehouse: 'Kano office', status: 'available' },
  { packageNo: '702', design: '9037', warehouse: 'Kano office', status: 'available' },
  { packageNo: '801', design: '9037', warehouse: 'Lagos office', status: 'available' },
  { packageNo: '802', design: '9037', warehouse: 'Lagos office', status: 'available' },
  { packageNo: '803', design: '9037', warehouse: 'Lagos office', status: 'available' },
  { packageNo: '710', design: '9045', warehouse: 'Kano office', status: 'available' },
];
inventoryRepository.getAll = async () => ROWS;
inventoryRepository.getSoldRows = async () => ROWS.filter((r) => r.status === 'sold');

let ALLOC = [];
allocRepo.getAll = async () => ALLOC;

const myProductsService = require('../../../src/services/myProductsService');
const info = { telegramId: '900', type: 'marketer', linkId: 'MK-1', linkName: 'Owaibula' };

test('auto mode: purchase-derived designs, source warehouse, sdg pair numbers', async () => {
  ALLOC = [];
  const v = await myProductsService.buildFor(info);
  assert.equal(v.mode, 'auto');
  assert.equal(v.warehouse, 'Kano office', 'most recent purchase pins the source warehouse');
  assert.deepEqual(v.items.map((i) => i.design), ['9037', '9045'], 'most-supplied first; nobody else\'s history');
  const d9037 = v.items[0];
  assert.equal(d9037.suppliedB, 2, 'distinct bales, than rows never double-count');
  assert.equal(d9037.availableB, 2, 'Kano only — Lagos stock stays out of a Kano history');
});

test('curated mode narrows to allocated designs; the * mode row never renders as a product', async () => {
  ALLOC = [
    { marketer_id: '900', design: '*', allocated_qty: 0, notes: 'curated' },
    { marketer_id: '900', design: '9045', allocated_qty: 1, notes: '' },
    { marketer_id: '901', design: '9037', allocated_qty: 5, notes: '' },
  ];
  const v = await myProductsService.buildFor(info);
  assert.equal(v.mode, 'curated');
  assert.deepEqual(v.items.map((i) => i.design), ['9045']);
  assert.equal(v.items[0].allocatedB, 1);
});

test('no history, no allocation → empty auto set (the polite empty state upstream)', async () => {
  ALLOC = [];
  const v = await myProductsService.buildFor({ telegramId: '111', type: 'customer', linkId: '', linkName: 'Nobody' });
  assert.equal(v.items.length, 0);
  assert.equal(v.warehouse, null);
});
