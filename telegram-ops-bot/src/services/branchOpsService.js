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
const { LAGOS_TZ } = require('../utils/dates');

const MAX_EXPENSE_AMOUNT = 5_000_000;       // ₦5M sanity ceiling per single line
const MAX_EXPENSE_TITLE_LEN = 80;
const MAX_EXPENSE_ITEMS = 20;               // per batch
const MAX_OPENING_CASH = 50_000_000;        // ₦50M sanity ceiling

// BR-OPS C1 — adaptive Office-Expense quick-pick.
// Seed titles give a brand-new manager tappable chips on day one; as the
// manager logs their own expenses, time-decayed frequency promotes their
// real titles into the grid and rarely-tapped seeds fall away. Titles are
// stored verbatim in BranchOpsLog.subject — no new column, no redundancy.
const SEED_EXPENSE_TITLES = [
  'Fuel',
  'Transportation',
  'Office Supplies',
  'Water / Refreshment',
  'Repairs / Maintenance',
  'Generator / Diesel',
];
const TITLE_DECAY_HALF_LIFE_DAYS = 30;  // a use loses half its weight every 30 days
const TITLE_HISTORY_WINDOW_DAYS = 90;   // ignore expenses older than this
const MAX_QUICK_PICK_TITLES = 10;       // chips shown in the picker grid
const SEED_BASE_SCORE = 0.25;           // floor score so seeds always rank above nothing
const DAY_MS = 24 * 3600 * 1000;

function todayInTz(tz = LAGOS_TZ) {
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
    // Prefer the explicit branch field (set during onboarding). Fall back to
    // the legacy guess (warehouses[0] → manages → HQ) only when it's blank,
    // so pre-existing rows keep working unchanged.
    if (u.branch && String(u.branch).trim()) return String(u.branch).trim();
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

/* ── EXP-1 (owner-confirmed layout, 08-Aug-2026) ─────────────────────────
 *
 * The daily office record extends the BR-OPS expense batch with three new
 * OUTFLOW kinds riding the same approval batch, plus two record-only rows:
 *
 *   person_allowance — subject = person's name, ref_id = their user_id
 *   commission       — subject = the remark (who/what)
 *   cash_in          — money handed to the office (record-only, immediate)
 *   zero_day         — explicit "nothing spent today" marker (record-only)
 *
 * Sheet rows stay CONCISE (owner): one row per item, subject short, no
 * prose — every derived figure (per-person totals, running balance) is
 * computed at read time, never persisted (BUSINESS_RULES 5b).
 *
 * Running cash balance = Σ cash_in − Σ outflows (non-rejected), whole
 * history per branch. Auditable and anchor-free: the float is seeded by
 * recording the current cash-in-hand once as the first ➕ Cash received.
 * Pending rows COUNT as spent — the cash left the drawer when it was
 * spent, not when the admin signed the book.
 */
const EXPENSE_OUTFLOW_KINDS = ['expense', 'person_allowance', 'commission'];

/**
 * Validate a list of expense items. Returns sanitised copy or throws.
 * Pure — used by both submitExpenseBatch and smoke tests.
 * EXP-1: items may carry a kind (default 'expense') and a ref_id
 * (person_allowance → the person's user_id).
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
    // EXP-1 — item kinds; anything unknown is refused, not coerced.
    const kind = String(it.kind || 'expense').trim();
    if (!EXPENSE_OUTFLOW_KINDS.includes(kind)) {
      const err = new Error(`Item #${i + 1} ("${title}"): unknown kind '${kind}'.`);
      err.code = 'BOPS_BAD_KIND';
      throw err;
    }
    return { kind, title, amount: +amount.toFixed(2), ref_id: String(it.ref_id || '') };
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
  // EXP-1 — each row keeps its own kind; subject stays the concise title.
  await branchOpsLogRepository.appendMany(cleaned.map((it) => ({
    date, branch, manager_id: manager.id, manager_name: manager.name,
    kind: it.kind || 'expense', subject: it.title, amount: it.amount,
    ref_id: it.ref_id || '',
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
      kind: it.kind || 'expense', subject: it.title, amount: it.amount,
      ref_id: it.ref_id || '',
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
 * Pure adaptive ranking of expense titles for the quick-pick grid.
 *
 * Each past use of a title contributes 0.5 ^ (ageDays / halfLifeDays) to
 * that title's score, so frequent + recent titles rank highest and stale
 * ones fade. Seed titles are guaranteed a baseline score so they always
 * appear for a manager with little/no history, but a genuinely-used title
 * outranks an untouched seed. Titles are grouped case-insensitively; the
 * most-recent casing + amount are surfaced (last amount feeds the
 * one-tap suggestion on the amount step).
 *
 * @param {Array<{title: string, amount: number, date: string}>} history
 * @param {{now?: number, seed?: string[], halfLifeDays?: number,
 *          windowDays?: number, maxTitles?: number, seedBase?: number}} [opts]
 * @returns {Array<{title: string, lastAmount: number|null, score: number}>}
 */
function rankExpenseTitles(history, opts = {}) {
  const now = opts.now == null ? Date.now() : opts.now;
  const seed = opts.seed || SEED_EXPENSE_TITLES;
  const halfLifeDays = opts.halfLifeDays || TITLE_DECAY_HALF_LIFE_DAYS;
  const windowDays = opts.windowDays || TITLE_HISTORY_WINDOW_DAYS;
  const maxTitles = opts.maxTitles || MAX_QUICK_PICK_TITLES;
  const seedBase = opts.seedBase == null ? SEED_BASE_SCORE : opts.seedBase;

  const byKey = new Map(); // lowerTitle -> { title, score, lastAmount, lastTs }
  for (const row of (history || [])) {
    const title = String(row.title || '').trim();
    if (!title) continue;
    const ts = new Date(`${row.date}T00:00:00Z`).getTime();
    if (!isFinite(ts)) continue;
    const ageDays = (now - ts) / DAY_MS;
    if (ageDays > windowDays) continue;
    const weight = Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
    const key = title.toLowerCase();
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { title, score: weight, lastAmount: row.amount == null ? null : Number(row.amount), lastTs: ts });
    } else {
      prev.score += weight;
      if (ts >= prev.lastTs) {
        prev.lastTs = ts;
        prev.title = title;
        prev.lastAmount = row.amount == null ? null : Number(row.amount);
      }
    }
  }

  // Guarantee seed titles a baseline score so they always have a chip.
  for (const s of seed) {
    const key = String(s).toLowerCase();
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { title: s, score: seedBase, lastAmount: null, lastTs: 0 });
    else if (prev.score < seedBase) prev.score = seedBase;
  }

  return Array.from(byKey.values())
    .sort((a, b) => (b.score - a.score) || (b.lastTs - a.lastTs) || a.title.localeCompare(b.title))
    .slice(0, maxTitles)
    .map((e) => ({ title: e.title, lastAmount: e.lastAmount, score: +e.score.toFixed(4) }));
}

