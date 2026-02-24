/**
 * Data access for Transactions sheet.
 * Columns: Timestamp | User | Action | Design | Color | Qty | Before | After | Status
 */

const sheets = require('./sheetsClient');

const SHEET = 'Transactions';
const HEADERS = ['Timestamp', 'User', 'Action', 'Design', 'Color', 'Qty', 'Before', 'After', 'Status'];

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:I1');
  if (!rows.length || rows[0].length < 9) {
    await sheets.updateRange(SHEET, 'A1:I1', [HEADERS]);
  }
}

async function append(record) {
  await ensureHeader();
  const row = [
    record.timestamp || new Date().toISOString(),
    record.user ?? '',
    record.action ?? '',
    record.design ?? '',
    record.color ?? '',
    record.qty ?? '',
    record.before ?? '',
    record.after ?? '',
    record.status ?? 'completed',
  ];
  await sheets.appendRows(SHEET, [row]);
  return record;
}

module.exports = { append, ensureHeader };
