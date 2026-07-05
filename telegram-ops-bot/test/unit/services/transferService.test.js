'use strict';

/**
 * TRF-2 — transferService (queue-carried, lean): pure selection helpers +
 * create / dispatch / confirmReceipt / abort lifecycle. Repos stubbed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const transferService = require('../../../src/services/transferService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');

const INV = [
  { packageNo: 'P1', design: 'Rose', shade: 'Red', warehouse: 'Lagos', status: 'available' },
  { packageNo: 'P2', design: 'Rose', shade: 'Red', warehouse: 'Lagos', status: 'available' },
  { packageNo: 'P3', design: 'Rose', shade: 'Red', warehouse: 'Lagos', status: 'sold' },
  { packageNo: 'P4', design: 'Rose', shade: 'Red', warehouse: 'Kano office', status: 'available' },
  // P5 spans two thans — must count once.
  { packageNo: 'P5', design: 'Rose', shade: 'Red', warehouse: 'Lagos', status: 'available' },
  { packageNo: 'P5', design: 'Rose', shade: 'Red', warehouse: 'Lagos', status: 'available' },
];

test('availableBales: distinct + filtered by status/warehouse/design/shade', () => {
  assert.deepEqual(transferService.availableBales(INV, 'Lagos', 'rose', 'RED'), ['P1', 'P2', 'P5']);
});

test('selectByQuantity: first-N in sheet order; shortfall flagged', () => {
  const ok = transferService.selectByQuantity(INV, 'Lagos', 'Rose', 'Red', 2);
  assert.deepEqual(ok, { ok: true, bales: ['P1', 'P2'], available: 3 });
  const short = transferService.selectByQuantity(INV, 'Lagos', 'Rose', 'Red', 9);
  assert.equal(short.ok, false);
  assert.equal(short.available, 3);
});

/** Stub all repos; returns recorder + a mutable queue row. */
function stub(row) {
  const calls = { transitions: [], appends: [], statusUpdates: [], ajPatches: [], txns: [], audits: [] };
  let current = row ? JSON.parse(JSON.stringify(row)) : null;
  inventoryRepository.transitionBales = async (pkgs, from, to, wh) => { calls.transitions.push({ pkgs, from, to, wh }); return []; };
  approvalQueueRepository.append = async (rec) => { calls.appends.push(rec); current = { ...rec, status: 'pending' }; return rec; };
  approvalQueueRepository.getByRequestId = async () => (current ? JSON.parse(JSON.stringify(current)) : null);
  approvalQueueRepository.getAllPending = async () => (current && current.status === 'pending' ? [current] : []);
  approvalQueueRepository.updateStatus = async (id, status) => { calls.statusUpdates.push({ id, status }); current.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { calls.ajPatches.push({ id, patch }); current.actionJSON = { ...current.actionJSON, ...patch }; return true; };
  transactionsRepository.append = async (t) => { calls.txns.push(t); };
  auditLogRepository.append = async (event, meta, user) => { calls.audits.push({ event, user }); };
  return calls;
}

const ROW = (stage) => ({
  requestId: 'TR-1', user: 'admin1', status: 'pending',
  actionJSON: {
    action: 'transfer_stock', from: 'Lagos', to: 'Kano office', design: 'Rose', shade: 'Red',
    qty: 2, bales: ['P1', 'P2'], dispatcher: 'abdul', receiver: 'musa', stage,
  },
});

test('createTransfer: bales → in_transit @ dest, queue row appended, audited', async () => {
  const calls = stub();
  const { requestId, aj } = await transferService.createTransfer({
    from: 'Lagos', to: 'Kano office', design: 'Rose', shade: 'Red', qty: 2,
    bales: ['P1', 'P2'], requestedBy: 'admin1', dispatcher: 'abdul', receiver: 'musa',
  });
  assert.match(requestId, /^TR-/);
  assert.equal(aj.stage, 'requested');
  assert.deepEqual(calls.transitions[0], { pkgs: ['P1', 'P2'], from: 'available', to: 'in_transit', wh: 'Kano office' });
  assert.equal(calls.appends[0].actionJSON.dispatcher, 'abdul');
  assert.equal(calls.audits[0].event, 'transfer.requested');
});

test('dispatch: requested → in_transit stage patch, no inventory change', async () => {
  const calls = stub(ROW('requested'));
  const res = await transferService.dispatch('TR-1', 'abdul');
  assert.equal(res.ok, true);
  assert.equal(calls.ajPatches[0].patch.stage, 'in_transit');
  assert.equal(calls.transitions.length, 0);
  assert.equal(calls.audits[0].event, 'transfer.dispatched');
});

test('dispatch: refuses when not in requested stage', async () => {
  stub(ROW('in_transit'));
  const res = await transferService.dispatch('TR-1', 'abdul');
  assert.equal(res.ok, false);
});

test('confirmReceipt: unlocks bales @ dest, closes row, logs transaction', async () => {
  const calls = stub(ROW('in_transit'));
  const res = await transferService.confirmReceipt('TR-1', 'musa');
  assert.equal(res.ok, true);
  assert.deepEqual(calls.transitions[0], { pkgs: ['P1', 'P2'], from: 'in_transit', to: 'available', wh: null });
  assert.deepEqual(calls.statusUpdates[0], { id: 'TR-1', status: 'approved' });
  assert.equal(calls.txns[0].action, 'transfer_stock');
  assert.equal(calls.txns[0].before, 'Lagos');
  assert.equal(calls.txns[0].after, 'Kano office');
  assert.equal(calls.audits[0].event, 'transfer.received');
});

test('confirmReceipt: refuses before dispatch', async () => {
  stub(ROW('requested'));
  const res = await transferService.confirmReceipt('TR-1', 'musa');
  assert.equal(res.ok, false);
});

test('abort pre-dispatch = declined; bales revert to source', async () => {
  const calls = stub(ROW('requested'));
  const res = await transferService.abort('TR-1', 'abdul');
  assert.equal(res.kind, 'declined');
  assert.deepEqual(calls.transitions[0], { pkgs: ['P1', 'P2'], from: 'in_transit', to: 'available', wh: 'Lagos' });
  assert.deepEqual(calls.statusUpdates[0], { id: 'TR-1', status: 'rejected' });
  assert.equal(calls.audits[0].event, 'transfer.declined');
});

test('abort in transit = rejected; terminal rows refuse further aborts', async () => {
  const calls = stub(ROW('in_transit'));
  const res = await transferService.abort('TR-1', 'musa');
  assert.equal(res.kind, 'rejected');
  assert.equal(calls.audits[0].event, 'transfer.rejected');
  const again = await transferService.abort('TR-1', 'musa');
  assert.equal(again.ok, false, 'already rejected');
});

test('getOpenTransfers filters to pending transfer_stock rows', async () => {
  stub(ROW('requested'));
  const open = await transferService.getOpenTransfers();
  assert.equal(open.length, 1);
  approvalQueueRepository.getAllPending = async () => [
    { requestId: 'X', status: 'pending', actionJSON: { action: 'update_price' } },
  ];
  assert.equal((await transferService.getOpenTransfers()).length, 0);
});
