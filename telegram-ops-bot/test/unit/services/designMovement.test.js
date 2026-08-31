'use strict';

/**
 * DML-1 — the movement ledger's arithmetic, walked by hand.
 *
 * The build order is explicit that wrong arithmetic is not fixable at the
 * page layer, so these tests reconcile a whole statement figure by figure:
 * opening + every movement = book, every running balance is the previous one
 * moved by exactly its row, and the gap is the audit's own two stored sides.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const goodsReceiptsRepository = require('../../../src/repositories/goodsReceiptsRepository');
const baleMovementsRepository = require('../../../src/repositories/baleMovementsRepository');
const stockTakesRepository = require('../../../src/repositories/stockTakesRepository');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');

const designMovementService = require('../../../src/services/designMovementService');

const WH = 'Kano office';
const DESIGN = '9043-B';

/** One Inventory row = one than. */
function than(pkg, thanNo, over = {}) {
  return {
    packageNo: pkg, design: DESIGN, shade: '2', thanNo, yards: 30,
    status: 'available', warehouse: WH, soldTo: '', soldDate: '',
    dateReceived: '2026-08-03', arrivalBatch: 'Aug26', designCategory: 'CASHMERE',
    grnId: 'G1', baleUid: `BAL-${pkg}-${thanNo}`, ...over,
  };
}

// Bale A: 3 thans, all sold on 07-Aug (a WHOLE bale left).
// Bale B: 2 thans, one sold on 07-Aug (a LOOSE than left), one still on the shelf.
const SOLD = { status: 'sold', soldTo: 'OKESON STORES', soldDate: '2026-08-07' };
const BASE_INV = [
  than('A', 1, SOLD), than('A', 2, SOLD), than('A', 3, SOLD),
  than('B', 1, SOLD), than('B', 2),
];

function stubAll({ inv = BASE_INV, moves = [], takes = [], pending = [] } = {}) {
  inventoryRepository.getAll = async () => inv;
  goodsReceiptsRepository.getAll = async () => ([{
    grn_id: 'G1', warehouse: WH, supplier: 'Wuse Textiles',
    received_at: '2026-08-03T09:20:00.000Z', status: 'received',
  }]);
  baleMovementsRepository.getAll = async () => moves;
  stockTakesRepository.getAll = async () => takes;
  approvalQueueRepository.getAllPending = async () => pending;
}

const AUDIT_MISMATCH = {
  stocktake_id: 'STK-1', warehouse: WH, design: DESIGN,
  sheet_bales: 0, sheet_bundles: 1, sheet_yards: 30,
  result: 'mismatch', auditor: '777', audited_at: '2026-08-10T07:15:00.000Z',
  counted_bales: 0, counted_bundles: 0, note: 'blind count',
};

