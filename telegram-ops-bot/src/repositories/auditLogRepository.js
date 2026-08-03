/**
 * Data access for AuditLog sheet.
 * Columns: Timestamp | EventType | Payload | User
 */

const sheets = require('./sheetsClient');

const SHEET = 'AuditLog';
const HEADERS = ['Timestamp', 'EventType', 'Payload', 'User'];

// P6 — the header only needs bootstrapping once per process; without this
// guard every audit append paid an extra read of row 1 first.
let _headerReady = false;

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:D1');
  if (!rows.length || rows[0].length < 4) {
    await sheets.updateRange(SHEET, 'A1:D1', [HEADERS]);
  }
}

async function append(eventType, payload, user) {
  if (!_headerReady) {
    await ensureHeader();
    _headerReady = true;
  }
  const row = [
    new Date().toISOString(),
    eventType,
    typeof payload === 'string' ? payload : JSON.stringify(payload || {}),
    user ?? '',
  ];
  await sheets.appendRows(SHEET, [row]);
}

/**
 * BMV-1 — append many events in ONE call. A 43-bale dispatch logs 43 rows;
 * appending them one at a time would be 43 round-trips.
 * @param {Array<{eventType:string, payload:*, user?:string}>} events
 */
async function appendMany(events) {
  const list = Array.isArray(events) ? events.filter(Boolean) : [];
  if (!list.length) return;
  if (!_headerReady) {
    await ensureHeader();
    _headerReady = true;
  }
  const now = new Date().toISOString();
  const rows = list.map((e) => [
    now,
    e.eventType,
    typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload || {}),
    e.user ?? '',
  ]);
  await sheets.appendRows(SHEET, rows);
}

module.exports = { append, appendMany, ensureHeader };
