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
  // TRF-20 — createTransferRequest writes through appendOnce, whose internal
  // call binds to the module's own append; mirror it here so the stub sees it.
  approvalQueueRepository.appendOnce = async (rec) => {
    const existing = await approvalQueueRepository.getByRequestId(rec.requestId);
    if (existing) return { created: false, existing };
    await approvalQueueRepository.append(rec);
    return { created: true, existing: null };
  };
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
  assert.match(bot.allText(), /🚚 In transit 2B → Kano office/);
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

/* ── TRF-21 — the goods arrive in more than one batch (owner, 30-Sep-2026) ─ */

/** Wizard + Abdul dispatches P1 and P2 + admin releases it: the load is on the road. */
async function dispatchTwo() {
  // Earlier tests leave Abdul mid-pick on another transfer; the APC-1 busy
  // guard would otherwise answer Accept with the continue/drop prompt.
  sessionStore.clear('abdul'); sessionStore.clear('musa');
  const { calls, requestId } = await runWizard();
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bot2, cb('trf:bl:t:0', 'abdul'));
  await controller.handleCallbackQuery(bot2, cb('trf:bl:t:1', 'abdul'));
  await controller.handleCallbackQuery(bot2, cb('trf:bl:nx', 'abdul'));
  await controller.handleCallbackQuery(bot2, cb('trf:bl:go', 'abdul'));
  await controller.handleFileMessage(createFakeBot(), { chat: { id: 'abdul' }, from: { id: 'abdul', first_name: 'Abdul' }, photo: [{ file_id: 'F1' }] });
  const r1 = await approvalQueueRepository.getByRequestId(requestId);
  const t1 = (Date.parse(((r1.actionJSON || {}).pendingDispatch || {}).submittedAt || '') || 0).toString(36);
  const bp = createFakeBot();
  await controller.handleCallbackQuery(bp, cb(`trf:adok:${requestId}:${t1}`, 777));
  const rdm = bp.callsTo('sendMessage').find((m) => m.args.chatId === 'musa');
  return { calls, requestId, receiverKb: rdm.args.opts.reply_markup.inline_keyboard.flat() };
}

