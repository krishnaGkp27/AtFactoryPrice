'use strict';

/**
 * RET-4 — the approved multi-than return card (`return_thans`).
 *
 * Pins the executor's contract (specs/RET-3_RETURN_CREDIT.md Part B):
 * every ticked than flips through stockEngine.returnThan carrying the
 * return DATE and the exact physical row's bale_uid; ONE Transactions row
 * and ONE ledger credit cover the whole set (txn `RN-<bale>-<requestId>`);
 * the buyer is resolved from the sold rows BEFORE the flip blanks soldTo;
 * a than that is no longer sold — or has been re-sold to somebody else while
 * the dual-admin request sat pending — is SKIPPED and named, never flipped
 * and never credited to the first buyer; a missing rate is reported as a
 * book failure instead of a silent ₦0; and the AuditLog payload carries the
 * condition, the note, the date and whether a photo rode along (§6d).
 */

process.env.ADMIN_IDS = '777,888';

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryService = require('../../../src/services/inventoryService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const accountingService = require('../../../src/services/accountingService');
const auditService = require('../../../src/services/auditService');
const customerEntity = require('../../../src/services/customerEntity');
const stockEngine = require('../../../src/services/stockEngine');

auditService.log = async () => true;
// The stock_events shadow is fail-open in prod; keep it inert here.
if (stockEngine._internals && stockEngine._internals.shadow) stockEngine._internals.shadow = async () => {};

const NAMES = {
  ABBA: { name: 'ABBA', customer_id: 'CUS-ABBA' },
  'abba textiles': { name: 'ABBA', customer_id: 'CUS-ABBA' },
  CHIMA: { name: 'CHIMA', customer_id: 'CUS-CHIMA' },
};
customerEntity.resolve = async ({ name }) => NAMES[name] || null;

const ROW = {
  packageNo: '9037', warehouse: 'Kano office', design: 'Cashmere', shade: 'Blue',
  status: 'sold', soldTo: 'ABBA',
};
const rows = (...specs) => specs.map((s) => ({ ...ROW, ...s }));

/**
 * Drive executeApprovedAction over a fixture set of Inventory rows.
 * `flipFails` names thans whose markThanAvailable comes back null;
 * `flipPrior` overrides the soldToPrior a flip reports back.
 */
function harness({ aj, invRows, flipFails = [], flipPrior = {} }) {
  const item = { requestId: 'REQ-RET', user: '555', actionJSON: aj, status: 'pending' };
  const calls = { flips: [], recordReturn: [], txn: [], audit: [] };
  let resolved = false;
  approvalQueueRepository.getAllPending = async () => (resolved ? [] : [JSON.parse(JSON.stringify(item))]);
  approvalQueueRepository.updateStatus = async (id, status) => { if (status !== 'pending') resolved = true; return true; };
  auditLogRepository.append = async (kind, payload) => { calls.audit.push({ kind, payload }); };
  transactionsRepository.append = async (rec) => { calls.txn.push(rec); return true; };
  accountingService.recordReturn = async (data) => { calls.recordReturn.push(data); };
  inventoryRepository.findByPackage = async () => invRows.map((r) => ({ ...r }));
  inventoryRepository.findThan = async (pkg, thanNo) => invRows.find((r) => String(r.thanNo) === String(thanNo)) || null;
  inventoryRepository.markThanAvailable = async (packageNo, thanNo, opts) => {
    calls.flips.push({ packageNo, thanNo, opts });
    if (flipFails.map(String).includes(String(thanNo))) return null;
    const src = invRows.find((r) => String(r.thanNo) === String(thanNo));
    const prior = Object.prototype.hasOwnProperty.call(flipPrior, String(thanNo))
      ? flipPrior[String(thanNo)] : src.soldTo;
    return { ...src, status: 'available', soldTo: '', soldToPrior: prior };
  };
  return calls;
}

const BASE_AJ = {
  action: 'return_thans', packageNo: '9037', warehouse: 'Kano office',
  thanNos: [1, 4], customer: 'ABBA', customerId: 'CUS-ABBA',
  returnedOn: '2026-08-28', condition: 'damaged', conditionNote: '6 yd cut off',
  return_photo_file_id: 'ph-1', pricePerYard: 2500, yards: 60,
  design: 'Cashmere', shade: 'Blue',
};

const TWO_SOLD = rows(
  { thanNo: 1, yards: 30, pricePerYard: 2500, baleUid: 'uid-1' },
  { thanNo: 2, yards: 30, pricePerYard: 2500, baleUid: 'uid-2' },
  { thanNo: 4, yards: 30, pricePerYard: 2500, baleUid: 'uid-4' },
);

test('every ticked than flips with the return date and its own bale_uid', async () => {
  const calls = harness({ aj: BASE_AJ, invRows: TWO_SOLD });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true);
  assert.equal(calls.flips.length, 2, 'only the ticked thans, never the untouched #2');
  assert.deepEqual(calls.flips.map((f) => String(f.thanNo)), ['1', '4']);
  for (const f of calls.flips) {
    assert.equal(f.opts.on, '2026-08-28', 'RET-3 — the movement carries the day the goods came back');
    assert.equal(f.opts.warehouse, 'Kano office', 'TRF-INT4 — the store the bale was sold from');
    assert.equal(f.opts.kind, 'return');
  }
  assert.deepEqual(calls.flips.map((f) => f.opts.baleUid), ['uid-1', 'uid-4'],
    '§5 — the exact physical row, so a same-numbered live duplicate is never hit');
});

