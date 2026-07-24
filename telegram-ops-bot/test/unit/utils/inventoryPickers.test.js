'use strict';

/**
 * Unit suite for src/utils/inventoryPickers.js — shared design-aggregation
 * helpers (baleGroupKey + aggregateDesigns). Pure logic, no I/O.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { baleGroupKey, aggregateDesigns, aggregateStockModel } = require('../../../src/utils/inventoryPickers');

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

/* ── TV-6 — aggregateStockModel: GRN-anchored opening + in-transit bucket ── */

test('aggregateStockModel()', async (t) => {
  const row = (design, pkg, shade, status, extra = {}) => ({
    design, packageNo: pkg, shade, status, warehouse: 'Kano office', ...extra,
  });
  /** Mixed statuses, NO grnIds (all legacy): 9043B cream 2 avail bales
   *  (5 thans) + 1 sold bale (3 thans); ash 1 avail bale (4 thans).
   *  9006: 1 sold bale (3 thans) + 1 in_transit bale (2 thans) pointed at
   *  Kano office (dispatch stamps the destination on the row). */
  const rows = [
    row('9043B', 'P1', 'cream', 'available'), row('9043B', 'P1', 'cream', 'available'), row('9043B', 'P1', 'cream', 'available'),
    row('9043B', 'P2', 'cream', 'available'), row('9043B', 'P2', 'cream', 'available'),
    row('9043B', 'P4', 'cream', 'sold'), row('9043B', 'P4', 'cream', 'sold'), row('9043B', 'P4', 'cream', 'sold'),
    row('9043B', 'P3', 'ash', 'available'), row('9043B', 'P3', 'ash', 'available'), row('9043B', 'P3', 'ash', 'available'), row('9043B', 'P3', 'ash', 'available'),
    row('9006', 'P9', 'black', 'sold'), row('9006', 'P9', 'black', 'sold'), row('9006', 'P9', 'black', 'sold'),
    row('9006', 'P10', 'gold', 'in_transit'), row('9006', 'P10', 'gold', 'in_transit'),
    row('OTHER', 'P99', 'x', 'available', { warehouse: 'Lagos' }), // other warehouse — excluded
  ];

  await t.test('legacy rows (no grnId): opening at CURRENT warehouse, in_transit excluded, incoming counted', () => {
    const out = aggregateStockModel(rows, { warehouse: 'Kano office' });
    // P10 (in_transit) is NOT in opening — anywhere.
    assert.deepEqual(out.opening.totals, { bales: 5, thans: 15 });
    assert.deepEqual(out.opening.designs.get('9043B'), { bales: 4, thans: 12 });
    assert.deepEqual(out.opening.designs.get('9006'), { bales: 1, thans: 3 });
    assert.equal(out.opening.designs.has('OTHER'), false, 'other warehouse excluded');
    assert.deepEqual(out.opening.shades.get('9043B').get('cream'), { bales: 3, thans: 8 });
    assert.deepEqual(out.opening.shades.get('9043B').get('ash'), { bales: 1, thans: 4 });
    assert.deepEqual(out.opening.shades.get('9006').get('black'), { bales: 1, thans: 3 });
    assert.equal(out.opening.shades.get('9006').has('gold'), false, 'in_transit shade not in opening');
    assert.equal(out.hasOpening, true);
    // …but P10 IS this destination's incoming bucket.
    assert.deepEqual(out.incoming.totals, { bales: 1, thans: 2 });
    assert.deepEqual(out.incoming.designs.get('9006'), { bales: 1, thans: 2 });
    // The dispatching warehouse gets NO incoming from it.
    const lagos = aggregateStockModel(rows, { warehouse: 'Lagos' });
    assert.deepEqual(lagos.incoming.totals, { bales: 0, thans: 0 });
  });

  await t.test('GRN-attributed opening sticks to the INTAKE warehouse (transferred-away bale stays in source opening)', () => {
    const grnMap = new Map([['GRN-1', 'Kano office'], ['GRN-2', 'Lagos']]);
    const moved = [
      // Bale received at Kano office (GRN-1), later transferred to Lagos —
      // now available there. Opening stays at Kano office.
      row('7001', 'T1', 'blue', 'available', { warehouse: 'Lagos', grnId: 'GRN-1' }),
      row('7001', 'T1', 'blue', 'available', { warehouse: 'Lagos', grnId: 'GRN-1' }),
      // Bale received at Lagos (GRN-2), still there.
      row('7002', 'T2', 'red', 'available', { warehouse: 'Lagos', grnId: 'GRN-2' }),
    ];
    const kano = aggregateStockModel(moved, { warehouse: 'Kano office', grnWarehouseById: grnMap });
    assert.deepEqual(kano.opening.designs.get('7001'), { bales: 1, thans: 2 }, 'transferred-away bale still in source opening');
    assert.equal(kano.opening.designs.has('7002'), false);
    assert.equal(kano.hasOpening, true);
    const lagos = aggregateStockModel(moved, { warehouse: 'Lagos', grnWarehouseById: grnMap });
    assert.equal(lagos.opening.designs.has('7001'), false, 'transferred-in bale NOT in destination opening');
    assert.deepEqual(lagos.opening.designs.get('7002'), { bales: 1, thans: 1 }, 'GRN received here counts here');
  });

  await t.test('purely transfer-fed warehouse → hasOpening false (remaining-only browse)', () => {
    const grnMap = new Map([['GRN-1', 'Kano office']]);
    const fed = [
      row('7001', 'T1', 'blue', 'available', { warehouse: 'Abuja', grnId: 'GRN-1' }),
      row('7001', 'T1', 'blue', 'available', { warehouse: 'Abuja', grnId: 'GRN-1' }),
    ];
    const abuja = aggregateStockModel(fed, { warehouse: 'Abuja', grnWarehouseById: grnMap });
    assert.equal(abuja.hasOpening, false);
    assert.deepEqual(abuja.opening.totals, { bales: 0, thans: 0 });
    assert.equal(abuja.opening.designs.size, 0);
  });

  await t.test('unresolvable grnId and null map fall back to the CURRENT warehouse (legacy attribution)', () => {
    const orphan = [row('8001', 'Q1', 'x', 'sold', { grnId: 'GRN-GONE' })];
    const withMap = aggregateStockModel(orphan, { warehouse: 'Kano office', grnWarehouseById: new Map([['GRN-1', 'Lagos']]) });
    assert.deepEqual(withMap.opening.designs.get('8001'), { bales: 1, thans: 1 }, 'unknown grnId → current warehouse');
    const noMap = aggregateStockModel(
      [row('8002', 'Q2', 'x', 'available', { grnId: 'GRN-1' })],
      { warehouse: 'Kano office' },
    );
    assert.deepEqual(noMap.opening.designs.get('8002'), { bales: 1, thans: 1 }, 'no map → current warehouse');
  });

  await t.test('in_transit rows never count toward opening even at their GRN intake warehouse', () => {
    const grnMap = new Map([['GRN-1', 'Kano office']]);
    const transiting = [row('7003', 'T3', 'x', 'in_transit', { warehouse: 'Lagos', grnId: 'GRN-1' })];
    const kano = aggregateStockModel(transiting, { warehouse: 'Kano office', grnWarehouseById: grnMap });
    assert.deepEqual(kano.opening.totals, { bales: 0, thans: 0 }, 'not in intake-warehouse opening while in transit');
    assert.deepEqual(kano.incoming.totals, { bales: 0, thans: 0 }, 'not incoming at a non-destination');
    const lagos = aggregateStockModel(transiting, { warehouse: 'Lagos', grnWarehouseById: grnMap });
    assert.deepEqual(lagos.incoming.designs.get('7003'), { bales: 1, thans: 1 }, 'incoming at the stamped destination');
    assert.deepEqual(lagos.opening.totals, { bales: 0, thans: 0 });
  });

  await t.test('warehouse matching is trimmed/case-insensitive for rows AND GRN attribution', () => {
    const grnMap = new Map([['GRN-1', '  KANO OFFICE ']]);
    const mixedCase = [
      row('7004', 'T4', 'x', 'available', { warehouse: 'Lagos', grnId: 'GRN-1' }),
      row('7005', 'T5', 'x', 'sold', { warehouse: 'kano OFFICE' }),
      row('7006', 'T6', 'x', 'in_transit', { warehouse: 'KANO office' }),
    ];
    const out = aggregateStockModel(mixedCase, { warehouse: 'Kano office', grnWarehouseById: grnMap });
    assert.deepEqual(out.opening.designs.get('7004'), { bales: 1, thans: 1 });
    assert.deepEqual(out.opening.designs.get('7005'), { bales: 1, thans: 1 });
    assert.deepEqual(out.incoming.designs.get('7006'), { bales: 1, thans: 1 });
  });

  await t.test('arrival-batch filter mirrors getAdjustedAvailability (incl. unlabelled sentinel) across buckets', () => {
    const batched = [
      row('9043B', 'P1', 'cream', 'sold', { arrivalBatch: 'Mar26' }),
      row('9043B', 'P2', 'cream', 'available', { arrivalBatch: 'JUN26' }),
      row('9043B', 'P5', 'cream', 'sold'), // no batch label
      row('9043B', 'P6', 'cream', 'in_transit', { arrivalBatch: 'JUN26' }),
    ];
    const mar = aggregateStockModel(batched, { warehouse: 'Kano office', arrivalBatch: 'mar26', unlabelledBatch: '(unlabelled)' });
    assert.deepEqual(mar.opening.totals, { bales: 1, thans: 1 }, 'case-insensitive batch match');
    assert.deepEqual(mar.incoming.totals, { bales: 0, thans: 0 }, 'other-batch transit filtered out');
    const jun = aggregateStockModel(batched, { warehouse: 'Kano office', arrivalBatch: 'JUN26', unlabelledBatch: '(unlabelled)' });
    assert.deepEqual(jun.incoming.totals, { bales: 1, thans: 1 }, 'incoming respects the batch slice');
    const unl = aggregateStockModel(batched, { warehouse: 'Kano office', arrivalBatch: '(unlabelled)', unlabelledBatch: '(unlabelled)' });
    assert.deepEqual(unl.opening.totals, { bales: 1, thans: 1 }, 'unlabelled sentinel matches empty batch');
    const all = aggregateStockModel(batched, { warehouse: 'Kano office', unlabelledBatch: '(unlabelled)' });
    assert.deepEqual(all.opening.totals, { bales: 3, thans: 3 }, 'no batch → all containers (in_transit still excluded)');
  });

  await t.test('designMatch predicate scopes every bucket; DEFAULT shade key; empty input safe', () => {
    const out = aggregateStockModel(rows, { warehouse: 'Kano office', designMatch: (d) => d === '9006' });
    assert.deepEqual(out.opening.totals, { bales: 1, thans: 3 });
    assert.equal(out.opening.designs.has('9043B'), false);
    assert.deepEqual(out.incoming.totals, { bales: 1, thans: 2 }, 'incoming scoped by designMatch too');
    const none = aggregateStockModel(rows, { warehouse: 'Kano office', designMatch: (d) => d === '9043B' });
    assert.deepEqual(none.incoming.totals, { bales: 0, thans: 0 });
    const noShade = aggregateStockModel([row('9', 'P1', '', 'sold')], { warehouse: 'Kano office' });
    assert.deepEqual(noShade.opening.shades.get('9').get('DEFAULT'), { bales: 1, thans: 1 });
    const empty = aggregateStockModel(null, { warehouse: 'Kano office' });
    assert.deepEqual(empty.opening.totals, { bales: 0, thans: 0 });
    assert.deepEqual(empty.incoming.totals, { bales: 0, thans: 0 });
    assert.equal(empty.hasOpening, false);
  });
});