test('the statement reconciles: opening + every movement = book, step by step', async () => {
  stubAll({ takes: [AUDIT_MISMATCH] });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });

  // Opening: nothing on the shelf before the first receipt.
  assert.equal(out.opening.bales, 0);
  assert.equal(out.opening.thans, 0);
  assert.equal(out.opening.yards, 0);
  assert.equal(out.opening.yards_exact, true);

  const rows = out.movements;
  assert.deepEqual(rows.map((r) => r.type), ['receipt', 'sale', 'audit']);

  // Receipt: 2 whole bales (A's 3 thans + B's 2), 150 yd.
  assert.equal(rows[0].family, 'in');
  assert.deepEqual([rows[0].qty.bales, rows[0].qty.thans, rows[0].qty.yards], [2, 0, 150]);
  assert.equal(rows[0].qty.label, '2B');
  assert.equal(rows[0].counterparty, 'Wuse Textiles');
  assert.deepEqual([rows[0].running.bales, rows[0].running.thans, rows[0].running.yards], [2, 0, 150]);

  // Sale: A whole (3 thans) + one loose than out of B = 1B + 1t, 120 yd.
  assert.equal(rows[1].family, 'out');
  assert.deepEqual([rows[1].qty.bales, rows[1].qty.thans, rows[1].qty.yards], [1, 1, 120]);
  assert.equal(rows[1].qty.label, '1B + 1t');
  assert.equal(rows[1].counterparty, 'OKESON STORES');
  assert.deepEqual(rows[1].detail.whole_bales, [{ bale_no: 'A', thans: 3, yards: 90 }]);
  assert.deepEqual(rows[1].detail.loose, [{ count: 1, yards: 30, from_bale: 'B' }]);
  // 2B · 150 yd − (1B + 1t · 120 yd) = one loose than of B, 30 yd.
  assert.deepEqual([rows[1].running.bales, rows[1].running.thans, rows[1].running.yards], [0, 1, 30]);
  assert.equal(rows[1].running.label, '1t');

  // A checkpoint moves no stock, so the running balance is unchanged.
  assert.equal(rows[2].family, 'checkpoint');
  assert.equal(rows[2].qty, null);
  assert.deepEqual([rows[2].running.bales, rows[2].running.thans], [0, 1]);

  // Book equals the last running balance, by construction.
  assert.deepEqual(
    [out.closing.book.bales, out.closing.book.thans, out.closing.book.yards], [0, 1, 30]);
  assert.equal(out.closing.book.label, '1t');

  // Walk it as the owner would: opening, then each row, must land on book.
  let yards = out.opening.yards;
  for (const r of rows) {
    if (!r.qty) continue;
    yards += (r.family === 'in' ? 1 : -1) * r.qty.yards;
    assert.equal(yards, r.running.yards, `running yards drift at ${r.id}`);
  }
  assert.equal(yards, out.closing.book.yards);
});

test('a blind mismatch states the gap in packaging and refuses to invent yards', async () => {
  stubAll({ takes: [AUDIT_MISMATCH] });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });

  // The audit stored both sides of its own comparison: book 0B+1t vs counted 0B+0t.
  assert.deepEqual(out.closing.gap_packaging, { bales: 0, thans: 1 });
  assert.equal(out.closing.gap_yards, null, 'no counted yards exist — never guess one');
  assert.equal(out.closing.gap_label, '−1t', 'a shortage prints with its own sign');
  assert.equal(out.closing.gap_direction, 'short');
  assert.equal(out.closing.count.result, 'mismatch');
  assert.equal(out.closing.count.yards, null);
  assert.deepEqual(
    [out.closing.count.book_at_count.bales, out.closing.count.book_at_count.thans], [0, 1]);
  assert.match(out.notes.join(' '), /stated in packaging, not yards/);
});

test('a reconciled count carries exact yards and a zero gap', async () => {
  stubAll({
    takes: [{
      ...AUDIT_MISMATCH, result: 'reconciled', counted_bales: 0, counted_bundles: 1,
    }],
  });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });
  assert.equal(out.closing.gap_yards, 0);
  assert.deepEqual(out.closing.gap_packaging, { bales: 0, thans: 0 });
  assert.equal(out.closing.count.yards, 30, 'same goods, so the book yards ARE the counted yards');
  assert.equal(out.closing.count.yards_exact, true);
  assert.equal(out.hints.length, 0, 'nothing to explain when the count agrees');
});

test('hints: a queued sale qualifies, an already-deducted transfer never does', async () => {
  // A transfer dispatched BEFORE the count: the book had already lost it, so
  // it cannot explain the book EXCEEDING the count. It must appear as a
  // movement and must NOT appear as a candidate.
  const dispatch = {
    rowIndex: 9, timestamp: '2026-08-05T10:00:00.000Z', movedOn: '2026-08-05',
    baleNo: 'C', design: DESIGN, shade: '2', container: 'Aug26', thans: 4,
    fromState: `available @ ${WH}`, toState: 'in_transit @ Lagos',
    kind: 'dispatch', ref: 'TRF-0088', user: '777', current: true,
  };
  stubAll({
    takes: [AUDIT_MISMATCH],
    moves: [dispatch],
    pending: [{
      requestId: 'R-1', user: '555', status: 'pending', createdAt: '2026-08-09T08:00:00.000Z',
      actionJSON: {
        action: 'sale_bundle', customer: 'ALHAJI MUSA',
        items: [{ type: 'than', packageNo: 'B', warehouse: WH, design: DESIGN, yards: 30 }],
      },
    }],
  });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });

  const types = out.movements.map((m) => m.type);
  assert.ok(types.includes('transfer_out'), 'the transfer is still a movement');

  assert.equal(out.hints.length, 1, 'exactly one candidate');
  assert.match(out.hints[0].title, /approval still pending/);
  assert.equal(out.hints[0].yards, 30);
  assert.ok(!out.hints.some((h) => /transfer/i.test(h.title) || /TRF-0088/.test(h.detail || '')),
    'an already-deducted transfer must never be offered as an explanation');
});

