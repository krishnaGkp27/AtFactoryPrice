'use strict';

/**
 * src/services/branchOpsService.js — BR-OPS C1.
 *
 * Service layer for the branch managers' daily routine. Pure(-ish) —
 * the math + queue handoff parts are offline-testable. Telegram lives
 * in the flow files.
 *
 * Public API:
 *   resolveBranch(userId)                 → infer branch from Users.warehouses[0]
 *   openDay({ branch, manager, cash, camera }) → write daily_open + camera_check + opening_cash
 *   closeDay({ branch, manager, cash })        → V2 day_close (stub)
 *   submitExpenseBatch({ manager, items })     → queue ONE approval row carrying N items
 *   applyExpenseBatch({ aj, approvedBy })      → post-approval: append N expense rows
 *   cancelExpenseBatch({ requestId })          → post-reject: flip BranchOpsLog rows to rejected
 *   logPointer({ kind, manager, ref_id, ... }) → fire-and-forget hook for reused flows
 *   getDailySummary({ branch, date })          → roll-up for the manager's "today" card + weekly finance read
 *
 * Approval policy:
 *   record_office_expense ∈ WRITE_ACTIONS (single-admin sign-off — you for
 *   now). Flip to ALWAYS_APPROVAL_ACTIONS when finance joins.
 *
 * Branch resolution rule (Q1 default):
 *   Read user.warehouses[0]. If empty, fall back to user.manages, then
 *   to "HQ". Manager never has to pick.
 *
 * Pointer hooks (Q10 default):
 *   The 4 reused flows (give_sample, upload_receipt, add_customer,
 *   register_marketer) call logPointer after their own write. Pointer
 *   rows live with status='logged' — they were already approved by
 *   their own flow's policy and we don't re-gate them.
 */

const branchOpsLogRepository = require('../repositories/branchOpsLogRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const usersRepository = require('../repositories/usersRepository');
const idGenerator = require('../utils/idGenerator');
const riskEvaluate = require('../risk/evaluate');
const logger = require('../utils/logger');

const MAX_EXPENSE_AMOUNT = 5_000_000;       // ₦5M sanity ceiling per single line
const MAX_EXPENSE_TITLE_LEN = 80;
const MAX_EXPENSE_ITEMS = 20;               // per batch
const MAX_OPENING_CASH = 50_000_000;        // ₦50M sanity ceiling

function todayInTz(tz = 'Africa/Lagos') {
  // Mirrors attendanceService.todayInTz to keep "today" definition
  // consistent across morning routines.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

/**
 * Infer the branch name for the manager from their Users row.
 * Returns 'HQ' as the last-resort fallback so daily_open rows
 * never land with an empty branch (which would break roll-up
 * filtering by branch).
 */
async function resolveBranch(userId) {
  try {
    const u = await usersRepository.findByUserId(String(userId));
    if (!u) return 'HQ';
    if (Array.isArray(u.warehouses) && u.warehouses.length) return u.warehouses[0];
    const manages = (u.manages || '').toString().trim();
    if (manages) return manages.split(',')[0].trim();
    return 'HQ';
  } catch (e) {
    logger.warn(`resolveBranch(${userId}) failed: ${e.message} — defaulting to HQ`);
    return 'HQ';
  }
}

async function _resolveManager(userId) {
  let name = '';
  try {
    const u = await usersRepository.findByUserId(String(userId));
    name = u?.name || '';
  } catch (_) { /* ignore */ }
  return { id: String(userId), name };
}

/**
 * Idempotent: if a daily_open already exists for (branch, date) we
 * return that row instead of writing a duplicate. The morning card
 * uses this to re-render the "🟢 Already open" state on re-tap.
 */
async function openDay({ userId, cash, cameraOk, cameraNote }) {
  if (cash != null && (!isFinite(Number(cash)) || Number(cash) < 0 || Number(cash) > MAX_OPENING_CASH)) {
    const err = new Error(`Opening cash must be a non-negative number ≤ ${MAX_OPENING_CASH.toLocaleString()}.`);
    err.code = 'BOPS_BAD_CASH';
    throw err;
  }
  const branch = await resolveBranch(userId);
  const manager = await _resolveManager(userId);
  const date = todayInTz();
  const alreadyOpen = await branchOpsLogRepository.isDayOpen(branch, date);
  if (alreadyOpen) {
    const rows = await branchOpsLogRepository.findByBranchDate(branch, date);
    return {
      alreadyOpen: true,
      branch, date,
      manager,
      rows,
    };
  }
  const cashNum = cash == null ? '' : Number(cash);

  // 3 atomic rows in one batch — daily_open carries `amount` =
  // opening cash so a single read of `kind=daily_open` suffices for
  // the weekly finance roll-up. The other two rows are the
  // itemised audit trail.
  const batch = await branchOpsLogRepository.appendMany([
    {
      date, branch, manager_id: manager.id, manager_name: manager.name,
      kind: 'daily_open', subject: `Branch opened (${branch})`,
      amount: cashNum, status: 'logged',
    },
    {
      date, branch, manager_id: manager.id, manager_name: manager.name,
      kind: 'camera_check',
      subject: cameraOk ? 'Camera OK' : 'Camera issue',
      amount: '', status: 'logged',
      notes: cameraOk ? '' : (cameraNote || ''),
    },
    {
      date, branch, manager_id: manager.id, manager_name: manager.name,
      kind: 'opening_cash', subject: 'Opening cash count',
      amount: cashNum, status: 'logged',
    },
  ]);
  await auditLogRepository.append('branch_opened',
    { branch, date, manager: manager.name, cash: cashNum, cameraOk: !!cameraOk },
    manager.id);
  logger.info(`branchOps.openDay: ${branch} opened by ${manager.name || manager.id} date=${date} cash=${cashNum} cameraOk=${!!cameraOk}`);
  return { alreadyOpen: false, branch, date, manager, rows: batch };
}

/**
 * Validate a list of expense items. Returns sanitised copy or throws.
 * Pure — used by both submitExpenseBatch and smoke tests.
 */
function validateExpenseItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('Add at least one expense item.');
    err.code = 'BOPS_NO_ITEMS';
    throw err;
  }
  if (items.length > MAX_EXPENSE_ITEMS) {
    const err = new Error(`Too many items in one batch (max ${MAX_EXPENSE_ITEMS}).`);
    err.code = 'BOPS_TOO_MANY_ITEMS';
    throw err;
  }
  return items.map((it, i) => {
    const title = String(it.title || '').trim().slice(0, MAX_EXPENSE_TITLE_LEN);
    const amount = Number(it.amount);
    if (!title) {
      const err = new Error(`Item #${i + 1}: title is empty.`);
      err.code = 'BOPS_BAD_TITLE';
      throw err;
    }
    if (!isFinite(amount) || amount <= 0 || amount > MAX_EXPENSE_AMOUNT) {
      const err = new Error(`Item #${i + 1} ("${title}"): amount must be > 0 and ≤ ${MAX_EXPENSE_AMOUNT.toLocaleString()}.`);
      err.code = 'BOPS_BAD_AMOUNT';
      throw err;
    }
    return { title, amount: +amount.toFixed(2) };
  });
}

