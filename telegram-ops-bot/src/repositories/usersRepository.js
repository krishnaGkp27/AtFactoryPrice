/**
 * Data access for Users sheet (role-based access control).
 * Extended with department and warehouse assignments.
 */

const sheets = require('./sheetsClient');

const SHEET = 'Users';

function str(v) { return (v ?? '').toString().trim(); }

function parse(r, rowIndex) {
  return {
    rowIndex,
    user_id: str(r[0]),
    name: str(r[1]),
    role: str(r[2]) || 'employee',
    branch: str(r[3]),
    access_level: str(r[4]) || 'branch_only',
    status: str(r[5]) || 'active',
    created_at: str(r[6]),
    department: str(r[7]),
    warehouses: str(r[8]).split(',').map((w) => w.trim()).filter(Boolean),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:I');
  return rows.map((r, i) => parse(r, i + 2)).filter((u) => u.user_id);
}

async function findByUserId(userId) {
  const all = await getAll();
  return all.find((u) => u.user_id === String(userId)) || null;
}

async function append(user) {
  await sheets.appendRows(SHEET, [[
    user.user_id, user.name || '', user.role || 'employee',
    user.branch || '', user.access_level || 'branch_only',
    user.status || 'active', new Date().toISOString(),
    user.department || '', Array.isArray(user.warehouses) ? user.warehouses.join(',') : (user.warehouses || ''),
  ]]);
}

async function updateDepartment(userId, department) {
  const u = await findByUserId(userId);
  if (!u) return false;
  await sheets.updateRange(SHEET, `H${u.rowIndex}`, [[department]]);
  return true;
}

async function updateWarehouses(userId, warehouses) {
  const u = await findByUserId(userId);
  if (!u) return false;
  const csv = Array.isArray(warehouses) ? warehouses.join(',') : warehouses;
  await sheets.updateRange(SHEET, `I${u.rowIndex}`, [[csv]]);
  return true;
}

module.exports = { getAll, findByUserId, append, updateDepartment, updateWarehouses, SHEET };
