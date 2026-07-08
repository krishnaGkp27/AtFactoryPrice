'use strict';

/**
 * PG-1 — mirror Inventory sheet rows into Postgres + parity checks.
 *
 * PG-1 scope: WRITE mirror only. inventoryRepository.getAll() still reads
 * Sheets. Sync runs on boot (when enabled) and on a timer. Parity compares
 * row counts + available-bale counts per warehouse + distinct design counts.
 */

const postgresPool = require('../db/postgresPool');
const { DDL_STATEMENTS } = require('../db/inventorySchema');
const inventoryRepository = require('../repositories/inventoryRepository');
const logger = require('../utils/logger');

const META_LAST_SYNC = 'inventory_last_sync_at';
const META_LAST_PARITY = 'inventory_last_parity_ok';
const META_ROW_COUNT = 'inventory_mirror_row_count';

/** Map a parsed Inventory row object to Postgres bind values. */
function rowToParams(r) {
  return [
    r.rowIndex,
    r.packageNo || '',
    r.indent || '',
    r.csNo || '',
    r.design || '',
    r.shade || '',
    r.thanNo || 0,
    r.yards || 0,
    (r.status || 'available').toLowerCase(),
    r.warehouse || '',
    r.pricePerYard || 0,
    r.dateReceived || '',
    r.soldTo || '',
    r.soldDate || '',
    r.netMtrs || 0,
    r.netWeight || 0,
    r.updatedAt || '',
    r.productType || 'fabric',
    r.baleUid || '',
    r.addedAt || '',
    r.grnId || '',
    r.binLocation || '',
    r.arrivalBatch || '',
    r.designCategory || '',
  ];
}

const UPSERT_SQL = `
INSERT INTO inventory_rows (
  sheet_row_index, package_no, indent, cs_no, design, shade, than_no, yards, status,
  warehouse, price_per_yard, date_received, sold_to, sold_date, net_mtrs, net_weight,
  updated_at, product_type, bale_uid, added_at, grn_id, bin_location, arrival_batch,
  design_category, synced_at
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24, NOW()
)
ON CONFLICT (sheet_row_index) DO UPDATE SET
  package_no = EXCLUDED.package_no,
  indent = EXCLUDED.indent,
  cs_no = EXCLUDED.cs_no,
  design = EXCLUDED.design,
  shade = EXCLUDED.shade,
  than_no = EXCLUDED.than_no,
  yards = EXCLUDED.yards,
  status = EXCLUDED.status,
  warehouse = EXCLUDED.warehouse,
  price_per_yard = EXCLUDED.price_per_yard,
  date_received = EXCLUDED.date_received,
  sold_to = EXCLUDED.sold_to,
  sold_date = EXCLUDED.sold_date,
  net_mtrs = EXCLUDED.net_mtrs,
  net_weight = EXCLUDED.net_weight,
  updated_at = EXCLUDED.updated_at,
  product_type = EXCLUDED.product_type,
  bale_uid = EXCLUDED.bale_uid,
  added_at = EXCLUDED.added_at,
  grn_id = EXCLUDED.grn_id,
  bin_location = EXCLUDED.bin_location,
  arrival_batch = EXCLUDED.arrival_batch,
  design_category = EXCLUDED.design_category,
  synced_at = NOW()
`;

async function ensureSchema() {
  if (!postgresPool.isEnabled()) return { ok: false, reason: 'postgres_disabled' };
  for (const ddl of DDL_STATEMENTS) {
    await postgresPool.query(ddl);
  }
  return { ok: true };
}

