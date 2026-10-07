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
const { todayInLagos } = require('../utils/dates');
const inventoryRepository = require('../repositories/inventoryRepository');
const transactionsRepository = require('../repositories/transactionsRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const mutex = require('../utils/asyncMutex');
const transferGhosts = require('./transferGhosts');
const logger = require('../utils/logger');

const ACTION = 'transfer_stock';
const AVAILABLE = 'available';
const IN_TRANSIT = 'in_transit';
const STAGES = Object.freeze({ REQUESTED: 'requested', ADMIN_REVIEW: 'admin_review', IN_TRANSIT: 'in_transit' });

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
    // TRF-18 — a parked package is the ADMIN's move; without this, a
    // transfer awaiting approval sat in NOBODY's My Tasks queue and only
    // the DM card carried the duty.
    if (aj.stage === STAGES.ADMIN_REVIEW) {
      try { return require('../middlewares/auth').isAdmin(uid); } catch (_) { return false; }
    }
    return false;
  });
}

/** One transfer row by id (any status). Null when not a transfer. */
/**
 * TRF-20 (6b/8) — shadow the row on Postgres after EVERY state write, in the
 * stock_events posture: best-effort, fails open, never throws. The sheet is
 * still the truth; the parity script compares the two.
 */
async function mirror(requestId, event, actor, detail = {}) {
  try {
    const pg = require('../repositories/transfersPgRepository');
    const row = await approvalQueueRepository.getByRequestId(requestId);
    if (row) await pg.upsert(row);
    await pg.event(requestId, event, actor, detail);
  } catch (e) {
    logger.warn(`transferService: mirror ${event} for ${requestId} failed: ${e.message}`);
  }
}

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
  const date = todayInLagos().replace(/-/g, '');  // TIME-1 — TR ids follow the Lagos day
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

/**
 * TRF-20 (2/8) — one identity that cannot repeat, and the duplicate guard.
 *
 * @param {object} p
 * @param {string} [p.idemKey]  minted when the confirm card was DRAWN and
 *   carried on Send. A retry after any failure (a timeout, a thrown audit
 *   line, a double delivery) finds the row this key already produced and
 *   returns it instead of writing a second one. Rides actionJSON; no column.
 * @param {boolean} [p.force]   an admin's "Send anyway": the identical open
 *   transfer no longer blocks, and the new row is stamped `duplicateOf` so
 *   every surface can say so.
 * @returns {Promise<{requestId:string, aj:object, existing?:boolean}
 *   | {duplicate:object}>} `duplicate` = the OLDEST open transfer of the
 *   same load (route + lines); nothing was written.
 */
