'use strict';

/**
 * branchOpsLogRepository — sole owner of the BranchOpsLog sheet.
 *
 * Single umbrella sheet for the branch managers' daily routine.
 * Polymorphic via `kind`:
 *
 *   daily_open            — branch opened, contains opening cash
 *                            in `amount`. One per (branch,date).
 *   camera_check          — single yes/no with optional 1-line note
 *   opening_cash          — explicit cash count row (also captured
 *                            in `daily_open.amount`; kept for audit)
 *   expense               — single approved expense item (one row per
 *                            item; written by the post-approval branch)
 *   sample_issued         — pointer row (ref_id = sample_id)
 *   receipt_logged        — pointer row (ref_id = receipt_id)
 *   customer_registered   — pointer row (ref_id = customer_id or name)
 *   marketer_registered   — pointer row (ref_id = marketer_id)
 *   day_close             — V2 — closing cash + day summary
 *
 * Columns:
 *   op_id | date | branch | manager_id | manager_name
 * | kind | subject | amount | ref_id | photo_url
 * | status | approval_request_id | notes
 * | created_at | updated_at
 *
 * status: logged | pending_approval | approved | rejected
 *
 * Append-only. Status flips (pending_approval → approved/rejected) happen
 * via `updateStatusByApprovalRequestId` driven by the approval-events
 * handler. We never mutate `subject`, `amount`, `ref_id` after the
 * first write — corrections are a NEW row with a back-pointer in notes.
 */

const sheets = require('./sheetsClient');

const SHEET = 'BranchOpsLog';

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }

let _seq = 0;
function _opId() {
  _seq = (_seq + 1) % 10_000;
  return `BOP-${Date.now()}-${String(_seq).padStart(4, '0')}`;
}

function parse(r, rowIndex) {
  if (!r || !r[0]) return null;
  return {
    rowIndex,
    op_id:                str(r[0]),
    date:                 str(r[1]),
    branch:               str(r[2]),
    manager_id:           str(r[3]),
    manager_name:         str(r[4]),
    kind:                 str(r[5]),
    subject:              str(r[6]),
    amount:               num(r[7]),
    ref_id:               str(r[8]),
    photo_url:            str(r[9]),
    status:               str(r[10]) || 'logged',
    approval_request_id:  str(r[11]),
    notes:                str(r[12]),
    created_at:           str(r[13]),
    updated_at:           str(r[14]),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:O');
  return (rows || []).map((r, i) => parse(r, i + 2)).filter(Boolean);
}

async function findByDate(date) {
  const target = str(date);
  if (!target) return [];
  return (await getAll()).filter((r) => r.date === target);
}

async function findByBranchDate(branch, date) {
  const b = str(branch).toLowerCase();
  const d = str(date);
  if (!d) return [];
  return (await getAll()).filter(
    (r) => r.date === d && r.branch.toLowerCase() === b
  );
}

async function findByApprovalRequestId(requestId) {
  const id = str(requestId);
  if (!id) return [];
  return (await getAll()).filter((r) => r.approval_request_id === id);
}

/**
 * True if this branch already has a daily_open row for `date`. Used by
 * the Daily Open flow to render the "🟢 Already open" state instead
 * of re-running the routine.
 */
async function isDayOpen(branch, date) {
  const rows = await findByBranchDate(branch, date);
  return rows.some((r) => r.kind === 'daily_open');
}

/**
 * Pull the N most-recent expense titles entered by `manager_id` in the
 * last `days` days. Used by the Office Expense flow's quick-pick row.
 * De-duplicated, most-recent-first.
 */
async function getRecentExpenseTitles(managerId, { days = 30, limit = 8 } = {}) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);
  const all = await getAll();
  const mine = all
    .filter((r) => r.kind === 'expense'
      && r.manager_id === String(managerId)
      && r.date >= cutoff
      && r.subject)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const out = [];
  const seen = new Set();
  for (const r of mine) {
    const key = r.subject.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.subject);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Generic append. Caller is responsible for setting `kind`, `status`,
 * etc. — we just stamp op_id and timestamps.
 */
async function append(row) {
  const opId = row.op_id || _opId();
  const now = new Date().toISOString();
  const sheetRow = [
    opId,
    String(row.date || now.slice(0, 10)),
    String(row.branch || ''),
    String(row.manager_id || ''),
    String(row.manager_name || ''),
    String(row.kind || ''),
    String(row.subject || ''),
    row.amount === '' || row.amount == null ? '' : Number(row.amount) || 0,
    String(row.ref_id || ''),
    String(row.photo_url || ''),
    String(row.status || 'logged'),
    String(row.approval_request_id || ''),
    String(row.notes || ''),
    now, now,
  ];
  await sheets.appendRows(SHEET, [sheetRow]);
  return parse(sheetRow, -1) && { ...parse(sheetRow, -1), op_id: opId };
}

async function appendMany(rows) {
  if (!rows || !rows.length) return [];
  const now = new Date().toISOString();
  const out = [];
  const sheetRows = rows.map((row) => {
    const opId = row.op_id || _opId();
    const sheetRow = [
      opId,
      String(row.date || now.slice(0, 10)),
      String(row.branch || ''),
      String(row.manager_id || ''),
      String(row.manager_name || ''),
      String(row.kind || ''),
      String(row.subject || ''),
      row.amount === '' || row.amount == null ? '' : Number(row.amount) || 0,
      String(row.ref_id || ''),
      String(row.photo_url || ''),
      String(row.status || 'logged'),
      String(row.approval_request_id || ''),
      String(row.notes || ''),
      now, now,
    ];
    out.push({ ...parse(sheetRow, -1), op_id: opId });
    return sheetRow;
  });
  await sheets.appendRows(SHEET, sheetRows);
  return out;
}

/**
 * Flip the `status` cell on every row that points to this approval
 * request. Used by the approve/reject branches so all line items in
 * a batch update atomically (well, sequentially) from
 * `pending_approval` to `approved` | `rejected`.
 *
 * Column K (11th) is `status`. We re-read each row, do a single
 * targeted updateRange — keeps drift to a minimum without dragging in
 * a full row rewrite.
 */
async function updateStatusByApprovalRequestId(requestId, newStatus) {
  const rows = await findByApprovalRequestId(requestId);
  const now = new Date().toISOString();
  for (const r of rows) {
    // K = status, O = updated_at
    await sheets.updateRange(SHEET, `K${r.rowIndex}:K${r.rowIndex}`, [[String(newStatus)]]);
    await sheets.updateRange(SHEET, `O${r.rowIndex}:O${r.rowIndex}`, [[now]]);
  }
  return rows.length;
}

module.exports = {
  getAll,
  findByDate,
  findByBranchDate,
  findByApprovalRequestId,
  isDayOpen,
  getRecentExpenseTitles,
  append,
  appendMany,
  updateStatusByApprovalRequestId,
  SHEET,
};