test('a sale logged after the count is offered, and honesty notes are emitted', async () => {
  // Same business day as the sale, but written to the sheet after the audit.
  const lateSale = {
    rowIndex: 11, timestamp: '2026-08-12T09:00:00.000Z', movedOn: '2026-08-09',
    baleNo: 'B', design: DESIGN, shade: '2', container: 'Aug26', thans: 1,
    fromState: `available @ ${WH}`, toState: `sold @ ${WH}`,
    kind: 'correction', ref: 'HAJIYA ZAINAB', user: '777', current: false,
  };
  stubAll({ takes: [AUDIT_MISMATCH], moves: [lateSale] });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });
  const late = out.hints.find((h) => /Logged after the count/.test(h.title));
  assert.ok(late, 'a movement written after the count explains a shortage');
  assert.match(late.detail, /after the auditor counted/);
});

test('no gap, no hints — and a surplus never invents candidates either', async () => {
  stubAll({
    takes: [{ ...AUDIT_MISMATCH, counted_bales: 1, counted_bundles: 3 }],  // counted MORE
  });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });
  assert.equal(out.hints.length, 0, 'a surplus is not a shortage; do not pad the list');
});

test('the payload is money-free and declares its packaging basis', async () => {
  stubAll({ takes: [AUDIT_MISMATCH] });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });
  assert.equal(out.packaging_basis, 'roster');
  const blob = JSON.stringify(out);
  assert.ok(!/₦/.test(blob), 'no naira anywhere');
  assert.ok(!/pricePerYard|amountPaid|"rate"|"value"/.test(blob), 'no money fields');
  assert.equal(out.design.category, 'CASHMERE');
});

test('an empty range keeps the balances, and since_audit opens at the last audit', async () => {
  stubAll({ takes: [AUDIT_MISMATCH] });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'since_audit', today: '2026-08-31',
  });
  assert.equal(out.range.preset, 'since_audit');
  assert.equal(out.range.from, '2026-08-10', 'opens on the day of the last audit');
  // Only the checkpoint itself falls in that window; stock has not moved since.
  assert.deepEqual(out.movements.map((m) => m.type), ['audit']);
  assert.deepEqual([out.opening.bales, out.opening.thans, out.opening.yards], [0, 1, 30]);
  assert.deepEqual(
    [out.closing.book.bales, out.closing.book.thans, out.closing.book.yards], [0, 1, 30]);
});

test('design and warehouse are required', async () => {
  stubAll();
  await assert.rejects(() => designMovementService.build({ design: '', warehouse: WH }),
    /design and warehouse are required/);
});


/* ── the defects the adversarial review found, each pinned ───────────────── */

