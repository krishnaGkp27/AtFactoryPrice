/**
 * Data access for Users sheet (role-based access control).
 * Extended with department and warehouse assignments.
 *
 * Multi-department support: column H stores a comma-separated list
 * (e.g. "Sales,Dispatch") so a single user can belong to multiple
 * departments and pass any per-department filter. The legacy
 * `department` field is kept (set to the first dept) for back-compat
 * with code that hasn't been updated yet — but new code should prefer
 * `departments` (the array) and the `inDepartment(user, name)` helper.
 */

const sheets = require('./sheetsClient');

const SHEET = 'Users';

function str(v) { return (v ?? '').toString().trim(); }

function parseDeptCsv(raw) {
  return str(raw).split(',').map((d) => d.trim()).filter(Boolean);
}

function parseManagesCsv(raw) {
  return str(raw).split(',').map((d) => d.trim()).filter(Boolean);
}

function parseNotificationPrefs(raw) {
  const s = str(raw);
  if (!s) return null; // null = "use default policy"
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) {
    // Malformed JSON shouldn't crash reads — log-and-default at call site.
    return { _malformed: s };
  }
}

function parse(r, rowIndex) {
  const departments = parseDeptCsv(r[7]);
  const manages = parseManagesCsv(r[9]);
  return {
    rowIndex,
    user_id: str(r[0]),
    name: str(r[1]),
    role: str(r[2]) || 'employee',
    branch: str(r[3]),
    access_level: str(r[4]) || 'branch_only',
    status: str(r[5]) || 'active',
    created_at: str(r[6]),
    // First department wins for legacy single-string consumers; new
    // code should consult `departments` instead.
    department: departments[0] || '',
    departments,
    warehouses: str(r[8]).split(',').map((w) => w.trim()).filter(Boolean),
    /** Department names this user heads (TG-7.5); scope = union of those depts' allowed_activities */
    manages,
    /** Per-user Admin Activity Feed opt-ins (T2). null = use default. */
    notification_prefs: parseNotificationPrefs(r[10]),
  };
}

/**
 * Case-insensitive department membership check that works against
 * either the single `department` or the multi `departments` field —
 * pick whichever the caller has handy.
 *
 * @param {{department?:string, departments?:string[]}} user
 * @param {string} name
 * @returns {boolean}
 */
function inDepartment(user, name) {
  if (!user || !name) return false;
  const target = String(name).trim().toLowerCase();
  if (Array.isArray(user.departments) && user.departments.length) {
    return user.departments.some((d) => String(d).trim().toLowerCase() === target);
  }
  return String(user.department || '').trim().toLowerCase() === target;
}

async function getAll() {
  // K = notification_prefs (T2). Older deployments may still have only
  // A:J — sheets API returns shorter rows; the parser handles undefined.
  const rows = await sheets.readRange(SHEET, 'A2:K');
  return rows.map((r, i) => parse(r, i + 2)).filter((u) => u.user_id);
}

async function findByUserId(userId) {
  const all = await getAll();
  const matches = all.filter((u) => u.user_id === String(userId));
  if (!matches.length) return null;
  // Re-onboarding a previously-deactivated user APPENDS a fresh row (the prior
  // row stays as an inactive audit trail), so one Telegram ID can map to
  // several rows. Returning the first row would surface the stale inactive
  // record (e.g. deactivate → "already inactive"). Prefer the ACTIVE row;
  // otherwise the most recent (last) row reflects the user's current state.
  return matches.find((u) => (u.status || 'active') === 'active') || matches[matches.length - 1];
}

/**
 * Return all active users that belong to the given department
 * (case-insensitive). Used by stage-1 dispatch confirmation routing
 * and any per-department picker.
 */
async function findByDepartment(deptName) {
  if (!deptName) return [];
  const all = await getAll();
  return all.filter((u) => u.status === 'active' && inDepartment(u, deptName));
}

async function append(user) {
  const deptCsv = Array.isArray(user.departments)
    ? user.departments.join(',')
    : (user.department || '');
  const managesCsv = Array.isArray(user.manages)
    ? user.manages.join(',')
    : str(user.manages);
  await sheets.appendRows(SHEET, [[
    user.user_id, user.name || '', user.role || 'employee',
    user.branch || '', user.access_level || 'branch_only',
    user.status || 'active', new Date().toISOString(),
    deptCsv, Array.isArray(user.warehouses) ? user.warehouses.join(',') : (user.warehouses || ''),
    managesCsv,
  ]]);
}

/**
 * Update the user's departments. Accepts either a single string
 * ("Sales") or an array (["Sales", "Dispatch"]); both are stored as
 * comma-separated CSV in column H.
 */
async function updateDepartment(userId, department) {
  const u = await findByUserId(userId);
  if (!u) return false;
  const csv = Array.isArray(department)
    ? department.map((d) => String(d).trim()).filter(Boolean).join(',')
    : String(department || '').trim();
  await sheets.updateRange(SHEET, `H${u.rowIndex}`, [[csv]]);
  return true;
}

/**
 * USR-C3b — update a user's role in column C (admin / manager / employee).
 * Returns true if the row was found and updated, false otherwise.
 */
async function updateRole(userId, role) {
  const u = await findByUserId(userId);
  if (!u) return false;
  await sheets.updateRange(SHEET, `C${u.rowIndex}`, [[String(role || 'employee')]]);
  return true;
}

