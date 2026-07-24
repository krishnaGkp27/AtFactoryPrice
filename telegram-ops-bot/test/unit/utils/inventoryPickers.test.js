'use strict';

/**
 * Unit suite for src/utils/inventoryPickers.js — shared design-aggregation
 * helpers (baleGroupKey + aggregateDesigns). Pure logic, no I/O.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { baleGroupKey, aggregateDesigns } = require('../../../src/utils/inventoryPickers');

test('baleGroupKey()', async (t) => {
  await t.test('prefers design+packageNo over baleUid', () => {
    assert.equal(
      baleGroupKey({ design: '9006', packageNo: '6534', baleUid: 'BAL-1' }),
      'pkg:9006|6534',
    );
  });

  await t.test('falls back to baleUid when no packageNo', () => {
    assert.equal(baleGroupKey({ design: '9006', baleUid: 'BAL-7' }), 'BAL-7');
  });

  await t.test('last-resort "row" when neither present', () => {
    assert.equal(baleGroupKey({ design: '9006' }), 'row');
  });
});

test('aggregateDesigns()', async (t) => {
  await t.test('groups rows by design with than counts and yard sums', () => {
    const out = aggregateDesigns([
      { design: '9006', packageNo: '6534', baleUid: 'BAL-1', yards: 25 },
      { design: '9006', packageNo: '6534', baleUid: 'BAL-1', yards: 25 },
      { design: '80045', packageNo: '6101', baleUid: 'BAL-2', yards: 30 },
    ]);
    assert.equal(out.length, 2);
    const d9006 = out.find((d) => d.design === '9006');
    assert.deepEqual(d9006, { design: '9006', bales: 1, thans: 2, yards: 50 });
    const d80045 = out.find((d) => d.design === '80045');
    assert.deepEqual(d80045, { design: '80045', bales: 1, thans: 1, yards: 30 });
  });

  await t.test('counts distinct PHYSICAL bales: legacy per-row baleUids collapse via packageNo', () => {
    // Legacy rows: synthetic per-ROW baleUids but the same package number —
    // must count as ONE bale (the CSUP-1b bug this key exists to fix).
    const out = aggregateDesigns([
      { design: '9006', packageNo: '6534', baleUid: 'BAL-LEGACY-1', yards: 25 },
      { design: '9006', packageNo: '6534', baleUid: 'BAL-LEGACY-2', yards: 25 },
      { design: '9006', packageNo: '6600', baleUid: 'BAL-LEGACY-3', yards: 30 },
      { design: '9006', baleUid: 'BAL-9', yards: 10 }, // no packageNo → own bale
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { design: '9006', bales: 3, thans: 4, yards: 90 });
  });

  await t.test('sorts bales desc, then design asc numeric-aware', () => {
    const out = aggregateDesigns([
      { design: '80045', packageNo: 'P1', yards: 10 },
      { design: '9006', packageNo: 'P2', yards: 10 },
      { design: '9006', packageNo: 'P3', yards: 10 },
      { design: '812', packageNo: 'P4', yards: 10 },
    ]);
    // 9006 has 2 bales → first; 812 vs 80045 tie on 1 bale → numeric-aware
    // asc puts 812 before 80045.
    assert.deepEqual(out.map((d) => d.design), ['9006', '812', '80045']);
  });

  await t.test('handles empty/missing input and missing yards', () => {
    assert.deepEqual(aggregateDesigns([]), []);
    assert.deepEqual(aggregateDesigns(null), []);
    const out = aggregateDesigns([{ design: '1', packageNo: 'P', yards: undefined }]);
    assert.deepEqual(out, [{ design: '1', bales: 1, thans: 1, yards: 0 }]);
  });
});
