/**
 * Data access for Inventory sheet — Package/Than model.
 * Columns: PackageNo | Indent | CSNo | Design | Shade | ThanNo | Yards | Status |
 *          Warehouse | PricePerYard | DateReceived | SoldTo | SoldDate | NetMtrs | NetWeight | UpdatedAt
 */

const sheets = require('./sheetsClient');

const SHEET = 'Inventory';
const COL_COUNT = 16;
const HEADERS = [
  'PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status',
  'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
];

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }
function upper(v) { return str(v).toUpperCase(); }

function parseRow(r, rowIndex) {
  return {
    rowIndex,
    packageNo: str(r[0]),
    indent: str(r[1]),
    csNo: str(r[2]),
    design: str(r[3]),
    shade: str(r[4]),
    thanNo: num(r[5]),
    yards: num(r[6]),
    status: str(r[7]).toLowerCase() || 'available',
    warehouse: str(r[8]),
    pricePerYard: num(r[9]),
    dateReceived: str(r[10]),
    soldTo: str(r[11]),
    soldDate: str(r[12]),
    netMtrs: num(r[13]),
    netWeight: num(r[14]),
    updatedAt: str(r[15]),
  };
}

function toRow(o) {
  return [
    o.packageNo ?? '', o.indent ?? '', o.csNo ?? '', o.design ?? '', o.shade ?? '',
    o.thanNo ?? '', o.yards ?? 0, o.status ?? 'available',
    o.warehouse ?? '', o.pricePerYard ?? 0, o.dateReceived ?? '',
    o.soldTo ?? '', o.soldDate ?? '', o.netMtrs ?? '', o.netWeight ?? '',
    o.updatedAt ?? '',
  ];
}

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:P1');
  if (!rows.length || rows[0].length < COL_COUNT) {
    await sheets.updateRange(SHEET, 'A1:P1', [HEADERS]);
  }
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:P');
  return rows.map((r, i) => parseRow(r, i + 2)).filter((r) => r.packageNo || r.design);
}

async function findByDesign(design, shade) {
  const all = await getAll();
  const d = upper(design);
  const s = shade ? upper(shade) : null;
  return all.filter((r) => upper(r.design) === d && (!s || upper(r.shade) === s));
}

async function findByPackage(packageNo) {
  const all = await getAll();
  const p = str(packageNo);
  return all.filter((r) => r.packageNo === p);
}

async function findAvailable(filters = {}) {
  const all = await getAll();
  return all.filter((r) => {
    if (r.status !== 'available') return false;
    if (filters.design && upper(r.design) !== upper(filters.design)) return false;
    if (filters.shade && upper(r.shade) !== upper(filters.shade)) return false;
    if (filters.warehouse && upper(r.warehouse) !== upper(filters.warehouse)) return false;
    if (filters.packageNo && r.packageNo !== str(filters.packageNo)) return false;
    return true;
  });
}

async function findThan(packageNo, thanNo) {
  const all = await getAll();
  const p = str(packageNo);
  const t = num(thanNo);
  return all.find((r) => r.packageNo === p && r.thanNo === t) || null;
}

async function markThanSold(packageNo, thanNo, customer) {
  const than = await findThan(packageNo, thanNo);
  if (!than) return null;
  const now = new Date().toISOString();
  const soldDate = new Date().toISOString().split('T')[0];
  await sheets.updateRange(SHEET, `H${than.rowIndex}:P${than.rowIndex}`, [[
    'sold', than.warehouse, than.pricePerYard, than.dateReceived,
    customer || '', soldDate, than.netMtrs, than.netWeight, now,
  ]]);
  return { ...than, status: 'sold', soldTo: customer, soldDate, updatedAt: now };
}

async function markPackageSold(packageNo, customer) {
  const thans = await findByPackage(packageNo);
  const available = thans.filter((t) => t.status === 'available');
  if (!available.length) return [];
  const now = new Date().toISOString();
  const soldDate = new Date().toISOString().split('T')[0];
  const results = [];
  for (const than of available) {
    await sheets.updateRange(SHEET, `H${than.rowIndex}:P${than.rowIndex}`, [[
      'sold', than.warehouse, than.pricePerYard, than.dateReceived,
      customer || '', soldDate, than.netMtrs, than.netWeight, now,
    ]]);
    results.push({ ...than, status: 'sold', soldTo: customer, soldDate, updatedAt: now });
  }
  return results;
}

