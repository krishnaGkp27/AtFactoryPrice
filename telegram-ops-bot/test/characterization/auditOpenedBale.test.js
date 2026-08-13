'use strict';

/**
 * WAU-4 (owner, 13-Aug-2026) — the opened-bale equivalence.
 *
 * The owner's exact scenario: design 9032 shade 2, two bales opened — one
 * born with 6 pieces, one with 4 — piles physically mixed. The count rule
 * is physical (sealed = bale, opened = pieces), so a bale opened for
 * display with NOTHING sold reads differently on the two sides: book says
 * full bale, count says loose pieces. The reconciliation now recognises
 * that swap — but ONLY when the surplus pieces equal the missing bales'
 * own ledger piece counts exactly. Pinned:
 *
 *  - k bales counted as their pieces reconcile, variable sizes included;
 *  - one missing piece is NEVER forgiven — still a mismatch → recount;
 *  - extra bales, or surplus with no bale shortfall, stay mismatches;
 *  - the equivalence uses row-level ledger truth, never an assumed size.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';
process.env.WAREHOUSE_AUDIT_ENABLED = 'true';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, loadController, SRC } = require('../helpers/controllerHarness');

const INV_HEADER = [
  'PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status',
  'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs',
  'NetWeight', 'UpdatedAt', 'ProductType', 'bale_uid', 'addedAt', 'grn_id',
  'bin_location', 'arrival_batch', 'design_category',
];
const invRow = (pkg, design, shade, than, status) => {
  const r = new Array(23).fill('');
  r[0] = pkg; r[3] = design; r[4] = shade; r[5] = than; r[6] = '30';
  r[7] = status; r[8] = 'Kano office'; r[17] = `U-${pkg}-${than}`;
  return r;
};

// Design 9032 in Kano office, the owner's mixed reality:
//   bale B6: born 6 pieces, ALL still available (closed on the books)
//   bale B4: born 4 pieces, ALL still available (closed on the books)
//   bale B5: born 5 pieces, 2 sold → 3 loose on the books
// Book line: 2 bales + 3 loose. Closed sizes = [6, 4].
function seedRows() {
  const rows = [INV_HEADER];
  for (let t = 1; t <= 6; t += 1) rows.push(invRow('B6', '9032', '2', t, 'available'));
  for (let t = 1; t <= 4; t += 1) rows.push(invRow('B4', '9032', '2', t, 'available'));
  for (let t = 1; t <= 3; t += 1) rows.push(invRow('B5', '9032', '2', t, 'available'));
  rows.push(invRow('B5', '9032', '2', 4, 'sold'));
  rows.push(invRow('B5', '9032', '2', 5, 'sold'));
  return rows;
}

installFakeSheets(createFakeSheets({ Inventory: seedRows(), StockTakes: [[]] }));
loadController();

const stockTakesRepository = require(path.join(SRC, 'repositories/stockTakesRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const flow = require(path.join(SRC, 'flows/warehouseAuditFlow'));

auditLogRepository.append = async () => {};

let takes = [];
stockTakesRepository.appendMany = async (rows) => {
  const stamped = rows.map((r, i) => ({ ...r, stocktake_id: `ST-${takes.length + i}`, audited_at: new Date().toISOString() }));
  takes.push(...stamped);
  return stamped;
};
stockTakesRepository.getAll = async () => takes;
stockTakesRepository.latestFor = async () => new Map();

const reconcile = (bales, bundles) => flow._internals.reconcileDesign({
  warehouse: 'Kano office', location: '', design: '9032', bales, bundles, auditor: '4242',
});

test('exact book count still matches: 2 bales + 3 loose', async () => {
  takes = [];
  const out = await reconcile(2, 3);
  assert.equal(out.status, 'match');
});

test('the 6-piece bale counted as opened pieces reconciles: 1 + 9', async () => {
  takes = [];
  const out = await reconcile(1, 9);
  assert.equal(out.status, 'match_opened');
  assert.equal(out.openedBales, 1);
  assert.match(takes[0].note, /opened-bale match: 1 bale/);
  assert.equal(takes[0].result, 'reconciled');
});

test('the 4-piece bale as pieces also reconciles: 1 + 7 — variable sizes, no assumed 6', async () => {
  takes = [];
  const out = await reconcile(1, 7);
  assert.equal(out.status, 'match_opened');
});

test('BOTH bales as pieces reconcile: 0 + 13', async () => {
  takes = [];
  const out = await reconcile(0, 13);
  assert.equal(out.status, 'match_opened');
  assert.equal(out.openedBales, 2);
});

test('one missing piece is never forgiven: 1 + 8 stays a mismatch', async () => {
  takes = [];
  // 1 bale short, 5 surplus… neither 6 nor 4 equals 5: a piece is missing
  // somewhere (or a bale was misjudged). Recount, then flag — unchanged.
  const out = await reconcile(1, 8);
  assert.equal(out.status, 'recount');
  assert.equal(takes[0].result, 'mismatch');
});

test('surplus pieces with NO bale shortfall stay a mismatch: 2 + 5', async () => {
  takes = [];
  const out = await reconcile(2, 5);
  assert.equal(out.status, 'recount', 'extra loose pieces are a real finding, not an equivalence');
});

test('extra bales stay a mismatch: 3 + 3', async () => {
  takes = [];
  const out = await reconcile(3, 3);
  assert.equal(out.status, 'recount');
});
