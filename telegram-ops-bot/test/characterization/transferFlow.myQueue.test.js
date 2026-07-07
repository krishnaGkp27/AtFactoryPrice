'use strict';

/**
 * TRF-5 — transfers surface in the assignee's My Tasks queue, and the
 * legacy instant-transfer entry points redirect into Transfer Stock.
 *
 *   admin wizard → order → dispatcher's My Tasks lists it with a
 *   [🚚 Dispatch] button → trf:card re-sends the action card (session-free)
 *   → after dispatch the queue hands over to the receiver
 *   → legacy tiles / typed transfer commands redirect to Transfer Stock.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = 'abdul,musa,4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

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
const taskFlow = require(path.join(SRC, 'flows/taskFlow'));
const activityRegistry = require(path.join(SRC, 'services/activityRegistry'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
designAssetsRepo.findActive = async () => null;
auditLogRepository.append = async () => {};
transactionsRepository.append = async () => {};
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
];
usersRepository.findByUserId = async (id) => ({ user_id: id, name: id === 'abdul' ? 'Abdul' : 'Musa' });

function invRow(pkg, status = 'available', wh = 'Lagos') {
  return { packageNo: pkg, design: '9006', shade: '3', warehouse: wh, status, productType: 'fabric', yards: 100, pricePerYard: 0 };
}
function seedInventory() {
  inventoryRepository.getAll = async () => [
    invRow('P1'), invRow('P2'), invRow('P3'), invRow('P4'),
    invRow('P9', 'available', 'Kano office'),
  ];
}

function armQueue() {
  const calls = { transitions: [], appended: null, ajPatches: [] };
  let row = null;
  inventoryRepository.transitionBales = async (pkgs, from, to, wh) => { calls.transitions.push({ pkgs, from, to, wh }); return []; };
  approvalQueueRepository.append = async (rec) => { calls.appended = rec; row = { ...rec, status: 'pending' }; return rec; };
  approvalQueueRepository.getByRequestId = async () => (row ? JSON.parse(JSON.stringify(row)) : null);
  approvalQueueRepository.getAllPending = async () => (row && row.status === 'pending' ? [JSON.parse(JSON.stringify(row))] : []);
  approvalQueueRepository.updateStatus = async (id, status) => { row.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { calls.ajPatches.push(patch); row.actionJSON = { ...row.actionJSON, ...patch }; return true; };
  return calls;
}

function cb(data, uid, messageId = 60) { return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: messageId } }; }
function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat().map((b) => `${b.text}|${b.callback_data}`) : [];
}

/** Admin creates a 2-bale order of 9006/3 Lagos → Kano office. */
async function runWizard() {
  seedInventory();
  const calls = armQueue();
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:transfer_stock', 777));
  await controller.handleCallbackQuery(bot, cb('trf:wh:1', 777)); // Lagos
  await controller.handleCallbackQuery(bot, cb('trf:dg:0', 777)); // 9006
  await controller.handleCallbackQuery(bot, cb('trf:sh:0', 777)); // shade 3
  await controller.handleCallbackQuery(bot, cb('trf:qty:2', 777)); // 2 bales
  await controller.handleCallbackQuery(bot, cb('trf:dest:0', 777)); // Kano office
  await controller.handleCallbackQuery(bot, cb('trf:send', 777));
  return { calls, requestId: calls.appended.requestId };
}

/** Drive the dispatcher through auto-pick → dispatch. */
async function dispatchAll(requestId) {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:auto', 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:go', 'abdul'));
  sessionStore.clear('abdul'); // drop the photo prompt session for isolation
}

test("dispatcher's My Tasks lists the pending transfer with a Dispatch button", async () => {
  const { requestId } = await runWizard();
  const bot = createFakeBot();
  await taskFlow.showMyTasks(bot, 'abdul', 'abdul', null);
  const text = bot.allText();
  assert.match(text, /Transfers waiting on you/);
  assert.ok(text.includes(requestId), 'request id shown');
  assert.match(text, /waiting for you to dispatch/);
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => b === `🚚 Dispatch — ${requestId}|trf:card:${requestId}`), 'Dispatch button routes to trf:card');
});

