/**
 * Data access for Inventory sheet — Package/Than model.
 *
 * Columns A-Q (legacy): PackageNo | Indent | CSNo | Design | Shade | ThanNo | Yards | Status |
 *                       Warehouse | PricePerYard | DateReceived | SoldTo | SoldDate | NetMtrs | NetWeight | UpdatedAt | ProductType
 * Columns R-T (P1 — composite key foundation):
 *   R = bale_uid   internal-only unambiguous ID; format BAL-YYYYMMDD-{pkg}-{rand4}.
 *                  PackageNo (column A) is the human-printed bale number and may
 *                  legitimately repeat over time as new physical bales arrive.
 *                  bale_uid is the FK target for ProcurementOrders, transfers,
 *                  sales and audit trail.
 *   S = addedAt    server-generated ISO timestamp at row creation (distinct
 *                  from DateReceived, which is the supplier-stated date).
 *   T = grn_id     foreign key to GoodsReceipts header (optional; empty for
 *                  legacy rows and for non-GRN intake paths).
 *
 * Legacy rows (created before P1) get synthetic bale_uid='BAL-LEGACY-{rowIndex}'
 * and addedAt=DateReceived||'' injected at read time. They are persisted on
 * next mutation (transfer / sale / price update) or via backfillLegacyBales().
 */

const sheets = require('./sheetsClient');
const idGenerator = require('../utils/idGenerator');

const SHEET = 'Inventory';
const COL_COUNT = 21;
const HEADERS = [
  'PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status',
  'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id',
  // BUNDLE-SALE C1 — optional shelf / bin reference rendered next to the
  // bale header in the bundle picker. Empty for rows that don't track it.
  'bin_location',
];

/** Short-lived cache for getAll() to avoid hammering the API during batch ops. */
let _allCache = null;
let _allCacheTs = 0;
const CACHE_TTL_MS = 5000;

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }
function upper(v) { return str(v).toUpperCase(); }

function parseRow(r, rowIndex) {
  const rawUid = str(r[17]);
  const rawAddedAt = str(r[18]);
  const isLegacy = !rawUid;
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
    productType: str(r[16]) || 'fabric',
    baleUid: rawUid || `BAL-LEGACY-${rowIndex}`,
    addedAt: rawAddedAt || str(r[10]) || '',
    grnId: str(r[19]),
    binLocation: str(r[20]),
    _legacy: isLegacy,
  };
}

function toRow(o) {
  return [
    o.packageNo ?? '', o.indent ?? '', o.csNo ?? '', o.design ?? '', o.shade ?? '',
    o.thanNo ?? '', o.yards ?? 0, o.status ?? 'available',
    o.warehouse ?? '', o.pricePerYard ?? 0, o.dateReceived ?? '',
    o.soldTo ?? '', o.soldDate ?? '', o.netMtrs ?? '', o.netWeight ?? '',
    o.updatedAt ?? '', o.productType ?? 'fabric',
    o.baleUid ?? '', o.addedAt ?? '', o.grnId ?? '', o.binLocation ?? '',
  ];
}

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:U1');
  if (!rows.length || rows[0].length < COL_COUNT) {
    await sheets.updateRange(SHEET, 'A1:U1', [HEADERS]);
  }
}

async function getAll() {
  const now = Date.now();
  if (_allCache && (now - _allCacheTs) < CACHE_TTL_MS) return _allCache;
  const rows = await sheets.readRange(SHEET, 'A2:U');
  _allCache = rows.map((r, i) => parseRow(r, i + 2)).filter((r) => r.packageNo || r.design);
  _allCacheTs = Date.now();
  return _allCache;
}

function invalidateCache() {
  _allCache = null;
  _allCacheTs = 0;
}

async function findByDesign(design, shade) {
  const all = await getAll();
  const d = upper(design);
  const s = shade ? upper(shade) : null;
  return all.filter((r) => upper(r.design) === d && (!s || upper(r.shade) === s));
}