test('ONE Transactions row covers the whole set, dated returnedOn', async () => {
  const calls = harness({ aj: BASE_AJ, invRows: TWO_SOLD });
  await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(calls.txn.length, 1);
  const t = calls.txn[0];
  assert.equal(t.action, 'return_thans');
  assert.equal(t.qty, 60, 'total yards of the ticked thans');
  assert.equal(t.warehouse, 'Kano office');
  assert.equal(t.customerName, 'ABBA');
  assert.equal(t.customerId, 'CUS-ABBA');
  assert.equal(t.saleRefId, 'REQ-RET');
  assert.equal(t.pricePerYard, 2500);
  assert.equal(t.salesDate, '2026-08-28');
  assert.equal(t.before, 'sold');
  assert.equal(t.after, 'available');
});

test('ONE ledger credit for the set, txn RN-<bale>-<requestId>', async () => {
  const calls = harness({ aj: BASE_AJ, invRows: TWO_SOLD });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(calls.recordReturn.length, 1, 'one credit, not one per than');
  const c = calls.recordReturn[0];
  assert.equal(c.txnId, 'RN-9037-REQ-RET');
  assert.equal(c.yards, 60);
  assert.equal(c.pricePerYard, 2500);
  assert.equal(c.customer, 'ABBA');
  assert.equal(c.customerId, 'CUS-ABBA');
  assert.deepEqual(res.erpFailures, []);
  assert.match(res.creditNote, /Credited ₦150,000 to ABBA \(2 thans, 60 yds × ₦2,500\/yd\)/);
});

test('the buyer is resolved from the SOLD rows, not the request spelling', async () => {
  // The rows say "abba textiles"; the request was raised naming "ABBA".
  // CUS-2: the credit must land on the canonical customer of the rows.
  const invRows = rows(
    { thanNo: 1, yards: 30, pricePerYard: 2500, soldTo: 'abba textiles' },
    { thanNo: 4, yards: 30, pricePerYard: 2500, soldTo: 'abba textiles' },
  );
  const calls = harness({ aj: { ...BASE_AJ, customer: 'abba textiles' }, invRows });
  await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(calls.recordReturn[0].customer, 'ABBA');
  assert.equal(calls.recordReturn[0].customerId, 'CUS-ABBA');
});

test('a than that is no longer sold is skipped and named, the rest still return', async () => {
  const invRows = rows(
    { thanNo: 1, yards: 30, pricePerYard: 2500 },
    { thanNo: 4, yards: 30, pricePerYard: 2500, status: 'available', soldTo: '' },
  );
  const calls = harness({ aj: BASE_AJ, invRows });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true);
  assert.equal(calls.flips.length, 1);
  assert.equal(calls.recordReturn[0].yards, 30, 'only the than that came back is credited');
  assert.match(res.creditNote, /#4 \(not sold — nothing flipped\)/);
});

