/**
 * Repository: MFG_Activity_Log sheet — immutable log of every manufacturing action.
 * Tracks who, what, which article, which stage, old/new values, timestamp.
 */

const gs = require('./googleSheetsRepository');

const SHEET = 'MFG_Activity_Log';
const HEADERS = ['log_id', 'timestamp', 'article_no', 'stage', 'action', 'field', 'old_value', 'new_value', 'user_id', 'status'];

function str(v) { return (v ?? '').toString().trim(); }

async function ensureHeader() {
  const rows = await gs.readSheet(SHEET, 'A1:J1');
  if (!rows.length || rows[0].length < HEADERS.length) {
    await gs.updateRow(SHEET, 'A1:J1', [HEADERS]);
  }
}

async function append(record) {
  await ensureHeader();
  await gs.appendRow(SHEET, [
    record.log_id || '', new Date().toISOString(),
    record.article_no || '', record.stage || '', record.action || '',
    record.field || '', record.old_value || '', record.new_value || '',
    record.user_id || '', record.status || 'completed',
  ]);
}

async function getByArticle(articleNo) {
  const rows = await gs.readSheet(SHEET, 'A2:J');
  return rows.filter((r) => str(r[2]) === String(articleNo)).map((r) => ({
    log_id: str(r[0]), timestamp: str(r[1]), article_no: str(r[2]),
    stage: str(r[3]), action: str(r[4]), field: str(r[5]),
    old_value: str(r[6]), new_value: str(r[7]), user_id: str(r[8]), status: str(r[9]),
  }));
}

module.exports = { SHEET, HEADERS, ensureHeader, append, getByArticle };
