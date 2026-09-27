'use strict';

/**
 * QTA-1 — scripts/check-sale-request.js: the ref the card prints must find
 * the row, and the verdict must be judged per ITEM, distinguish a duplicate
 * request from a half-done one, and never call a whole bale sale "mixed".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { matchesRef, judge } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'check-sale-request.js'));
const { shortRequestRef } = require(path.join(__dirname, '..', '..', '..', 'src', 'services', 'approvalCards.js'));

const ID = '9bf6c2d4-1111-4222-8333-abcdefabcdef';

test('matchesRef: the card\'s short ref (FIRST four characters), the full id, and the id without dashes all match', () => {
  assert.equal(shortRequestRef(ID), 'R-9BF6', 'the card mints the first four');
  assert.equal(matchesRef(ID, 'R-9BF6'), true);
  assert.equal(matchesRef(ID, 'r-9bf6'), true);
  assert.equal(matchesRef(ID, '9BF6'), true);
  assert.equal(matchesRef(ID, ID), true);
  assert.equal(matchesRef(ID, ID.replace(/-/g, '')), true);
  assert.equal(matchesRef(ID, 'R-CDEF'), false, 'the LAST four are not the ref');
  assert.equal(matchesRef(ID, ''), false);
});

function row(pkg, thanNo, status, opts = {}) {
  return { packageNo: pkg, thanNo, design: 'D', yards: 30, warehouse: opts.wh || 'IDUMOTA', status, soldTo: opts.soldTo || '', soldDate: opts.soldDate || '' };
}
const Q = (items, status = 'pending') => ({ requestId: ID, status, actionJSON: { action: 'sale_bundle', customer: 'ABBA', salesDate: '2026-08-19', items } });
const TXN = (ref, extra = {}) => ({ action: 'sale_bundle', saleRefId: ref, customerName: 'ABBA', salesDate: '2026-08-19', qty: 60, ...extra });
const LEDGER = (ref) => ({ txn_id: `${ref}-D` });

test('WHOLE: a bale item counts as flipped only when every than of it is; money rows carry the request', () => {
  const j = judge({
    queue: Q([{ type: 'package', packageNo: 'A1' }, { type: 'than', packageNo: 'B2', thanNo: 1 }], 'approved'),
    inventory: [row('A1', 1, 'sold', { soldTo: 'ABBA', soldDate: '2026-08-19' }), row('A1', 2, 'sold', { soldTo: 'ABBA', soldDate: '2026-08-19' }), row('B2', 1, 'sold', { soldTo: 'ABBA', soldDate: '2026-08-19' })],
    txns: [TXN(ID)], ledger: [LEDGER(ID)],
  });
  assert.equal(j.verdict, 'WHOLE');
  assert.equal(j.flippedItems, 2);
});

test('HALF-DONE: goods flipped to this customer on this date with no Transactions row for the request', () => {
  const j = judge({
    queue: Q([{ type: 'package', packageNo: 'A1' }, { type: 'package', packageNo: 'B2' }]),
    inventory: [row('A1', 1, 'sold', { soldTo: 'ABBA', soldDate: '2026-08-19' }), row('B2', 1, 'available')],
    txns: [], ledger: [],
  });
  assert.equal(j.verdict, 'HALF-DONE');
  assert.match(j.reading, /no Transactions row carries this request/);
  assert.equal(j.flippedItems, 1);
  assert.equal(j.untouchedItems, 1);
  // QTA-2 — a bundle is finished by ONE Approve; a single door is not.
  assert.match(j.reading, /Tap Approve ONCE on this request/);
  assert.ok(!/Do not re-approve/.test(j.reading));
  const single = judge({
    queue: { requestId: ID, status: 'pending', actionJSON: { action: 'sell_than', customer: 'ABBA', salesDate: '2026-08-19', packageNo: 'A1', thanNo: 1 } },
    inventory: [row('A1', 1, 'sold', { soldTo: 'ABBA', soldDate: '2026-08-19' })],
    txns: [], ledger: [],
  });
  assert.equal(single.verdict, 'HALF-DONE');
  assert.match(single.reading, /Do not re-approve; post the missing side/);
});

test('a part-flipped bale is HALF-DONE too, never WHOLE', () => {
  const j = judge({
    queue: Q([{ type: 'package', packageNo: 'A1' }], 'approved'),
    inventory: [row('A1', 1, 'sold', { soldTo: 'ABBA', soldDate: '2026-08-19' }), row('A1', 2, 'available')],
    txns: [TXN(ID)], ledger: [],
  });
  assert.equal(j.verdict, 'HALF-DONE');
  assert.equal(j.mixedItems, 1);
  assert.match(j.reading, /no ledger entry carries this request/);
});

test('DUPLICATE?: every item sold to the customer that day, but the money rows carry another request id', () => {
  const j = judge({
    queue: Q([{ type: 'package', packageNo: 'A1' }]),
    inventory: [row('A1', 1, 'sold', { soldTo: 'ABBA', soldDate: '2026-08-19' })],
    txns: [TXN('other-req-1')], ledger: [LEDGER('other-req-1')],
  });
  assert.equal(j.verdict, 'DUPLICATE?');
  assert.match(j.reading, /other-req-1/);
  assert.match(j.reading, /do NOT post/);
});

test('UNTOUCHED: nothing flipped — safe to approve again; an approved row that flipped nothing was Marked as done', () => {
  const a = judge({ queue: Q([{ type: 'than', packageNo: 'A1', thanNo: 1 }]), inventory: [row('A1', 1, 'available')], txns: [], ledger: [] });
  assert.equal(a.verdict, 'UNTOUCHED');
  assert.match(a.reading, /approved again/);
  const b = judge({ queue: Q([{ type: 'than', packageNo: 'A1', thanNo: 1 }], 'approved'), inventory: [row('A1', 1, 'available')], txns: [], ledger: [] });
  assert.equal(b.verdict, 'UNTOUCHED');
  assert.match(b.reading, /Marked as done/);
});

test('MIXED: goods sold to someone else, or on another day, are named as such', () => {
  const j = judge({
    queue: Q([{ type: 'than', packageNo: 'A1', thanNo: 1 }, { type: 'than', packageNo: 'B2', thanNo: 1 }]),
    inventory: [row('A1', 1, 'sold', { soldTo: 'MUSA', soldDate: '2026-08-19' }), row('B2', 1, 'available')],
    txns: [], ledger: [],
  });
  assert.equal(j.verdict, 'MIXED');
  assert.equal(j.elsewhereItems, 1);
  assert.equal(j.untouchedItems, 1);
});