test('every ticked than already gone → ok:false, no flip, no ledger call', async () => {
  const invRows = rows(
    { thanNo: 1, yards: 30, pricePerYard: 2500, status: 'available', soldTo: '' },
    { thanNo: 4, yards: 30, pricePerYard: 2500, status: 'available', soldTo: '' },
  );
  const calls = harness({ aj: BASE_AJ, invRows });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, false);
  assert.equal(calls.flips.length, 0);
  assert.equal(calls.recordReturn.length, 0);
  assert.match(res.message, /No thans of Bale 9037 are still sold to ABBA/);
});

test('a than re-sold to somebody else while the request waited is skipped, never credited to the first buyer', async () => {
  // A dual-admin request can sit pending for days. Than #4 came back through
  // another door and was re-sold to CHIMA in the meantime.
  const invRows = rows(
    { thanNo: 1, yards: 30, pricePerYard: 2500 },
    { thanNo: 4, yards: 30, pricePerYard: 2500, soldTo: 'CHIMA' },
  );
  const calls = harness({ aj: BASE_AJ, invRows });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true);
  assert.equal(calls.flips.length, 1, "CHIMA's than is never flipped");
  assert.equal(String(calls.flips[0].thanNo), '1');
  assert.equal(calls.recordReturn[0].yards, 30, "only ABBA's than enters the credit");
  assert.equal(calls.recordReturn[0].customer, 'ABBA');
  assert.match(res.creditNote, /#4 \(now sold to CHIMA\)/);
});

test('every ticked than re-sold elsewhere → ok:false, nothing flipped, nothing credited', async () => {
  const invRows = rows(
    { thanNo: 1, yards: 30, pricePerYard: 2500, soldTo: 'CHIMA' },
    { thanNo: 4, yards: 30, pricePerYard: 2500, soldTo: 'CHIMA' },
  );
  const calls = harness({ aj: BASE_AJ, invRows });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, false);
  assert.equal(calls.flips.length, 0);
  assert.equal(calls.recordReturn.length, 0);
});

test('a buyer that changed between the read and the flip is skipped, its yards stay out of the credit', async () => {
  const calls = harness({ aj: BASE_AJ, invRows: TWO_SOLD, flipPrior: { 4: 'CHIMA' } });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true);
  assert.equal(calls.flips.length, 2, 'both were attempted');
  assert.equal(calls.recordReturn[0].yards, 30, 'the mismatched than is not credited');
  assert.match(res.creditNote, /#4 \(buyer changed mid-flight\)/);
});

test('no rate on record: the stock returns, the missing credit is reported, never a silent ₦0', async () => {
  const invRows = rows(
    { thanNo: 1, yards: 30, pricePerYard: 0 },
    { thanNo: 4, yards: 30, pricePerYard: 0 },
  );
  const calls = harness({ aj: { ...BASE_AJ, pricePerYard: 0 }, invRows });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true, 'the stock flip still happens');
  assert.equal(calls.flips.length, 2);
  assert.equal(res.erpFailures.length, 1);
  assert.match(res.erpFailures[0].error, /no rate on record for Bale 9037 thans 1, 4/);
  assert.equal(res.creditNote, null);
  assert.ok(calls.audit.some((a) => a.kind === 'erp_hook_failed'), 'AuditLog carries the uncredited return');
});

test('a ledger failure is surfaced, not swallowed', async () => {
  const calls = harness({ aj: BASE_AJ, invRows: TWO_SOLD });
  const original = accountingService.recordReturn;
  accountingService.recordReturn = async () => { throw new Error('sheet quota'); };
  try {
    const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
    assert.equal(res.ok, true);
    assert.equal(res.erpFailures.length, 1);
    assert.match(res.erpFailures[0].error, /sheet quota/);
    assert.equal(calls.recordReturn.length, 0);
  } finally { accountingService.recordReturn = original; }
});

