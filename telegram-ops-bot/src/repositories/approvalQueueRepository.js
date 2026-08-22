/**
 * Data access for ApprovalQueue sheet.
 * Columns: RequestID | User | ActionJSON | RiskReason | Status | CreatedAt | ResolvedAt
 */

const sheets = require('./sheetsClient');
const mutex = require('../utils/asyncMutex');

const SHEET = 'ApprovalQueue';
const HEADERS = ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt'];

let _headerReady = false;

async function ensureHeader() {
  // Bootstrapping the header only matters once per process — schemaMapper
  // already creates every sheet + header at startup. Without this guard each
  // append/write paid an extra read (and, where ensureHeader also calls
  // getSheetNames, a whole-spreadsheet metadata call) first.
  if (_headerReady) return;
  const rows = await sheets.readRange(SHEET, 'A1:G1');
  if (!rows.length || rows[0].length < 7) {
    await sheets.updateRange(SHEET, 'A1:G1', [HEADERS]);
  }
  _headerReady = true;
}

async function append(record) {
  await ensureHeader();
  const row = [
    record.requestId ?? '',
    record.user ?? '',
    typeof record.actionJSON === 'string' ? record.actionJSON : JSON.stringify(record.actionJSON || {}),
    record.riskReason ?? '',
    record.status ?? 'pending',
    record.createdAt || new Date().toISOString(),
    record.resolvedAt ?? '',
  ];
  await sheets.appendRows(SHEET, [row]);
  // ANL-2 — approval_queued is the completions signal for every wizard that
  // queues, and ~25 producers reach this seam (flows, services, controller):
  // tracking anywhere else misses most of them. Lazy require: repositories
  // must not eagerly pull the service layer.
  try {
    const aj = typeof record.actionJSON === 'string'
      ? JSON.parse(record.actionJSON || '{}') : (record.actionJSON || {});
    require('../services/usageTracker').track({
      userId: record.user, surface: 'approval', feature: aj.action || 'other',
      event: 'approval_queued', requestId: record.requestId,
    });
  } catch (_) { /* analytics never breaks a queue write */ }
  return record;
}

async function getAllPending() {
  const rows = await sheets.readRange(SHEET, 'A2:G');
  return rows
    .filter((r) => (r[4] || '').toString().toLowerCase() === 'pending')
    .map((r) => ({
      requestId: r[0],
      user: r[1],
      actionJSON: safeParse(r[2]),
      riskReason: r[3],
      status: r[4],
      createdAt: r[5],
      resolvedAt: r[6],
    }));
}

async function updateStatus(requestId, status, resolvedAt) {
  const rows = await sheets.readRange(SHEET, 'A2:G');
  const idx = rows.findIndex((r) => String(r[0]) === String(requestId));
  if (idx === -1) return false;
  const rowIndex = idx + 2;
  const createdAt = rows[idx][5] || '';
  await sheets.updateRange(SHEET, `E${rowIndex}:G${rowIndex}`, [[status, createdAt, resolvedAt || new Date().toISOString()]]);
  return true;
}

/** RPT-2 — resolved (non-pending) rows, for the Supplies browser. */
async function getResolved() {
  const rows = await sheets.readRange(SHEET, 'A2:G');
  return rows
    .filter((r) => (r[4] || '').toString().toLowerCase() !== 'pending')
    .map((r) => ({
      requestId: r[0], user: r[1], actionJSON: safeParse(r[2]),
      riskReason: r[3], status: r[4], createdAt: r[5], resolvedAt: r[6],
    }));
}

/**
 * SUB-1 — append exactly once per requestId.
 *
 * `append` is a blind write, and it has ~40 callers — every submit door in
 * the bot. When a door mints its request id at CONFIRM-RENDER time and
 * routes through here, a re-entered submit (album burst, double tap, retry
 * after a timeout) collapses into the row that already exists instead of
 * becoming a second pending request with its own admin card.
 *
 * Serialised per requestId on the existing asyncMutex, so two concurrent
 * calls with the same id cannot both pass the existence check: the second
 * waits, then sees the first's row. Sheets has no unique constraint — this
 * mutex plus the read-before-write IS the constraint, and it holds because
 * the bot is a single process (the same assumption every approval action
 * already rests on).
 *
 * @returns {Promise<{created:boolean, existing:object|null}>}
 */
async function appendOnce(record) {
  const requestId = String(record.requestId || '');
  if (!requestId) { await append(record); return { created: true, existing: null }; }
  return mutex.runExclusive(`apq-append:${requestId}`, async () => {
    const existing = await getByRequestId(requestId);
    if (existing) return { created: false, existing };
    await append(record);
    return { created: true, existing: null };
  });
}

/** Get one approval queue row by requestId (any status). */
async function getByRequestId(requestId) {
  const rows = await sheets.readRange(SHEET, 'A2:G');
  const r = rows.find((row) => String(row[0]) === String(requestId));
  if (!r) return null;
  return {
    requestId: r[0],
    user: r[1],
    actionJSON: safeParse(r[2]),
    riskReason: r[3],
    status: r[4],
    createdAt: r[5],
    resolvedAt: r[6],
  };
}

/** TRID-1 — every row WITH its absolute sheet row number (repair tooling).
 *  While duplicate requestIds exist, all id-keyed updates are ambiguous —
 *  repairs must address the physical row. */
async function getAllWithRowIndex() {
  const rows = await sheets.readRange(SHEET, 'A2:G');
  return rows.map((r, i) => ({
    rowIndex: i + 2,
    requestId: r[0], user: r[1], actionJSON: safeParse(r[2]),
    riskReason: r[3], status: r[4], createdAt: r[5], resolvedAt: r[6],
  }));
}

/**
 * TRID-1 — rewrite column A (RequestID) of ONE specific row. Guarded
 * compare-and-set: refuses when the cell no longer holds `expectedOldId`
 * (row moved / concurrent write), so the repair can never rename the
 * wrong row.
 * @param {number} rowIndex absolute sheet row (2-based data rows)
 * @param {string} expectedOldId
 * @param {string} newId
 * @returns {Promise<boolean>} true when the cell was rewritten
 */
async function renameRequestIdAtRow(rowIndex, expectedOldId, newId) {
  const cell = await sheets.readRange(SHEET, `A${rowIndex}:A${rowIndex}`);
  const current = cell && cell[0] ? String(cell[0][0] || '') : '';
  if (current !== String(expectedOldId)) return false;
  await sheets.updateRange(SHEET, `A${rowIndex}`, [[String(newId)]]);
  return true;
}

function safeParse(str) {
  try {
    return JSON.parse(str || '{}');
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the row's actionJSON and persist. Used by the
 * multi-stage supply-request flow to record stage transitions
 * (confirmedByDispatch, dispatchDecline, etc.) without bloating the
 * sheet schema. Returns true if the row was found and updated.
 *
 * @param {string} requestId
 * @param {object} patch
 * @returns {Promise<boolean>}
 */
async function updateActionJSON(requestId, patch) {
  const rows = await sheets.readRange(SHEET, 'A2:G');
  const idx = rows.findIndex((r) => String(r[0]) === String(requestId));
  if (idx === -1) return false;
  const rowIndex = idx + 2;
  const existing = safeParse(rows[idx][2]);
  const merged = { ...existing, ...patch };
  await sheets.updateRange(SHEET, `C${rowIndex}`, [[JSON.stringify(merged)]]);
  return true;
}

module.exports = {
  append, appendOnce, getAllPending, getResolved, updateStatus, updateActionJSON, getByRequestId,
  getAllWithRowIndex, renameRequestIdAtRow, ensureHeader,
};
