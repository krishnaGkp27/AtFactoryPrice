/**
 * Data access for Departments sheet — role-based activity control.
 * Each department has a list of allowed_activities (comma-separated activity codes).
 */

const sheets = require('./sheetsClient');

const SHEET = 'Departments';
const HEADERS = ['dept_id', 'dept_name', 'allowed_activities', 'status', 'created_at'];

function str(v) { return (v ?? '').toString().trim(); }

function parse(r, rowIndex) {
  return {
    rowIndex,
    dept_id: str(r[0]),
    dept_name: str(r[1]),
    allowed_activities: str(r[2]).split(',').map((a) => a.trim()).filter(Boolean),
    status: str(r[3]) || 'active',
    created_at: str(r[4]),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:E');
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

module.exports = { getAll, findById, findByName, append, updateActivities, SHEET, HEADERS };
