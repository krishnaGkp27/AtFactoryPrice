'use strict';

/**
 * QTA-1 — the incident's shape, pinned END TO END through fakeSheets.
 *
 * 24-Sep-2026: an approved 20-item bundle sale died on Google's 60
 * writes/min cap because the executor sold item by item. The fix routes
 * the whole request through ONE Inventory batchUpdate and ONE
 * BaleMovements append. The unit tests prove that at the repository
 * boundary with stubs; THIS test runs a successful bundle through the real
 * executor, the real `markItemsSold`, the real `baleMovementLog` and the
 * in-memory sheets, so a later refactor that reintroduces a per-item write
 * (a per-row rate stamp, a per-bale movement append) or changes WHICH rows
 * reach the movement log (they must be the rows as READ — the state they
 * leave, `available @ …`) fails a test that names it.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, SRC } = require('../helpers/controllerHarness');

const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));

const INV_HEADER = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status',
  'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];

function invRow(pkg, thanNo, design, status = 'available') {
  return inventoryRepository.toRow({
    packageNo: pkg, indent: '', csNo: '', design, shade: 'Red', thanNo, yards: 30, status,
    warehouse: 'IDUMOTA', pricePerYard: 100, dateReceived: '2026-01-01', soldTo: status === 'sold' ? 'OLD' : '',
    soldDate: status === 'sold' ? '2026-05-01' : '', netMtrs: '', netWeight: '', updatedAt: '2026-01-01',
    baleUid: `BAL-${pkg}-${thanNo}`, addedAt: '2026-01-01', grnId: '', arrivalBatch: '', designCategory: '',
  });
}

// 20 AVAILABLE thans across six bales (three designs), plus one than that
// already sold — the guard must leave it alone and the bundle must not count it.
const BALES = [['A1', '202/201', 4], ['A2', '202/201', 4], ['B1', '77019', 3], ['B2', '77019', 3], ['C1', '9006', 3], ['C2', '9006', 3]];
const seed = [];
for (const [pkg, design, n] of BALES) for (let t = 1; t <= n; t += 1) seed.push(invRow(pkg, t, design));
seed.push(invRow('A1', 5, '202/201', 'sold'));

const fake = createFakeSheets({ Inventory: [INV_HEADER, ...seed], BaleMovements: [], Transactions: [] });
installFakeSheets(fake);
// Count writes at the sheetsClient BOUNDARY — each call here is one Google
// API request against the 60/min cap. (The fake's batchUpdateRanges fans
// out through its own updateRange; wrapping the fake would count that.)
const sheetsClient = require(path.join(SRC, 'repositories/sheetsClient'));
const writes = [];
for (const m of ['appendRows', 'updateRange', 'batchUpdateRanges', 'addSheet']) {
  const orig = sheetsClient[m];
  sheetsClient[m] = async (...a) => {
    writes.push({ m, sheet: a[0], n: m === 'batchUpdateRanges' || m === 'appendRows' ? a[1].length : 1 });
    return orig(...a);
  };
}

const inventoryService = require(path.join(SRC, 'services/inventoryService'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
const auditService = require(path.join(SRC, 'services/auditService'));
const invoiceService = require(path.join(SRC, 'services/invoiceService'));

invoiceService.createForSale = async () => null;
auditService.log = async () => true;
auditLogRepository.append = async () => {};
const ledger = [];
accountingService.recordSale = async (p) => { ledger.push(p); return true; };

const ROW = {
  requestId: 'R-QTA1', user: '888', status: 'pending', createdAt: '2026-09-24T09:00:00.000Z',
  actionJSON: {
    action: 'sale_bundle', customer: 'ABBA', salesDate: '2026-09-24', warehouse: 'IDUMOTA',
    items: [
      { type: 'package', packageNo: 'A1', warehouse: 'IDUMOTA' },
      { type: 'package', packageNo: 'A2', warehouse: 'IDUMOTA' },
      { type: 'package', packageNo: 'B1', warehouse: 'IDUMOTA' },
      { type: 'package', packageNo: 'B2', warehouse: 'IDUMOTA' },
      { type: 'package', packageNo: 'C1', warehouse: 'IDUMOTA' },
      { type: 'than', packageNo: 'C2', thanNo: 1, warehouse: 'IDUMOTA' },
      { type: 'than', packageNo: 'C2', thanNo: 2, warehouse: 'IDUMOTA' },
      { type: 'than', packageNo: 'C2', thanNo: 3, warehouse: 'IDUMOTA' },
    ],
  },
};
let resolved = false;
approvalQueueRepository.getAllPending = async () => (resolved ? [] : [JSON.parse(JSON.stringify(ROW))]);
approvalQueueRepository.getByRequestId = async (id) => (id === ROW.requestId ? JSON.parse(JSON.stringify(ROW)) : null);
approvalQueueRepository.updateStatus = async (id, status) => { if (status === 'approved') resolved = true; return true; };
approvalQueueRepository.updateActionJSON = async () => true;

const by = (m, sheet) => writes.filter((w) => w.m === m && w.sheet === sheet);

test('a 20-than bundle sale is ONE Inventory batchUpdate and ONE BaleMovements append, logged available → sold', async () => {
  const res = await inventoryService.executeApprovedAction('R-QTA1', '777',
    { ratePerUnitByDesign: { '202/201': 1450, '77019': 1200, '9006': 900 }, paymentMode: 'Cash', amountPaid: 0 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual({ p: res.bundleReport.appliedPkgCount, t: res.bundleReport.appliedThans, y: res.bundleReport.appliedYards, f: res.bundleReport.failedItems },
    { p: 6, t: 20, y: 600, f: [] });

  // ONE write flips the stock — the incident's shape.
  assert.equal(by('batchUpdateRanges', 'Inventory').length, 1, 'exactly one Inventory batchUpdate');
  assert.equal(by('updateRange', 'Inventory').length, 0, 'no per-row Inventory write (a per-item rate stamp would land here)');
  assert.equal(by('appendRows', 'Inventory').length, 0);
  // 20 sold rows (H:P) + the rate stamp on the one untouched row of A1 (J + P).
  assert.equal(by('batchUpdateRanges', 'Inventory')[0].n, 22);

  // ONE movement append, one row per bale, from the state the rows LEFT.
  assert.equal(by('appendRows', 'BaleMovements').length, 1, 'exactly one BaleMovements append');
  const moves = fake._store.get('BaleMovements').slice(1);
  const H = fake._store.get('BaleMovements')[0];
  const col = (name) => H.indexOf(name);
  assert.equal(moves.length, 6, 'one row per bale');
  assert.deepEqual([...new Set(moves.map((r) => `${r[col('FromState')]} → ${r[col('ToState')]}`))], ['available @ IDUMOTA → sold @ IDUMOTA']);
  assert.equal(moves.reduce((s, r) => s + Number(r[col('Thans')]), 0), 20);
  assert.ok(moves.every((r) => r[col('Kind')] === 'sale' && r[col('Ref')] === 'ABBA' && r[col('MovedOn')] === '2026-09-24'));

  // The sheet itself: every seeded available row is sold to ABBA on the sale
  // date at its design's negotiated rate; the pre-sold than is untouched.
  const inv = fake._store.get('Inventory').slice(1);
  const soldNow = inv.filter((r) => r[11] === 'ABBA');
  assert.equal(soldNow.length, 20);
  assert.ok(soldNow.every((r) => r[7] === 'sold' && r[12] === '2026-09-24'));
  assert.deepEqual([...new Set(soldNow.map((r) => `${r[3]}=${r[9]}`))].sort(), ['202/201=1450', '77019=1200', '9006=900']);
  const old = inv.find((r) => r[0] === 'A1' && String(r[5]) === '5');
  assert.equal(old[11], 'OLD', 'SEC-P2 C5: the already-sold than keeps its buyer');
  assert.equal(old[9], 1450, 'but takes the bale\'s new rate (updatePrice contract)');

  // The money side still follows: one Transactions row, one ledger debit per design.
  assert.equal(by('appendRows', 'Transactions').length, 1);
  const txn = fake._store.get('Transactions').slice(-1)[0];
  assert.ok(txn.includes('sale_bundle') && txn.includes('R-QTA1') && txn.includes(600), JSON.stringify(txn));
  assert.deepEqual(ledger.map((l) => [l.design, l.yards, l.pricePerYard]).sort(), [['202/201', 240, 1450], ['77019', 180, 1200], ['9006', 180, 900]]);
});
