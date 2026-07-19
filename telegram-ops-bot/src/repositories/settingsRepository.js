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
  // APR-1 — hours between pending-approval reminder cards (0 disables).
  // Covers approvals queued outside the bot process too (Drive imports).
  APPROVAL_REMINDER_HOURS: 6,
  // MORN-1 — 09:15 admin morning digest (owner, 17-Jul-2026). Time is
  // HH:MM Nigeria local; category toggles editable in-bot (⏰ Morning
  // Digest tile). Launch state: customer notes ON, everything else OFF.
  DIGEST_ENABLED: 1,
  DIGEST_TIME: '10:00',
  DIGEST_TIMEZONE: 'Africa/Lagos',
  DIGEST_NOTES_DAYS: 7,
  DIGEST_CUSTOMER_NOTES: 1,
  DIGEST_FOLLOWUPS: 0,
  DIGEST_APPROVALS: 0,
  DIGEST_TASKS: 0,
  DIGEST_SAMPLES: 0,
  DIGEST_ORDERS: 0,
  // ATT-C3 (owner 19-Jul): attendance section ON from day one — the 10:00
  // digest is the after-deadline "who is missing" check.
  DIGEST_ATTENDANCE: 1,
  // ATT-C3 master switch for the 09:00 employee nudge DM.
  ATTENDANCE_REMINDER_ENABLED: 1,
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

// P6 — Settings is consulted on nearly every action (risk thresholds,
// display toggles, cleanup grace…) yet only changes when a human edits
// the sheet. 30s TTL; set() invalidates so in-bot changes apply at once,
// manual sheet edits show within 30s (same trade-off as the Users cache).
const CACHE_TTL_MS = 30 * 1000;
let _cache = null;
let _cacheTs = 0;

function invalidateCache() {
  _cache = null;
  _cacheTs = 0;
}

async function getAll() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return { ..._cache };
  try {
    const rows = await sheets.readRange(SHEET, 'A2:C');
    const map = { ...DEFAULTS };
    rows.forEach((r) => {
      const k = (r[0] || '').toString().trim();
      const v = (r[1] || '').toString().trim();
      if (k) map[k] = isNaN(Number(v)) ? v : Number(v);
    });
    _cache = map;
    _cacheTs = Date.now();
    return { ...map };
  } catch (e) {
    // Errors are NOT cached — next caller retries the sheet.
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
  invalidateCache();
  return { key, value: isNaN(Number(value)) ? value : Number(value), updatedAt };
}

module.exports = { getAll, set, invalidateCache, ensureHeader, DEFAULTS };
