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
  assert.equal(net.bales, 2, 'net = supplied minus returned');
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