async function createTransferRequest({ from, to, lines, requestedBy, dispatcher, receiver, idemKey, force }) {
  const cleanLines = (lines || [])
    .map((l) => {
      const line = { design: l.design, shade: l.shade, qty: Math.max(0, parseInt(l.qty, 10) || 0) };
      // TRF-14 — typed orders pin the REQUESTED bale numbers to the line so
      // the dispatcher picker pre-selects exactly those (not FIFO stand-ins).
      const req = Array.isArray(l.bales)
        ? [...new Set(l.bales.map((b) => String(b).trim()).filter(Boolean))].slice(0, line.qty)
        : [];
      if (req.length) line.bales = req;
      return line;
    })
    .filter((l) => l.design && l.qty > 0);
  if (!cleanLines.length) throw new Error('transferService: at least one line with qty > 0 required');
  // One exclusive section for read → allocate → write: the day counter used
  // to be computed from a scan of the sheet at send time, so two people
  // sending in the same second could both compute the same TR-<day>-<n>.
  const wanted = transferGhosts.loadKey({ from, to, lines: cleanLines });
  const made = await mutex.runExclusive('transfer-create', async () => {
    const open = await getOpenTransfers();
    if (idemKey) {
      // A retry of THIS card — same load, same people. A key carried onto an
      // edited load (review, 22-Sep) must never bind the old row.
      const mine = open.find((r) => r.actionJSON && r.actionJSON.idemKey === idemKey
        && transferGhosts.loadKey(r.actionJSON) === wanted
        && String(r.actionJSON.dispatcher) === String(dispatcher || '')
        && String(r.actionJSON.receiver) === String(receiver || ''));
      if (mine) return { requestId: mine.requestId, aj: mine.actionJSON, existing: true };
    }
    const twin = transferGhosts.findIdenticalOpen(open, { from, to, lines: cleanLines });
    if (twin && !force) return { duplicate: twin };
    const requestId = await uniqueTransferId();
    const aj = {
      action: ACTION,
      from, to,
      lines: cleanLines,
      dispatcher: String(dispatcher || ''),
      receiver: String(receiver || ''),
      stage: STAGES.REQUESTED,
      ...(idemKey ? { idemKey: String(idemKey) } : {}),
      ...(twin ? { duplicateOf: twin.requestId } : {}),
    };
    const { created } = await approvalQueueRepository.appendOnce({
      requestId, user: String(requestedBy || ''),
      actionJSON: aj,
      riskReason: 'Warehouse transfer — dispatcher + receiver confirmation chain.',
      status: 'pending',
    });
    // A taken reference means NOTHING was written (a same-day id minted by an
    // earlier process that fell back to a random floor). Reporting success
    // here would lose the load silently; throwing re-arms Send, and the next
    // tap mints past the clash.
    if (!created) throw new Error(`transfer reference ${requestId} is already taken — please tap Send again`);
    return { requestId, aj, twin };
  });
  if (made.duplicate || made.existing) return made;
  // The row exists from here. The audit line sits OUTSIDE the exclusive
  // section (it holds no reference) and is guarded: a failed log write must
  // never report a created transfer as failed — that re-armed Send and made
  // the next tap a twin.
  try {
    await auditLogRepository.append('transfer.requested',
      { requestId: made.requestId, from, to, lines: cleanLines, ...(made.twin ? { duplicateOf: made.twin.requestId } : {}) },
      String(requestedBy || ''));
  } catch (e) {
    logger.warn(`transferService: audit line for ${made.requestId} failed: ${e.message}`);
  }
  await mirror(made.requestId, 'requested', requestedBy, { from, to, lines: cleanLines });
  return { requestId: made.requestId, aj: made.aj };
}

/**
 * Dispatcher accepts: log the ACTUAL bales now — flip them in_transit @
 * destination, record per-line sent vs requested. Partial dispatch allowed;
 * fails only when nothing is available at all.
 *
 * `manualPicks` is REQUIRED (TRF-15, owner rule 02-Aug): an array parallel
 * to `aj.lines`, each element the list of packageNos a human chose for that
 * line (picker ticks, or numbers read from the load photo). Chosen bales are
 * still validated against LIVE availability (someone may have moved stock
 * since the picker opened), capped to the line qty, and de-duped. The bot
 * never auto-selects — a call without picks is refused.
 *
 * @param {string} requestId
 * @param {string} byUserId
 * @param {Array<Array<string>>} [manualPicks] per-line chosen packageNos
 * @returns {Promise<{ok:boolean, aj?:object, short?:boolean, message?:string}>}
 */
async function dispatch(requestId, byUserId, manualPicks, opts = {}) {
  // SEC-P2 (H3): serialize the stage transition per request so a double-tapped
  // Dispatch (or Dispatch racing a Reject) can't both read stage=requested and
  // transition the same bales twice. The re-read + stage guard run inside the
  // lock, so the second caller sees the new stage and bails cleanly.
  return mutex.runExclusive(requestId, () => dispatchInner(requestId, byUserId, manualPicks, opts));
}

/**
 * TRF-18 — a NON-ADMIN dispatcher's completed package goes to admin review
 * instead of flipping stock. Same validation and mutexes as dispatch.
 */