/**
 * Queue the expense batch for single-admin approval and stamp pending
 * rows on BranchOpsLog so the manager sees them in their "today" card
 * immediately (with a status=pending_approval pill).
 */
async function submitExpenseBatch({ userId, items }) {
  const cleaned = validateExpenseItems(items);
  const total = +cleaned.reduce((s, it) => s + it.amount, 0).toFixed(2);
  const branch = await resolveBranch(userId);
  const manager = await _resolveManager(userId);
  const date = todayInTz();
  const requestId = idGenerator.requestId();
  const aj = {
    action: 'record_office_expense',
    branch, manager_id: manager.id, manager_name: manager.name, date,
    items: cleaned, total_amount: total,
  };
  const risk = await riskEvaluate.evaluate({ action: 'record_office_expense', userId });
  await approvalQueueRepository.append({
    requestId, user: String(userId), actionJSON: aj,
    riskReason: risk.reason || 'admin_approval_required', status: 'pending',
  });
  // Eager pending rows so the manager's "Today" lens reflects what's in flight.
  await branchOpsLogRepository.appendMany(cleaned.map((it) => ({
    date, branch, manager_id: manager.id, manager_name: manager.name,
    kind: 'expense', subject: it.title, amount: it.amount,
    status: 'pending_approval', approval_request_id: requestId,
  })));
  await auditLogRepository.append('approval_queued',
    { requestId, action: 'record_office_expense', branch, total, count: cleaned.length }, manager.id);
  logger.info(`branchOps.submitExpenseBatch: ${branch} ${cleaned.length} items total=₦${total} request=${requestId} by=${manager.id}`);
  return { requestId, branch, manager, total, items: cleaned };
}

/**
 * Post-approval write — flip the pending rows to approved. Idempotent:
 * if the rows were already approved (e.g. retry), the second update is
 * a no-op cell rewrite.
 */
