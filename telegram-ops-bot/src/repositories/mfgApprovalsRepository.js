/**
 * Repository: MFG_Approvals sheet — staging area for employee-submitted manufacturing data awaiting admin approval.
 * Each row: approval_id, article_no, stage, data_json (serialized field values), submitted_by, status, reviewed_by, created_at, reviewed_at.
 */

const gs = require('./googleSheetsRepository');

const SHEET = 'MFG_Approvals';
const HEADERS = ['approval_id', 'article_no', 'stage', 'data_json', 'submitted_by', 'status', 'reviewed_by', 'created_at', 'reviewed_at'];

function str(v) { return (v ?? '').toString().trim(); }

function parseRow(row, rowIndex) {
  let data = {};
  try { data = JSON.parse(row[3] || '{}'); } catch (_) {}
  return {
    rowIndex: rowIndex + 2,
    approval_id: str(row[0]),
    article_no: str(row[1]),
    stage: str(row[2]),
    data: data,
    submitted_by: str(row[4]),
    status: str(row[5]) || 'pending',
    reviewed_by: str(row[6]),
    created_at: str(row[7]),
    reviewed_at: str(row[8]),
  };
}

async function ensureHeader() {
  const rows = await gs.readSheet(SHEET, 'A1:I1');
  if (!rows.length || rows[0].length < HEADERS.length) {
    await gs.updateRow(SHEET, 'A1:I1', [HEADERS]);
  }
}

async function append(record) {
  await ensureHeader();
  await gs.appendRow(SHEET, [
    record.approval_id, record.article_no, record.stage,
    JSON.stringify(record.data || {}), record.submitted_by || '',
    'pending', '', new Date().toISOString(), '',
  ]);
}

async function getAll() {
  const rows = await gs.readSheet(SHEET, 'A2:I');
  return rows.map((r, i) => parseRow(r, i)).filter((r) => r.approval_id);
}

async function getPending() {
  return (await getAll()).filter((r) => r.status === 'pending');
}

async function findById(approvalId) {
  return (await getAll()).find((r) => r.approval_id === String(approvalId)) || null;
}

async function updateStatus(approvalId, status, reviewedBy) {
  const item = await findById(approvalId);
  if (!item) return false;
  await gs.updateRow(SHEET, `F${item.rowIndex}:I${item.rowIndex}`, [[status, reviewedBy || '', item.created_at, new Date().toISOString()]]);
  return true;
}

module.exports = { SHEET, HEADERS, ensureHeader, append, getAll, getPending, findById, updateStatus };
