'use strict';

/**
 * SLP-1 (owner, 10-Aug-2026: "Are you logging the salesperson also when the
 * sales are logged?").
 *
 * Transactions column M is SalesPerson and has been there since APU-1. Only
 * the sale_bundle executor filled it. Snap Sale queues `sell_package` with
 * the seller's name on the queue row, and the executor dropped it on the
 * floor — so a single-bale sale landed in the ledger with a blank seller and
 * sales could not be read per person. Same for approved `sell_than`.
 *
 * One line per executor. Pinned here so a future edit cannot lose it again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryService = require('../../../src/services/inventoryService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const accountingService = require('../../../src/services/accountingService');
const auditService = require('../../../src/services/auditService');
const invoiceService = require('../../../src/services/invoiceService');

invoiceService.createForSale = async () => null;
accountingService.recordSale = async () => true;
auditService.log = async () => true;

function harness(item) {
  const rows = [];
  let resolved = false;
  approvalQueueRepository.getAllPending = async () => (resolved ? [] : [JSON.parse(JSON.stringify(item))]);
  approvalQueueRepository.updateStatus = async (id, status) => {
    if (status === 'approved' || status === 'rejected') resolved = true;
    return true;
  };
  auditLogRepository.append = async () => {};
  transactionsRepository.append = async (row) => { rows.push(row); return true; };
  inventoryRepository.markPackageSold = async (packageNo) => ([
    { packageNo, thanNo: 1, yards: 30, design: 'D', shade: '1', warehouse: 'IDUMOTA' },
  ]);
  inventoryRepository.markThanSold = async (packageNo, thanNo) => (
    { packageNo, thanNo, yards: 30, design: 'D', shade: '1', warehouse: 'IDUMOTA' });
  inventoryRepository.findByPackage = async (packageNo) => ([{ packageNo, status: 'sold', soldTo: '', yards: 30 }]);
  inventoryRepository.findThan = async (packageNo, thanNo) => ({ packageNo, thanNo, status: 'sold', soldTo: '' });
  inventoryRepository.updatePrice = async () => 1;
  return rows;
}

test('an approved sell_package writes the salesperson the flow captured', async () => {
  const rows = harness({
    requestId: 'SP1', user: 'emp1', status: 'pending',
    actionJSON: {
      action: 'sell_package', packageNo: '896', customer: 'OKSON', yards: 30, thans: 1,
      design: 'D', shade: '1', warehouse: 'IDUMOTA', salesPerson: 'Yarima',
      salesDate: '2026-08-09', source: 'snap_sale',
    },
  });
  const res = await inventoryService.executeApprovedAction('SP1', 'admin1');
  assert.equal(res.ok, true);
  const sale = rows.find((r) => r.action === 'sell_package');
  assert.ok(sale, 'a sale row was written');
  assert.equal(sale.salesPerson, 'Yarima', 'the seller reaches Transactions column M');
  assert.equal(sale.customerName, 'OKSON');
});

test('an approved sell_than writes it too, and a missing name stays blank', async () => {
  const withName = harness({
    requestId: 'ST1', user: 'emp1', status: 'pending',
    actionJSON: {
      action: 'sell_than', packageNo: '896', thanNo: 2, customer: 'OKSON', yards: 30,
      design: 'D', shade: '1', warehouse: 'IDUMOTA', salesPerson: 'Abdul',
    },
  });
  assert.equal((await inventoryService.executeApprovedAction('ST1', 'admin1')).ok, true);
  assert.equal(withName.find((r) => r.action === 'sell_than').salesPerson, 'Abdul');

  // A legacy queue row with no salesPerson must not become "undefined".
  const legacy = harness({
    requestId: 'ST2', user: 'emp1', status: 'pending',
    actionJSON: {
      action: 'sell_than', packageNo: '897', thanNo: 1, customer: 'OKSON', yards: 30,
      design: 'D', shade: '1', warehouse: 'IDUMOTA',
    },
  });
  assert.equal((await inventoryService.executeApprovedAction('ST2', 'admin1')).ok, true);
  assert.equal(legacy.find((r) => r.action === 'sell_than').salesPerson, '');
});
