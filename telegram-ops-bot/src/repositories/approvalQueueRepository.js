/**
 * Data access for ApprovalQueue sheet.
 * Columns: RequestID | User | ActionJSON | RiskReason | Status | CreatedAt | ResolvedAt
 */

const sheets = require('./sheetsClient');

const SHEET = 'ApprovalQueue';
const HEADERS = ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt'];

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:G1');
  if (!rows.length || rows[0].length < 7) {
    await sheets.updateRange(SHEET, 'A1:G1', [HEADERS]);
  }
}

async function append(record) {
  await ensureHeader();
  const row = [
    record.requestId ?? '',
    record.user ?? '',
    typeof record.actionJSON === 'string' ? record.actionJSON : JSON.stringify(record.actionJSON || {}),
    record.riskReason ?? '',
    record.status ?? 'pending',
    record.createdAt || new Date().toISOString(),
    record.resolvedAt ?? '',
  ];
  await sheets.appendRows(SHEET, [row]);
  return record;
}

async function getAllPending() {
  const rows = await sheets.readRange(SHEET, 'A2:G');
  return rows
    .filter((r) => (r[4] || '').toString().toLowerCase() === 'pending')
    .map((r) => ({
      requestId: r[0],
      user: r[1],
      actionJSON: safeParse(r[2]),
      riskReason: r[3],
      status: r[4],
      createdAt: r[5],
      resolvedAt: r[6],
    }));
}

async function updateStatus(requestId, status, resolvedAt) {
  const rows = await sheets.readRange(SHEET, 'A2:G');
  const idx = rows.findIndex((r) => String(r[0]) === String(requestId));
  if (idx === -1) return false;
  const rowIndex = idx + 2;
  await sheets.updateRange(SHEET, `E${rowIndex}:G${rowIndex}`, [[status, resolvedAt || new Date().toISOString(), resolvedAt || '']]);
  return true;
}

function safeParse(str) {
  try {
    return JSON.parse(str || '{}');
  } catch {
    return {};
  }
}

module.exports = { append, getAllPending, updateStatus, ensureHeader };
