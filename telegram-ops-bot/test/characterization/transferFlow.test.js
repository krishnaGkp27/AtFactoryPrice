'use strict';

/**
 * TRF-2..TRF-6 — staged warehouse transfer, end to end through the real
 * controller:
 *   admin wizard (source→design→shade→qty→dest→confirm, auto-picked people)
 *   → dispatcher Accept → bale review → MANDATORY load photo (TRF-6 gate:
 *     nothing moves and the receiver hears nothing until the photo lands)
 *   → receiver Received → MANDATORY receipt photo → bales unlocked at the
 *     destination, row closed
 * plus: decline reverts, stranger taps blocked, TRF-8 any-active-user
 * creation gate, and Check Stock shows the 🚚 in-transit line.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,5555,abdul,musa';

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

let _rowSeq = 1;
function invRow(pkg, status = 'available', wh = 'Lagos') {
  _rowSeq += 1;
  return { rowIndex: _rowSeq, baleUid: `U-${pkg}-${_rowSeq}`, packageNo: pkg, design: '9006', shade: '3', warehouse: wh, status, productType: 'fabric', yards: 100, pricePerYard: 0 };
}
// TRF-INT1 — dispatch resolves picks to rows and stores uids; keep it offline.
inventoryRepository.ensureRowUids = async (rows) => new Map(rows.map((r) => [r.rowIndex, r.baleUid]));
function seedInventory() {
  { const _rows = [
    invRow('P1'), invRow('P2'), invRow('P3'),
    invRow('P9', 'available', 'Kano office'),
  ]; inventoryRepository.getAll = async () => _rows; }
}

/** Queue stub with one mutable row; returns recorder. */
function armQueue() {
  const calls = { transitions: [], appended: null };
  let row = null;
  inventoryRepository.transitionBales = async (pkgs, from_, to, wh, opts = {}) => {
    calls.transitions.push({ pkgs, from: from_, to, wh, opts });
    const set = new Set((pkgs || []).map(String));
    const uidSet = Array.isArray(opts.uids) && opts.uids.length ? new Set(opts.uids.map(String)) : null;
    const low = (v) => String(v == null ? '' : v).trim().toLowerCase();
    const all = await inventoryRepository.getAll();
    const rows = all.filter((r) => r.status === from_
      && (uidSet ? uidSet.has(String(r.baleUid))
        : (set.has(String(r.packageNo)) && (!opts.warehouse || low(r.warehouse) === low(opts.warehouse)))));
    rows.forEach((r) => { r.status = to; if (wh != null) r.warehouse = wh; });
    return rows.map((r) => ({ ...r }));
  };
  approvalQueueRepository.append = async (rec) => { calls.appended = rec; row = { ...rec, status: 'pending' }; return rec; };
  approvalQueueRepository.getByRequestId = async () => (row ? JSON.parse(JSON.stringify(row)) : null);
  approvalQueueRepository.getAllPending = async () => (row && row.status === 'pending' ? [JSON.parse(JSON.stringify(row))] : []);
  approvalQueueRepository.updateStatus = async (id, status) => { row.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { row.actionJSON = { ...row.actionJSON, ...patch }; return true; };
  return calls;
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
  await controller.handleCallbackQuery(bot2, cb('trf:bl:t:0', 'abdul')); // tick P1
  await controller.handleCallbackQuery(bot2, cb('trf:bl:t:1', 'abdul')); // tick P2
  await controller.handleCallbackQuery(bot2, cb('trf:bl:nx', 'abdul'));  // review
  await controller.handleCallbackQuery(bot2, cb('trf:bl:go', 'abdul'));
  assert.equal(calls.transitions.length, 0, 'TRF-6: nothing moves before the load photo');
  assert.ok(!bot2.callsTo('sendMessage').some((m) => m.args.chatId === 'musa'), 'receiver hears nothing before the photo');
  assert.match(bot2.allText(), /Photo required/i);
  // The load photo lands → TRF-18 parks the package; the admin's ✅ applies
  // the dispatch and only then does the receiver DM go out.
  const bp0 = createFakeBot();
  await controller.handleFileMessage(bp0, { chat: { id: 'abdul' }, from: { id: 'abdul', first_name: 'Abdul' }, photo: [{ file_id: 'F1' }] });
  assert.equal(calls.transitions.length, 0, 'TRF-18: parked, not flipped');
  assert.ok(!bp0.callsTo('sendMessage').some((m) => m.args.chatId === 'musa'), 'receiver still hears nothing');
  const _r1 = await approvalQueueRepository.getByRequestId(requestId);
  const _t1 = (Date.parse(((_r1.actionJSON || {}).pendingDispatch || {}).submittedAt || '') || 0).toString(36);
  const bp = createFakeBot();
  await controller.handleCallbackQuery(bp, cb(`trf:adok:${requestId}:${_t1}`, 777));
  const t0 = calls.transitions[0];
  assert.deepEqual(t0.pkgs, ['P1', 'P2']);
  assert.equal(t0.from, 'available');
  assert.equal(t0.to, 'in_transit');
  assert.equal(t0.wh, 'Kano office');
  assert.equal(t0.opts.uids.length, 2, 'TRF-INT1: exact rows ride the transition');
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
  // Between order and dispatch, Lagos sold a bale: only P1 remains.
  // TRF-15 — the picker still opens (never auto-fills); Abdul ticks P1 and
  // the review flags the 1/2 shortfall.
  { const _rows = [invRow('P1'), invRow('P9', 'available', 'Kano office')]; inventoryRepository.getAll = async () => _rows; }
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bot2, cb('trf:bl:t:0', 'abdul')); // tick P1
  await controller.handleCallbackQuery(bot2, cb('trf:bl:nx', 'abdul'));  // review
  assert.match(bot2.allText(), /9006\/3: 1\/2 ⚠️ short/, 'per-line shortfall shown on review');
  await controller.handleCallbackQuery(bot2, cb('trf:bl:go', 'abdul'));
  assert.equal(calls.transitions.length, 0, 'gate: still nothing moved');
  await controller.handleFileMessage(createFakeBot(), { chat: { id: 'abdul' }, from: { id: 'abdul', first_name: 'Abdul' }, photo: [{ file_id: 'F1' }] });
  const _r1 = await approvalQueueRepository.getByRequestId(requestId);
  const _t1 = (Date.parse(((_r1.actionJSON || {}).pendingDispatch || {}).submittedAt || '') || 0).toString(36);
  const bp = createFakeBot();
  await controller.handleCallbackQuery(bp, cb(`trf:adok:${requestId}:${_t1}`, 777)); // TRF-18
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

test('TRF-8: an active employee CAN start the wizard; a stranger cannot', async () => {
  seedInventory(); armQueue();
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:transfer_stock', 4242));
  assert.match(bot.allText(), /From which warehouse\?/, 'employee reaches the source screen');
  sessionStore.clear('4242');
  // A stranger is stopped at the controller's allow-list fence.
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('act:transfer_stock', '999111'));
  assert.equal(bot2.allText(), '', 'no wizard for a stranger');
  const ack = bot2.callsTo('answerCallbackQuery')[0];
  assert.match(ack.args.opts.text, /not authorized/i);
});