async function submitForAdminReview(requestId, byUserId, manualPicks, opts = {}) {
  return mutex.runExclusive(requestId, () =>
    dispatchInner(requestId, byUserId, manualPicks, { ...opts, stageOnly: true }));
}

/**
 * TRF-18 — admin approves: the STORED picks re-run the real dispatch, so
 * stock lost between review and approval is dropped and reported (TRF-INT1).
 */
async function approveDispatch(requestId, adminId) {
  return mutex.runExclusive(requestId, async () => {
    const row = await findTransfer(requestId);
    if (!row) return { ok: false, message: 'transferService: transfer not found' };
    const aj = row.actionJSON;
    if (row.status !== 'pending' || aj.stage !== STAGES.ADMIN_REVIEW || !aj.pendingDispatch) {
      return { ok: false, message: `transferService: nothing awaiting approval (${row.status}/${aj.stage})` };
    }
    const pending = aj.pendingDispatch;
    // The flip path asserts nothing about stage itself (dispatchInner did);
    // run it directly under the warehouse lock with the stored picks.
    return mutex.runExclusive(`dispatch-wh:${norm(aj.from)}`,
      () => dispatchPickAndFlip(requestId, pending.submittedBy || adminId, pending.picks || [], aj,
        { leftOn: pending.leftOn, approvedBy: adminId }));
  });
}

/**
 * TRF-18 — admin sends the package back: stage returns to `requested`, the
 * dispatcher re-logs. Nothing flipped, so nothing reverts.
 */
async function sendBackFromReview(requestId, adminId) {
  return mutex.runExclusive(requestId, async () => {
    const row = await findTransfer(requestId);
    if (!row) return { ok: false, message: 'transferService: transfer not found' };
    const aj = row.actionJSON;
    if (row.status !== 'pending' || aj.stage !== STAGES.ADMIN_REVIEW) {
      return { ok: false, message: `transferService: nothing awaiting approval (${row.status}/${aj.stage})` };
    }
    const patch = {
      stage: STAGES.REQUESTED, pendingDispatch: null,
      reviewSentBackBy: String(adminId), reviewSentBackAt: new Date().toISOString(),
    };
    await approvalQueueRepository.updateActionJSON(requestId, patch);
    await auditLogRepository.append('transfer.review_sent_back', { requestId }, String(adminId));
    await mirror(requestId, 'review_sent_back', adminId);
    return { ok: true, aj: { ...aj, ...patch } };
  });
}

async function dispatchInner(requestId, byUserId, manualPicks, opts = {}) {
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
    () => dispatchPickAndFlip(requestId, byUserId, manualPicks, aj, opts));
}

