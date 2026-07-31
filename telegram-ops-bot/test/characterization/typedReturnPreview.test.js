'use strict';

/**
 * RET-1 — typed returns preview before queueing, and the belongs-to check:
 *
 *   "Return Bale P1"            → confirm card naming the BUYER; nothing
 *                                 queues until ✅ (rtx:ok)
 *   "Return Bale P1 from <X>"   → blocked outright when X is not the buyer
 *   wrong / unsold bale numbers → immediate explanation, no card
 *
 * The approval card (buildReturnCard) also names the buyer — the signing
 * admins' safety net against a mistyped bale number.
 */

process.env.ADMIN_IDS = '777,888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

const INV_HEADERS = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];

/** Inventory row: pkg, than, status, soldTo. Design 9006, 60 yds each. */
function invRow(pkg, than, status, soldTo) {
  return [pkg, '', '', '9006', '1', than, '60', status, 'Kano office', '0', '2026-07-01',
    soldTo, soldTo ? '2026-07-30' : '', '', '', '', 'fabric', `UID-${pkg}-${than}`, '2026-07-01', '', '', '', ''];
}

const CUS_HEADERS = ['customer_id', 'name', 'phone', 'address', 'category',
  'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status',
  'created_at', 'updated_at', 'aliases'];

const fakeSheets = createFakeSheets({
  Inventory: [
    INV_HEADERS,
    invRow('P1', '1', 'sold', 'Benduku'),
    invRow('P1', '2', 'sold', 'Benduku'),
    invRow('P2', '1', 'available', ''),
    invRow('P3', '1', 'sold', 'Benduku'),
    invRow('P3', '2', 'sold', 'Alhaji Musa'),
  ],
  Customers: [
    CUS_HEADERS,
    ['CUS-B', 'Benduku', '080', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
    ['CUS-A', 'Alhaji Musa', '081', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
  ],
});
installFakeSheets(fakeSheets);

let intentResult = { action: 'unknown', confidence: 0 };
installFakeIntent(() => intentResult);

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}`, role: 'admin' });
auditLogRepository.append = async () => {};

const ADMIN = '777';
function message(text) {
  return { chat: { id: ADMIN }, from: { id: ADMIN, first_name: 'Test' }, text };
}

function armQueue() {
  const calls = { appended: [] };
  approvalQueueRepository.append = async (row) => { calls.appended.push(row); };
  return calls;
}

test('typed return shows the preview with the buyer and queues NOTHING yet', async () => {
  const bot = createFakeBot();
  const q = armQueue();
  sessionStore.clear(ADMIN);
  intentResult = { action: 'return_package', packageNo: 'P1', customer: null, confidence: 0.95 };
  await controller.handleMessage(bot, message('Return Bale P1'));

  assert.equal(q.appended.length, 0, 'no approval queued before confirm');
  assert.match(bot.allText(), /Sold to: \*Benduku\*/, 'preview names the buyer');
  assert.match(bot.allText(), /2 sold thans/, 'preview counts what reverses');
  const s = sessionStore.get(ADMIN);
  assert.equal(s && s.type, 'return_confirm_flow');
});

test('rtx:ok on the LIVE card queues the approval with the buyer stamped; a second tap cannot double-queue', async () => {
  const bot = createFakeBot();
  const q = armQueue();
  const cardId = sessionStore.get(ADMIN).flowMessageId;
  await controller.handleCallbackQuery(bot, cb('rtx:ok', ADMIN, cardId));

  assert.equal(q.appended.length, 1, 'one approval queued on confirm');
  const aj = q.appended[0].actionJSON;
  assert.equal(aj.action, 'return_package');
  assert.equal(aj.packageNo, 'P1');
  assert.equal(aj.soldTo, 'Benduku');
  assert.equal(aj.customerId, 'CUS-B');
  assert.equal(sessionStore.get(ADMIN), null, 'session cleared');

  // Double-tap: the second tap finds no session and must not re-queue.
  await controller.handleCallbackQuery(bot, cb('rtx:ok', ADMIN, cardId));
  assert.equal(q.appended.length, 1, 'still exactly one approval');
});

test('a stale preview card cannot queue a DIFFERENT bale than it shows', async () => {
  const bot = createFakeBot();
  const q = armQueue();
  sessionStore.clear(ADMIN);
  intentResult = { action: 'return_package', packageNo: 'P1', customer: null, confidence: 0.95 };
  await controller.handleMessage(bot, message('Return Bale P1'));
  const cardA = sessionStore.get(ADMIN).flowMessageId;
  intentResult = { action: 'return_than', packageNo: 'P3', thanNo: 1, customer: null, confidence: 0.95 };
  await controller.handleMessage(bot, message('Return than 1 from Bale P3'));
  const cardB = sessionStore.get(ADMIN).flowMessageId;
  assert.notEqual(cardA, cardB, 'two distinct preview cards');

  await controller.handleCallbackQuery(bot, cb('rtx:ok', ADMIN, cardA));
  assert.equal(q.appended.length, 0, 'the superseded card queues NOTHING');
  assert.match(bot.allText(), /expired or was replaced/i);

  await controller.handleCallbackQuery(bot, cb('rtx:ok', ADMIN, cardB));
  assert.equal(q.appended.length, 1, 'the live card queues its own bale');
  assert.equal(q.appended[0].actionJSON.packageNo, 'P3');
});

test('whole-bale return of a MULTI-buyer bale is refused (per-than instead)', async () => {
  const bot = createFakeBot();
  const q = armQueue();
  sessionStore.clear(ADMIN);
  intentResult = { action: 'return_package', packageNo: 'P3', customer: null, confidence: 0.95 };
  await controller.handleMessage(bot, message('Return Bale P3'));
  assert.equal(q.appended.length, 0, 'nothing queued');
  assert.match(bot.allText(), /more than one buyer/i);
  assert.match(bot.allText(), /than by than/i);
  assert.equal(sessionStore.get(ADMIN), null, 'no confirm session');
});

test('belongs-to check: naming the WRONG customer blocks before any card', async () => {
  const bot = createFakeBot();
  const q = armQueue();
  sessionStore.clear(ADMIN);
  intentResult = { action: 'return_package', packageNo: 'P1', customer: 'Alhaji Musa', confidence: 0.95 };
  await controller.handleMessage(bot, message('Return Bale P1 from Alhaji Musa'));

  assert.equal(q.appended.length, 0, 'nothing queued');
  assert.match(bot.allText(), /NOT sold to Alhaji Musa/, 'mismatch is stated plainly');
  assert.match(bot.allText(), /Benduku/, 'the real buyer is named');
  assert.equal(sessionStore.get(ADMIN), null, 'no confirm session created');
});

test('naming the RIGHT customer passes through to the preview', async () => {
  const bot = createFakeBot();
  sessionStore.clear(ADMIN);
  intentResult = { action: 'return_package', packageNo: 'P1', customer: 'Benduku', confidence: 0.95 };
  await controller.handleMessage(bot, message('Return Bale P1 from Benduku'));
  assert.match(bot.allText(), /Confirm Return/, 'preview shown');
  sessionStore.clear(ADMIN);
});

test('unknown bale and unsold bale are refused immediately, no card', async () => {
  const bot = createFakeBot();
  sessionStore.clear(ADMIN);
  intentResult = { action: 'return_package', packageNo: 'NOPE', customer: null, confidence: 0.95 };
  await controller.handleMessage(bot, message('Return Bale NOPE'));
  assert.match(bot.allText(), /not found/i);

  intentResult = { action: 'return_package', packageNo: 'P2', customer: null, confidence: 0.95 };
  await controller.handleMessage(bot, message('Return Bale P2'));
  assert.match(bot.allText(), /no sold thans/i);
  assert.equal(sessionStore.get(ADMIN), null);
});

test('rtx tap after expiry explains instead of dead-ending', async () => {
  const bot = createFakeBot();
  sessionStore.clear(ADMIN);
  await controller.handleCallbackQuery(bot, cb('rtx:ok', ADMIN));
  assert.match(bot.allText(), /expired/i);
});

test('the admin approval card names the buyer (safety net)', async () => {
  const approvalCards = require(path.join(SRC, 'services/approvalCards'));
  const text = await approvalCards.buildReturnCard({ packageNo: 'P1' });
  assert.match(text, /Sold to: Benduku/, 'card carries the buyer');
  assert.match(text, /credits this account/);
});