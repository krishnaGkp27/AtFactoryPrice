'use strict';

/**
 * TRF-INT1/3 — scoped transitions, live-collision lookup, sold-only returns,
 * and the same-warehouse duplicate scan. Real repository over fake sheets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets } = require('../../helpers/controllerHarness');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const baleAuditReport = require('../../../src/services/baleAuditReport');

const HEADER = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];

function row(pkg, design, shade, status, wh, uid, dateReceived = '2026-07-01') {
  return [pkg, '', '', design, shade, '1', '30', status, wh, '0', dateReceived,
    '', '', '', '', '', 'fabric', uid, '2026-07-01T00:00:00.000Z', '', '', '', ''];
}

// The duplicate-number reality: "997" exists as THREE physical bales —
// one available in Lagos, one available in Kano, one in transit.
const SHEET_ROWS = [
  HEADER,
  row('997', '80045', '1', 'available', 'Lagos', 'U-LAG-997'),        // rowIndex 2
  row('997', '70012', '2', 'available', 'Kano office', 'U-KAN-997'),  // rowIndex 3
  row('997', '9032', '1', 'in_transit', 'PH', 'U-PH-997'),            // rowIndex 4
  row('500', '80045', '1', 'sold', 'Lagos', 'U-LAG-500'),             // rowIndex 5 — sold: number free
  row('600', '80045', '1', 'available', 'Lagos', ''),                 // rowIndex 6 — legacy, no uid
  // Same number, same warehouse, DIFFERENT design + intake date = the
  // forbidden state the boot report must flag.
  row('777', '80045', '1', 'available', 'Kano office', 'U-KAN-777a', '2026-06-01'), // 7
  row('777', '70012', '2', 'available', 'Kano office', 'U-KAN-777b', '2026-07-20'), // 8
];

let restore;
test.before(() => { restore = installFakeSheets(createFakeSheets({ Inventory: SHEET_ROWS.map((r) => [...r]) })); });
test.after(() => restore && restore());
test.beforeEach(() => inventoryRepository.invalidateCache());

test('transitionBales with uids flips ONLY the exact rows — same number elsewhere untouched', async () => {
  const flipped = await inventoryRepository.transitionBales(['997'], 'available', 'in_transit', 'Kano office',
    { uids: ['U-LAG-997'] });
  assert.equal(flipped.length, 1);
  assert.equal(flipped[0].baleUid, 'U-LAG-997');
  const all = await inventoryRepository.getAll(true);
  assert.equal(all.find((r) => r.baleUid === 'U-KAN-997').status, 'available', 'Kano 997 untouched');
  assert.equal(all.find((r) => r.baleUid === 'U-PH-997').status, 'in_transit', 'PH 997 untouched');
  // revert for the next tests
  await inventoryRepository.transitionBales(['997'], 'in_transit', 'available', 'Lagos', { uids: ['U-LAG-997'] });
});

test('transitionBales warehouse scope (legacy fallback) never crosses warehouses', async () => {
  const flipped = await inventoryRepository.transitionBales(['997'], 'available', 'in_transit', 'X',
    { warehouse: 'Lagos' });
  assert.equal(flipped.length, 1);
  assert.equal(flipped[0].baleUid, 'U-LAG-997', 'only the Lagos 997');
  await inventoryRepository.transitionBales(['997'], 'in_transit', 'available', 'Lagos', { uids: ['U-LAG-997'] });
});

test('transitionBales returns what it actually flipped (caller checks it)', async () => {
  const none = await inventoryRepository.transitionBales(['997'], 'available', 'in_transit', 'X',
    { uids: ['U-DOES-NOT-EXIST'] });
  assert.deepEqual(none, []);
});

test('ensureRowUids persists real uids for legacy rows and keeps real ones', async () => {
  const all = await inventoryRepository.getAll(true);
  const legacy = all.find((r) => r.packageNo === '600');
  assert.ok(legacy._legacy, 'fixture row 600 is legacy');
  const real = all.find((r) => r.baleUid === 'U-LAG-997');
  const map = await inventoryRepository.ensureRowUids([legacy, real]);
  assert.equal(map.get(real.rowIndex), 'U-LAG-997', 'real uid unchanged');
  const newUid = map.get(legacy.rowIndex);
  assert.match(newUid, /^BAL-/, 'legacy row got a real generated uid');
  const after = await inventoryRepository.getAll(true);
  assert.equal(after.find((r) => r.packageNo === '600').baleUid, newUid, 'uid persisted to the sheet');
});

test('liveBaleConflicts: live numbers block, sold numbers are free, other warehouses ignored', async () => {
  const conflicts = await inventoryRepository.liveBaleConflicts(['997', '500', '999'], 'Lagos');
  assert.ok(conflicts.has('997'), 'live 997 in Lagos blocks');
  assert.ok(!conflicts.has('500'), 'sold 500 may be intaken again (owner rule)');
  assert.ok(!conflicts.has('999'), 'unknown number is free');
  const kano = await inventoryRepository.liveBaleConflicts(['997'], 'Kano office');
  assert.equal(kano.get('997').design, '70012', 'conflict names the LOCAL bale');
});

test('markThanAvailable flips ONLY sold thans — never an in-transit one', async () => {
  // PH 997 is in_transit; a return against it must refuse.
  const res = await inventoryRepository.markThanAvailable('500', 1);
  assert.ok(res, 'sold than returns fine');
  await inventoryRepository.markPackageSold('500', 'X'); // restore sold state
  inventoryRepository.invalidateCache();
  const all = await inventoryRepository.getAll(true);
  assert.equal(all.find((r) => r.baleUid === 'U-PH-997').status, 'in_transit');
  // findThan resolves the FIRST 997 (Lagos, available) — also refused.
  const blocked = await inventoryRepository.markThanAvailable('997', 1);
  assert.equal(blocked, null, 'non-sold thans are untouchable by returns');
});

// ── TRF-INT4 — sale/return mutators honour the warehouse scope ────────────

test('markPackageSold {warehouse} sells ONLY that warehouse — same number elsewhere untouched', async () => {
  const sold = await inventoryRepository.markPackageSold('997', 'ACME', null, { warehouse: 'Lagos' });
  assert.equal(sold.length, 1);
  assert.equal(sold[0].baleUid, 'U-LAG-997');
  const all = await inventoryRepository.getAll(true);
  assert.equal(all.find((r) => r.baleUid === 'U-KAN-997').status, 'available', 'Kano 997 untouched');
  assert.equal(all.find((r) => r.baleUid === 'U-PH-997').status, 'in_transit', 'PH 997 untouched');
  // Scoped return: sell Kano too, then return ONLY Kano — Lagos stays sold.
  await inventoryRepository.markPackageSold('997', 'ACME', null, { warehouse: 'Kano office' });
  const returned = await inventoryRepository.markPackageAvailable('997', { warehouse: 'Kano office' });
  assert.equal(returned.length, 1);
  assert.equal(returned[0].baleUid, 'U-KAN-997');
  const after = await inventoryRepository.getAll(true);
  assert.equal(after.find((r) => r.baleUid === 'U-LAG-997').status, 'sold', 'Lagos stays sold');
  // restore for the next tests
  await inventoryRepository.markPackageAvailable('997', { warehouse: 'Lagos' });
});

test('markThanSold {warehouse} picks the physical than in THAT warehouse', async () => {
  const res = await inventoryRepository.markThanSold('997', 1, 'BUYER', null, { warehouse: 'Kano office' });
  assert.ok(res, 'Kano 997 than 1 sold');
  assert.equal(res.design, '70012', 'the KANO bale, not the Lagos one findThan would hit first');
  const all = await inventoryRepository.getAll(true);
  assert.equal(all.find((r) => r.baleUid === 'U-LAG-997').status, 'available', 'Lagos untouched');
  const back = await inventoryRepository.markThanAvailable('997', 1, { warehouse: 'Kano office' });
  assert.ok(back, 'scoped return restores it');
});

test('unscoped markPackageSold keeps the legacy behavior for pre-TRF-INT4 pending rows', async () => {
  // No warehouse on the aj (queued before the change) → every available
  // instance of the number flips, in-transit stays locked. Documented, not
  // desired — new queue items always carry the warehouse.
  const sold = await inventoryRepository.markPackageSold('997', 'X');
  assert.equal(sold.length, 2, 'Lagos + Kano available rows; PH in_transit untouched');
  await inventoryRepository.markPackageAvailable('997', { warehouse: 'Lagos' });
  await inventoryRepository.markPackageAvailable('997', { warehouse: 'Kano office' });
});

test('baleAuditReport flags same-warehouse duplicates only (cross-warehouse is legal)', async () => {
  const { offenders, crossWarehouse } = await baleAuditReport._internals.computeDuplicates();
  assert.equal(offenders.length, 1, `only the Kano 777 pair, got ${JSON.stringify(offenders)}`);
  assert.equal(offenders[0].packageNo, '777');
  assert.equal(offenders[0].variants.length, 2);
  assert.ok(crossWarehouse >= 1, '997 counted as cross-warehouse reuse, not an offence');
});
