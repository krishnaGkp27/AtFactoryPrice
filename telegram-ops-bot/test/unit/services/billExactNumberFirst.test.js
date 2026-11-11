'use strict';

/**
 * Bill check — the bill line that carries EXACTLY the bale's number is the
 * one it is paired with (BUSINESS_RULES §1: the printed bale number is the
 * key). The suffix-tolerant match stays only as the fallback, and never
 * takes a line that is exactly another bale of the same request.
 *
 * Before: the first unused line whose number equalled the bale OR ended
 * with it (or the reverse) was taken, so with bales 832 and 1832 on one
 * request a bill listing 1832 first ticked bale 832 with line 1832.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../../../src/services/saleDocVerifyService');
const { compareItemsToLabels } = svc._internals;

const item = (no, thans = 5) => ({ packageNo: String(no), design: '9006', shade: '3', thans, type: 'package' });
const line = (no) => ({ packageNo: String(no), design: '9006', shade: '3', thanNo: 0 });
const pairOf = (results, no) => results.find((r) => r.item.packageNo === String(no));

test('two bales whose numbers end alike are each paired with their own line, whatever the order on the paper', () => {
  for (const bill of [[line(1832), line(832)], [line(832), line(1832)]]) {
    const { results, extras } = compareItemsToLabels([item(832), item(1832)], bill);
    assert.equal(pairOf(results, 832).status, 'ok');
    assert.equal(pairOf(results, 832).label.packageNo, '832');
    assert.equal(pairOf(results, 1832).status, 'ok');
    assert.equal(pairOf(results, 1832).label.packageNo, '1832');
    assert.deepEqual(extras, []);
  }
});

test('a line that is exactly ANOTHER bale of the request is never lent to a bale missing from the paper', () => {
  // The bill carries 1832 only. Bale 832 is not on it: it must read missing,
  // and line 1832 must still be there for bale 1832.
  const { results, extras } = compareItemsToLabels([item(832), item(1832)], [line(1832)]);
  assert.equal(pairOf(results, 832).status, 'missing');
  assert.equal(pairOf(results, 1832).status, 'ok');
  assert.equal(pairOf(results, 1832).label.packageNo, '1832');
  assert.deepEqual(extras, []);
});

test('the exact line wins over an earlier longer one', () => {
  const { results, extras } = compareItemsToLabels([item(896)], [line(26896), line(896)]);
  assert.equal(results[0].status, 'ok');
  assert.equal(results[0].label.packageNo, '896');
  assert.equal(extras.length, 1);
  assert.equal(extras[0].packageNo, '26896');
});

test('the tolerant match still works when no line carries the number exactly (a prefix printed on the paper)', () => {
  const { results, extras } = compareItemsToLabels([item(896)], [line('P896'), line('26-897')]);
  assert.equal(results[0].status, 'ok');
  assert.equal(results[0].label.packageNo, 'P896');
  assert.equal(extras.length, 1);
  const longer = compareItemsToLabels([item(896)], [line('26-896')]);
  assert.equal(longer.results[0].status, 'ok');
  assert.equal(longer.results[0].label.packageNo, '26-896');
});