test('the AuditLog row carries the thans, the condition, the note, the date and the photo flag', async () => {
  const calls = harness({ aj: BASE_AJ, invRows: TWO_SOLD });
  await inventoryService.executeApprovedAction('REQ-RET', '777');
  const row = calls.audit.find((a) => a.kind === 'return_thans');
  assert.ok(row, 'one return_thans AuditLog row');
  assert.deepEqual(row.payload.thanNos, ['1', '4']);
  assert.deepEqual(row.payload.returned, [1, 4]);
  assert.equal(row.payload.yards, 60);
  assert.equal(row.payload.rate, 2500);
  assert.equal(row.payload.condition, 'damaged');
  assert.equal(row.payload.conditionNote, '6 yd cut off');
  assert.equal(row.payload.returnedOn, '2026-08-28');
  assert.equal(row.payload.photo, true);
  assert.equal(row.payload.customerId, 'CUS-ABBA');
  assert.equal(row.payload.warehouse, 'Kano office');
  assert.equal(row.payload.requestId, 'REQ-RET');
});

test('a request with no thans is refused before anything is touched', async () => {
  const calls = harness({ aj: { ...BASE_AJ, thanNos: [] }, invRows: TWO_SOLD });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, false);
  assert.match(res.message, /No thans on this return request/);
  assert.equal(calls.flips.length, 0);
  assert.equal(calls.txn.length, 0);
});

test('arrivalBatch on the payload scopes the flip to that container', async () => {
  // §5 — the same printed number in two containers of one store. Only the
  // rows of the named container may be flipped.
  const invRows = rows(
    { thanNo: 1, yards: 30, pricePerYard: 2500, arrivalBatch: 'C-1', baleUid: 'uid-c1' },
    { thanNo: 4, yards: 30, pricePerYard: 2500, arrivalBatch: 'C-2', baleUid: 'uid-c2' },
  );
  const calls = harness({ aj: { ...BASE_AJ, arrivalBatch: 'C-1' }, invRows });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true);
  assert.deepEqual(calls.flips.map((f) => f.opts.baleUid), ['uid-c1']);
  assert.match(res.creditNote, /#4 \(not sold — nothing flipped\)/);
});

test('a differently spelled but same-id buyer is recognised through customerEntity, not skipped', async () => {
  // The rows read "abba textiles"; the request names "ABBA" with the
  // customer_id. Both resolve to CUS-ABBA, so the thans are still his.
  const invRows = rows(
    { thanNo: 1, yards: 30, pricePerYard: 2500, soldTo: 'abba textiles' },
    { thanNo: 4, yards: 30, pricePerYard: 2500, soldTo: 'abba textiles' },
  );
  const calls = harness({ aj: BASE_AJ, invRows });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true);
  assert.equal(calls.flips.length, 2, 'the spelling difference does not lose the thans');
  assert.equal(calls.recordReturn[0].customerId, 'CUS-ABBA');
});

/* ── the rate a partial apply credits at ─────────────────────────────── */

test('a mixed-rate set credits the SURVIVORS at their own booked rate, never the set average', async () => {
  // The card sends the yards-weighted average of the ticked set as a DISPLAY
  // figure (30 yd @₦2,000 + 30 yd @₦3,000 → ₦2,500/yd, ₦150,000). Applied as
  // a uniform override to a partial apply it would credit the one surviving
  // than 30 × ₦2,500 = ₦75,000 instead of its booked 30 × ₦2,000 = ₦60,000.
  const invRows = rows(
    { thanNo: 1, yards: 30, pricePerYard: 2000, baleUid: 'uid-1' },
    { thanNo: 4, yards: 30, pricePerYard: 3000, baleUid: 'uid-4', soldTo: 'CHIMA' },
  );
  const calls = harness({ aj: { ...BASE_AJ, pricePerYard: 2500, yards: 60 }, invRows });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true);
  assert.equal(calls.flips.length, 1);
  assert.equal(calls.recordReturn.length, 1);
  assert.equal(calls.recordReturn[0].yards, 30);
  assert.equal(calls.recordReturn[0].pricePerYard, 2000, "than #1's own booked rate");
  assert.equal(calls.txn[0].pricePerYard, 2000, 'the Transactions row carries the same rate');
  assert.match(res.creditNote, /Credited ₦60,000 to ABBA/);
  assert.match(res.creditNote, /#4 \(now sold to CHIMA\)/);
});

