'use strict';

/**
 * LOC-1 — the read model over the Locations register.
 *
 * One question, asked from every screen: **where is this place, and what
 * kind of place is it?** The register (Locations sheet) answers it; this
 * service merges that answer with the places the system already knows about
 * from Inventory rows and the WAREHOUSE_LIST Settings CSV.
 *
 * The invariant that keeps it safe: **a place is never hidden.** A
 * warehouse holding stock but missing from the register is reported under
 * `UNASSIGNED`, visibly, so an unregistered place shows up as work to do
 * rather than silently dropping rows off a screen (the class of bug that
 * makes an inbox lie about how much is pending).
 *
 * Nothing here writes. Registration is owner-edited in the sheet for now.
 */

const locationsRepository = require('../repositories/locationsRepository');
const logger = require('../utils/logger');

/** The bucket for a place with no registered location. Never a real city. */
const UNASSIGNED = '__unassigned__';
const UNASSIGNED_LABEL = 'Unassigned';

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Every place the system knows, annotated where the register has it.
 *
 * Sources merged, in order of authority:
 *   1. the Locations register (name → location + kind + status);
 *   2. distinct Inventory.Warehouse values (places holding stock);
 *   3. the WAREHOUSE_LIST Settings CSV (registered before holding stock).
 *
 * @returns {Promise<Array<{name:string, location:string, kind:string, status:string, registered:boolean}>>}
 */
async function allPlaces() {
  const byName = new Map();

  let registered = [];
  try { registered = await locationsRepository.getAll(); } catch (e) {
    logger.warn(`locationService: register read failed, continuing unannotated: ${e.message}`);
  }
  for (const p of registered) {
    if (p.status === 'closed') continue;
    byName.set(norm(p.name), {
      name: p.name, location: p.location || '', kind: p.kind, status: p.status, registered: true,
    });
  }

  // Places that HOLD STOCK must appear even when nobody registered them.
  try {
    const inventoryRepository = require('../repositories/inventoryRepository');
    const names = await inventoryRepository.getWarehouses();
    for (const n of names || []) {
      if (!n || byName.has(norm(n))) continue;
      byName.set(norm(n), { name: n, location: '', kind: 'warehouse', status: 'active', registered: false });
    }
  } catch (e) {
    logger.warn(`locationService: Inventory warehouse read failed: ${e.message}`);
  }

  // Names registered through the dual-admin Add Warehouse flow.
  try {
    const settingsRepository = require('../repositories/settingsRepository');
    const csv = (await settingsRepository.getAll()).WAREHOUSE_LIST || '';
    for (const n of csv.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (byName.has(norm(n))) continue;
      byName.set(norm(n), { name: n, location: '', kind: 'warehouse', status: 'active', registered: false });
    }
  } catch (e) {
    logger.warn(`locationService: WAREHOUSE_LIST read failed: ${e.message}`);
  }

  return [...byName.values()];
}

/**
 * The city a place sits in, or '' when unregistered.
 * @param {string} placeName
 * @returns {Promise<string>}
 */
async function locationOf(placeName) {
  const key = norm(placeName);
  if (!key) return '';
  const hit = (await allPlaces()).find((p) => norm(p.name) === key);
  return (hit && hit.location) || '';
}

/**
 * Locations with their places, for a picker. Unassigned places collect
 * under one final bucket so they are impossible to miss.
 *
 * @returns {Promise<Array<{location:string, label:string, places:string[]}>>}
 */
async function listLocations() {
  const groups = new Map();
  for (const p of await allPlaces()) {
    const key = p.location ? p.location : UNASSIGNED;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p.name);
  }
  const out = [...groups.entries()]
    .filter(([k]) => k !== UNASSIGNED)
    .sort((a, b) => a[0].localeCompare(b[0], 'en'))
    .map(([location, places]) => ({
      location, label: location, places: places.sort((a, b) => a.localeCompare(b, 'en')),
    }));
  if (groups.has(UNASSIGNED)) {
    out.push({
      location: UNASSIGNED, label: UNASSIGNED_LABEL,
      places: groups.get(UNASSIGNED).sort((a, b) => a.localeCompare(b, 'en')),
    });
  }
  return out;
}

/**
 * True when `placeName` belongs to `location`. The UNASSIGNED bucket
 * matches any place the register does not place in a city.
 *
 * @param {string} placeName
 * @param {string} location
 * @param {Array} [places] pre-loaded allPlaces() result, to avoid re-reading
 */
function placeIsIn(placeName, location, places) {
  const key = norm(placeName);
  const hit = (places || []).find((p) => norm(p.name) === key);
  const where = (hit && hit.location) || '';
  return location === UNASSIGNED ? !where : norm(where) === norm(location);
}

/** 'store' | 'warehouse' — the packaging/size distinction, default warehouse. */
async function kindOf(placeName) {
  const key = norm(placeName);
  const hit = (await allPlaces()).find((p) => norm(p.name) === key);
  return (hit && hit.kind) || 'warehouse';
}

module.exports = {
  UNASSIGNED, UNASSIGNED_LABEL,
  allPlaces, locationOf, listLocations, placeIsIn, kindOf,
};