async function applyExpenseBatch({ aj, approvedBy, requestId }) {
  if (!aj || aj.action !== 'record_office_expense') {
    return { ok: false, message: 'Not an office-expense action.' };
  }
  const updated = await branchOpsLogRepository.updateStatusByApprovalRequestId(requestId, 'approved');
  if (updated === 0) {
    // Rows didn't get the eager write (shouldn't happen, but be safe).
    // Fall through to a re-append so the data isn't lost.
    await branchOpsLogRepository.appendMany((aj.items || []).map((it) => ({
      date: aj.date, branch: aj.branch,
      manager_id: aj.manager_id, manager_name: aj.manager_name,
      kind: 'expense', subject: it.title, amount: it.amount,
      status: 'approved', approval_request_id: requestId,
      notes: 'late-write (eager rows missing)',
    })));
  }
  await auditLogRepository.append('office_expense_approved',
    { requestId, branch: aj.branch, total: aj.total_amount, count: (aj.items || []).length, approvedBy },
    String(approvedBy || 'system'));
  return { ok: true, branch: aj.branch, total: aj.total_amount, count: (aj.items || []).length };
}

/**
 * Post-reject — flip the pending rows to rejected (audit-preserving).
 * The manager can re-submit as a new batch.
 */
async function cancelExpenseBatch({ requestId, rejectedBy }) {
  const count = await branchOpsLogRepository.updateStatusByApprovalRequestId(requestId, 'rejected');
  await auditLogRepository.append('office_expense_rejected',
    { requestId, count }, String(rejectedBy || 'system'));
  return { count };
}

/**
 * Lightweight pointer write. Called by reused flows AFTER their own
 * write to existing sheets (Samples / Receipts / Customers / Marketers).
 * Failure is swallowed — the underlying business action already
 * succeeded; we don't want a roll-up logging blip to surface as a
 * user error.
 */
async function logPointer({ kind, userId, ref_id, subject, amount, photo_url, notes }) {
  try {
    const branch = await resolveBranch(userId);
    const manager = await _resolveManager(userId);
    await branchOpsLogRepository.append({
      date: todayInTz(),
      branch,
      manager_id: manager.id, manager_name: manager.name,
      kind, subject: subject || '',
      amount: amount == null ? '' : amount,
      ref_id: String(ref_id || ''),
      photo_url: photo_url || '',
      notes: notes || '',
      status: 'logged',
    });
  } catch (e) {
    logger.warn(`branchOps.logPointer(${kind}, ${userId}): ${e.message} — swallowed`);
  }
}

/**
 * Roll-up for the manager's "Today" card and the weekly finance read.
 * Tallies opening cash + approved/pending expenses + counts of
 * pointer rows (samples, receipts, customers, marketers).
 */
async function getDailySummary({ branch, date }) {
  const d = date || todayInTz();
  const rows = await branchOpsLogRepository.findByBranchDate(branch, d);

  const dailyOpen = rows.find((r) => r.kind === 'daily_open') || null;
  const cameraCheck = rows.find((r) => r.kind === 'camera_check') || null;

  const expensesApproved = rows.filter((r) => r.kind === 'expense' && r.status === 'approved');
  const expensesPending  = rows.filter((r) => r.kind === 'expense' && r.status === 'pending_approval');
  const expensesRejected = rows.filter((r) => r.kind === 'expense' && r.status === 'rejected');

  const total = (list) => list.reduce((s, r) => s + (r.amount || 0), 0);

  return {
    branch, date: d,
    isOpen: !!dailyOpen,
    openingCash: dailyOpen ? (dailyOpen.amount || 0) : 0,
    camera: cameraCheck ? { ok: cameraCheck.subject === 'Camera OK', notes: cameraCheck.notes } : null,
    expenses: {
      approved: { count: expensesApproved.length, total: +total(expensesApproved).toFixed(2), items: expensesApproved },
      pending:  { count: expensesPending.length,  total: +total(expensesPending).toFixed(2),  items: expensesPending  },
      rejected: { count: expensesRejected.length, total: +total(expensesRejected).toFixed(2), items: expensesRejected },
    },
    pointers: {
      samples_issued:     rows.filter((r) => r.kind === 'sample_issued').length,
      receipts_logged:    rows.filter((r) => r.kind === 'receipt_logged').length,
      customers_added:    rows.filter((r) => r.kind === 'customer_registered').length,
      marketers_added:    rows.filter((r) => r.kind === 'marketer_registered').length,
    },
    rowCount: rows.length,
  };
}

module.exports = {
  resolveBranch,
  openDay,
  submitExpenseBatch,
  applyExpenseBatch,
  cancelExpenseBatch,
  logPointer,
  getDailySummary,
  validateExpenseItems,
  todayInTz,
  // tunable constants — exposed for smoke
  MAX_EXPENSE_AMOUNT,
  MAX_EXPENSE_TITLE_LEN,
  MAX_EXPENSE_ITEMS,
  MAX_OPENING_CASH,
};
