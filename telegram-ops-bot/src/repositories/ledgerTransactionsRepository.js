/**
 * Repository: LedgerTransactions sheet (source of truth for all customer ledger transactions).
 * Schema: txn_id, timestamp, customer_id, txn_type, direction, amount, description, reference, created_by, status.
 * All reads/writes go through googleSheetsRepository. No business logic here.
 */

const googleSheetsRepository = require('./googleSheetsRepository');

const SHEET_NAME = 'LedgerTransactions';
const HEADERS = ['txn_id', 'timestamp', 'customer_id', 'txn_type', 'direction', 'amount', 'description', 'reference', 'created_by', 'status'];

const TXN_TYPES = Object.freeze({ SALE: 'SALE', PAYMENT: 'PAYMENT', ADJUSTMENT: 'ADJUSTMENT' });
const DIRECTIONS = Object.freeze({ debit: 'debit', credit: 'credit' });

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }

function parseRow(row) {
  return {
    txn_id: str(row[0]),
    timestamp: str(row[1]),
    customer_id: str(row[2]),
    txn_type: str(row[3]),
    direction: str(row[4]).toLowerCase() || 'debit',
    amount: num(row[5]),
    description: str(row[6]),
    reference: str(row[7]),
    created_by: str(row[8]),
    status: str(row[9]) || 'completed',
  };
}

async function ensureHeader() {
  const rows = await googleSheetsRepository.readSheet(SHEET_NAME, 'A1:J1');
  if (!rows.length || rows[0].length < HEADERS.length) {
    await googleSheetsRepository.updateRow(SHEET_NAME, 'A1:J1', [HEADERS]);
  }
}

async function append(transaction) {
  await ensureHeader();
  const row = [
    transaction.txn_id || '',
    transaction.timestamp || new Date().toISOString(),
    transaction.customer_id || '',
    transaction.txn_type || TXN_TYPES.SALE,
    (transaction.direction || DIRECTIONS.debit).toLowerCase(),
    transaction.amount ?? 0,
    transaction.description || '',
    transaction.reference || '',
    transaction.created_by || '',
    transaction.status || 'completed',
  ];
  await googleSheetsRepository.appendRow(SHEET_NAME, row);
  return { ...transaction, timestamp: row[1], status: row[9] };
}

async function getAll() {
  const rows = await googleSheetsRepository.readSheet(SHEET_NAME, 'A2:J');
  return rows.map(parseRow).filter((t) => t.txn_id);
}

async function getByCustomerId(customerId) {
  const all = await getAll();
  const id = String(customerId);
  return all.filter((t) => t.customer_id === id);
}

module.exports = {
  SHEET_NAME,
  HEADERS,
  TXN_TYPES,
  DIRECTIONS,
  ensureHeader,
  append,
  getAll,
  getByCustomerId,
  parseRow,
};