test('trf:card re-sends the dispatcher action card, session-free', async () => {
  const { requestId } = await runWizard();
  sessionStore.clear('abdul'); // no session at all — must still work
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:card:${requestId}`, 'abdul'));
  assert.match(bot.allText(), /please dispatch/i);
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => b.includes(`trf:acc:${requestId}`)), 'Accept & dispatch offered');
  assert.ok(kb.some((b) => b.includes(`trf:dec:${requestId}`)), 'Decline offered');
});

test('after dispatch the queue hands over to the receiver', async () => {
  const { requestId } = await runWizard();
  await dispatchAll(requestId);

  const bd = createFakeBot();
  await taskFlow.showMyTasks(bd, 'abdul', 'abdul', null);
  assert.ok(!/Transfers waiting on you/.test(bd.allText()), "dispatcher's queue is clear");

  const br = createFakeBot();
  await taskFlow.showMyTasks(br, 'musa', 'musa', null);
  assert.match(br.allText(), /in transit — confirm receipt/);
  const kb = lastKb(br);
  assert.ok(kb.some((b) => b === `📦 Receive — ${requestId}|trf:card:${requestId}`), 'Receive button routes to trf:card');

  // The receiver's card carries Received / Reject.
  const bc = createFakeBot();
  await controller.handleCallbackQuery(bc, cb(`trf:card:${requestId}`, 'musa'));
  assert.match(bc.allText(), /incoming/i);
  const kb2 = lastKb(bc);
  assert.ok(kb2.some((b) => b.includes(`trf:rcv:${requestId}`)), 'Received offered');
});

test('trf:card refuses a user who is not the assigned actor', async () => {
  const { requestId } = await runWizard();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:card:${requestId}`, '4242'));
  assert.ok(!/please dispatch/i.test(bot.allText()), 'no action card leaked');
  const alerted = bot.callsTo('answerCallbackQuery').some((c) => c.args.opts && c.args.opts.show_alert);
  assert.ok(alerted, 'stranger gets an alert instead');
});

test('trf:card on a settled transfer shows its state, no action buttons', async () => {
  const { requestId } = await runWizard();
  await dispatchAll(requestId);
  const br = createFakeBot();
  await controller.handleCallbackQuery(br, cb(`trf:rcv:${requestId}`, 'musa'));
  sessionStore.clear('musa');

  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:card:${requestId}`, 'musa'));
  assert.match(bot.allText(), /received/i);
  const kb = lastKb(bot);
  assert.ok(!kb.some((b) => b.includes('trf:rcv:') || b.includes('trf:acc:')), 'no stale action buttons');
});

test('legacy tiles are hidden from menus but still resolvable', () => {
  assert.equal(activityRegistry.getActivity('transfer_package').hub, '_hidden');
  assert.equal(activityRegistry.getActivity('transfer_than').hub, '_hidden');
  const grouped = activityRegistry.groupByHub(activityRegistry.getAll());
  const surfaced = grouped.hubs.flatMap((h) => h.activities.map((a) => a.code));
  assert.ok(!surfaced.includes('transfer_package'), 'tile no longer surfaces');
  assert.ok(!surfaced.includes('transfer_than'), 'tile no longer surfaces');
  assert.ok(surfaced.includes('transfer_stock'), 'staged flow still surfaces');
});

test('act:transfer_package / act:transfer_than redirect to Transfer Stock', async () => {
  seedInventory();
  armQueue();
  for (const code of ['act:transfer_package', 'act:transfer_than']) {
    sessionStore.clear('777');
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb(code, 777));
    assert.match(bot.allText(), /Transfer Stock/, `${code} redirects`);
    assert.ok(!/Select the Bale/.test(bot.allText()), 'legacy picker never opens');
    const kb = lastKb(bot);
    assert.ok(kb.some((b) => b.includes('act:transfer_stock')), 'redirect button offered');
  }
});

test('typed transfer commands redirect instead of moving stock', async () => {
  seedInventory();
  armQueue();
  const restore = installFakeIntent(() => ({
    action: 'transfer_package', packageNo: '5801', warehouse: 'Kano', confidence: 0.95,
  }));
  try {
    sessionStore.clear('777');
    const bot = createFakeBot();
    await controller.handleMessage(bot, { chat: { id: 777 }, from: { id: 777 }, text: 'Transfer Bale 5801 to Kano' });
    assert.match(bot.allText(), /Transfer Stock/);
    assert.ok(!/Transferred/.test(bot.allText()), 'nothing was moved');
  } finally {
    restore();
    installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
  }
});
