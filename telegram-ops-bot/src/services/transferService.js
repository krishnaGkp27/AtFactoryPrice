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
const mutex = require('../utils/asyncMutex');

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

/**
 * Open transfers waiting on a specific user's action (their "queue"):
 * stage `requested` → waiting on the dispatcher; stage `in_transit` →
 * waiting on the receiver. Feeds the My Tasks transfer section.
 * @param {string} userId Telegram id
 * @returns {Promise<Array>} pending ApprovalQueue rows where this user is the pending actor
 */
async function getActionableFor(userId) {
  const uid = String(userId);
  const open = await getOpenTransfers();
  return open.filter((t) => {
    const aj = t.actionJSON;
    if (aj.stage === STAGES.REQUESTED) return String(aj.dispatcher) === uid;
    if (aj.stage === STAGES.IN_TRANSIT) return String(aj.receiver) === uid;
    return false;
  });
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
/**
 * TRID-1 — mint TR-YYYYMMDD-NNN with the sequence seeded from the queue
 * itself. The old in-memory daily counter reset on every deploy and could
 * re-issue a live id (two transfers sharing TR-…-001 made all by-id routing
 * open the wrong one). Reading max(NNN) for today from the sheet survives
 * restarts; if the sheet is unreadable, a random high sequence beats
 * reusing a low live number.
 */
const _mintedFloor = {}; // date → highest seq handed out by THIS process
async function uniqueTransferId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let max = 0;
  try {
    const re = new RegExp(`^TR-${date}-(\\d+)$`);
    for (const row of await approvalQueueRepository.getAllWithRowIndex()) {
      const m = re.exec(String(row.requestId || ''));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch (_) {
    max = 500 + Math.floor(Math.random() * 400);
  }
  // In-process floor: two transfers created in one batch both read the
  // queue BEFORE either append lands — the sync floor bump below keeps
  // their sequences distinct (single-threaded, no await in between).
  const seq = Math.max(max, _mintedFloor[date] || 0) + 1;
  _mintedFloor[date] = seq;
  return `TR-${date}-${String(seq).padStart(3, '0')}`;
}

async function createTransferRequest({ from, to, lines, requestedBy, dispatcher, receiver }) {
  const cleanLines = (lines || [])
    .map((l) => ({ design: l.design, shade: l.shade, qty: Math.max(0, parseInt(l.qty, 10) || 0) }))
    .filter((l) => l.design && l.qty > 0);
  if (!cleanLines.length) throw new Error('transferService: at least one line with qty > 0 required');
  const requestId = await uniqueTransferId();
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
 * Dispatcher accepts: log the ACTUAL bales now — flip them in_transit @
 * destination, record per-line sent vs requested. Partial dispatch allowed;
 * fails only when nothing is available at all.
 *
 * When `manualPicks` is provided it is an array parallel to `aj.lines`, each
 * element a list of chosen packageNos for that line. Chosen bales are still
 * validated against LIVE availability (someone may have moved stock since the
 * picker opened), capped to the line qty, and de-duped. When omitted, bales
 * are auto-selected FIFO in sheet order (original TRF-3 behaviour, also used
 * by the picker's "Auto-pick remaining" path).
 *
 * @param {string} requestId
 * @param {string} byUserId
 * @param {Array<Array<string>>} [manualPicks] per-line chosen packageNos
 * @returns {Promise<{ok:boolean, aj?:object, short?:boolean, message?:string}>}
 */
async function dispatch(requestId, byUserId, manualPicks) {
  // SEC-P2 (H3): serialize the stage transition per request so a double-tapped
  // Dispatch (or Dispatch racing a Reject) can't both read stage=requested and
  // transition the same bales twice. The re-read + stage guard run inside the
  // lock, so the second caller sees the new stage and bails cleanly.
  return mutex.runExclusive(requestId, () => dispatchInner(requestId, byUserId, manualPicks));
}

async function dispatchInner(requestId, byUserId, manualPicks) {
  const row = await findTransfer(requestId);
  if (!row) return { ok: false, message: 'transferService: transfer not found' };
  if (row.status !== 'pending' || row.actionJSON.stage !== STAGES.REQUESTED) {
    return { ok: false, message: `transferService: cannot dispatch (${row.status}/${row.actionJSON.stage})` };
  }
  const aj = row.actionJSON;
  // TRF-INT1 — ONE dispatch at a time per SOURCE warehouse. The per-request
  // mutex cannot see a different transfer picking from the same shelf; two
  // overlapping dispatches reading one snapshot would both claim the same
  // bales. Nested key differs from the requestId key, so no deadlock.
  return mutex.runExclusive(`dispatch-wh:${norm(aj.from)}`,
    () => dispatchPickAndFlip(requestId, byUserId, manualPicks, aj));
}

async function dispatchPickAndFlip(requestId, byUserId, manualPicks, aj) {
  const inv = await inventoryRepository.getAll(true); // fresh, under the lock
  const useManual = Array.isArray(manualPicks);
  const picked = [];
  const dispatched = [];
  const lines = aj.lines || [];
  // TRF-INT1 — resolve every picked printed number to its exact rows inside
  // the pick's own scope (warehouse+design+shade). The printed number stays
  // the only thing the user sees (owner rule); the rows are what must move.
  const rowsOfPkg = (pkg, l) => inv.filter((r) => r.status === AVAILABLE
    && String(r.packageNo) === String(pkg)
    && norm(r.warehouse) === norm(aj.from)
    && norm(r.design) === norm(l.design)
    && norm(r.shade) === norm(l.shade));
  const pickedRows = [];
  const lineRowRefs = []; // per line: Map(pkg -> its resolved rows), captured AT PICK TIME
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    let balesForLine;
    if (useManual) {
      // Keep only chosen bales still available for this exact line, de-duped,
      // in the operator's tap order, capped to the requested qty.
      const availSet = new Set(availableBales(inv, aj.from, l.design, l.shade));
      const seen = new Set();
      balesForLine = [];
      for (const p of (manualPicks[i] || [])) {
        const pkg = String(p);
        if (availSet.has(pkg) && !seen.has(pkg)) { seen.add(pkg); balesForLine.push(pkg); }
        if (balesForLine.length >= l.qty) break;
      }
    } else {
      balesForLine = selectByQuantity(inv, aj.from, l.design, l.shade, l.qty).bales;
    }
    picked.push(...balesForLine);
    const refMap = new Map();
    for (const pkg of balesForLine) {
      const rows = rowsOfPkg(pkg, l);
      refMap.set(String(pkg), rows);
      pickedRows.push(...rows);
    }
    lineRowRefs.push(refMap);
    // TRF-12 — keep the per-line bale numbers: the cards print them in
    // brackets on each row, and flattening into aj.bales loses attribution.
    dispatched.push({ design: l.design, shade: l.shade, requested: l.qty, sent: balesForLine.length, bales: balesForLine });
  }
  if (!picked.length) {
    return { ok: false, message: 'No stock left for any line — decline the transfer instead.' };
  }
  // Persist real uids BEFORE storing them (legacy synthetic uids are
  // rowIndex-derived and would not survive a later backfill).
  const uidByRow = await inventoryRepository.ensureRowUids(pickedRows);
  const uids = pickedRows.map((r) => uidByRow.get(r.rowIndex));
  const flipped = await inventoryRepository.transitionBales(picked, AVAILABLE, IN_TRANSIT, aj.to, { uids });
  // TRF-INT1 — trust only what ACTUALLY flipped. A bale lost to a concurrent
  // sale in the same instant is dropped from the claim, never ghost-carried.
  // Judged from the PICK-TIME row mapping, not a re-filter of the snapshot.
  const flippedUids = new Set(flipped.map((r) => String(r.baleUid)));
  const conflicts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const d = dispatched[i];
    const refMap = lineRowRefs[i];
    const kept = d.bales.filter((pkg) =>
      (refMap.get(String(pkg)) || []).some((r) => flippedUids.has(String(uidByRow.get(r.rowIndex)))));
    conflicts.push(...d.bales.filter((pkg) => !kept.includes(pkg)));
    d.bales = kept;
    d.sent = kept.length;
  }
  const keptPkgs = dispatched.flatMap((d) => d.bales);
  if (!keptPkgs.length) {
    return { ok: false, message: 'Stock changed while dispatching — every picked bale was taken by another transaction. Open dispatch again and re-pick.' };
  }
  const keptUids = flipped.map((r) => String(r.baleUid));
  const short = dispatched.some((d) => d.sent < d.requested);
  const patch = { stage: STAGES.IN_TRANSIT, bales: keptPkgs, baleUids: keptUids, dispatched, short, dispatchedAt: new Date().toISOString() };
  await approvalQueueRepository.updateActionJSON(requestId, patch);
  await auditLogRepository.append('transfer.dispatched', { requestId, dispatched, short, conflicts }, String(byUserId || ''));
  return { ok: true, aj: { ...aj, ...patch }, short, conflicts };
}

/**
 * Destination receiver confirms: bales sellable @ destination; row closed.
 * @returns {Promise<{ok:boolean, aj?:object, message?:string}>}
 */
async function confirmReceipt(requestId, byUserId) {
  // SEC-P2 (H3): serialized with dispatch/abort on the same request.
  return mutex.runExclusive(requestId, () => confirmReceiptInner(requestId, byUserId));
}

async function confirmReceiptInner(requestId, byUserId) {
  const row = await findTransfer(requestId);
  if (!row) return { ok: false, message: 'transferService: transfer not found' };
  if (row.status !== 'pending' || row.actionJSON.stage !== STAGES.IN_TRANSIT) {
    return { ok: false, message: `transferService: cannot confirm (${row.status}/${row.actionJSON.stage})` };
  }
  const aj = row.actionJSON;
  // TRF-INT1 — flip exactly the rows dispatch logged (uids); transfers from
  // before uid storage fall back to printed numbers scoped to the transfer's
  // own destination (dispatch stamped the rows there), so a same-numbered
  // bale elsewhere can never be flipped by this receive.
  const hasUids = Array.isArray(aj.baleUids) && aj.baleUids.length > 0;
  const flipped = await inventoryRepository.transitionBales(aj.bales || [], IN_TRANSIT, AVAILABLE, null,
    hasUids ? { uids: aj.baleUids } : { warehouse: aj.to });
  // Result check: fewer rows than expected means the sheet was touched
  // outside the pipeline (hand edit / cross-contamination). The goods are
  // physically here, so the transfer still closes — but never silently.
  const expected = hasUids ? aj.baleUids.length : null;
  const flippedPkgs = new Set(flipped.map((r) => String(r.packageNo)));
  const mismatch = (hasUids && flipped.length !== expected)
    || (!hasUids && flippedPkgs.size !== (aj.bales || []).length)
    ? { expectedRows: expected, flippedRows: flipped.length, expectedBales: (aj.bales || []).length, flippedBales: flippedPkgs.size }
    : null;
  if (mismatch) {
    await auditLogRepository.append('transfer.receive_mismatch', { requestId, ...mismatch }, String(byUserId || ''));
  }
  await approvalQueueRepository.updateStatus(requestId, 'approved', new Date().toISOString());
  const totalSent = (aj.dispatched || []).reduce((s, d) => s + d.sent, 0) || (aj.bales || []).length;
  await transactionsRepository.append({
    user: String(byUserId || ''), action: ACTION,
    design: (aj.lines || []).map((l) => l.design).join('+'),
    color: (aj.lines || []).map((l) => l.shade).join('+'),
    qty: totalSent, before: aj.from || '', after: aj.to || '', status: 'completed',
  });
  await auditLogRepository.append('transfer.received', { requestId }, String(byUserId || ''));
  return { ok: true, aj, mismatch };
}

/**
 * Decline (pre-dispatch: nothing was moved, just close) or reject
 * (post-dispatch: revert the logged bales to the source).
 * @returns {Promise<{ok:boolean, aj?:object, kind?:string, message?:string}>}
 */
async function abort(requestId, byUserId) {
  // SEC-P2 (H3): serialized with dispatch/confirmReceipt on the same request.
  return mutex.runExclusive(requestId, () => abortInner(requestId, byUserId));
}

async function abortInner(requestId, byUserId) {
  const row = await findTransfer(requestId);
  if (!row) return { ok: false, message: 'transferService: transfer not found' };
  if (row.status !== 'pending') return { ok: false, message: `transferService: transfer already ${row.status}` };
  const aj = row.actionJSON;
  const kind = aj.stage === STAGES.IN_TRANSIT ? 'rejected' : 'declined';
  let mismatch = null;
  if (kind === 'rejected') {
    // Bales were logged at dispatch — send them home. TRF-INT1: exactly the
    // logged rows (uids), or printed numbers scoped to this transfer's
    // destination for pre-uid transfers; result checked, never silent.
    const hasUids = Array.isArray(aj.baleUids) && aj.baleUids.length > 0;
    const flipped = await inventoryRepository.transitionBales(aj.bales || [], IN_TRANSIT, AVAILABLE, aj.from,
      hasUids ? { uids: aj.baleUids } : { warehouse: aj.to });
    const expected = hasUids ? aj.baleUids.length : null;
    const flippedPkgs = new Set(flipped.map((r) => String(r.packageNo)));
    if ((hasUids && flipped.length !== expected)
      || (!hasUids && flippedPkgs.size !== (aj.bales || []).length)) {
      mismatch = { expectedRows: expected, flippedRows: flipped.length, expectedBales: (aj.bales || []).length, flippedBales: flippedPkgs.size };
      await auditLogRepository.append('transfer.reject_mismatch', { requestId, ...mismatch }, String(byUserId || ''));
    }
  }
  await approvalQueueRepository.updateStatus(requestId, 'rejected', new Date().toISOString());
  await auditLogRepository.append(`transfer.${kind}`, { requestId }, String(byUserId || ''));
  return { ok: true, aj, kind, mismatch };
}

/**
 * Attach a dispatch- or receive-time document (photo / PDF of the load) to a
 * transfer. The link rides the existing ApprovalQueue actionJSON — no schema
 * change — under `dispatchDoc` / `receiveDoc`. Best-effort metadata only; it
 * never moves inventory or changes the stage.
 *
 * @param {string} requestId
 * @param {'dispatch'|'receive'} kind
 * @param {{url?:string, name?:string, fileId?:string, by?:string}} doc
 * @returns {Promise<{ok:boolean, key?:string, message?:string}>}
 */
async function attachDoc(requestId, kind, doc = {}) {
  // TRF-INT2 — updateActionJSON is read-merge-write; unserialized it can race
  // a stage change on the same row and resurrect the old stage. Same key as
  // dispatch/receive/abort, so doc writes and stage writes take turns.
  return mutex.runExclusive(requestId, () => attachDocInner(requestId, kind, doc));
}

async function attachDocInner(requestId, kind, doc = {}) {
  const row = await findTransfer(requestId);
  if (!row) return { ok: false, message: 'transferService: transfer not found' };
  const key = kind === 'receive' ? 'receiveDoc' : 'dispatchDoc';
  const entry = {
    url: doc.url || '',
    name: doc.name || '',
    fileId: doc.fileId || '',
    // TRF-9 — photo vs PDF matters at view time: sendPhoto and sendDocument
    // reject each other's file_ids, so remember which kind this was.
    mime: doc.mime || '',
    by: String(doc.by || ''),
    at: new Date().toISOString(),
  };
  await approvalQueueRepository.updateActionJSON(requestId, { [key]: entry });
  await auditLogRepository.append(`transfer.${kind}_doc`, { requestId, url: entry.url, name: entry.name }, entry.by);
  return { ok: true, key };
}

module.exports = {
  ACTION,
  STAGES,
  uniqueTransferId,
  availableBales,
  selectByQuantity,
  getOpenTransfers,
  getActionableFor,
  findTransfer,
  createTransferRequest,
  dispatch,
  confirmReceipt,
  abort,
  attachDoc,
};
