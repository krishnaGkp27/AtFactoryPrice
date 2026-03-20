/**
 * Repository: MFG_Rejections sheet — tracks pieces rejected at QC and their re-entry into manufacturing.
 */

const gs = require('./googleSheetsRepository');

const SHEET = 'MFG_Rejections';
const HEADERS = ['rejection_id', 'article_no', 'qty', 'reason', 'from_stage', 'to_stage', 'status', 'approved_by', 'created_by', 'created_at', 'resolved_at'];

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }

function parseRow(row, rowIndex) {
  return {
    rowIndex: rowIndex + 2,
    rejection_id: str(row[0]), article_no: str(row[1]), qty: num(row[2]),
    reason: str(row[3]), from_stage: str(row[4]), to_stage: str(row[5]),
    status: str(row[6]) || 'pending', approved_by: str(row[7]),
    created_by: str(row[8]), created_at: str(row[9]), resolved_at: str(row[10]),
  };
}

async function ensureHeader() {
  const rows = await gs.readSheet(SHEET, 'A1:K1');
  if (!rows.length || rows[0].length < HEADERS.length) {
    await gs.updateRow(SHEET, 'A1:K1', [HEADERS]);
  }
}

async function append(record) {
  await ensureHeader();
  await gs.appendRow(SHEET, [
    record.rejection_id, record.article_no, record.qty || 0,
    record.reason || '', record.from_stage || 'QC', record.to_stage || '',
    'pending', '', record.created_by || '', new Date().toISOString(), '',
  ]);
}

async function getAll() {
  const rows = await gs.readSheet(SHEET, 'A2:K');
  return rows.map((r, i) => parseRow(r, i)).filter((r) => r.rejection_id);
}

async function getByArticle(articleNo) {
  return (await getAll()).filter((r) => r.article_no === String(articleNo));
}

async function getPending() {
  return (await getAll()).filter((r) => r.status === 'pending');
}

async function updateStatus(rejectionId, status, approvedBy) {
  const item = (await getAll()).find((r) => r.rejection_id === String(rejectionId));
  if (!item) return false;
  await gs.updateRow(SHEET, `G${item.rowIndex}:K${item.rowIndex}`, [[status, approvedBy || '', item.created_by, item.created_at, new Date().toISOString()]]);
  return true;
}

module.exports = { SHEET, HEADERS, ensureHeader, append, getAll, getByArticle, getPending, updateStatus };