async function dispatchPickAndFlip(requestId, byUserId, manualPicks, aj, opts = {}) {
  // TRF-15 (owner rule, 02-Aug) — the bot never selects bales. Every
  // dispatch must carry the human's explicit per-line picks (picker ticks,
  // or numbers read from the load photo in snap transfers).
  if (!Array.isArray(manualPicks)) {
    return { ok: false, message: 'transferService: dispatch requires explicitly picked bales — the bot does not choose (TRF-15).' };
  }
  const inv = await inventoryRepository.getAll(true); // fresh, under the lock
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
    // Keep only chosen bales still available for this exact line, de-duped,
    // in the operator's tap order, capped to the requested qty.
    const availSet = new Set(availableBales(inv, aj.from, l.design, l.shade));
    const seen = new Set();
    const balesForLine = [];
    for (const p of (manualPicks[i] || [])) {
      const pkg = String(p);
      if (availSet.has(pkg) && !seen.has(pkg)) { seen.add(pkg); balesForLine.push(pkg); }
      if (balesForLine.length >= l.qty) break;
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
  const leftOn = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.leftOn || ''))
    ? String(opts.leftOn) : todayInLagos();  // TIME-1
  // TRF-18 — a non-admin's dispatch stops HERE: the picks are validated and
  // resolved exactly as a real dispatch would, but nothing flips. The package
  // (picks + resolved preview + departure date) parks on the row for an
  // admin to approve; approval re-runs this function without stageOnly, so
  // the flip re-resolves against live stock (TRF-INT1) at approval time.
  if (opts.stageOnly) {
    const patch = {
      stage: STAGES.ADMIN_REVIEW,
      pendingDispatch: {
        picks: manualPicks, bales: picked, baleUids: uids.map(String),
        dispatched, leftOn, submittedBy: String(byUserId || ''),
        submittedAt: new Date().toISOString(),
      },
    };
    await approvalQueueRepository.updateActionJSON(requestId, patch);
    await mirror(requestId, 'review_submitted', byUserId);
    await auditLogRepository.append('transfer.review_submitted',
      { requestId, bales: picked, leftOn }, String(byUserId || ''));
    return { ok: true, aj: { ...aj, ...patch }, review: true };
  }
  const flipped = await require('./stockEngine').transition(picked, AVAILABLE, IN_TRANSIT, aj.to, {
    uids,
    // BMV-1 — the business date + the origin, so prev_state reads
    // "available @ IDUMOTA" rather than the destination it was rewritten to.
    on: leftOn, fromWarehouse: aj.from, ref: requestId,
  }, { event: 'dispatch', adminId: byUserId, approvalId: requestId });
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
  const now = new Date().toISOString();
  // TRF-16 (owner, 03-Aug) — `dispatchedOn` is the date the goods
  // PHYSICALLY left the store, chosen by the dispatcher; `dispatchedAt`
  // stays the system timestamp of the logging, for audit. They differ
  // whenever a load is logged after the truck left.
  const patch = {
    stage: STAGES.IN_TRANSIT, bales: keptPkgs, baleUids: keptUids, dispatched,
    short, dispatchedAt: now, dispatchedOn: leftOn,
    // TRF-18 — approval provenance; pendingDispatch is consumed by the flip.
    ...(opts.approvedBy ? { approvedBy: String(opts.approvedBy) } : {}),
    pendingDispatch: null,
  };
  await approvalQueueRepository.updateActionJSON(requestId, patch);
  await mirror(requestId, 'dispatched', byUserId);
  await auditLogRepository.append('transfer.dispatched',
    { requestId, dispatched, short, conflicts, dispatchedOn: leftOn }, String(byUserId || ''));
  return { ok: true, aj: { ...aj, ...patch }, short, conflicts };
}

/**
 * Destination receiver confirms: bales sellable @ destination; row closed.
 * @returns {Promise<{ok:boolean, aj?:object, message?:string}>}
 */
/**
 * TRF-21 (owner, 30-Sep-2026: "the goods received by the receiver do not
 * come in the same batch … whichever goods he receives by that time, they
 * can be updated instantly") — what a transfer's receipt looks like so far.
 *
 * The record rides the same ApprovalQueue row (no column, no sheet, no
 * migration): `receivedBales` (printed numbers confirmed so far),
 * `receivedUids` (the rows those confirmations covered) and `receipts[]`
 * (one entry per delivery: when, who, which bales). The row stays
 * `pending` / `in_transit` until the LAST bale is confirmed — `approved`
 * still means "everything received", exactly as every reader expects.
 *
 * @param {object} aj transfer actionJSON
 * @returns {{bales:string[], received:string[], remaining:string[], uids:string[],
 *   receivedUids:string[], remainingUids:string[], receipts:object[], partial:boolean}}
 */
