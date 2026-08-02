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
 * TV-7 (owner, 25-Jul-2026) — single-figure stock display for than-visibility
 * warehouses: THANS ONLY, e.g. { bales: 22, thans: 88 } → "88t", rendered as
 * "9043-B (88t)".
 *
 * Supersedes the TV-3 "<N>B = <M>t" pair. The owner's reason: the "=" read as
 * a conversion ("1 bale = 4 thans") and made it ambiguous which number was the
 * quantity — thans are not measured in bales. Kano sells in thans, so the than
 * count IS the figure; every other warehouse sells whole bales and shows bales
 * only (formatRemainingOpeningBales). Same rule the Supply Details drill uses.
 *
 * `bales` is still accepted so callers stay unchanged, and because the physical
 * bale count (inventoryPickers.baleGroupKey) still drives selection.
 * Display-only, like all of TV-1..6: carts and approvals stay in bales.
 * @param {{bales:number|*, thans:number|*}} counts
 * @returns {string} e.g. "88t"
 */
function formatBalesThans({ thans } = {}) {
  const t = Number.isFinite(Number(thans)) ? Number(thans) : 0;
  return `${t}t`;
}

/**
 * TV-7 — compact form used inside the "remaining / opening" pair. Now
 * identical to {@link formatBalesThans}: with the bale figure dropped there is
 * no longer a wide/narrow variant to choose between (TV-4b existed only to
 * stop "<N>B=<M>t / <N>B=<M>t" truncating on a phone).
 * @param {{bales:number|*, thans:number|*}} counts
 * @returns {string} e.g. "88t"
 */
function formatBalesThansCompact({ thans } = {}) {
  const t = Number.isFinite(Number(thans)) ? Number(thans) : 0;
  return `${t}t`;
}

/**
 * TV-4 + TV-7 — "remaining / opening" display for than-visibility warehouses,
 * thans only: "<remT>t / <openT>t", e.g. "88t / 132t" (spaces around "/").
 * remaining = rows still available today (cart-adjusted); opening = every
 * Inventory row ever recorded for the slice, any status (available + sold +
 * in_transit). Display-only like all of TV-1..6.
 * @param {{bales:number|*, thans:number|*}} remaining
 * @param {{bales:number|*, thans:number|*}} opening
 * @returns {string} e.g. "88t / 132t"
 */
function formatRemainingOpening(remaining, opening) {
  return `${formatBalesThansCompact(remaining)} / ${formatBalesThansCompact(opening)}`;
}

/**
 * TV-5 — bales-only compact "remaining / opening" pair for warehouses NOT
 * flagged for than visibility (they market stock by bale, no than figures):
 * "<remB>B / <openB>B", e.g. "20B / 30B". Same pair semantics as
 * formatRemainingOpening (remaining = cart-adjusted available today;
 * opening = every Inventory row ever for the slice, any status), minus the
 * than counts. Display-only, like all of TV-1..4: selection, carts and
 * approvals stay in bales.
 * @param {{bales:number|*}} remaining
 * @param {{bales:number|*}} opening
 * @returns {string} e.g. "20B / 30B"
 */
