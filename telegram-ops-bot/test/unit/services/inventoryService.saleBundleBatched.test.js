'use strict';

/**
 * QTA-1 — the approved bundle sale sells every item through ONE batched
 * call (stockEngine.sellItems → inventoryRepository.markItemsSold), and the
 * executor's own arithmetic — totals, per-design yards for the ledger, the
 * partial report, the all-failed refusal (APF-1) — is unchanged.
 */

process.env.ADMIN_IDS = 'admin1';

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
const stockEventsRepository = require('../../../src/repositories/stockEventsRepository');

invoiceService.createForSale = async () => null;
auditService.log = async () => true;
stockEventsRepository.record = async () => 0;

function harness(item, world) {
  const out = { txns: [], sales: [], audits: [], calls: [] };
  let resolved = false;
  approvalQueueRepository.getAllPending = async () => (resolved ? [] : [JSON.parse(JSON.stringify(item))]);
  approvalQueueRepository.updateStatus = async (id, status) => { if (status === 'approved' || status === 'rejected') resolved = true; return true; };
  approvalQueueRepository.updateActionJSON = async () => true;
  auditLogRepository.append = async (type, payload) => { out.audits.push({ type, payload }); };
  // QTA-2 — the executor reads Inventory once before the batched write to
  // see whether any item is its own earlier, half-done run.
  inventoryRepository.getAll = async () => Object.values(world).flat().map((r) => ({ ...r }));
  approvalQueueRepository.getResolved = async () => [];
  transactionsRepository.append = async (row) => { out.txns.push(row); return true; };
  accountingService.recordSale = async (p) => { out.sales.push(p); return true; };
  inventoryRepository.markItemsSold = async (items, customer, salesDate, opts) => {
    out.calls.push({ items, customer, salesDate, opts });
    const applied = []; const failed = []; const rows = [];
    for (const it of items) {
      const mine = (world[it.packageNo] || []).filter((r) => r.status === 'available' && (it.type === 'package' || r.thanNo === it.thanNo));
      if (!mine.length) { failed.push({ item: it, reason: it.type === 'package' ? 'not found or no available thans' : 'not found or not available' }); continue; }
      const sold = mine.map((r) => ({ ...r, status: 'sold', soldTo: customer, pricePerYard: opts.rateFor ? (opts.rateFor(r) || r.pricePerYard) : r.pricePerYard }));
      applied.push({ item: it, rows: sold }); rows.push(...sold);
    }
    return { applied, failed, rows };
  };
  return out;
}

const WORLD = {
  A1: [{ packageNo: 'A1', thanNo: 1, yards: 30, design: '202/201', warehouse: 'IDUMOTA', pricePerYard: 100 }, { packageNo: 'A1', thanNo: 2, yards: 30, design: '202/201', warehouse: 'IDUMOTA', pricePerYard: 100 }],
  B2: [{ packageNo: 'B2', thanNo: 1, yards: 25, design: '77019', warehouse: 'IDUMOTA', pricePerYard: 100 }],
  C3: [{ packageNo: 'C3', thanNo: 1, yards: 40, design: '77019', warehouse: 'KANO OFFICE', pricePerYard: 100, status: 'sold' }],
};
for (const rows of Object.values(WORLD)) rows.forEach((r) => { r.status = r.status || 'available'; });

test('one batched call carries every item with its warehouse; totals, per-design ledger yards and the partial report follow', async () => {
  const out = harness({
    requestId: 'Q1', user: 'emp1', status: 'pending',
    actionJSON: {
      action: 'sale_bundle', customer: 'ABBA', salesDate: '2026-08-19', warehouse: 'IDUMOTA',
      items: [
        { type: 'package', packageNo: 'A1' },
        { type: 'than', packageNo: 'B2', thanNo: 1, warehouse: 'IDUMOTA' },
        { type: 'than', packageNo: 'C3', thanNo: 1, warehouse: 'KANO OFFICE' },
      ],
    },
  }, WORLD);
  const enrichment = { ratePerUnitByDesign: { '202/201': 1450, '77019': 1200 }, paymentMode: 'Cash', amountPaid: 0 };
  const res = await inventoryService.executeApprovedAction('Q1', 'admin1', enrichment);
  assert.equal(res.ok, true);
  assert.equal(out.calls.length, 1, 'ONE call for the whole bundle');
  assert.deepEqual(out.calls[0].items.map((i) => [i.type, i.packageNo, i.warehouse]),
    [['package', 'A1', 'IDUMOTA'], ['than', 'B2', 'IDUMOTA'], ['than', 'C3', 'KANO OFFICE']]);
  assert.equal(out.calls[0].customer, 'ABBA');
  assert.equal(out.calls[0].salesDate, '2026-08-19');
  // The rate callback resolves the negotiated rate by design; no design → no stamp.
  assert.equal(out.calls[0].opts.rateFor({ design: '202/201' }), 1450);
  assert.equal(out.calls[0].opts.rateFor({ design: '77019' }), 1200);
  assert.equal(out.calls[0].opts.rateFor({ design: '' }), 0);
  // Totals from what was applied (A1 ×2 + B2 ×1; C3 was already sold).
  const sale = out.txns.find((t) => t.action === 'sale_bundle');
  assert.equal(sale.qty, 85);
  assert.equal(sale.before, '3 thans');
  assert.equal(sale.saleRefId, 'Q1');
  // Ledger: one debit per design at its own rate.
  assert.deepEqual(out.sales.map((s) => [s.design, s.yards, s.pricePerYard]).sort(), [['202/201', 60, 1450], ['77019', 25, 1200]]);
  // The partial report names the item that could not be applied, in the old shape.
  const partial = out.audits.find((a) => a.type === 'sale_bundle_partial');
  assert.deepEqual(partial.payload.failedItems, [{ packageNo: 'C3', thanNo: 1, type: 'than', reason: 'not found or not available' }]);
  assert.deepEqual(res.bundleReport && { r: res.bundleReport.requestedItems, p: res.bundleReport.appliedPkgCount, t: res.bundleReport.appliedThans, y: res.bundleReport.appliedYards },
    { r: 3, p: 2, t: 3, y: 85 });
});

