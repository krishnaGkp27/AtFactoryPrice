'use strict';

/**
 * Unit suite for src/utils/inventoryPickers.js — shared design-aggregation
 * helpers (baleGroupKey + aggregateDesigns). Pure logic, no I/O.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { baleGroupKey, aggregateDesigns, aggregateOpeningStock } = require('../../../src/utils/inventoryPickers');

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

/* ── TV-4 — aggregateOpeningStock: opening = all rows, ANY status ── */

test('aggregateOpeningStock()', async (t) => {
  const row = (design, pkg, shade, status, extra = {}) => ({
    design, packageNo: pkg, shade, status, warehouse: 'Kano office', ...extra,
  });
  /** Mixed statuses: 9043B cream 2 avail bales (5 thans) + 1 sold bale
   *  (3 thans); ash 1 avail bale (4 thans). 9006 fully out (sold+in_transit). */
  const rows = [
    row('9043B', 'P1', 'cream', 'available'), row('9043B', 'P1', 'cream', 'available'), row('9043B', 'P1', 'cream', 'available'),
    row('9043B', 'P2', 'cream', 'available'), row('9043B', 'P2', 'cream', 'available'),
    row('9043B', 'P4', 'cream', 'sold'), row('9043B', 'P4', 'cream', 'sold'), row('9043B', 'P4', 'cream', 'sold'),
    row('9043B', 'P3', 'ash', 'available'), row('9043B', 'P3', 'ash', 'available'), row('9043B', 'P3', 'ash', 'available'), row('9043B', 'P3', 'ash', 'available'),
    row('9006', 'P9', 'black', 'sold'), row('9006', 'P9', 'black', 'sold'), row('9006', 'P9', 'black', 'sold'),
    row('9006', 'P10', 'gold', 'in_transit'), row('9006', 'P10', 'gold', 'in_transit'),
    row('OTHER', 'P99', 'x', 'available', { warehouse: 'Lagos' }), // other warehouse — excluded
  ];

  await t.test('mixed statuses → correct opening splits per design and shade', () => {
    const out = aggregateOpeningStock(rows, { warehouse: 'Kano office' });
    assert.deepEqual(out.totals, { bales: 6, thans: 17 });
    assert.deepEqual(out.designs.get('9043B'), { bales: 4, thans: 12 });
    assert.deepEqual(out.designs.get('9006'), { bales: 2, thans: 5 });
    assert.equal(out.designs.has('OTHER'), false, 'other warehouse excluded');
    assert.deepEqual(out.shades.get('9043B').get('cream'), { bales: 3, thans: 8 });
    assert.deepEqual(out.shades.get('9043B').get('ash'), { bales: 1, thans: 4 });
    assert.deepEqual(out.shades.get('9006').get('black'), { bales: 1, thans: 3 });
    assert.deepEqual(out.shades.get('9006').get('gold'), { bales: 1, thans: 2 });
  });

  await t.test('arrival-batch filter mirrors getAdjustedAvailability (incl. unlabelled sentinel)', () => {
    const batched = [
      row('9043B', 'P1', 'cream', 'sold', { arrivalBatch: 'Mar26' }),
      row('9043B', 'P2', 'cream', 'available', { arrivalBatch: 'JUN26' }),
      row('9043B', 'P5', 'cream', 'sold'), // no batch label
    ];
    const mar = aggregateOpeningStock(batched, { warehouse: 'Kano office', arrivalBatch: 'mar26', unlabelledBatch: '(unlabelled)' });
    assert.deepEqual(mar.totals, { bales: 1, thans: 1 }, 'case-insensitive batch match');
    const unl = aggregateOpeningStock(batched, { warehouse: 'Kano office', arrivalBatch: '(unlabelled)', unlabelledBatch: '(unlabelled)' });
    assert.deepEqual(unl.totals, { bales: 1, thans: 1 }, 'unlabelled sentinel matches empty batch');
    const all = aggregateOpeningStock(batched, { warehouse: 'Kano office', unlabelledBatch: '(unlabelled)' });
    assert.deepEqual(all.totals, { bales: 3, thans: 3 }, 'no batch → all containers');
  });

  await t.test('designMatch predicate scopes the slice; DEFAULT shade key; empty input safe', () => {
    const out = aggregateOpeningStock(rows, { warehouse: 'Kano office', designMatch: (d) => d === '9006' });
    assert.deepEqual(out.totals, { bales: 2, thans: 5 });
    assert.equal(out.designs.has('9043B'), false);
    const noShade = aggregateOpeningStock([row('9', 'P1', '', 'sold')], { warehouse: 'Kano office' });
    assert.deepEqual(noShade.shades.get('9').get('DEFAULT'), { bales: 1, thans: 1 });
    assert.deepEqual(aggregateOpeningStock(null, { warehouse: 'Kano office' }).totals, { bales: 0, thans: 0 });
  });
});
