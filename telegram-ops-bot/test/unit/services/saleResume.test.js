'use strict';

/**
 * QTA-2 — saleResume: "is this item's stock gone because THIS sale already
 * took it?" Resumed = sold to the request's customer on its date and no
 * other APPROVED request for that customer and day covers it; duplicate =
 * such a request exists; failed = anything else. With the resolved queue
 * unreadable nothing resumes. The APF-2 stock check no longer calls a
 * resumable item "gone".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const R = require(path.join(SRC, 'services/saleResume'));
const { allItemsGone, itemsOf } = require(path.join(SRC, 'services/saleStockCheck'));

const AJ = { action: 'sale_bundle', customer: 'Ayubal Ansari', salesDate: '2026-09-25', warehouse: 'Kano office', items: [] };
function row(pkg, thanNo, status, opts = {}) {
  return { packageNo: pkg, thanNo, design: opts.design || '9037', yards: 30, warehouse: opts.wh || 'Kano office', status, soldTo: opts.soldTo || '', soldDate: opts.soldDate || '' };
}
const mine = (pkg, thanNo, opts = {}) => row(pkg, thanNo, 'sold', { soldTo: 'ayubal ansari', soldDate: '25-09-2026', ...opts });

test('rowSoldForThisSale: same customer (any case) on the same day (any spelling); not another buyer, day or status', () => {
  assert.equal(R.rowSoldForThisSale(mine('771', 1), AJ), true);
  assert.equal(R.rowSoldForThisSale(row('771', 1, 'sold', { soldTo: 'Musa', soldDate: '2026-09-25' }), AJ), false);
  assert.equal(R.rowSoldForThisSale(row('771', 1, 'sold', { soldTo: 'Ayubal Ansari', soldDate: '2026-09-24' }), AJ), false);
  assert.equal(R.rowSoldForThisSale(row('771', 1, 'available'), AJ), false);
  assert.equal(R.rowSoldForThisSale(mine('771', 1), { ...AJ, customer: '' }), false, 'a blank customer never matches');
});

test('isResumableItem / resumableItems: a bale is resumable only when EVERY than of it in that store is this sale\'s', () => {
  const inv = [mine('771', 1), mine('771', 2), mine('779', 1), row('779', 2, 'available'), mine('6189', 5, { design: '9006' }), row('6189', 4, 'sold', { design: '9006', soldTo: 'Zakirullah', soldDate: '2026-07-08' })];
  const aj = { ...AJ, items: [{ type: 'package', packageNo: '771' }, { type: 'package', packageNo: '779' }, { type: 'than', packageNo: '6189', thanNo: 5 }, { type: 'than', packageNo: '6189', thanNo: 4 }] };
  assert.equal(R.isResumableItem(aj.items[0], aj, inv), true);
  assert.equal(R.isResumableItem(aj.items[1], aj, inv), false, 'one than still available → not a resume, a normal partial');
  assert.equal(R.isResumableItem(aj.items[2], aj, inv), true, 'a than item looks only at its own than');
  assert.equal(R.isResumableItem(aj.items[3], aj, inv), false);
  assert.deepEqual(R.resumableItems(aj, inv).map((i) => `${i.packageNo}${i.thanNo ? '/' + i.thanNo : ''}`), ['771', '6189/5']);
  // Warehouse scope: the same number in another store is not this bale.
  assert.equal(R.isResumableItem({ type: 'package', packageNo: '771', warehouse: 'IDUMOTA' }, aj, inv), false);
});

test('classifyFailed: resumed vs duplicate vs failed; an unreadable queue resumes nothing', () => {
  const aj = { ...AJ, items: [{ type: 'package', packageNo: '771' }, { type: 'than', packageNo: '6189', thanNo: 5 }, { type: 'package', packageNo: '772' }, { type: 'package', packageNo: '999' }] };
  const failed = [
    { item: aj.items[0], reason: 'not found or no available thans', rows: [mine('771', 1), mine('771', 2)] },
    { item: aj.items[1], reason: 'not found or not available', rows: [mine('6189', 5, { design: '9006' })] },
    { item: aj.items[2], reason: 'not found or no available thans', rows: [row('772', 1, 'sold', { soldTo: 'Musa', soldDate: '2026-09-25' })] },
    { item: aj.items[3], reason: 'not found or no available thans', rows: [] },
  ];
  const resolved = [
    // another approved sale to the same customer, same day, covering 6189/5 (a than item)
    { requestId: 'other-1', status: 'approved', actionJSON: { action: 'sell_than', customer: 'AYUBAL ANSARI', salesDate: '2026-09-25', packageNo: '6189', thanNo: 5 } },
    // same customer, ANOTHER day, covering 771 — irrelevant
    { requestId: 'other-2', status: 'approved', actionJSON: { action: 'sale_bundle', customer: 'Ayubal Ansari', salesDate: '2026-09-23', items: [{ type: 'package', packageNo: '771' }] } },
    // same day, same customer, but rejected — does not claim anything
    { requestId: 'other-3', status: 'rejected', actionJSON: { action: 'sale_bundle', customer: 'Ayubal Ansari', salesDate: '2026-09-25', items: [{ type: 'package', packageNo: '771' }] } },
    // this very request (already resolved copy) must not count as "other"
    { requestId: 'me', status: 'approved', actionJSON: { ...aj } },
  ];
  const out = R.classifyFailed({ failed, aj, requestId: 'me', resolved });
  assert.deepEqual(out.map((c) => [c.entry.item.packageNo, c.kind, c.otherRequestId]), [
    ['771', 'resumed', null],
    ['6189', 'duplicate', 'other-1'],
    ['772', 'failed', null],
    ['999', 'failed', null],
  ]);
  assert.equal(out[0].rows.length, 2);
  const none = R.classifyFailed({ failed, aj, requestId: 'me', resolved: null });
  assert.ok(none.every((c) => c.kind === 'failed'), 'no resolved queue → nothing resumes');
});

test('otherRequestCovering: a whole-bale item of another request covers a than of that bale, and a than item covers only itself', () => {
  const aj = { ...AJ };
  const bale = { requestId: 'o', status: 'approved', actionJSON: { action: 'sale_bundle', customer: 'Ayubal Ansari', salesDate: '2026-09-25', items: [{ type: 'package', packageNo: '771' }] } };
  const than = { requestId: 'o', status: 'approved', actionJSON: { action: 'sale_bundle', customer: 'Ayubal Ansari', salesDate: '2026-09-25', items: [{ type: 'than', packageNo: '771', thanNo: 2 }] } };
  assert.equal(R.otherRequestCovering({ type: 'than', packageNo: '771', thanNo: 3 }, aj, 'me', [bale]), 'o');
  assert.equal(R.otherRequestCovering({ type: 'than', packageNo: '771', thanNo: 3 }, aj, 'me', [than]), null);
  assert.equal(R.otherRequestCovering({ type: 'than', packageNo: '771', thanNo: 2 }, aj, 'me', [than]), 'o');
  assert.equal(R.otherRequestCovering({ type: 'package', packageNo: '771' }, aj, 'me', [than]), 'o', 'a than sold elsewhere means the bale is not wholly this sale\'s');
});

test('allItemsGone: a request whose gone items are its own earlier flips is NOT gone (the wizard runs, not Mark-as-done)', () => {
  const inv = [mine('771', 1), mine('771', 2), mine('779', 1)];
  const own = { ...AJ, items: [{ type: 'package', packageNo: '771' }, { type: 'package', packageNo: '779' }] };
  assert.equal(allItemsGone(own, inv), false);
  const theirs = { ...AJ, customer: 'Musa', items: own.items };
  assert.equal(allItemsGone(theirs, inv), true, 'sold to someone else → gone as before');
  const partly = { ...AJ, items: [{ type: 'package', packageNo: '771' }, { type: 'package', packageNo: '772' }] };
  assert.equal(allItemsGone(partly, [...inv, row('772', 1, 'sold', { soldTo: 'Musa', soldDate: '2026-09-25' })]), false, 'one own item keeps the wizard open');
  // The single doors have no resume path: their own flip still reads as gone
  // so the Mark-as-done / Reject choice stays on offer.
  assert.equal(allItemsGone({ action: 'sell_than', customer: 'Ayubal Ansari', salesDate: '2026-09-25', packageNo: '771', thanNo: 1, warehouse: 'Kano office' }, inv), true);
  assert.equal(allItemsGone({ action: 'sell_package', customer: 'Ayubal Ansari', salesDate: '2026-09-25', packageNo: '771', warehouse: 'Kano office' }, inv), true);
});

test('a sale undone by an approved revert_sale_bundle claims nothing — its bales resume, not "duplicate"', () => {
  const aj = { ...AJ, items: [{ type: 'package', packageNo: '771' }] };
  const failed = [{ item: aj.items[0], reason: 'not found or no available thans', rows: [mine('771', 1), mine('771', 2)] }];
  const earlier = { requestId: 'old-1', status: 'approved', actionJSON: { action: 'sale_bundle', customer: 'Ayubal Ansari', salesDate: '2026-09-25', items: [{ type: 'package', packageNo: '771' }] } };
  const revert = { requestId: 'rv-1', status: 'approved', actionJSON: { action: 'revert_sale_bundle', saleRefId: 'old-1' } };
  assert.deepEqual(R.classifyFailed({ failed, aj, requestId: 'me', resolved: [earlier] }).map((c) => c.kind), ['duplicate']);
  assert.deepEqual(R.classifyFailed({ failed, aj, requestId: 'me', resolved: [earlier, revert] }).map((c) => c.kind), ['resumed']);
  // A PENDING or rejected revert undoes nothing.
  const pendingRevert = { ...revert, status: 'pending' };
  assert.deepEqual(R.classifyFailed({ failed, aj, requestId: 'me', resolved: [earlier, pendingRevert] }).map((c) => c.kind), ['duplicate']);
  assert.deepEqual([...R.revertedSaleIds([earlier, revert, pendingRevert])], ['old-1']);
});

test('itemsOf: the single doors carry their type and than', () => {
  assert.deepEqual(itemsOf({ action: 'sell_than', packageNo: '5', thanNo: 2, warehouse: 'W' }), [{ type: 'than', packageNo: '5', thanNo: 2, warehouse: 'W' }]);
  assert.deepEqual(itemsOf({ action: 'sell_package', packageNo: '5', warehouse: 'W' }), [{ type: 'package', packageNo: '5', thanNo: undefined, warehouse: 'W' }]);
  assert.deepEqual(itemsOf({ action: 'transfer_stock' }), []);
});
