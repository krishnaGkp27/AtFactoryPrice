'use strict';

/**
 * shadesRepository — sole owner of the Shades sheet.
 *
 * Columns: shade_id | shade_name | display_emoji | supplier_colour_no |
 *          active | aliases | created_at | notes
 *
 * Used by the bundle sale flow (Kano poly-colour bales) and any future
 * UI that wants a consistent emoji chip for a colour name. The catalogue
 * is seeded by schemaMapper with the ten most-common Nigerian textile
 * colours. Admin can extend it without a code change.
 *
 * Lookup is case-insensitive and supports comma-separated `aliases` so
 * "BLK" / "Crimson" map onto the canonical shade. Falls back to a
 * generic chip ("🎨") when an Inventory shade has no entry — this is
 * intentionally non-blocking so a new colour can't break the picker.
 */

const sheets = require('./sheetsClient');

const SHEET = 'Shades';
const DEFAULT_EMOJI = '🎨';
const TTL_MS = 60_000;

let _cache = null;
let _cacheTs = 0;

function str(v) { return (v ?? '').toString().trim(); }

function parse(r) {
  if (!r || !r[0]) return null;
  return {
    shade_id:           str(r[0]),
    shade_name:         str(r[1]),
    display_emoji:      str(r[2]) || DEFAULT_EMOJI,
    supplier_colour_no: str(r[3]),
    active:             String(r[4] || '').toUpperCase() === 'TRUE',
    aliases:            str(r[5]).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    created_at:         str(r[6]),
    notes:              str(r[7]),
  };
}

async function getAll({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && (now - _cacheTs) < TTL_MS) return _cache;
  let rows;
  try {
    rows = await sheets.readRange(SHEET, 'A2:H');
  } catch (_) {
    rows = [];
  }
  _cache = (rows || []).map(parse).filter(Boolean);
  _cacheTs = now;
  return _cache;
}

function invalidate() {
  _cache = null;
  _cacheTs = 0;
}

async function getActive() {
  return (await getAll()).filter((s) => s.active);
}

/**
 * Resolve an arbitrary shade string (as stored on an Inventory row) to a
 * canonical Shades entry. Tries exact name match first, then alias match,
 * then substring contains. Returns `null` when nothing fits — callers
 * should render a generic chip in that case.
 */
async function resolve(shadeStr) {
  const q = str(shadeStr).toLowerCase();
  if (!q) return null;
  const all = await getAll();
  let hit = all.find((s) => s.shade_name.toLowerCase() === q);
  if (hit) return hit;
  hit = all.find((s) => s.aliases.includes(q));
  if (hit) return hit;
  hit = all.find((s) => q.includes(s.shade_name.toLowerCase()));
  return hit || null;
}

/**
 * Synchronous lookup against a prefetched list — handy when a flow has
 * already paid the API cost and needs to map dozens of shade strings.
 */
function resolveFrom(list, shadeStr) {
  const q = str(shadeStr).toLowerCase();
  if (!q || !list) return null;
  let hit = list.find((s) => s.shade_name.toLowerCase() === q);
  if (hit) return hit;
  hit = list.find((s) => s.aliases.includes(q));
  if (hit) return hit;
  hit = list.find((s) => q.includes(s.shade_name.toLowerCase()));
  return hit || null;
}

/**
 * Return just the emoji chip for a shade string, falling back to the
 * generic chip. Async (uses cache).
 */
async function chipFor(shadeStr) {
  const hit = await resolve(shadeStr);
  return hit ? hit.display_emoji : DEFAULT_EMOJI;
}

function chipFromList(list, shadeStr) {
  const hit = resolveFrom(list, shadeStr);
  return hit ? hit.display_emoji : DEFAULT_EMOJI;
}

module.exports = {
  SHEET,
  DEFAULT_EMOJI,
  getAll,
  getActive,
  resolve,
  resolveFrom,
  chipFor,
  chipFromList,
  invalidate,
};
