/**
 * Data access for Receipts sheet — payment receipts uploaded via Telegram.
 */

const sheets = require('./sheetsClient');

const SHEET = 'Receipts';
const HEADERS = [
  'receipt_id', 'customer', 'amount', 'bank_account',
  'uploaded_by_id', 'uploaded_by_name', 'telegram_file_id', 'file_type',
  'drive_file_id', 'drive_url', 'status', 'approved_by',
  'upload_date', 'created_at', 'notes',
];

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }

function parse(r, rowIndex) {
  return {
    rowIndex,
    receipt_id: str(r[0]),
    customer: str(r[1]),
    amount: num(r[2]),
    bank_account: str(r[3]),
    uploaded_by_id: str(r[4]),
    uploaded_by_name: str(r[5]),
    telegram_file_id: str(r[6]),
    file_type: str(r[7]),
    drive_file_id: str(r[8]),
    drive_url: str(r[9]),
    status: str(r[10]) || 'pending',
    approved_by: str(r[11]),
    upload_date: str(r[12]),
    created_at: str(r[13]),
    notes: str(r[14]),
  };
}

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:O1');
  if (!rows.length || !rows[0].length) {
    await sheets.updateRange(SHEET, 'A1:O1', [HEADERS]);
  }
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:O');
  return rows.map((r, i) => parse(r, i + 2)).filter((r) => r.receipt_id);
}

async function getByCustomer(customer) {
  const all = await getAll();
  const c = (customer || '').toLowerCase();
  return all.filter((r) => r.customer.toLowerCase() === c && r.status === 'approved');
}

async function getById(receiptId) {
  const all = await getAll();
  return all.find((r) => r.receipt_id === receiptId) || null;
}

async function append(receipt) {
  await ensureHeader();
  const now = new Date().toISOString();
  await sheets.appendRows(SHEET, [[
    receipt.receipt_id, receipt.customer, receipt.amount, receipt.bank_account,
    receipt.uploaded_by_id, receipt.uploaded_by_name, receipt.telegram_file_id, receipt.file_type || 'image',
    receipt.drive_file_id || '', receipt.drive_url || '', receipt.status || 'pending', receipt.approved_by || '',
    receipt.upload_date || now.split('T')[0], now, receipt.notes || '',
  ]]);
}

async function updateDriveInfo(receiptId, driveFileId, driveUrl, approvedBy) {
  const r = await getById(receiptId);
  if (!r) return false;
  await sheets.batchUpdateRanges(SHEET, [
    { range: `I${r.rowIndex}`, values: [[driveFileId]] },
    { range: `J${r.rowIndex}`, values: [[driveUrl]] },
    { range: `K${r.rowIndex}`, values: [['approved']] },
    { range: `L${r.rowIndex}`, values: [[approvedBy]] },
  ]);
  return true;
}

async function updateStatus(receiptId, status) {
  const r = await getById(receiptId);
  if (!r) return false;
  await sheets.updateRange(SHEET, `K${r.rowIndex}`, [[status]]);
  return true;
}

module.exports = { getAll, getByCustomer, getById, append, updateDriveInfo, updateStatus, SHEET, HEADERS };
