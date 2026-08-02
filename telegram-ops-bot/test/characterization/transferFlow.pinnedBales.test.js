'use strict';

/**
 * TRF-14 — typed transfer orders PIN their bale numbers end to end
 * (owner, 02-Aug-2026: transfer 02Aug·01 asked for 869/843/874/864/903 and
 * the FIFO pre-pick logged 867/842/873/863/903 — neighbours, not the truck).
 *
 *   typed numbers → order lines carry `bales` → the dispatcher picker
 *   pre-ticks exactly those → any deviation is spelled out on the confirm
 *   screen before the Dispatch button.
 *
 * Driven through the real controller. Tap-built orders (no typed numbers)
 * keep the original FIFO pre-selection — pinned behaviour is additive.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = 'abdul,musa,4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, kbTexts: lastKb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const transferFlow = require(path.join(SRC, 'flows/transferFlow'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
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
  return { rowIndex: _rowSeq, baleUid: `U-${pkg}-${wh.slice(0, 3)}`, packageNo: pkg, design: '9006', shade: '3', warehouse: wh, status, productType: 'fabric', yards: 100, pricePerYard: 0 };
}

let invStore = [];
function seedInventory() {
  // Four numbered bales of 9006/3 in Lagos (sheet order 101..104) plus one
  // in Kano so the destination list has a second warehouse.
  invStore = [
    invRow('101'), invRow('102'), invRow('103'), invRow('104'),
    invRow('900', 'available', 'Kano office'),
  ];
  inventoryRepository.getAll = async () => JSON.parse(JSON.stringify(invStore));
  inventoryRepository.ensureRowUids = async (rows) => new Map(rows.map((r) => [r.rowIndex, r.baleUid]));
}

function armQueue() {
  const calls = { transitions: [], appended: null, ajPatches: [] };
  let row = null;
  inventoryRepository.transitionBales = async (pkgs, from, to, wh, opts = {}) => {
    calls.transitions.push({ pkgs, from, to, wh, opts });
    const set = new Set((pkgs || []).map(String));
    const uidSet = Array.isArray(opts.uids) && opts.uids.length ? new Set(opts.uids.map(String)) : null;
    const low = (v) => String(v == null ? '' : v).trim().toLowerCase();
    const rows = invStore.filter((r) => r.status === from
      && (uidSet ? uidSet.has(String(r.baleUid))
        : (set.has(String(r.packageNo)) && (!opts.warehouse || low(r.warehouse) === low(opts.warehouse)))));
    rows.forEach((r) => { r.status = to; if (wh != null) r.warehouse = wh; });
    return rows.map((r) => ({ ...r }));
  };
  approvalQueueRepository.append = async (rec) => { calls.appended = rec; row = { ...rec, status: 'pending' }; return rec; };
  approvalQueueRepository.getByRequestId = async () => (row ? JSON.parse(JSON.stringify(row)) : null);
  approvalQueueRepository.getAllPending = async () => (row && row.status === 'pending' ? [JSON.parse(JSON.stringify(row))] : []);
  approvalQueueRepository.getAllWithRowIndex = async () => (row ? [JSON.parse(JSON.stringify({ ...row, rowIndex: 2 }))] : []);
  approvalQueueRepository.updateStatus = async (id, status) => { row.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { calls.ajPatches.push(patch); row.actionJSON = { ...row.actionJSON, ...patch }; return true; };
  return calls;
}


/** Chip-label membership (kbTexts entries are "label|callback_data"). */
function hasChip(texts, label) { return texts.some((t) => t.startsWith(`${label}|`)); }
/** Text of the most recent sendMessage/editMessageText. */
function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}

/** Typed order for bales 102 + 104 → preload review → send. */
async function typedOrder() {
  seedInventory();
  const calls = armQueue();
  sessionStore.clear('777');
  const bot = createFakeBot();
  const shown = await transferFlow.startFromText(bot, 777, '777', 'Transfer packages 102, 104 to Kano');
  assert.equal(shown, true);
  await controller.handleCallbackQuery(bot, cb('trf:pl:go', 777));
  await controller.handleCallbackQuery(bot, cb('trf:send', 777));
  assert.ok(calls.appended, 'transfer request must be queued');
  return { calls, requestId: calls.appended.requestId, bot };
}

