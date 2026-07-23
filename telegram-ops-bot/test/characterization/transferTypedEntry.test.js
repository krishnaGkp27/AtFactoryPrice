'use strict';

/**
 * TRF-8b — "Transfer package 997, 999, 1000 to kano" typed by a NON-ADMIN
 * employee (mirror of SELL-T1): the numbers preload the Transfer Stock
 * cart (validated against available stock, per-number skip reasons), the
 * trailing "to kano" pre-selects the Kano office destination, and the
 * normal tap wizard carries on to the ApprovalQueue submit. The redirect
 * card remains only for messages with no readable numbers.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,abdul,musa';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, lastKb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
// The intent parser recognises the typed command; the flow re-parses the
// RAW text for numbers + destination (tolerant, deterministic).
installFakeIntent(() => ({
  action: 'transfer_batch',
  packageNos: ['997', '999', '1000'],
  warehouse: 'kano',
  confidence: 0.95,
}));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
auditLogRepository.append = async () => {};
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
];

// 997 + 999 available in Lagos; 1000 sold (to CJE); P9 gives Kano office stock.
inventoryRepository.getAll = async () => [
  { packageNo: '997', design: '9006', shade: '3', warehouse: 'Lagos', status: 'available', yards: 100 },
  { packageNo: '999', design: '9006', shade: '3', warehouse: 'Lagos', status: 'available', yards: 100 },
  { packageNo: '1000', design: '9006', shade: '3', warehouse: 'Lagos', status: 'sold', yards: 100, soldTo: 'CJE' },
  { packageNo: 'P9', design: '9006', shade: '3', warehouse: 'Kano office', status: 'available', yards: 100 },
];

function armQueue() {
  const calls = { appended: null };
  let row = null;
  approvalQueueRepository.append = async (rec) => { calls.appended = rec; row = { ...rec, status: 'pending' }; return rec; };
  approvalQueueRepository.getByRequestId = async () => (row ? JSON.parse(JSON.stringify(row)) : null);
  approvalQueueRepository.getAllPending = async () => (row && row.status === 'pending' ? [JSON.parse(JSON.stringify(row))] : []);
  approvalQueueRepository.updateStatus = async (id, status) => { row.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { row.actionJSON = { ...row.actionJSON, ...patch }; return true; };
  return calls;
}

function msg(text, uid = '4242') {
  return { from: { id: uid }, chat: { id: uid }, text };
}

test('typed bale list preloads the cart, skips the sold bale, pre-selects Kano office, submits to the queue', async () => {
  const calls = armQueue();
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Transfer package 997, 999, 1000 to kano'));

  // Preload review card: 2 of 3 loaded, sold bale skipped with reason,
  // destination resolved from the trailing "to kano".
  const text = bot.allText();
  assert.match(text, /preloaded 2 of 3 typed bale\(s\)/i);
  assert.match(text, /From \*Lagos\*/);
  assert.match(text, /997, 999/, 'loaded bales listed');
  assert.match(text, /1000 — already sold to CJE \(skipped\)/);
  assert.match(text, /Destination: \*Kano office\* \(from your message\)/);
  const session = sessionStore.get('4242');
  assert.equal(session.type, 'transfer_flow');
  assert.equal(session.step, 'preload_review');
  assert.equal(session.from, 'Lagos');
  assert.equal(session.to, 'Kano office');
  assert.deepEqual(session.lines, [{ design: '9006', shade: '3', qty: 2 }]);

  // Continue → destination already known → straight to auto-picked people.
  const cont = lastKb(bot).find((b) => b.callback_data === 'trf:pl:go');
  assert.equal(cont && cont.text, '➡ Continue', 'Continue (not Pick destination) offered');
  await controller.handleCallbackQuery(bot, cb('trf:pl:go', '4242'));
  assert.match(bot.allText(), /Dispatcher: \*Abdul\*/);
  assert.match(bot.allText(), /Receiver: \*Musa\*/);

  // Send → ApprovalQueue row with the preloaded order.
  await controller.handleCallbackQuery(bot, cb('trf:send', '4242'));
  assert.ok(calls.appended, 'approval row appended');
  const aj = calls.appended.actionJSON;
  assert.deepEqual(
    { action: aj.action, from: aj.from, to: aj.to, lines: aj.lines, stage: aj.stage },
    { action: 'transfer_stock', from: 'Lagos', to: 'Kano office', lines: [{ design: '9006', shade: '3', qty: 2 }], stage: 'requested' },
  );
  assert.equal(calls.appended.user, '4242', 'non-admin creator recorded');
  // Dispatcher card + admin brief still ride the commit-1 pipeline.
  assert.ok(bot.callsTo('sendMessage').some((m) => String(m.args.chatId) === 'abdul'), 'dispatcher DM sent');
  assert.ok(bot.callsTo('sendMessage').some((m) => String(m.args.chatId) === '777' && /requested ⏳/.test(m.args.text)), 'admin briefed');
  sessionStore.clear('4242');
});

test('no destination match: preload keeps the wizard asking for the warehouse', async () => {
  armQueue();
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Transfer package 997, 999 to nowhere'));
  assert.match(bot.allText(), /preloaded 2 of 2 typed bale\(s\)/i);
  const session = sessionStore.get('4242');
  assert.equal(session.to, undefined, 'no destination pre-selected');
  const btn = lastKb(bot).find((b) => b.callback_data === 'trf:pl:go');
  assert.equal(btn && btn.text, '➡ Pick destination');
  await controller.handleCallbackQuery(bot, cb('trf:pl:go', '4242'));
  assert.match(bot.allText(), /to which warehouse\?/i, 'destination picker shown');
  sessionStore.clear('4242');
});

test('no valid numbers: per-number reasons + tap-flow fallback, no session left behind', async () => {
  armQueue();
  sessionStore.clear('4242');
  installFakeIntent(() => ({ action: 'transfer_batch', packageNos: ['111'], warehouse: 'kano', confidence: 0.9 }));
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Transfer package 111 to kano'));
  assert.match(bot.allText(), /None of the typed bale numbers matched available stock/);
  assert.match(bot.allText(), /111 — not found in the sheet/);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'act:transfer_stock'), 'tap-flow fallback offered');
  assert.ok(!sessionStore.get('4242'), 'no half-loaded session');
});

test('no readable numbers at all: the TRF-5 redirect card still answers', async () => {
  armQueue();
  sessionStore.clear('4242');
  installFakeIntent(() => ({ action: 'transfer_package', confidence: 0.9 }));
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('please transfer stock to kano'));
  assert.match(bot.allText(), /Warehouse transfers now go through \*Transfer Stock\*/);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'act:transfer_stock'), 'redirect button shown');
  assert.ok(!sessionStore.get('4242'), 'no session started');
});
