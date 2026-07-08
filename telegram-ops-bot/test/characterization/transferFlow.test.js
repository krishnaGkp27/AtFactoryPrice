'use strict';

/**
 * TRF-2..TRF-6 — staged warehouse transfer, end to end through the real
 * controller:
 *   admin wizard (source→design→shade→qty→dest→confirm, auto-picked people)
 *   → dispatcher Accept → bale review → MANDATORY load photo (TRF-6 gate:
 *     nothing moves and the receiver hears nothing until the photo lands)
 *   → receiver Received → MANDATORY receipt photo → bales unlocked at the
 *     destination, row closed
 * plus: decline reverts, stranger taps blocked, non-admin can't start,
 * and Check Stock shows the 🚚 in-transit line.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,5555';

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
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const driveBackup = require(path.join(SRC, 'services/vision/driveBackup'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
designAssetsRepo.findActive = async () => null;
auditLogRepository.append = async () => {};
transactionsRepository.append = async () => {};
// TRF-6: the mandatory photo gate downloads + archives the file — keep it offline.
telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('bytes'), mimeType: 'image/jpeg', ext: 'jpg' });
driveBackup.archiveFile = async () => ({ drive: { webViewLink: 'https://drive/xyz' }, readableName: 'file.jpg' });
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
];

function invRow(pkg, status = 'available', wh = 'Lagos') {
  return { packageNo: pkg, design: '9006', shade: '3', warehouse: wh, status, productType: 'fabric', yards: 100, pricePerYard: 0 };
}
function seedInventory() {
  inventoryRepository.getAll = async () => [
    invRow('P1'), invRow('P2'), invRow('P3'),
    invRow('P9', 'available', 'Kano office'),
  ];
}

/** Queue stub with one mutable row; returns recorder. */
function armQueue() {
  const calls = { transitions: [], appended: null };
  let row = null;
  inventoryRepository.transitionBales = async (pkgs, from, to, wh) => { calls.transitions.push({ pkgs, from, to, wh }); return []; };
  approvalQueueRepository.append = async (rec) => { calls.appended = rec; row = { ...rec, status: 'pending' }; return rec; };
  approvalQueueRepository.getByRequestId = async () => (row ? JSON.parse(JSON.stringify(row)) : null);
  approvalQueueRepository.getAllPending = async () => (row && row.status === 'pending' ? [JSON.parse(JSON.stringify(row))] : []);
  approvalQueueRepository.updateStatus = async (id, status) => { row.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { row.actionJSON = { ...row.actionJSON, ...patch }; return true; };
  return calls;
}

function cb(data, uid) { return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 60 } }; }
function kbTexts(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat().map((b) => `${b.text}|${b.callback_data}`) : [];
}
/** Run the full admin wizard; returns { bot, calls, requestId }. */
async function runWizard() {
  seedInventory();
  const calls = armQueue();
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:transfer_stock', 777)); // source
  await controller.handleCallbackQuery(bot, cb('trf:wh:1', 777));           // ['Kano office','Lagos'] → Lagos
  await controller.handleCallbackQuery(bot, cb('trf:dg:0', 777));           // 9006
  await controller.handleCallbackQuery(bot, cb('trf:sh:0', 777));           // shade 3
  await controller.handleCallbackQuery(bot, cb('trf:qty:2', 777));          // 2 bales
  await controller.handleCallbackQuery(bot, cb('trf:dest:0', 777));         // Kano office → auto-picks people
  assert.match(bot.allText(), /Dispatcher: \*Abdul\*/);
  assert.match(bot.allText(), /Receiver: \*Musa\*/);
  await controller.handleCallbackQuery(bot, cb('trf:send', 777));
  return { bot, calls, requestId: calls.appended.requestId };
}

test('wizard: 5 taps, auto-picked people, ORDER queued — nothing locked at send', async () => {
  const { bot, calls, requestId } = await runWizard();
  assert.match(requestId, /^TR-/);
  const aj = calls.appended.actionJSON;
  assert.deepEqual(
    { from: aj.from, to: aj.to, lines: aj.lines, dispatcher: aj.dispatcher, receiver: aj.receiver, stage: aj.stage },
    { from: 'Lagos', to: 'Kano office', lines: [{ design: '9006', shade: '3', qty: 2 }], dispatcher: 'abdul', receiver: 'musa', stage: 'requested' },
  );
  assert.equal(calls.transitions.length, 0, 'TRF-3: no bales flipped at send — dispatcher logs them');
  const dm = bot.callsTo('sendMessage').find((m) => m.args.chatId === 'abdul');
  assert.ok(dm, 'dispatcher got the card');
  const dmCbs = dm.args.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(dmCbs, [`trf:acc:${requestId}`, `trf:dec:${requestId}`]);
});