/**
 * Resolve the adaptive quick-pick titles (each with its last-used amount)
 * for a manager's Office Expense picker. Reads the manager's own expense
 * history and blends it with the seed list via rankExpenseTitles. Falls
 * back to seeds-only if the history read fails.
 *
 * @param {string} userId
 * @param {{now?: number}} [opts]
 * @returns {Promise<Array<{title: string, lastAmount: number|null}>>}
 */
async function getExpenseQuickPicks(userId, opts = {}) {
  let history = [];
  try {
    history = await branchOpsLogRepository.getExpenseHistory(String(userId), { days: TITLE_HISTORY_WINDOW_DAYS });
  } catch (e) {
    logger.warn(`branchOps.getExpenseQuickPicks(${userId}): ${e.message} — seeds only`);
  }
  return rankExpenseTitles(history, { now: opts.now || Date.now() })
    .map((e) => ({ title: e.title, lastAmount: e.lastAmount }));
}

/**
 * EXP-1 — record money handed to the office. Record-only (the giver is
 * the owner/admin side; the evening report shows it the same day), writes
 * one concise row and returns the new running balance.
 */
async function recordCashIn({ userId, amount, source }) {
  const v = Number(amount);
  if (!isFinite(v) || v <= 0 || v > MAX_OPENING_CASH) {
    const err = new Error(`Cash amount must be > 0 and ≤ ₦${MAX_OPENING_CASH.toLocaleString()}.`);
    err.code = 'BOPS_BAD_CASH';
    throw err;
  }
  const branch = await resolveBranch(userId);
  const manager = await _resolveManager(userId);
  await branchOpsLogRepository.append({
    date: todayInTz(), branch, manager_id: manager.id, manager_name: manager.name,
    kind: 'cash_in', subject: String(source || 'Cash received').trim().slice(0, MAX_EXPENSE_TITLE_LEN),
    amount: +v.toFixed(2), status: 'logged',
  });
  await auditLogRepository.append('office_cash_in', { branch, amount: +v.toFixed(2) }, manager.id);
  const balance = await getCashBalance({ branch });
  return { branch, amount: +v.toFixed(2), balance };
}

/**
 * EXP-1 — explicit "nothing spent today" marker, so a missing day and a
 * zero day are never confused (§2 — the bot never guesses). Refused when
 * the day already has outflow rows: the marker would contradict them.
 */
async function recordZeroDay({ userId }) {
  const branch = await resolveBranch(userId);
  const manager = await _resolveManager(userId);
  const date = todayInTz();
  const rows = await branchOpsLogRepository.findByBranchDate(branch, date);
  if (rows.some((r) => EXPENSE_OUTFLOW_KINDS.includes(r.kind) && r.status !== 'rejected')) {
    const err = new Error('Expenses are already recorded today — a zero-day marker would contradict them.');
    err.code = 'BOPS_ZERO_CONFLICT';
    throw err;
  }
  if (rows.some((r) => r.kind === 'zero_day')) {
    return { branch, date, already: true };
  }
  await branchOpsLogRepository.append({
    date, branch, manager_id: manager.id, manager_name: manager.name,
    kind: 'zero_day', subject: 'Nothing spent', amount: '', status: 'logged',
  });
  return { branch, date, already: false };
}

