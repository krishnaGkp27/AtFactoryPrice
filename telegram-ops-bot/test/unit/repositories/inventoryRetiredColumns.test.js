'use strict';

/**
 * ISC-1 R9 (08-Sep-2026) — Inventory columns Q (ProductType) and U
 * (bin_location) are RETIRED in code: the bot never writes them, keeps
 * reading them with the existing defaults, and the columns stay in place
 * until one coordinated letter-map pass deletes them.
 *
 * §2e finding: Q held ONE value ('fabric') on 3,224 rows and blank elsewhere
 * (parseRow already defaulted it); U was 100% blank, only the Postgres mirror
 * ever copied it. Real repository over fake sheets — no Sheets API.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets } = require('../../helpers/controllerHarness');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');

const Q = 16; // ProductType
const U = 20; // bin_location
const HEADER = inventoryRepository.HEADERS;

function row(pkg, uid, productType, bin) {
  return [pkg, '', '', '9006', '3', '1', '30', 'available', 'Lagos', '0', '2026-07-01',
    '', '', '', '', '', productType, uid, '2026-07-01T00:00:00.000Z', '', bin, 'Jul26', ''];
}

let fake;
let restore;
test.before(() => {
  fake = createFakeSheets({ Inventory: [
    [...HEADER],
    row('100', 'U-100', 'fabric', ''),   // the live shape: 'fabric', no bin
    row('101', 'U-101', '', ''),         // blank Q — the legacy half of the sheet
    row('102', 'U-102', 'fabric', 'A3'), // a hand-filled bin, should one ever appear
  ] });
  restore = installFakeSheets(fake);
});
test.after(() => restore && restore());
test.beforeEach(() => inventoryRepository.invalidateCache());

function lastWritten() {
  const sheet = fake._store.get('Inventory');
  return sheet[sheet.length - 1];
}

test('HEADERS still name Q and U in place — retired in code, not deleted', () => {
  assert.equal(HEADER[Q], 'ProductType');
  assert.equal(HEADER[U], 'bin_location');
  assert.equal(HEADER.length, 23);
});

test('parseRow keeps the read-side defaults: blank Q reads as fabric, U reads as held', async () => {
  const all = await inventoryRepository.getAll();
  const byPkg = Object.fromEntries(all.map((r) => [r.packageNo, r]));
  assert.equal(byPkg['100'].productType, 'fabric');
  assert.equal(byPkg['101'].productType, 'fabric', 'blank Q still defaults — every reader sees fabric');
  assert.equal(byPkg['102'].productType, 'fabric');
  assert.equal(byPkg['100'].binLocation, '');
  assert.equal(byPkg['102'].binLocation, 'A3', 'an existing bin is still readable');
});

test('toRow writes Q and U blank whatever the object carries', () => {
  const out = inventoryRepository.toRow({
    packageNo: '1', design: '9006', updatedAt: 'T', productType: 'fabric',
    baleUid: 'U-1', addedAt: 'A', grnId: 'G', binLocation: 'A3', arrivalBatch: 'Jul26', designCategory: 'TR',
  });
  assert.equal(out.length, HEADER.length, 'column count unchanged — no letter shifts');
  assert.equal(out[Q], '', 'Q ProductType never written');
  assert.equal(out[U], '', 'U bin_location never written');
  // The neighbours are untouched: P before Q, R after it, T before U, V after it.
  assert.equal(out[15], 'T');
  assert.equal(out[17], 'U-1');
  assert.equal(out[19], 'G');
  assert.equal(out[21], 'Jul26');
  assert.equal(out[22], 'TR');
});

test('appendBale stamps no productType; the written row has blank Q and U; readers still see fabric', async () => {
  const created = await inventoryRepository.appendBale([{
    packageNo: '200', design: '9006', shade: '3', thanNo: 1, yards: 30,
    warehouse: 'Lagos', dateReceived: '2026-09-08',
  }]);
  assert.equal(Object.prototype.hasOwnProperty.call(created[0], 'productType'), false, 'nothing stamped on the row object');
  const written = lastWritten();
  assert.equal(written[0], '200');
  assert.match(written[17], /^BAL-\d{8}-200-/, 'uid still minted');
  assert.equal(written[Q], '');
  assert.equal(written[U], '');
  inventoryRepository.invalidateCache();
  const back = (await inventoryRepository.getAll()).find((r) => r.packageNo === '200');
  assert.equal(back.productType, 'fabric', 'read-side default carries the reader');
  assert.equal(back.binLocation, '');
});

test('a caller that still passes fabric / a bin (an old queued request) gets them written blank', async () => {
  await inventoryRepository.appendBale([{
    packageNo: '201', design: '9006', shade: '3', thanNo: 1, yards: 30,
    warehouse: 'Lagos', dateReceived: '2026-09-08', productType: 'fabric', binLocation: 'K-shelf-1',
  }]);
  const written = lastWritten();
  assert.equal(written[0], '201');
  assert.equal(written[Q], '');
  assert.equal(written[U], '');
});

test('appendThans (the CLI import path) writes Q and U blank too', async () => {
  await inventoryRepository.appendThans([{
    packageNo: '300', design: '9006', shade: '3', thanNo: 1, yards: 30, status: 'available',
    warehouse: 'Lagos', pricePerYard: 0, dateReceived: '2026-09-08', updatedAt: 'T',
  }]);
  const written = lastWritten();
  assert.equal(written[0], '300');
  assert.equal(written[Q], '');
  assert.equal(written[U], '');
});
