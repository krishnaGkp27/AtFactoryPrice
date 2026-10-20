'use strict';

/**
 * RET-1 — typed returns preview before queueing, and the belongs-to check:
 *
 *   RET-5 (20-Oct-2026) retired the preview: every typed return intent now
 *   opens the multi-bale review card (returnBundleFlow), which names each
 *   than's buyer from the sale record, so a claimed customer is only noted.
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
const { cb, lastKb } = require('../helpers/charFixture');

const INV_HEADERS = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];

/** Inventory row: pkg, than, status, soldTo. Design 9006, 60 yds each. */
function invRow(pkg, than, status, soldTo, wh = 'Kano office') {
  return [pkg, '', '', '9006', '1', than, '60', status, wh, '0', '2026-07-01',
    soldTo, soldTo ? '2026-07-30' : '', '', '', '', 'fabric', `UID-${pkg}-${than}-${wh.replace(/\s+/g, '')}`, '2026-07-01', '', '', '', ''];
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
    // TRF-INT4 — the SAME printed number sold in TWO warehouses (numbers
    // recycle across intakes): a typed return must ask which one.
    invRow('P9', '1', 'sold', 'Benduku', 'Kano office'),
    invRow('P9', '1', 'sold', 'Alhaji Musa', 'IDUMOTA'),
    // One physical warehouse spelled two ways — must NOT trigger the ask.
    invRow('P10', '1', 'sold', 'Benduku', 'Kano office'),
    invRow('P10', '2', 'sold', 'Benduku', 'KANO OFFICE'),
    // Named warehouse + blank-warehouse legacy row — no ask; the named
    // warehouse wins and the blank row drops out of the totals.
    invRow('P11', '1', 'sold', 'Benduku', 'Benduku WH'),
    invRow('P11', '2', 'sold', 'Benduku', ''),
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

test('RET-5 (R4): every typed return intent opens the multi-bale review card — nothing queues from the line', async () => {
  const bot = createFakeBot();
  const q = armQueue();
  sessionStore.clear(ADMIN);
  intentResult = { action: 'return_package', packageNo: 'P1', confidence: 0.9 };
  await controller.handleMessage(bot, message('Return Bale P1'));
  const text = bot.allText().replace(/\\/g, '');
  assert.match(text, /↩️ \*Return\*[\s\S]*👤 Benduku · 2t · 120 yd[\s\S]*1\. P1 · 120 yd/, 'the buyer comes from the sale record');
  assert.equal(q.appended.length, 0, 'nothing queued from the line itself');
  assert.equal(sessionStore.get(ADMIN).type, 'return_bundle_flow');
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'rb:go'), 'the review card continues to date, condition, photo');

  sessionStore.clear(ADMIN);
  intentResult = { action: 'return_than', packageNo: 'P3', thanNo: 2, customer: 'Benduku', confidence: 0.9 };
  await controller.handleMessage(bot, message('Return than 2 from Bale P3 from Benduku'));
  const t2 = bot.allText().replace(/\\/g, '');
  assert.match(t2, /👤 Alhaji Musa · 1t · 60 yd[\s\S]*P3\/2 · 60 yd/, 'the than belongs to Alhaji Musa whatever the line claimed');
  assert.match(t2, /ℹ️ I ignored "Benduku"/);
  intentResult = { action: 'unknown', confidence: 0 };
});

test('a multi-buyer bale is no longer refused: each buyer gets their own group', async () => {
  const bot = createFakeBot();
  armQueue();
  sessionStore.clear(ADMIN);
  intentResult = { action: 'return_package', packageNo: 'P3', confidence: 0.9 };
  await controller.handleMessage(bot, message('Return Bale P3'));
  intentResult = { action: 'unknown', confidence: 0 };
  const text = bot.allText().replace(/\\/g, '');
  assert.match(text, /📦 2t · 120 yd · 2 customers[\s\S]*👤 Alhaji Musa · 1t · 60 yd[\s\S]*👤 Benduku · 1t · 60 yd/);
});

test('unknown and unsold bales are named on the card, not refused in silence', async () => {
  const bot = createFakeBot();
  armQueue();
  sessionStore.clear(ADMIN);
  intentResult = { action: 'return_package', packageNo: 'P2', confidence: 0.9 };
  await controller.handleMessage(bot, message('Return Bale P2'));
  intentResult = { action: 'unknown', confidence: 0 };
  assert.match(bot.allText(), /• P2 — nothing sold — all 1 than in stock/);
});

test('buildReturnCard scoped to a warehouse describes ONLY that physical bale', async () => {
  const approvalCards = require(path.join(SRC, 'services/approvalCards'));
  const idu = await approvalCards.buildReturnCard({ packageNo: 'P9', warehouse: 'IDUMOTA' });
  assert.match(idu, /Sold to: Alhaji Musa/, 'the IDUMOTA buyer');
  assert.ok(!/MULTIPLE buyers/.test(idu), 'no cross-warehouse buyer mixing');
  assert.match(idu, /Warehouse: IDUMOTA/);
});