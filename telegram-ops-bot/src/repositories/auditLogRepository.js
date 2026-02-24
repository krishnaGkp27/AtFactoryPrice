/**
 * Data access for AuditLog sheet.
 * Columns: Timestamp | EventType | Payload | User
 */

const sheets = require('./sheetsClient');

const SHEET = 'AuditLog';
const HEADERS = ['Timestamp', 'EventType', 'Payload', 'User'];

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:D1');
  if (!rows.length || rows[0].length < 4) {
    await sheets.updateRange(SHEET, 'A1:D1', [HEADERS]);
  }
}

async function append(eventType, payload, user) {
  await ensureHeader();
  const row = [
    new Date().toISOString(),
    eventType,
    typeof payload === 'string' ? payload : JSON.stringify(payload || {}),
    user ?? '',
  ];
  await sheets.appendRows(SHEET, [row]);
}

module.exports = { append, ensureHeader };
