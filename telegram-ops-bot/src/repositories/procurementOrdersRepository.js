/**
 * Data access for ProcurementOrders + ProcurementOrderLines sheets (P4).
 *
 * A Procurement Order (PO) is the "we plan to buy" doc — drafted by an
 * admin before any goods physically arrive. When goods arrive, the GRN
 * flow (P2) optionally references po_id so receipts can be reconciled
 * against the PO and the PO's status auto-advances:
 *   draft  →  sent  →  partially_received  →  received
 *                                          ↘ cancelled
 *
 * Why two sheets:
 *   - ProcurementOrders is the header (one row per PO).
 *   - ProcurementOrderLines is the line-item detail (N rows per PO,
 *     one per design/shade combo with planned qty).
 * This mirrors industry-standard ERP shape (PO header / PO lines)
 * and keeps each row narrow enough for spreadsheet display.
 *
 * Status transitions are emitted lazily — call recomputeStatus(poId)
 * after a GRN against this PO is recorded, and it'll reconcile the
 * `received_bales` totals across lines and set the header status.
 */

const sheets = require('./sheetsClient');
const idGenerator = require('../utils/idGenerator');

const HEADER_SHEET = 'ProcurementOrders';
const LINES_SHEET  = 'ProcurementOrderLines';

const HEADER_HEADERS = [
  'po_id', 'supplier', 'supplier_id', 'expected_date', 'status',
  'created_by', 'created_at', 'updated_at', 'photo_file_id', 'notes',
];

const LINE_HEADERS = [
  'line_id', 'po_id', 'design', 'shade', 'qty_bales', 'qty_yards',
  'unit_price', 'received_bales', 'received_yards',
];

const STATUSES = Object.freeze({
  DRAFT: 'draft',
  SENT: 'sent',
  PARTIALLY_RECEIVED: 'partially_received',
  RECEIVED: 'received',
  CANCELLED: 'cancelled',
});

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }

function parseHeader(r, rowIndex) {
  return {
    rowIndex,
    po_id: str(r[0]),
    supplier: str(r[1]),
    supplier_id: str(r[2]),
    expected_date: str(r[3]),
    status: str(r[4]) || STATUSES.DRAFT,
    created_by: str(r[5]),
    created_at: str(r[6]),
    updated_at: str(r[7]),
    photo_file_id: str(r[8]),
    notes: str(r[9]),
  };
}

function parseLine(r, rowIndex) {
  return {
    rowIndex,
    line_id: str(r[0]),
    po_id: str(r[1]),
    design: str(r[2]),
    shade: str(r[3]),
    qty_bales: num(r[4]),
    qty_yards: num(r[5]),
    unit_price: num(r[6]),
    received_bales: num(r[7]),
    received_yards: num(r[8]),
  };
}

// ---------------------------------------------------------------------------
// Header reads/writes
// ---------------------------------------------------------------------------

async function getAll() {
  const rows = await sheets.readRange(HEADER_SHEET, 'A2:J');
  return rows.map((r, i) => parseHeader(r, i + 2)).filter((p) => p.po_id);
}

async function getById(poId) {
  const all = await getAll();
  return all.find((p) => p.po_id === str(poId)) || null;
}

async function getOpen() {
  const all = await getAll();
  const open = new Set([STATUSES.DRAFT, STATUSES.SENT, STATUSES.PARTIALLY_RECEIVED]);
  return all.filter((p) => open.has(p.status));
}

async function appendHeader(po) {
  const poId = po.po_id || idGenerator.procurementOrder();
  const now = new Date().toISOString();
  const row = [
    poId,
    po.supplier || '',
    po.supplier_id || '',
    po.expected_date || '',
    po.status || STATUSES.DRAFT,
    po.created_by || '',
    po.created_at || now,
    po.updated_at || now,
    po.photo_file_id || '',
    po.notes || '',
  ];
  await sheets.appendRows(HEADER_SHEET, [row]);
  return { ...po, po_id: poId, status: row[4], created_at: row[6], updated_at: row[7] };
}