test('dispatch applies only after the mandatory load photo; receive after the receipt photo', async () => {
  const { calls, requestId } = await runWizard();
  // Abdul accepts → picker → review → Dispatch tap arms the photo GATE.
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bot2, cb('trf:bl:auto', 'abdul'));
  await controller.handleCallbackQuery(bot2, cb('trf:bl:go', 'abdul'));
  assert.equal(calls.transitions.length, 0, 'TRF-6: nothing moves before the load photo');
  assert.ok(!bot2.callsTo('sendMessage').some((m) => m.args.chatId === 'musa'), 'receiver hears nothing before the photo');
  assert.match(bot2.allText(), /Photo required/i);
  // The load photo lands → dispatch applies, receiver DM goes out.
  const bp = createFakeBot();
  await controller.handleFileMessage(bp, { chat: { id: 'abdul' }, from: { id: 'abdul', first_name: 'Abdul' }, photo: [{ file_id: 'F1' }] });
  assert.deepEqual(calls.transitions[0], { pkgs: ['P1', 'P2'], from: 'available', to: 'in_transit', wh: 'Kano office' });
  const rdm = bp.callsTo('sendMessage').find((m) => m.args.chatId === 'musa');
  assert.ok(rdm, 'receiver got the incoming card');
  assert.match(rdm.args.text, /Shade 3 ×2/, 'receiver sees the grouped dispatched lines');
  assert.ok(rdm.args.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === `trf:rcv:${requestId}`));
  // Musa taps Received → receipt photo GATE; unlock waits for the file.
  const bot3 = createFakeBot();
  await controller.handleCallbackQuery(bot3, cb(`trf:rcv:${requestId}`, 'musa'));
  assert.ok(!calls.transitions.some((t) => t.from === 'in_transit'), 'no unlock before the receipt photo');
  assert.match(bot3.allText(), /Photo required/i);
  const br = createFakeBot();
  await controller.handleFileMessage(br, { chat: { id: 'musa' }, from: { id: 'musa', first_name: 'Musa' }, photo: [{ file_id: 'F2' }] });
  const unlock = calls.transitions.find((t) => t.from === 'in_transit' && t.to === 'available' && t.wh === null);
  assert.ok(unlock, 'bales unlocked at destination after the receipt photo');
  assert.match(br.allText(), /received.*now live at \*Kano office\*/i);
  // Admin 777 briefed (after the photo, not before).
  assert.ok(br.callsTo('sendMessage').some((m) => String(m.args.chatId) === '777'), 'admin notified');
});

test('shortfall at dispatch: partial send recorded and flagged', async () => {
  const { calls, requestId } = await runWizard();
  // Between order and dispatch, Lagos sold a bale: only P1 remains. With no
  // real choice, the picker goes straight to the dispatch-confirm screen —
  // which now says WHY there was no picker (auto-filled).
  inventoryRepository.getAll = async () => [invRow('P1'), invRow('P9', 'available', 'Kano office')];
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`trf:acc:${requestId}`, 'abdul'));
  assert.match(bot2.allText(), /9006\/3: 1\/2 ⚠️ short/, 'per-line shortfall shown on review');
  assert.match(bot2.allText(), /auto-filled/i, 'review explains the skipped picker');
  await controller.handleCallbackQuery(bot2, cb('trf:bl:go', 'abdul'));
  assert.equal(calls.transitions.length, 0, 'gate: still nothing moved');
  const bp = createFakeBot();
  await controller.handleFileMessage(bp, { chat: { id: 'abdul' }, from: { id: 'abdul', first_name: 'Abdul' }, photo: [{ file_id: 'F1' }] });
  assert.deepEqual(calls.transitions[0].pkgs, ['P1'], 'only the existing bale dispatched');
  assert.match(bp.allText(), /Shade 3 — 1\/2 ⚠️ short/, 'grouped shortfall shown');
  assert.match(bp.allText(), /Partially dispatched/i);
});

test('dispatcher decline (pre-dispatch): nothing was moved, nothing reverted', async () => {
  const { calls, requestId } = await runWizard();
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`trf:dec:${requestId}`, 'abdul'));
  assert.equal(calls.transitions.length, 0, 'no inventory touch on pre-dispatch decline');
  assert.match(bot2.allText(), /declined.*nothing was moved/i);
});

test('a stranger cannot act on someone else\'s transfer card', async () => {
  const { calls, requestId } = await runWizard();
  const before = calls.transitions.length;
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`trf:acc:${requestId}`, '5555'));
  assert.equal(calls.transitions.length, before, 'no inventory change');
  const ack = bot2.callsTo('answerCallbackQuery')[0];
  assert.match(ack.args.opts.text, /assigned person only/i);
});

test('non-admin cannot start the wizard', async () => {
  seedInventory(); armQueue();
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:transfer_stock', 4242));
  assert.match(bot.allText(), /admins only/i);
});

test('Check Stock shows the 🚚 in-transit line at the destination', async () => {
  armQueue();
  inventoryRepository.getAll = async () => [
    invRow('P1'), invRow('P2', 'in_transit', 'Kano office'), invRow('P3', 'in_transit', 'Kano office'),
  ];
  // checkStock reads through the repo's internal (fake-sheets) path — stub
  // the availability summary; the in-transit line reads the patched getAll.
  const inventoryService = require(path.join(SRC, 'services/inventoryService'));
  inventoryService.checkStock = async () => ({ totalPackages: 1, totalThans: 1, totalYards: 100 });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('cks:9006', 777));
  assert.match(bot.allText(), /🚚 In transit \(not yet sellable\): 2 bales → Kano office/);
});
