'use strict';

/**
 * FIX-BALEMATCH2 (11-Nov-2026) — which bales a typed or label-read number
 * stands for (BUSINESS_RULES §1: the printed bale number is the only key).
 *
 * Three doors matched a number against the stock sheet by "the bale's
 * number EQUALS it OR ENDS with it" with no preference for the bale that
 * IS the number: 832 could stand for 1832. The typed transfer line was
 * corrected first (FIX-TRANSFERS, transferFlow.typedHits); the label-photo
 * sale door and the typed Sell Bale preload now share the same rule
 * through this one helper.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { balesForNumber, exactBales } = require('../../../src/utils/baleNumberMatch');

const b = (packageNo, left = 1) => ({ packageNo, left });
const nos = (list) => list.map((x) => x.packageNo);

test('exact beats ending — in either sheet order', () => {
  assert.deepEqual(nos(balesForNumber([b('1832'), b('832')], '832')), ['832']);
  assert.deepEqual(nos(balesForNumber([b('832'), b('1832'), b('20832')], '832')), ['832']);
});

test('an exact bale with nothing left is still the answer — the caller reports it, the longer number is not offered', () => {
  const pool = balesForNumber([b('1832', 5), b('832', 0)], '832');
  assert.deepEqual(nos(pool), ['832']);
  assert.deepEqual(pool.filter((x) => x.left > 0), [], 'nothing available under the number that was read');
});

test('the ending match still works alone, when no bale carries the number exactly', () => {
  assert.deepEqual(nos(balesForNumber([b('997'), b('1832')], '832')), ['1832']);
});

test('two ending candidates and no exact bale: both come back in sheet order, as before', () => {
  assert.deepEqual(nos(balesForNumber([b('2832'), b('1832'), b('997')], '832')), ['2832', '1832']);
});

test('a lettered number counts as exact on its digits (P832 is 832), as before', () => {
  assert.deepEqual(nos(balesForNumber([b('1832'), b('P832')], '832')), ['P832']);
  assert.deepEqual(nos(exactBales([b('1832'), b('P832'), b('832')], '832')), ['P832', '832']);
});

test('the number read may carry letters or spaces — only its digits count', () => {
  assert.deepEqual(nos(balesForNumber([b('1832'), b('832')], 'No. 832')), ['832']);
  assert.deepEqual(nos(balesForNumber([b('1832'), b('832')], 832)), ['832']);
});

test('nothing to match on → nothing matched (never "every bale")', () => {
  assert.deepEqual(balesForNumber([b('832')], ''), []);
  assert.deepEqual(balesForNumber([b('832')], 'abc'), []);
  assert.deepEqual(balesForNumber([b('832')], null), []);
  assert.deepEqual(balesForNumber(null, '832'), []);
  assert.deepEqual(balesForNumber([b('997'), b('999')], '832'), []);
  assert.deepEqual(exactBales([b('1832')], '832'), []);
  assert.deepEqual(exactBales([b('832')], ''), []);
});