async function setStatus(poId, status) {
  const header = await getById(poId);
  if (!header) return null;
  const now = new Date().toISOString();
  await sheets.batchUpdateRanges(HEADER_SHEET, [
    { range: `E${header.rowIndex}`, values: [[status]] },
    { range: `H${header.rowIndex}`, values: [[now]] },
  ]);
  return { ...header, status, updated_at: now };
}

// ---------------------------------------------------------------------------
// Lines reads/writes
// ---------------------------------------------------------------------------

async function getLines(poId) {
  const rows = await sheets.readRange(LINES_SHEET, 'A2:I');
  return rows
    .map((r, i) => parseLine(r, i + 2))
    .filter((l) => l.line_id && l.po_id === str(poId));
}

async function appendLines(poId, lines) {
  if (!Array.isArray(lines) || !lines.length) return [];
  const rows = lines.map((l) => [
    l.line_id || idGenerator.generate('POL'),
    poId,
    l.design || '',
    l.shade || '',
    l.qty_bales || 0,
    l.qty_yards || 0,
    l.unit_price || 0,
    l.received_bales || 0,
    l.received_yards || 0,
  ]);
  await sheets.appendRows(LINES_SHEET, rows);
  return rows.map((r) => ({
    line_id: r[0], po_id: r[1], design: r[2], shade: r[3],
    qty_bales: r[4], qty_yards: r[5], unit_price: r[6],
    received_bales: r[7], received_yards: r[8],
  }));
}

/**
 * Apply received quantities to a PO's lines (called by the GRN handler).
 *
 * The bales array shape: [{ design, shade, qty_bales, qty_yards }, ...]
 * Lines are matched by (design, shade) — case-insensitive. Unmatched bales
 * are returned in `unmatched` so the caller can log/warn.
 */
async function applyReceived(poId, bales) {
  const lines = await getLines(poId);
  if (!lines.length) return { ok: false, message: 'PO has no lines.' };
  const norm = (s) => (s || '').toString().trim().toLowerCase();
  const updates = [];
  const unmatched = [];
  for (const b of (bales || [])) {
    const m = lines.find((l) => norm(l.design) === norm(b.design) && norm(l.shade) === norm(b.shade));
    if (!m) { unmatched.push(b); continue; }
    m.received_bales += (b.qty_bales || 0);
    m.received_yards += (b.qty_yards || 0);
    updates.push({ range: `H${m.rowIndex}:I${m.rowIndex}`, values: [[m.received_bales, m.received_yards]] });
  }
  if (updates.length) await sheets.batchUpdateRanges(LINES_SHEET, updates);
  return { ok: true, updatedLines: updates.length, unmatched };
}

/**
 * Recompute the header's status based on its lines' received vs. ordered
 * quantities. Pure: doesn't fetch state from anywhere except the sheets.
 *   all received_bales >= qty_bales  →  received
 *   any received_bales > 0            →  partially_received
 *   otherwise                          →  unchanged (caller decides
 *                                          whether to bump draft→sent)
 */
async function recomputeStatus(poId) {
  const header = await getById(poId);
  if (!header) return null;
  if (header.status === STATUSES.CANCELLED || header.status === STATUSES.DRAFT) return header;
  const lines = await getLines(poId);
  if (!lines.length) return header;
  const allReceived = lines.every((l) => l.received_bales >= l.qty_bales && l.qty_bales > 0);
  const anyReceived = lines.some((l) => l.received_bales > 0);
  let newStatus = header.status;
  if (allReceived) newStatus = STATUSES.RECEIVED;
  else if (anyReceived) newStatus = STATUSES.PARTIALLY_RECEIVED;
  if (newStatus !== header.status) return setStatus(poId, newStatus);
  return header;
}

module.exports = {
  HEADER_SHEET, LINES_SHEET,
  STATUSES,
  getAll, getById, getOpen,
  appendHeader, setStatus,
  getLines, appendLines,
  applyReceived, recomputeStatus,
};
