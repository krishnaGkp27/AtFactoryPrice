'use strict';
/**
 * TRF-22 (owner, 07-Oct-2026): "my manager has accepted all the bales, but
 * some of the bales did not arrive yet." reverseReceipt puts exactly the
 * picked bales back on the road, reopens the row, and refuses by name any
 * bale sold or moved since the receipt — flipping nothing for the others.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const transferService = require('../../../src/services/transferService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');

const INV = () => [
  { rowIndex: 2, baleUid: 'U-P1', packageNo: 'P1', design: 'Rose', shade: 'Red', warehouse: 'Kano office', status: 'available' },
  { rowIndex: 3, baleUid: 'U-P2', packageNo: 'P2', design: 'Rose', shade: 'Red', warehouse: 'Kano office', status: 'available' },
  { rowIndex: 4, baleUid: 'U-P3', packageNo: 'P3', design: 'Lily', shade: 'Blue', warehouse: 'Kano office', status: 'available' },
];
const RECEIVED = (over = {}) => ({
  requestId: 'TR-1', user: 'admin1', status: 'approved', resolvedAt: '2026-10-06T10:00:00.000Z', approver: 'Ajeet',
  actionJSON: {
    action: 'transfer_stock', from: 'Lagos', to: 'Kano office', stage: 'in_transit', dispatcher: 'abdul', receiver: 'musa',
    lines: [{ design: 'Rose', shade: 'Red', qty: 2 }, { design: 'Lily', shade: 'Blue', qty: 1 }],
    bales: ['P1', 'P2', 'P3'], baleUids: ['U-P1', 'U-P2', 'U-P3'],
    dispatched: [{ design: 'Rose', shade: 'Red', requested: 2, sent: 2, bales: ['P1', 'P2'] }, { design: 'Lily', shade: 'Blue', requested: 1, sent: 1, bales: ['P3'] }],
    ...over,
  },
});

function stub(row, inv = INV()) {
  const calls = { transitions: [], statusUpdates: [], ajPatches: [], txns: [], audits: [] };
  let current = JSON.parse(JSON.stringify(row));
  const store = inv;
  inventoryRepository.getAll = async () => JSON.parse(JSON.stringify(store));
  inventoryRepository.transitionBales = async (pkgs, from, to, wh, opts = {}) => {
    calls.transitions.push({ pkgs, from, to, wh, opts });
    const uidSet = Array.isArray(opts.uids) && opts.uids.length ? new Set(opts.uids.map(String)) : null;
    const set = new Set((pkgs || []).map(String));
    const rows = store.filter((r) => r.status === from && (uidSet ? uidSet.has(r.baleUid) : set.has(r.packageNo)));
    rows.forEach((r) => { r.status = to; if (wh != null) r.warehouse = wh; });
    return rows.map((r) => ({ ...r }));
  };
  approvalQueueRepository.getByRequestId = async () => JSON.parse(JSON.stringify(current));
  approvalQueueRepository.updateStatus = async (id, status, resolvedAt, approver) => { calls.statusUpdates.push({ id, status, resolvedAt, approver }); current.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { calls.ajPatches.push({ id, patch }); current.actionJSON = { ...current.actionJSON, ...patch }; return true; };
  transactionsRepository.append = async (t) => { calls.txns.push(t); };
  auditLogRepository.append = async (event, meta, user) => { calls.audits.push({ event, meta, user }); };
  return { calls, store, row: () => current };
}

test('a received transfer: the picked bales go back on the road, the row reopens, the record and books say so', async () => {
  const { calls, store, row } = stub(RECEIVED());
  const res = await transferService.reverseReceipt('TR-1', ['P2', 'P3'], '888', { reason: 'truck came half', requestedBy: 'musa', ref: 'REQ-9' });
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(res.reversed, ['P2', 'P3']);
  assert.deepEqual(res.remaining, ['P2', 'P3'], 'they are outstanding again');
  assert.equal(res.reopened, true);
  const t = calls.transitions[0];
  assert.deepEqual([t.from, t.to, t.wh], ['available', 'in_transit', null], 'the rows stay at the destination column, as dispatch left them');
  assert.deepEqual(t.opts.uids, ['U-P2', 'U-P3'], 'exactly the received rows of the picked bales');
  assert.equal(t.opts.fromWarehouse, 'Lagos');
  assert.deepEqual(store.map((r) => r.status), ['available', 'in_transit', 'in_transit']);
  assert.deepEqual(calls.statusUpdates, [{ id: 'TR-1', status: 'pending', resolvedAt: '2026-10-06T10:00:00.000Z', approver: 'Ajeet' }], 'reopened; the release stamp is kept');
  const aj = row().actionJSON;
  assert.deepEqual(aj.receivedBales, ['P1']);
  assert.deepEqual(aj.receivedUids, ['U-P1']);
  assert.equal(aj.reversals.length, 1);
  assert.deepEqual(aj.reversals[0].bales, ['P2', 'P3']);
  assert.equal(aj.reversals[0].reason, 'truck came half');
  assert.equal(aj.reversals[0].ref, 'REQ-9');
  assert.deepEqual(transferService.receiptState(aj).remaining, ['P2', 'P3']);
  assert.equal(calls.txns.length, 1);
  assert.deepEqual([calls.txns[0].action, calls.txns[0].qty, calls.txns[0].before, calls.txns[0].design], ['transfer_unreceive', 2, 'Kano office', 'Rose+Lily']);
  assert.equal(calls.audits[0].event, 'transfer.receipt_reversed');
});

test('a bale sold or moved since the receipt is refused BY NAME and nothing is flipped for the others', async () => {
  const inv = INV();
  inv[1].status = 'sold';
  inv[2].warehouse = 'IDUMOTA';
  const { calls } = stub(RECEIVED(), inv);
  const res = await transferService.reverseReceipt('TR-1', ['P1', 'P2', 'P3'], '888', {});
  assert.equal(res.ok, false);
  assert.match(res.message, /bale\(s\) P2, P3 are no longer available at Kano office/);
  assert.equal(calls.transitions.length, 0);
  assert.equal(calls.statusUpdates.length, 0);
});

test('refusals: a bale never received, a declined transfer, a duplicated number; a partly received row reverses too', async () => {
  let s = stub(RECEIVED());
  let res = await transferService.reverseReceipt('TR-1', ['P9'], '888', {});
  assert.equal(res.ok, false); assert.match(res.message, /none of those bales is on record as received/);

  s = stub({ ...RECEIVED(), status: 'rejected' });
  res = await transferService.reverseReceipt('TR-1', ['P1'], '888', {});
  assert.equal(res.ok, false); assert.match(res.message, /transfer is rejected/);

  s = stub(RECEIVED({ bales: ['P1', 'P1', 'P3'], baleUids: ['U-P1', 'U-P2', 'U-P3'] }));
  res = await transferService.reverseReceipt('TR-1', ['P1'], '888', {});
  assert.equal(res.ok, false); assert.match(res.message, /same bale number more than once/);

  // TRF-21 partial: P1 received, P2/P3 on the road; P1 ticked by mistake.
  const inv = INV(); inv[1].status = 'in_transit'; inv[2].status = 'in_transit';
  s = stub({ ...RECEIVED({ receivedBales: ['P1'], receivedUids: ['U-P1'], receipts: [{ at: 'x', bales: ['P1'] }] }), status: 'pending' }, inv);
  res = await transferService.reverseReceipt('TR-1', ['P1'], '888', { reason: 'mis-ticked' });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.reopened, false, 'already open');
  assert.equal(s.calls.statusUpdates.length, 0);
  assert.deepEqual(s.row().actionJSON.receivedBales, []);
  assert.deepEqual(res.remaining, ['P1', 'P2', 'P3']);
});
