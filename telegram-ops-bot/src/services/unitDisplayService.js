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

const SETTINGS_KEY = 'THAN_VISIBILITY_WAREHOUSES';
const CACHE_TTL_MS = 60 * 1000;

let _cache = null;
let _cacheTs = 0;

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

/**
 * Warehouses flagged for than-count visibility (cached ~60s).
 * @returns {Promise<Set<string>>}
 */
async function getThanVisibilityWarehouses() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  let csv = '';
  try {
    const settings = await settingsRepository.getAll();
    csv = settings[SETTINGS_KEY];
  } catch (_) { /* sheet unreachable → feature off, never block the picker */ }
  _cache = parseWarehouseCsv(csv);
  _cacheTs = now;
  return _cache;
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
  _cache = null;
  _cacheTs = 0;
}

module.exports = {
  SETTINGS_KEY,
  parseWarehouseCsv,
  getThanVisibilityWarehouses,
  isThanVisibilityWarehouse,
  invalidateCache,
};