test('a dispatched bale keeps its yardage: no zero row, no negative opening', async () => {
  // The bale's rows now read the DESTINATION warehouse — a roster counted
  // from "rows still here" would price the whole bale at nothing.
  const gone = [1, 2, 3, 4].map((n) => than('D3', n, { warehouse: 'Lagos', status: 'available' }));
  stubAll({
    inv: BASE_INV.concat(gone),
    moves: [{
      rowIndex: 5, timestamp: '2026-08-12T10:00:00.000Z', movedOn: '2026-08-12',
      baleNo: 'D3', design: DESIGN, shade: '2', container: 'Aug26', thans: 4,
      fromState: `available @ ${WH}`, toState: 'in_transit @ Lagos',
      kind: 'dispatch', ref: 'TRF-1', user: '777',
    }],
  });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });
  const trf = out.movements.find((m) => m.type === 'transfer_out');
  assert.equal(trf.qty.yards, 120, '4 thans × 30 yd, summed from the bale\'s own rows');
  assert.equal(trf.qty.yards_exact, true, 'a whole roster sums exactly — not a mean');
  assert.equal(trf.qty.label, '1B', 'the whole roster moved, so it is one bale');
  assert.ok(out.opening.yards >= 0, 'an opening balance can never be negative');
  // D3 arrived on the same GRN inside this window, so the window still opens
  // empty — the point is that its 120 yd is carried by the rows, not dropped.
  assert.equal(out.opening.yards, 0);
  const receipt = out.movements.find((m) => m.type === 'receipt');
  assert.equal(receipt.qty.yards, 270, 'A 90 + B 60 + D3 120 — the dispatched bale still counts in');
  assert.equal(out.closing.book.yards, 30, 'and the walk lands exactly on today\'s shelf');
});

test('a part-bale sale stays loose thans even after the rest is transferred away', async () => {
  // Roster must be the BALE's, not "what is still in this warehouse".
  const rest = [2, 3, 4].map((n) => than('A', n, { warehouse: 'Lagos', status: 'available' }));
  stubAll({ inv: [than('A', 1, SOLD)].concat(rest) });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });
  const sale = out.movements.find((m) => m.type === 'sale');
  assert.equal(sale.qty.label, '1t', 'one than of a four-than bale is loose, never a whole bale');
  assert.deepEqual(sale.detail.loose, [{ count: 1, yards: 30, from_bale: 'A' }]);
});

test('a sale that was later returned still shows its OUT leg', async () => {
  // An approved return clears soldTo/soldDate, erasing the sale from
  // Inventory; BaleMovements keeps it, so the ledger must not lose the leg.
  const returned = [1, 2].map((n) => than('R1', n));   // back on the shelf, no sale on file
  stubAll({
    inv: returned,
    moves: [
      { rowIndex: 3, timestamp: '2026-08-05T09:00:00.000Z', movedOn: '2026-08-05',
        baleNo: 'R1', design: DESIGN, shade: '2', container: 'Aug26', thans: 2,
        fromState: `available @ ${WH}`, toState: `sold @ ${WH}`,
        kind: 'sale', ref: 'OKESON STORES', user: '777' },
      { rowIndex: 4, timestamp: '2026-08-10T09:00:00.000Z', movedOn: '2026-08-10',
        baleNo: 'R1', design: DESIGN, shade: '2', container: 'Aug26', thans: 2,
        fromState: `sold @ ${WH}`, toState: `available @ ${WH}`,
        kind: 'return', ref: 'OKESON STORES', user: '777' },
    ],
  });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });
  const types = out.movements.map((m) => m.type);
  assert.ok(types.includes('sale'), 'the erased sale is recovered from the movement log');
  assert.ok(types.includes('return'));
  assert.ok(out.opening.yards >= 0, 'the two legs balance, so nothing goes negative');
  // Received, sold and returned all inside the window: it opens empty and
  // closes on the returned bale — which only balances because the OUT leg
  // was recovered from the movement log.
  assert.equal(out.opening.yards, 0);
  assert.equal(out.closing.book.yards, 60);
  const sale = out.movements.find((m) => m.type === 'sale');
  assert.equal(sale.qty.yards, 60, 'the recovered leg carries the bale\'s own yardage');
});

test('an opened bale the audit itself reconciled is not a gap and gets no hints', async () => {
  // book 1B + 0t vs counted 0B + 2t: the flow proved the re-label, so the
  // page must read agreed, not a red "1B + 2t short".
  stubAll({
    takes: [{
      ...AUDIT_MISMATCH, result: 'reconciled',
      sheet_bales: 1, sheet_bundles: 0, counted_bales: 0, counted_bundles: 2,
      note: 'opened-bale match: 1 bale(s) counted as pieces, all present',
    }],
  });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });
  assert.equal(out.closing.gap_direction, 'none', 'the audit judged it square');
  assert.equal(out.closing.gap_label, null);
  assert.equal(out.closing.gap_yards, 0);
  assert.equal(out.hints.length, 0);
  assert.ok(!out.notes.join(' ').includes('recount'), 'never tell the owner to recount a clean audit');
});

