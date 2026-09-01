/**
 * Data access for ApprovalQueue sheet.
 * Columns: RequestID | User | ActionJSON | RiskReason | Status | CreatedAt | ResolvedAt | Approver
 *
 * APR-1 (owner, 01-Sep-2026) — column H `Approver` records WHO released the
 * request, readably, in the sheet itself. Before it, the decider survived
 * only inside the opaque ActionJSON blob or in AuditLog, and AuditLog is on
 * its way to Postgres; on several paths it was recorded nowhere at all.
 *
 * Two things this column is deliberately NOT:
 *   • it is not "whoever flipped the Status cell". A transfer is flipped to
 *     approved by the destination RECEIVER and a supply request by the
 *     assigned DISPATCH hand — naming either as the approver would
 *     manufacture a false audit trail on exactly the rows that matter most.
 *     `approverStamp.labelFor()` resolves the real approver per action.
 *   • it is not a gate. Nothing reads it back to decide anything; approval
 *     policy stays entirely in risk/evaluate.js.
 */

const sheets = require('./sheetsClient');
const mutex = require('../utils/asyncMutex');

const SHEET = 'ApprovalQueue';
const HEADERS = ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'];

let _headerReady = false;

async function ensureHeader() {
  // Bootstrapping the header only matters once per process — schemaMapper
  // already creates every sheet + header at startup. Without this guard each
  // append/write paid an extra read (and, where ensureHeader also calls
  // getSheetNames, a whole-spreadsheet metadata call) first.
  if (_headerReady) return;
  // APR-1 — both bounds are derived from HEADERS, never literals: the live
  // sheet already had 7 columns, so a hardcoded `< 7` would have found the
  // header "complete" and left the new column permanently unnamed (the
  // unlabelled-column drift the 14-Aug sheet audit found on AuditLog).
  const lastCol = String.fromCharCode('A'.charCodeAt(0) + HEADERS.length - 1);
  const rows = await sheets.readRange(SHEET, `A1:${lastCol}1`);
  if (!rows.length || rows[0].length < HEADERS.length) {
    await sheets.updateRange(SHEET, `A1:${lastCol}1`, [HEADERS]);
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
  const rows = await sheets.readRange(SHEET, 'A2:H');
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
      approver: r[7] || '',
    }));
}

/**
 * Resolve a request: Status (E), ResolvedAt (G) and, when known, the
 * Approver (H).
 *
 * The write is two disjoint ranges rather than one E:H span so CreatedAt (F)
 * is never touched. The old code spanned E:G and had to re-read F and write
 * it back — a round-trip that reads a FORMATTED value and writes it back as
 * USER_ENTERED, quietly rewriting the cell's type. Not copying that forward.
 *
 * @param {string} requestId
 * @param {string} status 'approved' | 'rejected'
 * @param {string} [resolvedAt] ISO instant
 * @param {string} [approver] already-resolved display label — see
 *   `approverStamp.labelFor()`. Omitted leaves H untouched, never blanked.
 */
async function updateStatus(requestId, status, resolvedAt, approver) {
  const rows = await sheets.readRange(SHEET, 'A2:H');
  const idx = rows.findIndex((r) => String(r[0]) === String(requestId));
  if (idx === -1) return false;
  const rowIndex = idx + 2;
  const updates = [{ range: `E${rowIndex}`, values: [[status]] }];
  const stamp = resolvedAt || new Date().toISOString();
  if (approver) {
    updates.push({ range: `G${rowIndex}:H${rowIndex}`, values: [[stamp, String(approver)]] });
  } else {
    updates.push({ range: `G${rowIndex}`, values: [[stamp]] });
  }
  await sheets.batchUpdateRanges(SHEET, updates);
  return true;
}

/** RPT-2 — resolved (non-pending) rows, for the Supplies browser. */
async function getResolved() {
  const rows = await sheets.readRange(SHEET, 'A2:H');
  return rows
    .filter((r) => (r[4] || '').toString().toLowerCase() !== 'pending')
    .map((r) => ({
      requestId: r[0], user: r[1], actionJSON: safeParse(r[2]),
      riskReason: r[3], status: r[4], createdAt: r[5], resolvedAt: r[6], approver: r[7] || '',
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
  const rows = await sheets.readRange(SHEET, 'A2:H');
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
    approver: r[7] || '',
  };
}

/** TRID-1 — every row WITH its absolute sheet row number (repair tooling).
 *  While duplicate requestIds exist, all id-keyed updates are ambiguous —
 *  repairs must address the physical row. */
async function getAllWithRowIndex() {
  const rows = await sheets.readRange(SHEET, 'A2:H');
  return rows.map((r, i) => ({
    rowIndex: i + 2,
    requestId: r[0], user: r[1], actionJSON: safeParse(r[2]),
    riskReason: r[3], status: r[4], createdAt: r[5], resolvedAt: r[6], approver: r[7] || '',
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
  const rows = await sheets.readRange(SHEET, 'A2:H');
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