test('a mixed-rate set that applies in FULL credits the exact booked total', async () => {
  const invRows = rows(
    { thanNo: 1, yards: 30, pricePerYard: 2000, baleUid: 'uid-1' },
    { thanNo: 4, yards: 30, pricePerYard: 3000, baleUid: 'uid-4' },
  );
  const calls = harness({ aj: { ...BASE_AJ, pricePerYard: 2500, yards: 60 }, invRows });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true);
  assert.equal(calls.recordReturn[0].yards, 60);
  assert.equal(calls.recordReturn[0].pricePerYard, 2500, 'the weighted rate reproduces ₦150,000');
  assert.match(res.creditNote, /Credited ₦150,000 to ABBA/);
  assert.deepEqual(res.erpFailures, []);
});

test('an UNPRICED survivor gets the loud zero, never the average of its priced neighbour', async () => {
  // #1 has no rate on record, #4 does — the card's average is ₦1,250/yd.
  // #4 is re-sold while the request waits, so only the unpriced than
  // survives: RET-3 says the stock comes back and the credit is REPORTED
  // missing, not quietly paid at a rate nobody booked.
  const invRows = rows(
    { thanNo: 1, yards: 30, pricePerYard: 0, baleUid: 'uid-1' },
    { thanNo: 4, yards: 30, pricePerYard: 2500, baleUid: 'uid-4', soldTo: 'CHIMA' },
  );
  const calls = harness({ aj: { ...BASE_AJ, pricePerYard: 1250, yards: 60 }, invRows });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true, 'the stock still comes back');
  assert.equal(calls.flips.length, 1);
  assert.equal(res.erpFailures.length, 1);
  assert.match(res.erpFailures[0].error, /no rate on record for Bale 9037/);
  assert.equal(calls.recordReturn[0].pricePerYard, 0, 'no invented rate reaches the ledger');
  assert.ok(!/Credited/.test(res.creditNote || ''), `got: ${res.creditNote}`);
});

/* ── one printed number, two containers ──────────────────────────────── */

test("a same-numbered than in ANOTHER container is not reported as skipped when ours flipped", async () => {
  // §5 — 9037 sits twice in Kano office; the neighbour's #1 belongs to CHIMA.
  // Ours IS flipped and credited, so naming #1 on the approve reply as
  // "nothing flipped, nothing credited" would tell the second admin the
  // return partly failed when it did not.
  const invRows = rows(
    { thanNo: 1, yards: 30, pricePerYard: 2500, arrivalBatch: 'C-1', baleUid: 'uid-a' },
    { thanNo: 1, yards: 30, pricePerYard: 2500, arrivalBatch: 'C-2', baleUid: 'uid-b', soldTo: 'CHIMA' },
    { thanNo: 4, yards: 30, pricePerYard: 2500, arrivalBatch: 'C-1', baleUid: 'uid-4' },
  );
  const calls = harness({ aj: BASE_AJ, invRows });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true);
  assert.deepEqual(calls.flips.map((f) => String(f.thanNo)), ['1', '4']);
  assert.equal(calls.recordReturn[0].yards, 60);
  assert.ok(!/Skipped/.test(res.creditNote || ''), `no false warning, got: ${res.creditNote}`);
  const row = calls.audit.find((a) => a.kind === 'return_thans');
  assert.deepEqual(row.payload.skipped, [], 'and the AuditLog does not contradict itself');
});

test('the SAME customer holding one than number in two containers flips neither', async () => {
  // Both rows are his (a recycled printed number, same regular buyer). The
  // request cannot say which 9037 came back, so flipping both would return —
  // and credit — twice what the card promised.
  const invRows = rows(
    { thanNo: 1, yards: 30, pricePerYard: 2500, arrivalBatch: 'C-1', baleUid: 'uid-a' },
    { thanNo: 1, yards: 30, pricePerYard: 2500, arrivalBatch: 'C-2', baleUid: 'uid-b' },
    { thanNo: 4, yards: 30, pricePerYard: 2500, arrivalBatch: 'C-1', baleUid: 'uid-4' },
  );
  const calls = harness({ aj: BASE_AJ, invRows });
  const res = await inventoryService.executeApprovedAction('REQ-RET', '777');
  assert.equal(res.ok, true);
  assert.deepEqual(calls.flips.map((f) => String(f.thanNo)), ['4'], 'only the unambiguous than');
  assert.equal(calls.recordReturn[0].yards, 30, 'nothing doubled');
  assert.match(res.creditNote, /#1 \(this bale number sits in two containers here/);
});
