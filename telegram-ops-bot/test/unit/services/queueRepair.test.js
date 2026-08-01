'use strict';

/**
 * TRID-1 — duplicate transfer-id repair + restart-proof id minting.
 * Queue/audit repos are stubbed; bot is the recording fake. No sheets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const queueRepair = require('../../../src/services/queueRepair');
const transferService = require('../../../src/services/transferService');

const audits = [];
const origAudit = auditLogRepository.append;
auditLogRepository.append = async (event, meta, userId) => { audits.push({ event, meta, userId }); };

const orig = {
  getAllWithRowIndex: approvalQueueRepository.getAllWithRowIndex,
  renameRequestIdAtRow: approvalQueueRepository.renameRequestIdAtRow,
};
test.afterEach(() => {
  Object.assign(approvalQueueRepository, orig);
  audits.length = 0;
});
test.after(() => { auditLogRepository.append = origAudit; });

function trRow(rowIndex, requestId, status, aj = {}) {
  return {
    rowIndex, requestId, user: '10', status,
    createdAt: '2026-07-31T10:00:00.000Z', resolvedAt: status === 'pending' ? '' : '2026-07-31T18:00:00.000Z',
    actionJSON: { action: 'transfer_stock', from: 'IDUMOTA', to: 'Kano office', dispatcher: '11', receiver: '12', stage: 'requested', lines: [{ design: 'D', shade: '1', qty: 43 }], ...aj },
  };
}

test('TRID-1: pending row colliding with a resolved one is renamed to the next free seq', async () => {
  const renames = [];
  approvalQueueRepository.getAllWithRowIndex = async () => [
    trRow(2, 'TR-20260731-001', 'approved', { stage: 'in_transit', bales: ['B1'] }), // the received 7-bale one
    trRow(3, 'TR-20260731-001', 'pending'),                                          // the stuck 43-bale request
    trRow(4, 'TR-20260724-002', 'approved'),                                         // unrelated, untouched
  ];
  approvalQueueRepository.renameRequestIdAtRow = async (rowIndex, oldId, newId) => { renames.push({ rowIndex, oldId, newId }); return true; };

  const bot = createFakeBot();
  const r = await queueRepair.dedupeTransferIds(bot);

  assert.deepEqual(renames, [{ rowIndex: 3, oldId: 'TR-20260731-001', newId: 'TR-20260731-002' }],
    'only the PENDING row is renamed; the resolved row keeps its id');
  assert.deepEqual(r.repaired, [{ oldId: 'TR-20260731-001', newId: 'TR-20260731-002', rowIndex: 3 }]);
  assert.equal(audits[0].event, 'transfer.id_repaired');
  assert.deepEqual(audits[0].meta, { oldId: 'TR-20260731-001', newId: 'TR-20260731-002', rowIndex: 3, stage: 'requested' });
  // Dispatcher (stage requested) gets a fresh pointer carrying the NEW id.
  const dm = bot.callsTo('sendMessage')[0];
  assert.equal(String(dm.args.chatId), '11');
  assert.match(dm.args.text, /TR-20260731-002/);
  const kb = dm.args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === 'trf:card:TR-20260731-002'));
});

test('TRID-1: new seq skips ids already taken that day (incl. ones assigned this run)', async () => {
  const renames = [];
  approvalQueueRepository.getAllWithRowIndex = async () => [
    trRow(2, 'TR-20260731-001', 'approved'),
    trRow(3, 'TR-20260731-001', 'pending'),
    trRow(4, 'TR-20260731-001', 'pending', { stage: 'in_transit' }), // second colliding pending
    trRow(5, 'TR-20260731-004', 'pending'),                          // seq 4 already taken
  ];
  approvalQueueRepository.renameRequestIdAtRow = async (rowIndex, oldId, newId) => { renames.push({ rowIndex, newId }); return true; };
  const r = await queueRepair.dedupeTransferIds(createFakeBot());
  assert.deepEqual(renames.map((x) => x.newId), ['TR-20260731-005', 'TR-20260731-006'], 'each rename lands on a fresh seq');
  assert.equal(r.repaired.length, 2);
});

test('TRID-1: clean queue and resolved-only duplicates are a no-op', async () => {
  approvalQueueRepository.getAllWithRowIndex = async () => [
    trRow(2, 'TR-20260731-001', 'approved'),
    trRow(3, 'TR-20260731-002', 'pending'),
    trRow(4, 'TR-20260720-001', 'rejected'),
    trRow(5, 'TR-20260720-001', 'approved'), // resolved-vs-resolved: history, untouched
  ];
  approvalQueueRepository.renameRequestIdAtRow = async () => { throw new Error('must not be called'); };
  const bot = createFakeBot();
  const r = await queueRepair.dedupeTransferIds(bot);
  assert.deepEqual(r, { repaired: [], skippedPendingOnly: 0, failed: 0 });
  assert.equal(bot.callsTo('sendMessage').length, 0);
  assert.equal(audits.length, 0);
});

test('TRID-1: pending-vs-pending collision is flagged but left alone', async () => {
  approvalQueueRepository.getAllWithRowIndex = async () => [
    trRow(2, 'TR-20260731-003', 'pending'),
    trRow(3, 'TR-20260731-003', 'pending'),
  ];
  approvalQueueRepository.renameRequestIdAtRow = async () => { throw new Error('must not be called'); };
  const r = await queueRepair.dedupeTransferIds(createFakeBot());
  assert.deepEqual(r, { repaired: [], skippedPendingOnly: 1, failed: 0 });
});

test('TRID-1: compare-and-set refusal counts as failed, no audit, no DM', async () => {
  approvalQueueRepository.getAllWithRowIndex = async () => [
    trRow(2, 'TR-20260731-001', 'approved'),
    trRow(3, 'TR-20260731-001', 'pending'),
  ];
  approvalQueueRepository.renameRequestIdAtRow = async () => false; // concurrent write
  const bot = createFakeBot();
  const r = await queueRepair.dedupeTransferIds(bot);
  assert.equal(r.failed, 1);
  assert.equal(r.repaired.length, 0);
  assert.equal(audits.length, 0);
  assert.equal(bot.callsTo('sendMessage').length, 0);
});

test('TRID-1: non-TR ids (UUID approvals) are never considered', async () => {
  approvalQueueRepository.getAllWithRowIndex = async () => [
    { rowIndex: 2, requestId: '9ddcb92e-50f6-43f5-9d42-1a0200f4a896', status: 'approved', actionJSON: {} },
    { rowIndex: 3, requestId: '9ddcb92e-50f6-43f5-9d42-1a0200f4a896', status: 'pending', actionJSON: {} },
  ];
  approvalQueueRepository.renameRequestIdAtRow = async () => { throw new Error('must not be called'); };
  const r = await queueRepair.dedupeTransferIds(createFakeBot());
  assert.deepEqual(r.repaired, []);
});

test('TRID-1: uniqueTransferId seeds the sequence from the queue (restart-proof)', async () => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  approvalQueueRepository.getAllWithRowIndex = async () => [
    trRow(2, `TR-${date}-007`, 'approved'),
    trRow(3, `TR-${date}-002`, 'pending'),
    trRow(4, 'TR-20200101-999', 'approved'), // other day — ignored
  ];
  assert.equal(await transferService.uniqueTransferId(), `TR-${date}-008`);
});

test('TRID-1: unreadable queue falls back to a high random sequence, never a low reuse', async () => {
  approvalQueueRepository.getAllWithRowIndex = async () => { throw new Error('sheets down'); };
  const id = await transferService.uniqueTransferId();
  const m = /^TR-\d{8}-(\d+)$/.exec(id);
  assert.ok(m, `well-formed id, got ${id}`);
  assert.ok(parseInt(m[1], 10) > 500, `high sequence, got ${id}`);
});
