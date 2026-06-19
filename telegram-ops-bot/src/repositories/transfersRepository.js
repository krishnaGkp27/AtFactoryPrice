/**
 * Data access for the `Transfers` sheet (TRF-1).
 *
 * One row per warehouse→warehouse transfer, tracking its full lifecycle:
 *   requested → in_transit → received   (or → cancelled / declined)
 *
 * The selected bale identifiers (packageNos) live in `items_json` so the
 * inventory layer can flip exactly those rows; the staged accept/confirm
 * routing reads source_person / dest_person.
 *
 * Columns:
 *   A transfer_id        TR-<short>
 *   B from_warehouse
 *   C to_warehouse
 *   D items_json         [{ design, shade, qty, bales:[packageNo…] }]
 *   E status             requested | in_transit | received | declined | cancelled
 *   F requested_by       admin user_id
 *   G requested_at       ISO
 *   H source_person      user_id who accepts/dispatches
 *   I dispatched_at      ISO (set on source accept)
 *   J dest_person        user_id who confirms receipt
 *   K received_at        ISO (set on dest confirm)
 *   L note               decline/reject reason or discrepancy
 *   M requested_by_name  display helper
 */

'use strict';

const sheets = require('./sheetsClient');

const SHEET = 'Transfers';
const HEADERS = [
  'transfer_id', 'from_warehouse', 'to_warehouse', 'items_json', 'status',
  'requested_by', 'requested_at', 'source_person', 'dispatched_at',
  'dest_person', 'received_at', 'note', 'requested_by_name',
];

const STATUSES = Object.freeze({
  REQUESTED: 'requested',
  IN_TRANSIT: 'in_transit',
  RECEIVED: 'received',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
});

function str(v) { return (v ?? '').toString().trim(); }

function parseItems(raw) {
  const s = str(raw);
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function parse(r, rowIndex) {
  return {
    rowIndex,
    transfer_id: str(r[0]),
    from_warehouse: str(r[1]),
    to_warehouse: str(r[2]),
    items: parseItems(r[3]),
    status: str(r[4]) || STATUSES.REQUESTED,
    requested_by: str(r[5]),
    requested_at: str(r[6]),
    source_person: str(r[7]),
    dispatched_at: str(r[8]),
    dest_person: str(r[9]),
    received_at: str(r[10]),
    note: str(r[11]),
    requested_by_name: str(r[12]),
  };
}

/** All packageNos referenced by a transfer's items — the rows inventory flips. */
function packageNosOf(transfer) {
  const out = [];
  for (const it of (transfer.items || [])) {
    for (const b of (it.bales || [])) out.push(String(b));
  }
  return out;
}

function toRow(t) {
  return [
    str(t.transfer_id),
    str(t.from_warehouse),
    str(t.to_warehouse),
    JSON.stringify(Array.isArray(t.items) ? t.items : []),
    str(t.status) || STATUSES.REQUESTED,
    str(t.requested_by),
    t.requested_at || new Date().toISOString(),
    str(t.source_person),
    str(t.dispatched_at),
    str(t.dest_person),
    str(t.received_at),
    str(t.note),
    str(t.requested_by_name),
  ];
}

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:M1');
  if (!rows.length || rows[0].length < HEADERS.length) {
    await sheets.updateRange(SHEET, 'A1:M1', [HEADERS]);
  }
}

async function getAll() {
  try {
    const rows = await sheets.readRange(SHEET, 'A2:M');
    return rows.map((r, i) => parse(r, i + 2)).filter((t) => t.transfer_id);
  } catch (_) {
    return [];
  }
}

async function findById(transferId) {
  const all = await getAll();
  return all.find((t) => t.transfer_id === String(transferId)) || null;
}

/** Transfers whose bales are currently sitting at `warehouse` as in_transit. */
async function getInTransitTo(warehouse) {
  const w = String(warehouse || '').trim().toLowerCase();
  const all = await getAll();
  return all.filter((t) => t.status === STATUSES.IN_TRANSIT
    && String(t.to_warehouse || '').trim().toLowerCase() === w);
}

async function append(transfer) {
  await ensureHeader();
  await sheets.appendRows(SHEET, [toRow(transfer)]);
  return transfer;
}

/**
 * Merge `patch` into an existing transfer row and persist the whole row.
 * Returns the merged transfer, or false if not found.
 */
async function update(transferId, patch) {
  const t = await findById(transferId);
  if (!t) return false;
  const merged = { ...t, ...patch };
  await sheets.updateRange(SHEET, `A${t.rowIndex}:M${t.rowIndex}`, [toRow(merged)]);
  return merged;
}

module.exports = {
  getAll,
  findById,
  getInTransitTo,
  append,
  update,
  packageNosOf,
  ensureHeader,
  SHEET,
  HEADERS,
  STATUSES,
};
