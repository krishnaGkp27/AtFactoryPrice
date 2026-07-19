'use strict';

/**
 * WEB-2 — Ops Dashboard API: key gating, response shapes, and the
 * one-broken-sheet-doesn't-blank-the-dashboard section isolation.
 */

process.env.BOT_API_KEY = 'test-ops-key';
process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const customerNotesRepository = require(path.join(SRC, 'repositories/customerNotesRepository'));
const samplesRepository = require(path.join(SRC, 'repositories/samplesRepository'));
const ordersRepository = require(path.join(SRC, 'repositories/ordersRepository'));
const stockTakesRepository = require(path.join(SRC, 'repositories/stockTakesRepository'));
const attendanceService = require(path.join(SRC, 'services/attendanceService'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const apiController = require(path.join(SRC, 'controllers/apiController'));

const NOW = new Date().toISOString();
approvalQueueRepository.getAllPending = async () => [
  { requestId: 'R1', user: '4242', actionJSON: { action: 'sale_bundle' }, createdAt: NOW },
];
customerNotesRepository.getAll = async () => [{ note_id: 'N1', created_at: NOW }];
samplesRepository.getAll = async () => [{ sample_id: 'S1', status: 'with_customer' }];
ordersRepository.getAll = async () => [{ order_id: 'O1', status: 'pending' }];
stockTakesRepository.getAll = async () => [
  { stocktake_id: 'ST1', warehouse: 'IDUMOTA', design: '9032', result: 'flagged', sheet_bales: 1, sheet_bundles: 0, counted_bales: 3, counted_bundles: 0, auditor: '4242', audited_at: NOW },
];
attendanceService.getAudience = async () => [{ user_id: '4242', name: 'Yarima' }, { user_id: '5555', name: 'Abdul' }];
attendanceService.getTodayAll = async () => ({ date: NOW.slice(0, 10), rows: [{ telegram_id: '4242', location: 'Kano Office', logged_at: NOW, logged_via: 'self' }] });
approvalCards.resolveUserLabel = async (id) => `U${id}`;

function call(handler, headers = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler({ headers, query: {} }, res);
  });
}

test('all four endpoints reject a missing/wrong key', async () => {
  for (const h of [apiController.getOpsOverview, apiController.getOpsApprovals, apiController.getOpsAttendance, apiController.getOpsStockTakes]) {
    const noKey = await call(h);
    assert.equal(noKey.status, 403);
    const badKey = await call(h, { 'x-api-key': 'wrong' });
    assert.equal(badKey.status, 403);
  }
});

test('overview aggregates every section; a broken sheet degrades only its own tile', async () => {
  const ok = await call(apiController.getOpsOverview, { 'x-api-key': 'test-ops-key' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.approvals.pending, 1);
  assert.deepEqual(ok.body.attendance, { required: 2, marked: 1 });
  assert.equal(ok.body.audits.openFlags, 1);
  assert.equal(ok.body.samples.out, 1);
  // Break one repo — the rest of the dashboard must survive.
  ordersRepository.getAll = async () => { throw new Error('orders sheet down'); };
  const degraded = await call(apiController.getOpsOverview, { 'x-api-key': 'test-ops-key' });
  assert.equal(degraded.status, 200);
  assert.match(degraded.body.orders.error, /orders sheet down/);
  assert.equal(degraded.body.approvals.pending, 1, 'other sections intact');
  ordersRepository.getAll = async () => [{ order_id: 'O1', status: 'pending' }];
});

test('approvals + attendance + stocktakes shapes are dashboard-ready', async () => {
  const appr = await call(apiController.getOpsApprovals, { 'x-api-key': 'test-ops-key' });
  assert.equal(appr.body.total, 1);
  assert.equal(appr.body.rows[0].requester, 'U4242', 'names, not raw ids');
  assert.equal(appr.body.rows[0].ageDays, 0);

  const att = await call(apiController.getOpsAttendance, { 'x-api-key': 'test-ops-key' });
  assert.equal(att.body.marked.length, 1);
  assert.equal(att.body.marked[0].location, 'Kano Office');
  assert.deepEqual(att.body.missing, [{ name: 'Abdul' }]);

  const aud = await call(apiController.getOpsStockTakes, { 'x-api-key': 'test-ops-key' });
  assert.equal(aud.body.rows[0].result, 'flagged');
  assert.equal(aud.body.rows[0].counted, '3+0');
  assert.equal(aud.body.rows[0].book, '1+0');
});
