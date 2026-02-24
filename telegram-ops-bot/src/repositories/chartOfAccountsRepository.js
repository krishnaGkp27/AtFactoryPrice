/**
 * Data access for Chart_of_Accounts sheet.
 */

const sheets = require('./sheetsClient');

const SHEET = 'Chart_of_Accounts';

function parse(r) {
  return {
    account_code: (r[0] || '').toString().trim(),
    account_name: (r[1] || '').toString().trim(),
    account_type: (r[2] || '').toString().trim(),
    parent_code: (r[3] || '').toString().trim(),
    is_active: (r[4] || 'TRUE').toString().trim().toUpperCase() === 'TRUE',
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:E');
  return rows.map(parse).filter((r) => r.account_code);
}

async function findByCode(code) {
  const all = await getAll();
  return all.find((a) => a.account_code === String(code)) || null;
}

async function findByName(name) {
  const all = await getAll();
  const n = (name || '').toLowerCase();
  return all.find((a) => a.account_name.toLowerCase() === n) || null;
}

async function append(account) {
  await sheets.appendRows(SHEET, [[
    account.account_code, account.account_name, account.account_type,
    account.parent_code || '', account.is_active !== false ? 'TRUE' : 'FALSE',
  ]]);
}

module.exports = { getAll, findByCode, findByName, append, SHEET };
