'use strict';

/**
 * SLG-1 — the per-customer Supply Ledger (owner's hand-drawn format,
 * 06/07-Aug-2026). Locked decisions pinned here:
 *   - goods only, derived at read time from Inventory (+ movement log);
 *   - credits come ONLY from `return` transitions — the approved executors
 *     are the only writers of those;
 *   - option B: the web face renders Debit/Credit/Balance EMPTY with a
 *     reserved blank row after each entry, and not one naira anywhere;
 *   - a share-link token can never open a ledger page (k:'SL' isolation).
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const baleMovementsRepository = require(path.join(SRC, 'repositories/baleMovementsRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const svc = require(path.join(SRC, 'services/supplyLedgerService'));
const shareLinkService = require(path.join(SRC, 'services/shareLinkService'));

customersRepository.getAll = async () => [
  { customer_id: 'CUST-X', name: 'Chief OKSON', status: 'Active', aliases: [] },
];

function soldRow(pkg, design, shade, day, yards = 150) {
  return {
    packageNo: pkg, design, shade, status: 'sold', soldTo: 'Chief OKSON',
    soldDate: day, yards, warehouse: 'IDUMOTA', thanNo: 1,
  };
}

test('supplies group per day from Inventory sold rows; returns come from the movement log', async () => {
  // The returned bale's own rows must exist for the whole/loose roster —
  // after a return they are back as `available`, which is the real state.
  inventoryRepository.getAll = async () => [
    ...[1, 2, 3, 4].map((thanNo) => ({
      packageNo: '869', design: '9060-A', shade: '01', thanNo, yards: 0,
      status: 'available', warehouse: 'IDUMOTA', arrivalBatch: 'Jul26',
    })),
    soldRow('869', '9060-A', '01', '2026-08-04'),
    soldRow('843', '9060-A', '01', '2026-08-04'),
    soldRow('903', '9037-D', '12', '2026-08-06'),
  ];
  inventoryRepository.getSoldRows = async () => [
    soldRow('869', '9060-A', '01', '2026-08-04'),
    soldRow('843', '9060-A', '01', '2026-08-04'),
    soldRow('903', '9037-D', '12', '2026-08-06'),
  ];
  baleMovementsRepository.getAll = async () => [
    { kind: 'return', ref: 'Chief OKSON', movedOn: '2026-08-05', design: '9060-A', baleNo: '869', container: 'Jul26', thans: 4 },
    { kind: 'dispatch', ref: 'TR-1', movedOn: '2026-08-05', design: 'X', baleNo: '1', container: '', thans: 4 },
    { kind: 'return', ref: 'Somebody Else', movedOn: '2026-08-05', design: 'Y', baleNo: '2', container: '', thans: 1 },
  ];
  const { entries, net } = await svc.buildLedger('Chief OKSON');
  assert.deepEqual(entries.map((e) => [e.day, e.kind, e.bales]), [
    ['2026-08-04', 'supply', 2],
    ['2026-08-05', 'return', 1],
    ['2026-08-06', 'supply', 1],
  ], 'chronological, other customers and non-return moves excluded');
  assert.match(entries[0].label, /2 Bales \(300 yards\)/);
  // Net is counted in THANS (bale counts are not summable across days).
  // 3 thans supplied, 4 returned → the customer holds -1 than net here
  // because the fixture's return is larger than its supply; what matters is
  // that the RETURN IS COUNTED ONCE, not twice (see the dedicated test).
  assert.equal(typeof net.thans, 'number');
});

test('day detail groups design → shade → printed numbers (the SBL-2 grammar)', async () => {
  inventoryRepository.getSoldRows = async () => [
    soldRow('869', '9060-A', '01', '2026-08-04'),
    soldRow('843', '9060-A', '01', '2026-08-04'),
    soldRow('903', '9037-D', '12', '2026-08-04'),
    soldRow('999', '9037-D', '12', '2026-08-05'), // other day — excluded
  ];
  const det = await svc.dayDetail('Chief OKSON', '2026-08-04');
  const d9060 = det.find((d) => d.design === '9060-A');
  assert.deepEqual(d9060.shades[0].bales, ['869', '843']);
  assert.equal(det.find((d) => d.design === '9037-D').shades[0].bales.length, 1);
  assert.ok(!JSON.stringify(det).includes('999'));
});

test('ledger tokens verify, tamper 404s, and a DESIGN share token is refused', () => {
  const tok = svc.mintLedgerToken('Chief OKSON', '777');
  const p = svc.verifyLedgerToken(tok);
  assert.equal(p.customerName, 'Chief OKSON');
  assert.equal(svc.verifyLedgerToken(`${tok}x`), null, 'tampered signature dies');
  // The isolation that matters: a legit SHR-1 catalogue token must not open
  // a ledger — same signer, different kind.
  const shareTok = shareLinkService.mintToken({ design: '9060-A', customerId: 'CUST-X', mintedBy: '777' });
  assert.equal(svc.verifyLedgerToken(shareTok), null, 'share token refused by the ledger door');
});

test('the web page renders option B: empty money columns, reserved rows, no naira', async () => {
  inventoryRepository.getSoldRows = async () => [soldRow('869', '9060-A', '01', '2026-08-04')];
  baleMovementsRepository.getAll = async () => [];
  const webController = require(path.join(SRC, 'controllers/supplyLedgerWebController'));
  const tok = svc.mintLedgerToken('Chief OKSON', '777');
  let html = ''; let status = 200;
  const res = {
    set: () => {}, send: (b) => { html = String(b); },
    status: (c) => { status = c; return res; },
  };
  await webController.viewPage({ params: { token: tok } }, res);
  assert.equal(status, 200);
  assert.match(html, /SUPPLY LEDGER/);
  assert.match(html, /CHIEF OKSON/);
  assert.match(html, /<th>Debit<\/th><th>Credit<\/th><th>Balance<\/th>/, 'the classic columns exist');
  assert.match(html, /1 Bale \(150 yards\)/, 'particular carries the goods');
  assert.ok(!/₦|NGN|naira/i.test(html), 'not one naira on the page');
  assert.match(html, /class="reserved"/, 'blank payment row reserved after the entry');
  assert.match(html, /869/, 'printed numbers in the expandable detail');
  assert.match(html, /finance portal/, 'the columns say who fills them');

  // Bad token: plain 404, no hints.
  let s2 = 200; const res2 = { set: () => {}, send: () => {}, status: (c) => { s2 = c; return res2; } };
  await webController.viewPage({ params: { token: 'garbage.token' } }, res2);
  assert.equal(s2, 404);
});

test('§6c — the quantity comes from the TV-8 engine, never a hardcoded bale count', async () => {
  // Kano office is a than-visibility warehouse by default, AND this customer
  // took only 2 of the bale's 4 thans. Both reasons say "thans"; a hardcoded
  // bale count would read "1 Bale" here while Customer Supplies read "2t" —
  // exactly the cross-surface disagreement the owner forbade.
  const bale = (thanNo, sold) => ({
    packageNo: '869', design: '9060-A', shade: '01', thanNo, yards: 50,
    status: sold ? 'sold' : 'available', soldTo: sold ? 'Chief OKSON' : '',
    soldDate: sold ? '2026-08-04' : '', warehouse: 'Kano office', arrivalBatch: 'Jul26',
  });
  const all = [bale(1, true), bale(2, true), bale(3, false), bale(4, false)];
  inventoryRepository.getAll = async () => all;
  inventoryRepository.getSoldRows = async () => all.filter((r) => r.status === 'sold');
  baleMovementsRepository.getAll = async () => [];

  const { entries } = await svc.buildLedger('Chief OKSON');
  assert.equal(entries.length, 1);
  assert.match(entries[0].qty, /2 thans/, `part-taken bale must read in thans, got: ${entries[0].qty}`);
  assert.ok(!/1 Bale/.test(entries[0].label), 'must NOT claim a whole bale');
  assert.match(entries[0].label, /100 yards/, 'yards still ride alongside');
});

test('§6c — a whole bale still reads in bales, in the owner’s phrasing', async () => {
  const bale = (thanNo) => ({
    packageNo: '869', design: '9060-A', shade: '01', thanNo, yards: 50,
    status: 'sold', soldTo: 'Chief OKSON', soldDate: '2026-08-04',
    warehouse: 'IDUMOTA', arrivalBatch: 'Jul26',
  });
  const all = [bale(1), bale(2)];
  inventoryRepository.getAll = async () => all;
  inventoryRepository.getSoldRows = async () => all;
  baleMovementsRepository.getAll = async () => [];
  const { entries } = await svc.buildLedger('Chief OKSON');
  assert.match(entries[0].label, /^1 Bale \(100 yards\)$/, `got: ${entries[0].label}`);
});

test('a partial return reads in thans, a whole-bale return in bales', async () => {
  const rows = [1, 2, 3, 4].map((thanNo) => ({
    packageNo: '869', design: '9060-A', shade: '01', thanNo, yards: 50,
    status: 'available', warehouse: 'IDUMOTA', arrivalBatch: 'Jul26',
  }));
  inventoryRepository.getAll = async () => rows;
  inventoryRepository.getSoldRows = async () => [];
  baleMovementsRepository.getAll = async () => [
    { kind: 'return', ref: 'Chief OKSON', movedOn: '2026-08-05', design: '9060-A', baleNo: '869', container: 'Jul26', thans: 2 },
    { kind: 'return', ref: 'Chief OKSON', movedOn: '2026-08-06', design: '9060-A', baleNo: '869', container: 'Jul26', thans: 4 },
  ];
  const { entries } = await svc.buildLedger('Chief OKSON');
  assert.match(entries[0].label, /Return — 2 thans/, `partial, got: ${entries[0].label}`);
  assert.match(entries[1].label, /Return — 1 Bale/, `whole, got: ${entries[1].label}`);
});

test('a returned supply keeps its own debit row — the return is counted ONCE', async () => {
  // The bug this pins: an approved return flips the Inventory rows back to
  // `available` and clears SoldTo, so the original supply VANISHED from the
  // debit side while its credit remained — the return was subtracted twice
  // and the net went negative. The debit is now reconstructed from the
  // movement log's own sale row.
  const rows = [1, 2].map((thanNo) => ({
    packageNo: '869', design: '9060-A', shade: '01', thanNo, yards: 50,
    status: 'available', warehouse: 'IDUMOTA', arrivalBatch: 'Jul26', // returned: no longer sold
  }));
  inventoryRepository.getAll = async () => rows;
  inventoryRepository.getSoldRows = async () => [];   // Inventory has forgotten the sale
  baleMovementsRepository.getAll = async () => [
    { kind: 'sale', ref: 'Chief OKSON', movedOn: '2026-08-04', design: '9060-A', baleNo: '869', container: 'Jul26', thans: 2 },
    { kind: 'return', ref: 'Chief OKSON', movedOn: '2026-08-05', design: '9060-A', baleNo: '869', container: 'Jul26', thans: 2 },
  ];
  const { entries, net } = await svc.buildLedger('Chief OKSON');
  assert.equal(entries.length, 2, 'both the supply and the return are on the ledger');
  assert.equal(entries[0].kind, 'supply');
  assert.equal(entries[1].kind, 'return');
  assert.equal(net.thans, 0, 'supplied 2, returned 2 — the customer holds nothing, not minus two');
});

test('a bale supplied across two days is not counted twice in the net', async () => {
  const mk = (thanNo, day) => ({
    packageNo: '869', design: '9060-A', shade: '01', thanNo, yards: 50,
    status: 'sold', soldTo: 'Chief OKSON', soldDate: day,
    warehouse: 'IDUMOTA', arrivalBatch: 'Jul26',
  });
  const all = [mk(1, '2026-08-04'), mk(2, '2026-08-05')];
  inventoryRepository.getAll = async () => all;
  inventoryRepository.getSoldRows = async () => all;
  baleMovementsRepository.getAll = async () => [];
  const { entries, net } = await svc.buildLedger('Chief OKSON');
  assert.equal(entries.length, 2, 'one row per day');
  assert.equal(net.thans, 2, 'two thans, not "2 bales"');
  assert.equal(net.bales, 1, 'ONE physical bale is held, despite two day-rows');
});

test('the same printed number in two containers stays two bales (§1/§5)', async () => {
  const mk = (batch, thanNo) => ({
    packageNo: '869', design: '9060-A', shade: '01', thanNo, yards: 50,
    status: 'sold', soldTo: 'Chief OKSON', soldDate: '2026-08-04',
    warehouse: 'IDUMOTA', arrivalBatch: batch,
  });
  const all = [mk('Jul26', 1), mk('Aug26', 1)];
  inventoryRepository.getAll = async () => all;
  inventoryRepository.getSoldRows = async () => all;
  baleMovementsRepository.getAll = async () => [];
  const { net } = await svc.buildLedger('Chief OKSON');
  assert.equal(net.bales, 2, 'a re-used printed number must not collapse two physical bales');
});

test('the web page emits ABSOLUTE doc links carrying the token', async () => {
  const mk = (thanNo) => ({
    packageNo: '869', design: '9060-A', shade: '01', thanNo, yards: 50,
    status: 'sold', soldTo: 'Chief OKSON', soldDate: '2026-08-04',
    warehouse: 'IDUMOTA', arrivalBatch: 'Jul26',
  });
  inventoryRepository.getAll = async () => [mk(1)];
  inventoryRepository.getSoldRows = async () => [mk(1)];
  baleMovementsRepository.getAll = async () => [];
  const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
  approvalQueueRepository.getResolved = async () => [
    { status: 'approved', actionJSON: { customer: 'Chief OKSON', salesDate: '2026-08-04', sale_doc_file_id: 'F1', action: 'sale_bundle' } },
  ];
  const webController = require(path.join(SRC, 'controllers/supplyLedgerWebController'));
  const tok = svc.mintLedgerToken('Chief OKSON', '777');
  let html = '';
  const res = { set: () => {}, send: (b) => { html = String(b); }, status: () => res };
  await webController.viewPage({ params: { token: tok } }, res);
  assert.match(html, new RegExp(`href="/sl/${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/doc/2026-08-04/0"`),
    'absolute, token-carrying href — a relative one 404s');
  assert.ok(!/href="doc\//.test(html), 'no relative doc href survives');
});

/* ── RET-2: a correction is not a return ───────────────────────────────── */

