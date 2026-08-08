'use strict';

/**
 * APC-1 Phase C — the transfer dispatcher chain under concurrency.
 *
 * The per-user session holds PHYSICAL work (ticked bales, an armed photo
 * gate). Pinned:
 *  - a second ✅ Accept mid-pick does NOT silently wipe the first
 *    transfer's picks — it offers ▶ Continue / 🗑 Drop, and only the
 *    explicit drop switches;
 *  - a leftover picker card from an earlier/replaced dispatch cannot tick
 *    bales into the current one (chips fire only from the session's own
 *    anchored card);
 *  - ↩ Not now on ANOTHER transfer's card never kills the live photo gate.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = 'abdul,musa,4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, lastKb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const designAssetsRepo = require(path.join(SRC, 'repositories/designAssetsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
designAssetsRepo.findActive = async () => null;
auditLogRepository.append = async () => {};
transactionsRepository.append = async () => {};
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
];
usersRepository.findByUserId = async (id) => ({ user_id: id, name: id === 'abdul' ? 'Abdul' : 'Musa' });

let _rowSeq = 1;
function invRow(pkg, status = 'available', wh = 'Lagos') {
  _rowSeq += 1;
  return { rowIndex: _rowSeq, baleUid: `U-${pkg}`, packageNo: pkg, design: '9006', shade: '3', warehouse: wh, status, productType: 'fabric', yards: 100, pricePerYard: 0 };
}
const invStore = [invRow('P1'), invRow('P2'), invRow('P3'), invRow('P4'), invRow('P9', 'available', 'Kano office')];
inventoryRepository.getAll = async () => JSON.parse(JSON.stringify(invStore));
inventoryRepository.ensureRowUids = async (rows) => new Map(rows.map((r) => [r.rowIndex, r.baleUid]));
inventoryRepository.transitionBales = async () => [];

// Multi-row queue — TWO transfers must exist at once for these tests.
const qRows = new Map();
approvalQueueRepository.append = async (rec) => { qRows.set(rec.requestId, { ...rec, status: 'pending' }); return rec; };
approvalQueueRepository.getByRequestId = async (id) => {
  const r = qRows.get(String(id)); return r ? JSON.parse(JSON.stringify(r)) : null;
};
approvalQueueRepository.getAllPending = async () => [...qRows.values()]
  .filter((r) => r.status === 'pending').map((r) => JSON.parse(JSON.stringify(r)));
approvalQueueRepository.updateStatus = async (id, status) => { qRows.get(String(id)).status = status; return true; };
approvalQueueRepository.updateActionJSON = async (id, patch) => {
  const r = qRows.get(String(id)); r.actionJSON = { ...r.actionJSON, ...patch }; return true;
};

/** Admin builds a 2-bale Lagos → Kano office order; returns its requestId. */
async function makeOrder() {
  sessionStore.clear('777');
  const bot = createFakeBot();
  const before = new Set(qRows.keys());
  await controller.handleCallbackQuery(bot, cb('act:transfer_stock', 777));
  await controller.handleCallbackQuery(bot, cb('trf:wh:1', 777));
  await controller.handleCallbackQuery(bot, cb('trf:dg:0', 777));
  await controller.handleCallbackQuery(bot, cb('trf:sh:0', 777));
  await controller.handleCallbackQuery(bot, cb('trf:qty:2', 777));
  await controller.handleCallbackQuery(bot, cb('trf:dest:0', 777));
  await controller.handleCallbackQuery(bot, cb('trf:send', 777));
  const rid = [...qRows.keys()].find((k) => !before.has(k));
  assert.ok(rid, 'order queued');
  return rid;
}

