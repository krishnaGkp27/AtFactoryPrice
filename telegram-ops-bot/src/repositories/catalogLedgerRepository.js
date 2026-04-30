/**
 * Data access for CatalogLedger sheet — audit trail for physical catalog movements.
 *
 * Every supply, loan, or return creates a row here. Returns update the existing
 * row's Status and DateReturned rather than creating new rows.
 */

const sheets = require('./sheetsClient');

const SHEET = 'CatalogLedger';
const HEADERS = [
  'LedgerId', 'Design', 'CatalogSize', 'Warehouse', 'Quantity', 'Action',
  'RecipientType', 'RecipientName', 'Status', 'DateOut', 'DateReturned',
  'RequestedBy', 'ApprovedBy', 'ApprovalRequestId', 'Notes', 'CreatedAt',
];
const COL_COUNT = HEADERS.length;

/** Short-lived cache to avoid hammering the API during batch ops. */
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 10000;

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }

function parseRow(r, rowIndex) {
  return {
    rowIndex,
    ledger_id: str(r[0]),
    design: str(r[1]),
    catalog_size: str(r[2]),
    warehouse: str(r[3]),
    quantity: num(r[4]),
    action: str(r[5]),
    recipient_type: str(r[6]),
    recipient_name: str(r[7]),
    status: str(r[8]).toLowerCase() || 'active',
    date_out: str(r[9]),
    date_returned: str(r[10]),
    requested_by: str(r[11]),
    approved_by: str(r[12]),
    approval_request_id: str(r[13]),
    notes: str(r[14]),
    created_at: str(r[15]),
  };
}

function toRow(o) {
  return [
    o.ledger_id ?? '',
    o.design ?? '',
    o.catalog_size ?? '',
    o.warehouse ?? '',
    o.quantity ?? 0,
    o.action ?? '',
    o.recipient_type ?? '',
    o.recipient_name ?? '',
    o.status ?? 'active',
    o.date_out ?? '',
    o.date_returned ?? '',
    o.requested_by ?? '',
    o.approved_by ?? '',
    o.approval_request_id ?? '',
    o.notes ?? '',
    o.created_at ?? new Date().toISOString(),
  ];
}

function columnLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

async function ensureHeader() {
  try {
    const names = await sheets.getSheetNames();
    if (!names.includes(SHEET)) {
      try { await sheets.addSheet(SHEET); } catch (_) { /* may race or already exist */ }
    }
  } catch (_) { /* sheet listing failure: try header write anyway */ }

  const rows = await sheets.readRange(SHEET, `A1:${columnLetter(COL_COUNT)}1`).catch(() => []);
  if (!rows.length || rows[0].length < COL_COUNT) {
    await sheets.updateRange(SHEET, `A1:${columnLetter(COL_COUNT)}1`, [HEADERS]);
  }
}

function invalidateCache() { _cache = null; _cacheTs = 0; }

async function getAll() {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL_MS) return _cache;
  await ensureHeader();
  const rows = await sheets.readRange(SHEET, `A2:${columnLetter(COL_COUNT)}`).catch(() => []);
  _cache = rows.map((r, i) => parseRow(r, i + 2)).filter((r) => r.ledger_id);
  _cacheTs = Date.now();
  return _cache;
}

async function append(record) {
  await ensureHeader();
  await sheets.appendRows(SHEET, [toRow(record)]);
  invalidateCache();
}

async function findByRecipient(recipientName, recipientType) {
  const all = await getAll();
  const n = (recipientName || '').toLowerCase();
  const t = (recipientType || '').toLowerCase();
  return all.filter(
    (r) => r.recipient_name.toLowerCase() === n
      && (!t || r.recipient_type.toLowerCase() === t),
  );
}

async function findActive(recipientName, recipientType) {
  const matches = await findByRecipient(recipientName, recipientType);
  return matches.filter((r) => r.status === 'active');
}

async function findByApprovalRequestId(requestId) {
  if (!requestId) return null;
  const all = await getAll();
  return all.find((r) => r.approval_request_id === requestId) || null;
}

async function findActiveByIds(ledgerIds) {
  if (!ledgerIds || !ledgerIds.length) return [];
  const all = await getAll();
  const idSet = new Set(ledgerIds.map((id) => str(id)));
  return all.filter((r) => idSet.has(r.ledger_id) && r.status === 'active');
}

async function markReturned(rowIndex, approvedBy, dateReturned) {
  const returned = dateReturned || new Date().toISOString().split('T')[0];
  await sheets.batchUpdateRanges(SHEET, [
    { range: `I${rowIndex}`, values: [['returned']] },
    { range: `K${rowIndex}`, values: [[returned]] },
    { range: `M${rowIndex}`, values: [[approvedBy ?? '']] },
  ]);
  invalidateCache();
}

async function getRecent(limit) {
  const all = await getAll();
  const sorted = [...all].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return sorted.slice(0, limit || 20);
}

module.exports = {
  SHEET,
  HEADERS,
  getAll,
  append,
  findByRecipient,
  findActive,
  findByApprovalRequestId,
  findActiveByIds,
  markReturned,
  getRecent,
  ensureHeader,
  invalidateCache,
};
