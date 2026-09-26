'use strict';

/**
 * QTA-1 — markItemsSold: every item of one approved sale in ONE Sheets
 * write (one read, one batchUpdate, one movement append), carrying the
 * guards of the per-item writers it replaces: never overwrite a than that
 * is not available (SEC-P2 C5), scope to the item's warehouse (TRF-INT4),
 * never claim one physical row twice, stamp the negotiated rate on the
 * rest of each touched bale (updatePrice's contract).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sheets = require('../../../src/repositories/sheetsClient');
const inventoryRepo = require('../../../src/repositories/inventoryRepository');
const baleMovementLog = require('../../../src/services/baleMovementLog');

// Inventory columns A..V. A PackageNo, D Design, E Shade, F ThanNo, G Yards,
// H Status, I Warehouse, J Price, K DateReceived, L SoldTo, M SoldDate.
function invRow(pkg, thanNo, status, opts = {}) {
  return [pkg, '', '', opts.design || 'Rose', 'Red', String(thanNo), String(opts.yards || 30), status,
    opts.wh || 'IDUMOTA', String(opts.price || 100), '2026-01-01', opts.soldTo || '', opts.soldDate || '',
    '', '', '', 'fabric', `BAL-${pkg}-${thanNo}`, '2026-01-01', '', '', ''];
}

function withInventory(rows, fn) {
  const orig = { read: sheets.readRange, update: sheets.updateRange, batch: sheets.batchUpdateRanges, append: sheets.appendRows, record: baleMovementLog.record };
  const calls = { batch: [], update: [], record: [] };
  sheets.readRange = async () => rows.map((r) => [...r]);
  sheets.updateRange = async (sheet, range, values) => { calls.update.push({ sheet, range, values }); };
  sheets.batchUpdateRanges = async (sheet, updates) => { calls.batch.push({ sheet, updates }); };
  sheets.appendRows = async () => {};
  baleMovementLog.record = async (moved, m) => { calls.record.push({ moved, m }); return moved.length; };
  inventoryRepo.invalidateCache();
  return Promise.resolve(fn(calls)).finally(() => {
    sheets.readRange = orig.read; sheets.updateRange = orig.update; sheets.batchUpdateRanges = orig.batch;
    sheets.appendRows = orig.append; baleMovementLog.record = orig.record;
    inventoryRepo.invalidateCache();
  });
}

test('a package and a than sell in ONE batchUpdate and ONE movement append; totals per item come back', async () => {
  await withInventory([
    invRow('5804', 1, 'available'), invRow('5804', 2, 'available'), invRow('5804', 3, 'sold', { soldTo: 'OLD', soldDate: '2026-05-01' }),
    invRow('5611', 1, 'available', { design: 'Navy', yards: 37 }), invRow('5611', 2, 'available', { design: 'Navy', yards: 37 }),
  ], async (calls) => {
    const r = await inventoryRepo.markItemsSold(
      [{ type: 'package', packageNo: '5804', warehouse: 'IDUMOTA' }, { type: 'than', packageNo: '5611', thanNo: 2 }],
      'ABBA', '2026-08-19', { user: 'admin:777' });
    assert.equal(r.failed.length, 0);
    assert.deepEqual(r.applied.map((a) => [a.item.packageNo, a.rows.map((x) => x.thanNo)]), [['5804', [1, 2]], ['5611', [2]]]);
    assert.equal(r.rows.length, 3);
    assert.equal(r.rows[0].status, 'sold');
    assert.equal(r.rows[0].soldTo, 'ABBA');
    assert.equal(r.rows[0].soldDate, '2026-08-19');
    assert.equal(calls.update.length, 0, 'no single-range writes');
    assert.equal(calls.batch.length, 1, 'ONE batchUpdate for the whole sale');
    assert.equal(calls.batch[0].sheet, 'Inventory');
    // Row 2 = sheet row of 5804/1 (header is row 1): H2:P2 etc.
    assert.deepEqual(calls.batch[0].updates.map((u) => u.range), ['H2:P2', 'H3:P3', 'H6:P6']);
    assert.deepEqual(calls.batch[0].updates[0].values[0].slice(0, 6), ['sold', 'IDUMOTA', 100, '2026-01-01', 'ABBA', '2026-08-19']);
    assert.equal(calls.record.length, 1, 'ONE movement append');
    assert.equal(calls.record[0].moved.length, 3);
    assert.deepEqual(calls.record[0].m, { to: 'sold', on: '2026-08-19', kind: 'sale', ref: 'ABBA', user: 'admin:777' });
  });
});

test('the negotiated rate lands on the sold rows AND the rest of each touched bale, in the same write', async () => {
  await withInventory([
    invRow('5804', 1, 'available', { design: 'Rose' }), invRow('5804', 2, 'available', { design: 'Rose' }),
    invRow('5804', 3, 'sold', { design: 'Rose', soldTo: 'OLD' }),
    invRow('9001', 1, 'available', { design: 'Other' }),
  ], async (calls) => {
    const rateFor = (row) => (row.design === 'Rose' ? 1450 : 0);
    const r = await inventoryRepo.markItemsSold([{ type: 'than', packageNo: '5804', thanNo: 1 }], 'ABBA', '2026-08-19', { rateFor });
    assert.equal(r.rows[0].pricePerYard, 1450, 'the sold row carries the new rate');
    const u = calls.batch[0].updates;
    assert.equal(u[0].range, 'H2:P2');
    assert.equal(u[0].values[0][2], 1450);
    // The other two rows of bale 5804 (than 2 available, than 3 sold) take J + P; bale 9001 is untouched.
    assert.deepEqual(u.slice(1).map((x) => x.range), ['J3', 'P3', 'J4', 'P4']);
    assert.equal(u[1].values[0][0], 1450);
    assert.equal(u.some((x) => /5$/.test(x.range)), false, 'an untouched bale gets no stamp');
  });
});

test('no rate → no extra stamps; a rate of 0 keeps the row\'s own price', async () => {
  await withInventory([invRow('5804', 1, 'available', { price: 120 })], async (calls) => {
    const r = await inventoryRepo.markItemsSold([{ type: 'than', packageNo: '5804', thanNo: 1 }], 'ABBA', '2026-08-19', { rateFor: () => 0 });
    assert.equal(r.rows[0].pricePerYard, 120);
    assert.equal(calls.batch[0].updates.length, 1);
  });
});

test('guards: a sold than is refused, a wrong warehouse is refused, an unknown type is refused, and a row is never claimed twice', async () => {
  await withInventory([
    invRow('5804', 1, 'sold', { soldTo: 'OLD' }),
    invRow('5805', 1, 'available', { wh: 'KETU' }),
    invRow('5806', 1, 'available'), invRow('5806', 2, 'available'),
  ], async (calls) => {
    const r = await inventoryRepo.markItemsSold([
      { type: 'than', packageNo: '5804', thanNo: 1 },
      { type: 'package', packageNo: '5805', warehouse: 'IDUMOTA' },
      { type: 'package', packageNo: '5806' },
      { type: 'than', packageNo: '5806', thanNo: 2 },
      { type: 'bale', packageNo: '5806' },
    ], 'ABBA', '2026-08-19');
    assert.deepEqual(r.failed.map((f) => [f.item.packageNo, f.reason]), [
      ['5804', 'not found or not available'],
      ['5805', 'not found or no available thans'],
      ['5806', 'not found or not available'],
      ['5806', 'unknown item type "bale"'],
    ]);
    assert.deepEqual(r.applied.map((a) => [a.item.packageNo, a.rows.length]), [['5806', 2]]);
    assert.equal(calls.batch.length, 1);
    assert.equal(calls.batch[0].updates.length, 2);
  });
});

test('nothing applicable → nothing written, nothing logged', async () => {
  await withInventory([invRow('5804', 1, 'sold', { soldTo: 'OLD' })], async (calls) => {
    const r = await inventoryRepo.markItemsSold([{ type: 'than', packageNo: '5804', thanNo: 1 }], 'ABBA', '2026-08-19');
    assert.equal(r.rows.length, 0);
    assert.equal(r.failed.length, 1);
    assert.equal(calls.batch.length, 0);
    assert.equal(calls.record.length, 0);
  });
});

test('a mixed-spelling sale date is normalised once for every row', async () => {
  await withInventory([invRow('5804', 1, 'available'), invRow('5804', 2, 'available')], async (calls) => {
    const r = await inventoryRepo.markItemsSold([{ type: 'package', packageNo: '5804' }], 'ABBA', '19-08-2026');
    assert.ok(r.rows.every((x) => x.soldDate === '2026-08-19'));
    assert.ok(calls.batch[0].updates.every((u) => u.values[0][5] === '2026-08-19'));
  });
});