test('a mixed-sign gap is unreconciled, and each unit carries its own sign', async () => {
  // book 6B + 0t vs counted 5B + 4t — a bale was opened AND a piece is gone.
  stubAll({
    takes: [{
      ...AUDIT_MISMATCH, sheet_bales: 6, sheet_bundles: 0,
      counted_bales: 5, counted_bundles: 4, result: 'mismatch',
    }],
  });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });
  assert.equal(out.closing.gap_direction, 'unreconciled');
  assert.equal(out.closing.gap_label, '−1B +4t', 'one bale short, four thans over — never a sum');
});

test('a surplus is an over, not a shortage, and hunts no candidates', async () => {
  stubAll({
    takes: [{ ...AUDIT_MISMATCH, sheet_bales: 0, sheet_bundles: 1, counted_bales: 0, counted_bundles: 3 }],
    pending: [{
      requestId: 'R-9', user: '555', status: 'pending', createdAt: '2026-08-01T08:00:00.000Z',
      actionJSON: { action: 'sale_bundle', customer: 'X',
        items: [{ type: 'than', packageNo: 'B', warehouse: WH, design: DESIGN, yards: 30 }] },
    }],
  });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });
  assert.equal(out.closing.gap_direction, 'over');
  assert.equal(out.closing.gap_label, '+2t');
  assert.equal(out.hints.length, 0, 'a surplus needs no explanation for missing goods');
});

test('a queued sale of another design, or queued after the count, is never a candidate', async () => {
  stubAll({
    takes: [AUDIT_MISMATCH],
    pending: [
      { requestId: 'R-OTHER', user: '555', status: 'pending', createdAt: '2026-08-01T08:00:00.000Z',
        actionJSON: { action: 'sale_bundle', customer: 'Someone',
          items: [{ type: 'package', packageNo: 'Q9', warehouse: WH, design: '8802-A' }] } },
      { requestId: 'R-LATE', user: '555', status: 'pending', createdAt: '2026-08-28T08:00:00.000Z',
        actionJSON: { action: 'sale_bundle', customer: 'Later',
          items: [{ type: 'than', packageNo: 'B', warehouse: WH, design: DESIGN, yards: 30 }] } },
      { requestId: 'R-UNPINNABLE', user: '555', status: 'pending', createdAt: '2026-08-01T08:00:00.000Z',
        actionJSON: { action: 'sale_bundle', customer: 'Ghost', items: [{ type: 'package' }] } },
    ],
  });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'all_time', today: '2026-08-31',
  });
  assert.equal(out.hints.length, 0,
    'another design, a sale queued after the count, and an unpinnable item are all excluded');
  assert.match(out.notes.join(' '), /No candidate explains this shortage/);
});

test('a late-logged sale outside the displayed range is still found', async () => {
  // Business day before the count, written after it — the audit never saw it.
  stubAll({
    takes: [AUDIT_MISMATCH],
    moves: [{
      rowIndex: 7, timestamp: '2026-08-12T09:00:00.000Z', movedOn: '2026-08-01',
      baleNo: 'B', design: DESIGN, shade: '2', container: 'Aug26', thans: 1,
      fromState: `available @ ${WH}`, toState: 'in_transit @ Lagos',
      kind: 'dispatch', ref: 'TRF-9', user: '777',
    }],
  });
  const out = await designMovementService.build({
    design: DESIGN, warehouse: WH, range: 'since_audit', today: '2026-08-31',
  });
  assert.ok(out.movements.every((m) => m.type !== 'transfer_out'),
    'the transfer is outside the displayed window');
  assert.ok(out.hints.some((h) => /Logged after the count/.test(h.title)),
    'but the count-bounded scan still finds it, so the page never claims nothing was late');
});
