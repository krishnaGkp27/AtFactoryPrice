'use strict';

/**
 * TRF-16 — the dispatcher picks the date the goods PHYSICALLY LEFT the
 * store (owner, 03-Aug: "It is the date when goods physically left the
 * store").
 *
 * Before this there was no date field at all — `dispatchedAt` was stamped
 * from the server clock when the load photo landed, so a truck that left
 * yesterday and was logged this morning read as today.
 *
 *   dispatch review shows "📅 Left the store: <today>" + 📅 Change date
 *   → quick chips → 📆 month grid → the tap commits → back on review
 *   → the chosen day rides the transfer as aj.dispatchedOn and prints on
 *     the receiver + detail cards.
 *
 * `dispatchedAt` (the logging timestamp) is kept alongside for audit.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = 'abdul,musa,4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, kbTexts } = require('../helpers/charFixture');

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
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const driveBackup = require(path.join(SRC, 'services/vision/driveBackup'));
const dateCalendar = require(path.join(SRC, 'utils/dateCalendar'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
auditLogRepository.append = async () => {};
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
];
usersRepository.findByUserId = async (id) => ({ user_id: id, name: id === 'abdul' ? 'Abdul' : 'Musa' });
telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('b'), mimeType: 'image/jpeg', ext: 'jpg' });
driveBackup.archiveFile = async () => ({ drive: { webViewLink: 'https://drive/x' }, readableName: 'load.jpg' });

const TODAY = dateCalendar.lagosISO(0);
const YESTERDAY = dateCalendar.lagosISO(1);

let _seq = 1;
function invRow(pkg, status = 'available', wh = 'Lagos') {
  _seq += 1;
  return { rowIndex: _seq, baleUid: `U-${pkg}-${wh.slice(0, 3)}`, packageNo: pkg, design: '9006', shade: '3', warehouse: wh, status, productType: 'fabric', yards: 100, pricePerYard: 0 };
}
let invStore = [];
function seedInventory() {
  invStore = [invRow('P1'), invRow('P2'), invRow('P3'), invRow('P9', 'available', 'Kano office')];
  inventoryRepository.getAll = async () => JSON.parse(JSON.stringify(invStore));
  inventoryRepository.ensureRowUids = async (rows) => new Map(rows.map((r) => [r.rowIndex, r.baleUid]));
}
function armQueue() {
  const calls = { appended: null, ajPatches: [], txns: [] };
  let row = null;
  inventoryRepository.transitionBales = async (pkgs, from, to, wh, opts = {}) => {
    const uidSet = Array.isArray(opts.uids) && opts.uids.length ? new Set(opts.uids.map(String)) : null;
    const set = new Set((pkgs || []).map(String));
    const rows = invStore.filter((r) => r.status === from
      && (uidSet ? uidSet.has(String(r.baleUid)) : set.has(String(r.packageNo))));
    rows.forEach((r) => { r.status = to; if (wh != null) r.warehouse = wh; });
    return rows.map((r) => ({ ...r }));
  };
  approvalQueueRepository.append = async (rec) => { calls.appended = rec; row = { ...rec, status: 'pending' }; return rec; };
  approvalQueueRepository.getByRequestId = async () => (row ? JSON.parse(JSON.stringify(row)) : null);
  approvalQueueRepository.getAllPending = async () => (row && row.status === 'pending' ? [JSON.parse(JSON.stringify(row))] : []);
  approvalQueueRepository.getAllWithRowIndex = async () => (row ? [JSON.parse(JSON.stringify({ ...row, rowIndex: 2 }))] : []);
  approvalQueueRepository.updateStatus = async (id, status) => { row.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => {
    calls.ajPatches.push(patch); row.actionJSON = { ...row.actionJSON, ...patch }; return true;
  };
  transactionsRepository.append = async (rec) => { calls.txns.push(rec); };
  return calls;
}

function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}
function hasCb(bot, data) {
  return kbTexts(bot).some((t) => t.endsWith(`|${data}`));
}

/** Admin raises a 2-bale order; Abdul accepts and ticks P1+P2. */
async function toDispatchReview() {
  seedInventory();
  const calls = armQueue();
  sessionStore.clear('777'); sessionStore.clear('abdul');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:transfer_stock', 777));
  await controller.handleCallbackQuery(bot, cb('trf:wh:1', 777));
  await controller.handleCallbackQuery(bot, cb('trf:dg:0', 777));
  await controller.handleCallbackQuery(bot, cb('trf:sh:0', 777));
  await controller.handleCallbackQuery(bot, cb('trf:qty:2', 777));
  await controller.handleCallbackQuery(bot, cb('trf:dest:0', 777));
  await controller.handleCallbackQuery(bot, cb('trf:send', 777));
  const requestId = calls.appended.requestId;
  const b2 = createFakeBot();
  await controller.handleCallbackQuery(b2, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(b2, cb('trf:bl:t:0', 'abdul'));
  await controller.handleCallbackQuery(b2, cb('trf:bl:t:1', 'abdul'));
  await controller.handleCallbackQuery(b2, cb('trf:bl:nx', 'abdul'));
  return { calls, requestId, bot: b2 };
}


/** TRF-18 — Abdul is not an admin, so his photo PARKS the package; the flip
 *  happens on the admin's ✅. Drives the approve and returns the admin bot. */
async function approveAsAdmin(requestId) {
  // The live card carries a package token derived from submittedAt.
  const row = await approvalQueueRepository.getByRequestId(requestId);
  const tok = (Date.parse(((row.actionJSON || {}).pendingDispatch || {}).submittedAt || '') || 0).toString(36);
  const ba = createFakeBot();
  await controller.handleCallbackQuery(ba, cb(`trf:adok:${requestId}:${tok}`, 777));
  return ba;
}

test('the dispatch review shows today by default with a Change date button', async () => {
  const { bot } = await toDispatchReview();
  const text = lastText(bot);
  assert.match(text, /📅 Left the store: \*.+\* \(today\)/, `date line, got: ${text}`);
  assert.ok(hasCb(bot, 'trf:dq'), 'Change date offered');
  assert.ok(hasCb(bot, 'trf:bl:go'), 'Dispatch still one tap away for the common case');
});

test('Change date opens quick chips including Today and Yesterday', async () => {
  const { bot } = await toDispatchReview();
  await controller.handleCallbackQuery(bot, cb('trf:dq', 'abdul'));
  assert.match(lastText(bot), /When did the goods leave \*?Lagos/);
  assert.ok(hasCb(bot, `trf:dd:${TODAY}`), 'Today chip');
  assert.ok(hasCb(bot, `trf:dd:${YESTERDAY}`), 'Yesterday chip');
  assert.ok(kbTexts(bot).some((t) => t.includes('trf:dm:')), 'calendar door');
});

test('picking yesterday returns to the review with the new date', async () => {
  const { bot } = await toDispatchReview();
  await controller.handleCallbackQuery(bot, cb('trf:dq', 'abdul'));
  await controller.handleCallbackQuery(bot, cb(`trf:dd:${YESTERDAY}`, 'abdul'));
  const text = lastText(bot);
  assert.match(text, /📅 Left the store: \*/);
  assert.ok(!/\(today\)/.test(text), 'no longer marked today');
  assert.ok(hasCb(bot, 'trf:bl:go'), 'back on the review screen');
});

test('the calendar grid commits on a tap and refuses a future day', async () => {
  const { bot } = await toDispatchReview();
  await controller.handleCallbackQuery(bot, cb('trf:dq', 'abdul'));
  await controller.handleCallbackQuery(bot, cb(`trf:dm:${TODAY.slice(0, 7)}`, 'abdul'));
  assert.match(lastText(bot), /Tap the day the goods left/);
  // A future ISO is refused with a reason instead of being stored.
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await controller.handleCallbackQuery(bot, cb(`trf:dd:${future}`, 'abdul'));
  assert.match(lastText(bot), /FUTURE/, 'future departure refused');
  // A valid grid day commits.
  await controller.handleCallbackQuery(bot, cb(`trf:dd:${YESTERDAY}`, 'abdul'));
  assert.ok(hasCb(bot, 'trf:bl:go'), 'committed and back on review');
});

test('a typed date only marks the day — the tap stays the commit', async () => {
  const { bot, calls } = await toDispatchReview();
  await controller.handleCallbackQuery(bot, cb('trf:dq', 'abdul'));
  const b3 = createFakeBot();
  await controller.handleMessage(b3, {
    chat: { id: 'abdul' }, from: { id: 'abdul', first_name: 'Abdul' }, text: YESTERDAY,
  });
  assert.match(lastText(b3), /You typed .* confirm it with a TAP/i);
  assert.equal(calls.ajPatches.length, 0, 'nothing dispatched by typing');
});

test('the chosen day rides the dispatch as dispatchedOn, and dispatchedAt stays', async () => {
  const { bot, calls, requestId } = await toDispatchReview();
  await controller.handleCallbackQuery(bot, cb('trf:dq', 'abdul'));
  await controller.handleCallbackQuery(bot, cb(`trf:dd:${YESTERDAY}`, 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:go', 'abdul'));
  const bp = createFakeBot();
  await controller.handleFileMessage(bp, {
    chat: { id: 'abdul' }, from: { id: 'abdul', first_name: 'Abdul' }, photo: [{ file_id: 'F1' }],
  });
  // TRF-18 — Abdul's photo parks the package for admin approval; the date he
  // picked must survive the park and ride the flip when the admin approves.
  const parked = calls.ajPatches.find((p) => p.stage === 'admin_review');
  assert.ok(parked, 'parked for admin review');
  assert.equal(parked.pendingDispatch.leftOn, YESTERDAY, 'departure date held in the package');
  const ba = await approveAsAdmin(requestId);
  const patch = calls.ajPatches.find((p) => p.stage === 'in_transit');
  assert.ok(patch, 'dispatch applied on approve');
  assert.equal(patch.dispatchedOn, YESTERDAY, 'the physical departure date is stored');
  assert.match(patch.dispatchedAt, /^\d{4}-\d{2}-\d{2}T/, 'the logging timestamp is kept too');
  // The receiver card tells Musa when the goods actually left — on APPROVE.
  const before = bp.callsTo('sendMessage').find((m) => m.args.chatId === 'musa');
  assert.ok(!before, 'receiver hears nothing while the package awaits approval');
  const rdm = ba.callsTo('sendMessage').find((m) => m.args.chatId === 'musa');
  assert.ok(rdm, 'receiver notified on approve');
  assert.match(rdm.args.text, /📅 Left Lagos: \*/, `departure on the receiver card, got: ${rdm.args.text}`);
});

test('dispatching without touching the date records today', async () => {
  const { bot, calls } = await toDispatchReview();
  await controller.handleCallbackQuery(bot, cb('trf:bl:go', 'abdul'));
  const bp = createFakeBot();
  await controller.handleFileMessage(bp, {
    chat: { id: 'abdul' }, from: { id: 'abdul', first_name: 'Abdul' }, photo: [{ file_id: 'F1' }],
  });
  const parked = calls.ajPatches.find((p) => p.stage === 'admin_review');
  await approveAsAdmin(calls.appended.requestId);
  const patch = calls.ajPatches.find((p) => p.stage === 'in_transit');
  assert.equal(parked.pendingDispatch.leftOn, TODAY, 'package holds today by default');
  assert.equal(patch.dispatchedOn, TODAY, 'default is today — zero extra taps');
});

test('the receipt Transactions row carries the physical departure date', async () => {
  const { bot, calls, requestId } = await toDispatchReview();
  await controller.handleCallbackQuery(bot, cb('trf:dq', 'abdul'));
  await controller.handleCallbackQuery(bot, cb(`trf:dd:${YESTERDAY}`, 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:go', 'abdul'));
  await controller.handleFileMessage(createFakeBot(), {
    chat: { id: 'abdul' }, from: { id: 'abdul', first_name: 'Abdul' }, photo: [{ file_id: 'F1' }],
  });
  await approveAsAdmin(requestId); // TRF-18 — nothing to receive until approved
  const br = createFakeBot();
  await controller.handleCallbackQuery(br, cb(`trf:rcv:${requestId}`, 'musa'));
  await controller.handleFileMessage(createFakeBot(), {
    chat: { id: 'musa' }, from: { id: 'musa', first_name: 'Musa' }, photo: [{ file_id: 'F2' }],
  });
  const txn = calls.txns.find((t) => t.action === 'transfer_stock');
  assert.ok(txn, 'receipt wrote a Transactions row');
  assert.equal(txn.salesDate, YESTERDAY, 'the business date is the departure date');
});
