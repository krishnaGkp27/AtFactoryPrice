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

function parse(r, rowIndex) {
  const departments = parseDeptCsv(r[7]);
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
  const rows = await sheets.readRange(SHEET, 'A2:I');
  return rows.map((r, i) => parse(r, i + 2)).filter((u) => u.user_id);
}

async function findByUserId(userId) {
  const all = await getAll();
  return all.find((u) => u.user_id === String(userId)) || null;
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
  await sheets.appendRows(SHEET, [[
    user.user_id, user.name || '', user.role || 'employee',
    user.branch || '', user.access_level || 'branch_only',
    user.status || 'active', new Date().toISOString(),
    deptCsv, Array.isArray(user.warehouses) ? user.warehouses.join(',') : (user.warehouses || ''),
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

async function updateWarehouses(userId, warehouses) {
  const u = await findByUserId(userId);
  if (!u) return false;
  const csv = Array.isArray(warehouses) ? warehouses.join(',') : warehouses;
  await sheets.updateRange(SHEET, `I${u.rowIndex}`, [[csv]]);
  return true;
}

module.exports = {
  getAll,
  findByUserId,
  findByDepartment,
  inDepartment,
  append,
  updateDepartment,
  updateWarehouses,
  SHEET,
};
