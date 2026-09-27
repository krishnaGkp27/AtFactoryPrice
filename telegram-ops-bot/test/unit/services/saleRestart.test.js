'use strict';

/**
 * QTA-2 — saleRestart: "is this row's stock gone because THIS sale already
 * took it?" (sold to the request's customer on its sale date), judged per
 * ROW the way the writer resolves rows; and the restart plan: a row another
 * PENDING sale of the same customer/day covers BLOCKS, a row an APPROVED
 * one covers is a duplicate (left sold), the rest is put back. The APF-2
 * stock check no longer calls a bundle item with own rows "gone".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const R = require(path.join(SRC, 'services/saleRestart'));
const { allItemsGone, itemsOf } = require(path.join(SRC, 'services/saleStockCheck'));

const AJ = { action: 'sale_bundle', customer: 'Ayubal Ansari', salesDate: '2026-09-25', warehouse: 'Kano office', items: [] };
let idx = 2;
function row(pkg, thanNo, status, opts = {}) {
  return { rowIndex: opts.rowIndex || idx++, packageNo: pkg, thanNo, design: opts.design || '9037', yards: 30, warehouse: opts.wh || 'Kano office', status, soldTo: opts.soldTo || '', soldDate: opts.soldDate || '', baleUid: opts.uid || '' };
}
const mine = (pkg, thanNo, opts = {}) => row(pkg, thanNo, 'sold', { soldTo: 'ayubal ansari', soldDate: '25/09/2026', ...opts });
const theirs = (pkg, thanNo, opts = {}) => row(pkg, thanNo, 'sold', { soldTo: 'Zakirullah', soldDate: '2026-07-08', ...opts });

test('dayOf reads every spelling the doors store and nothing relative or parse-guessed; nameSet lower-cases and drops blanks', () => {
  assert.equal(R.dayOf('2026-09-25'), '2026-09-25');
  assert.equal(R.dayOf('25/09/2026'), '2026-09-25');
  assert.equal(R.dayOf('25-09-2026'), '2026-09-25');
  assert.equal(R.dayOf('25.09.2026'), '2026-09-25');
  assert.equal(R.dayOf(''), '');
  assert.equal(R.dayOf('sometime'), '', 'an unreadable spelling is not a day');
  assert.equal(R.dayOf('yesterday'), '', 'a relative word names a different day every day');
  assert.equal(R.dayOf('today'), '');
  assert.equal(R.dayOf('Thu, 25 Sep 2026'), '', 'no Date.parse fallback (it shifts under a non-UTC clock)');
  assert.deepEqual([...R.nameSet(['AYUBAL ANSARI', ' Ayubal ', ''])], ['ayubal ansari', 'ayubal']);
});

test('rowSoldForThisSale: same customer on the same day; not another buyer, day or status', () => {
  assert.equal(R.rowSoldForThisSale(mine('771', 1), AJ), true);
  assert.equal(R.rowSoldForThisSale(row('771', 1, 'sold', { soldTo: 'Musa', soldDate: '2026-09-25' }), AJ), false);
  assert.equal(R.rowSoldForThisSale(row('771', 1, 'sold', { soldTo: 'Ayubal Ansari', soldDate: '2026-09-24' }), AJ), false);
  assert.equal(R.rowSoldForThisSale(row('771', 1, 'available'), AJ), false);
  assert.equal(R.rowSoldForThisSale(mine('771', 1), { ...AJ, customer: '' }), false, 'a blank customer never matches');
  // Any registered spelling of the customer owns the row (CUS-2 aliases).
  const alias = row('771', 1, 'sold', { soldTo: 'Ayubal', soldDate: '2026-09-25' });
  assert.equal(R.rowSoldForThisSale(alias, AJ), false, 'the typed name alone');
  assert.equal(R.rowSoldForThisSale(alias, AJ, R.nameSet(['Ayubal Ansari', 'Ayubal'])), true);
});

test('itemRows resolves rows the way the writer does: a package = its rows in the store; a than = the uid-pinned row, else the first match', () => {
  const kanoA = mine('771', 1, { uid: 'BAL-A' });
  const kanoB = row('771', 1, 'available', { uid: 'BAL-B' });
  const idu = row('771', 1, 'available', { wh: 'IDUMOTA' });
  const inv = [kanoA, kanoB, idu, mine('771', 2)];
  assert.deepEqual(R.itemRows({ type: 'package', packageNo: '771' }, AJ, inv).map((r) => r.rowIndex), [kanoA.rowIndex, kanoB.rowIndex, inv[3].rowIndex], 'scoped to the bundle store');
  assert.deepEqual(R.itemRows({ type: 'package', packageNo: '771', warehouse: 'IDUMOTA' }, AJ, inv).map((r) => r.rowIndex), [idu.rowIndex]);
  assert.deepEqual(R.itemRows({ type: 'than', packageNo: '771', thanNo: 1, baleUid: 'BAL-B' }, AJ, inv).map((r) => r.rowIndex), [kanoB.rowIndex], 'the uid pins');
  assert.deepEqual(R.itemRows({ type: 'than', packageNo: '771', thanNo: 1, baleUid: 'BAL-LEGACY-9' }, AJ, inv).map((r) => r.rowIndex), [kanoA.rowIndex], 'a stale uid falls back to the first match');
  assert.deepEqual(R.itemRows({ type: 'than', packageNo: '771', thanNo: 1 }, AJ, inv).map((r) => r.rowIndex), [kanoA.rowIndex]);
  assert.deepEqual(R.itemRows({ type: 'than', packageNo: '771', thanNo: 9 }, AJ, inv), []);
  assert.deepEqual(R.itemRows({ type: 'bale', packageNo: '771' }, AJ, inv), []);
});

test('ownRows is judged per ROW: a bale carrying a than sold to someone else months ago still owns its own thans', () => {
  const inv = [mine('6189', 5, { design: '9006' }), theirs('6189', 4, { design: '9006' }), mine('771', 1), mine('771', 2), row('772', 1, 'available')];
  const aj = { ...AJ, items: [{ type: 'package', packageNo: '6189' }, { type: 'than', packageNo: '6189', thanNo: 4 }, { type: 'package', packageNo: '771' }, { type: 'package', packageNo: '772' }] };
  assert.deepEqual(R.ownRows(aj.items[0], aj, inv).map((r) => r.thanNo), [5], 'the July-sold than is not this sale\'s');
  assert.equal(R.hasOwnRows(aj.items[1], aj, inv), false);
  assert.deepEqual(R.ownRowsByItem(aj, inv).map((x) => [x.item.packageNo, x.rows.length]), [['6189', 1], ['771', 2]]);
  // A bale named whole AND one of its thans: the row is claimed once (the writer's `taken` guard).
  const twice = { ...AJ, items: [{ type: 'package', packageNo: '771' }, { type: 'than', packageNo: '771', thanNo: 1 }] };
  assert.deepEqual(R.ownRowsByItem(twice, inv).map((x) => [x.item.type, x.rows.length]), [['package', 2]]);
  // Rows of the request's items sold on its date to SOMEONE ELSE.
  const musa = row('779', 1, 'sold', { soldTo: 'Musa', soldDate: '2026-09-25' });
  const old = row('779', 2, 'sold', { soldTo: 'Musa', soldDate: '2026-07-01' });
  const f = R.foreignSameDayRows({ ...AJ, items: [{ type: 'package', packageNo: '779' }, { type: 'package', packageNo: '771' }] }, [...inv, musa, old]);
  assert.deepEqual(f.map((r) => [r.packageNo, r.thanNo, r.soldTo]), [['779', 1, 'Musa']], 'another day is not foreign-same-day; own rows are not foreign');
});

test('claimsRow: pending / booked / any — another request, same customer (any spelling) unless "any", same or unreadable day, covering that row in that store', () => {
  const rowK = mine('771', 3);
  const names = R.nameSet(['Ayubal Ansari', 'Ayubal']);
  const ctx = (kind, extra = {}) => ({ requestId: 'me', day: '2026-09-25', names, reverted: new Set(), hasSaleBooks: () => false, kind, ...extra });
  const base = { requestId: 'o', status: 'approved', actionJSON: { action: 'sale_bundle', customer: 'AYUBAL ANSARI', salesDate: '25-09-2026', items: [{ type: 'package', packageNo: '771' }] } };
  assert.equal(R.claimsRow(base, rowK, ctx('booked')), true);
  assert.equal(R.claimsRow({ ...base, requestId: 'me' }, rowK, ctx('booked')), false, 'never this request');
  assert.equal(R.claimsRow({ ...base, status: 'pending' }, rowK, ctx('booked')), false);
  assert.equal(R.claimsRow({ ...base, status: 'pending' }, rowK, ctx('pending')), true);
  assert.equal(R.claimsRow(base, rowK, ctx('pending')), false);
  assert.equal(R.claimsRow({ ...base, status: 'rejected' }, rowK, ctx('booked')), false, 'a plain rejected request claims nothing');
  assert.equal(R.claimsRow({ ...base, status: 'rejected' }, rowK, ctx('booked', { hasSaleBooks: (id) => id === 'o' })), true, 'a rejected request that BOOKED the sale still owns it');
  assert.equal(R.claimsRow(base, rowK, ctx('booked', { reverted: new Set(['o']) })), false, 'a reverted sale claims nothing');
  assert.equal(R.claimsRow({ ...base, actionJSON: { ...base.actionJSON, customer: 'Ayubal' } }, rowK, ctx('booked')), true, 'an alias of the same customer claims');
  assert.equal(R.claimsRow({ ...base, actionJSON: { ...base.actionJSON, customer: 'Musa' } }, rowK, ctx('booked')), false, 'another customer does not');
  assert.equal(R.claimsRow({ ...base, actionJSON: { ...base.actionJSON, customer: 'Musa' } }, rowK, ctx('any')), true, '…except to explain a foreign row');
  assert.equal(R.claimsRow({ ...base, status: 'rejected', actionJSON: { ...base.actionJSON, customer: 'Musa' } }, rowK, ctx('any')), false);
  assert.equal(R.claimsRow({ ...base, actionJSON: { ...base.actionJSON, salesDate: '2026-09-23' } }, rowK, ctx('booked')), false, 'a readable different day clears it');
  assert.equal(R.claimsRow({ ...base, actionJSON: { ...base.actionJSON, salesDate: 'yesterday' } }, rowK, ctx('booked')), true, 'an unreadable (or relative) day cannot clear it');
  assert.equal(R.claimsRow({ ...base, actionJSON: { ...base.actionJSON, action: 'transfer_stock' } }, rowK, ctx('booked')), false);
  assert.equal(R.claimsRow({ ...base, actionJSON: { ...base.actionJSON, warehouse: 'IDUMOTA' } }, rowK, ctx('booked')), false, 'another store is another bale');
  // Coverage is per row: a than item covers its than only; a package item every than.
  const thanItem = { ...base, actionJSON: { action: 'sell_than', customer: 'Ayubal Ansari', salesDate: '2026-09-25', packageNo: '771', thanNo: 1 } };
  assert.equal(R.claimsRow(thanItem, rowK, ctx('booked')), false);
  assert.equal(R.claimsRow(thanItem, mine('771', 1), ctx('booked')), true);
  assert.equal(R.claimsRow({ ...base, actionJSON: { action: 'sell_package', customer: 'Ayubal Ansari', salesDate: '2026-09-25', packageNo: '771' } }, rowK, ctx('booked')), true);
});

test('planRestart splits own rows into put-back, duplicate (approved cover) and blocked (pending cover)', () => {
  const r1 = mine('771', 1); const r2 = mine('771', 2); const r3 = mine('775', 1); const r4 = mine('779', 1);
  const aj = { ...AJ, items: [{ type: 'package', packageNo: '771' }, { type: 'package', packageNo: '775' }, { type: 'package', packageNo: '779' }] };
  const own = [{ item: aj.items[0], rows: [r1, r2] }, { item: aj.items[1], rows: [r3] }, { item: aj.items[2], rows: [r4] }];
  const approvedThan = { requestId: 'aaaa-1', status: 'approved', actionJSON: { action: 'sell_than', customer: 'Ayubal Ansari', salesDate: '2026-09-25', packageNo: '771', thanNo: 1 } };
  const approvedBale = { requestId: 'bbbb-2', status: 'approved', actionJSON: { action: 'sale_bundle', customer: 'Ayubal Ansari', salesDate: '2026-09-25', items: [{ type: 'package', packageNo: '775' }] } };
  const revertOfBale = { requestId: 'rv-1', status: 'approved', actionJSON: { action: 'revert_sale_bundle', saleRefId: 'bbbb-2' } };
  const pendingBale = { requestId: 'pppp-3', status: 'pending', actionJSON: { action: 'sale_bundle', customer: 'ayubal ansari', salesDate: '25/09/2026', items: [{ type: 'package', packageNo: '779' }] } };
  const me = { requestId: 'me', status: 'pending', actionJSON: aj };
  const plan = R.planRestart({ aj, requestId: 'me', own, resolved: [approvedThan, approvedBale], pending: [me, pendingBale], hasSaleBooks: (id) => id === 'pppp-3' });
  assert.deepEqual(plan.revert.map((r) => [r.packageNo, r.thanNo]), [['771', 2]], '771/1 is the approved than sale\'s; 775 the approved bale sale\'s; 779 blocked');
  assert.deepEqual(plan.duplicates.map((d) => [d.row.packageNo, d.row.thanNo, d.otherRequestId]), [['771', 1, 'aaaa-1'], ['775', 1, 'bbbb-2']]);
  assert.deepEqual(plan.blockedBy.map((b) => [b.row.packageNo, b.otherRequestId, b.otherBooked]), [['779', 'pppp-3', true]]);
  assert.deepEqual(plan.items.map((x) => [x.item.packageNo, x.revert.length, x.duplicate.length]), [['771', 1, 1], ['775', 0, 1], ['779', 0, 0]]);
  // The reverted bale sale claims nothing → 775 is put back.
  const plan2 = R.planRestart({ aj, requestId: 'me', own, resolved: [approvedThan, approvedBale, revertOfBale], pending: [me] });
  assert.deepEqual(plan2.revert.map((r) => [r.packageNo, r.thanNo]), [['771', 2], ['775', 1], ['779', 1]]);
  assert.deepEqual([...R.revertedSaleIds([approvedBale, revertOfBale, { ...revertOfBale, status: 'pending', requestId: 'rv-2', actionJSON: { action: 'revert_sale_bundle', saleRefId: 'aaaa-1' } }])], ['bbbb-2']);
  // No other requests at all → everything is put back.
  const plan3 = R.planRestart({ aj, requestId: 'me', own, resolved: [], pending: [me] });
  assert.equal(plan3.revert.length, 4);
  assert.equal(plan3.blockedBy.length + plan3.duplicates.length + plan3.stranded.length, 0);
  // A foreign same-day row nothing explains is STRANDED; one another request covers is not.
  const musaRow = row('772', 1, 'sold', { soldTo: 'Musa', soldDate: '2026-09-25' });
  const musaSale = { requestId: 'mmmm-4', status: 'approved', actionJSON: { action: 'sell_than', customer: 'Musa', salesDate: '2026-09-25', packageNo: '772', thanNo: 1 } };
  assert.deepEqual(R.planRestart({ aj, requestId: 'me', own: [], foreign: [musaRow], resolved: [], pending: [me] }).stranded.map((r) => r.soldTo), ['Musa']);
  assert.deepEqual(R.planRestart({ aj, requestId: 'me', own: [], foreign: [musaRow], resolved: [musaSale], pending: [me] }).stranded, []);
});

test('allItemsGone: a bundle whose gone items are its own earlier flips is NOT gone (the wizard runs); single doors unchanged', () => {
  const inv = [mine('771', 1), mine('771', 2), mine('779', 1), theirs('779', 2)];
  const own = { ...AJ, items: [{ type: 'package', packageNo: '771' }, { type: 'package', packageNo: '779' }] };
  assert.equal(allItemsGone(own, inv), false);
  assert.equal(allItemsGone({ ...AJ, customer: 'Musa', items: own.items }, inv), true, 'sold to someone else → gone as before');
  assert.equal(allItemsGone({ ...AJ, items: [{ type: 'package', packageNo: '779' }] }, inv), false, 'a bale with ONE own than is not gone (per row)');
  assert.equal(allItemsGone({ action: 'sell_than', customer: 'Ayubal Ansari', salesDate: '2026-09-25', packageNo: '771', thanNo: 1, warehouse: 'Kano office' }, inv), true);
  assert.equal(allItemsGone({ action: 'sell_package', customer: 'Ayubal Ansari', salesDate: '2026-09-25', packageNo: '771', warehouse: 'Kano office' }, inv), true);
});

test('itemsOf: the single doors carry their type and than', () => {
  assert.deepEqual(itemsOf({ action: 'sell_than', packageNo: '5', thanNo: 2, warehouse: 'W' }), [{ type: 'than', packageNo: '5', thanNo: 2, warehouse: 'W' }]);
  assert.deepEqual(R.itemsOf({ action: 'sell_package', packageNo: '5', warehouse: 'W' }), [{ type: 'package', packageNo: '5', thanNo: undefined, warehouse: 'W' }]);
  assert.deepEqual(R.itemsOf({ action: 'transfer_stock' }), []);
});

test('readBooks: one read of each book sheet, indexed per request; sale books vs the payment pair; a failing read throws', async () => {
  const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
  const ledgerRepository = require(path.join(SRC, 'repositories/ledgerRepository'));
  const invoicesRepository = require(path.join(SRC, 'repositories/invoicesRepository'));
  const orig = { t: transactionsRepository.getAll, l: ledgerRepository.getAll, i: invoicesRepository.getAll };
  let reads = 0;
  try {
    transactionsRepository.getAll = async () => { reads += 1; return [{ action: 'sale_bundle', saleRefId: 'a' }, { action: 'payment', saleRefId: 'c' }]; };
    ledgerRepository.getAll = async () => { reads += 1; return [{ txn_id: 'b-9037' }, { txn_id: 'me-PAY' }, { txn_id: 'other-9037' }]; };
    invoicesRepository.getAll = async () => { reads += 1; return [{ requestId: 'd', invoiceNo: 'INV-1' }]; };
    const b = await R.readBooks();
    assert.equal(reads, 3, 'one read per sheet');
    assert.deepEqual(['a', 'b', 'c', 'd', 'me', ''].map((id) => b.hasSaleBooks(id)), [true, true, false, true, false, false]);
    const me = b.forRequest('me');
    assert.deepEqual({ pay: me.ledgerPay.length, sale: me.ledgerSale.length, any: me.sale }, { pay: 1, sale: 0, any: false }, 'the payment pair alone is not a booked sale');
    assert.equal(b.forRequest('d').invoice.invoiceNo, 'INV-1');
    ledgerRepository.getAll = async () => { throw new Error('rate-limiting reads'); };
    await assert.rejects(R.readBooks(), /rate-limiting reads/);
  } finally {
    transactionsRepository.getAll = orig.t; ledgerRepository.getAll = orig.l; invoicesRepository.getAll = orig.i;
  }
});
