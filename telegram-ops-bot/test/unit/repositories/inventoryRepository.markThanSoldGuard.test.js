'use strict';

/**
 * SEC-P2 (C5): markThanSold must refuse to overwrite a than that is not
 * currently 'available' (already sold / in_transit), so a racing second sale
 * can't double-sell one physical than. Mirrors markPackageSold's filter.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sheets = require('../../../src/repositories/sheetsClient');
const inventoryRepo = require('../../../src/repositories/inventoryRepository');

// Inventory columns A..V; only the ones markThanSold/parseRow read matter here.
// A PackageNo, D Design, E Shade, F ThanNo, G Yards, H Status, I Warehouse, J Price.
function invRow(pkg, thanNo, status) {
  return [pkg, '', '', 'Rose', 'Red', String(thanNo), '30', status, 'Lagos', '100',
    '2026-01-01', '', '', '', '', '', 'fabric', `BAL-${pkg}-${thanNo}`, '2026-01-01', '', '', ''];
}

function withInventory(rows, fn) {
  const origRead = sheets.readRange;
  const origUpdate = sheets.updateRange;
  const writes = [];
  sheets.readRange = async () => rows.map((r) => [...r]);
  sheets.updateRange = async (sheet, range, values) => { writes.push({ range, values }); };
  inventoryRepo.invalidateCache();
  return Promise.resolve(fn(writes)).finally(() => {
    sheets.readRange = origRead;
    sheets.updateRange = origUpdate;
    inventoryRepo.invalidateCache();
  });
}

test('C5: markThanSold returns null and writes nothing for an already-sold than', async () => {
  await withInventory([invRow('P1', 1, 'sold')], async (writes) => {
    const res = await inventoryRepo.markThanSold('P1', 1, 'ACME');
    assert.equal(res, null, 'sold than must not be re-sold');
    assert.equal(writes.length, 0, 'no sheet write for a non-available than');
  });
});

test('C5: markThanSold still sells an available than (happy path preserved)', async () => {
  await withInventory([invRow('P2', 1, 'available')], async (writes) => {
    const res = await inventoryRepo.markThanSold('P2', 1, 'ACME');
    assert.ok(res, 'available than sells');
    assert.equal(res.status, 'sold');
    assert.equal(writes.length, 1, 'exactly one row write');
    assert.match(writes[0].range, /^H\d+:P\d+$/, 'writes the status..soldDate range');
  });
});

test('C5: markThanSold returns null for an in_transit than', async () => {
  await withInventory([invRow('P3', 1, 'in_transit')], async (writes) => {
    const res = await inventoryRepo.markThanSold('P3', 1, 'ACME');
    assert.equal(res, null);
    assert.equal(writes.length, 0);
  });
});