/**
 * USR-C4 — flip a user's `status` (column F) between 'active' / 'inactive'.
 * Inactive users disappear from pickers and lose bot access, but their row
 * (and full history) stays in place for audit. Reactivating is symmetric.
 */
async function updateStatus(userId, status) {
  const u = await findByUserId(userId);
  if (!u) return false;
  await sheets.updateRange(SHEET, `F${u.rowIndex}`, [[String(status || 'active')]]);
  return true;
}

async function updateWarehouses(userId, warehouses) {
  const u = await findByUserId(userId);
  if (!u) return false;
  const csv = Array.isArray(warehouses) ? warehouses.join(',') : warehouses;
  await sheets.updateRange(SHEET, `I${u.rowIndex}`, [[csv]]);
  return true;
}

/**
 * Update the user's branch (city/region) in column D. A branch groups one or
 * more warehouses; see services/branchService.js.
 */
async function updateBranch(userId, branch) {
  const u = await findByUserId(userId);
  if (!u) return false;
  await sheets.updateRange(SHEET, `D${u.rowIndex}`, [[String(branch || '')]]);
  return true;
}

/**
 * USR-C4 — re-onboard an existing user by REACTIVATING their row in place
 * (status→active + refresh name/role/departments/warehouses) instead of
 * appending a duplicate row. Avoids two rows mapping to one Telegram ID.
 * History is preserved in AuditLog, not via stale duplicate Users rows.
 * Returns false if no row exists for the id.
 *
 * @param {string} userId
 * @param {{name?:string, role?:string, branch?:string, departments?:string[]|string, warehouses?:string[]|string, manages?:string[]|string}} fields
 */
async function reactivate(userId, fields = {}) {
  const u = await findByUserId(userId);
  if (!u) return false;
  const ri = u.rowIndex;
  const deptCsv = Array.isArray(fields.departments)
    ? fields.departments.map((d) => String(d).trim()).filter(Boolean).join(',')
    : String(fields.departments || '').trim();
  const whCsv = Array.isArray(fields.warehouses)
    ? fields.warehouses.map((w) => String(w).trim()).filter(Boolean).join(',')
    : String(fields.warehouses || '').trim();
  // B=name, C=role | F=status | H=departments, I=warehouses. Leaves
  // E(access_level), G(created_at), K(prefs) intact.
  await sheets.updateRange(SHEET, `B${ri}:C${ri}`, [[
    fields.name != null ? String(fields.name) : (u.name || ''),
    fields.role != null ? String(fields.role) : (u.role || 'employee'),
  ]]);
  await sheets.updateRange(SHEET, `F${ri}`, [['active']]);
  await sheets.updateRange(SHEET, `H${ri}:I${ri}`, [[deptCsv, whCsv]]);
  // D(branch) + J(manages) only when explicitly supplied, so a plain
  // reactivate doesn't wipe existing values.
  if (fields.branch != null) {
    await sheets.updateRange(SHEET, `D${ri}`, [[String(fields.branch || '')]]);
  }
  if (fields.manages != null) {
    const managesCsv = Array.isArray(fields.manages)
      ? fields.manages.map((d) => String(d).trim()).filter(Boolean).join(',')
      : String(fields.manages || '').trim();
    await sheets.updateRange(SHEET, `J${ri}`, [[managesCsv]]);
  }
  return true;
}

/**
 * CSV of department names this user manages (heads). Empty = not a dept head.
 */
async function updateManages(userId, manages) {
  const u = await findByUserId(userId);
  if (!u) return false;
  const csv = Array.isArray(manages)
    ? manages.map((d) => String(d).trim()).filter(Boolean).join(',')
    : String(manages || '').trim();
  await sheets.updateRange(SHEET, `J${u.rowIndex}`, [[csv]]);
  return true;
}

/**
 * Persist the entire notification_prefs object (JSON-encoded) for a user.
 * Pass `null` or `{}` to clear (which resumes the default policy).
 *
 * Stored in column K of the Users sheet.
 */
async function updateNotificationPrefs(userId, prefs) {
  const u = await findByUserId(userId);
  if (!u) return false;
  let json = '';
  if (prefs && typeof prefs === 'object' && Object.keys(prefs).length) {
    try { json = JSON.stringify(prefs); } catch (_) { json = ''; }
  }
  await sheets.updateRange(SHEET, `K${u.rowIndex}`, [[json]]);
  return true;
}

/**
 * Set a single event-type pref to enabled/disabled, preserving the
 * other keys already in the user's prefs object.
 *
 * @param {string} userId
 * @param {string} eventType   e.g. 'task.assigned', 'order.delivered'
 * @param {boolean} enabled
 * @returns {Promise<Object|null>} the merged prefs object, or null on failure.
 */
async function setNotificationPref(userId, eventType, enabled) {
  const u = await findByUserId(userId);
  if (!u) return null;
  const current = (u.notification_prefs && typeof u.notification_prefs === 'object' && !u.notification_prefs._malformed)
    ? { ...u.notification_prefs } : {};
  current[eventType] = !!enabled;
  const ok = await updateNotificationPrefs(userId, current);
  return ok ? current : null;
}

module.exports = {
  getAll,
  findByUserId,
  findByDepartment,
  inDepartment,
  append,
  reactivate,
  updateDepartment,
  updateBranch,
  updateWarehouses,
  updateManages,
  updateRole,
  updateStatus,
  updateNotificationPrefs,
  setNotificationPref,
  SHEET,
};
