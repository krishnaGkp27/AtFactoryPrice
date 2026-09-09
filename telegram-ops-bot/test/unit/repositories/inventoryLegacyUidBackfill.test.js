'use strict';

/**
 * ISC-1 Phase 2c (spec §2e, ruling R8) — legacy bale_uid backfill with REAL
 * ids, and the duplicate-uid re-mint. Real repository over fake sheets.
 *
 * Pinned:
 *  - a blank column R gets `BAL-<yyyymmdd>-<pkg>-<rand>` — no row index in
 *    it, nothing position-bearing, never the LEGACY prefix;
 *  - column R is the ONLY cell written; S (addedAt) stays as it was;
 *  - dryRun writes nothing; rows already carrying a uid are never touched;
 *  - dedupe keeps the uid on the lowest row and re-mints the later ones;
 *  - a cell literally holding the read-time `BAL-LEGACY-` prefix is not a
 *    real uid and is never counted as a duplicate;
 *  - the re-read guard skips (and reports) a row whose cell changed between
 *    the plan and the write, in both operations.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets } = require('../../helpers/controllerHarness');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');

const HEADER = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];

const DUP = 'BAL-20260713-864-bjwg';
const REAL_UID = /^BAL-\d{8}-\d+-[a-z0-9]+$/;

function row(pkg, design, thanNo, uid, addedAt) {
  return [pkg, 'SA/1326', '', design, '01', String(thanNo), '30', 'available', 'IDUMOTA', '0',
    '2026-02-24', '', '', '', '', '', 'fabric', uid, addedAt, '', '', 'Mar26', ''];
}

function fixture() {
  return [
    HEADER,
    row('6534', '9006', 1, '', ''),                                  // 2 — legacy, blank R and S
    row('6534', '9006', 2, '', ''),                                  // 3 — legacy, blank R and S
    row('864', '77014', 4, DUP, '2026-07-13T10:00:00.000Z'),         // 4 — keeps the duplicate
    row('864', '77014', 5, DUP, '2026-07-13T10:00:00.000Z'),         // 5 — re-minted
    row('865', '77014', 1, 'BAL-20260713-865-aaaa', '2026-07-13T10:00:00.000Z'), // 6 — unique, untouched
    row('700', '9037', 1, 'BAL-LEGACY-7-700', ''),                   // 7 — synthetic literal ×2:
    row('700', '9037', 2, 'BAL-LEGACY-7-700', ''),                   // 8   not a duplicate
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''], // 9 — spacer
  ];
}

let fake;
let restore;
function reset() {
  if (restore) restore();
  fake = createFakeSheets({ Inventory: fixture() });
  restore = installFakeSheets(fake);
  inventoryRepository.invalidateCache();
}
const cell = (rowIndex, col) => (fake._store.get('Inventory')[rowIndex - 1] || [])[col] ?? '';
const R = 17;
const S = 18;

test.beforeEach(reset);
test.after(() => restore && restore());

test('backfill dryRun: plans real position-free ids for the blank rows and writes nothing', async () => {
  const seen = [];
  const res = await inventoryRepository.backfillLegacyBales({ dryRun: true, onPlan: (plan) => seen.push(...plan) });
  assert.equal(res.matched, 2);
  assert.equal(res.written, 0);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(seen.map((p) => p.rowIndex), [2, 3], 'only the blank-R live rows are planned');
  assert.equal(res.sample.length, 2);
  for (const p of res.sample) {
    assert.match(p.baleUid, /^BAL-\d{8}-6534-[a-z0-9]+$/, 'appendBale shape: BAL-<date>-<pkg>-<rand>');
    assert.ok(!/LEGACY/.test(p.baleUid), 'never the position-bearing prefix');
    assert.equal(p.currentUid, '');
  }
  assert.equal(cell(2, R), '', 'dry-run left column R blank');
  assert.equal(cell(3, R), '', 'dry-run left column R blank');
});

test('backfill commit: writes column R only, leaves S untouched, is idempotent', async () => {
  const res = await inventoryRepository.backfillLegacyBales();
  assert.equal(res.matched, 2);
  assert.equal(res.written, 2);
  assert.deepEqual(res.skipped, []);
  assert.match(cell(2, R), REAL_UID);
  assert.match(cell(3, R), REAL_UID);
  assert.notEqual(cell(2, R), cell(3, R), 'two thans, two ids');
  assert.ok(!cell(2, R).includes('LEGACY') && !cell(3, R).includes('LEGACY'));
  assert.equal(cell(2, S), '', 'addedAt is not written (slated for retirement, parser falls back to K)');
  assert.equal(cell(3, S), '', 'addedAt is not written');
  assert.equal(cell(4, R), DUP, 'a row with a uid is never touched by the backfill');
  assert.equal(cell(7, R), 'BAL-LEGACY-7-700', 'a cell with any value is "has a uid" to the backfill');
  assert.equal(cell(9, R), '', 'spacer row gets no id');
  // The parser now sees real ids: no row is legacy any more.
  const all = await inventoryRepository.getAll(true);
  assert.ok(all.every((r) => !r._legacy), 'no legacy rows remain');
  assert.equal(all.find((r) => r.rowIndex === 2).addedAt, '2026-02-24', 'addedAt still falls back to DateReceived');
  // Second run: nothing left to do.
  const again = await inventoryRepository.backfillLegacyBales();
  assert.equal(again.matched, 0);
  assert.equal(again.written, 0);
});

test('backfill guard: a row whose column R filled in after the plan is skipped and reported', async () => {
  const res = await inventoryRepository.backfillLegacyBales({
    // Simulates a concurrent writer (ensureRowUids on a transfer) landing
    // between the plan read and the write.
    onPlan: async () => { await fake.updateRange('Inventory', 'R2', [['BAL-20260909-6534-race']]); },
  });
  assert.equal(res.matched, 2);
  assert.equal(res.written, 1);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].rowIndex, 2);
  assert.match(res.skipped[0].why, /no longer blank/);
  assert.equal(cell(2, R), 'BAL-20260909-6534-race', 'the racing uid is kept, not overwritten');
  assert.match(cell(3, R), REAL_UID, 'the untouched row was still written');
});

test('backfill guard: a re-ordered sheet (row no longer holds the planned than) is skipped', async () => {
  const res = await inventoryRepository.backfillLegacyBales({
    onPlan: async () => { await fake.updateRange('Inventory', 'F3', [['9']]); }, // than #2 → #9
  });
  assert.equal(res.written, 1);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].rowIndex, 3);
  assert.match(res.skipped[0].why, /re-ordered/);
  assert.equal(cell(3, R), '', 'nothing written to the moved row');
});

test('dedupe dryRun: the lowest row keeps the uid, later rows are planned; BAL-LEGACY- literals are not duplicates', async () => {
  const res = await inventoryRepository.dedupeBaleUids({ dryRun: true });
  assert.equal(res.matched, 1, 'only row 5 (the second carrier of the duplicate)');
  assert.equal(res.written, 0);
  assert.equal(res.sample[0].rowIndex, 5);
  assert.equal(res.sample[0].currentUid, DUP);
  assert.match(res.sample[0].baleUid, /^BAL-\d{8}-864-[a-z0-9]+$/);
  assert.notEqual(res.sample[0].baleUid, DUP);
  assert.equal(cell(4, R), DUP);
  assert.equal(cell(5, R), DUP, 'dry-run wrote nothing');
});

test('dedupe commit: re-mints only the later row, column R only, idempotent', async () => {
  const res = await inventoryRepository.dedupeBaleUids();
  assert.equal(res.matched, 1);
  assert.equal(res.written, 1);
  assert.equal(cell(4, R), DUP, 'first row keeps the original');
  assert.match(cell(5, R), /^BAL-\d{8}-864-[a-z0-9]+$/);
  assert.notEqual(cell(5, R), DUP);
  assert.equal(cell(5, S), '2026-07-13T10:00:00.000Z', 'addedAt untouched');
  assert.equal(cell(6, R), 'BAL-20260713-865-aaaa', 'unique uid untouched');
  assert.equal(cell(7, R), 'BAL-LEGACY-7-700');
  assert.equal(cell(8, R), 'BAL-LEGACY-7-700', 'synthetic literals are left alone');
  assert.equal(cell(2, R), '', 'dedupe never fills blanks — that is the backfill\'s job');
  const again = await inventoryRepository.dedupeBaleUids();
  assert.equal(again.matched, 0);
});

test('dedupe guard: a row that no longer carries the duplicate is skipped and reported', async () => {
  const res = await inventoryRepository.dedupeBaleUids({
    onPlan: async () => { await fake.updateRange('Inventory', 'R5', [['BAL-20260713-864-hand']]); },
  });
  assert.equal(res.matched, 1);
  assert.equal(res.written, 0);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].rowIndex, 5);
  assert.match(res.skipped[0].why, /no longer carries the duplicate/);
  assert.equal(cell(5, R), 'BAL-20260713-864-hand', 'the hand edit is kept');
});

test('minted ids never collide with a uid already on the sheet or minted in the same run', async () => {
  const res = await inventoryRepository.backfillLegacyBales();
  const after = await inventoryRepository.dedupeBaleUids();
  assert.equal(res.written + after.written, 3);
  const uids = fake._store.get('Inventory').slice(1).map((r) => r[R]).filter(Boolean);
  const real = uids.filter((u) => !u.startsWith('BAL-LEGACY-'));
  assert.equal(new Set(real).size, real.length, 'every real uid is unique');
});

test('baleUidCensus: counts blank live rows and lists real duplicates (synthetic literals excluded)', async () => {
  const before = await inventoryRepository.baleUidCensus();
  assert.equal(before.rows, 7, 'the spacer row is not a live row');
  assert.equal(before.blank, 2);
  assert.deepEqual(before.duplicates, [{ uid: DUP, rowIndexes: [4, 5] }]);
  await inventoryRepository.backfillLegacyBales();
  await inventoryRepository.dedupeBaleUids();
  const after = await inventoryRepository.baleUidCensus();
  assert.equal(after.blank, 0);
  assert.deepEqual(after.duplicates, []);
});