/**
 * EXP-1 — the running office cash balance for a branch, computed at read
 * time (never persisted): Σ cash_in − Σ outflows, non-rejected, whole
 * history. Pending rows count as spent — cash leaves the drawer when it
 * is spent, not when the admin signs the book. Seed the float by
 * recording the current cash-in-hand once as the first cash_in.
 */
function computeCashBalance(rows) {
  let bal = 0;
  for (const r of rows || []) {
    if (r.status === 'rejected') continue;
    if (r.kind === 'cash_in') bal += r.amount || 0;
    else if (EXPENSE_OUTFLOW_KINDS.includes(r.kind)) bal -= r.amount || 0;
  }
  return +bal.toFixed(2);
}

async function getCashBalance({ branch }) {
  const b = String(branch || '').toLowerCase();
  const all = await branchOpsLogRepository.getAll();
  return computeCashBalance(all.filter((r) => r.branch.toLowerCase() === b));
}

/**
 * EXP-1 — one branch's day in report shape: per-person allowances, office
 * items, commissions, cash in, spent total, running balance, and whether
 * anything was filed (zero-day counts as filed). Pure roll-up over rows.
 */
function buildDayReport(dayRows, allBranchRows) {
  const live = (dayRows || []).filter((r) => r.status !== 'rejected');
  const of = (kind) => live.filter((r) => r.kind === kind);
  const sum = (list) => +list.reduce((s, r) => s + (r.amount || 0), 0).toFixed(2);
  const allowances = of('person_allowance');
  const office = of('expense');
  const commissions = of('commission');
  const cashIn = of('cash_in');
  const spent = +(sum(allowances) + sum(office) + sum(commissions)).toFixed(2);
  return {
    allowances: allowances.map((r) => ({ name: r.subject, amount: r.amount })),
    office: office.map((r) => ({ title: r.subject, amount: r.amount })),
    commissions: commissions.map((r) => ({ note: r.subject, amount: r.amount })),
    cashIn: cashIn.map((r) => ({ source: r.subject, amount: r.amount })),
    cashInTotal: sum(cashIn),
    spent,
    pendingCount: live.filter((r) => EXPENSE_OUTFLOW_KINDS.includes(r.kind) && r.status === 'pending_approval').length,
    zeroDay: live.some((r) => r.kind === 'zero_day'),
    filed: spent > 0 || cashIn.length > 0 || live.some((r) => r.kind === 'zero_day'),
    balance: computeCashBalance(allBranchRows),
  };
}

async function getExpenseDayReport({ branch, date }) {
  const d = date || todayInTz();
  const b = String(branch || '').toLowerCase();
  const all = await branchOpsLogRepository.getAll();
  const branchRows = all.filter((r) => r.branch.toLowerCase() === b);
  return { branch, date: d, ...buildDayReport(branchRows.filter((r) => r.date === d), branchRows) };
}

/**
 * EXP-1 — the person's last allowance amount (any branch), for the
 * one-tap "same as last time" chip. Null when they have none on record.
 */
async function lastAllowanceAmount(refId) {
  const id = String(refId || '');
  if (!id) return null;
  const all = await branchOpsLogRepository.getAll();
  const mine = all
    .filter((r) => r.kind === 'person_allowance' && r.ref_id === id && r.status !== 'rejected')
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return mine.length && mine[0].amount > 0 ? mine[0].amount : null;
}

/**
 * EXP-1 — who files expenses for which branch: distinct manager_ids seen
 * on a branch's rows in the last `days` days. Drives the evening reminder
 * recipients without any hardcoded person.
 */
async function activeExpenseBranches({ days = 14 } = {}) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const all = await branchOpsLogRepository.getAll();
  const map = new Map(); // branch → Set<manager_id>
  for (const r of all) {
    if (r.date < cutoff || !r.branch) continue;
    if (!map.has(r.branch)) map.set(r.branch, new Set());
    if (r.manager_id) map.get(r.branch).add(r.manager_id);
  }
  return [...map.entries()].map(([branch, filers]) => ({ branch, filers: [...filers] }));
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
  rankExpenseTitles,
  getExpenseQuickPicks,
  todayInTz,
  // EXP-1
  recordCashIn,
  recordZeroDay,
  lastAllowanceAmount,
  getCashBalance,
  computeCashBalance,
  buildDayReport,
  getExpenseDayReport,
  activeExpenseBranches,
  EXPENSE_OUTFLOW_KINDS,
  // tunable constants — exposed for smoke
  MAX_EXPENSE_AMOUNT,
  MAX_EXPENSE_TITLE_LEN,
  MAX_EXPENSE_ITEMS,
  MAX_OPENING_CASH,
  SEED_EXPENSE_TITLES,
  TITLE_DECAY_HALF_LIFE_DAYS,
  TITLE_HISTORY_WINDOW_DAYS,
  MAX_QUICK_PICK_TITLES,
  SEED_BASE_SCORE,
};
