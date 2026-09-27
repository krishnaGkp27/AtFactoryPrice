'use strict';

/**
 * QTA-2 (owner: "revert and restart for complete sale") — a bundle sale
 * whose earlier run flipped some thans and died before the books (R-9BF6,
 * 25-Sep-2026: 27 of 33 thans sold to Ayubal Ansari, no Transactions row,
 * no ledger debit, no invoice, request still pending).
 *
 * One Approve must now: put the 27 back (one write, a correction), sell all
 * 33 afresh in one write, book once; refuse a than another APPROVED
 * same-customer-same-day sale covers; block on a PENDING one; when the
 * books already carry the request, touch nothing and only mark it
 * approved; and write NOTHING when a needed record cannot be read.
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
const mine = (pkg, thanNo, design) => invRow(pkg, thanNo, design, 'sold', { soldTo: 'AYUBAL ANSARI', soldDate: '2026-09-25' });

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
  const out = { txns: [], sales: [], audits: [], sells: [], restores: [], invoices: 0, payments: [], resolvedReads: 0, bookReads: 0, persisted: [] };
  let resolved = false;
  const item = { requestId: ID, user: 'emp1', status: 'pending', actionJSON: opts.aj || AJ() };
  const up = (v) => String(v || '').toUpperCase();
  approvalQueueRepository.getAllPending = async () => (resolved ? [] : [JSON.parse(JSON.stringify(item)), ...JSON.parse(JSON.stringify(opts.otherPending || []))]);
  approvalQueueRepository.updateStatus = async (id, status) => { if (status === 'approved' || status === 'rejected') resolved = true; return true; };
  approvalQueueRepository.updateActionJSON = async (id, aj) => { out.persisted.push(aj); return true; };
  approvalQueueRepository.getResolved = async () => {
    out.resolvedReads += 1;
    if (opts.resolvedThrows) throw new Error('Google Sheets is rate-limiting reads right now — wait one minute, then tap again. (readRange(ApprovalQueue))');
    return JSON.parse(JSON.stringify(opts.resolved || [OTHER_SALE]));
  };
  auditLogRepository.append = async (type, payload) => { out.audits.push({ type, payload }); };
  inventoryRepository.getAll = async () => rows.map((r) => ({ ...r }));
  inventoryRepository.markRowsAvailable = async (want, o) => {
    out.restores.push({ want, o });
    if (opts.restoreThrows) throw Object.assign(new Error('Google Sheets is rate-limiting writes right now — wait one minute, then tap again. (batchUpdate(Inventory))'), { code: 'SHEETS_QUOTA' });
    const restored = [];
    for (const w of want) {
      const live = rows.find((r) => r.rowIndex === w.rowIndex);
      if (!live || live.status !== 'sold') continue;
      const prior = live.soldTo;
      Object.assign(live, { status: 'available', soldTo: '', soldDate: '' });
      restored.push({ ...live, soldToPrior: prior });
    }
    return { restored, skipped: [] };
  };
  inventoryRepository.markItemsSold = async (items, customer, salesDate, o) => {
    out.sells.push({ items, customer, salesDate, o });
    if (opts.sellThrows) throw Object.assign(new Error('Google Sheets is rate-limiting writes right now — wait one minute, then tap again. (batchUpdate(Inventory))'), { code: 'SHEETS_QUOTA' });
    const applied = []; const failed = []; const sold = [];
    const taken = new Set();
    for (const it of items) {
      const inWh = rows.filter((r) => r.packageNo === it.packageNo && (!it.warehouse || up(r.warehouse) === up(it.warehouse)));
      if (it.type === 'package') {
        const m = inWh.filter((r) => r.status === 'available' && !taken.has(r.rowIndex));
        if (!m.length) { failed.push({ item: it, reason: 'not found or no available thans', rows: inWh }); continue; }
        m.forEach((r) => { taken.add(r.rowIndex); Object.assign(r, { status: 'sold', soldTo: customer, soldDate: salesDate }); });
        applied.push({ item: it, rows: m.map((r) => ({ ...r })) }); sold.push(...m);
      } else if (it.type === 'than') {
        const r = inWh.find((x) => Number(x.thanNo) === Number(it.thanNo));
        if (!r || r.status !== 'available' || taken.has(r.rowIndex)) { failed.push({ item: it, reason: 'not found or not available', rows: r ? [r] : [] }); continue; }
        taken.add(r.rowIndex); Object.assign(r, { status: 'sold', soldTo: customer, soldDate: salesDate });
        applied.push({ item: it, rows: [{ ...r }] }); sold.push(r);
      } else failed.push({ item: it, reason: `unknown item type "${it.type}"`, rows: [] });
    }
    return { applied, failed, rows: sold };
  };
  transactionsRepository.append = async (row) => { out.txns.push(row); return true; };
  transactionsRepository.findBySaleRef = async (ref) => {
    out.bookReads += 1;
    if (opts.booksThrow) throw new Error('Google Sheets is rate-limiting reads right now — wait one minute, then tap again. (readRange(Transactions))');
    return (opts.priorTxn && ref === ID ? [{ action: 'sale_bundle', saleRefId: ID, qty: 990 }] : []);
  };
  ledgerRepository.getAll = async () => (opts.ledgerHas || []).map((txn_id) => ({ txn_id }));
  invoicesRepository.getByRequestId = async (id) => (opts.invoiceExists && id === ID ? { requestId: ID, invoiceNo: 'INV-2026-0042' } : null);
  invoiceService.createForSale = async () => { out.invoices += 1; return { invoiceNo: 'INV-2026-0099' }; };
  crmService.recordPayment = async (p) => { out.payments.push(p); return true; };
  accountingService.recordSale = async (p) => { out.sales.push(p); return true; };
  return out;
}

const ENRICH = { ratePerUnitByDesign: { 9037: 1000, 9006: 1200 }, paymentMode: 'Not yet paid', amountPaid: 0 };
const isSold = (rows, pkg) => rows.filter((r) => r.packageNo === pkg).every((r) => r.status === 'sold' && r.soldTo === CUSTOMER);

test('R-9BF6: one Approve puts the 27 back, sells all 33 afresh in one write, and books once', async () => {
  const rows = world9bf6();
  const out = harness(rows);
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(out.resolvedReads, 1);
  assert.equal(out.bookReads, 1);
  // The put-back: the 27 own rows, one call, as a correction under the request's authority.
  assert.equal(out.restores.length, 1);
  assert.equal(out.restores[0].want.length, 27);
  assert.deepEqual({ kind: out.restores[0].o.kind, ref: out.restores[0].o.ref, user: out.restores[0].o.user }, { kind: 'correction', ref: CUSTOMER, user: 'admin1' }, 'the approving admin is the actor');
  // Then ONE sale write for every item, all available now.
  assert.equal(out.sells.length, 1);
  assert.equal(out.sells[0].items.length, 8);
  assert.deepEqual({
    r: res.bundleReport.requestedItems, p: res.bundleReport.appliedPkgCount, t: res.bundleReport.appliedThans, y: res.bundleReport.appliedYards,
    f: res.bundleReport.failedItems, rt: res.bundleReport.restartedThans, ri: res.bundleReport.restartedItems, d: res.bundleReport.duplicateRows,
  }, { r: 8, p: 8, t: 33, y: 990, f: [], rt: 27, ri: 7, d: 0 });
  assert.ok(['771', '773', '775', '779', '772'].every((p) => isSold(rows, p)), 'every bale sold to the customer at the end');
  // The books: once, for the whole sale.
  assert.equal(out.txns.length, 1);
  assert.deepEqual({ qty: out.txns[0].qty, before: out.txns[0].before, ref: out.txns[0].saleRefId }, { qty: 990, before: '33 thans', ref: ID });
  assert.deepEqual(out.sales.map((s) => [s.design, s.yards, s.pricePerYard]).sort(), [['9006', 90, 1200], ['9037', 900, 1000]]);
  assert.equal(out.invoices, 1);
  assert.equal(out.persisted.length, 1, 'the enrichment this pass booked with is persisted');
  const restarted = out.audits.find((a) => a.type === 'sale_bundle_restarted');
  assert.deepEqual({ t: restarted.payload.restoredThans, items: restarted.payload.items.length, dup: restarted.payload.duplicates.length }, { t: 27, items: 7, dup: 0 });
  assert.ok(!out.audits.some((a) => a.type === 'sale_bundle_partial'));
});

test('a than another APPROVED same-customer-same-day sale covers stays sold and is refused by name; the rest restarts', async () => {
  const dup = { requestId: 'dddd1111-2222-4333-8444-555555555555', user: 'emp2', status: 'approved', actionJSON: {
    action: 'sale_bundle', customer: 'ayubal ansari', salesDate: '25.09.2026', warehouse: WH, items: [{ type: 'package', packageNo: '771', warehouse: WH }],
  } };
  const rows = world9bf6();
  const out = harness(rows, { resolved: [OTHER_SALE, dup] });
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(out.restores[0].want.length, 21, '771\'s six rows are that sale\'s — not put back');
  assert.deepEqual(res.bundleReport.failedItems, [{ packageNo: '771', type: 'package',
    reason: `already sold to ${CUSTOMER} on ${DAY} under request R-DDDD — a duplicate, not sold again` }]);
  assert.deepEqual({ t: res.bundleReport.appliedThans, y: res.bundleReport.appliedYards, rt: res.bundleReport.restartedThans, d: res.bundleReport.duplicateRows }, { t: 27, y: 810, rt: 21, d: 6 });
  assert.equal(out.txns[0].qty, 810, 'the duplicate is not charged');
  assert.match(out.audits.find((a) => a.type === 'sale_bundle_partial').payload.failedItems[0].reason, /duplicate/);
});

test('a PENDING sale of the same customer/day covering a row BLOCKS the restart: nothing put back, sold or booked', async () => {
  const pend = { requestId: 'pppp2222-0000-4000-8000-000000000000', user: 'emp2', status: 'pending', actionJSON: {
    action: 'sale_bundle', customer: CUSTOMER, salesDate: DAY, warehouse: WH, items: [{ type: 'than', packageNo: '6210', thanNo: 5, warehouse: WH }],
  } };
  const out = harness(world9bf6(), { otherPending: [pend] });
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, false);
  assert.match(res.message, /another PENDING sale request \(R-PPPP\) for the same customer and day covers bale 6210\/5 — decide that request first/);
  assert.match(res.message, /Nothing was changed/);
  assert.equal(out.restores.length + out.sells.length + out.txns.length + out.sales.length + out.invoices, 0);
});

test('books already carry the request → nothing put back, sold, booked or invoiced; the request is only marked approved and the missing sides are named', async () => {
  const rows = world9bf6();
  const out = harness(rows, { priorTxn: true });
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', { ...ENRICH, paymentMode: 'Cash', amountPaid: 50000 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(out.restores.length + out.sells.length + out.txns.length + out.sales.length + out.invoices + out.payments.length, 0);
  assert.equal(out.persisted.length, 0, 'the earlier run\'s enrichment stays on the row');
  assert.deepEqual({ t: res.bundleReport.appliedThans, y: res.bundleReport.appliedYards, ab: res.bundleReport.alreadyBooked }, { t: 27, y: 810, ab: { transactions: 1, ledger: 0, invoice: false } });
  assert.deepEqual(res.bundleReport.failedItems, [{ packageNo: '772', type: 'package', reason: 'not part of the sale already booked under this request — raise a fresh request if it is still to be sold' }]);
  assert.deepEqual(res.erpFailures.map((f) => f.stage), ['sale ledger (bundle)', 'invoice issue', 'payment record (bundle)']);
  assert.match(res.erpFailures[0].error, /never wrote the customer's ledger debit; post it by hand/);
  assert.match(res.erpFailures[2].error, /check the customer statement and record the 50,000/);
  assert.ok(rows.filter((r) => r.packageNo === '772').every((r) => r.status === 'available'), '772 untouched');
  assert.ok(out.audits.some((a) => a.type === 'sale_bundle_already_booked'));
  // Every book side present → a clean close with nothing to report.
  const out2 = harness(world9bf6(), { priorTxn: true, ledgerHas: [`${ID}-9037`, `${ID}-9006`, `${ID}-PAY`], invoiceExists: true });
  const res2 = await inventoryService.executeApprovedAction(ID, 'admin1', { ...ENRICH, paymentMode: 'Cash', amountPaid: 50000 });
  assert.equal(res2.ok, true);
  assert.deepEqual(res2.erpFailures, []);
  assert.equal(out2.payments.length, 0);
});

test('a needed record that cannot be read → NOTHING is written and the message says why', async () => {
  for (const o of [{ resolvedThrows: true }, { booksThrow: true }]) {
    const out = harness(world9bf6(), o);
    const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
    assert.equal(res.ok, false);
    assert.match(res.message, /27 than\(s\) of 7 item\(s\) are already sold to Ayubal Ansari on 2026-09-25 by an earlier run of this request/);
    assert.match(res.message, /could not be read/);
    assert.match(res.message, /Nothing was changed — try again in a minute/);
    assert.equal(out.restores.length + out.sells.length + out.txns.length + out.sales.length + out.invoices, 0);
  }
});

test('a normal sale (nothing of its own already flipped) reads no record and puts nothing back', async () => {
  const rows = world9bf6().map((r) => (r.soldTo === 'AYUBAL ANSARI' ? { ...r, status: 'available', soldTo: '', soldDate: '' } : r));
  const out = harness(rows);
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, true);
  assert.equal(out.resolvedReads + out.bookReads + out.restores.length, 0);
  assert.deepEqual({ t: res.bundleReport.appliedThans, rt: res.bundleReport.restartedThans }, { t: 33, rt: 0 });
  assert.ok(!out.audits.some((a) => a.type === 'sale_bundle_restarted'));
});

test('EVERY item flipped by the earlier run, no books → all put back and sold afresh, the books written', async () => {
  const rows = world9bf6().map((r) => (r.packageNo === '772' ? { ...mine('772', r.thanNo, '9037'), rowIndex: r.rowIndex } : r));
  const out = harness(rows);
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(out.restores[0].want.length, 33);
  assert.deepEqual({ t: res.bundleReport.appliedThans, y: res.bundleReport.appliedYards, rt: res.bundleReport.restartedThans }, { t: 33, y: 990, rt: 33 });
  assert.equal(out.txns[0].qty, 990);
  assert.equal(out.invoices, 1);
});

test('a bale with a than sold to someone else months ago still restarts its OWN thans (per row, not per bale)', async () => {
  const rows = world9bf6();
  // 6189 as a PACKAGE item: than 5 is this sale's, than 4 is Zakirullah's from July.
  const aj = AJ();
  aj.items[5] = { type: 'package', packageNo: '6189', warehouse: WH };
  const out = harness(rows, { aj });
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(out.restores[0].want.length, 27);
  assert.ok(out.restores[0].want.every((r) => r.soldTo === 'AYUBAL ANSARI'));
  assert.deepEqual({ t: res.bundleReport.appliedThans, f: res.bundleReport.failedItems }, { t: 33, f: [] });
  const z = rows.find((r) => r.packageNo === '6189' && r.thanNo === 4);
  assert.deepEqual([z.status, z.soldTo], ['sold', 'Zakirullah'], 'the July sale is untouched');
});

test('stock gone to SOMEONE ELSE is still a plain failure', async () => {
  const rows = world9bf6().map((r) => (r.packageNo === '779' ? { ...r, soldTo: 'Musa' } : r));
  const out = harness(rows);
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, true);
  assert.deepEqual(res.bundleReport.failedItems, [{ packageNo: '779', type: 'package', reason: 'not found or no available thans' }]);
  assert.deepEqual({ t: res.bundleReport.appliedThans, rt: res.bundleReport.restartedThans }, { t: 27, rt: 21 });
  assert.equal(out.txns[0].qty, 810);
});

test('the sale write refused after the put-back → the executor throws, nothing is booked, the rows are available for a clean re-approve', async () => {
  const rows = world9bf6();
  const out = harness(rows, { sellThrows: true });
  await assert.rejects(inventoryService.executeApprovedAction(ID, 'admin1', ENRICH), (e) => e.code === 'SHEETS_QUOTA');
  assert.equal(out.restores.length, 1);
  assert.equal(out.txns.length + out.sales.length + out.invoices, 0);
  assert.ok(rows.filter((r) => r.soldTo === 'AYUBAL ANSARI').length === 0 && rows.filter((r) => r.packageNo === '771').every((r) => r.status === 'available'));
  // …and the put-back itself refused → nothing at all changed.
  const rows2 = world9bf6();
  const out2 = harness(rows2, { restoreThrows: true });
  await assert.rejects(inventoryService.executeApprovedAction(ID, 'admin1', ENRICH), (e) => e.code === 'SHEETS_QUOTA');
  assert.equal(out2.sells.length + out2.txns.length, 0);
  assert.equal(rows2.filter((r) => r.soldTo === 'AYUBAL ANSARI').length, 27);
});

test('every item a duplicate → the APF-1 refusal names each item\'s reason', async () => {
  const dup = { requestId: 'dddd1111-2222-4333-8444-555555555555', user: 'emp2', status: 'approved', actionJSON: { ...AJ(), customer: CUSTOMER } };
  const rows = world9bf6().map((r) => (r.packageNo === '772' ? { ...mine('772', r.thanNo, '9037'), rowIndex: r.rowIndex } : r));
  const out = harness(rows, { resolved: [dup] });
  const res = await inventoryService.executeApprovedAction(ID, 'admin1', ENRICH);
  assert.equal(res.ok, false);
  assert.equal(res.allItemsFailed, true);
  assert.match(res.message, /^no item could be applied — every bale\/than in this request is already sold or not found:\n• Bale 771: already sold to Ayubal Ansari on 2026-09-25 under request R-DDDD — a duplicate, not sold again/);
  assert.match(res.message, /• Bale 6199 Than 5: already sold/);
  assert.equal(out.restores.length + out.txns.length + out.sales.length, 0);
});

test('the payment of a fresh pass is keyed to the request; a quota refusal on the final status write names any failed book write', async () => {
  const out = harness(world9bf6());
  await inventoryService.executeApprovedAction(ID, 'admin1', { ...ENRICH, paymentMode: 'Cash', amountPaid: 50000 });
  assert.equal(out.payments.length, 1);
  assert.equal(out.payments[0].txnId, `${ID}-PAY`);

  harness(world9bf6());
  const quota = () => Object.assign(new Error('Google Sheets is rate-limiting writes right now — wait one minute, then tap again. (batchUpdate(ApprovalQueue))'), { code: 'SHEETS_QUOTA' });
  transactionsRepository.append = async () => { throw quota(); };
  approvalQueueRepository.updateStatus = async () => { throw quota(); };
  await assert.rejects(inventoryService.executeApprovedAction(ID, 'admin1', ENRICH), (e) => e.code === 'SHEETS_QUOTA_AFTER_APPLY'
    && /^Applied — only the request could not be marked approved/.test(e.message)
    && /1 book write\(s\) FAILED as well \(Transactions row \(bundle\)\) — post them by hand/.test(e.message)
    && /tap Approve again — the bot sees the sale is already booked/.test(e.message)
    && !/Mark as done/.test(e.message));
});

test('single doors: a refused rate stamp after the flip is collected, not thrown; their after-apply advice stays Mark as done', async () => {
  harness(world9bf6());
  const single = { requestId: 'single-1', user: 'emp1', status: 'pending', actionJSON: { action: 'sell_than', packageNo: '772', thanNo: 1, design: '9037', yards: 30, customer: CUSTOMER, salesDate: DAY, warehouse: WH } };
  approvalQueueRepository.getAllPending = async () => [JSON.parse(JSON.stringify(single))];
  const stockEngine = require('../../../src/services/stockEngine');
  const origSellThan = stockEngine.sellThan;
  stockEngine.sellThan = async () => ({ packageNo: '772', thanNo: 1, yards: 30, design: '9037' });
  inventoryRepository.updatePrice = async () => { throw Object.assign(new Error('Google Sheets is rate-limiting writes right now — wait one minute, then tap again. (batchUpdate(Inventory))'), { code: 'SHEETS_QUOTA' }); };
  try {
    const res = await inventoryService.executeApprovedAction('single-1', 'admin1', ENRICH);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.erpFailures.map((f) => f.stage), ['rate stamp (sell_than)']);
    approvalQueueRepository.getAllPending = async () => [JSON.parse(JSON.stringify(single))];
    approvalQueueRepository.updateStatus = async () => { throw Object.assign(new Error('rate-limiting writes'), { code: 'SHEETS_QUOTA' }); };
    await assert.rejects(inventoryService.executeApprovedAction('single-1', 'admin1', ENRICH), (e) => e.code === 'SHEETS_QUOTA_AFTER_APPLY'
      && /choose ✅ Mark as done \(no re-run\)/.test(e.message));
  } finally {
    stockEngine.sellThan = origSellThan;
  }
});
