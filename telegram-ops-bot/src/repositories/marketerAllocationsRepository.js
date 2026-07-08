/**
 * Data access for the MarketerAllocations sheet — MKT-2.
 *
 * One row per (marketer_id, design): `allocated_qty` is the bale quantity an
 * admin has released to that marketer. Powers the marketer's category-first
 * "My Products" view — only designs with qty > 0 are visible to them.
 *
 * Columns: marketer_id | marketer_name | design | allocated_qty | updated_by | updated_at | notes
 *
 * Writes are admin-only (allocateMarketerFlow gates entry; the write itself
 * is a direct upsert — no approval queue, per owner: fast to test, can be
 * gated later). Re-allocating overwrites the row; qty 0 hides the design.
 */

const sheets = require('./sheetsClient');

const SHEET = 'MarketerAllocations';
const HEADERS = ['marketer_id', 'marketer_name', 'design', 'allocated_qty', 'updated_by', 'updated_at', 'notes'];

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 10000;

function str(v) { return (v ?? '').toString().trim(); }

/** @param {Array<string>} row Raw sheet row. @returns {object} Parsed record. */
function parse(row) {
  return {
    marketer_id: str(row[0]),
    marketer_name: str(row[1]),
    design: str(row[2]),
    allocated_qty: parseInt(row[3], 10) || 0,
    updated_by: str(row[4]),
    updated_at: str(row[5]),
    notes: str(row[6]),
  };
}

/**
 * All allocation rows (cached, 10 s TTL).
 * @returns {Promise<Array<object>>} Parsed rows (marketer_id + design present).
 */
async function getAll() {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL_MS) return _cache;
  try {
    const rows = await sheets.readRange(SHEET, 'A2:G');
    _cache = (rows || []).map(parse).filter((r) => r.marketer_id && r.design);
    _cacheTs = Date.now();
    return _cache;
  } catch {
    return _cache || [];
  }
}

/**
 * Live allocations (qty > 0) for one marketer.
 * @param {string|number} marketerId Telegram user id.
 * @returns {Promise<Array<object>>} Rows sorted by design.
 */
async function listForMarketer(marketerId) {
  const id = str(marketerId);
  const all = await getAll();
  return all
    .filter((r) => r.marketer_id === id && r.allocated_qty > 0)
    .sort((a, b) => a.design.localeCompare(b.design));
}

/**
 * Marketers that currently hold at least one live allocation.
 * @returns {Promise<Map<string, number>>} marketer_id → count of allocated designs.
 */
async function countsByMarketer() {
  const all = await getAll();
  const m = new Map();
  for (const r of all) {
    if (r.allocated_qty > 0) m.set(r.marketer_id, (m.get(r.marketer_id) || 0) + 1);
  }
  return m;
}

/**
 * Upsert one (marketer, design) allocation. qty 0 keeps the row but hides
 * the design from the marketer's view (history stays visible in the sheet).
 * @param {object} p Params.
 * @param {string} p.marketerId Telegram user id.
 * @param {string} [p.marketerName] Display name (denormalized for sheet readability).
 * @param {string} p.design Design number.
 * @param {number} p.qty Allocated bale quantity (>= 0).
 * @param {string} p.updatedBy Admin user id.
 * @param {string} [p.notes] Optional note.
 * @returns {Promise<{updated: boolean, qty: number}>} updated=true when an existing row was overwritten.
 */
async function setAllocation({ marketerId, marketerName = '', design, qty, updatedBy, notes = '' }) {
  const id = str(marketerId);
  const d = str(design);
  const q = Math.max(0, parseInt(qty, 10) || 0);
  if (!id) throw new Error('marketerAllocationsRepository: marketerId required');
  if (!d) throw new Error('marketerAllocationsRepository: design required');
  const updatedAt = new Date().toISOString();
  const record = [id, str(marketerName), d, q, str(updatedBy), updatedAt, str(notes)];
  const rows = await sheets.readRange(SHEET, 'A2:G');
  const idx = (rows || []).findIndex((r) => str(r[0]) === id && str(r[2]).toUpperCase() === d.toUpperCase());
  if (idx >= 0) {
    await sheets.updateRange(SHEET, `A${idx + 2}:G${idx + 2}`, [record]);
  } else {
    await sheets.appendRows(SHEET, [record]);
  }
  invalidateCache();
  return { updated: idx >= 0, qty: q };
}

/** Drop the read cache. */
function invalidateCache() {
  _cache = null;
  _cacheTs = 0;
}

module.exports = {
  getAll,
  listForMarketer,
  countsByMarketer,
  setAllocation,
  invalidateCache,
  HEADERS,
  SHEET,
};
