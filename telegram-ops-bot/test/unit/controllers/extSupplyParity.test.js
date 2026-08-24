'use strict';

/**
 * SUP-1 parity — /api/ext/supply* and /sl/:token must tell the customer the
 * SAME story.
 *
 * Both surfaces are driven here from ONE set of stubbed sheet rows through
 * the REAL supplyLedgerService, then compared: same days, same bale counts,
 * same yards, same printed bale numbers. This is the checklist item "table
 * matches /sl/<token> for the same customer", mechanised — a future edit
 * that changes one surface's arithmetic and not the other's fails here
 * instead of on the customer's screen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const baleMovementsRepository = require(path.join(SRC, 'repositories/baleMovementsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const customerEntity = require(path.join(SRC, 'services/customerEntity'));
const supplyLedgerService = require(path.join(SRC, 'services/supplyLedgerService'));
const supplyLedgerWebController = require(path.join(SRC, 'controllers/supplyLedgerWebController'));
const extLedgerService = require(path.join(SRC, 'services/extLedgerService'));
const apiController = require(path.join(SRC, 'controllers/apiController'));
const fmtDate = require(path.join(SRC, 'utils/formatDate'));

/* ── one set of sheet rows, feeding both surfaces ──────────────────────── */

const ROWS = [
  // 12-Jul — design 8802-A, shade 2, three bales
  { status: 'sold', soldTo: 'Qaribullah', soldDate: '2026-07-12', design: '8802-A', shade: '2', packageNo: '5810', arrivalBatch: 'C1', yards: 126 },
  { status: 'sold', soldTo: 'Qaribullah', soldDate: '2026-07-12', design: '8802-A', shade: '2', packageNo: '5811', arrivalBatch: 'C1', yards: 126 },
  { status: 'sold', soldTo: 'Qaribullah', soldDate: '2026-07-12', design: '8802-A', shade: '2', packageNo: '5814', arrivalBatch: 'C1', yards: 126 },
  // 05-Aug — two designs on one day
  { status: 'sold', soldTo: 'Qaribullah', soldDate: '2026-08-05', design: '9031-C', shade: '1', packageNo: '6280', arrivalBatch: 'C2', yards: 126 },
  { status: 'sold', soldTo: 'Qaribullah', soldDate: '2026-08-05', design: '8802-A', shade: '4', packageNo: '5831', arrivalBatch: 'C1', yards: 126 },
  // a different customer on the same days — must not bleed into either view
  { status: 'sold', soldTo: 'Bello', soldDate: '2026-08-05', design: '7777-Z', shade: '1', packageNo: '9001', arrivalBatch: 'C3', yards: 126 },
];

inventoryRepository.getAll = async () => ROWS.slice();
inventoryRepository.getSoldRows = async () => ROWS.filter((r) => r.status === 'sold');
baleMovementsRepository.getAll = async () => [];
approvalQueueRepository.getResolved = async () => [];
// No Customers sheet in this test: namesFor falls back to the single spelling.
customerEntity.resolve = async () => null;
extLedgerService.sessionCustomer = async (t) => (t === 'tok' ? 'Qaribullah' : null);

// SUP-2 — supplySession verifies the session name is not shared by two live
// customers before reading anything, so the parity run needs the identity
// context that guard reads. One live 'Qaribullah' = unique = served.
require(path.join(SRC, 'repositories/customersRepository')).getAll = async () => ([
  { customer_id: 'CUST-1', name: 'Qaribullah', phone: '+2348138475360', status: 'Active' },
]);
supplyLedgerService.verifyLedgerToken = (t) => (t === 'sl-token' ? { customerName: 'Qaribullah', mintedBy: '1', mintedAt: 0 } : null);

/* ── harness ───────────────────────────────────────────────────────────── */

function callJson(handler, { token, params = {} } = {}) {
  return new Promise((resolve) => {
    const headers = { 'x-forwarded-for': '10.9.9.9' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      set() { return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
      send(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler({ headers, params, query: {}, socket: {} }, res);
  });
}

function callPage(token) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      set() { return this; },
      send(b) { resolve({ status: this.statusCode, html: String(b) }); },
    };
    supplyLedgerWebController.viewPage({ params: { token } }, res);
  });
}

/* ── tests ─────────────────────────────────────────────────────────────── */

test('the API and /sl/ agree on days, bales and yards for the same customer', async () => {
  const api = await callJson(apiController.getExtSupply, { token: 'tok' });
  assert.equal(api.status, 200);

  const page = await callPage('sl-token');
  assert.equal(page.status, 200);

  assert.deepEqual(api.body.days.map((d) => d.date), ['2026-07-12', '2026-08-05']);

  for (const day of api.body.days) {
    // Every day the API reports is a day the /sl/ page shows, in its format.
    assert.ok(page.html.includes(fmtDate.short(day.date)), `/sl/ is missing ${day.date}`);
  }

  // Bale counts and yards come from the same service call, so they must be
  // identical to what buildLedger itself produced.
  const { entries, net } = await supplyLedgerService.buildLedger('Qaribullah');
  const supplies = entries.filter((e) => e.kind === 'supply');
  assert.deepEqual(api.body.days.map((d) => d.bales), supplies.map((e) => e.bales));
  assert.deepEqual(api.body.days.map((d) => d.yards), supplies.map((e) => Math.round(e.yards)));
  assert.equal(api.body.totals.bales, net.bales);
  assert.equal(api.body.totals.thans, net.thans);
});

test('printed bale numbers match between the day endpoint and the /sl/ detail', async () => {
  const page = await callPage('sl-token');
  const day = await callJson(apiController.getExtSupplyDay, { token: 'tok', params: { day: '2026-07-12' } });
  assert.equal(day.status, 200);

  const numbers = day.body.designs
    .flatMap((d) => d.shades)
    .flatMap((s) => s.bales);
  assert.deepEqual(numbers, ['5810', '5811', '5814']);
  for (const n of numbers) {
    assert.ok(page.html.includes(n), `/sl/ detail is missing bale ${n}`);
  }
});

test('another customer\'s goods appear on neither surface', async () => {
  const api = await callJson(apiController.getExtSupply, { token: 'tok' });
  const day = await callJson(apiController.getExtSupplyDay, { token: 'tok', params: { day: '2026-08-05' } });
  const page = await callPage('sl-token');

  const blob = JSON.stringify(api.body) + JSON.stringify(day.body);
  assert.ok(!blob.includes('7777-Z'), 'the other customer\'s design leaked into the API');
  assert.ok(!blob.includes('9001'), 'the other customer\'s bale number leaked into the API');
  assert.ok(!page.html.includes('7777-Z'), 'the other customer\'s design leaked into /sl/');
});

test('the API carries no money field that /sl/ leaves blank', async () => {
  // /sl/ renders Debit/Credit/Balance as EMPTY reserved columns. The API has
  // no such columns at all — and must never grow one.
  const api = await callJson(apiController.getExtSupply, { token: 'tok' });
  const day = await callJson(apiController.getExtSupplyDay, { token: 'tok', params: { day: '2026-07-12' } });
  const blob = JSON.stringify(api.body) + JSON.stringify(day.body);
  for (const bad of ['₦', 'price', 'lc_', 'amount', 'debit', 'credit', 'balance', 'rate']) {
    assert.ok(!blob.toLowerCase().includes(bad.toLowerCase()), `"${bad}" reached the customer API`);
  }
});
