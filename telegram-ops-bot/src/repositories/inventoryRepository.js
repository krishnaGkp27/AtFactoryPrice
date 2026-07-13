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
const { normalizeSalesDate } = require('../utils/dates');

const SHEET = 'Inventory';
const COL_COUNT = 23;
const HEADERS = [
  'PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status',
  'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id',
  // BUNDLE-SALE C1 — optional shelf / bin reference rendered next to the
  // bale header in the bundle picker. Empty for rows that don't track it.
  'bin_location',
  // ARRIVAL-BATCH C1 — operator-facing shipment/arrival label (e.g. "Mar26",
  // "July26") chosen at intake. Drives the "Select Container" step in the
  // Supply Request + Bundle Sale pickers. Distinct from the productTypes
  // "container" label (which means the packaging unit — bale/box). Empty
  // rows are treated as unlabelled until backfilled.
  'arrival_batch',
  // DCAT-1 — product-category label for the row's DESIGN (Cashmere / Chinos /
  // Gaberdine / Senator / TR / …). Owner chose an Inventory column over a
  // separate mapping sheet. Category is a per-DESIGN fact: the dual-admin
  // "Set Design Category" flow stamps every row of the design, and readers
  // (designCategoriesRepository) take the first non-empty cell per design so
  // later-received unstamped rows still inherit the label on screens.
  'design_category',
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
    arrivalBatch: str(r[21]),
    designCategory: str(r[22]),
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
    o.arrivalBatch ?? '', o.designCategory ?? '',
  ];
}

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:W1');
  if (!rows.length || rows[0].length < COL_COUNT) {
    await sheets.updateRange(SHEET, 'A1:W1', [HEADERS]);
  }
}