test('a corrected sale leaves the ledger entirely — no phantom debit, no credit', async () => {
  // `/revert_packages` un-does a MIS-ENTERED sale: no approval, no goods
  // came back. Before RET-2 it wrote kind:'return', so the customer's ledger
  // showed a Return they never made. Erasing only the credit is not enough
  // either — the movement log's own sale row would then re-appear as a
  // standing debit for goods the customer never took.
  const rows = [1, 2].map((thanNo) => ({
    packageNo: '869', design: '9060-A', shade: '01', thanNo, yards: 50,
    status: 'available', warehouse: 'IDUMOTA', arrivalBatch: 'Jul26',
  }));
  inventoryRepository.getAll = async () => rows;
  inventoryRepository.getSoldRows = async () => [];
  baleMovementsRepository.getAll = async () => [
    { kind: 'sale', ref: 'Chief OKSON', movedOn: '2026-08-04', design: '9060-A', baleNo: '869', container: 'Jul26', thans: 2 },
    { kind: 'correction', ref: 'Chief OKSON', movedOn: '2026-08-05', design: '9060-A', baleNo: '869', container: 'Jul26', thans: 2 },
  ];
  const { entries, net } = await svc.buildLedger('Chief OKSON');
  assert.deepEqual(entries, [], 'the mis-entered sale never happened');
  assert.equal(net.thans, 0);
});

