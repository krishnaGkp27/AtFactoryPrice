'use strict';

/**
 * TRF-INT4 — the tap Return-Than flow is per-PHYSICAL-bale:
 *
 *   act:return_than → one chip per (warehouse, bale) — a printed number
 *   sold in two warehouses gets TWO chips, warehouse right after the
 *   number; the pick scopes the than picker, the confirm card and the
 *   queued aj to that warehouse; a stale picker card cannot select against
 *   a newer session's list (rtp: chips are indexes, not numbers).
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
  return [pkg, '', '', '9006', '1', than, '60', status, wh, '0', '2026-07-01',
    soldTo, soldTo ? '2026-07-30' : '', '', '', '', 'fabric', `UID-${pkg}-${than}-${wh.replace(/\s+/g, '')}`, '2026-07-01', '', '', '', ''];
}

installFakeSheets(createFakeSheets({
  Inventory: [
    INV_HEADERS,
    // The TRF-INT4 target: printed number 100 sold in TWO warehouses.
    invRow('100', '1', 'sold', 'Musa', 'Kano office'),
    invRow('100', '1', 'sold', 'Aliyu', 'IDUMOTA'),
    invRow('200', '1', 'sold', 'Benduku', 'Kano office'),
  ],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}`, role: 'admin' });
auditLogRepository.append = async () => {};

const ADMIN = '777';
const CARD = 42;

test('duplicate number → two chips (warehouse after the number); pick scopes picker, confirm and queued aj', async () => {
  const bot = createFakeBot();
  const queued = [];
  approvalQueueRepository.append = async (row) => { queued.push(row); };
  sessionStore.clear(ADMIN);

  await controller.handleCallbackQuery(bot, cb('act:return_than', ADMIN, CARD));
  const chips = lastKb(bot).filter((b) => b.callback_data.startsWith('rtp:'));
  const chips100 = chips.filter((b) => b.text.includes('100'));
  assert.equal(chips100.length, 2, `one chip per physical bale, got: ${chips.map((b) => b.text)}`);
  const idu = chips100.find((b) => b.text.includes('IDUMOTA'));
  assert.ok(idu, 'warehouse visible on the chip');
  assert.match(idu.text, /📦 100 · 🏭 IDUMOTA/, 'warehouse right after the number (truncation-safe)');

  await controller.handleCallbackQuery(bot, cb(idu.callback_data, ADMIN, CARD));
  const s1 = sessionStore.get(ADMIN);
  assert.equal(s1.warehouse, 'IDUMOTA', 'the pick pins the warehouse on the session');
  // Than picker: ONLY the IDUMOTA bale's sold than — the Kano buyer must not leak in.
  const thanChips = lastKb(bot).filter((b) => b.callback_data.startsWith('rth:'));
  assert.equal(thanChips.length, 1, 'one sold than in the picked warehouse');
  assert.match(thanChips[0].text, /Aliyu/, 'the IDUMOTA buyer, not Musa');

  await controller.handleCallbackQuery(bot, cb('rth:1', ADMIN, CARD));
  const confirmText = bot.allText().replace(/\\/g, '');
  assert.match(confirmText, /Warehouse: \*IDUMOTA\*/, 'confirm card names the warehouse');
  assert.match(confirmText, /Sold to: \*Aliyu\*/, 'confirm card names the scoped buyer');

  await controller.handleCallbackQuery(bot, cb('rtconf:1', ADMIN, CARD));
  assert.equal(queued.length, 1);
  const aj = queued[0].actionJSON;
  assert.equal(aj.action, 'return_than');
  assert.equal(aj.packageNo, '100');
  assert.equal(String(aj.thanNo), '1');
  assert.equal(aj.warehouse, 'IDUMOTA', 'the executor will act on IDUMOTA only');
});

test('a stale picker card cannot select against a newer session list', async () => {
  const bot = createFakeBot();
  const queued = [];
  approvalQueueRepository.append = async (row) => { queued.push(row); };
  sessionStore.clear(ADMIN);

  await controller.handleCallbackQuery(bot, cb('act:return_than', ADMIN, CARD)); // card A
  await controller.handleCallbackQuery(bot, cb('act:return_than', ADMIN, 99));   // card B supersedes
  const before = JSON.parse(JSON.stringify(sessionStore.get(ADMIN)));

  await controller.handleCallbackQuery(bot, cb('rtp:0', ADMIN, CARD)); // tap on stale card A
  const after = sessionStore.get(ADMIN);
  assert.equal(after.packageNo, undefined, 'stale tap selected nothing');
  assert.deepEqual(after._pkgOptions, before._pkgOptions, 'newer session untouched');
  const answered = bot.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
  assert.match(JSON.stringify(answered.args), /Card expired/, 'stale tap is told why');
  sessionStore.clear(ADMIN);
});
