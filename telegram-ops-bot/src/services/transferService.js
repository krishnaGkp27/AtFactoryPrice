/**
 * transferService — warehouse→warehouse transfer logic (TRF-1).
 *
 * Two concerns:
 *   1. Pure bale-selection helpers (operate on a passed inventory snapshot,
 *      no I/O) used by the create wizard.
 *   2. Lifecycle orchestration (createTransfer / dispatch / confirmReceipt /
 *      abort) that drives the Transfers sheet and flips the matching bales
 *      via inventoryRepository.transitionBales.
 *
 * Inventory effects (see specs/warehouse-transfer.md):
 *   created     available → in_transit @ destination  (visible at dest, not sellable)
 *   dispatched  (no inventory change — operational ack)
 *   received    in_transit → available @ destination  (now sellable)
 *   aborted     in_transit → available @ source        (reverted)
 */

'use strict';

const transfersRepo = require('../repositories/transfersRepository');
const inventoryRepo = require('../repositories/inventoryRepository');
const idGenerator = require('../utils/idGenerator');

const { STATUSES } = transfersRepo;
const AVAILABLE = 'available';
const IN_TRANSIT = 'in_transit';

function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

/**
 * Distinct AVAILABLE bale packageNos of a design+shade in a warehouse.
 * @returns {string[]} packageNos, in sheet order
 */
function availableBales(inventory, warehouse, design, shade) {
  const w = norm(warehouse);
  const d = norm(design);
  const s = norm(shade);
  const seen = new Set();
  const out = [];
  for (const r of (inventory || [])) {
    if (r.status !== AVAILABLE) continue;
    if (norm(r.warehouse) !== w) continue;
    if (norm(r.design) !== d) continue;
    if (norm(r.shade) !== s) continue;
    const pkg = String(r.packageNo);
    if (!seen.has(pkg)) { seen.add(pkg); out.push(pkg); }
  }
  return out;
}

/**
 * Select bales for a list of { design, shade, qty } requests from a warehouse.
 * qty is a BALE count. Picks the first `qty` available bales per request.
 * @returns {{ ok:boolean, items:Array, shortfalls:Array }}
 */
function selectByQuantity(inventory, fromWarehouse, requests) {
  const items = [];
  const shortfalls = [];
  for (const req of (requests || [])) {
    const qty = Math.max(0, parseInt(req.qty, 10) || 0);
    const bales = availableBales(inventory, fromWarehouse, req.design, req.shade);
    if (bales.length < qty) {
      shortfalls.push({
        design: req.design, shade: req.shade, requested: qty, available: bales.length,
      });
    }
    const take = bales.slice(0, qty);
    if (take.length) {
      items.push({ design: req.design, shade: req.shade, qty: take.length, bales: take });
    }
  }
  return { ok: shortfalls.length === 0 && items.length > 0, items, shortfalls };
}

/**
 * Select by explicit bale numbers; validates each packageNo is AVAILABLE in the
 * source warehouse and groups them into items by design+shade.
 * @returns {{ ok:boolean, items:Array, missing:string[] }}
 */
function selectByBaleNumbers(inventory, fromWarehouse, packageNos) {
  const wanted = new Set((packageNos || []).map((p) => String(p).trim()).filter(Boolean));
  const w = norm(fromWarehouse);
  const groups = new Map();
  const found = new Set();
  for (const r of (inventory || [])) {
    const pkg = String(r.packageNo);
    if (!wanted.has(pkg)) continue;
    if (r.status !== AVAILABLE) continue;
    if (norm(r.warehouse) !== w) continue;
    found.add(pkg);
    const key = `${norm(r.design)}||${norm(r.shade)}`;
    if (!groups.has(key)) groups.set(key, { design: r.design, shade: r.shade, bales: new Set() });
    groups.get(key).bales.add(pkg);
  }
  const missing = [...wanted].filter((p) => !found.has(p));
  const items = [...groups.values()].map((g) => ({
    design: g.design, shade: g.shade, qty: g.bales.size, bales: [...g.bales],
  }));
  return { ok: missing.length === 0 && items.length > 0, items, missing };
}

