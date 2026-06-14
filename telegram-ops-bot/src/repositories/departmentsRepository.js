/**
 * Data access for Departments sheet — role-based activity control.
 * Each department has a list of allowed_activities (comma-separated activity codes).
 */

const sheets = require('./sheetsClient');

const SHEET = 'Departments';
const HEADERS = [
  'dept_id', 'dept_name', 'allowed_activities', 'status', 'created_at',
  'parent_department',
  // MG-1: CSV of warehouse names a department (used as a marketing group)
  // draws stock from. Empty for non-marketing departments.
  'warehouses',
];

function str(v) { return (v ?? '').toString().trim(); }

/**
 * Parse one Departments row.
 * Tolerates legacy 5- and 6-column rows: missing columns parse to ''
 * (parent_department) or [] (warehouses).
 *
 * @param {Array<string|undefined>} r
 * @param {number} rowIndex 1-based sheet row index
 * @returns {{rowIndex:number, dept_id:string, dept_name:string,
 *   allowed_activities:string[], status:string, created_at:string,
 *   parent_department:string, warehouses:string[]}}
 */
function parse(r, rowIndex) {
  return {
    rowIndex,
    dept_id: str(r[0]),
    dept_name: str(r[1]),
    allowed_activities: str(r[2]).split(',').map((a) => a.trim()).filter(Boolean),
    status: str(r[3]) || 'active',
    created_at: str(r[4]),
    parent_department: str(r[5]),
    warehouses: str(r[6]).split(',').map((w) => w.trim()).filter(Boolean),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:G');
  return rows.map((r, i) => parse(r, i + 2)).filter((d) => d.dept_id);
}

async function findById(deptId) {
  const all = await getAll();
  return all.find((d) => d.dept_id === deptId) || null;
}

async function findByName(name) {
  const all = await getAll();
  const n = (name || '').toLowerCase();
  return all.find((d) => d.dept_name.toLowerCase() === n) || null;
}

async function append(dept) {
  const now = new Date().toISOString();
  await sheets.appendRows(SHEET, [[
    dept.dept_id, dept.dept_name,
    Array.isArray(dept.allowed_activities) ? dept.allowed_activities.join(',') : (dept.allowed_activities || ''),
    dept.status || 'active', now,
  ]]);
}

async function updateActivities(deptId, activities) {
  const d = await findById(deptId);
  if (!d) return false;
  const csv = Array.isArray(activities) ? activities.join(',') : activities;
  await sheets.updateRange(SHEET, `C${d.rowIndex}`, [[csv]]);
  return true;
}

/**
 * Set parent department name (empty = top-level). Validates row exists.
 */
async function updateParentDepartment(deptId, parentDepartmentName) {
  const d = await findById(deptId);
  if (!d) return false;
  await sheets.updateRange(SHEET, `F${d.rowIndex}`, [[str(parentDepartmentName)]]);
  return true;
}

/**
 * MG-1 — set the marketing-group warehouses CSV (column G).
 * Accepts an array (joined with ',') or a pre-joined string.
 * Empty value clears the field, which also takes this department
 * out of the "is a marketing group" set used by marketerOverlay.
 *
 * @param {string} deptId
 * @param {string|string[]} warehouses
 * @returns {Promise<boolean>} true if row found+updated, false otherwise
 */
async function updateWarehouses(deptId, warehouses) {
  const d = await findById(deptId);
  if (!d) return false;
  const csv = Array.isArray(warehouses)
    ? warehouses.map((w) => String(w).trim()).filter(Boolean).join(',')
    : String(warehouses || '').trim();
  await sheets.updateRange(SHEET, `G${d.rowIndex}`, [[csv]]);
  return true;
}

/**
 * Idempotent: ensure a department row exists with the given name.
 * Used by Stage 1 dispatch routing so the bot can self-heal a missing
 * Dispatch department without forcing the admin to hand-edit the
 * Departments sheet. Returns the (existing or newly-created) row.
 *
 * @param {{dept_name:string, dept_id?:string, allowed_activities?:string[]|string}} cfg
 * @returns {Promise<object>}
 */
async function ensureDept(cfg) {
  if (!cfg || !cfg.dept_name) throw new Error('ensureDept: dept_name is required');
  const existing = await findByName(cfg.dept_name);
  if (existing) return existing;
  const dept_id = cfg.dept_id || `D-${cfg.dept_name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)}`;
  await append({
    dept_id,
    dept_name: cfg.dept_name,
    allowed_activities: cfg.allowed_activities || '',
    status: 'active',
  });
  // Re-read to get the rowIndex of the newly-appended row.
  return await findByName(cfg.dept_name);
}

module.exports = {
  getAll,
  findById,
  findByName,
  append,
  updateActivities,
  updateParentDepartment,
  updateWarehouses,
  ensureDept,
  SHEET,
  HEADERS,
};
