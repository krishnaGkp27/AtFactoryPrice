'use strict';

/**
 * QTA-2 — a sale whose earlier run flipped some thans and died before the
 * books (R-9BF6, 25-Sep-2026: 27 of 33 thans sold to Ayubal Ansari, no
 * Transactions row, no ledger debit, no invoice, request still pending).
 *
 * One Approve must now finish it: the 6 remaining thans sell, the 27 are
 * COUNTED (never sold or charged again), the Transactions row / ledger /
 * invoice cover all 33, a than another APPROVED same-customer-same-day
 * request already covers is refused as a duplicate, and with the resolved
 * queue unreadable nothing at all is written.
 */

process.env.ADMIN_IDS = 'admin1';

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryService = require('../../../src/services/inventoryService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const ledgerRepository = require('../../../src/repositories/ledgerRepository');
const invoicesRepository = require('../../../src/repositories/invoicesRepository');
const accountingService = require('../../../src/services/accountingService');
const auditService = require('../../../src/services/auditService');
const invoiceService = require('../../../src/services/invoiceService');
const crmService = require('../../../src/services/crmService');
const stockEventsRepository = require('../../../src/repositories/stockEventsRepository');

auditService.log = async () => true;
stockEventsRepository.record = async () => 0;

const ID = '9bf6c2d4-1111-4222-8333-abcdefabcdef';
const CUSTOMER = 'Ayubal Ansari';
const DAY = '2026-09-25';
const WH = 'Kano office';

function invRow(pkg, thanNo, design, status, opts = {}) {
  return { packageNo: pkg, thanNo, design, shade: '1', yards: 30, warehouse: WH, status, pricePerYard: 100,
    soldTo: opts.soldTo || '', soldDate: opts.soldDate || '', rowIndex: opts.rowIndex || 0 };
}
const mine = (pkg, thanNo, design) => invRow(pkg, thanNo, design, 'sold', { soldTo: 'AYUBAL ANSARI', soldDate: '25/09/2026' });

/** The R-9BF6 world: 771/773/775/779 ×6 of 9037 flipped, 6189/6210/6199 than 5 of 9006 flipped, 772 ×6 still available. */
function world9bf6() {
  const rows = [];
  let i = 2;
  for (const pkg of ['771', '773', '775', '779']) for (let t = 1; t <= 6; t += 1) rows.push({ ...mine(pkg, t, '9037'), rowIndex: i++ });
  for (let t = 1; t <= 6; t += 1) rows.push({ ...invRow('772', t, '9037', 'available'), rowIndex: i++ });
  for (const pkg of ['6189', '6210', '6199']) {
    rows.push({ ...mine(pkg, 5, '9006'), rowIndex: i++ });
    rows.push({ ...invRow(pkg, 4, '9006', 'sold', { soldTo: 'Zakirullah', soldDate: '2026-07-08' }), rowIndex: i++ });
  }
  return rows;
}
const ITEMS = [
  { type: 'package', packageNo: '771', warehouse: WH }, { type: 'package', packageNo: '779', warehouse: WH },
  { type: 'package', packageNo: '775', warehouse: WH }, { type: 'package', packageNo: '773', warehouse: WH },
  { type: 'package', packageNo: '772', warehouse: WH },
  { type: 'than', packageNo: '6189', thanNo: 5, warehouse: WH }, { type: 'than', packageNo: '6210', thanNo: 5, warehouse: WH },
  { type: 'than', packageNo: '6199', thanNo: 5, warehouse: WH },
];
const AJ = () => ({ action: 'sale_bundle', customer: CUSTOMER, salesDate: DAY, warehouse: WH, items: ITEMS.map((i) => ({ ...i })) });
// The unrelated same-day sale the owner's screenshot showed: five 202/201 thans, no overlap.
const OTHER_SALE = { requestId: 'aaaa0000-0000-4000-8000-000000000000', user: 'emp2', status: 'approved', actionJSON: {
  action: 'sale_bundle', customer: CUSTOMER, salesDate: DAY, warehouse: 'IDUMOTA',
  items: ['1085', '1093', '1102', '1126', '1120'].map((p) => ({ type: 'than', packageNo: p, thanNo: 1, warehouse: 'IDUMOTA' })),
} };

function harness(rows, opts = {}) {
  const out = { txns: [], sales: [], audits: [], calls: [], invoices: 0, payments: 0, resolvedReads: 0 };
  let resolved = false;
  const item = { requestId: ID, user: 'emp1', status: 'pending', actionJSON: opts.aj || AJ() };
  approvalQueueRepository.getAllPending = async () => (resolved ? [] : [JSON.parse(JSON.stringify(item))]);
  approvalQueueRepository.updateStatus = async (id, status) => { if (status === 'approved' || status === 'rejected') resolved = true; return true; };
  approvalQueueRepository.updateActionJSON = async () => true;
  approvalQueueRepository.getResolved = async () => {
    out.resolvedReads += 1;
    if (opts.resolvedThrows) throw new Error('Google Sheets is rate-limiting reads right now — wait one minute, then tap again. (readRange(ApprovalQueue))');
    return JSON.parse(JSON.stringify(opts.resolved || [OTHER_SALE]));
  };
  auditLogRepository.append = async (type, payload) => { out.audits.push({ type, payload }); };
  inventoryRepository.getAll = async () => rows.map((r) => ({ ...r }));
  inventoryRepository.markItemsSold = async (items, customer, salesDate, o) => {
    out.calls.push({ items, customer, salesDate, o });
    const applied = []; const failed = []; const sold = [];
    const taken = new Set();
    const up = (v) => String(v || '').toUpperCase();
    for (const it of items) {
      const inWh = rows.filter((r) => r.packageNo === it.packageNo && (!it.warehouse || up(r.warehouse) === up(it.warehouse)));
      if (it.type === 'package') {
        const m = inWh.filter((r) => r.status === 'available' && !taken.has(r.rowIndex));
        if (!m.length) { failed.push({ item: it, reason: 'not found or no available thans', rows: inWh }); continue; }
        m.forEach((r) => taken.add(r.rowIndex));
        const flipped = m.map((r) => ({ ...r, status: 'sold', soldTo: customer, soldDate: salesDate }));
        applied.push({ item: it, rows: flipped }); sold.push(...flipped);
      } else if (it.type === 'than') {
        const r = inWh.find((x) => Number(x.thanNo) === Number(it.thanNo));
        if (!r || r.status !== 'available' || taken.has(r.rowIndex)) { failed.push({ item: it, reason: 'not found or not available', rows: r ? [r] : [] }); continue; }
        taken.add(r.rowIndex);
        const f = { ...r, status: 'sold', soldTo: customer, soldDate: salesDate };
        applied.push({ item: it, rows: [f] }); sold.push(f);
      } else failed.push({ item: it, reason: `unknown item type "${it.type}"`, rows: [] });
    }
    return { applied, failed, rows: sold };
  };
  transactionsRepository.append = async (row) => { out.txns.push(row); return true; };
  transactionsRepository.findBySaleRef = async (ref) => (opts.priorTxn && ref === ID ? [{ action: 'sale_bundle', saleRefId: ID, qty: 990 }] : []);
  ledgerRepository.findByTxnId = async (txnId) => ((opts.ledgerHas || []).includes(txnId) ? [{ txn_id: txnId }] : []);
  invoicesRepository.getByRequestId = async (id) => (opts.invoiceExists && id === ID ? { requestId: ID, invoiceNo: 'INV-2026-0042' } : null);
  invoiceService.createForSale = async () => { out.invoices += 1; return { invoiceNo: 'INV-2026-0099' }; };
  crmService.recordPayment = async () => { out.payments += 1; return true; };
  accountingService.recordSale = async (p) => { out.sales.push(p); return true; };
  return out;
}

const ENRICH = { ratePerUnitByDesign: { 9037: 1000, 9006: 1200 }, paymentMode: 'Not yet paid', amountPaid: 0 };

test('R-9BF6: one Approve sells the 6 remaining thans, counts the 27 already flipped, and books all 33 once', async () => {
  const out = harness(world9bf6());
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(out.resolvedReads, 1, 'the duplicate check read the resolved queue once');
  assert.equal(out.calls.length, 1, 'still ONE batched write');
  assert.equal(out.calls[0].items.length, 8, 'every item goes to the writer; the writer says which are gone');
  assert.deepEqual({
    r: res.bundleReport.requestedItems, p: res.bundleReport.appliedPkgCount, t: res.bundleReport.appliedThans,
    y: res.bundleReport.appliedYards, f: res.bundleReport.failedItems, ri: res.bundleReport.resumedItems, rt: res.bundleReport.resumedThans,
  }, { r: 8, p: 8, t: 33, y: 990, f: [], ri: 7, rt: 27 });
  // The books cover the WHOLE sale, once.
  assert.equal(out.txns.length, 1);
  assert.equal(out.txns[0].qty, 990);
  assert.equal(out.txns[0].before, '33 thans');
  assert.equal(out.txns[0].saleRefId, ID);
  assert.deepEqual(out.sales.map((s) => [s.design, s.yards, s.pricePerYard]).sort(), [['9006', 90, 1200], ['9037', 900, 1000]]);
  assert.equal(out.invoices, 1);
  const resumed = out.audits.find((a) => a.type === 'sale_bundle_resumed');
  assert.ok(resumed, 'the resume is on the audit trail');
  assert.deepEqual({ i: resumed.payload.resumedItems, t: resumed.payload.resumedThans, prior: resumed.payload.priorTransactionsRow }, { i: 7, t: 27, prior: false });
  assert.ok(!out.audits.some((a) => a.type === 'sale_bundle_partial'), 'nothing failed — no partial report');
});

test('a than another APPROVED same-customer-same-day request covers is a DUPLICATE: refused by name, the rest resumes', async () => {
  const dup = { requestId: 'dddd1111-2222-4333-8444-555555555555', user: 'emp2', status: 'approved', actionJSON: {
    action: 'sale_bundle', customer: 'ayubal ansari', salesDate: '25-09-2026', warehouse: WH, items: [{ type: 'package', packageNo: '771', warehouse: WH }],
  } };
  const out = harness(world9bf6(), { resolved: [OTHER_SALE, dup] });
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.bundleReport.failedItems, [{ packageNo: '771', type: 'package',
    reason: `already sold to ${CUSTOMER} on ${DAY} under request R-DDDD — a duplicate, not sold again` }]);
  assert.deepEqual({ t: res.bundleReport.appliedThans, y: res.bundleReport.appliedYards, ri: res.bundleReport.resumedItems, rt: res.bundleReport.resumedThans },
    { t: 27, y: 810, ri: 6, rt: 21 });
  assert.equal(out.txns[0].qty, 810, 'the duplicate is not charged');
  assert.deepEqual(out.sales.map((s) => [s.design, s.yards]).sort(), [['9006', 90], ['9037', 720]]);
  const partial = out.audits.find((a) => a.type === 'sale_bundle_partial');
  assert.match(partial.payload.failedItems[0].reason, /duplicate/);
});

