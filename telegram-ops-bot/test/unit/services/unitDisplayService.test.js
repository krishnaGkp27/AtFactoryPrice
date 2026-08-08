'use strict';

/**
 * TV-1 — unitDisplayService: Settings-driven per-warehouse than-count
 * visibility. settingsRepository is stubbed; no sheets are touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const unitDisplayService = require('../../../src/services/unitDisplayService');
const settingsRepository = require('../../../src/repositories/settingsRepository');

function stubSettings(value) {
  settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: value });
  unitDisplayService.invalidateCache();
}

test('parseWarehouseCsv: trims, lowercases, drops empties', () => {
  const set = unitDisplayService.parseWarehouseCsv(' Kano office , Idumota Store ,, ');
  assert.deepEqual([...set].sort(), ['idumota store', 'kano office']);
});

test('parseWarehouseCsv: non-string input yields an empty set', () => {
  assert.equal(unitDisplayService.parseWarehouseCsv(0).size, 0);
  assert.equal(unitDisplayService.parseWarehouseCsv(null).size, 0);
  assert.equal(unitDisplayService.parseWarehouseCsv(undefined).size, 0);
});

test('SDS-3 formatReceivedRemaining: received B · left t / received t', () => {
  assert.equal(unitDisplayService.formatReceivedRemaining({ receivedBales: 20, remainingThans: 34, receivedThans: 120 }),
    '20B · 34t/120t');
  assert.equal(unitDisplayService.formatReceivedRemaining({ receivedBales: 1, remainingThans: 2, receivedThans: 2 }),
    '1B · 2t/2t');
  assert.equal(unitDisplayService.formatReceivedRemaining({}), '0B · 0t/0t');
  assert.equal(unitDisplayService.formatReceivedRemaining({ receivedBales: 'x', remainingThans: null, receivedThans: NaN }),
    '0B · 0t/0t');
});

test('isThanVisibilityWarehouse: case-insensitive match on configured names', async () => {
  stubSettings('Kano office');
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse('Kano office'), true);
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse('KANO OFFICE'), true);
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse(' kano office '), true);
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse('Lagos'), false);
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse(''), false);
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse(null), false);
});

test('CSV of several warehouses matches each', async () => {
  stubSettings('Kano office, Idumota Store');
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse('Idumota store'), true);
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse('Kano Office'), true);
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse('Chinos Store'), false);
});

test('empty value disables the feature everywhere', async () => {
  stubSettings('');
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse('Kano office'), false);
});

test('settings errors degrade to feature-off, never throw', async () => {
  settingsRepository.getAll = async () => { throw new Error('sheet down'); };
  unitDisplayService.invalidateCache();
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse('Kano office'), false);
});

test('cache: fresh value visible after invalidateCache', async () => {
  stubSettings('Kano office');
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse('Kano office'), true);
  // Change settings behind the cache — stale until invalidated.
  settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: '' });
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse('Kano office'), true, 'cached value still in effect');
  unitDisplayService.invalidateCache();
  assert.equal(await unitDisplayService.isThanVisibilityWarehouse('Kano office'), false, 'invalidate picks up the new value');
});

test('DEFAULTS ship with Kano office enabled', () => {
  assert.equal(settingsRepository.DEFAULTS.THAN_VISIBILITY_WAREHOUSES, 'Kano office');
});

/* ── TV-7 — than-visible warehouses show THANS ONLY (no "B = t" pair) ── */

/* ── TV-4 + TV-7 — formatRemainingOpening: "rem / opening" pair display ── */

test('formatRemainingOpening: TV-7 thans only, "<remT>t / <openT>t"', () => {
  assert.equal(
    unitDisplayService.formatRemainingOpening({ bales: 20, thans: 88 }, { bales: 30, thans: 132 }),
    '88t / 132t',
    'bale counts are NOT shown on a than-visible warehouse',
  );
  assert.equal(
    unitDisplayService.formatRemainingOpening({ bales: 0, thans: 0 }, { bales: 5, thans: 17 }),
    '0t / 17t',
    'sold-out design display',
  );
  assert.equal(
    unitDisplayService.formatRemainingOpening(undefined, {}),
    '0t / 0t',
    'defensive on missing counts',
  );
  assert.ok(
    !unitDisplayService.formatRemainingOpening({ bales: 20, thans: 88 }, { bales: 30, thans: 132 }).includes('='),
    'the "=" that read as a bale→than conversion is gone (owner, 25-Jul-2026)',
  );
});

/* ── TV-5 — formatRemainingOpeningBales: bales-only "remB / openB" pair ── */

test('formatRemainingOpeningBales: bales-only pair "<remB>B / <openB>B"', () => {
  assert.equal(
    unitDisplayService.formatRemainingOpeningBales({ bales: 20 }, { bales: 30 }),
    '20B / 30B',
  );
  assert.equal(
    unitDisplayService.formatRemainingOpeningBales({ bales: 0, thans: 0 }, { bales: 6, thans: 17 }),
    '0B / 6B',
    'sold-out design display — than counts ignored',
  );
  assert.equal(
    unitDisplayService.formatRemainingOpeningBales({ bales: '2' }, { bales: '4' }),
    '2B / 4B',
    'numeric strings coerce',
  );
  assert.equal(
    unitDisplayService.formatRemainingOpeningBales(undefined, {}),
    '0B / 0B',
    'defensive on missing counts',
  );
  assert.equal(
    unitDisplayService.formatRemainingOpeningBales({ bales: 'x' }, { bales: null }),
    '0B / 0B',
    'garbage coerces to 0',
  );
});

test('formatBalesThans: TV-7 owner-locked format is thans only, "<M>t"', () => {
  assert.equal(unitDisplayService.formatBalesThans({ bales: 22, thans: 88 }), '88t');
  assert.equal(unitDisplayService.formatBalesThans({ bales: 1, thans: 1 }), '1t');
  assert.equal(unitDisplayService.formatBalesThans({ bales: 64, thans: 255 }), '255t');
});

test('formatBalesThans: missing/garbage counts coerce to 0', () => {
  assert.equal(unitDisplayService.formatBalesThans({}), '0t');
  assert.equal(unitDisplayService.formatBalesThans(), '0t');
  assert.equal(unitDisplayService.formatBalesThans({ bales: 'x', thans: null }), '0t');
  assert.equal(unitDisplayService.formatBalesThans({ bales: '2', thans: '4' }), '4t');
});

test('formatBalesThans: than-mode path from rows — 4 thans across 2 bales → "4t"', () => {
  const { aggregateDesigns } = require('../../../src/utils/inventoryPickers');
  // Kano office rows: one row per than; thans of the same bale share packageNo.
  const rows = [
    { design: '9043B', packageNo: 'P1', warehouse: 'Kano office', yards: 25 },
    { design: '9043B', packageNo: 'P1', warehouse: 'Kano office', yards: 25 },
    { design: '9043B', packageNo: 'P1', warehouse: 'Kano office', yards: 25 },
    { design: '9043B', packageNo: 'P2', warehouse: 'Kano office', yards: 25 },
  ];
  const [agg] = aggregateDesigns(rows);
  // The physical bale count is still computed (it drives selection and the
  // bales-only warehouses) — TV-7 only stops DISPLAYING it on Kano screens.
  assert.equal(agg.bales, 2);
  assert.equal(agg.thans, 4);
  assert.equal(unitDisplayService.formatBalesThans(agg), '4t');
});