/**
 * Find all Inventory rows matching a human-printed PackageNo.
 *
 * Because PackageNo may legitimately repeat across intake dates, this returns
 * every matching row (newest addedAt first). Pass `{ latestOnly: true }` to
 * collapse to the most recently-added instance.
 *
 * @param {string|number} packageNo
 * @param {{ latestOnly?: boolean, includeSold?: boolean }} [opts]
 */
async function findByPackage(packageNo, opts = {}) {
  const all = await getAll();
  const p = str(packageNo);
  let rows = all.filter((r) => r.packageNo === p);
  if (opts.includeSold === false) {
    rows = rows.filter((r) => r.status !== 'sold');
  }
  rows.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  if (opts.latestOnly) return rows.length ? [rows[0]] : [];
  return rows;
}

async function findByBaleUid(baleUid) {
  const all = await getAll();
  return all.find((r) => r.baleUid === str(baleUid)) || null;
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

async function markThanSold(packageNo, thanNo, customer, soldDateOverride) {
  const than = await findThan(packageNo, thanNo);
  if (!than) return null;
  const now = new Date().toISOString();
  const soldDate = soldDateOverride || new Date().toISOString().split('T')[0];
  await sheets.updateRange(SHEET, `H${than.rowIndex}:P${than.rowIndex}`, [[
    'sold', than.warehouse, than.pricePerYard, than.dateReceived,
    customer || '', soldDate, than.netMtrs, than.netWeight, now,
  ]]);
  invalidateCache();
  return { ...than, status: 'sold', soldTo: customer, soldDate, updatedAt: now };
}

async function markPackageSold(packageNo, customer, soldDateOverride) {
  const thans = await findByPackage(packageNo);
  const available = thans.filter((t) => t.status === 'available');
  if (!available.length) return [];
  const now = new Date().toISOString();
  const soldDate = soldDateOverride || new Date().toISOString().split('T')[0];
  const updates = available.map((than) => ({
    range: `H${than.rowIndex}:P${than.rowIndex}`,
    values: [['sold', than.warehouse, than.pricePerYard, than.dateReceived, customer || '', soldDate, than.netMtrs, than.netWeight, now]],
  }));
  await sheets.batchUpdateRanges(SHEET, updates);
  invalidateCache();
  return available.map((than) => ({ ...than, status: 'sold', soldTo: customer, soldDate, updatedAt: now }));
}

async function appendThans(thanRows) {
  await ensureHeader();
  const rows = thanRows.map(toRow);
  await sheets.appendRows(SHEET, rows);
  invalidateCache();
  return thanRows.length;
}

/**
 * Append one or more bales with server-generated bale_uid + addedAt.
 *
 * Each input bale may omit `baleUid` and `addedAt`; they will be generated
 * here. If a bale provides them explicitly (e.g. lazy back-fill writes), they
 * are preserved as-is.
 *
 * `grnId` is optional and links the bale to a GoodsReceipts header.
 *
 * Returns the bale objects with their generated ids attached. Cache is
 * invalidated atomically.
 *
 * @param {Array<object>} bales
 * @returns {Promise<Array<object>>}
 */
async function appendBale(bales) {
  if (!Array.isArray(bales) || !bales.length) return [];
  await ensureHeader();
  const nowIso = new Date().toISOString();
  const prepared = bales.map((b) => {
    const baleUid = b.baleUid || idGenerator.baleUid(b.packageNo);
    const addedAt = b.addedAt || nowIso;
    return {
      ...b,
      status: b.status || 'available',
      productType: b.productType || 'fabric',
      updatedAt: b.updatedAt || nowIso,
      baleUid,
      addedAt,
      grnId: b.grnId || '',
    };
  });
  const rows = prepared.map(toRow);
  await sheets.appendRows(SHEET, rows);
  invalidateCache();
  return prepared;
}

/**
 * Back-fill legacy Inventory rows (those without bale_uid in column R) with
 * generated bale_uid + addedAt values. Safe to run repeatedly — only touches
 * rows where column R is empty. Returns the count of rows back-filled.
 *
 * Trade-off: this is opt-in (not run automatically on every read) because the
 * back-fill takes one batch-update API call. In typical operation the legacy
 * row count is small (< 1000) and a single run during a maintenance window
 * suffices.
 */
async function backfillLegacyBales() {
  // BUNDLE-SALE C1 — read range bumped to A2:U for bin_location, but the
  // back-fill itself only writes to R:S (bale_uid + addedAt), so the
  // extra column is harmless if absent.
  const rows = await sheets.readRange(SHEET, 'A2:U');
  const updates = [];
  let count = 0;
  rows.forEach((r, i) => {
    const rowIndex = i + 2;
    const packageNo = str(r[0]);
    if (!packageNo) return;
    const hasUid = str(r[17]);
    if (hasUid) return;
    const dateReceived = str(r[10]);
    const synthUid = `BAL-LEGACY-${rowIndex}-${(packageNo || 'X').toString().slice(0, 8)}`;
    const synthAddedAt = dateReceived || '1970-01-01T00:00:00.000Z';
    updates.push({ range: `R${rowIndex}:S${rowIndex}`, values: [[synthUid, synthAddedAt]] });
    count += 1;
  });
  if (updates.length) {
    await sheets.batchUpdateRanges(SHEET, updates);
    invalidateCache();
  }
  return count;
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
  invalidateCache();
  return { ...than, status: 'available', soldTo: '', soldDate: '', updatedAt: now };
}

async function markPackageAvailable(packageNo) {
  const thans = await findByPackage(packageNo);
  const sold = thans.filter((t) => t.status === 'sold');
  if (!sold.length) return [];
  const now = new Date().toISOString();
  const updates = sold.map((than) => ({
    range: `H${than.rowIndex}:P${than.rowIndex}`,
    values: [['available', than.warehouse, than.pricePerYard, than.dateReceived, '', '', than.netMtrs, than.netWeight, now]],
  }));
  await sheets.batchUpdateRanges(SHEET, updates);
  invalidateCache();
  return sold.map((than) => ({ ...than, status: 'available', soldTo: '', soldDate: '', updatedAt: now }));
}

async function updatePrice(filters, newPrice) {
  const all = await getAll();
  const matches = all.filter((r) => {
    if (filters.packageNo && r.packageNo !== str(filters.packageNo)) return false;
    if (filters.design && upper(r.design) !== upper(filters.design)) return false;
    if (filters.shade && upper(r.shade) !== upper(filters.shade)) return false;
    if (filters.warehouse && upper(r.warehouse) !== upper(filters.warehouse)) return false;
    return true;
  });
  if (!matches.length) return 0;
  const now = new Date().toISOString();
  const updates = [];
  for (const row of matches) {
    updates.push({ range: `J${row.rowIndex}`, values: [[newPrice]] });
    updates.push({ range: `P${row.rowIndex}`, values: [[now]] });
  }
  await sheets.batchUpdateRanges(SHEET, updates);
  invalidateCache();
  return matches.length;
}

async function transferThan(packageNo, thanNo, toWarehouse) {
  const than = await findThan(packageNo, thanNo);
  if (!than) return null;
  if (than.status !== 'available') return null;
  const now = new Date().toISOString();
  const fromWarehouse = than.warehouse;
  await sheets.batchUpdateRanges(SHEET, [
    { range: `I${than.rowIndex}`, values: [[toWarehouse]] },
    { range: `P${than.rowIndex}`, values: [[now]] },
  ]);
  invalidateCache();
  return { ...than, warehouse: toWarehouse, fromWarehouse, updatedAt: now };
}

async function transferPackage(packageNo, toWarehouse) {
  const thans = await findByPackage(packageNo);
  const available = thans.filter((t) => t.status === 'available');
  if (!available.length) return [];
  const now = new Date().toISOString();
  const updates = [];
  for (const than of available) {
    updates.push({ range: `I${than.rowIndex}`, values: [[toWarehouse]] });
    updates.push({ range: `P${than.rowIndex}`, values: [[now]] });
  }
  await sheets.batchUpdateRanges(SHEET, updates);
  invalidateCache();
  return available.map((than) => ({ ...than, warehouse: toWarehouse, fromWarehouse: than.warehouse, updatedAt: now }));
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

/**
 * BUNDLE-SALE C1 — build a 2-level grouping of AVAILABLE thans for a given
 * design+warehouse, suitable for the Kano bundle picker.
 *
 *   designKey         (UPPER design)
 *     └─ shades       (UPPER shade)
 *          ├─ summary { thanCount, yards, baleCount }
 *          └─ bales[] { packageNo, baleUid, binLocation, ageDays, thans[] }
 *
 * Rules:
 *   – Only rows with status='available'.
 *   – Warehouse filter is case-insensitive; null/empty includes all.
 *   – Shade dictionary lookup happens in the flow (this helper stays pure).
 *   – Empty / blank shades are bucketed as '(no-shade)'.
 */
async function groupByBaleAndShade(design, warehouse = null) {
  const all = await getAll();
  const d = upper(design);
  const w = warehouse ? upper(warehouse) : null;
  const matches = all.filter((r) =>
    r.status === 'available' &&
    upper(r.design) === d &&
    (!w || upper(r.warehouse) === w)
  );
  const byShade = new Map();
  const nowMs = Date.now();
  for (const t of matches) {
    const shadeKey = upper(t.shade) || '(NO-SHADE)';
    if (!byShade.has(shadeKey)) {
      byShade.set(shadeKey, {
        shade: t.shade || '',
        shadeKey,
        summary: { thanCount: 0, yards: 0, baleCount: 0 },
        balesByUid: new Map(),
      });
    }
    const bucket = byShade.get(shadeKey);
    bucket.summary.thanCount += 1;
    bucket.summary.yards += t.yards || 0;
    const baleKey = t.baleUid || `pkg:${t.packageNo}`;
    if (!bucket.balesByUid.has(baleKey)) {
      const addedMs = Date.parse(t.addedAt || t.dateReceived || '');
      const ageDays = isFinite(addedMs) ? Math.max(0, Math.round((nowMs - addedMs) / 86400000)) : null;
      bucket.balesByUid.set(baleKey, {
        baleUid: t.baleUid,
        packageNo: t.packageNo,
        binLocation: t.binLocation || '',
        addedAt: t.addedAt || '',
        ageDays,
        thans: [],
      });
      bucket.summary.baleCount += 1;
    }
    bucket.balesByUid.get(baleKey).thans.push({
      rowIndex: t.rowIndex,
      thanNo: t.thanNo,
      yards: t.yards,
      packageNo: t.packageNo,
      baleUid: t.baleUid,
      shade: t.shade,
    });
  }
  // Flatten bales map to array, sort by oldest-first (FIFO) so the picker
  // can render "Take ALL" against the bale that's been sitting longest.
  const shades = Array.from(byShade.values()).map((b) => ({
    shade: b.shade,
    shadeKey: b.shadeKey,
    summary: b.summary,
    bales: Array.from(b.balesByUid.values())
      .sort((a, b2) => {
        const ax = Date.parse(a.addedAt || '') || 0;
        const bx = Date.parse(b2.addedAt || '') || 0;
        return ax - bx;
      })
      .map((bale) => ({ ...bale, thans: bale.thans.sort((x, y) => (x.thanNo || 0) - (y.thanNo || 0)) })),
  }));
  shades.sort((a, b2) => b2.summary.yards - a.summary.yards);
  return { design, designKey: d, warehouse: warehouse || '', shades };
}

module.exports = {
  HEADERS,
  getAll,
  findByDesign,
  findByPackage,
  findByBaleUid,
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
  appendBale,
  backfillLegacyBales,
  getWarehouses,
  getDistinctDesigns,
  groupByBaleAndShade,
  ensureHeader,
  parseRow,
  toRow,
  invalidateCache,
};
