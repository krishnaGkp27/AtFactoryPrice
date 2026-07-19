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
