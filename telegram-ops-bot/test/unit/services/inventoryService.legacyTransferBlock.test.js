'use strict';

/**
 * TRF-5 — executeApprovedAction must REFUSE the retired instant-transfer
 * actions (transfer_than / transfer_package / transfer_batch), even for
 * stale pending ApprovalQueue rows created before the retirement. The only
 * transfer path is the staged Transfer Stock flow (transferService).
 * Repos are stubbed; no sheets are touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryService = require('../../../src/services/inventoryService');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');

function stub(actionJSON) {
  const captured = { moved: false, txAppended: false };
  approvalQueueRepository.getAllPending = async () => [
    { requestId: 'R1', user: 'emp1', actionJSON },
  ];
  approvalQueueRepository.updateStatus = async () => {};
  inventoryRepository.transferThan = async () => { captured.moved = true; return { yards: 50 }; };
  inventoryRepository.transferPackage = async () => { captured.moved = true; return [{ yards: 50 }]; };
  transactionsRepository.append = async () => { captured.txAppended = true; };
  return captured;
}

const CASES = [
  { action: 'transfer_than', packageNo: '5801', thanNo: 3, toWarehouse: 'Kano' },
  { action: 'transfer_package', packageNo: '5801', toWarehouse: 'Kano' },
  { action: 'transfer_batch', packageNos: ['5801', '5802'], toWarehouse: 'Kano' },
];

for (const aj of CASES) {
  test(`approving a stale ${aj.action} row is refused — no stock moves`, async () => {
    const captured = stub(aj);
    const res = await inventoryService.executeApprovedAction('R1', 'admin2', {});
    assert.equal(res.ok, false);
    assert.match(res.message, /Transfer Stock/i, 'points to the staged flow');
    assert.equal(captured.moved, false, 'no inventory rows touched');
    assert.equal(captured.txAppended, false, 'no transaction logged');
  });
}
