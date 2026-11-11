'use strict';

/**
 * FIX-TRANSFERS (11-Nov-2026) — which bales one typed number stands for on
 * the typed transfer line (`Transfer 832, 1186 to kano`).
 *
 * The lookup took every available bale whose number EQUALS the typed digits
 * or ENDS with them, and the preload then loaded the first one on the
 * source shelf: typing 832 could load 1832. The bale that IS the number now
 * wins outright; the ending match is only the fallback for a number no bale
 * carries exactly.
 */

process.env.ADMIN_IDS = '777';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const { typedHits } = require(path.join(SRC, 'flows/transferFlow'))._internals;

const b = (packageNo, warehouse = 'Lagos', avail = 1, soldTo = '') => ({ packageNo, warehouse, design: '9006', shade: '3', avail, soldTo });
const nos = (hits) => hits.map((h) => `${h.packageNo}@${h.warehouse}`);

test('exact beats ending — in either sheet order', () => {
  assert.deepEqual(nos(typedHits([b('1832'), b('832')], '832')), ['832@Lagos']);
  assert.deepEqual(nos(typedHits([b('832'), b('1832'), b('20832')], '832')), ['832@Lagos']);
});

test('an exact bale in another store is the only hit — the longer number on this shelf is not offered', () => {
  assert.deepEqual(nos(typedHits([b('1832', 'Lagos'), b('832', 'IDUMOTA')], '832')), ['832@IDUMOTA']);
});

test('the same exact number in two stores: both are hits, as before (the source store decides)', () => {
  assert.deepEqual(nos(typedHits([b('832', 'Lagos'), b('1832', 'Lagos'), b('832', 'Kano office')], '832')),
    ['832@Lagos', '832@Kano office']);
});

test('an exact bale with nothing available blocks the ending match — no hit at all', () => {
  assert.deepEqual(typedHits([b('1832'), b('832', 'Lagos', 0, 'CJE')], '832'), []);
  assert.deepEqual(typedHits([b('1832'), b('832', 'Lagos', 0)], '832'), []);
});

test('a lettered number counts as exact on its digits, as before (P832 is 832)', () => {
  assert.deepEqual(nos(typedHits([b('1832'), b('P832')], '832')), ['P832@Lagos']);
});

test('ending match still works alone, and only on available bales', () => {
  assert.deepEqual(nos(typedHits([b('997'), b('1832')], '832')), ['1832@Lagos']);
  assert.deepEqual(typedHits([b('1832', 'Lagos', 0, 'CJE')], '832'), []);
});

test('two ending candidates and no exact bale: both are hits in sheet order, as before', () => {
  assert.deepEqual(nos(typedHits([b('2832'), b('1832'), b('997')], '832')), ['2832@Lagos', '1832@Lagos']);
});

test('nothing matches → no hit', () => {
  assert.deepEqual(typedHits([b('997'), b('999')], '832'), []);
  assert.deepEqual(typedHits([], '832'), []);
});
