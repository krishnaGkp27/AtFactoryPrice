'use strict';

/**
 * TRF-5 cleanup — boot sweep rejects still-pending LEGACY transfer rows
 * only; live actions (transfer_stock etc.) are untouched. Repos stubbed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const legacyCleanup = require('../../../src/services/legacyCleanup');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');

function arm(pending) {
  const calls = { statusUpdates: [], audits: [] };
  approvalQueueRepository.getAllPending = async () => pending;
  approvalQueueRepository.updateStatus = async (id, status) => { calls.statusUpdates.push({ id, status }); return true; };
  auditLogRepository.append = async (event, meta) => { calls.audits.push({ event, requestId: meta.requestId }); };
  return calls;
}

const row = (requestId, action) => ({ requestId, status: 'pending', actionJSON: { action } });

test('rejects only legacy transfer rows; live rows untouched', async () => {
  const calls = arm([
    row('R1', 'transfer_package'),
    row('R2', 'transfer_than'),
    row('R3', 'transfer_batch'),
    row('R4', 'transfer_stock'),   // TRF-2+ — live, must survive
    row('R5', 'update_price'),     // unrelated — must survive
    { requestId: 'R6', status: 'pending', actionJSON: null }, // malformed — skipped
  ]);
  const res = await legacyCleanup.rejectStaleLegacyTransfers();
  assert.deepEqual(res, { rejected: 3, failed: 0 });
  assert.deepEqual(calls.statusUpdates.map((u) => u.id).sort(), ['R1', 'R2', 'R3']);
  assert.ok(calls.statusUpdates.every((u) => u.status === 'rejected'));
  assert.equal(calls.audits.length, 3);
  assert.ok(calls.audits.every((a) => a.event === 'legacy_transfer_rejected'));
});

test('empty queue → quiet no-op', async () => {
  const calls = arm([]);
  const res = await legacyCleanup.rejectStaleLegacyTransfers();
  assert.deepEqual(res, { rejected: 0, failed: 0 });
  assert.equal(calls.statusUpdates.length, 0);
});

test('a failing row is counted but never breaks the sweep', async () => {
  const calls = arm([row('R1', 'transfer_package'), row('R2', 'transfer_than')]);
  approvalQueueRepository.updateStatus = async (id) => {
    if (id === 'R1') throw new Error('sheet hiccup');
    calls.statusUpdates.push({ id });
    return true;
  };
  const res = await legacyCleanup.rejectStaleLegacyTransfers();
  assert.deepEqual(res, { rejected: 1, failed: 1 });
  assert.deepEqual(calls.statusUpdates.map((u) => u.id), ['R2']);
});

test('queue read failure → sweep skipped, never throws', async () => {
  approvalQueueRepository.getAllPending = async () => { throw new Error('quota'); };
  const res = await legacyCleanup.rejectStaleLegacyTransfers();
  assert.deepEqual(res, { rejected: 0, failed: 0 });
});
