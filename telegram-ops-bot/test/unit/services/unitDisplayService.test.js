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

/* ── TV-3 — formatBalesThans: canonical combined "NB = Mt" display ── */

/* ── TV-4 — formatRemainingOpening: "rem / opening" pair display ── */

test('formatRemainingOpening: "<remB>B = <remT>t / <openB>B = <openT>t"', () => {
  assert.equal(
    unitDisplayService.formatRemainingOpening({ bales: 20, thans: 88 }, { bales: 30, thans: 132 }),
    '20B = 88t / 30B = 132t',
  );
  assert.equal(
    unitDisplayService.formatRemainingOpening({ bales: 0, thans: 0 }, { bales: 5, thans: 17 }),
    '0B = 0t / 5B = 17t',
    'sold-out design display',
  );
  assert.equal(
    unitDisplayService.formatRemainingOpening(undefined, {}),
    '0B = 0t / 0B = 0t',
    'defensive on missing counts',
  );
});

test('formatBalesThans: owner-locked format "<N>B = <M>t"', () => {
  assert.equal(unitDisplayService.formatBalesThans({ bales: 22, thans: 88 }), '22B = 88t');
  assert.equal(unitDisplayService.formatBalesThans({ bales: 1, thans: 1 }), '1B = 1t');
  assert.equal(unitDisplayService.formatBalesThans({ bales: 64, thans: 255 }), '64B = 255t');
});

test('formatBalesThans: missing/garbage counts coerce to 0', () => {
  assert.equal(unitDisplayService.formatBalesThans({}), '0B = 0t');
  assert.equal(unitDisplayService.formatBalesThans(), '0B = 0t');
  assert.equal(unitDisplayService.formatBalesThans({ bales: 'x', thans: null }), '0B = 0t');
  assert.equal(unitDisplayService.formatBalesThans({ bales: '2', thans: '4' }), '2B = 4t');
});

test('formatBalesThans: than-mode path from rows — 4 thans across 2 bales → "2B = 4t"', () => {
  const { aggregateDesigns } = require('../../../src/utils/inventoryPickers');
  // Kano office rows: one row per than; thans of the same bale share packageNo.
  const rows = [
    { design: '9043B', packageNo: 'P1', warehouse: 'Kano office', yards: 25 },
    { design: '9043B', packageNo: 'P1', warehouse: 'Kano office', yards: 25 },
    { design: '9043B', packageNo: 'P1', warehouse: 'Kano office', yards: 25 },
    { design: '9043B', packageNo: 'P2', warehouse: 'Kano office', yards: 25 },
  ];
  const [agg] = aggregateDesigns(rows);
  assert.equal(agg.bales, 2);
  assert.equal(agg.thans, 4);
  assert.equal(unitDisplayService.formatBalesThans(agg), '2B = 4t');
});
