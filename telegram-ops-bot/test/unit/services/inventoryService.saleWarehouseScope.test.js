'use strict';

/**
 * TRF-INT4 — the approved-sale/return executors pass the request's warehouse
 * down to the repository mutators, so a printed number that exists in more
 * than one warehouse can only ever flip the physical bale the flow picked.
 * Pre-TRF-INT4 pending rows carry no warehouse and keep the legacy unscoped
 * call (status-guarded), which is pinned here too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryService = require('../../../src/services/inventoryService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const accountingService = require('../../../src/services/accountingService');
const stockLedgerService = require('../../../src/services/stockLedgerService');
const auditService = require('../../../src/services/auditService');
const invoiceService = require('../../../src/services/invoiceService');

// Keep every ledger/invoice hook inert — this suite pins only the warehouse
// argument on the inventory mutators.
invoiceService.createForSale = async () => null;
accountingService.recordSale = async () => true;
accountingService.recordReturn = async () => true;
stockLedgerService.recordSaleOut = async () => true;
auditService.log = async () => true;

function harness(item) {
  const calls = { markPackageSold: [], markThanSold: [], markPackageAvailable: [], markThanAvailable: [], findByPackage: [], findThan: [] };
  let resolved = false;
  approvalQueueRepository.getAllPending = async () => (resolved ? [] : [JSON.parse(JSON.stringify(item))]);
  approvalQueueRepository.updateStatus = async (id, status) => {
    if (status === 'approved' || status === 'rejected') resolved = true;
    return true;
  };
  auditLogRepository.append = async () => {};
  transactionsRepository.append = async () => true;
  inventoryRepository.markPackageSold = async (packageNo, customer, salesDate, opts) => {
    calls.markPackageSold.push({ packageNo, opts: opts || {} });
    return [{ packageNo, thanNo: 1, yards: 30, design: 'D', shade: '1', warehouse: (opts && opts.warehouse) || '' }];
  };
  inventoryRepository.markThanSold = async (packageNo, thanNo, customer, salesDate, opts) => {
    calls.markThanSold.push({ packageNo, thanNo, opts: opts || {} });
    return { packageNo, thanNo, yards: 30, design: 'D', shade: '1' };
  };
  inventoryRepository.markPackageAvailable = async (packageNo, opts) => {
    calls.markPackageAvailable.push({ packageNo, opts: opts || {} });
    return [{ packageNo, thanNo: 1, yards: 30, design: 'D', shade: '1' }];
  };
  inventoryRepository.markThanAvailable = async (packageNo, thanNo, opts) => {
    calls.markThanAvailable.push({ packageNo, thanNo, opts: opts || {} });
    return { packageNo, thanNo, yards: 30, design: 'D', shade: '1' };
  };
  inventoryRepository.findByPackage = async (packageNo, opts) => {
    calls.findByPackage.push({ packageNo, opts: opts || {} });
    return [{ packageNo, status: 'sold', soldTo: '', yards: 30 }];
  };
  inventoryRepository.findThan = async (packageNo, thanNo, opts) => {
    calls.findThan.push({ packageNo, thanNo, opts: opts || {} });
    return { packageNo, thanNo, status: 'sold', soldTo: '' };
  };
  calls.updatePrice = [];
  inventoryRepository.updatePrice = async (filters) => { calls.updatePrice.push(filters || {}); return 1; };
  return calls;
}

test('sell_package passes aj.warehouse to markPackageSold', async () => {
  const calls = harness({
    requestId: 'W1', user: 'emp1', status: 'pending',
    actionJSON: { action: 'sell_package', packageNo: '997', customer: 'ACME', yards: 30, thans: 1, design: 'D', shade: '1', warehouse: 'IDUMOTA' },
  });
  const res = await inventoryService.executeApprovedAction('W1', 'admin1');
  assert.equal(res.ok, true);
  assert.equal(calls.markPackageSold.length, 1);
  assert.equal(calls.markPackageSold[0].opts.warehouse, 'IDUMOTA');
});

test('pre-TRF-INT4 sell_package (no warehouse on the aj) stays legacy-unscoped', async () => {
  const calls = harness({
    requestId: 'W2', user: 'emp1', status: 'pending',
    actionJSON: { action: 'sell_package', packageNo: '997', customer: 'ACME', yards: 30, thans: 1, design: 'D', shade: '1' },
  });
  const res = await inventoryService.executeApprovedAction('W2', 'admin1');
  assert.equal(res.ok, true);
  assert.equal(calls.markPackageSold[0].opts.warehouse, undefined);
});

test('sale_bundle scopes each item by its own warehouse, falling back to the bundle one', async () => {
  const calls = harness({
    requestId: 'W3', user: 'emp1', status: 'pending',
    actionJSON: {
      action: 'sale_bundle', customer: 'ACME', salesDate: '2026-08-02', warehouse: 'KANO OFFICE',
      items: [
        { type: 'package', packageNo: 'A1', warehouse: 'IDUMOTA' },
        { type: 'package', packageNo: 'B2' },
        { type: 'than', packageNo: 'C3', thanNo: 2, warehouse: 'LAGOS' },
      ],
    },
  });
  const res = await inventoryService.executeApprovedAction('W3', 'admin1');
  assert.equal(res.ok, true);
  assert.deepEqual(calls.markPackageSold.map((c) => c.opts.warehouse), ['IDUMOTA', 'KANO OFFICE']);
  assert.equal(calls.markThanSold[0].opts.warehouse, 'LAGOS');
});

test('return_package passes aj.warehouse to markPackageAvailable (and the buyer lookup)', async () => {
  const calls = harness({
    requestId: 'W4', user: 'emp1', status: 'pending',
    actionJSON: { action: 'return_package', packageNo: '997', warehouse: 'IDUMOTA' },
  });
  const res = await inventoryService.executeApprovedAction('W4', 'admin1');
  assert.equal(res.ok, true);
  assert.equal(calls.markPackageAvailable[0].opts.warehouse, 'IDUMOTA');
  assert.equal(calls.findByPackage[0].opts.warehouse, 'IDUMOTA', 'CUS-2 buyer capture reads the same physical bale');
});

test('return_than passes aj.warehouse to markThanAvailable', async () => {
  const calls = harness({
    requestId: 'W5', user: 'emp1', status: 'pending',
    actionJSON: { action: 'return_than', packageNo: '997', thanNo: 1, warehouse: 'KANO OFFICE' },
  });
  const res = await inventoryService.executeApprovedAction('W5', 'admin1');
  assert.equal(res.ok, true);
  assert.equal(calls.markThanAvailable[0].opts.warehouse, 'KANO OFFICE');
});

test('sell_than passes aj.warehouse to markThanSold, and the rate stamp is warehouse-scoped', async () => {
  const calls = harness({
    requestId: 'W6', user: 'emp1', status: 'pending',
    actionJSON: { action: 'sell_than', packageNo: '997', thanNo: 2, customer: 'ACME', yards: 30, design: 'D', shade: '1', warehouse: 'IDUMOTA' },
  });
  const res = await inventoryService.executeApprovedAction('W6', 'admin1', { ratePerUnitByDesign: { D: 1500 } });
  assert.equal(res.ok, true);
  assert.equal(calls.markThanSold[0].opts.warehouse, 'IDUMOTA');
  assert.equal(calls.updatePrice.length, 1, 'enriched rate stamped');
  assert.equal(calls.updatePrice[0].warehouse, 'IDUMOTA', 'price stamp cannot leak to a same-numbered bale elsewhere');
  assert.equal(calls.updatePrice[0].packageNo, '997');
});

test('revertSaleBundle undoes each item in ITS warehouse (per-item, bundle fallback)', async () => {
  const calls = harness({ requestId: 'unused', user: 'emp1', status: 'pending', actionJSON: { action: 'noop' } });
  approvalQueueRepository.getByRequestId = async () => ({
    requestId: 'SALE-1', status: 'approved',
    actionJSON: {
      action: 'sale_bundle', customer: 'ACME', warehouse: 'KANO OFFICE',
      items: [
        { type: 'package', packageNo: 'A1', warehouse: 'IDUMOTA' },
        { type: 'than', packageNo: 'C3', thanNo: 2 },
      ],
    },
  });
  const res = await inventoryService.revertSaleBundle('SALE-1', 'admin1');
  assert.equal(res.ok, true);
  assert.equal(calls.findByPackage[0].opts.warehouse, 'IDUMOTA', 'package item looked up in its own warehouse');
  assert.equal(calls.markPackageAvailable[0].opts.warehouse, 'IDUMOTA');
  assert.equal(calls.findThan[0].opts.warehouse, 'KANO OFFICE', 'than item falls back to the bundle warehouse');
  assert.equal(calls.markThanAvailable[0].opts.warehouse, 'KANO OFFICE');
});

test('sellPackage stamps the resolved warehouse on the queued aj and scopes the totals', async () => {
  const calls = harness({ requestId: 'unused', user: 'emp1', status: 'pending', actionJSON: { action: 'noop' } });
  const riskEvaluate = require('../../../src/risk/evaluate');
  const origEval = riskEvaluate.evaluate;
  riskEvaluate.evaluate = async () => ({ risk: 'approval_required', reason: 'test' });
  const queued = [];
  approvalQueueRepository.append = async (row) => { queued.push(row); };
  // Blank-warehouse legacy row + one named warehouse: the named one wins,
  // and the blank row's yardage must NOT inflate the queued totals (the
  // scoped executor would never flip it).
  inventoryRepository.findByPackage = async (packageNo, opts) => {
    calls.findByPackage.push({ packageNo, opts: opts || {} });
    return [
      { packageNo, thanNo: 1, status: 'available', warehouse: '', yards: 30, design: 'D', shade: '1', pricePerYard: 0 },
      { packageNo, thanNo: 1, status: 'available', warehouse: 'Benduku', yards: 50, design: 'D', shade: '1', pricePerYard: 0 },
    ];
  };
  try {
    const res = await inventoryService.sellPackage('507', 'ACME', 'emp1', null);
    assert.equal(res.status, 'approval_required');
    assert.equal(queued.length, 1);
    const aj = queued[0].actionJSON;
    assert.equal(aj.warehouse, 'Benduku', 'single named warehouse inferred and stamped');
    assert.equal(aj.yards, 50, 'blank-warehouse row excluded from the promised total');
    assert.equal(aj.thans, 1);
  } finally {
    riskEvaluate.evaluate = origEval;
  }
});