async function appendThans(thanRows) {
  await ensureHeader();
  const rows = thanRows.map(toRow);
  await sheets.appendRows(SHEET, rows);
  return thanRows.length;
}

async function getWarehouses() {
  const all = await getAll();
  const set = new Set();
  all.forEach((r) => { if (r.warehouse) set.add(r.warehouse); });
  return Array.from(set).sort();
}

async function markThanAvailable(packageNo, thanNo) {
  const than = await findThan(packageNo, thanNo);
  if (!than || than.status === 'available') return null;
  const now = new Date().toISOString();
  await sheets.updateRange(SHEET, `H${than.rowIndex}:P${than.rowIndex}`, [[
    'available', than.warehouse, than.pricePerYard, than.dateReceived,
    '', '', than.netMtrs, than.netWeight, now,
  ]]);
  return { ...than, status: 'available', soldTo: '', soldDate: '', updatedAt: now };
}

async function markPackageAvailable(packageNo) {
  const thans = await findByPackage(packageNo);
  const sold = thans.filter((t) => t.status === 'sold');
  if (!sold.length) return [];
  const now = new Date().toISOString();
  const results = [];
  for (const than of sold) {
    await sheets.updateRange(SHEET, `H${than.rowIndex}:P${than.rowIndex}`, [[
      'available', than.warehouse, than.pricePerYard, than.dateReceived,
      '', '', than.netMtrs, than.netWeight, now,
    ]]);
    results.push({ ...than, status: 'available', soldTo: '', soldDate: '', updatedAt: now });
  }
  return results;
}

async function updatePrice(filters, newPrice) {
  const all = await getAll();
  const matches = all.filter((r) => {
    if (filters.packageNo && r.packageNo !== str(filters.packageNo)) return false;
    if (filters.design && upper(r.design) !== upper(filters.design)) return false;
    if (filters.shade && upper(r.shade) !== upper(filters.shade)) return false;
    return true;
  });
  const now = new Date().toISOString();
  let count = 0;
  for (const row of matches) {
    await sheets.updateRange(SHEET, `J${row.rowIndex}`, [[newPrice]]);
    await sheets.updateRange(SHEET, `P${row.rowIndex}`, [[now]]);
    count++;
  }
  return count;
}

async function transferThan(packageNo, thanNo, toWarehouse) {
  const than = await findThan(packageNo, thanNo);
  if (!than) return null;
  if (than.status !== 'available') return null;
  const now = new Date().toISOString();
  const fromWarehouse = than.warehouse;
  await sheets.updateRange(SHEET, `I${than.rowIndex}`, [[toWarehouse]]);
  await sheets.updateRange(SHEET, `P${than.rowIndex}`, [[now]]);
  return { ...than, warehouse: toWarehouse, fromWarehouse, updatedAt: now };
}

async function transferPackage(packageNo, toWarehouse) {
  const thans = await findByPackage(packageNo);
  const available = thans.filter((t) => t.status === 'available');
  if (!available.length) return [];
  const now = new Date().toISOString();
  const results = [];
  for (const than of available) {
    const fromWarehouse = than.warehouse;
    await sheets.updateRange(SHEET, `I${than.rowIndex}`, [[toWarehouse]]);
    await sheets.updateRange(SHEET, `P${than.rowIndex}`, [[now]]);
    results.push({ ...than, warehouse: toWarehouse, fromWarehouse, updatedAt: now });
  }
  return results;
}

async function getDistinctDesigns() {
  const all = await getAll();
  const map = new Map();
  all.forEach((r) => {
    const key = `${upper(r.design)}|${upper(r.shade)}`;
    if (!map.has(key)) map.set(key, { design: r.design, shade: r.shade });
  });
  return Array.from(map.values());
}

module.exports = {
  HEADERS,
  getAll,
  findByDesign,
  findByPackage,
  findAvailable,
  findThan,
  markThanSold,
  markPackageSold,
  markThanAvailable,
  markPackageAvailable,
  updatePrice,
  transferThan,
  transferPackage,
  appendThans,
  getWarehouses,
  getDistinctDesigns,
  ensureHeader,
  parseRow,
  toRow,
};
