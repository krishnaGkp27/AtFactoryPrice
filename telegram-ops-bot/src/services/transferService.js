'use strict';

/**
 * transferService — warehouse→warehouse transfer logic (TRF-2, lean).
 *
 * The transfer request rides an ApprovalQueue row (NO dedicated sheet —
 * owner decision, spec §2): actionJSON carries the payload, `stage`
 * advances requested→in_transit via updateActionJSON, and the terminal
 * state lands via updateStatus ('approved' = received, 'rejected' =
 * declined/rejected). History: AuditLog events + one Transactions row on
 * completion.
 *
 * Inventory effects (existing transitionBales; Status column only):
 *   create   available  → in_transit @ destination (visible, not sellable)
 *   dispatch (no inventory change — operational ack by the source person)
 *   receive  in_transit → available  @ destination (now sellable)
 *   abort    in_transit → available  @ source      (decline/reject revert)
 */

const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const transactionsRepository = require('../repositories/transactionsRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const idGenerator = require('../utils/idGenerator');

const ACTION = 'transfer_stock';
const AVAILABLE = 'available';
const IN_TRANSIT = 'in_transit';
const STAGES = Object.freeze({ REQUESTED: 'requested', IN_TRANSIT: 'in_transit' });

function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

/* ── pure selection helpers (operate on an inventory snapshot) ─────────── */

/**
 * Distinct AVAILABLE bale packageNos of a design+shade in a warehouse.
 * @returns {string[]} packageNos in sheet order
 */
function availableBales(inventory, warehouse, design, shade) {
  const w = norm(warehouse);
  const d = norm(design);
  const s = norm(shade);
  const seen = new Set();
  const out = [];
  for (const r of (inventory || [])) {
    if (r.status !== AVAILABLE) continue;
    if (norm(r.warehouse) !== w || norm(r.design) !== d || norm(r.shade) !== s) continue;
    const pkg = String(r.packageNo);
    if (!seen.has(pkg)) { seen.add(pkg); out.push(pkg); }
  }
  return out;
}

/**
 * Auto-pick the first `qty` available bales of design+shade (sheet order).
 * @returns {{ ok:boolean, bales:string[], available:number }}
 */
function selectByQuantity(inventory, fromWarehouse, design, shade, qty) {
  const n = Math.max(0, parseInt(qty, 10) || 0);
  const bales = availableBales(inventory, fromWarehouse, design, shade);
  return { ok: n > 0 && bales.length >= n, bales: bales.slice(0, n), available: bales.length };
}

/* ── lifecycle (queue-carried) ─────────────────────────────────────────── */

/** Open (pending) transfer rows, newest last. */
async function getOpenTransfers() {
  const pending = await approvalQueueRepository.getAllPending();
  return pending.filter((p) => p.actionJSON && p.actionJSON.action === ACTION);
}

/** One transfer row by id (any status). Null when not a transfer. */
async function findTransfer(requestId) {
  const row = await approvalQueueRepository.getByRequestId(requestId);
  if (!row || !row.actionJSON || row.actionJSON.action !== ACTION) return null;
  return row;
}

/**
 * Create a transfer: bales → in_transit @ destination, queue row appended.
 * @returns {Promise<{requestId:string, aj:object}>}
 */
async function createTransfer({ from, to, design, shade, qty, bales, requestedBy, dispatcher, receiver }) {
  const requestId = idGenerator.transfer();
  const aj = {
    action: ACTION,
    from, to, design, shade,
    qty: bales.length || qty,
    bales: bales.map(String),
    dispatcher: String(dispatcher || ''),
    receiver: String(receiver || ''),
    stage: STAGES.REQUESTED,
  };
  await inventoryRepository.transitionBales(aj.bales, AVAILABLE, IN_TRANSIT, to);
  await approvalQueueRepository.append({
    requestId, user: String(requestedBy || ''),
    actionJSON: aj,
    riskReason: 'Warehouse transfer — dispatcher + receiver confirmation chain.',
    status: 'pending',
  });
  await auditLogRepository.append('transfer.requested', { requestId, from, to, design, shade, qty: aj.qty }, String(requestedBy || ''));
  return { requestId, aj };
}

/**
 * Source dispatcher accepts: stage requested → in_transit (ack only).
 * @returns {Promise<{ok:boolean, aj?:object, message?:string}>}
 */
async function dispatch(requestId, byUserId) {
  const row = await findTransfer(requestId);
  if (!row) return { ok: false, message: 'transferService: transfer not found' };
  if (row.status !== 'pending' || row.actionJSON.stage !== STAGES.REQUESTED) {
    return { ok: false, message: `transferService: cannot dispatch (${row.status}/${row.actionJSON.stage})` };
  }
  await approvalQueueRepository.updateActionJSON(requestId, { stage: STAGES.IN_TRANSIT, dispatchedAt: new Date().toISOString() });
  await auditLogRepository.append('transfer.dispatched', { requestId }, String(byUserId || ''));
  return { ok: true, aj: { ...row.actionJSON, stage: STAGES.IN_TRANSIT } };
}

/**
 * Destination receiver confirms: bales sellable @ destination; row closed.
 * @returns {Promise<{ok:boolean, aj?:object, message?:string}>}
 */
async function confirmReceipt(requestId, byUserId) {
  const row = await findTransfer(requestId);
  if (!row) return { ok: false, message: 'transferService: transfer not found' };
  if (row.status !== 'pending' || row.actionJSON.stage !== STAGES.IN_TRANSIT) {
    return { ok: false, message: `transferService: cannot confirm (${row.status}/${row.actionJSON.stage})` };
  }
  const aj = row.actionJSON;
  await inventoryRepository.transitionBales(aj.bales || [], IN_TRANSIT, AVAILABLE, null);
  await approvalQueueRepository.updateStatus(requestId, 'approved', new Date().toISOString());
  await transactionsRepository.append({
    user: String(byUserId || ''), action: ACTION, design: aj.design || '', color: aj.shade || '',
    qty: aj.qty || (aj.bales || []).length, before: aj.from || '', after: aj.to || '', status: 'completed',
  });
  await auditLogRepository.append('transfer.received', { requestId }, String(byUserId || ''));
  return { ok: true, aj };
}

/**
 * Decline (pre-dispatch) or reject (in transit): bales revert to source.
 * @returns {Promise<{ok:boolean, aj?:object, kind?:string, message?:string}>}
 */
async function abort(requestId, byUserId) {
  const row = await findTransfer(requestId);
  if (!row) return { ok: false, message: 'transferService: transfer not found' };
  if (row.status !== 'pending') return { ok: false, message: `transferService: transfer already ${row.status}` };
  const aj = row.actionJSON;
  const kind = aj.stage === STAGES.IN_TRANSIT ? 'rejected' : 'declined';
  await inventoryRepository.transitionBales(aj.bales || [], IN_TRANSIT, AVAILABLE, aj.from);
  await approvalQueueRepository.updateStatus(requestId, 'rejected', new Date().toISOString());
  await auditLogRepository.append(`transfer.${kind}`, { requestId }, String(byUserId || ''));
  return { ok: true, aj, kind };
}

module.exports = {
  ACTION,
  STAGES,
  availableBales,
  selectByQuantity,
  getOpenTransfers,
  findTransfer,
  createTransfer,
  dispatch,
  confirmReceipt,
  abort,
};