test('an earlier run that got PAST the flip (Transactions row, one ledger debit, invoice already there) is never booked twice', async () => {
  const out = harness(world9bf6(), { priorTxn: true, ledgerHas: [`${ID}-9037`], invoiceExists: true });
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', { ...ENRICH, paymentMode: 'Cash', amountPaid: 50000 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(out.txns.length, 0, 'the earlier row stands — no second Transactions row');
  assert.equal(out.payments, 0, 'a payment already recorded with that row is not recorded again');
  assert.deepEqual(out.sales.map((s) => s.design), ['9006'], 'only the debit the earlier run never posted');
  assert.equal(out.invoices, 0, 'the issued invoice stands');
  const resumed = out.audits.find((a) => a.type === 'sale_bundle_resumed');
  assert.equal(resumed.payload.priorTransactionsRow, true);
});

test('resolved queue unreadable → NOTHING is written (no flip, no row, no debit) and the message says why', async () => {
  const out = harness(world9bf6(), { resolvedThrows: true });
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, false);
  assert.match(res.message, /7 item\(s\) were already sold to Ayubal Ansari on 2026-09-25 by an earlier run of this request/);
  assert.match(res.message, /could not be read to rule out a duplicate/);
  assert.match(res.message, /Nothing was changed — try again in a minute/);
  assert.equal(out.calls.length, 0, 'the batched write never ran');
  assert.equal(out.txns.length, 0);
  assert.equal(out.sales.length, 0);
  assert.equal(out.invoices, 0);
});