test('a correction erases only ITS OWN sale, not a later genuine one', async () => {
  const sold = {
    packageNo: '869', design: '9060-A', shade: '01', thanNo: 1, yards: 50,
    status: 'sold', soldTo: 'Chief OKSON', soldDate: '2026-08-09',
    warehouse: 'IDUMOTA', arrivalBatch: 'Jul26',
  };
  inventoryRepository.getAll = async () => [sold];
  inventoryRepository.getSoldRows = async () => [sold];
  baleMovementsRepository.getAll = async () => [
    { kind: 'sale', ref: 'Chief OKSON', movedOn: '2026-08-04', design: '9060-A', baleNo: '869', container: 'Jul26', thans: 1 },
    { kind: 'correction', ref: 'Chief OKSON', movedOn: '2026-08-05', design: '9060-A', baleNo: '869', container: 'Jul26', thans: 1 },
    { kind: 'sale', ref: 'Chief OKSON', movedOn: '2026-08-09', design: '9060-A', baleNo: '869', container: 'Jul26', thans: 1 },
  ];
  const { entries, net } = await svc.buildLedger('Chief OKSON');
  assert.deepEqual(entries.map((e) => [e.day, e.kind]), [['2026-08-09', 'supply']],
    'the 04-Aug entry is erased; the 09-Aug re-sale stands');
  assert.equal(net.thans, 1);
});

test('an APPROVED return is still a credit — corrections do not swallow it', async () => {
  const rows = [1, 2].map((thanNo) => ({
    packageNo: '869', design: '9060-A', shade: '01', thanNo, yards: 50,
    status: 'available', warehouse: 'IDUMOTA', arrivalBatch: 'Jul26',
  }));
  inventoryRepository.getAll = async () => rows;
  inventoryRepository.getSoldRows = async () => [];
  baleMovementsRepository.getAll = async () => [
    { kind: 'sale', ref: 'Chief OKSON', movedOn: '2026-08-04', design: '9060-A', baleNo: '869', container: 'Jul26', thans: 2 },
    { kind: 'return', ref: 'Chief OKSON', movedOn: '2026-08-05', design: '9060-A', baleNo: '869', container: 'Jul26', thans: 2 },
  ];
  const { entries } = await svc.buildLedger('Chief OKSON');
  assert.deepEqual(entries.map((e) => e.kind), ['supply', 'return']);
});
