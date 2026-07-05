/**
 * unitDisplayService — per-warehouse display-unit preference (TV-1).
 *
 * Some warehouses (e.g. "Kano office") market stock by THAN, not by bale.
 * The Settings sheet key THAN_VISIBILITY_WAREHOUSES holds a CSV of warehouse
 * names whose stock listings should show subunit (than) counts in brackets
 * instead of container (bale) counts. Matching is trimmed and
 * case-insensitive; an empty value disables the feature everywhere.
 *
 * DISPLAY-ONLY: quantity selection, the cart, and approvals stay in bales.
 * The list is cached for ~60s so pickers don't add a Settings read per tap;
 * edits to the Settings sheet are picked up within a minute.
 */

'use strict';

const settingsRepository = require('../repositories/settingsRepository');
const { ttlCache } = require('../utils/ttlCache');

const SETTINGS_KEY = 'THAN_VISIBILITY_WAREHOUSES';
const CACHE_TTL_MS = 60 * 1000;

/**
 * Parse a CSV of warehouse names into a normalized lookup Set.
 * Non-string input (e.g. an emptied Settings cell coerced to 0) yields
 * an empty set — i.e. the feature is off.
 * @param {*} csv raw Settings value
 * @returns {Set<string>} lowercased, trimmed warehouse names
 */
function parseWarehouseCsv(csv) {
  const raw = typeof csv === 'string' ? csv : '';
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

// Cached ~60s; loader swallows sheet errors → feature off, never block a picker.
const _warehouseCache = ttlCache(CACHE_TTL_MS, async () => {
  let csv = '';
  try {
    const settings = await settingsRepository.getAll();
    csv = settings[SETTINGS_KEY];
  } catch (_) { /* sheet unreachable → feature off */ }
  return parseWarehouseCsv(csv);
});

/**
 * Warehouses flagged for than-count visibility (cached ~60s).
 * @returns {Promise<Set<string>>}
 */
async function getThanVisibilityWarehouses() {
  return _warehouseCache.get();
}

/**
 * True when stock listed in `warehouse` should show than counts.
 * @param {string} warehouse warehouse name as stored on Inventory rows
 * @returns {Promise<boolean>}
 */
async function isThanVisibilityWarehouse(warehouse) {
  const set = await getThanVisibilityWarehouses();
  return set.has(String(warehouse == null ? '' : warehouse).trim().toLowerCase());
}

/** Drop the cached list (tests / after Settings writes). */
function invalidateCache() {
  _warehouseCache.invalidate();
}

/**
 * TV-2 — pure CSV rewrite: set `warehouse` to `mode` inside a CSV of
 * than-visibility warehouse names. Case-insensitive and idempotent;
 * preserves the original casing/order of other entries.
 * @param {*} csv current Settings value
 * @param {string} warehouse warehouse name (casing preserved on add)
 * @param {'thans'|'bales'} mode target display mode
 * @returns {string} the new CSV value
 */
function computeWarehouseCsv(csv, warehouse, mode) {
  const raw = typeof csv === 'string' ? csv : '';
  const target = String(warehouse || '').trim();
  const targetLc = target.toLowerCase();
  const kept = raw.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((name) => name.toLowerCase() !== targetLc);
  if (mode === 'thans' && target) kept.push(target);
  return kept.join(', ');
}

/**
 * TV-2 — persist a warehouse's display mode to the Settings sheet and
 * invalidate the cache so it takes effect immediately.
 * @param {string} warehouse warehouse name
 * @param {'thans'|'bales'} mode target display mode
 * @returns {Promise<string>} the CSV that was written
 */
async function setWarehouseMode(warehouse, mode) {
  if (!warehouse || !String(warehouse).trim()) {
    throw new Error('unitDisplayService: warehouse required');
  }
  if (mode !== 'thans' && mode !== 'bales') {
    throw new Error('unitDisplayService: mode must be "thans" or "bales"');
  }
  const settings = await settingsRepository.getAll();
  const next = computeWarehouseCsv(settings[SETTINGS_KEY], warehouse, mode);
  await settingsRepository.set(SETTINGS_KEY, next);
  invalidateCache();
  return next;
}

module.exports = {
  SETTINGS_KEY,
  parseWarehouseCsv,
  computeWarehouseCsv,
  getThanVisibilityWarehouses,
  isThanVisibilityWarehouse,
  setWarehouseMode,
  invalidateCache,
};