test('a normal sale (nothing of its own already flipped) never reads the resolved queue', async () => {
  const rows = world9bf6().map((r) => (r.soldTo === 'AYUBAL ANSARI' ? { ...r, status: 'available', soldTo: '', soldDate: '' } : r));
  const out = harness(rows);
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, true);
  assert.equal(out.resolvedReads, 0);
  assert.deepEqual({ t: res.bundleReport.appliedThans, ri: res.bundleReport.resumedItems }, { t: 33, ri: 0 });
  assert.ok(!out.audits.some((a) => a.type === 'sale_bundle_resumed'));
});

test('EVERY item flipped by the earlier run and no books → Approve writes the books (not the APF-1 refusal)', async () => {
  const rows = world9bf6().map((r) => (r.packageNo === '772' ? mine('772', r.thanNo, '9037') : r));
  const out = harness(rows);
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.allItemsFailed, undefined);
  assert.deepEqual({ t: res.bundleReport.appliedThans, y: res.bundleReport.appliedYards, ri: res.bundleReport.resumedItems }, { t: 33, y: 990, ri: 8 });
  assert.equal(out.txns.length, 1);
  assert.equal(out.txns[0].qty, 990);
  assert.equal(out.invoices, 1);
});

test('stock gone to SOMEONE ELSE is still a plain failure — resumed only when the buyer and the day are this request\'s', async () => {
  const rows = world9bf6().map((r) => (r.packageNo === '779' ? { ...r, soldTo: 'Musa' } : r));
  const out = harness(rows);
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, true);
  assert.deepEqual(res.bundleReport.failedItems, [{ packageNo: '779', type: 'package', reason: 'not found or no available thans' }]);
  assert.deepEqual({ t: res.bundleReport.appliedThans, ri: res.bundleReport.resumedItems }, { t: 27, ri: 6 });
  assert.equal(out.txns[0].qty, 810);
});

