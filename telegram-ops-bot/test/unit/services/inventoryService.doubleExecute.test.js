'use strict';

/**
 * SEC-P2 (C4): executeApprovedAction must not double-apply when two admins tap
 * Approve on the same request at the same instant. The in-process per-request
 * lock + the "still pending?" re-check inside it means the first caller
 * applies the side effect and marks the row approved; the second re-reads,
 * finds it resolved, and no-ops.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryService = require('../../../src/services/inventoryService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('C4: concurrent approvals of one request apply the side effect exactly once', async () => {
  const item = {
    requestId: 'R1', user: 'u1',
    actionJSON: { action: 'update_price', filters: { design: 'Rose' }, price: 100 },
    status: 'pending',
  };
  let resolved = false;
  let priceWrites = 0;

  approvalQueueRepository.getAllPending = async () => {
    // Simulate a slow sheet read so both callers would overlap WITHOUT a lock.
    await sleep(5);
    return resolved ? [] : [JSON.parse(JSON.stringify(item))];
  };
  approvalQueueRepository.updateStatus = async (id, status) => {
    if (status === 'approved' || status === 'rejected') resolved = true;
    return true;
  };
  inventoryRepository.updatePrice = async () => { priceWrites += 1; return 1; };
  transactionsRepository.append = async () => {};
  auditLogRepository.append = async () => {};

  const [a, b] = await Promise.all([
    inventoryService.executeApprovedAction('R1', 'admin1'),
    inventoryService.executeApprovedAction('R1', 'admin2'),
  ]);

  const okCount = [a, b].filter((r) => r.ok).length;
  assert.equal(okCount, 1, 'exactly one execution should succeed');
  assert.equal(priceWrites, 1, 'the price write must happen exactly once');
  const loser = [a, b].find((r) => !r.ok);
  assert.match(loser.message, /already resolved|not found/i);
});
