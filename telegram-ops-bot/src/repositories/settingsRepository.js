/**
 * Data access for Settings sheet (key-value for risk thresholds, etc.).
 * Columns: Key | Value | UpdatedAt
 * Used by Admin page and Risk Engine.
 */

const sheets = require('./sheetsClient');

const SHEET = 'Settings';
const HEADERS = ['Key', 'Value', 'UpdatedAt'];

const DEFAULTS = {
  RISK_THRESHOLD: 300,
  LOW_STOCK_THRESHOLD: 100,
  // TV-1 — CSV of warehouse names whose stock listings show than counts
  // instead of bale counts. Override via a Settings sheet row of the same
  // key; an empty value disables the behavior everywhere.
  THAN_VISIBILITY_WAREHOUSES: 'Kano office',
  // SJ-1 — stale-flow janitor grace periods (minutes from last activity
  // before an abandoned flow's hanging message is tombstoned). Generous
  // defaults because field connectivity is inconsistent; tune via
  // Settings sheet rows of the same keys, no deploy needed.
  FLOW_CLEANUP_MINUTES: 30,
  FLOW_CLEANUP_MINUTES_HEAVY: 60,
  FLOW_CLEANUP_HEAVY_TYPES: 'supply_req_flow,grn_flow,bulk_receive_flow,photo_receive_flow,bundle_sale_flow,order_flow,receipt_flow,landed_cost_flow,po_new_flow',
  // BKP-1 — automated daily snapshot of the master sheet into the backup
  // Drive folder. Hour is UTC (1 = 02:00 Lagos); copies older than the
  // retention window are trashed (recoverable for 30 more days).
  // BKP-1c (10-Jul-2026) — DISABLED by owner request: the service account
  // has no Drive storage, so the job can only fail and DM admins daily.
  // Re-enable by adding a Settings sheet row SHEET_BACKUP_ENABLED=1 (no
  // deploy needed) once the Apps Script backup (checklist Task 1) — or a
  // storage-capable upload path — is in place.
  SHEET_BACKUP_ENABLED: 0,
  SHEET_BACKUP_HOUR_UTC: 1,
  SHEET_BACKUP_RETENTION_DAYS: 14,
};

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:C1');
  if (!rows.length || rows[0].length < 3) {
    await sheets.updateRange(SHEET, 'A1:C1', [HEADERS]);
  }
}

async function getAll() {
  try {
    const rows = await sheets.readRange(SHEET, 'A2:C');
    const map = { ...DEFAULTS };
    rows.forEach((r) => {
      const k = (r[0] || '').toString().trim();
      const v = (r[1] || '').toString().trim();
      if (k) map[k] = isNaN(Number(v)) ? v : Number(v);
    });
    return map;
  } catch (e) {
    return { ...DEFAULTS };
  }
}

async function set(key, value) {
  await ensureHeader();
  const rows = await sheets.readRange(SHEET, 'A2:C');
  const idx = rows.findIndex((r) => (r[0] || '').toString().trim() === key);
  const updatedAt = new Date().toISOString();
  const valueStr = String(value);
  if (idx >= 0) {
    const rowIndex = idx + 2;
    await sheets.updateRange(SHEET, `B${rowIndex}:C${rowIndex}`, [[valueStr, updatedAt]]);
  } else {
    await sheets.appendRows(SHEET, [[key, valueStr, updatedAt]]);
  }
  return { key, value: isNaN(Number(value)) ? value : Number(value), updatedAt };
}

module.exports = { getAll, set, ensureHeader, DEFAULTS };
