'use strict';

/**
 * WAU-2/WAU-3 — StockTakes: one row per AUDIT EVENT on a design in a
 * warehouse. Raw tabular business records (storage rule 5b): what the book
 * said, what was physically counted, the outcome, who, when. Append-only —
 * never deleted or mutated; every verdict is derived at read time.
 *
 * result values (WAU-3 blind count, owner 20-Jul-2026):
 *   'reconciled'   count matched the book (legacy WAU-2 checkbox rows too)
 *   'mismatch'     a blind count attempt that did NOT match (counted_* kept)
 *   'flagged'      second same-day mismatch — admins alerted, design locked
 *   'flag_cleared' admin cleared a flag (auditor = the admin) — unlocks
 *
 * A reconciliation is treated as VALID only while the warehouse's current
 * quantities still equal the audited ones — any sale/receipt/transfer that
 * changes the design's stock silently flips it back to holding (equality
 * check lives in the flow). No expiry logic needed.
 */

const crypto = require('crypto');
const sheets = require('./sheetsClient');

const SHEET = 'StockTakes';
const HEADERS = [
  'stocktake_id', 'location', 'warehouse', 'design',
  'sheet_bales', 'sheet_bundles', 'sheet_yards',
  'result', 'auditor', 'audited_at',
  // WAU-3 — the auditor's blind count (end-append per sheet rules).
  'counted_bales', 'counted_bundles', 'note',
];

const CACHE_TTL_MS = 30 * 1000;
let _cache = null;
let _cacheTs = 0;
function invalidateCache() { _cache = null; _cacheTs = 0; }

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function parse(r, rowIndex) {
  return {
    rowIndex,
    stocktake_id: str(r[0]),
    location: str(r[1]),
    warehouse: str(r[2]),
    design: str(r[3]),
    sheet_bales: num(r[4]),
    sheet_bundles: num(r[5]),
    sheet_yards: num(r[6]),
    result: str(r[7]) || 'reconciled',
    auditor: str(r[8]),
    audited_at: str(r[9]),
    counted_bales: r[10] === undefined || r[10] === '' ? null : num(r[10]),
    counted_bundles: r[11] === undefined || r[11] === '' ? null : num(r[11]),
    note: str(r[12]),
  };
}

async function getAll() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  const rows = await sheets.readRange(SHEET, 'A2:M');
  _cache = rows.map((r, i) => parse(r, i + 2)).filter((x) => x.stocktake_id);
  _cacheTs = Date.now();
  return _cache;
}

/**
 * Append one audit-event row per record. Returns the records WITH their
 * minted stocktake_ids so callers (e.g. the flag→admin card) can reference
 * a specific row later.
 */
async function appendMany(records) {
  if (!records.length) return [];
  const minted = records.map((o) => ({
    ...o,
    stocktake_id: o.stocktake_id || `ST-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    audited_at: o.audited_at || new Date().toISOString(),
  }));
  const rows = minted.map((o) => [
    o.stocktake_id,
    o.location || '', o.warehouse, o.design,
    o.sheet_bales || 0, o.sheet_bundles || 0, o.sheet_yards || 0,
    o.result || 'reconciled', o.auditor || '', o.audited_at,
    o.counted_bales === undefined || o.counted_bales === null ? '' : o.counted_bales,
    o.counted_bundles === undefined || o.counted_bundles === null ? '' : o.counted_bundles,
    o.note || '',
  ]);
  await sheets.appendRows(SHEET, rows);
  invalidateCache();
  return minted;
}

/** Latest reconciled row per design for a warehouse: Map(DESIGN → row). */
async function latestFor(warehouse) {
  const all = await getAll();
  const w = str(warehouse).toLowerCase();
  const map = new Map();
  for (const r of all) {
    if (r.warehouse.toLowerCase() !== w || r.result !== 'reconciled') continue;
    const k = r.design.toUpperCase();
    const prev = map.get(k);
    if (!prev || r.audited_at > prev.audited_at) map.set(k, r);
  }
  return map;
}

/** All rows for a warehouse on a given day (audited_at date prefix). */
async function rowsForDay(warehouse, dayIso) {
  const all = await getAll();
  const w = str(warehouse).toLowerCase();
  return all.filter((r) => r.warehouse.toLowerCase() === w && r.audited_at.startsWith(dayIso));
}

/** Find one row by its stocktake_id (for flag-clear cards). */
async function getById(stocktakeId) {
  const all = await getAll();
  return all.find((r) => r.stocktake_id === str(stocktakeId)) || null;
}

module.exports = { SHEET, HEADERS, getAll, appendMany, latestFor, rowsForDay, getById, invalidateCache };
