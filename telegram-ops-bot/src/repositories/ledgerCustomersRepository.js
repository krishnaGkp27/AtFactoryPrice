/**
 * Repository: Ledger_Customers sheet (industry-standard ledger customer master).
 * Schema: customer_id, customer_name, phone, credit_limit, created_at, status.
 * Uses googleSheetsRepository for all sheet access. Does not mix business logic with I/O.
 */

const googleSheetsRepository = require('./googleSheetsRepository');

const SHEET_NAME = 'Ledger_Customers';
const HEADERS = ['customer_id', 'customer_name', 'phone', 'credit_limit', 'created_at', 'status'];

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }

function parseRow(row, rowIndex) {
  return {
    rowIndex: rowIndex + 2,
    customer_id: str(row[0]),
    customer_name: str(row[1]),
    phone: str(row[2]),
    credit_limit: num(row[3]),
    created_at: str(row[4]),
    status: str(row[5]) || 'Active',
  };
}

async function ensureHeader() {
  const rows = await googleSheetsRepository.readSheet(SHEET_NAME, 'A1:F1');
  if (!rows.length || rows[0].length < HEADERS.length) {
    await googleSheetsRepository.updateRow(SHEET_NAME, 'A1:F1', [HEADERS]);
  }
}

async function getAll() {
  const rows = await googleSheetsRepository.readSheet(SHEET_NAME, 'A2:F');
  return rows.map((r, i) => parseRow(r, i)).filter((c) => c.customer_id || c.customer_name);
}

async function findById(customerId) {
  const all = await getAll();
  return all.find((c) => c.customer_id === String(customerId)) || null;
}

async function findByName(name) {
  const all = await getAll();
  const n = (name || '').toLowerCase();
  return all.find((c) => c.customer_name.toLowerCase() === n) || null;
}

async function append(customer) {
  await ensureHeader();
  const now = new Date().toISOString();
  const row = [
    customer.customer_id || '',
    customer.customer_name || '',
    customer.phone || '',
    customer.credit_limit ?? 0,
    customer.created_at || now,
    customer.status || 'Active',
  ];
  await googleSheetsRepository.appendRow(SHEET_NAME, row);
  return { ...customer, created_at: row[4], status: row[5] };
}

module.exports = {
  SHEET_NAME,
  HEADERS,
  ensureHeader,
  getAll,
  findById,
  findByName,
  append,
};
