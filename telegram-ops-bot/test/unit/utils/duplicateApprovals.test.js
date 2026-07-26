'use strict';

/**
 * APX-2 — duplicate approval detection.
 *
 * The dangerous failure here is a FALSE POSITIVE: flagging two genuinely
 * different sales as duplicates invites the admin to reject a real order.
 * Most of these tests exist to prove the detector stays quiet when it should.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findDuplicateGroups, duplicateIndex, fingerprintOf, _internals,
} = require('../../../src/utils/duplicateApprovals');

const T0 = Date.parse('2026-07-26T10:00:00.000Z');
const at = (secs) => new Date(T0 + secs * 1000).toISOString();

function row(requestId, user, action, payload, secs) {
  return { requestId, user, status: 'pending', createdAt: at(secs), actionJSON: { action, ...payload } };
}

/* ── true positives ───────────────────────────────────────────────────── */

test('four identical submissions seconds apart are one duplicate group', () => {
  const rows = [
    row('A', '111', 'sell_package', { packageNo: '5801', customer: 'CJE' }, 0),
    row('B', '111', 'sell_package', { packageNo: '5801', customer: 'CJE' }, 3),
    row('C', '111', 'sell_package', { packageNo: '5801', customer: 'CJE' }, 6),
    row('D', '111', 'sell_package', { packageNo: '5801', customer: 'CJE' }, 9),
  ];
  const groups = findDuplicateGroups(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 4);
  assert.deepEqual(groups[0].map((r) => r.requestId), ['A', 'B', 'C', 'D']);
});

test('key order and whitespace do not hide a duplicate', () => {
  const rows = [
    row('A', '111', 'sale_bundle', { customer: 'CJE', rate: 1200 }, 0),
    row('B', '111', 'sale_bundle', { rate: 1200, customer: ' CJE ' }, 5),
  ];
  assert.equal(findDuplicateGroups(rows).length, 1);
});

test('a re-sent bill with a fresh Telegram file id is still a duplicate', () => {
  const rows = [
    row('A', '111', 'sell_package', { packageNo: '5801', sale_doc_file_id: 'AgAC-aaa' }, 0),
    row('B', '111', 'sell_package', { packageNo: '5801', sale_doc_file_id: 'AgAC-zzz' }, 20),
  ];
  assert.equal(findDuplicateGroups(rows).length, 1, 'attachment ids are volatile, not identity');
});

test('nested payloads compare structurally', () => {
  const rows = [
    row('A', '111', 'sale_bundle', { items: [{ design: '9006', thans: 3 }, { design: '9032', thans: 2 }] }, 0),
    row('B', '111', 'sale_bundle', { items: [{ thans: 3, design: '9006' }, { thans: 2, design: '9032' }] }, 4),
  ];
  assert.equal(findDuplicateGroups(rows).length, 1);
});

/* ── false positives the detector MUST avoid ──────────────────────────── */

test('two different customers in the same minute are NOT duplicates', () => {
  const rows = [
    row('A', '111', 'sell_package', { packageNo: '5801', customer: 'CJE' }, 0),
    row('B', '111', 'sell_package', { packageNo: '5802', customer: 'Ketu madam' }, 30),
  ];
  assert.equal(findDuplicateGroups(rows).length, 0, 'different payload — a real second sale');
});

test('the same request from two DIFFERENT people is not a duplicate', () => {
  const rows = [
    row('A', '111', 'add_contact', { name: 'ACME' }, 0),
    row('B', '222', 'add_contact', { name: 'ACME' }, 10),
  ];
  assert.equal(findDuplicateGroups(rows).length, 0);
});

test('an identical repeat order outside the window is NOT a duplicate', () => {
  const rows = [
    row('A', '111', 'sell_package', { packageNo: '5801', customer: 'CJE' }, 0),
    row('B', '111', 'sell_package', { packageNo: '5801', customer: 'CJE' }, 7 * 86400), // a week later
  ];
  assert.equal(findDuplicateGroups(rows).length, 0, 'a legitimate repeat order');
});

test('the window clusters correctly across a long gap', () => {
  const rows = [
    row('A', '111', 'sell_package', { packageNo: '5801' }, 0),
    row('B', '111', 'sell_package', { packageNo: '5801' }, 30),      // dup of A
    row('C', '111', 'sell_package', { packageNo: '5801' }, 3 * 86400), // separate day
    row('D', '111', 'sell_package', { packageNo: '5801' }, 3 * 86400 + 20), // dup of C
  ];
  const groups = findDuplicateGroups(rows);
  assert.equal(groups.length, 2, 'two clusters, not one run of four');
  assert.deepEqual(groups.map((g) => g.map((r) => r.requestId)), [['A', 'B'], ['C', 'D']]);
});

test('different actions never merge', () => {
  const rows = [
    row('A', '111', 'sell_package', { packageNo: '5801' }, 0),
    row('B', '111', 'return_package', { packageNo: '5801' }, 5),
  ];
  assert.equal(findDuplicateGroups(rows).length, 0);
});

/* ── robustness ───────────────────────────────────────────────────────── */

test('rows with an unparseable date are never clustered', () => {
  const rows = [
    { requestId: 'A', user: '111', createdAt: '', actionJSON: { action: 'x', a: 1 } },
    { requestId: 'B', user: '111', createdAt: 'not-a-date', actionJSON: { action: 'x', a: 1 } },
  ];
  assert.equal(findDuplicateGroups(rows).length, 0, 'without a time we cannot tell a double-tap from a repeat');
});

test('malformed input never throws', () => {
  assert.deepEqual(findDuplicateGroups(null), []);
  assert.deepEqual(findDuplicateGroups(undefined), []);
  assert.deepEqual(findDuplicateGroups([]), []);
  assert.deepEqual(findDuplicateGroups([null, undefined]), []);
  assert.deepEqual(findDuplicateGroups([{ requestId: 'A' }]), []);
  assert.doesNotThrow(() => fingerprintOf(null));
  assert.doesNotThrow(() => fingerprintOf({}));
});

test('a custom window is honoured and a bad window falls back to the default', () => {
  const rows = [
    row('A', '111', 'x', { p: 1 }, 0),
    row('B', '111', 'x', { p: 1 }, 20 * 60), // 20 minutes later
  ];
  assert.equal(findDuplicateGroups(rows, 10).length, 0, 'outside a 10-minute window');
  assert.equal(findDuplicateGroups(rows, 30).length, 1, 'inside a 30-minute window');
  assert.equal(findDuplicateGroups(rows, 0).length, 0, 'zero clamps to a sane window, not everything');
  assert.equal(findDuplicateGroups(rows, NaN).length, 0, 'NaN falls back to the 10-minute default');
});

test('duplicateIndex maps every member of a group to its group', () => {
  const rows = [
    row('A', '111', 'x', { p: 1 }, 0),
    row('B', '111', 'x', { p: 1 }, 5),
    row('C', '111', 'y', { p: 9 }, 0),
  ];
  const idx = duplicateIndex(rows);
  assert.equal(idx.get('A').length, 2);
  assert.equal(idx.get('B'), idx.get('A'), 'both members share one group object');
  assert.equal(idx.has('C'), false, 'a lone row is absent');
});

test('canonical output is stable and drops volatile keys', () => {
  const { canonical } = _internals;
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  assert.equal(canonical({ a: 1, requestId: 'X' }), canonical({ a: 1, requestId: 'Y' }));
  assert.equal(canonical({ a: 1, approvals: ['777'] }), canonical({ a: 1 }));
});