test('typed numbers ride the order lines into the queue', async () => {
  const { calls } = await typedOrder();
  const lines = calls.appended.actionJSON.lines;
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].bales, ['102', '104']);
  assert.equal(lines[0].qty, 2);
});

test('order cards print the pinned numbers on the line rows', async () => {
  const { requestId, calls } = await typedOrder();
  assert.ok(requestId);
  const block = transferFlow._internals.linesBlock(calls.appended.actionJSON.lines);
  assert.match(block, /Shade 3 ×2 \(102, 104\)/);
});

test('picker pre-ticks the requested bales, not the FIFO head', async () => {
  const { requestId } = await typedOrder();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  const texts = lastKb(bot);
  assert.ok(hasChip(texts, '✅ 102'), `102 pre-ticked, got: ${texts}`);
  assert.ok(hasChip(texts, '✅ 104'), `104 pre-ticked, got: ${texts}`);
  assert.ok(hasChip(texts, '101'), 'FIFO head 101 present but NOT ticked');
  assert.ok(!hasChip(texts, '✅ 101'), 'FIFO head must not be pre-selected');
  assert.match(lastText(bot), /Ordered: \*102, 104\*/);
});

test('confirm screen is quiet when the picked bales match the order', async () => {
  const { requestId } = await typedOrder();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:nx', 'abdul'));
  const msg = lastText(bot);
  assert.match(msg, /dispatch 2 bale\(s\)/);
  assert.match(msg, /102, 104/);
  assert.ok(!/order asked for/.test(msg), 'no warning when selection matches');
});

test('swapping a pinned bale for a neighbour warns loudly on confirm', async () => {
  const { requestId } = await typedOrder();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  // Untick 104 (grid index 3), tick 103 (grid index 2) — the 02Aug mistake.
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:3', 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:2', 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:nx', 'abdul'));
  const msg = lastText(bot);
  assert.match(msg, /order asked for \*104\*/);
  assert.match(msg, /dispatching \*103\* instead/);
  assert.match(msg, /PHYSICALLY loaded/);
});

test('a pinned bale gone missing forces the picker open with a warning', async () => {
  const { requestId } = await typedOrder();
  // 102 vanishes (sold) between order and dispatch.
  const gone = invStore.find((r) => r.packageNo === '102');
  gone.status = 'sold';
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  assert.match(lastText(bot), /102.*not available here/);
  // 104 stays ticked; the fill-in (101, FIFO) completes the qty.
  const texts = lastKb(bot);
  assert.ok(hasChip(texts, '✅ 104'));
  assert.ok(hasChip(texts, '✅ 101'), 'FIFO fill-in for the missing bale');
});

test('tap-built orders keep plain FIFO pre-selection (no pinning)', async () => {
  seedInventory();
  const calls = armQueue();
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:transfer_stock', 777));
  await controller.handleCallbackQuery(bot, cb('trf:wh:1', 777)); // Lagos
  await controller.handleCallbackQuery(bot, cb('trf:dg:0', 777)); // 9006
  await controller.handleCallbackQuery(bot, cb('trf:sh:0', 777)); // shade 3
  await controller.handleCallbackQuery(bot, cb('trf:qty:2', 777));
  await controller.handleCallbackQuery(bot, cb('trf:dest:0', 777)); // Kano office
  await controller.handleCallbackQuery(bot, cb('trf:send', 777));
  assert.equal(calls.appended.actionJSON.lines[0].bales, undefined, 'tap orders carry no pinned bales');
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`trf:acc:${calls.appended.requestId}`, 'abdul'));
  const texts = lastKb(bot2);
  assert.ok(hasChip(texts, '✅ 101') && hasChip(texts, '✅ 102'), `FIFO pre-selection intact, got: ${texts}`);
  assert.ok(!/Ordered:/.test(lastText(bot2)), 'no Ordered note without pinned bales');
});
