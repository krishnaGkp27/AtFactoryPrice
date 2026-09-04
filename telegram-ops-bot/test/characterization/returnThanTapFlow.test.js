'use strict';

/**
 * TRF-INT4 — the tap return door is per-PHYSICAL-bale.
 *
 * RET-4 moved the door: `act:return_than` now opens the customer-first
 * ↩️ Return goods card (returnFlow, `rn:`), so the chips are `rn:bale:`
 * instead of the retired `rtp:`. The SUBJECT is unchanged and still pinned
 * here: one printed number sold in two warehouses gets TWO chips with the
 * warehouse right after the number; the pick scopes the than picker, the
 * confirm card and the queued ActionJSON to that warehouse; and a stale
 * picker card cannot select against a newer session's list (the chips are
 * indexes into the session array, never numbers).
 *
 * The full RET-4 journey (date, condition, photo, dual approval, credit)
 * lives in returnGoodsCard.test.js.
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

function invRow(pkg, than, status, soldTo, wh) {
  return [pkg, '', '', '9006', '1', than, '60', status, wh, '2500', '2026-07-01',
    soldTo, soldTo ? '2026-07-30' : '', '', '', '', 'fabric',
    `UID-${pkg}-${than}-${wh.replace(/\s+/g, '')}`, '2026-07-01', '', '', 'C1', ''];
}

installFakeSheets(createFakeSheets({
  Inventory: [
    INV_HEADERS,
    // The TRF-INT4 target: printed number 100 sold in TWO warehouses, to the
    // SAME buyer — so both physical bales sit on one customer's bale card.
    invRow('100', '1', 'sold', 'Musa', 'Kano office'),
    invRow('100', '1', 'sold', 'Musa', 'IDUMOTA'),
    invRow('200', '1', 'sold', 'Benduku', 'Kano office'),
  ],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const customerEntity = require(path.join(SRC, 'services/customerEntity'));

usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}`, role: 'admin' });
auditLogRepository.append = async () => {};
customerEntity.resolve = async () => null;      // walk-in spellings, no CRM row

const ADMIN = '777';
const CARD = 42;

/** Open the card and pick the one customer with goods out. */
async function toBaleCard(bot) {
  await controller.handleCallbackQuery(bot, cb('act:return_than', ADMIN, CARD));
  const musa = lastKb(bot).find((b) => b.callback_data.startsWith('rn:cust:') && /Musa/.test(b.text));
  assert.ok(musa, 'Musa has goods out');
  await controller.handleCallbackQuery(bot, cb(musa.callback_data, ADMIN, CARD));
}

test('duplicate number → two chips (warehouse after the number); pick scopes picker, confirm and queued aj', async () => {
  const bot = createFakeBot();
  const queued = [];
  approvalQueueRepository.append = async (row) => { queued.push(row); };
  sessionStore.clear(ADMIN);

  await toBaleCard(bot);
  const chips = lastKb(bot).filter((b) => b.callback_data.startsWith('rn:bale:'));
  const chips100 = chips.filter((b) => b.text.includes('100'));
  assert.equal(chips100.length, 2, `one chip per physical bale, got: ${chips.map((b) => b.text)}`);
  const idu = chips100.find((b) => b.text.includes('IDUMOTA'));
  assert.ok(idu, 'warehouse visible on the chip');
  assert.match(idu.text, /📦 100 · 🏭 IDUMOTA/, 'warehouse right after the number (truncation-safe)');

  await controller.handleCallbackQuery(bot, cb(idu.callback_data, ADMIN, CARD));
  const s1 = sessionStore.get(ADMIN);
  assert.equal(s1.warehouse, 'IDUMOTA', 'the pick pins the warehouse on the session');
  // Than picker: ONLY the IDUMOTA bale's sold than — the Kano row must not leak in.
  const thanChips = lastKb(bot).filter((b) => b.callback_data.startsWith('rn:t:'));
  assert.equal(thanChips.length, 1, 'one sold than in the picked warehouse');

  // Tick it, date it, call the goods good, skip the photo → confirm.
  await controller.handleCallbackQuery(bot, cb('rn:t:0', ADMIN, CARD));
  await controller.handleCallbackQuery(bot, cb('rn:tnext', ADMIN, CARD));
  const day = lastKb(bot).map((b) => b.callback_data).find((d) => d.startsWith('rn:dd:'));
  await controller.handleCallbackQuery(bot, cb(day, ADMIN, CARD));
  await controller.handleCallbackQuery(bot, cb('rn:c:good', ADMIN, CARD));
  await controller.handleCallbackQuery(bot, cb('rn:pskip', ADMIN, CARD));

  const confirmText = bot.allText().replace(/\\/g, '');
  assert.match(confirmText, /🏭 IDUMOTA/, 'confirm card names the warehouse');
  assert.match(confirmText, /👤 Customer: \*Musa\*/, 'confirm card names the scoped buyer');

  await controller.handleCallbackQuery(bot, cb('rn:submit', ADMIN, CARD));
  assert.equal(queued.length, 1);
  const aj = queued[0].actionJSON;
  assert.equal(aj.action, 'return_thans');
  assert.equal(aj.packageNo, '100');
  assert.deepEqual(aj.thanNos, [1]);
  assert.equal(aj.warehouse, 'IDUMOTA', 'the executor will act on IDUMOTA only');
  sessionStore.clear(ADMIN);
});

test('a stale picker card cannot select against a newer session list', async () => {
  const bot = createFakeBot();
  const queued = [];
  approvalQueueRepository.append = async (row) => { queued.push(row); };
  sessionStore.clear(ADMIN);

  await toBaleCard(bot);                                                        // card A, on the bale step
  await controller.handleCallbackQuery(bot, cb('act:return_than', ADMIN, 99));  // card B supersedes
  const before = JSON.parse(JSON.stringify(sessionStore.get(ADMIN)));

  await controller.handleCallbackQuery(bot, cb('rn:bale:0', ADMIN, CARD));      // tap on stale card A
  const after = sessionStore.get(ADMIN);
  assert.equal(after.packageNo, '', 'stale tap selected nothing');
  assert.deepEqual(after._customers.map((c) => c.key), before._customers.map((c) => c.key),
    'newer session untouched');
  const answered = bot.callsTo('answerCallbackQuery').at(-1);
  assert.match(JSON.stringify(answered.args), /Card expired/, 'stale tap is told why');
  sessionStore.clear(ADMIN);
});