function formatRemainingOpeningBales(remaining, opening) {
  const fmt = ({ bales } = {}) => `${Number.isFinite(Number(bales)) ? Number(bales) : 0}B`;
  return `${fmt(remaining)} / ${fmt(opening)}`;
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

/* ── TV-8: the one quantity grammar (owner, 02-Aug-2026) ─────────────
 *
 * "Only the customer taking the goods from an allowed store (Kano office,
 *  Lagos office) will be showing thans. Remaining will be showing bales
 *  with suffix B, or bales plus thans ..B + ..t."
 *
 * Two things make a quantity thans, and BOTH are folded into one label:
 *   1. the goods left a than-visibility warehouse (TV-1 Settings), or
 *   2. the customer took only PART of a bale — a bale-only warehouse that
 *      starts breaking bales (owner: "if we start moving the warehouse
 *      into small store as well") supplies whole bales + loose thans.
 *
 * So: 6B · 250t · 4B + 21t — a customer's whole bales, then every loose
 * than from either source, added together. Yards are a measure, not a
 * packaging unit, and are printed alongside by callers as before.
 *
 * "Whole" means the customer took EVERY than of that bale — judged
 * against the bale's full than roster across all statuses, so a bale
 * split between two customers reads as loose thans for each of them.
 * Without a roster the labeller degrades to counting whole bales, which
 * is exactly the pre-TV-8 behaviour.
 *
 * KNOWN LIMIT: the roster is keyed design|packageNo|arrival_batch. Printed
 * numbers are legitimately re-used across intakes (BUSINESS_RULES §5), so
 * two physical bales sharing a number AND a container would share a
 * roster and could read as loose. The container axis makes that rare; the
 * alternative (a per-bale id) does not exist in the sheet — bale_uid is
 * per-than.
 */

const { baleGroupKey } = require('../utils/inventoryPickers');

/** Roster key: the bale identity, narrowed by arrival container. */
function rosterKey(r) {
  const batch = String((r && r.arrivalBatch) || '').trim().toUpperCase();
  return `${baleGroupKey(r)}|${batch}`;
}

/**
 * Build the than-count roster for every bale — how many than rows exist,
 * across ALL statuses. Pass `inventoryRepository.getAll()` rows.
 * @param {Array<object>} allRows
 * @returns {Map<string, number>}
 */
function buildBaleRoster(allRows) {
  const roster = new Map();
  for (const r of allRows || []) {
    const k = rosterKey(r);
    roster.set(k, (roster.get(k) || 0) + 1);
  }
  return roster;
}

/**
 * Format one row set in the owner's grammar.
 * @param {Array<object>} rows sold/held Inventory rows (one row = one than)
 * @param {{thanWarehouses?:Set<string>, roster?:Map<string,number>, empty?:string}} opts
 * @returns {string} "6B" · "250t" · "4B + 21t"
 */
function formatQty(rows, opts = {}) {
  const thanSet = opts.thanWarehouses || new Set();
  const roster = opts.roster || null;
  let thans = 0;
  let bales = 0;
  const byBale = new Map();
  for (const r of rows || []) {
    const wh = String((r && r.warehouse) || '').trim().toLowerCase();
    if (thanSet.has(wh)) { thans += 1; continue; }   // than-visible store
    const k = rosterKey(r);
    if (!byBale.has(k)) byBale.set(k, 0);
    byBale.set(k, byBale.get(k) + 1);
  }
  for (const [k, taken] of byBale) {
    const total = roster ? (roster.get(k) || taken) : taken;
    if (taken >= total) bales += 1;                  // the whole bale
    else thans += taken;                             // a broken bale
  }
  const parts = [];
  if (bales) parts.push(`${bales}B`);
  if (thans) parts.push(`${thans}t`);
  return parts.length ? parts.join(' + ') : (opts.empty || '0B');
}

/**
 * One-call helper for a render: resolves the than-visible set once and
 * (optionally) builds the roster, returning a SYNC labeller.
 * @param {Array<object>} [allRows] every Inventory row, for whole/loose
 * @returns {Promise<function(Array<object>, object=):string>}
 */
async function createQtyLabeller(allRows) {
  const thanWarehouses = await getThanVisibilityWarehouses();
  const roster = allRows ? buildBaleRoster(allRows) : null;
  return (rows, extra = {}) => formatQty(rows, { thanWarehouses, roster, ...extra });
}

module.exports = {
  SETTINGS_KEY,
  formatBalesThans,
  formatRemainingOpening,
  formatRemainingOpeningBales,
  parseWarehouseCsv,
  computeWarehouseCsv,
  getThanVisibilityWarehouses,
  isThanVisibilityWarehouse,
  setWarehouseMode,
  invalidateCache,
  // TV-8
  formatQty,
  buildBaleRoster,
  createQtyLabeller,
  _internals: { rosterKey },
};
