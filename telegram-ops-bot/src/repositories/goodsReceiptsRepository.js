/**
 * Data access for GoodsReceipts sheet (P2).
 *
 * Each row is a GRN header — the "delivery" or "intake batch" that grouped a
 * set of bales when they physically arrived at a warehouse. The bales
 * themselves go into Inventory directly (with grn_id back-pointer in
 * column T), so this sheet stays compact and acts only as the audit /
 * receipt-level document.
 *
 * Columns:
 *   grn_id          — primary key (GRN-YYYYMMDD-NNN)
 *   warehouse       — receiving warehouse name
 *   supplier        — Contacts.name (type='supplier') or free-text fallback
 *   supplier_id     — Contacts.contact_id when known (empty for free-text)
 *   po_id           — optional FK to ProcurementOrders (P4); empty for ad-hoc receipts
 *   received_by     — Telegram user_id of the operator
 *   received_at     — ISO timestamp of confirmation
 *   total_bales     — count of bales attached to this GRN
 *   total_yards     — sum of yards across all bales
 *   photo_file_id   — Telegram file_id of the supplier invoice photo (P5 OCR)
 *   notes           — free-text
 *   status          — 'received' | 'cancelled'
 */

const sheets = require('./sheetsClient');
const idGenerator = require('../utils/idGenerator');

const SHEET = 'GoodsReceipts';
const HEADERS = [
  'grn_id', 'warehouse', 'supplier', 'supplier_id', 'po_id',
  'received_by', 'received_at', 'total_bales', 'total_yards',
  'photo_file_id', 'notes', 'status',
];

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }

function parse(r, rowIndex) {
  return {
    rowIndex,
    grn_id: str(r[0]),
    warehouse: str(r[1]),
    supplier: str(r[2]),
    supplier_id: str(r[3]),
    po_id: str(r[4]),
    received_by: str(r[5]),
    received_at: str(r[6]),
    total_bales: num(r[7]),
    total_yards: num(r[8]),
    photo_file_id: str(r[9]),
    notes: str(r[10]),
    status: str(r[11]) || 'received',
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:L');
  return rows.map((r, i) => parse(r, i + 2)).filter((g) => g.grn_id);
}

async function getById(grnId) {
  const all = await getAll();
  return all.find((g) => g.grn_id === str(grnId)) || null;
}

async function getByWarehouse(warehouse) {
  const all = await getAll();
  return all.filter((g) => g.warehouse.toLowerCase() === (warehouse || '').toLowerCase());
}

/**
 * Append a new GRN header. grn_id is server-generated if not provided.
 * Returns the saved row including the generated grn_id.
 */
async function append(grn) {
  const grnId = grn.grn_id || idGenerator.grn();
  const now = new Date().toISOString();
  const row = [
    grnId,
    grn.warehouse || '',
    grn.supplier || '',
    grn.supplier_id || '',
    grn.po_id || '',
    grn.received_by || '',
    grn.received_at || now,
    grn.total_bales || 0,
    grn.total_yards || 0,
    grn.photo_file_id || '',
    grn.notes || '',
    grn.status || 'received',
  ];
  await sheets.appendRows(SHEET, [row]);
  return { ...grn, grn_id: grnId, received_at: row[6], status: row[11] };
}

module.exports = { getAll, getById, getByWarehouse, append, SHEET, HEADERS };