function receiptState(aj) {
  const a = aj || {};
  const bales = (Array.isArray(a.bales) ? a.bales : []).map(String);
  const baleSet = new Set(bales);
  const received = [];
  const seen = new Set();
  for (const b of (Array.isArray(a.receivedBales) ? a.receivedBales : []).map(String)) {
    if (baleSet.has(b) && !seen.has(b)) { seen.add(b); received.push(b); }
  }
  const remaining = bales.filter((b) => !seen.has(b));
  const uids = (Array.isArray(a.baleUids) ? a.baleUids : []).map(String);
  const gotUid = new Set((Array.isArray(a.receivedUids) ? a.receivedUids : []).map(String));
  const receivedUids = uids.filter((u) => gotUid.has(u));
  const remainingUids = uids.filter((u) => !gotUid.has(u));
  const receipts = Array.isArray(a.receipts) ? a.receipts : [];
  return {
    bales, received, remaining, uids, receivedUids, remainingUids, receipts,
    partial: received.length > 0 && remaining.length > 0,
  };
}

/**
 * Confirm arrival of a transfer — the whole outstanding load, or (TRF-21)
 * the bales that physically arrived in THIS delivery.
 *
 * @param {string} requestId
 * @param {string} byUserId the receiver (or an admin in that seat)
 * @param {{bales?:string[]}} [opts] printed numbers received now; absent =
 *   everything still on the road (the pre-TRF-21 path, byte-identical).
 * @returns {Promise<{ok:boolean, aj?:object, mismatch?:object|null, closed?:boolean,
 *   received?:string[], remaining?:string[], message?:string}>}
 */
async function confirmReceipt(requestId, byUserId, opts = {}) {
  // SEC-P2 (H3): serialized with dispatch/abort on the same request.
  return mutex.runExclusive(requestId, () => confirmReceiptInner(requestId, byUserId, opts));
}