test('TRF-21: only P1 arrives — Musa ticks it, sends the photo, P1 goes live, P2 stays on the road, the transfer stays open', async () => {
  const { calls, requestId, receiverKb } = await dispatchTwo();
  assert.ok(receiverKb.some((b) => b.callback_data === `trf:rcvp:${requestId}`), 'the receiver card offers the "only some arrived" door');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:rcvp:${requestId}`, 'musa'));
  // Review (30-Sep) — the picker is its own message; the card (msg 5) keeps its buttons.
  const pid = sessionStore.get('musa').flowMessageId;
  assert.ok(pid && pid !== 5, 'picker sent as a fresh message');
  assert.ok(!bot.callsTo('editMessageText').some((m) => m.args.opts.message_id === 5), 'the receiver card was not touched');
  let kb = kbTexts(bot);
  assert.ok(kb.includes('⬜ P1|trf:rp:t:0') && kb.includes('⬜ P2|trf:rp:t:1'), `every outstanding bale UNTICKED (§2), got ${kb}`);
  assert.ok(!kb.some((t) => t.includes('trf:rp:go')), 'no Confirm button before a human ticks');
  assert.match(bot.allText(), /which bales are here now\?/);
  assert.match(bot.allText(), /9006 · Shade 3: P1, P2/, 'the text says which design each number is');
  await controller.handleCallbackQuery(bot, cb('trf:rp:t:0', 'musa', pid));
  kb = kbTexts(bot);
  assert.ok(kb.includes('✅ P1|trf:rp:t:0'), 'ticked');
  assert.ok(kb.includes('✅ Confirm 1 of 2 arrived|trf:rp:go'));
  await controller.handleCallbackQuery(bot, cb('trf:rp:go', 'musa', pid));
  assert.ok(!calls.transitions.some((t) => t.from === 'in_transit'), 'TRF-6: nothing flips before the receipt photo');
  assert.match(bot.allText(), /Photo required/);
  assert.match(bot.allText(), /1 bale\(s\) received now \(P1\)/);
  assert.match(bot.allText(), /the other 1 stay on the road/);
  const br = createFakeBot();
  await controller.handleFileMessage(br, { chat: { id: 'musa' }, from: { id: 'musa', first_name: 'Musa' }, photo: [{ file_id: 'F2' }] });
  const unlock = calls.transitions.filter((t) => t.from === 'in_transit' && t.to === 'available');
  assert.equal(unlock.length, 1);
  assert.deepEqual(unlock[0].pkgs, ['P1']);
  assert.equal(unlock[0].opts.uids.length, 1, 'only P1\'s row flips');
  const row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.status, 'pending', 'the transfer stays open for P2');
  assert.equal(row.actionJSON.stage, 'in_transit');
  assert.deepEqual(row.actionJSON.receivedBales, ['P1']);
  assert.equal(row.actionJSON.receipts.length, 1);
  assert.ok(row.actionJSON.receipts[0].doc && row.actionJSON.receipts[0].doc.fileId === 'F2', 'the photo is stamped on its delivery');
  assert.match(br.allText(), /1 of 2 received/);
  assert.match(br.allText(), /P1 now live at \*Kano office\*; 1 still on the road/);
  // The picker seal is gone and the receiver's card (msg 5) is redrawn live, buttons included.
  assert.ok(br.callsTo('deleteMessage').some((m) => m.args.messageId === pid), 'picker message deleted');
  const cardEdit = br.callsTo('editMessageText').find((m) => m.args.opts.message_id === 5);
  assert.ok(cardEdit, 'receiver card redrawn in place');
  assert.match(cardEdit.args.text, /1 of 2 received\* · 🚚 1 still on the road \(P2\)/);
  assert.ok(cardEdit.args.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === `trf:rcv:${requestId}`), 'card keeps ✅ Received');
  const admin = br.callsTo('sendMessage').find((m) => String(m.args.chatId) === '777');
  assert.ok(admin && /partly received 📦 \(1 of 2\)/.test(admin.args.text), 'admins hear it is partly received');
  const disp = br.callsTo('sendMessage').find((m) => String(m.args.chatId) === 'abdul');
  assert.ok(disp && /This delivery: P1/.test(disp.args.text), 'the dispatcher hears which bales landed');
  const photo = br.callsTo('sendPhoto').find((m) => String(m.args.chatId) === '777');
  assert.match(photo.args.opts.caption, /delivery 1: P1/);
  const inv = await inventoryRepository.getAll();
  assert.equal(inv.find((r) => r.packageNo === 'P1').status, 'available');
  assert.equal(inv.find((r) => r.packageNo === 'P2').status, 'in_transit');
  assert.ok(!sessionStore.get('musa'), 'gate session cleared');

  // The card now reads the state; ✅ Received confirms the rest.
  const bc = createFakeBot();
  await controller.handleCallbackQuery(bc, cb(`trf:card:${requestId}`, 'musa'));
  assert.match(bc.allText(), /1 of 2 received\* · 🚚 1 still on the road \(P2\)/);
  assert.match(bc.allText(), /P1 ✅, P2/, 'received bales are ticked in the line');
  assert.match(bc.allText(), /With Musa to confirm the rest\* · 1 of 2 received/);
  assert.ok(!kbTexts(bc).some((t) => t.includes('trf:rcvp:')), 'one bale left — no "only some" door (a single option is navigation)');
  await controller.handleCallbackQuery(bc, cb(`trf:rcv:${requestId}`, 'musa'));
  assert.match(bc.allText(), /the remaining 1 bale\(s\)/);
  const br2 = createFakeBot();
  await controller.handleFileMessage(br2, { chat: { id: 'musa' }, from: { id: 'musa', first_name: 'Musa' }, photo: [{ file_id: 'F3' }] });
  const row2 = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row2.status, 'approved', 'the last bale closes the transfer');
  assert.deepEqual(row2.actionJSON.receivedBales, ['P1', 'P2']);
  assert.equal(row2.actionJSON.receipts.length, 2);
  assert.match(br2.allText(), /received\* — bales are now live at \*Kano office\* \(in 2 deliveries\)/);
  const unlock2 = calls.transitions.filter((t) => t.from === 'in_transit' && t.to === 'available');
  assert.equal(unlock2.length, 2);
  assert.deepEqual(unlock2[1].pkgs, ['P2']);
});

test('TRF-21: a receipt with everything ticked is today\'s receipt; ↩ Not now on the picker drops the ticks', async () => {
  const { calls, requestId } = await dispatchTwo();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:rcvp:${requestId}`, 'musa'));
  let pid = sessionStore.get('musa').flowMessageId;
  await controller.handleCallbackQuery(bot, cb('trf:rp:t:1', 'musa', pid));
  // A stale copy's ↩ Not now (another message id) must not wipe the live ticks.
  await controller.handleCallbackQuery(bot, cb(`trf:rp:nn:${requestId}`, 'musa', 4));
  assert.deepEqual(sessionStore.get('musa')._rcvSel, ['P2'], 'live picker untouched by a stale Not now');
  await controller.handleCallbackQuery(bot, cb(`trf:rp:nn:${requestId}`, 'musa', pid));
  assert.ok(!sessionStore.get('musa'), 'ticks dropped');
  assert.ok(bot.callsTo('deleteMessage').some((m) => m.args.messageId === pid), 'picker message deleted');
  const back = bot.callsTo('editMessageText').filter((m) => m.args.opts.message_id === 5).pop();
  assert.ok(back && /Transfer .* incoming/.test(back.args.text), 'the receiver card is redrawn where it stands');
  // Opened from a card that carried ⬅ Back (🛂 inbox / 📋 list): Not now
  // restores the card WITH that Back.
  const fromList = cb(`trf:rcvp:${requestId}`, 'musa');
  fromList.message.reply_markup = { inline_keyboard: [[{ text: '⬅ Back', callback_data: 'trf:list' }]] };
  await controller.handleCallbackQuery(bot, fromList);
  pid = sessionStore.get('musa').flowMessageId;
  await controller.handleCallbackQuery(bot, cb(`trf:rp:nn:${requestId}`, 'musa', pid));
  assert.ok(kbTexts(bot).includes('⬅ Back|trf:list'), `Back survives the picker round-trip, got ${kbTexts(bot)}`);
  // Second attempt: tick both → same as ✅ Received.
  await controller.handleCallbackQuery(bot, cb(`trf:rcvp:${requestId}`, 'musa'));
  pid = sessionStore.get('musa').flowMessageId;
  await controller.handleCallbackQuery(bot, cb('trf:rp:t:0', 'musa', pid));
  await controller.handleCallbackQuery(bot, cb('trf:rp:t:1', 'musa', pid));
  assert.ok(kbTexts(bot).includes('✅ Confirm 2 of 2 arrived|trf:rp:go'));
  await controller.handleCallbackQuery(bot, cb('trf:rp:go', 'musa', pid));
  const br = createFakeBot();
  await controller.handleFileMessage(br, { chat: { id: 'musa' }, from: { id: 'musa', first_name: 'Musa' }, photo: [{ file_id: 'F2' }] });
  const row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.status, 'approved');
  assert.equal(row.actionJSON.receivedBales, undefined, 'a single all-at-once receipt writes no delivery record');
  const unlock = calls.transitions.find((t) => t.from === 'in_transit' && t.to === 'available');
  assert.deepEqual(unlock.pkgs, ['P1', 'P2']);
  assert.match(br.allText(), /received\* — bales are now live at \*Kano office\*\./);
});

