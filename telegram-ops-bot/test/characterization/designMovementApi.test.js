'use strict';

/**
 * DML-1 — who may read the movement ledger, and what they see.
 *
 * The build spec said only "auth exactly as /ops /allocations /gantt", but
 * those three are not one policy: /allocations and /gantt are hard admin-only,
 * while the stock-takes feed admits a warehouse manager scoped to their own
 * warehouses. This ledger follows the stock-takes precedent — it is built from
 * the same StockTakes and Inventory rows a manager already sees, and it is the
 * screen that makes their own recount actionable. These tests pin that choice
 * so it cannot drift back, in either direction.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';
process.env.BOT_API_KEY = 'test-ops-key';
process.env.BASE_URL = 'https://ops.example.test';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const apiController = require(path.join(SRC, 'controllers/apiController'));
const webSessionService = require(path.join(SRC, 'services/webSessionService'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const goodsReceiptsRepository = require(path.join(SRC, 'repositories/goodsReceiptsRepository'));
const baleMovementsRepository = require(path.join(SRC, 'repositories/baleMovementsRepository'));
const stockTakesRepository = require(path.join(SRC, 'repositories/stockTakesRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));

const KANO = 'Kano office';
const LAGOS = 'Lagos';

inventoryRepository.getAll = async () => ([
  { packageNo: 'A', design: '9043-B', shade: '2', thanNo: 1, yards: 30, status: 'available',
    warehouse: KANO, soldTo: '', soldDate: '', dateReceived: '2026-08-03', arrivalBatch: 'Aug26',
    designCategory: 'CASHMERE', grnId: 'G1', baleUid: 'u1' },
  { packageNo: 'Z', design: '8802-A', shade: '1', thanNo: 1, yards: 25, status: 'available',
    warehouse: LAGOS, soldTo: '', soldDate: '', dateReceived: '2026-08-03', arrivalBatch: 'Aug26',
    designCategory: 'COTTON', grnId: 'G2', baleUid: 'u2' },
]);
goodsReceiptsRepository.getAll = async () => ([
  { grn_id: 'G1', warehouse: KANO, supplier: 'Wuse Textiles', received_at: '2026-08-03T09:20:00.000Z' },
  { grn_id: 'G2', warehouse: LAGOS, supplier: 'Wuse Textiles', received_at: '2026-08-03T09:20:00.000Z' },
]);
baleMovementsRepository.getAll = async () => [];
stockTakesRepository.getAll = async () => [];
approvalQueueRepository.getAllPending = async () => [];

/** Same shape as webLogin.test.js's helper, with a query string. */
function call(handler, headers = {}, query = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler({ headers, query }, res);
  });
}

async function sessionFor(who) {
  webSessionService._resetForTests();
  const t = webSessionService.mintLoginToken(who);
  const { sessionId } = await webSessionService.redeemLoginToken(t);
  return { cookie: `afp_session=${sessionId}` };
}
const MANAGER = { userId: '4242', name: 'Abdul', role: 'manager', departments: ['Sales'], warehouses: [KANO] };
const ADMIN = { userId: '777', name: 'Boss', role: 'admin', departments: [], warehouses: [] };

test('a warehouse manager reads their own store’s ledger', async () => {
  const cookie = await sessionFor(MANAGER);
  const r = await call(apiController.getOpsDesignMovement, cookie,
    { design: '9043-B', warehouse: KANO, range: 'all_time' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.warehouse, KANO);
  assert.equal(r.body.design.code, '9043-B');
  assert.equal(r.body.packaging_basis, 'roster');
});

test('a manager is refused another warehouse outright, never silently re-scoped', async () => {
  const cookie = await sessionFor(MANAGER);
  const r = await call(apiController.getOpsDesignMovement, cookie,
    { design: '8802-A', warehouse: LAGOS });
  assert.equal(r.status, 403, 'a deep link must never quietly show a different shelf');
  assert.match(r.body.error, /not one of your warehouses/);
});

test('an admin reads any warehouse', async () => {
  const cookie = await sessionFor(ADMIN);
  const r = await call(apiController.getOpsDesignMovement, cookie,
    { design: '8802-A', warehouse: LAGOS });
  assert.equal(r.status, 200);
  assert.equal(r.body.warehouse, LAGOS);
});

test('no design yet: the tappable lists come back, manager-scoped', async () => {
  const cookie = await sessionFor(MANAGER);
  const r = await call(apiController.getOpsDesignMovement, cookie, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.needs_design, true);
  assert.deepEqual(r.body.pickers.warehouses, [KANO], 'a manager is offered only their own stores');

  const admin = await sessionFor(ADMIN);
  const ra = await call(apiController.getOpsDesignMovement, admin, {});
  assert.deepEqual(ra.body.pickers.warehouses.sort(), [KANO, LAGOS].sort());
});

test('the design list is scoped to the chosen warehouse', async () => {
  const cookie = await sessionFor(ADMIN);
  const r = await call(apiController.getOpsDesignMovement, cookie,
    { design: '9043-B', warehouse: KANO, range: 'all_time' });
  assert.deepEqual(r.body.pickers.designs.map((d) => d.code), ['9043-B'],
    'Lagos designs are not offered while standing in Kano');
});

test('signed out gets a refusal, never a half-rendered statement', async () => {
  webSessionService._resetForTests();
  const r = await call(apiController.getOpsDesignMovement, {},
    { design: '9043-B', warehouse: KANO });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Sign in via the bot/);
});