async function confirmReceiptInner(requestId, byUserId, opts = {}) {
  const row = await findTransfer(requestId);
  if (!row) return { ok: false, message: 'transferService: transfer not found' };
  if (row.status !== 'pending' || row.actionJSON.stage !== STAGES.IN_TRANSIT) {
    return { ok: false, message: `transferService: cannot confirm (${row.status}/${row.actionJSON.stage})` };
  }
  const aj = row.actionJSON;
  const state = receiptState(aj);
  // Review (30-Sep) — a printed number can ride two lines of one transfer
  // (the same number in two containers is two bales). A subset keyed on
  // numbers alone would flip both; such a load is received in one go.
  if (Array.isArray(opts.bales) && new Set(state.bales).size !== state.bales.length) {
    return { ok: false, message: 'transferService: this load carries the same bale number more than once — receive it in one go with ✅ Received' };
  }
  // Review (30-Sep) — every bale is on the record as received but the row
  // is still open (the status write failed after the record write, or the
  // process died between them): close it, flip nothing, book nothing twice.
  if (state.bales.length && !state.remaining.length) {
    const approverLabel = await require('./approverStamp').labelFor({ actionJSON: aj, actorId: null });
    await approvalQueueRepository.updateStatus(requestId, 'approved', new Date().toISOString(), approverLabel);
    await mirror(requestId, 'received', byUserId, { recovered: true, delivery: state.receipts.length });
    await auditLogRepository.append('transfer.received',
      { requestId, recovered: true, deliveries: state.receipts.length }, String(byUserId || ''));
    return { ok: true, aj, mismatch: null, closed: true, received: [], remaining: [], recovered: true, delivery: state.receipts.length };
  }
  // TRF-21 — which bales this delivery covers. A number already confirmed
  // by an earlier delivery is dropped (a stale picker card must never
  // count a bale twice); a number the transfer never carried is ignored.
  let picked;
  if (Array.isArray(opts.bales)) {
    const remainingSet = new Set(state.remaining);
    picked = [...new Set(opts.bales.map(String))].filter((b) => remainingSet.has(b));
    if (!picked.length) {
      return { ok: false, message: state.remaining.length
        ? 'transferService: none of those bales is still on the road for this transfer'
        : 'transferService: every bale of this transfer is already received' };
    }
  } else {
    picked = state.remaining;
  }
  // A row that never carried a bale list (nothing was logged at dispatch)
  // keeps the pre-TRF-21 close: flip nothing, settle the row.
  const bareRow = !state.bales.length;
  if (!picked.length && !bareRow) return { ok: false, message: 'transferService: nothing left to receive' };
  const everything = picked.length === state.remaining.length;
  // TRF-INT1 — flip exactly the rows dispatch logged (uids); transfers from
  // before uid storage fall back to printed numbers scoped to the transfer's
  // own destination (dispatch stamped the rows there), so a same-numbered
  // bale elsewhere can never be flipped by this receive.
  const hasUids = state.uids.length > 0;
  let uids = state.remainingUids;
  if (hasUids && !everything) {
    // TRF-21 — a subset: the transfer stores uids per ROW, not per bale, so
    // the rows of the picked bales are resolved from the sheet (any status
    // — a hand-flipped row still belongs to its bale and is counted as
    // expected, so the mismatch check below still sees it).
    const want = new Set(state.remainingUids);
    const pickedSet = new Set(picked.map((b) => b.toLowerCase()));
    // Fresh, under the lock — deciding what to flip from a cached snapshot
    // is how a row edited seconds ago gets flipped by the wrong bale.
    uids = (await inventoryRepository.getAll(true))
      .filter((r) => want.has(String(r.baleUid)) && pickedSet.has(String(r.packageNo || '').toLowerCase()))
      .map((r) => String(r.baleUid));
  }
  const arrivedOn = todayInLagos();  // TIME-1
  // A uid transfer whose picked rows resolve to NOTHING must not fall
  // through to the unscoped printed-number path (transitionBales treats an
  // empty uid list as "no uid filter") — flip nothing, report the mismatch.
  const flipped = (hasUids && !uids.length) ? []
    : await require('./stockEngine').transition(picked, IN_TRANSIT, AVAILABLE, null,
      Object.assign(hasUids ? { uids } : { warehouse: aj.to },
        // BMV-1 — prev_state keeps the ORIGIN visible after arrival:
        // "in_transit @ IDUMOTA".
        { on: arrivedOn, fromWarehouse: aj.from, ref: requestId }),
      { event: 'receive', adminId: byUserId, approvalId: requestId });
  // Result check: fewer rows than expected means the sheet was touched
  // outside the pipeline (hand edit / cross-contamination). The goods are
  // physically here, so the receipt still applies — but never silently.
  const expected = hasUids ? uids.length : null;
  const flippedPkgs = new Set(flipped.map((r) => String(r.packageNo).toLowerCase()));
  const pickedDistinct = new Set(picked.map((b) => b.toLowerCase())).size;
  // TRF-21 — the bale count is checked on the uid SUBSET path too: its rows
  // are resolved from the live sheet, so a bale whose rows were edited away
  // resolves to NO uid at all and would otherwise pass as "0 of 0 flipped".
  // The whole-load uid path keeps the row comparison alone (one number on
  // two lines is two bales there, and the rows already say so).
  const mismatch = (hasUids && flipped.length !== expected)
    || ((!hasUids || !everything) && flippedPkgs.size !== pickedDistinct)
    ? { expectedRows: expected, flippedRows: flipped.length, expectedBales: pickedDistinct, flippedBales: flippedPkgs.size }
    : null;
  if (mismatch) {
    await auditLogRepository.append('transfer.receive_mismatch', { requestId, ...mismatch }, String(byUserId || ''));
  }
  const now = new Date().toISOString();
  const receivedBales = [...state.received, ...picked];
  const receivedUids = [...state.receivedUids, ...uids];
  const remaining = state.remaining.filter((b) => !picked.includes(b));
  const receipts = [...state.receipts, {
    at: now, on: arrivedOn, by: String(byUserId || ''), bales: picked, rows: flipped.length,
  }];
  // TRF-21 — a delivery that is part of a series is written to the row
  // (a single all-at-once receipt keeps the pre-TRF-21 record untouched).
  const series = receipts.length > 1 || remaining.length > 0;
  const patch = series ? { receivedBales, receivedUids, receipts, lastReceivedAt: now } : null;
  const ajOut = patch ? { ...aj, ...patch } : aj;
  // Review (30-Sep) — on the CLOSING delivery the status flip is written
  // before the bookkeeping patch: a failure between the two then leaves a
  // closed row missing one record line (AuditLog has it), never an open row
  // whose record says everything arrived (see the recovery branch above).
  if (!remaining.length) {
    // APR-1 — `byUserId` here is the destination RECEIVER, not an approver.
    // labelFor reads the admin who released the transfer off the record.
    const approverLabel = await require('./approverStamp')
      .labelFor({ actionJSON: ajOut, actorId: null });
    await approvalQueueRepository.updateStatus(requestId, 'approved', now, approverLabel);
  }
  if (patch) await approvalQueueRepository.updateActionJSON(requestId, patch);
  // One Transactions row per delivery (owner default, 30-Sep-2026): the
  // bales confirmed that day, not the whole load.
  const totalSent = (aj.dispatched || []).reduce((s, d) => s + d.sent, 0) || (aj.bales || []).length;
  const linesOf = () => {
    const ds = Array.isArray(aj.dispatched) ? aj.dispatched : [];
    const pickedSet = new Set(picked);
    const hit = ds.filter((d) => Array.isArray(d.bales) && d.bales.some((b) => pickedSet.has(String(b))));
    return hit.length ? hit : (aj.lines || []);
  };
  const txnLines = series ? linesOf() : (aj.lines || []);
  if (!remaining.length) {
    await mirror(requestId, 'received', byUserId, series ? { delivery: receipts.length, bales: picked.length } : {});
  } else {
    await mirror(requestId, 'partly_received', byUserId,
      { delivery: receipts.length, bales: picked.length, remaining: remaining.length });
  }
  await transactionsRepository.append({
    user: String(byUserId || ''), action: ACTION,
    design: txnLines.map((l) => l.design).join('+'),
    color: txnLines.map((l) => l.shade).join('+'),
    qty: series ? picked.length : totalSent, before: aj.from || '', after: aj.to || '', status: 'completed',
    // TRF-16 — the physical departure date the dispatcher chose. The
    // SalesDate column is this sheet's business-date column; backdatedStamp
    // only stamps sell/sale actions, so a transfer row stays unstamped.
    salesDate: aj.dispatchedOn || '',
  });
  if (!remaining.length) {
    await auditLogRepository.append('transfer.received',
      series ? { requestId, deliveries: receipts.length, bales: picked.length } : { requestId },
      String(byUserId || ''));
  } else {
    await auditLogRepository.append('transfer.partly_received',
      { requestId, delivery: receipts.length, bales: picked, remaining: remaining.length }, String(byUserId || ''));
  }
  return { ok: true, aj: ajOut, mismatch, closed: !remaining.length, received: picked, remaining, delivery: receipts.length };
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
  const state = receiptState(aj);
  if (kind === 'rejected') {
    // Bales were logged at dispatch — send them home. TRF-INT1: exactly the
    // logged rows (uids), or printed numbers scoped to this transfer's
    // destination for pre-uid transfers; result checked, never silent.
    // TRF-21 — only the bales still ON THE ROAD go back; a bale confirmed
    // by an earlier delivery is live at the destination and stays there.
    const hasUids = state.uids.length > 0;
    let homeUids = state.remainingUids;
    if (hasUids && state.received.length) {
      // Review (30-Sep) — after a partial delivery only the rows of the
      // bales STILL ON THE ROAD go home. A bale recorded received whose rows
      // could not be matched at the time (a hand-edited number cell) still
      // has its uids in the outstanding list; the card promised it stays,
      // so a row that no longer answers to an outstanding number is left
      // for a human (the sentinel names it), never sent home by guesswork.
      const still = new Set(state.remaining.map((b) => b.toLowerCase()));
      const byUid = new Map((await inventoryRepository.getAll(true)).map((r) => [String(r.baleUid), r]));
      homeUids = state.remainingUids.filter((u) => {
        const r = byUid.get(u);
        return !!r && still.has(String(r.packageNo || '').toLowerCase());
      });
    }
    const flipped = (hasUids && !homeUids.length) ? []
      : await require('./stockEngine').transition(state.remaining, IN_TRANSIT, AVAILABLE, aj.from,
        Object.assign(hasUids ? { uids: homeUids } : { warehouse: aj.to },
          { on: todayInLagos(), fromWarehouse: aj.from, ref: requestId }),  // TIME-1
        { event: 'reject', adminId: byUserId, approvalId: requestId });
    const expected = hasUids ? homeUids.length : null;
    const flippedPkgs = new Set(flipped.map((r) => String(r.packageNo)));
    if ((hasUids && flipped.length !== expected)
      || (!hasUids && flippedPkgs.size !== state.remaining.length)) {
      mismatch = { expectedRows: expected, flippedRows: flipped.length, expectedBales: state.remaining.length, flippedBales: flippedPkgs.size };
      await auditLogRepository.append('transfer.reject_mismatch', { requestId, ...mismatch }, String(byUserId || ''));
    }
  }
  // TRF-20 review — the person who closed it IS the record (the transfer
  // approver ids alone name only the releasing admin, so every declined
  // transfer left the Approver column blank).
  const approverLabel = await require('./approverStamp')
    .labelFor({ actionJSON: aj, actorId: byUserId, actorAlways: true });
  await approvalQueueRepository.updateStatus(requestId, 'rejected', new Date().toISOString(), approverLabel);
  await auditLogRepository.append(`transfer.${kind}`,
    state.received.length ? { requestId, returned: state.remaining.length, kept: state.received.length } : { requestId },
    String(byUserId || ''));
  await mirror(requestId, kind, byUserId,
    state.received.length ? { returned: state.remaining.length, kept: state.received.length } : {});
  return { ok: true, aj, kind, mismatch, returned: state.remaining, kept: state.received };
}

