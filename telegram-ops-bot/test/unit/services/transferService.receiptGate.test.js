'use strict';
/**
 * TRF-22 (owner, 07-Oct-2026): "one extra gate after the goods are received
 * by the recipient … one admin will approve, which will flip the bill
 * details from in transit to received." The receiver REPORTS (nothing
 * moves), one admin CONFIRMS (the TRF-21 receipt runs with the reported
 * bales) or SENDS BACK (nothing moves, the report keeps its number). Two
 * people on every receipt: the reporter never confirms their own.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const transferService = require('../../../src/services/transferService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');

const INV = () => [
  { rowIndex: 2, baleUid: 'U-P1', packageNo: 'P1', design: 'Rose', shade: 'Red', warehouse: 'Kano office', status: 'in_transit' },
  { rowIndex: 3, baleUid: 'U-P2', packageNo: 'P2', design: 'Rose', shade: 'Red', warehouse: 'Kano office', status: 'in_transit' },
  { rowIndex: 4, baleUid: 'U-P3', packageNo: 'P3', design: 'Lily', shade: 'Blue', warehouse: 'Kano office', status: 'in_transit' },
];
const ROW = (over = {}) => ({
  requestId: 'TR-1', user: 'admin1', status: 'pending',
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
  approvalQueueRepository.updateStatus = async (id, status) => { calls.statusUpdates.push({ id, status }); current.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { calls.ajPatches.push({ id, patch }); current.actionJSON = { ...current.actionJSON, ...patch }; return true; };
  transactionsRepository.append = async (t) => { calls.txns.push(t); };
  auditLogRepository.append = async (event, meta, user) => { calls.audits.push({ event, meta, user }); };
  return { calls, store, row: () => current };
}

test('report → nothing moves; the document lands on the report; the reporter cannot confirm; another admin confirms and the TRF-21 receipt runs', async () => {
  const { calls, store, row } = stub(ROW());
  const rep = await transferService.reportReceipt('TR-1', 'musa', { bales: ['P1', 'P2'] });
  assert.equal(rep.ok, true, rep.message);
  assert.equal(rep.n, 1);
  assert.deepEqual(rep.bales, ['P1', 'P2']);
  assert.equal(calls.transitions.length, 0, 'nothing flips on a report');
  assert.equal(row().actionJSON.pendingReceipt, 1);
  assert.equal(transferService.pendingReport(row().actionJSON).status, 'pending');
  assert.equal(calls.audits.at(-1).event, 'transfer.receipt_reported');

  await transferService.attachDoc('TR-1', 'receive', { fileId: 'PDF1', mime: 'application/pdf', by: 'musa', report: 1 });
  assert.equal(row().actionJSON.receiptReports[0].doc.fileId, 'PDF1', 'the file belongs to the report');
  assert.equal(row().actionJSON.receiveDoc, undefined, 'and not to the transfer yet');

  const again = await transferService.reportReceipt('TR-1', 'musa', { bales: ['P3'] });
  assert.equal(again.ok, false); assert.match(again.message, /receipt 1 is already with the admins/);

  const self = await transferService.confirmReportedReceipt('TR-1', 'musa');
  assert.equal(self.ok, false); assert.match(self.message, /different admin must confirm/);
  assert.equal(calls.transitions.length, 0);

  const res = await transferService.confirmReportedReceipt('TR-1', '888');
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(res.received, ['P1', 'P2']);
  assert.equal(res.closed, false);
  assert.deepEqual(calls.transitions[0].pkgs, ['P1', 'P2']);
  assert.deepEqual(calls.transitions[0].opts.uids, ['U-P1', 'U-P2']);
  assert.deepEqual(store.map((r) => r.status), ['available', 'available', 'in_transit']);
  const aj = row().actionJSON;
  assert.equal(aj.pendingReceipt, null);
  assert.deepEqual(aj.receivedBales, ['P1', 'P2']);
  assert.equal(aj.receiptReports[0].status, 'confirmed');
  assert.equal(aj.receiptReports[0].confirmedBy, '888');
  assert.equal(aj.receiptReports[0].delivery, 1);
  assert.equal(aj.receipts[0].doc.fileId, 'PDF1', 'the report\'s document is stamped on the delivery');
  assert.equal(aj.receiveDoc.fileId, 'PDF1');
  assert.equal(row().status, 'pending', 'one bale still on the road');
  assert.equal(calls.txns.length, 1);
  assert.equal(calls.audits.at(-1).event, 'transfer.receipt_confirmed');
});

test('send back → nothing moves, the report keeps its number with the reason; the next report is number 2; the closing confirmation closes the row', async () => {
  const { calls, store, row } = stub(ROW());
  await transferService.reportReceipt('TR-1', 'musa', {});
  const sb = await transferService.sendBackReceipt('TR-1', '888', 'only two bales are here');
  assert.equal(sb.ok, true);
  assert.equal(calls.transitions.length, 0);
  let aj = row().actionJSON;
  assert.equal(aj.pendingReceipt, null);
  assert.deepEqual([aj.receiptReports[0].n, aj.receiptReports[0].status, aj.receiptReports[0].reason], [1, 'sent_back', 'only two bales are here']);
  assert.equal(transferService.pendingReport(aj), null, 'the receiver may report again');

  const r2 = await transferService.reportReceipt('TR-1', 'musa', { bales: ['P1', 'P2'] });
  assert.equal(r2.n, 2);
  assert.equal((await transferService.confirmReportedReceipt('TR-1', '777')).ok, true);
  const r3 = await transferService.reportReceipt('TR-1', 'musa', {});
  assert.equal(r3.n, 3);
  assert.deepEqual(r3.bales, ['P3'], 'a bare ✅ Received reports everything still outstanding');
  const res = await transferService.confirmReportedReceipt('TR-1', '888');
  assert.equal(res.ok, true, res.message);
  assert.equal(res.closed, true);
  assert.equal(row().status, 'approved');
  assert.deepEqual(store.map((r) => r.status), ['available', 'available', 'available']);
  aj = row().actionJSON;
  assert.deepEqual(aj.receiptReports.map((r) => r.status), ['sent_back', 'confirmed', 'confirmed']);
  assert.equal(aj.receipts.length, 2, 'two deliveries');
});

test('refusals: a report on a transfer not in transit; confirming or sending back with nothing pending', async () => {
  stub(ROW({ stage: 'requested' }));
  assert.match((await transferService.reportReceipt('TR-1', 'musa', {})).message, /cannot report a receipt/);
  stub(ROW());
  assert.match((await transferService.confirmReportedReceipt('TR-1', '888')).message, /no receipt awaiting confirmation/);
  assert.match((await transferService.sendBackReceipt('TR-1', '888', 'x')).message, /no receipt awaiting confirmation/);
  const none = await transferService.reportReceipt('TR-1', 'musa', { bales: ['P9'] });
  assert.match(none.message, /none of those bales/);
});

test('getActionableFor: a reported receipt is the admins\' move, never the reporter\'s', async () => {
  process.env.ADMIN_IDS = process.env.ADMIN_IDS || '777,888';
  const { row } = stub(ROW());
  await transferService.reportReceipt('TR-1', 'musa', {});
  approvalQueueRepository.getAllPending = async () => [JSON.parse(JSON.stringify(row()))];
  const auth = require('../../../src/middlewares/auth');
  const realIsAdmin = auth.isAdmin;
  auth.isAdmin = (id) => ['777', '888'].includes(String(id));
  try {
    assert.equal((await transferService.getActionableFor('musa')).length, 0, 'the receiver has nothing to do');
    assert.equal((await transferService.getActionableFor('777')).length, 1, 'an admin does');
  } finally { auth.isAdmin = realIsAdmin; }
});