test('books already written by the earlier run → the re-entered enrichment does NOT overwrite the one the books carry', async () => {
  const persisted = [];
  const out = harness(world9bf6(), { priorTxn: true, ledgerHas: [`${ID}-9037`, `${ID}-9006`], invoiceExists: true });
  approvalQueueRepository.updateActionJSON = async (id, aj) => { persisted.push(aj); return true; };
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', { ...ENRICH, ratePerUnitByDesign: { 9037: 999, 9006: 999 } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(persisted.length, 0, 'the first run\'s rates stand on the row');
  assert.equal(out.txns.length + out.sales.length + out.invoices + out.payments, 0, 'nothing booked twice');
  // …whereas a run that never got to the books persists what it books with.
  const persisted2 = [];
  harness(world9bf6());
  approvalQueueRepository.updateActionJSON = async (id, aj) => { persisted2.push(aj); return true; };
  await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(persisted2.length, 1);
  assert.deepEqual(persisted2[0].enrichment.ratePerUnitByDesign, ENRICH.ratePerUnitByDesign);
});

test('a quota refusal on the final status write of a BUNDLE says Approve again resumes it; a single door still gets Mark as done', async () => {
  harness(world9bf6());
  const quota = () => Object.assign(new Error('Google Sheets is rate-limiting writes right now — wait one minute, then tap again. (batchUpdate(ApprovalQueue))'), { code: 'SHEETS_QUOTA' });
  approvalQueueRepository.updateStatus = async () => { throw quota(); };
  await assert.rejects(inventoryService.executeApprovedAction(ID, 'admin1', ENRICH), (e) => e.code === 'SHEETS_QUOTA_AFTER_APPLY'
    && /^Applied and booked — only the request could not be marked approved/.test(e.message)
    && /tap Approve again — the bot recognises the sale as already applied/.test(e.message)
    && !/Mark as done/.test(e.message));
  // A single-than door: its stock reads as gone next time, so Mark as done is the right chip.
  const single = { requestId: 'single-1', user: 'emp1', status: 'pending', actionJSON: { action: 'sell_than', packageNo: '772', thanNo: 1, design: '9037', yards: 30, customer: CUSTOMER, salesDate: DAY, warehouse: WH } };
  approvalQueueRepository.getAllPending = async () => [JSON.parse(JSON.stringify(single))];
  const stockEngine = require('../../../src/services/stockEngine');
  const origSellThan = stockEngine.sellThan;
  stockEngine.sellThan = async () => ({ packageNo: '772', thanNo: 1, yards: 30, design: '9037' });
  inventoryRepository.updatePrice = async () => true;
  try {
    await assert.rejects(inventoryService.executeApprovedAction('single-1', 'admin1', ENRICH), (e) => e.code === 'SHEETS_QUOTA_AFTER_APPLY'
      && /choose ✅ Mark as done \(no re-run\)/.test(e.message));
  } finally {
    stockEngine.sellThan = origSellThan;
  }
});