// ---------------------------------------------------------------------------
// Lifecycle orchestration
// ---------------------------------------------------------------------------

/**
 * Create a transfer: persist the row and move its bales to in_transit @ dest.
 * @returns {Promise<object>} the created transfer
 */
async function createTransfer({
  fromWarehouse, toWarehouse, items, requestedBy, requestedByName, sourcePerson, destPerson,
}) {
  const transfer = {
    transfer_id: idGenerator.transfer(),
    from_warehouse: fromWarehouse,
    to_warehouse: toWarehouse,
    items: items || [],
    status: STATUSES.REQUESTED,
    requested_by: String(requestedBy || ''),
    requested_at: new Date().toISOString(),
    source_person: String(sourcePerson || ''),
    dest_person: String(destPerson || ''),
    requested_by_name: requestedByName || '',
  };
  const pkgs = transfersRepo.packageNosOf(transfer);
  // available → in_transit, warehouse rewritten to destination.
  await inventoryRepo.transitionBales(pkgs, AVAILABLE, IN_TRANSIT, toWarehouse);
  await transfersRepo.append(transfer);
  return transfer;
}

/**
 * Source dispatcher accepts: requested → in_transit (operational ack; bales
 * already in_transit @ dest). No inventory change.
 * @returns {Promise<{ok:boolean, transfer?:object, message?:string}>}
 */
async function dispatch(transferId) {
  const t = await transfersRepo.findById(transferId);
  if (!t) return { ok: false, message: 'transferService: transfer not found' };
  if (t.status !== STATUSES.REQUESTED) {
    return { ok: false, message: `transferService: cannot dispatch a ${t.status} transfer` };
  }
  const transfer = await transfersRepo.update(transferId, {
    status: STATUSES.IN_TRANSIT,
    dispatched_at: new Date().toISOString(),
  });
  return { ok: true, transfer };
}

/**
 * Destination receiver confirms: in_transit → received; bales become available
 * (sellable) at the destination warehouse.
 * @returns {Promise<{ok:boolean, transfer?:object, message?:string}>}
 */
async function confirmReceipt(transferId) {
  const t = await transfersRepo.findById(transferId);
  if (!t) return { ok: false, message: 'transferService: transfer not found' };
  if (t.status !== STATUSES.IN_TRANSIT) {
    return { ok: false, message: `transferService: cannot confirm a ${t.status} transfer` };
  }
  const pkgs = transfersRepo.packageNosOf(t);
  // in_transit → available; warehouse already destination, so leave it.
  await inventoryRepo.transitionBales(pkgs, IN_TRANSIT, AVAILABLE, null);
  const transfer = await transfersRepo.update(transferId, {
    status: STATUSES.RECEIVED,
    received_at: new Date().toISOString(),
  });
  return { ok: true, transfer };
}

/**
 * Abort a transfer before receipt: revert bales to AVAILABLE @ source.
 * `cancelled` for a source decline (pre-dispatch), `declined` for a dest reject.
 * @returns {Promise<{ok:boolean, transfer?:object, message?:string}>}
 */
async function abort(transferId, { reason = '', cancelled = false } = {}) {
  const t = await transfersRepo.findById(transferId);
  if (!t) return { ok: false, message: 'transferService: transfer not found' };
  const terminal = [STATUSES.RECEIVED, STATUSES.DECLINED, STATUSES.CANCELLED];
  if (terminal.includes(t.status)) {
    return { ok: false, message: `transferService: transfer already ${t.status}` };
  }
  const pkgs = transfersRepo.packageNosOf(t);
  // in_transit → available, warehouse back to source.
  await inventoryRepo.transitionBales(pkgs, IN_TRANSIT, AVAILABLE, t.from_warehouse);
  const transfer = await transfersRepo.update(transferId, {
    status: cancelled ? STATUSES.CANCELLED : STATUSES.DECLINED,
    note: reason || '',
  });
  return { ok: true, transfer };
}

module.exports = {
  availableBales,
  selectByQuantity,
  selectByBaleNumbers,
  createTransfer,
  dispatch,
  confirmReceipt,
  abort,
  AVAILABLE,
  IN_TRANSIT,
};
