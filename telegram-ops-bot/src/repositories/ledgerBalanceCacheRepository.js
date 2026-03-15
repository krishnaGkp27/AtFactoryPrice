/**
 * Repository: LedgerBalanceCache sheet (cache of current balance per customer for fast reads).
 * Schema: customer_id, balance, last_updated.
 * All operations go through googleSheetsRepository. Recalculated when transactions are created.
 */

const googleSheetsRepository = require('./googleSheetsRepository');

const SHEET_NAME = 'LedgerBalanceCache';
const HEADERS = ['customer_id', 'balance', 'last_updated'];

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }

function parseRow(row, rowIndex) {
  return {
    rowIndex: rowIndex + 2,
    customer_id: str(row[0]),
    balance: num(row[1]),
    last_updated: str(row[2]),
  };
}

async function ensureHeader() {
  const rows = await googleSheetsRepository.readSheet(SHEET_NAME, 'A1:C1');
  if (!rows.length || rows[0].length < HEADERS.length) {
    await googleSheetsRepository.updateRow(SHEET_NAME, 'A1:C1', [HEADERS]);
  }
}

async function get(customerId) {
  const all = await getAll();
  const c = all.find((r) => r.customer_id === String(customerId));
  return c ? c.balance : null;
}

async function getAll() {
  const rows = await googleSheetsRepository.readSheet(SHEET_NAME, 'A2:C');
  return rows.map((r, i) => parseRow(r, i)).filter((r) => r.customer_id);
}

async function set(customerId, balance) {
  await ensureHeader();
  const id = String(customerId);
  const now = new Date().toISOString();
  const all = await getAll();
  const existing = all.find((r) => r.customer_id === id);
  if (existing) {
    await googleSheetsRepository.updateRow(SHEET_NAME, `B${existing.rowIndex}:C${existing.rowIndex}`, [[balance, now]]);
  } else {
    await googleSheetsRepository.appendRow(SHEET_NAME, [id, balance, now]);
  }
  return { customer_id: id, balance, last_updated: now };
}

module.exports = {
  SHEET_NAME,
  HEADERS,
  ensureHeader,
  get,
  getAll,
  set,
};