async function getAll() {
  const now = Date.now();
  if (_allCache && (now - _allCacheTs) < CACHE_TTL_MS) return _allCache;
  const rows = await sheets.readRange(SHEET, 'A2:W');
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
 * All sold than-rows that carry a buyer + sale date — the source of truth
 * for sold-history drill-downs (Sold Bales Lookup). Each row retains
 * design/shade/packageNo/baleUid/thanNo/yards/pricePerYard/soldTo/soldDate,
 * so callers can group by customer -> date -> bale without touching
 * Transactions (which only stores aggregated totals).
 *
 * @returns {Promise<Array<object>>} parsed Inventory rows with status 'sold'.
 */
async function getSoldRows() {
  const all = await getAll();
  return all.filter((r) => r.status === 'sold' && r.soldTo && r.soldDate);
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
  // SEC-P2 (C5): never overwrite a than that is not currently available.
  // markPackageSold already filters on 'available'; markThanSold did not, so a
  // second approved sell (or a sale racing a transfer/return) could re-flip an
  // already-sold than and re-emit a sale — double-selling one physical than.
  // Returning null here lets every caller treat it as "no longer available".
  if (than.status !== 'available') return null;
  const now = new Date().toISOString();
  // SDN-1: bottom-of-write normalisation. Whatever shape the caller passed
  // (natural-language string, picker ISO, AI-parsed text), the sheet always
  // gets ISO YYYY-MM-DD so queryEngine lexical comparison stays correct.
  const soldDate = normalizeSalesDate(soldDateOverride) || new Date().toISOString().split('T')[0];
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
  // SDN-1: see markThanSold note above.
  const soldDate = normalizeSalesDate(soldDateOverride) || new Date().toISOString().split('T')[0];
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
  // BUNDLE-SALE C1 — read range bumped to A2:V (bin_location + arrival_batch),
  // but the back-fill itself only writes to R:S (bale_uid + addedAt), so the
  // extra columns are harmless if absent.
  const rows = await sheets.readRange(SHEET, 'A2:V');
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

/**
 * One-time backfill of the arrival_batch column (V). Stamps `label` onto
 * every row whose arrival_batch cell is currently empty — both available
 * and already-sold rows — so existing stock is "wrapped" into a named
 * container (e.g. "Mar26"). Idempotent: rows that already carry a label are
 * left untouched, so re-running never clobbers later uploads.
 *
 * @param {string} label  the batch label to stamp (e.g. "Mar26").
 * @param {{dryRun?: boolean}} [opts] when dryRun is true, computes the count
 *        of rows that WOULD change without writing anything.
 * @returns {Promise<{matched:number, written:number}>}
 */
async function backfillArrivalBatch(label, opts = {}) {
  const value = str(label);
  if (!value) throw new Error('inventoryRepository.backfillArrivalBatch: label required');
  const dryRun = !!opts.dryRun;
  const rows = await sheets.readRange(SHEET, 'A2:V');
  const updates = [];
  rows.forEach((r, i) => {
    const rowIndex = i + 2;
    const packageNo = str(r[0]);
    const design = str(r[3]);
    if (!packageNo && !design) return; // skip blank spacer rows
    if (str(r[21])) return;            // already labelled — leave as-is
    updates.push({ range: `V${rowIndex}:V${rowIndex}`, values: [[value]] });
  });
  if (!dryRun && updates.length) {
    await sheets.batchUpdateRanges(SHEET, updates);
    invalidateCache();
  }
  return { matched: updates.length, written: dryRun ? 0 : updates.length };
}

async function getWarehouses() {
  const all = await getAll();
  const set = new Set();
  all.forEach((r) => { if (r.warehouse) set.add(r.warehouse); });
  return Array.from(set).sort();
}

/**
 * ARRIVAL-BATCH C1 — distinct arrival_batch labels that currently have
 * AVAILABLE stock, with a bale + than count per label. Powers the "Select
 * Container" step. Rows with an empty arrival_batch are bucketed under a
 * synthetic '(unlabelled)' key so nothing is silently hidden pre-backfill.
 *
 * @param {{warehouse?: string, warehouses?: string[]}} [opts] optional
 *        case-insensitive warehouse scope. Pass a single `warehouse` or an
 *        array of `warehouses`; empty/absent includes every warehouse.
 * @returns {Promise<Array<{batch:string, label:string, bales:number, thans:number}>>}
 *          sorted by than count desc, then label asc.
 */
const UNLABELLED_BATCH = '(unlabelled)';
async function getArrivalBatches(opts = {}) {
  const all = await getAll();
  const scope = new Set();
  if (opts && opts.warehouse) scope.add(upper(opts.warehouse));
  if (opts && Array.isArray(opts.warehouses)) {
    for (const w of opts.warehouses) { if (w) scope.add(upper(w)); }
  }
  const byBatch = new Map();
  for (const r of all) {
    if (r.status !== 'available') continue;
    if (scope.size && !scope.has(upper(r.warehouse))) continue;
    const label = str(r.arrivalBatch);
    const key = label || UNLABELLED_BATCH;
    if (!byBatch.has(key)) byBatch.set(key, { batch: key, label: label || UNLABELLED_BATCH, bales: new Set(), thans: 0, yards: 0, value: 0 });
    const e = byBatch.get(key);
    e.thans += 1;
    // CV-1 — per-container totals for the owner's value display: yards is
    // safe for everyone; `value` (selling price × yards) is rendered by
    // ADMIN-gated callers only (PRICE-VIS). Zero-priced rows contribute 0
    // until Update Price runs.
    e.yards += r.yards || 0;
    e.value += (r.pricePerYard || 0) * (r.yards || 0);
    // A physical bale is identified by its printed PackageNo (column A). Each
    // Inventory row is one than and carries a per-row bale_uid, so counting
    // bale_uid would count thans; count distinct PackageNo instead. Fall back
    // to bale_uid only when a row has no PackageNo, so blanks stay distinct.
    e.bales.add(String(r.packageNo).trim() || r.baleUid);
  }
  return Array.from(byBatch.values())
    .map((e) => ({ batch: e.batch, label: e.label, bales: e.bales.size, thans: e.thans, yards: e.yards, value: e.value }))
    .sort((a, b) => b.thans - a.thans || a.label.localeCompare(b.label));
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

/**
 * DCAT-1 — stamp a product-category label onto EVERY row of a design
 * (column W), sold and available alike, so the sheet reads consistently.
 * Same batch-write pattern as updatePrice. Case-insensitive design match.
 *
 * @param {string} design Design number.
 * @param {string} category Category label (already canonicalized by caller).
 * @returns {Promise<number>} Count of rows stamped.
 */
async function updateDesignCategory(design, category) {
  const d = upper(design);
  if (!d) throw new Error('inventoryRepository.updateDesignCategory: design required');
  const all = await getAll();
  const matches = all.filter((r) => upper(r.design) === d);
  if (!matches.length) return 0;
  const updates = [];
  for (const row of matches) {
    updates.push({ range: `W${row.rowIndex}`, values: [[str(category)]] });
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
 * TRF-1 — transition a set of bales (by packageNo) from one status to another,
 * optionally rewriting their warehouse. Used by the staged warehouse-transfer
 * flow: available→in_transit (dispatch) and in_transit→available (receive /
 * revert). Only rows whose current status === fromStatus are touched.
 * @returns {Promise<Array>} the rows that were updated
 */
async function transitionBales(packageNos, fromStatus, toStatus, toWarehouse = null) {
  const set = new Set((packageNos || []).map((p) => String(p)));
  if (!set.size) return [];
  const all = await getAll();
  const rows = all.filter((r) => set.has(String(r.packageNo)) && r.status === fromStatus);
  if (!rows.length) return [];
  const now = new Date().toISOString();
  const updates = [];
  for (const r of rows) {
    updates.push({ range: `H${r.rowIndex}`, values: [[toStatus]] });
    if (toWarehouse != null) updates.push({ range: `I${r.rowIndex}`, values: [[toWarehouse]] });
    updates.push({ range: `P${r.rowIndex}`, values: [[now]] });
  }
  await sheets.batchUpdateRanges(SHEET, updates);
  invalidateCache();
  return rows.map((r) => ({ ...r, status: toStatus, warehouse: toWarehouse != null ? toWarehouse : r.warehouse, updatedAt: now }));
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
 *   – Optional arrivalBatch filter (case-insensitive exact); null/empty
 *     includes all containers.
 *   – Shade dictionary lookup happens in the flow (this helper stays pure).
 *   – Empty / blank shades are bucketed as '(no-shade)'.
 *
 * @param {string} design
 * @param {string|null} [warehouse]
 * @param {{arrivalBatch?: string}} [opts]
 */
async function groupByBaleAndShade(design, warehouse = null, opts = {}) {
  const all = await getAll();
  const d = upper(design);
  const w = warehouse ? upper(warehouse) : null;
  const ab = opts && opts.arrivalBatch ? upper(opts.arrivalBatch) : null;
  const matches = all.filter((r) =>
    r.status === 'available' &&
    upper(r.design) === d &&
    (!w || upper(r.warehouse) === w) &&
    (!ab || upper(r.arrivalBatch) === ab)
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
  getSoldRows,
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
  updateDesignCategory,
  transferThan,
  transferPackage,
  transitionBales,
  appendThans,
  appendBale,
  backfillLegacyBales,
  backfillArrivalBatch,
  getWarehouses,
  getArrivalBatches,
  UNLABELLED_BATCH,
  getDistinctDesigns,
  groupByBaleAndShade,
  ensureHeader,
  parseRow,
  toRow,
  invalidateCache,
};
