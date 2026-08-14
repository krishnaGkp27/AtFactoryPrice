'use strict';

/**
 * LOC-1 — sole owner of the `Locations` sheet: the register of PHYSICAL
 * PLACES and the city each one sits in.
 *
 * Why this sheet exists (owner, 14-Aug-2026). Until now a "warehouse" was
 * only a NAME on Inventory rows — `inventoryService.js` says it plainly:
 * "There is no central Warehouses sheet today — warehouses are derived from
 * distinct Inventory.Warehouse values." Three name-only lists existed
 * (Inventory's distinct values, the WAREHOUSE_LIST Settings CSV, and the
 * THAN_VISIBILITY_WAREHOUSES display toggle) and none of them knew:
 *
 *   - which CITY a place belongs to (Lagos / Kano …), so nothing could be
 *     browsed or reported per location; and
 *   - what KIND of place it is — a warehouse, or a STORE (physically
 *     smaller, different supply packaging, sells in thans).
 *
 * This is a RAW master record of the business's own geography, so per the
 * owner's storage rule it belongs in Sheets, owner-editable, no deploy.
 *
 * It does NOT replace the three existing lists and changes no behaviour on
 * its own: names still come from Inventory + WAREHOUSE_LIST. This sheet
 * only ANNOTATES them. A place missing here is never hidden — every reader
 * buckets it as unassigned and shows it, so a new warehouse cannot vanish
 * from a screen just because nobody registered it yet.
 *
 * Columns
 *   name        the place, spelled EXACTLY as Inventory.Warehouse spells it
 *   location    the city it sits in ('Lagos', 'Kano', …)
 *   kind        'warehouse' | 'store'
 *   status      'active' | 'planned' | 'closed'   (planned = structure
 *               declared before it holds stock, e.g. a warehouse the owner
 *               is about to split Lagos warehouse into)
 *   notes · updated_by · updated_at
 */

const sheets = require('./sheetsClient');

const SHEET = 'Locations';
const HEADERS = ['name', 'location', 'kind', 'status', 'notes', 'updated_by', 'updated_at'];

const KINDS = ['warehouse', 'store'];
const STATUSES = ['active', 'planned', 'closed'];

const CACHE_TTL_MS = 60 * 1000;
let _cache = null;
let _cacheTs = 0;
function invalidateCache() { _cache = null; _cacheTs = 0; }

function str(v) { return (v ?? '').toString().trim(); }

function parse(r, rowIndex) {
  const kind = str(r[2]).toLowerCase();
  const status = str(r[3]).toLowerCase();
  return {
    rowIndex,
    name: str(r[0]),
    location: str(r[1]),
    // An unrecognised value degrades to the safe default rather than
    // inventing a third kind nobody handles.
    kind: KINDS.includes(kind) ? kind : 'warehouse',
    status: STATUSES.includes(status) ? status : 'active',
    notes: str(r[4]),
    updated_by: str(r[5]),
    updated_at: str(r[6]),
  };
}

/** Every registered place. Cached ~60 s; a read failure yields []. */
async function getAll() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  let rows;
  try {
    rows = await sheets.readRange(SHEET, 'A2:G');
  } catch (_) {
    // The sheet may not exist yet on a deploy that predates schemaMapper's
    // bootstrap. An empty register means "nothing annotated", never a crash.
    return [];
  }
  _cache = (rows || [])
    .map((r, i) => parse(r, i + 2))
    .filter((p) => p.name);
  _cacheTs = now;
  return _cache;
}

/** Register one place. Callers dedupe by name first (see locationService). */
async function append(place) {
  const now = new Date().toISOString();
  const kind = String(place.kind || 'warehouse').toLowerCase();
  const status = String(place.status || 'active').toLowerCase();
  await sheets.appendRows(SHEET, [[
    str(place.name), str(place.location),
    KINDS.includes(kind) ? kind : 'warehouse',
    STATUSES.includes(status) ? status : 'active',
    str(place.notes), str(place.updated_by), now,
  ]]);
  invalidateCache();
  return { ...place, updated_at: now };
}

module.exports = { SHEET, HEADERS, KINDS, STATUSES, getAll, append, invalidateCache };