test('a second Accept mid-pick offers Continue / Drop — never a silent wipe', async () => {
  const t1 = await makeOrder();
  const t2 = await makeOrder();
  sessionStore.clear('abdul');

  const b1 = createFakeBot();
  await controller.handleCallbackQuery(b1, cb(`trf:acc:${t1}`, 'abdul', 51));
  await controller.handleCallbackQuery(b1, cb('trf:bl:t:0', 'abdul', 51)); // tick P1
  let s = sessionStore.get('abdul');
  assert.equal(s.requestId, t1);
  assert.deepEqual(s.pl[0].sel, ['P1'], 'one bale ticked on transfer 1');

  // ✅ Accept on transfer 2 while transfer 1's pick is live.
  const b2 = createFakeBot();
  await controller.handleCallbackQuery(b2, cb(`trf:acc:${t2}`, 'abdul', 52));
  s = sessionStore.get('abdul');
  assert.equal(s.requestId, t1, 'the live session is UNTOUCHED');
  assert.deepEqual(s.pl[0].sel, ['P1'], 'the tick survived');
  const kb = lastKb(b2);
  assert.ok(kb.some((b) => b.callback_data === `trf:sw:keep:${t1}`), 'Continue offered');
  assert.ok(kb.some((b) => b.callback_data === `trf:sw:go:acc:${t2}`), 'explicit Drop offered');

  // ▶ Continue → transfer 1's picker again, still its session.
  const b3 = createFakeBot();
  await controller.handleCallbackQuery(b3, cb(`trf:sw:keep:${t1}`, 'abdul', 60));
  assert.equal(sessionStore.get('abdul').requestId, t1);
  assert.match(b3.allText(), /line 1 of/, 'picker re-rendered');

  // 🗑 Drop → the switch is explicit; transfer 2 starts clean.
  const b4 = createFakeBot();
  await controller.handleCallbackQuery(b4, cb(`trf:sw:go:acc:${t2}`, 'abdul', 61));
  s = sessionStore.get('abdul');
  assert.equal(s.requestId, t2, 'now on transfer 2');
  assert.deepEqual(s.pl[0].sel, [], 'transfer 2 starts unticked (TRF-15)');
  sessionStore.clear('abdul');
});

test('a stale picker card cannot tick bales into the current dispatch', async () => {
  const t1 = await makeOrder();
  sessionStore.clear('abdul');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${t1}`, 'abdul', 70));
  const anchor = sessionStore.get('abdul').flowMessageId;
  assert.equal(anchor, 70, 'picker anchored on the tapped card');

  // A leftover card from an older dispatch (different message id) taps a chip.
  const bStale = createFakeBot();
  await controller.handleCallbackQuery(bStale, cb('trf:bl:t:0', 'abdul', 33));
  assert.deepEqual(sessionStore.get('abdul').pl[0].sel, [], 'stale card ticked NOTHING');
  assert.match(bStale.allText(), /belongs to an earlier step/, 'and says why');

  // The session's own card still works.
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:0', 'abdul', anchor));
  assert.deepEqual(sessionStore.get('abdul').pl[0].sel, ['P1']);
  sessionStore.clear('abdul');
});

test("↩ Not now on ANOTHER transfer's card never kills the live photo gate", async () => {
  const t1 = await makeOrder();
  const t2 = await makeOrder();
  sessionStore.clear('abdul');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${t1}`, 'abdul', 80));
  const mid = () => sessionStore.get('abdul').flowMessageId;
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:0', 'abdul', mid()));
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:1', 'abdul', mid()));
  await controller.handleCallbackQuery(bot, cb('trf:bl:nx', 'abdul', mid()));
  await controller.handleCallbackQuery(bot, cb('trf:bl:go', 'abdul', mid()));
  let s = sessionStore.get('abdul');
  assert.equal(s.step, 'await_doc', 'photo gate armed for transfer 1');

  // Stale ↩ Not now carrying transfer 2's id — must not stand down T1's gate.
  await controller.handleCallbackQuery(createFakeBot(), cb(`trf:nn:${t2}`, 'abdul', 81));
  s = sessionStore.get('abdul');
  assert.ok(s && s.step === 'await_doc' && String(s.requestId) === String(t1),
    "transfer 1's gate survives a stale Not-now from another card");

  // The gate's own Not now stands it down.
  await controller.handleCallbackQuery(createFakeBot(), cb(`trf:nn:${t1}`, 'abdul', mid()));
  assert.ok(!sessionStore.get('abdul'), 'own Not-now clears the gate');
});
