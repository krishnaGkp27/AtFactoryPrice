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
 *   source          — origin tag: 'manual' | 'bulk_csv' | 'bulk_xlsx' |
 *                     'ocr_vision_*' (P2.5 + P5)
 *   file_hash       — 16-hex sha256 prefix of the original upload; populated
 *                     for any non-manual receipt. Used by getByFileHash() to
 *                     reject duplicate re-uploads of the same file.
 *   source_url      — FILE-C1: clickable Google Drive webViewLink to the
 *                     original photo / PDF / CSV / XLSX. Empty when Drive
 *                     backup wasn't configured or failed.
 *   source_filename — FILE-C1: the human-readable filename the bot saved
 *                     into Drive, e.g.
 *                     `2026-05-15__abdul__packing-slip__a3f4b9c2.jpg`.
 *                     Mirrors what's in the Drive folder so an operator
 *                     can search either surface independently.
 */

const sheets = require('./sheetsClient');
const idGenerator = require('../utils/idGenerator');

const SHEET = 'GoodsReceipts';
const HEADERS = [
  'grn_id', 'warehouse', 'supplier', 'supplier_id', 'po_id',
  'received_by', 'received_at', 'total_bales', 'total_yards',
  'photo_file_id', 'notes', 'status',
  // P2.5 — bulk-import provenance. Both columns are empty for the
  // interactive (manual) GRN flow created in P2.
  'source', 'file_hash',
  // FILE-C1 — Drive backup link + readable filename, populated for
  // any non-manual receipt (bulk CSV/XLSX, photo OCR). Empty for
  // interactive GRNs that don't upload a source file.
  'source_url', 'source_filename',
  // LANDED-COST C1 — see schemaMapper.js for column semantics.
  'lc_status', 'lc_usd_per_yard', 'lc_charges_usd', 'lc_fx_rate',
  'lc_ngn_per_yard', 'lc_finalized_at', 'lc_finalized_by', 'lc_request_id',
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
    source: str(r[12]) || 'manual',
    file_hash: str(r[13]),
    // FILE-C1: clickable link + readable filename for non-manual receipts.
    source_url: str(r[14]),
    source_filename: str(r[15]),
    // LANDED-COST C1. All blank on a freshly-received GRN.
    lc_status: str(r[16]) || 'provisional',
    lc_usd_per_yard:  num(r[17]),
    lc_charges_usd:   num(r[18]),
    lc_fx_rate:       num(r[19]),
    lc_ngn_per_yard:  num(r[20]),
    lc_finalized_at:  str(r[21]),
    lc_finalized_by:  str(r[22]),
    lc_request_id:    str(r[23]),
  };
}

async function getAll() {
  // LANDED-COST C1: read range extended from P (16 cols) to X (24 cols)
  // to pick up the 8 landed-cost finalisation columns. Older deployments
  // missing those cells just yield empty strings / 0 via parse().
  const rows = await sheets.readRange(SHEET, 'A2:X');
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
 * Look up a GRN by the file_hash of its originating upload. Used by the
 * bulk-receive flow to reject duplicate re-uploads of the same file
 * before any sheet write happens.
 *
 * Returns null when no match (the common case — the user is uploading
 * a fresh file).
 */
async function getByFileHash(fileHash) {
  const h = str(fileHash);
  if (!h) return null;
  const all = await getAll();
  return all.find((g) => g.file_hash === h) || null;
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
    grn.source || 'manual',
    grn.file_hash || '',
    // FILE-C1
    grn.source_url || '',
    grn.source_filename || '',
    // LANDED-COST C1 — fresh GRNs land as `provisional`. The flow + the
    // approval handler are the only callers that flip these.
    grn.lc_status || 'provisional',
    grn.lc_usd_per_yard || '',
    grn.lc_charges_usd || '',
    grn.lc_fx_rate || '',
    grn.lc_ngn_per_yard || '',
    grn.lc_finalized_at || '',
    grn.lc_finalized_by || '',
    grn.lc_request_id || '',
  ];
  await sheets.appendRows(SHEET, [row]);
  return {
    ...grn,
    grn_id: grnId,
    received_at: row[6],
    status: row[11],
    source: row[12],
    file_hash: row[13],
    source_url: row[14],
    source_filename: row[15],
    lc_status: row[16],
  };
}

/**
 * LANDED-COST C1 — flip a GRN to `pending_approval` while the dual-admin
 * approval is in flight, and stamp the request_id so we can find it
 * back from the approval queue payload.
 */
async function markPendingLandedCost(grnId, requestId) {
  const grn = await getById(grnId);
  if (!grn) throw new Error(`GRN ${grnId} not found`);
  const rowNum = grn.rowIndex;
  // Cols Q..X = lc_status .. lc_request_id (8 cols).
  await sheets.updateRange(SHEET, `Q${rowNum}:X${rowNum}`, [[
    'pending_approval', '', '', '', '', '', '', String(requestId || ''),
  ]]);
  return true;
}

/**
 * LANDED-COST C1 — write the finalized landed-cost numbers on the GRN
 * row once the dual-admin approval lands. Called from
 * inventoryService.executeApprovedAction for action=finalize_landed_cost.
 */
async function finalizeLandedCost(grnId, payload) {
  const grn = await getById(grnId);
  if (!grn) throw new Error(`GRN ${grnId} not found`);
  const rowNum = grn.rowIndex;
  const { usdPerYard, chargesUsd, fxRate, ngnPerYard, finalizedAt, finalizedBy, requestId } = payload;
  await sheets.updateRange(SHEET, `Q${rowNum}:X${rowNum}`, [[
    'finalized',
    Number(usdPerYard) || 0,
    Number(chargesUsd) || 0,
    Number(fxRate) || 0,
    Number(ngnPerYard) || 0,
    finalizedAt || new Date().toISOString(),
    finalizedBy || '',
    requestId || '',
  ]]);
  return true;
}

/**
 * LANDED-COST C1 — reset a GRN's landed-cost state to `provisional` so
 * an admin can re-submit. Called when a finalize request is declined.
 */
async function clearPendingLandedCost(grnId) {
  const grn = await getById(grnId);
  if (!grn) throw new Error(`GRN ${grnId} not found`);
  const rowNum = grn.rowIndex;
  await sheets.updateRange(SHEET, `Q${rowNum}:X${rowNum}`, [[
    'provisional', '', '', '', '', '', '', '',
  ]]);
  return true;
}

module.exports = {
  getAll, getById, getByWarehouse, getByFileHash, append,
  markPendingLandedCost, finalizeLandedCost, clearPendingLandedCost,
  SHEET, HEADERS,
};
