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
