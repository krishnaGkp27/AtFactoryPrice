'use strict';

/**
 * TRF-3 — transferService (queue-carried, dispatch-time logging): pure
 * selection helpers + create / dispatch / confirmReceipt / abort. The
 * request is an ORDER (lines) — bales are picked & flipped only when the
 * dispatcher accepts. Repos stubbed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const transferService = require('../../../src/services/transferService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');

// TRF-INT1 — rows carry rowIndex + baleUid like real parsed rows: dispatch
// resolves picks to exact rows and stores uids on the transfer.
const INV = [
  { rowIndex: 2, baleUid: 'U-P1a', packageNo: 'P1', design: 'Rose', shade: 'Red', warehouse: 'Lagos', status: 'available' },
  { rowIndex: 3, baleUid: 'U-P2a', packageNo: 'P2', design: 'Rose', shade: 'Red', warehouse: 'Lagos', status: 'available' },
  { rowIndex: 4, baleUid: 'U-P3a', packageNo: 'P3', design: 'Rose', shade: 'Red', warehouse: 'Lagos', status: 'sold' },
  { rowIndex: 5, baleUid: 'U-P4a', packageNo: 'P4', design: 'Lily', shade: 'Blue', warehouse: 'Lagos', status: 'available' },
  // P5 spans two thans — must count once.
  { rowIndex: 6, baleUid: 'U-P5a', packageNo: 'P5', design: 'Rose', shade: 'Red', warehouse: 'Lagos', status: 'available' },
  { rowIndex: 7, baleUid: 'U-P5b', packageNo: 'P5', design: 'Rose', shade: 'Red', warehouse: 'Lagos', status: 'available' },
];

test('availableBales: distinct + filtered by status/warehouse/design/shade', () => {
  assert.deepEqual(transferService.availableBales(INV, 'Lagos', 'rose', 'RED'), ['P1', 'P2', 'P5']);
});

test('selectByQuantity: first-N in sheet order; short still returns what exists', () => {
  const ok = transferService.selectByQuantity(INV, 'Lagos', 'Rose', 'Red', 2);
  assert.deepEqual(ok, { ok: true, bales: ['P1', 'P2'], available: 3 });
  const short = transferService.selectByQuantity(INV, 'Lagos', 'Rose', 'Red', 9);
  assert.equal(short.ok, false);
  assert.deepEqual(short.bales, ['P1', 'P2', 'P5'], 'partial pick still returned');
});

/** Stub all repos; returns recorder + a mutable queue row. */
function stub(row, inventorySeed = INV) {
  const calls = { transitions: [], appends: [], statusUpdates: [], ajPatches: [], txns: [], audits: [] };
  let current = row ? JSON.parse(JSON.stringify(row)) : null;
  // Faithful sheet model: getAll hands out FRESH row objects per read (a
  // caller's snapshot never mutates under it — exactly like a re-fetch),
  // while transitionBales mutates the backing store and returns what it
  // actually flipped — TRF-INT1 dispatch/receive/abort check this result.
  const store = JSON.parse(JSON.stringify(inventorySeed));
  inventoryRepository.getAll = async () => JSON.parse(JSON.stringify(store));
  inventoryRepository.ensureRowUids = async (rows) => new Map(rows.map((r) => [r.rowIndex, r.baleUid]));
  inventoryRepository.transitionBales = async (pkgs, from, to, wh, opts = {}) => {
    calls.transitions.push({ pkgs, from, to, wh, opts });
    const set = new Set((pkgs || []).map(String));
    const uidSet = Array.isArray(opts.uids) && opts.uids.length ? new Set(opts.uids.map(String)) : null;
    const low = (v) => String(v == null ? '' : v).trim().toLowerCase();
    const rows = store.filter((r) => r.status === from
      && (uidSet ? uidSet.has(String(r.baleUid))
        : (set.has(String(r.packageNo)) && (!opts.warehouse || low(r.warehouse) === low(opts.warehouse)))));
    rows.forEach((r) => { r.status = to; if (wh != null) r.warehouse = wh; });
    return rows.map((r) => ({ ...r }));
  };
  approvalQueueRepository.append = async (rec) => { calls.appends.push(rec); current = { ...rec, status: 'pending' }; return rec; };
  approvalQueueRepository.getByRequestId = async () => (current ? JSON.parse(JSON.stringify(current)) : null);
  approvalQueueRepository.getAllPending = async () => (current && current.status === 'pending' ? [current] : []);
  approvalQueueRepository.updateStatus = async (id, status) => { calls.statusUpdates.push({ id, status }); current.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { calls.ajPatches.push({ id, patch }); current.actionJSON = { ...current.actionJSON, ...patch }; return true; };
  transactionsRepository.append = async (t) => { calls.txns.push(t); };
  auditLogRepository.append = async (event, meta, user) => { calls.audits.push({ event, user }); };
  return calls;
}

const ROW = (stage, extra = {}) => ({
  requestId: 'TR-1', user: 'admin1', status: 'pending',
  actionJSON: {
    action: 'transfer_stock', from: 'Lagos', to: 'Kano office',
    lines: [{ design: 'Rose', shade: 'Red', qty: 2 }, { design: 'Lily', shade: 'Blue', qty: 2 }],
    dispatcher: 'abdul', receiver: 'musa', stage, ...extra,
  },
});

test('createTransferRequest: ORDER only — queue row, NO inventory change', async () => {
  const calls = stub();
  const { requestId, aj } = await transferService.createTransferRequest({
    from: 'Lagos', to: 'Kano office',
    lines: [{ design: 'Rose', shade: 'Red', qty: 2 }, { design: 'Bad', shade: 'X', qty: 0 }],
    requestedBy: 'admin1', dispatcher: 'abdul', receiver: 'musa',
  });
  assert.match(requestId, /^TR-/);
  assert.equal(aj.stage, 'requested');
  assert.deepEqual(aj.lines, [{ design: 'Rose', shade: 'Red', qty: 2 }], 'zero-qty lines dropped');
  assert.equal(calls.transitions.length, 0, 'nothing locked at request time');
  assert.equal(calls.audits[0].event, 'transfer.requested');
});

test('createTransferRequest: refuses an empty order', async () => {
  stub();
  await assert.rejects(() => transferService.createTransferRequest({
    from: 'Lagos', to: 'Kano', lines: [], requestedBy: 'a', dispatcher: 'b', receiver: 'c',
  }), /at least one line/);
});

test('dispatch: logs actual bales per line, flips in_transit @ dest', async () => {
  const calls = stub(ROW('requested'));
  // TRF-15 — picks are always explicit (Rose: P1,P2 · Lily: P4; P5 gone).
  const res = await transferService.dispatch('TR-1', 'abdul', [['P1', 'P2'], ['P4', 'P5']]);
  assert.equal(res.ok, true);
  // Rose: P1,P2 (full) · Lily: only P4 exists → short 1/2.
  const t0 = calls.transitions[0];
  assert.deepEqual(t0.pkgs, ['P1', 'P2', 'P4']);
  assert.equal(t0.from, 'available');
  assert.equal(t0.to, 'in_transit');
  assert.equal(t0.wh, 'Kano office');
  // TRF-INT1 — the exact resolved rows ride the transition and the transfer.
  assert.deepEqual(t0.opts.uids, ['U-P1a', 'U-P2a', 'U-P4a']);
  assert.deepEqual(res.aj.baleUids, ['U-P1a', 'U-P2a', 'U-P4a']);
  assert.equal(res.short, true);
  assert.deepEqual(res.conflicts, [], 'nothing lost to a concurrent transaction');
  // TRF-12 — the per-line bale numbers are stored so cards can print them
  // in brackets on each row.
  assert.deepEqual(res.aj.dispatched, [
    { design: 'Rose', shade: 'Red', requested: 2, sent: 2, bales: ['P1', 'P2'] },
    { design: 'Lily', shade: 'Blue', requested: 2, sent: 1, bales: ['P4'] },
  ]);
  assert.equal(calls.ajPatches[0].patch.stage, 'in_transit');
  assert.deepEqual(calls.ajPatches[0].patch.bales, ['P1', 'P2', 'P4']);
});

test('dispatch: fails when NO line has stock; refuses wrong stage', async () => {
  stub(ROW('requested'), [] /* empty warehouse */);
  const res = await transferService.dispatch('TR-1', 'abdul', [['P1', 'P2'], ['P4']]);
  assert.equal(res.ok, false);
  assert.match(res.message, /No stock left/);
  // TRF-15 — a dispatch without explicit picks is refused outright.
  stub(ROW('requested'));
  const noPicks = await transferService.dispatch('TR-1', 'abdul');
  assert.equal(noPicks.ok, false);
  assert.match(noPicks.message, /explicitly picked/);
  stub(ROW('in_transit'));
  assert.equal((await transferService.dispatch('TR-1', 'abdul')).ok, false);
});

// In-transit fixture: the bales sit at the DESTINATION (dispatch stamped it).
const IN_TRANSIT_INV = [
  { rowIndex: 2, baleUid: 'U-P1a', packageNo: 'P1', design: 'Rose', shade: 'Red', warehouse: 'Kano office', status: 'in_transit' },
  { rowIndex: 3, baleUid: 'U-P2a', packageNo: 'P2', design: 'Rose', shade: 'Red', warehouse: 'Kano office', status: 'in_transit' },
  { rowIndex: 5, baleUid: 'U-P4a', packageNo: 'P4', design: 'Lily', shade: 'Blue', warehouse: 'Kano office', status: 'in_transit' },
  // Same printed number ELSEWHERE, also in transit — must never be touched.
  { rowIndex: 9, baleUid: 'U-P1x', packageNo: 'P1', design: 'Other', shade: '1', warehouse: 'PH', status: 'in_transit' },
];

test('confirmReceipt: unlocks the LOGGED bales (uid-exact), closes row, logs transaction', async () => {
  const calls = stub(ROW('in_transit', {
    bales: ['P1', 'P2', 'P4'], baleUids: ['U-P1a', 'U-P2a', 'U-P4a'],
    dispatched: [{ design: 'Rose', shade: 'Red', requested: 2, sent: 2 }, { design: 'Lily', shade: 'Blue', requested: 2, sent: 1 }],
  }), IN_TRANSIT_INV);
  const res = await transferService.confirmReceipt('TR-1', 'musa');
  assert.equal(res.ok, true);
  assert.equal(res.mismatch, null, 'all logged rows matched');
  const t0 = calls.transitions[0];
  assert.deepEqual(t0.opts.uids, ['U-P1a', 'U-P2a', 'U-P4a'], 'uid-exact — the PH P1 is untouchable');
  assert.equal(t0.from, 'in_transit');
  assert.equal(t0.to, 'available');
  assert.deepEqual(calls.statusUpdates[0], { id: 'TR-1', status: 'approved' });
  assert.equal(calls.txns[0].qty, 3, 'transaction logs actually-sent count');
  assert.equal(calls.txns[0].before, 'Lagos');
  assert.equal(calls.txns[0].after, 'Kano office');
});

test('confirmReceipt: pre-uid transfer falls back to printed numbers SCOPED to its destination', async () => {
  const calls = stub(ROW('in_transit', { bales: ['P1', 'P2', 'P4'] }), IN_TRANSIT_INV);
  const res = await transferService.confirmReceipt('TR-1', 'musa');
  assert.equal(res.ok, true);
  assert.equal(res.mismatch, null);
  assert.equal(calls.transitions[0].opts.warehouse, 'Kano office', 'legacy fallback stays inside aj.to');
});

test('confirmReceipt: fewer rows than logged closes WITH a mismatch flag, never silently', async () => {
  const calls = stub(ROW('in_transit', {
    bales: ['P1', 'P2', 'P4'], baleUids: ['U-P1a', 'U-P2a', 'U-P4a'],
  }), IN_TRANSIT_INV.filter((r) => r.baleUid !== 'U-P2a')); // P2 hand-edited away
  const res = await transferService.confirmReceipt('TR-1', 'musa');
  assert.equal(res.ok, true, 'goods physically arrived — still closes');
  assert.ok(res.mismatch, 'mismatch surfaced');
  assert.equal(res.mismatch.flippedRows, 2);
  assert.ok(calls.audits.some((a) => a.event === 'transfer.receive_mismatch'), 'audited');
});

test('confirmReceipt: refuses before dispatch', async () => {
  stub(ROW('requested'));
  assert.equal((await transferService.confirmReceipt('TR-1', 'musa')).ok, false);
});

test('abort pre-dispatch = declined, NOTHING reverted (nothing was moved)', async () => {
  const calls = stub(ROW('requested'));
  const res = await transferService.abort('TR-1', 'abdul');
  assert.equal(res.kind, 'declined');
  assert.equal(calls.transitions.length, 0, 'no inventory touch');
  assert.deepEqual(calls.statusUpdates[0], { id: 'TR-1', status: 'rejected' });
  assert.equal(calls.audits[0].event, 'transfer.declined');
});

test('abort post-dispatch = rejected, logged bales revert to source', async () => {
  const calls = stub(ROW('in_transit', { bales: ['P1', 'P2'], baleUids: ['U-P1a', 'U-P2a'] }), IN_TRANSIT_INV);
  const res = await transferService.abort('TR-1', 'musa');
  assert.equal(res.kind, 'rejected');
  const t0 = calls.transitions[0];
  assert.deepEqual(t0.pkgs, ['P1', 'P2']);
  assert.equal(t0.from, 'in_transit');
  assert.equal(t0.to, 'available');
  assert.equal(t0.wh, 'Lagos');
  assert.deepEqual(t0.opts.uids, ['U-P1a', 'U-P2a'], 'uid-exact revert');
  assert.equal(res.mismatch, null);
  const again = await transferService.abort('TR-1', 'musa');
  assert.equal(again.ok, false, 'terminal rows refuse further aborts');
});

test('getOpenTransfers filters to pending transfer_stock rows', async () => {
  stub(ROW('requested'));
  assert.equal((await transferService.getOpenTransfers()).length, 1);
  approvalQueueRepository.getAllPending = async () => [
    { requestId: 'X', status: 'pending', actionJSON: { action: 'update_price' } },
  ];
  assert.equal((await transferService.getOpenTransfers()).length, 0);
});

test('SEC-P2 H3: concurrent double-dispatch transitions bales only once', async () => {
  const calls = stub(ROW('requested'));
  // Both taps fire "at once"; the per-request lock must serialize them so the
  // second sees stage=in_transit and bails instead of re-transitioning.
  const [r1, r2] = await Promise.all([
    transferService.dispatch('TR-1', 'abdul', [['P1', 'P2'], ['P4']]),
    transferService.dispatch('TR-1', 'abdul', [['P1', 'P2'], ['P4']]),
  ]);
  const okCount = [r1, r2].filter((r) => r.ok).length;
  assert.equal(okCount, 1, 'exactly one dispatch succeeds');
  assert.equal(calls.transitions.length, 1, 'bales transitioned exactly once');
  const loser = [r1, r2].find((r) => !r.ok);
  assert.match(loser.message, /cannot dispatch/);
});

test('SEC-P2 H3: dispatch racing abort — bales are not both moved and reverted', async () => {
  const calls = stub(ROW('requested'));
  const [d, a] = await Promise.all([
    transferService.dispatch('TR-1', 'abdul'),
    transferService.abort('TR-1', 'admin1'),
  ]);
  // Whichever wins the lock first: if dispatch wins, abort then sees
  // stage=in_transit and reverts (rejected); if abort wins (declined),
  // dispatch sees status=rejected and bails. Either way the row ends
  // terminal and inventory nets out — never a half-applied double move.
  assert.ok(d.ok || a.ok, 'at least one op resolves the row');
  assert.deepEqual(calls.statusUpdates.map((s) => s.status).filter(Boolean).slice(-1), ['rejected']);
});