async function setMeta(key, value) {
  await postgresPool.query(
    `INSERT INTO mirror_meta (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value)],
  );
}

/**
 * Compute parity metrics from a row array (sheet or postgres-shaped).
 * @param {Array<object>} rows Parsed inventory rows.
 * @returns {{ total: number, availableBales: number, designs: number, byWarehouse: Map<string, number> }}
 */
function computeMetrics(rows) {
  const byWarehouse = new Map();
  const bales = new Set();
  const designs = new Set();
  for (const r of rows) {
    if (!r.packageNo && !r.design) continue;
    if (String(r.status || '').toLowerCase() === 'available' && r.packageNo) {
      bales.add(`${r.warehouse || ''}||${r.packageNo}`);
      const wh = r.warehouse || '(none)';
      byWarehouse.set(wh, (byWarehouse.get(wh) || 0) + 1);
    }
    if (r.design) designs.add(String(r.design).toUpperCase());
  }
  return {
    total: rows.filter((r) => r.packageNo || r.design).length,
    availableBales: bales.size,
    designs: designs.size,
    byWarehouse,
  };
}

/** Map a postgres inventory_rows record to parseRow-like shape for metrics. */
function pgRowToMetricShape(row) {
  return {
    packageNo: row.package_no,
    design: row.design,
    status: row.status,
    warehouse: row.warehouse,
  };
}

/**
 * Compare sheet metrics vs postgres metrics. Returns mismatches array.
 * @param {object} sheetMetrics From computeMetrics(sheetRows).
 * @param {object} pgMetrics From computeMetrics(pgRows).
 * @returns {string[]} Human-readable mismatch lines (empty = parity OK).
 */
function diffMetrics(sheetMetrics, pgMetrics) {
  const mismatches = [];
  if (sheetMetrics.total !== pgMetrics.total) {
    mismatches.push(`row count: sheet=${sheetMetrics.total} pg=${pgMetrics.total}`);
  }
  if (sheetMetrics.availableBales !== pgMetrics.availableBales) {
    mismatches.push(`available bales: sheet=${sheetMetrics.availableBales} pg=${pgMetrics.availableBales}`);
  }
  if (sheetMetrics.designs !== pgMetrics.designs) {
    mismatches.push(`distinct designs: sheet=${sheetMetrics.designs} pg=${pgMetrics.designs}`);
  }
  const whKeys = new Set([...sheetMetrics.byWarehouse.keys(), ...pgMetrics.byWarehouse.keys()]);
  for (const wh of whKeys) {
    const s = sheetMetrics.byWarehouse.get(wh) || 0;
    const p = pgMetrics.byWarehouse.get(wh) || 0;
    if (s !== p) mismatches.push(`available thans @ ${wh}: sheet=${s} pg=${p}`);
  }
  return mismatches;
}

/**
 * Full sync: read Inventory from Sheets, upsert every row, prune deleted
 * sheet rows from the mirror, then run parity.
 * @returns {Promise<{ ok: boolean, synced: number, parityOk: boolean, mismatches: string[] }>}
 */
async function syncFromSheets() {
  if (!postgresPool.isEnabled()) {
    return { ok: false, reason: 'postgres_disabled', synced: 0, parityOk: false, mismatches: ['DATABASE_URL not set'] };
  }
  await ensureSchema();
  inventoryRepository.invalidateCache();
  const sheetRows = await inventoryRepository.getAll();
  const sheetIds = new Set();

  for (const r of sheetRows) {
    sheetIds.add(r.rowIndex);
    await postgresPool.query(UPSERT_SQL, rowToParams(r));
  }

  // Drop mirror rows whose sheet row was deleted.
  const existing = await postgresPool.query('SELECT sheet_row_index FROM inventory_rows');
  const stale = (existing.rows || []).filter((row) => !sheetIds.has(row.sheet_row_index));
  for (const row of stale) {
    await postgresPool.query('DELETE FROM inventory_rows WHERE sheet_row_index = $1', [row.sheet_row_index]);
  }

  const parity = await runParityCheck(sheetRows);
  await setMeta(META_LAST_SYNC, new Date().toISOString());
  await setMeta(META_ROW_COUNT, String(sheetRows.length));
  await setMeta(META_LAST_PARITY, parity.ok ? '1' : '0');

  logger.info(`inventoryMirror: synced ${sheetRows.length} rows, parity=${parity.ok ? 'OK' : 'FAIL'}`);
  if (!parity.ok) {
    logger.warn(`inventoryMirror parity mismatches: ${parity.mismatches.join('; ')}`);
  }

  return {
    ok: true,
    synced: sheetRows.length,
    pruned: stale.length,
    parityOk: parity.ok,
    mismatches: parity.mismatches,
  };
}

/**
 * Parity check without re-syncing. Pass pre-fetched sheet rows when called
 * from syncFromSheets to avoid a double read.
 */
async function runParityCheck(sheetRows = null) {
  if (!postgresPool.isEnabled()) {
    return { ok: false, mismatches: ['DATABASE_URL not set'] };
  }
  const rows = sheetRows || await inventoryRepository.getAll();
  const pgRes = await postgresPool.query('SELECT * FROM inventory_rows');
  const pgRows = (pgRes.rows || []).map(pgRowToMetricShape);
  const sheetMetrics = computeMetrics(rows);
  const pgMetrics = computeMetrics(pgRows);
  const mismatches = diffMetrics(sheetMetrics, pgMetrics);
  return { ok: mismatches.length === 0, mismatches, sheetMetrics, pgMetrics };
}

let _timer = null;

/** Start periodic mirror sync (no-op when disabled). */
function start() {
  const config = require('../config');
  if (!postgresPool.isEnabled() || !config.postgres.mirrorEnabled) return;
  const intervalMs = config.postgres.mirrorIntervalMs;
  const tick = () => {
    syncFromSheets().catch((e) => logger.error(`inventoryMirror tick failed: ${e.message}`));
  };
  // Boot sync + interval.
  tick();
  _timer = setInterval(tick, intervalMs);
  _timer.unref?.();
  logger.info(`inventoryMirror: scheduler started (every ${Math.round(intervalMs / 1000)}s)`);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = {
  ensureSchema,
  syncFromSheets,
  runParityCheck,
  start,
  stop,
  _internals: { computeMetrics, diffMetrics, rowToParams, pgRowToMetricShape },
};
