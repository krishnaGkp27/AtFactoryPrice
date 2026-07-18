'use strict';

/**
 * WAU-2 — StockTakes: one row per DESIGN marked reconciled in a warehouse
 * audit (owner flow, 17-Jul-2026). Raw tabular business records (storage
 * rule 5b): the physical-count event with the sheet quantities it verified,
 * who audited, and when. Never deleted; "holding" is simply the absence of
 * a still-valid reconciled row.
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
  };
}

async function getAll() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  const rows = await sheets.readRange(SHEET, 'A2:J');
  _cache = rows.map((r, i) => parse(r, i + 2)).filter((x) => x.stocktake_id);
  _cacheTs = Date.now();
  return _cache;
}

/** Append one reconciled-design row per record. */
async function appendMany(records) {
  if (!records.length) return [];
  const rows = records.map((o) => [
    o.stocktake_id || `ST-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    o.location || '', o.warehouse, o.design,
    o.sheet_bales || 0, o.sheet_bundles || 0, o.sheet_yards || 0,
    o.result || 'reconciled', o.auditor || '', o.audited_at || new Date().toISOString(),
  ]);
  await sheets.appendRows(SHEET, rows);
  invalidateCache();
  return rows;
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

module.exports = { SHEET, HEADERS, getAll, appendMany, latestFor, invalidateCache };
