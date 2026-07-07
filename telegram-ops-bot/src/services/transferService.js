'use strict';

/**
 * transferService — warehouse→warehouse transfer logic (TRF-3, lean).
 *
 * The transfer request rides an ApprovalQueue row (NO dedicated sheet —
 * owner decision): actionJSON carries multi-line ORDER payload
 * `lines: [{design, shade, qty}]`. The admin's request reserves nothing —
 * the DISPATCHER's accept is the moment the actual physical bales are
 * logged (live-selected, sheet order) and flipped to in_transit at the
 * destination. Short stock at dispatch time → partial dispatch with the
 * shortfall recorded per line.
 *
 *   create   (order only — no inventory change, source keeps selling)
 *   dispatch  live-select bales per line → available → in_transit @ dest
 *   receive   in_transit → available @ destination (now sellable)
 *   abort     pre-dispatch decline: close only (nothing was moved);
 *             post-dispatch reject: in_transit → available @ source
 *
 * Terminal state via updateStatus ('approved' = received, 'rejected' =
 * declined/rejected); history = AuditLog + one Transactions row on receipt.
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
 * Pick up to `qty` available bales of design+shade (sheet order).
 * `bales` holds what could be picked even when short (ok=false).
 * @returns {{ ok:boolean, bales:string[], available:number }}
 */
function selectByQuantity(inventory, fromWarehouse, design, shade, qty) {
  const n = Math.max(0, parseInt(qty, 10) || 0);
  const bales = availableBales(inventory, fromWarehouse, design, shade);
  return { ok: n > 0 && bales.length >= n, bales: bales.slice(0, n), available: bales.length };
}

/* ── lifecycle (queue-carried) ─────────────────────────────────────────── */

/** Open (pending) transfer rows. */
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
 * Create a transfer ORDER: queue row only — no bales are picked or locked
 * yet (the dispatcher logs the physical bales at dispatch time).
 * @param {{from:string,to:string,lines:Array<{design:string,shade:string,qty:number}>,requestedBy:string,dispatcher:string,receiver:string}} p
 * @returns {Promise<{requestId:string, aj:object}>}
 */
async function createTransferRequest({ from, to, lines, requestedBy, dispatcher, receiver }) {
  const cleanLines = (lines || [])
    .map((l) => ({ design: l.design, shade: l.shade, qty: Math.max(0, parseInt(l.qty, 10) || 0) }))
    .filter((l) => l.design && l.qty > 0);
  if (!cleanLines.length) throw new Error('transferService: at least one line with qty > 0 required');
  const requestId = idGenerator.transfer();
  const aj = {
    action: ACTION,
    from, to,
    lines: cleanLines,
    dispatcher: String(dispatcher || ''),
    receiver: String(receiver || ''),
    stage: STAGES.REQUESTED,
  };
  await approvalQueueRepository.append({
    requestId, user: String(requestedBy || ''),
    actionJSON: aj,
    riskReason: 'Warehouse transfer — dispatcher + receiver confirmation chain.',
    status: 'pending',
  });
  await auditLogRepository.append('transfer.requested', { requestId, from, to, lines: cleanLines }, String(requestedBy || ''));
  return { requestId, aj };
}

/**
 * Dispatcher accepts: log the ACTUAL bales now — live-select per line,
 * flip them in_transit @ destination, record per-line sent vs requested.
 * Partial dispatch allowed; fails only when nothing is available at all.
 * @returns {Promise<{ok:boolean, aj?:object, short?:boolean, message?:string}>}
 */
async function dispatch(requestId, byUserId) {
  const row = await findTransfer(requestId);
  if (!row) return { ok: false, message: 'transferService: transfer not found' };
  if (row.status !== 'pending' || row.actionJSON.stage !== STAGES.REQUESTED) {
    return { ok: false, message: `transferService: cannot dispatch (${row.status}/${row.actionJSON.stage})` };
  }
  const aj = row.actionJSON;
  const inv = await inventoryRepository.getAll();
  const picked = [];
  const dispatched = [];
  for (const l of (aj.lines || [])) {
    const sel = selectByQuantity(inv, aj.from, l.design, l.shade, l.qty);
    picked.push(...sel.bales);
    dispatched.push({ design: l.design, shade: l.shade, requested: l.qty, sent: sel.bales.length });
  }
  if (!picked.length) {
    return { ok: false, message: 'No stock left for any line — decline the transfer instead.' };
  }
  const short = dispatched.some((d) => d.sent < d.requested);
  await inventoryRepository.transitionBales(picked, AVAILABLE, IN_TRANSIT, aj.to);
  const patch = { stage: STAGES.IN_TRANSIT, bales: picked, dispatched, short, dispatchedAt: new Date().toISOString() };
  await approvalQueueRepository.updateActionJSON(requestId, patch);
  await auditLogRepository.append('transfer.dispatched', { requestId, dispatched, short }, String(byUserId || ''));
  return { ok: true, aj: { ...aj, ...patch }, short };
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
  const totalSent = (aj.dispatched || []).reduce((s, d) => s + d.sent, 0) || (aj.bales || []).length;
  await transactionsRepository.append({
    user: String(byUserId || ''), action: ACTION,
    design: (aj.lines || []).map((l) => l.design).join('+'),
    color: (aj.lines || []).map((l) => l.shade).join('+'),
    qty: totalSent, before: aj.from || '', after: aj.to || '', status: 'completed',
  });
  await auditLogRepository.append('transfer.received', { requestId }, String(byUserId || ''));
  return { ok: true, aj };
}

/**
 * Decline (pre-dispatch: nothing was moved, just close) or reject
 * (post-dispatch: revert the logged bales to the source).
 * @returns {Promise<{ok:boolean, aj?:object, kind?:string, message?:string}>}
 */
async function abort(requestId, byUserId) {
  const row = await findTransfer(requestId);
  if (!row) return { ok: false, message: 'transferService: transfer not found' };
  if (row.status !== 'pending') return { ok: false, message: `transferService: transfer already ${row.status}` };
  const aj = row.actionJSON;
  const kind = aj.stage === STAGES.IN_TRANSIT ? 'rejected' : 'declined';
  if (kind === 'rejected') {
    // Bales were logged at dispatch — send them home.
    await inventoryRepository.transitionBales(aj.bales || [], IN_TRANSIT, AVAILABLE, aj.from);
  }
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
  createTransferRequest,
  dispatch,
  confirmReceipt,
  abort,
};
