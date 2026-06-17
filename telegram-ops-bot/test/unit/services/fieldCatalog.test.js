'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCatalog } = require('../../../src/services/fieldCatalog');

/** Inventory fixture: two warehouses, two designs, mixed status. */
const ITEMS = [
  { status: 'available', design: '44200', shade: 'BLACK', packageNo: '5801', thanNo: 1, yards: 25, warehouse: 'Lagos', pricePerYard: 1500 },
  { status: 'available', design: '44200', shade: 'BLACK', packageNo: '5801', thanNo: 2, yards: 25, warehouse: 'Lagos', pricePerYard: 1500 },
  { status: 'available', design: '44200', shade: 'RED', packageNo: '5802', thanNo: 1, yards: 30, warehouse: 'Lagos', pricePerYard: 1600 },
  { status: 'available', design: '9006', shade: 'BLUE', packageNo: '7001', thanNo: 1, yards: 40, warehouse: 'Lagos', pricePerYard: 2000 },
  { status: 'sold', design: '44200', shade: 'BLACK', packageNo: '5803', thanNo: 1, yards: 25, warehouse: 'Lagos', pricePerYard: 1500, soldTo: 'X' },
  { status: 'available', design: '44200', shade: 'BLACK', packageNo: '9901', thanNo: 1, yards: 25, warehouse: 'Kano', pricePerYard: 1500 },
];

test('buildCatalog() warehouse scoping', async (t) => {
  await t.test('only includes available stock in the assigned warehouse', () => {
    const { text } = buildCatalog(ITEMS, ['Lagos'], { showPrice: false });
    assert.match(text, /44200/);
    assert.match(text, /9006/);
    // Kano-only bale 9901 and the sold bale 5803 must not inflate Lagos totals.
    assert.match(text, /Shade BLACK: 1 Bales · 2 thans · 50 yds/);
  });

  await t.test('matches warehouse case-insensitively', () => {
    const { text } = buildCatalog(ITEMS, ['lagos'], {});
    assert.match(text, /44200/);
  });

  await t.test('excludes other warehouses entirely', () => {
    const { text } = buildCatalog(ITEMS, ['Kano'], {});
    assert.match(text, /Shade BLACK: 1 Bales · 1 thans · 25 yds/);
    assert.doesNotMatch(text, /9006/);
  });
});

test('buildCatalog() price visibility', async (t) => {
  await t.test('marketer view (showPrice=false) has no price', () => {
    const { text } = buildCatalog(ITEMS, ['Lagos'], { showPrice: false });
    assert.doesNotMatch(text, /\/yd/);
    assert.doesNotMatch(text, /₦/);
  });

  await t.test('salesman view (showPrice=true) appends selling price per shade', () => {
    const { text } = buildCatalog(ITEMS, ['Lagos'], { showPrice: true });
    assert.match(text, /₦1,500\/yd/);
    assert.match(text, /₦1,600\/yd/);
    assert.match(text, /₦2,000\/yd/);
  });
});

test('buildCatalog() empty states', async (t) => {
  await t.test('no warehouse assigned', () => {
    const { text, empty } = buildCatalog(ITEMS, [], {});
    assert.equal(empty, true);
    assert.match(text, /No warehouse assigned/i);
  });

  await t.test('warehouse with no available stock', () => {
    const { text, empty } = buildCatalog(ITEMS, ['Ibadan'], {});
    assert.equal(empty, true);
    assert.match(text, /No products available/i);
  });
});