test('Check Stock shows the 🚚 in-transit line at the destination', async () => {
  armQueue();
  { const _rows = [
    invRow('P1'), invRow('P2', 'in_transit', 'Kano office'), invRow('P3', 'in_transit', 'Kano office'),
  ]; inventoryRepository.getAll = async () => _rows; }
  // checkStock reads through the repo's internal (fake-sheets) path — stub
  // the availability summary; the in-transit line reads the patched getAll.
  const inventoryService = require(path.join(SRC, 'services/inventoryService'));
  inventoryService.checkStock = async () => ({ totalPackages: 1, totalThans: 1, totalYards: 100 });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('cks:9006', 777));
  assert.match(bot.allText(), /🚚 In transit \(not yet sellable\): 2 bales → Kano office/);
});

/* ── TRF-7 — dispatcher bale-number search ─────────────────────────────── */

function txt(text, uid) { return { chat: { id: uid }, from: { id: uid, first_name: 'T' }, text }; }

/** Wizard run against a 9-bale warehouse so the picker has real choice. */
async function runWizard9() {
  { const _rows = [
    ...Array.from({ length: 9 }, (_, i) => invRow(`P${i + 1}`)),
    invRow('P0', 'available', 'Kano office'),
  ]; inventoryRepository.getAll = async () => _rows; }
  const calls = armQueue();
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:transfer_stock', 777));
  await controller.handleCallbackQuery(bot, cb('trf:wh:1', 777));
  await controller.handleCallbackQuery(bot, cb('trf:dg:0', 777));
  await controller.handleCallbackQuery(bot, cb('trf:sh:0', 777));
  await controller.handleCallbackQuery(bot, cb('trf:qty:2', 777));
  await controller.handleCallbackQuery(bot, cb('trf:dest:0', 777));
  await controller.handleCallbackQuery(bot, cb('trf:send', 777));
  return { calls, requestId: calls.appended.requestId };
}

test('TRF-7: search a bale number, tick the checkbox, it joins the dispatch selection', async () => {
  const { requestId } = await runWizard9();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  assert.ok(kbTexts(bot).some((t) => t.includes('🔎 Search bale #')), 'search button on the picker');

  // TRF-15 — nothing is pre-ticked; Abdul ticks P2 from the grid himself.
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:1', 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:sr', 'abdul'));
  assert.match(bot.allText(), /Type part of the bale number/);

  // Dispatcher types a partial number → instant checkbox matches.
  await controller.handleMessage(bot, txt('8', 'abdul'));
  let boxes = kbTexts(bot);
  assert.ok(boxes.some((t) => t === '⬜ P8|trf:bl:m:0'), `unticked match shown, got ${boxes}`);

  // Tick it — joins the hand-picked P2.
  await controller.handleCallbackQuery(bot, cb('trf:bl:m:0', 'abdul'));
  boxes = kbTexts(bot);
  assert.ok(boxes.some((t) => t.startsWith('✅ P8|')), 'ticked after tap');

  // Back to the grid, then to review — the selection carries P8.
  await controller.handleCallbackQuery(bot, cb('trf:bl:bks', 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:nx', 'abdul'));
  assert.match(bot.allText(), /P2, P8/, 'review lists the searched bale');
});

test('TRF-7: no-match search explains why instead of a dead end', async () => {
  const { requestId } = await runWizard9();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:sr', 'abdul'));
  await controller.handleMessage(bot, txt('ZZZ', 'abdul'));
  // TRF-INT2 (owner rule 2) — a definite reason, not a vague shrug: ZZZ
  // matches nothing anywhere, and the search says exactly that.
  assert.match(bot.allText(), /No bale with that number exists/);
  assert.ok(kbTexts(bot).some((t) => t.includes('🔄 New search')), 'retry offered');
});
