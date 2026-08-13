'use strict';

/** WAU-3 — blind-count parsers (pure, smoke-friendly). */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { parseCount, parseAuditBatch } = require(path.join(__dirname, '../../../src/utils/auditCountParser'));

test('parseCount: bales, bales+bundles, zeros, junk', () => {
  assert.deepEqual(parseCount('12'), { ok: true, bales: 12, bundles: 0 });
  assert.deepEqual(parseCount('12+5'), { ok: true, bales: 12, bundles: 5 });
  assert.deepEqual(parseCount(' 0 + 3 '), { ok: true, bales: 0, bundles: 3 });
  assert.deepEqual(parseCount('0'), { ok: true, bales: 0, bundles: 0 });
  for (const bad of ['', 'abc', '12+', '+5', '12+5+1', '12.5', '-3']) {
    assert.equal(parseCount(bad).ok, false, `rejects ${JSON.stringify(bad)}`);
  }
});

test('parseAuditBatch: header matching, filled/blank/broken lines', () => {
  const out = parseAuditBatch(
    'AUDIT kano office\n9032 = 12+5\n77016 8\n44200 =\nBAD = xyz',
    ['IDUMOTA', 'Kano office'],
  );
  assert.equal(out.ok, true);
  assert.equal(out.warehouse, 'Kano office', 'case-insensitive canonical match');
  assert.deepEqual(out.entries, [
    { design: '9032', bales: 12, bundles: 5 },
    { design: '77016', bales: 8, bundles: 0 },
  ]);
  assert.deepEqual(out.skipped, ['44200']);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /BAD/);

  assert.equal(parseAuditBatch('AUDIT Nowhere\n9032 = 1', ['IDUMOTA']).ok, false, 'unknown warehouse rejected');
  assert.equal(parseAuditBatch('hello', ['IDUMOTA']).ok, false, 'missing header rejected');
});

/* ── WAU-4: the opened-bale equivalence (pure math) ── */

const { openedBaleEquivalence } = require('../../../src/utils/auditCountParser');

test('openedBaleEquivalence: exact bale⇄pieces swaps only, variable sizes', () => {
  // The owner's 6-and-4 reality.
  assert.equal(openedBaleEquivalence([6, 4], 1, 6), true, 'the 6-bale as pieces');
  assert.equal(openedBaleEquivalence([6, 4], 1, 4), true, 'the 4-bale as pieces');
  assert.equal(openedBaleEquivalence([6, 4], 2, 10), true, 'both');
  assert.equal(openedBaleEquivalence([6, 4], 1, 5), false, 'a missing piece is never forgiven');
  assert.equal(openedBaleEquivalence([6, 4], 2, 9), false);
  assert.equal(openedBaleEquivalence([6, 6, 4], 2, 10), true, 'subset choice: 6+4');
  assert.equal(openedBaleEquivalence([6, 6, 4], 2, 12), true, 'subset choice: 6+6');
  assert.equal(openedBaleEquivalence([6, 6, 4], 2, 11), false, 'no subset sums to 11');
});

test('openedBaleEquivalence: degenerate inputs are refused, never guessed', () => {
  assert.equal(openedBaleEquivalence([], 1, 6), false, 'no closed bales to swap');
  assert.equal(openedBaleEquivalence([6], 2, 6), false, 'more bales than exist');
  assert.equal(openedBaleEquivalence([6], 0, 6), false, 'zero shortfall is not a swap');
  assert.equal(openedBaleEquivalence([6], 1, 0), false, 'zero surplus is not a swap');
  assert.equal(openedBaleEquivalence([6], -1, -6), false);
  assert.equal(openedBaleEquivalence(['x', null, 6], 1, 6), true, 'junk sizes are dropped, real ones kept');
});