/**
 * Attach a dispatch- or receive-time document (photo / PDF of the load) to a
 * transfer. The link rides the existing ApprovalQueue actionJSON — no schema
 * change — under `dispatchDoc` / `receiveDoc`. Best-effort metadata only; it
 * never moves inventory or changes the stage.
 *
 * @param {string} requestId
 * @param {'dispatch'|'receive'} kind
 * @param {{url?:string, name?:string, fileId?:string, by?:string, delivery?:number}} doc
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
  const patch = { [key]: entry };
  // TRF-21 — a receipt photo belongs to ITS delivery (`doc.delivery`,
  // 1-based, carried from confirmReceipt through the photo gate): stamp
  // that entry, so an earlier delivery's photo is not lost when the next
  // one overwrites `receiveDoc`. A post-hoc attach names no delivery and
  // touches `receiveDoc` alone.
  const n = Number(doc.delivery) || 0;
  if (kind === 'receive' && n > 0 && Array.isArray(row.actionJSON.receipts) && n <= row.actionJSON.receipts.length) {
    const receipts = row.actionJSON.receipts.map((r) => ({ ...r }));
    receipts[n - 1].doc = { url: entry.url, name: entry.name, fileId: entry.fileId, mime: entry.mime };
    patch.receipts = receipts;
  }
  await approvalQueueRepository.updateActionJSON(requestId, patch);
  await mirror(requestId, `${kind}_doc`, entry.by, { url: entry.url });
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
  submitForAdminReview,
  approveDispatch,
  sendBackFromReview,
  confirmReceipt,
  receiptState,
  abort,
  attachDoc,
};