test('TRF-21: reject after a partial delivery sends back only P2; P1 stays live at the destination', async () => {
  const { calls, requestId } = await dispatchTwo();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:rcvp:${requestId}`, 'musa'));
  const pid = sessionStore.get('musa').flowMessageId;
  await controller.handleCallbackQuery(bot, cb('trf:rp:t:0', 'musa', pid));
  await controller.handleCallbackQuery(bot, cb('trf:rp:go', 'musa', pid));
  await controller.handleFileMessage(createFakeBot(), { chat: { id: 'musa' }, from: { id: 'musa', first_name: 'Musa' }, photo: [{ file_id: 'F2' }] });
  const bj = createFakeBot();
  await controller.handleCallbackQuery(bj, cb(`trf:rej:${requestId}`, 'musa'));
  assert.match(bj.allText(), /return 1 bale\(s\) to \*Lagos\*/);
  assert.match(bj.allText(), /The 1 bale\(s\) already received stay at \*Kano office\*/);
  await controller.handleCallbackQuery(bj, cb(`trf:rejc:${requestId}`, 'musa'));
  const home = calls.transitions.filter((t) => t.from === 'in_transit' && t.wh === 'Lagos');
  assert.equal(home.length, 1);
  assert.deepEqual(home[0].pkgs, ['P2']);
  assert.match(bj.allText(), /1 bale\(s\) reverted to \*Lagos\*\. 1 bale\(s\) received earlier stay at \*Kano office\*/);
  const inv = await inventoryRepository.getAll();
  assert.equal(inv.find((r) => r.packageNo === 'P1').warehouse, 'Kano office');
  assert.equal(inv.find((r) => r.packageNo === 'P1').status, 'available');
  assert.equal(inv.find((r) => r.packageNo === 'P2').warehouse, 'Lagos');
  const row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.status, 'rejected');
  // The closed record says what stayed and what went home, on every surface.
  const bd = createFakeBot();
  await controller.handleCallbackQuery(bd, cb(`trf:info:${requestId}`, 777));
  assert.match(bd.allText(), /1 bale\(s\) back at Lagos · 1 kept at Kano office/);
  assert.match(bd.allText(), /1 received\* at Kano office · ↩ 1 returned to Lagos/);
  assert.doesNotMatch(bd.allText(), /still on the road/);
});

test('TRF-21: ↩ Not now on the photo prompt after a picker Confirm drops the prompt and the seal, redraws the card', async () => {
  const { calls, requestId } = await dispatchTwo();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:rcvp:${requestId}`, 'musa'));
  const pid = sessionStore.get('musa').flowMessageId;
  await controller.handleCallbackQuery(bot, cb('trf:rp:t:0', 'musa', pid));
  await controller.handleCallbackQuery(bot, cb('trf:rp:go', 'musa', pid));
  const promptId = sessionStore.get('musa').flowMessageId;
  assert.ok(promptId && promptId !== pid && promptId !== 5, 'the photo prompt is a fresh message');
  const bn = createFakeBot();
  await controller.handleCallbackQuery(bn, cb(`trf:nn:${requestId}`, 'musa', promptId));
  assert.ok(!sessionStore.get('musa'), 'gate stood down');
  const deleted = bn.callsTo('deleteMessage').map((m) => m.args.messageId);
  assert.ok(deleted.includes(promptId) && deleted.includes(pid), `prompt and picker seal deleted, got ${deleted}`);
  const cardEdit = bn.callsTo('editMessageText').find((m) => m.args.opts.message_id === 5);
  assert.ok(cardEdit && /Transfer .* incoming/.test(cardEdit.args.text), 'the receiver card is redrawn where it stands');
  assert.ok(cardEdit.args.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === `trf:rcvp:${requestId}`), 'with its buttons');
  assert.ok(!calls.transitions.some((t) => t.from === 'in_transit'), 'nothing received');
  // The plain ✅ Received gate (no picker) keeps the old behaviour: the prompt turns back into the card.
  const bp = createFakeBot();
  await controller.handleCallbackQuery(bp, cb(`trf:rcv:${requestId}`, 'musa', 5));
  const prompt2 = sessionStore.get('musa').flowMessageId;
  const bn2 = createFakeBot();
  await controller.handleCallbackQuery(bn2, cb(`trf:nn:${requestId}`, 'musa', prompt2));
  assert.equal(bn2.callsTo('deleteMessage').length, 0, 'no picker — nothing to delete');
  const back = bn2.callsTo('editMessageText').find((m) => m.args.opts.message_id === prompt2);
  assert.ok(back && /Transfer .* incoming/.test(back.args.text), 'the prompt becomes the card again');
  sessionStore.clear('musa');
});

test('TRF-21: a stranger cannot open the arrival picker; a stale picker card cannot tick into a newer one', async () => {
  const { requestId } = await dispatchTwo();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:rcvp:${requestId}`, '5555'));
  assert.match(bot.callsTo('answerCallbackQuery')[0].args.opts.text, /assigned person only/i);
  assert.ok(!sessionStore.get('5555'));
  // Musa opens the picker on message 5; a tap from an older card (message 4) is refused.
  const bm = createFakeBot();
  await controller.handleCallbackQuery(bm, cb(`trf:rcvp:${requestId}`, 'musa', 5));
  await controller.handleCallbackQuery(bm, cb('trf:rp:t:0', 'musa', 4));
  assert.match(bm.allText(), /belongs to an earlier step/);
  assert.deepEqual(sessionStore.get('musa')._rcvSel, [], 'nothing ticked from the stale card');
  const pid = sessionStore.get('musa').flowMessageId;
  await controller.handleCallbackQuery(bm, cb('trf:rp:t:0', 'musa', pid));
  assert.deepEqual(sessionStore.get('musa')._rcvSel, ['P1'], 'the live picker ticks');
  sessionStore.clear('musa');
});
