/**
 * Data access for Users sheet (role-based access control).
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
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:G');
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
  ]]);
}

module.exports = { getAll, findByUserId, append, SHEET };