test('no rate enrichment → no rate callback; every item already sold → APF-1 refusal, nothing posted', async () => {
  const out = harness({
    requestId: 'Q2', user: 'emp1', status: 'pending',
    actionJSON: { action: 'sale_bundle', customer: 'ABBA', salesDate: '2026-08-19', items: [{ type: 'package', packageNo: 'A1' }] },
  }, WORLD);
  await inventoryService.executeApprovedAction('Q2', 'admin1');
  assert.equal(out.calls[0].opts.rateFor, undefined);
  assert.equal(out.calls[0].items[0].warehouse, undefined, 'legacy bundle: unscoped match');

  const out2 = harness({
    requestId: 'Q3', user: 'emp1', status: 'pending',
    actionJSON: { action: 'sale_bundle', customer: 'ABBA', salesDate: '2026-08-19', items: [{ type: 'than', packageNo: 'C3', thanNo: 1 }, { type: 'bale', packageNo: 'Z9' }] },
  }, WORLD);
  const res = await inventoryService.executeApprovedAction('Q3', 'admin1');
  assert.equal(res.ok, false);
  assert.equal(res.allItemsFailed, true);
  assert.equal(out2.txns.length, 0);
  assert.equal(out2.sales.length, 0);
});

test('a refused Transactions append after the flip is collected as a BOOKS NOT UPDATED failure, never a throw that invites a re-run', async () => {
  const out = harness({
    requestId: 'Q4', user: 'emp1', status: 'pending',
    actionJSON: { action: 'sale_bundle', customer: 'ABBA', salesDate: '2026-08-19', items: [{ type: 'package', packageNo: 'B2' }] },
  }, WORLD);
  const quota = Object.assign(new Error('Google Sheets is rate-limiting writes right now — wait one minute, then tap again. (appendRows(Transactions))'), { code: 'SHEETS_QUOTA' });
  transactionsRepository.append = async () => { throw quota; };
  const res = await inventoryService.executeApprovedAction('Q4', 'admin1');
  assert.equal(res.ok, true, 'the executor completes: the goods are sold, the row resolves');
  assert.deepEqual(res.erpFailures.map((f) => f.stage), ['Transactions row (bundle)']);
  assert.match(res.erpFailures[0].error, /rate-limiting writes/);
  assert.equal(out.sales.length, 1, 'the ledger debit still posts');
});

test('a quota refusal on the final status write says the sale IS applied and what to tap, not "tap again"', async () => {
  harness({
    requestId: 'Q5', user: 'emp1', status: 'pending',
    actionJSON: { action: 'sale_bundle', customer: 'ABBA', salesDate: '2026-08-19', items: [{ type: 'package', packageNo: 'B2' }] },
  }, WORLD);
  approvalQueueRepository.updateStatus = async () => { throw Object.assign(new Error('Google Sheets is rate-limiting writes right now — wait one minute, then tap again. (batchUpdate(ApprovalQueue))'), { code: 'SHEETS_QUOTA' }); };
  // QTA-2 — a bundle's next Approve resumes it (nothing sold or charged
  // twice), so the advice is "tap Approve again", not Mark as done.
  await assert.rejects(inventoryService.executeApprovedAction('Q5', 'admin1'), (e) => e.code === 'SHEETS_QUOTA_AFTER_APPLY'
    && /^Applied and booked — only the request could not be marked approved/.test(e.message)
    && /tap Approve again — the bot recognises the sale as already applied/.test(e.message));
});
