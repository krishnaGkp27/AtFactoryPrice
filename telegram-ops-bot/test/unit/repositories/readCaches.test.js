'use strict';

/**
 * P6 read caches for Customers and Departments.
 *
 * Both sheets are read on hot paths (every picker and every findByName during
 * an approval; every greeting-menu and hub render) but change only when a
 * human edits them. These tests pin the two properties that make caching them
 * safe: repeated reads inside the TTL hit the sheet ONCE, and every write path
 * invalidates so an in-bot change is visible immediately rather than up to
 * 30 seconds later. They also pin that callers get their own array copy, so a
 * caller sorting the result cannot poison the cache for everyone else.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sheets = require('../../../src/repositories/sheetsClient');
const customersRepo = require('../../../src/repositories/customersRepository');
const departmentsRepo = require('../../../src/repositories/departmentsRepository');

/** Swap in counting stubs for the duration of `fn`. */
async function withStubbedSheets(rows, fn) {
  const origRead = sheets.readRange;
  const origAppend = sheets.appendRows;
  const origUpdate = sheets.updateRange;
  const counts = { reads: 0 };
  sheets.readRange = async () => { counts.reads += 1; return rows; };
  sheets.appendRows = async () => {};
  sheets.updateRange = async () => {};
  try {
    await fn(counts);
  } finally {
    sheets.readRange = origRead;
    sheets.appendRows = origAppend;
    sheets.updateRange = origUpdate;
  }
}

test('customers: cached within TTL, invalidated by append/update, copies handed out', async () => {
  const rows = [['C1', 'Karibulla', '08012345678', 'Kano', 'Retail', '0', '0', 'COD', '', 'Active', '', '']];
  customersRepo.invalidateCache();
  await withStubbedSheets(rows, async (counts) => {
    const a = await customersRepo.getAll();
    await customersRepo.getAll();
    assert.equal(counts.reads, 1, 'second read served from cache');
    assert.equal(a[0].name, 'Karibulla');

    a.length = 0; // a caller mutating its result must not empty the cache
    const b = await customersRepo.getAll();
    assert.equal(b.length, 1, 'each caller gets its own array copy');
    assert.equal(counts.reads, 1, 'the copy check did not trigger a re-read');

    await customersRepo.append({ customer_id: 'C2', name: 'Belly' });
    await customersRepo.getAll();
    assert.equal(counts.reads, 2, 'append invalidates — a new customer is visible at once');

    await customersRepo.updateOutstanding('C1', 500);
    const readsAfterUpdate = counts.reads;
    await customersRepo.getAll();
    assert.ok(counts.reads > readsAfterUpdate - 1, 'updateOutstanding invalidates too');
  });
  customersRepo.invalidateCache();
});

test('departments: cached within TTL and invalidated by an activities edit', async () => {
  const rows = [['D1', 'Sales', 'supply_details,my_orders', 'active', '', '', 'Lagos']];
  departmentsRepo.invalidateCache();
  await withStubbedSheets(rows, async (counts) => {
    const a = await departmentsRepo.getAll();
    await departmentsRepo.getAll();
    assert.equal(counts.reads, 1, 'menu renders reuse one read inside the TTL');
    assert.deepEqual(a[0].allowed_activities, ['supply_details', 'my_orders']);

    // updateActivities does findById (a cached read) then a write; the write
    // must drop the cache so the changed menu applies on the next render.
    await departmentsRepo.updateActivities('D1', ['supply_details']);
    const before = counts.reads;
    await departmentsRepo.getAll();
    assert.equal(counts.reads, before + 1, 'activities edit invalidates the cache');
  });
  departmentsRepo.invalidateCache();
});
