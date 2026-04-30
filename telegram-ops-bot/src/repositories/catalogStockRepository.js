/**
 * Data access for CatalogStock sheet — physical catalog inventory per design × size × warehouse.
 *
 * Each row tracks stock for one combination: e.g. design 9006, Big, Lagos.
 * Quantities: total = in_office + with_customers + with_marketers.
 */

const sheets = require('./sheetsClient');

const SHEET = 'CatalogStock';
const HEADERS = [
  'Design', 'CatalogSize', 'Warehouse', 'TotalQty',
  'InOfficeQty', 'WithCustomersQty', 'WithMarketersQty', 'UpdatedAt',
];
const COL_COUNT = HEADERS.length;

/** Short-lived cache to avoid hammering the API during batch ops. */
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 10000;

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }

function parseRow(r, rowIndex) {
  return {
    rowIndex,
    design: str(r[0]),
    catalog_size: str(r[1]),
    warehouse: str(r[2]),
    total_qty: num(r[3]),
    in_office_qty: num(r[4]),
    with_customers_qty: num(r[5]),
    with_marketers_qty: num(r[6]),
    updated_at: str(r[7]),
  };
}

function toRow(o) {
  const inOffice = num(o.in_office_qty);
  const withCust = num(o.with_customers_qty);
  const withMkt = num(o.with_marketers_qty);
  return [
    o.design ?? '',
    o.catalog_size ?? '',
    o.warehouse ?? '',
    inOffice + withCust + withMkt,
    inOffice,
    withCust,
    withMkt,
    o.updated_at ?? new Date().toISOString(),
  ];
}

function columnLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

async function ensureHeader() {
  try {
    const names = await sheets.getSheetNames();
    if (!names.includes(SHEET)) {
      try { await sheets.addSheet(SHEET); } catch (_) { /* may race or already exist */ }
    }
  } catch (_) { /* sheet listing failure: try header write anyway */ }

  const rows = await sheets.readRange(SHEET, `A1:${columnLetter(COL_COUNT)}1`).catch(() => []);
  if (!rows.length || rows[0].length < COL_COUNT) {
    await sheets.updateRange(SHEET, `A1:${columnLetter(COL_COUNT)}1`, [HEADERS]);
  }
}

function invalidateCache() { _cache = null; _cacheTs = 0; }

async function getAll() {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL_MS) return _cache;
  await ensureHeader();
  const rows = await sheets.readRange(SHEET, `A2:${columnLetter(COL_COUNT)}`).catch(() => []);
  _cache = rows.map((r, i) => parseRow(r, i + 2)).filter((r) => r.design);
  _cacheTs = Date.now();
  return _cache;
}

async function find(design, catalogSize, warehouse) {
  const all = await getAll();
  const d = (design || '').toLowerCase();
  const s = (catalogSize || '').toLowerCase();
  const w = (warehouse || '').toLowerCase();
  return all.find(
    (r) => r.design.toLowerCase() === d
      && r.catalog_size.toLowerCase() === s
      && r.warehouse.toLowerCase() === w,
  ) || null;
}

async function findByDesign(design) {
  const all = await getAll();
  const d = (design || '').toLowerCase();
  return all.filter((r) => r.design.toLowerCase() === d);
}

async function findByWarehouse(warehouse) {
  const all = await getAll();
  const w = (warehouse || '').toLowerCase();
  return all.filter((r) => r.warehouse.toLowerCase() === w);
}

async function append(record) {
  await ensureHeader();
  await sheets.appendRows(SHEET, [toRow(record)]);
  invalidateCache();
}

async function updateQty(rowIndex, inOfficeQty, withCustomersQty, withMarketersQty) {
  const inOffice = num(inOfficeQty);
  const withCust = num(withCustomersQty);
  const withMkt = num(withMarketersQty);
  const total = inOffice + withCust + withMkt;
  const now = new Date().toISOString();
  await sheets.updateRange(SHEET, `D${rowIndex}:H${rowIndex}`, [[
    total, inOffice, withCust, withMkt, now,
  ]]);
  invalidateCache();
}

async function getDesignsWithStock(warehouse) {
  const all = await getAll();
  const w = (warehouse || '').toLowerCase();
  const rows = all.filter((r) => r.warehouse.toLowerCase() === w && r.in_office_qty > 0);

  const map = new Map();
  for (const r of rows) {
    const key = r.design.toLowerCase();
    if (!map.has(key)) {
      map.set(key, { design: r.design, sizes: {} });
    }
    map.get(key).sizes[r.catalog_size] = r.in_office_qty;
  }
  return Array.from(map.values());
}

module.exports = {
  SHEET,
  HEADERS,
  getAll,
  find,
  findByDesign,
  findByWarehouse,
  append,
  updateQty,
  getDesignsWithStock,
  ensureHeader,
  invalidateCache,
};
