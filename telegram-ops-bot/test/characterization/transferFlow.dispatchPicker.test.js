'use strict';

/**
 * TRF-4 — dispatcher bale picker + dispatch/receive load photos + short
 * admin cards that expand on demand. Driven through the real controller
 * (callbacks + handleFileMessage). The Telegram download and Drive upload
 * are stubbed so the whole thing runs offline.
 *
 *   admin wizard → order → dispatcher picks EXACT bales → dispatch
 *   → dispatcher sends a load photo (archived, link stored, forwarded)
 *   → receiver confirms → sends a receipt photo
 *   → every admin card is a one-liner with a working "View details".
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
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const driveBackup = require(path.join(SRC, 'services/vision/driveBackup'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
designAssetsRepo.findActive = async () => null;
auditLogRepository.append = async () => {};
transactionsRepository.append = async () => {};
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
];
usersRepository.findByUserId = async (id) => ({ user_id: id, name: id === 'abdul' ? 'Abdul' : 'Musa' });

// Offline file pipeline: fixed bytes in, a controllable Drive result out.
telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('bytes'), mimeType: 'image/jpeg', ext: 'jpg' });
let nextArchive = { drive: { webViewLink: 'https://drive/xyz' }, readableName: 'file.jpg' };
driveBackup.archiveFile = async () => nextArchive;

function invRow(pkg, status = 'available', wh = 'Lagos') {
  return { packageNo: pkg, design: '9006', shade: '3', warehouse: wh, status, productType: 'fabric', yards: 100, pricePerYard: 0 };
}
function seedInventory() {
  // Four candidate bales in Lagos → a real choice when transferring 2.
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

test('accept opens a bale picker with FIFO pre-selection', async () => {
  const { requestId } = await runWizard();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  const kb = lastKb(bot);
  // Four candidate chips, FIFO P1/P2 pre-ticked, plus Next / Auto / Decline.
  assert.ok(kb.some((b) => b.startsWith('✅ P1|trf:bl:t:0')), 'P1 pre-selected');
  assert.ok(kb.some((b) => b.startsWith('✅ P2|trf:bl:t:1')), 'P2 pre-selected');
  assert.ok(kb.some((b) => b === 'P3|trf:bl:t:2'), 'P3 selectable');
  assert.ok(kb.some((b) => b.includes('trf:bl:auto')), 'auto-pick offered');
});

test('dispatcher picks exact bales — chosen numbers are what dispatch', async () => {
  const { calls, requestId } = await runWizard();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:0', 'abdul')); // deselect P1
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:3', 'abdul')); // select P4
  await controller.handleCallbackQuery(bot, cb('trf:bl:nx', 'abdul'));  // review
  await controller.handleCallbackQuery(bot, cb('trf:bl:go', 'abdul'));  // dispatch
  assert.deepEqual(calls.transitions[0].pkgs, ['P2', 'P4'], 'exact chosen bales flipped in-transit');
  assert.equal(calls.transitions[0].to, 'in_transit');
});

test('dispatch photo: archived to Drive, link stored on actionJSON, prompt sealed', async () => {
  const { requestId } = await runWizard();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:auto', 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:go', 'abdul'));
  assert.equal(sessionStore.get('abdul').step, 'await_doc', 'photo session armed after dispatch');

  nextArchive = { drive: { webViewLink: 'https://drive/dispatch' }, readableName: 'load.jpg' };
  const bf = createFakeBot();
  await controller.handleFileMessage(bf, {
    chat: { id: 'abdul' }, from: { id: 'abdul', first_name: 'Abdul' }, photo: [{ file_id: 'F1' }],
  });
  const row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.actionJSON.dispatchDoc.url, 'https://drive/dispatch', 'link stored');
  assert.match(bf.allText(), /Dispatch photo attached/i);
  assert.ok(!sessionStore.get('abdul'), 'photo session cleared after upload');
  // Forwarded to the receiver for eyes-on.
  assert.ok(bf.callsTo('sendPhoto').some((c) => String(c.args.chatId) === 'musa'), 'photo forwarded to receiver');
});

test('skip photo leaves an Attach-photo fallback button', async () => {
  const { requestId } = await runWizard();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:auto', 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:go', 'abdul'));
  const bs = createFakeBot();
  await controller.handleCallbackQuery(bs, cb(`trf:dsk:d:${requestId}`, 'abdul'));
  assert.ok(!sessionStore.get('abdul'), 'session cleared on skip');
  const kb = lastKb(bs);
  assert.ok(kb.some((b) => b.includes(`trf:att:d:${requestId}`)), 'attach-photo fallback offered');
});

test('receive photo: stored as receiveDoc, session cleared', async () => {
  const { requestId } = await runWizard();
  const bd = createFakeBot();
  await controller.handleCallbackQuery(bd, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bd, cb('trf:bl:auto', 'abdul'));
  await controller.handleCallbackQuery(bd, cb('trf:bl:go', 'abdul'));
  sessionStore.clear('abdul'); // drop dispatcher's photo session for isolation

  const br = createFakeBot();
  await controller.handleCallbackQuery(br, cb(`trf:rcv:${requestId}`, 'musa'));
  assert.equal(sessionStore.get('musa').step, 'await_doc', 'receive photo session armed');

  nextArchive = { drive: { webViewLink: 'https://drive/receipt' }, readableName: 'rcv.pdf' };
  const bf = createFakeBot();
  await controller.handleFileMessage(bf, {
    chat: { id: 'musa' }, from: { id: 'musa', first_name: 'Musa' },
    document: { file_id: 'D1', mime_type: 'application/pdf', file_name: 'rcv.pdf' },
  });
  const row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.actionJSON.receiveDoc.url, 'https://drive/receipt');
  assert.match(bf.allText(), /Receipt photo attached/i);
  assert.ok(!sessionStore.get('musa'), 'session cleared after receipt upload');
});

test('admin short card expands to full detail then collapses', async () => {
  const { requestId } = await runWizard();
  const bd = createFakeBot();
  await controller.handleCallbackQuery(bd, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bd, cb('trf:bl:auto', 'abdul'));
  await controller.handleCallbackQuery(bd, cb('trf:bl:go', 'abdul'));

  const adminCard = bd.callsTo('sendMessage').find((m) => String(m.args.chatId) === '777');
  assert.ok(adminCard, 'admin briefed on dispatch');
  assert.match(adminCard.args.text, /dispatched/i);
  assert.ok(!/•/.test(adminCard.args.text), 'admin card is a one-liner (no per-line breakdown)');
  const kb = adminCard.args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === `trf:info:${requestId}`), 'View details offered');

  // Expand.
  const bi = createFakeBot();
  await controller.handleCallbackQuery(bi, cb(`trf:info:${requestId}`, 777));
  const expand = bi.callsTo('editMessageText').pop();
  assert.match(expand.args.text, /Dispatcher: Abdul/);
  assert.match(expand.args.text, /Bales:/);
  assert.ok(expand.args.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === `trf:less:${requestId}`), 'collapse offered');

  // Collapse.
  const bc = createFakeBot();
  await controller.handleCallbackQuery(bc, cb(`trf:less:${requestId}`, 777));
  const collapsed = bc.callsTo('editMessageText').pop();
  assert.ok(collapsed.args.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === `trf:info:${requestId}`), 'expand offered again');
});
