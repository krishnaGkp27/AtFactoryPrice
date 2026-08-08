'use strict';

/**
 * TRF-4/TRF-6 — dispatcher bale picker + MANDATORY dispatch/receive photos +
 * short admin cards that expand on demand. Driven through the real controller
 * (callbacks + handleFileMessage). The Telegram download and Drive upload
 * are stubbed so the whole thing runs offline.
 *
 *   admin wizard → order → dispatcher picks EXACT bales → photo GATE
 *   (dispatch applies only when the load photo lands; archived + forwarded)
 *   → receiver confirms → photo GATE again (receipt applies on the file)
 *   → every admin card is a one-liner with a working "View details".
 *   No Skip anywhere; legacy Skip buttons answer "photos are now required".
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

let _rowSeq = 1;
function invRow(pkg, status = 'available', wh = 'Lagos') {
  _rowSeq += 1;
  return { rowIndex: _rowSeq, baleUid: `U-${pkg}-${wh.slice(0, 3)}`, packageNo: pkg, design: '9006', shade: '3', warehouse: wh, status, productType: 'fabric', yards: 100, pricePerYard: 0 };
}
// TRF-INT1 — faithful sheet model: getAll hands out fresh copies (a snapshot
// never mutates under its holder), transitionBales mutates the store and
// returns what it ACTUALLY flipped (dispatch/receive check that result).
let invStore = [];
function seedInventory() {
  // Four candidate bales in Lagos → a real choice when transferring 2.
  invStore = [
    invRow('P1'), invRow('P2'), invRow('P3'), invRow('P4'),
    invRow('P9', 'available', 'Kano office'),
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
  approvalQueueRepository.updateStatus = async (id, status) => { row.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { calls.ajPatches.push(patch); row.actionJSON = { ...row.actionJSON, ...patch }; return true; };
  return calls;
}


/** Admin creates a 2-bale order of 9006/3 Lagos → Kano office. */
async function runWizard() {
  seedInventory();
  const calls = armQueue();
  sessionStore.clear('777');
  // APC-1 Phase C — a leftover dispatcher/receiver session from an earlier
  // test would now (correctly) trip the busy guard on the next Accept.
  sessionStore.clear('abdul');
  sessionStore.clear('musa');
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


/** TRF-18 — Abdul is not an admin: his photo parks the package for admin
 *  approval and the flip happens on the admin's ✅. */
async function approveAsAdmin(requestId) {
  // The live card carries a package token derived from submittedAt.
  const row = await approvalQueueRepository.getByRequestId(requestId);
  const tok = (Date.parse(((row.actionJSON || {}).pendingDispatch || {}).submittedAt || '') || 0).toString(36);
  const ba = createFakeBot();
  await controller.handleCallbackQuery(ba, cb(`trf:adok:${requestId}:${tok}`, 777));
  return ba;
}

test('accept opens a bale picker with NOTHING pre-selected (TRF-15)', async () => {
  const { requestId } = await runWizard();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  const kb = lastKb(bot);
  // Four candidate chips, all unticked — the bot never selects bales — and
  // no Auto-pick button anywhere.
  for (let i = 0; i < 4; i += 1) {
    assert.ok(kb.some((b) => b === `P${i + 1}|trf:bl:t:${i}`), `P${i + 1} selectable, unticked`);
  }
  assert.ok(!kb.some((b) => b.startsWith('✅') && b.includes('trf:bl:t:')), 'no bale chip pre-ticked');
  assert.ok(!kb.some((b) => b.includes('trf:bl:auto')), 'no auto-pick button');
});

/** Send the gate photo for `uid`; returns the recording bot. */
async function sendPhoto(uid, fileId = 'F1') {
  const bf = createFakeBot();
  await controller.handleFileMessage(bf, {
    chat: { id: uid }, from: { id: uid, first_name: uid }, photo: [{ file_id: fileId }],
  });
  return bf;
}

test('dispatcher picks exact bales — chosen numbers dispatch once the photo lands', async () => {
  const { calls, requestId } = await runWizard();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:1', 'abdul')); // tick P2
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:3', 'abdul')); // tick P4
  await controller.handleCallbackQuery(bot, cb('trf:bl:nx', 'abdul'));  // review
  await controller.handleCallbackQuery(bot, cb('trf:bl:go', 'abdul'));  // arm photo gate
  assert.equal(calls.transitions.length, 0, 'TRF-6: no move before the photo');
  await sendPhoto('abdul');
  // TRF-18 — the photo PARKS the package; only the admin's ✅ flips stock.
  assert.equal(calls.transitions.length, 0, 'TRF-18: no move before the admin approves');
  await approveAsAdmin(requestId);
  assert.deepEqual(calls.transitions[0].pkgs, ['P2', 'P4'], 'exact chosen bales flipped in-transit');
  assert.equal(calls.transitions[0].to, 'in_transit');
});

test('dispatch photo gate: fresh bottom prompt, archive + link, forward, seal', async () => {
  const { requestId } = await runWizard();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:0', 'abdul')); // tick P1
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:1', 'abdul')); // tick P2
  await controller.handleCallbackQuery(bot, cb('trf:bl:nx', 'abdul'));  // review
  await controller.handleCallbackQuery(bot, cb('trf:bl:go', 'abdul'));
  const s = sessionStore.get('abdul');
  assert.equal(s.step, 'await_doc', 'photo gate armed');
  assert.equal(s.gate, true, 'gate flag set — file will trigger the dispatch');
  // The prompt is a FRESH message (bottom of chat), not an edit of the card.
  const prompt = bot.callsTo('sendMessage').find((m) => /Photo required/i.test(m.args.text || ''));
  assert.ok(prompt, 'prompt sent fresh');
  const promptKb = prompt.args.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(!promptKb.some((d) => d.startsWith('trf:dsk:')), 'no Skip button — photo is mandatory');
  assert.ok(promptKb.includes('trf:bl:bk'), 'Back to bales offered');

  nextArchive = { drive: { webViewLink: 'https://drive/dispatch' }, readableName: 'load.jpg' };
  const bf = await sendPhoto('abdul');
  const row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.actionJSON.dispatchDoc.url, 'https://drive/dispatch', 'link stored');
  // TRF-18 — the photo parks the package; the flip waits for the admin.
  assert.equal(row.actionJSON.stage, 'admin_review', 'parked for admin approval');
  assert.match(bf.allText(), /Dispatch photo attached/i);
  assert.ok(!sessionStore.get('abdul'), 'photo session cleared after upload');
  // NOT forwarded to the receiver while awaiting approval — admins only.
  assert.ok(!bf.callsTo('sendPhoto').some((c) => String(c.args.chatId) === 'musa'),
    'receiver sees nothing before approval');
  assert.ok(bf.callsTo('sendPhoto').some((c) => String(c.args.chatId) === '777'),
    'photo forwarded to the admin');
  // The admin got the 🛂 review card with approve/send-back.
  const review = bf.callsTo('sendMessage').find((m) => /awaiting your approval/.test(String(m.args.text)));
  assert.ok(review, 'review card sent');
  const rkb = review.args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(rkb.some((b) => String(b.callback_data).startsWith(`trf:adok:${requestId}:`)), 'approve carries the package token');
  assert.ok(rkb.some((b) => String(b.callback_data).startsWith(`trf:adrj:${requestId}:`)));
  // On approve, the receiver finally hears about it (card + photo).
  const ba = await approveAsAdmin(requestId);
  assert.ok(ba.callsTo('sendMessage').some((c) => String(c.args.chatId) === 'musa'), 'receiver card on approve');
  assert.ok(ba.callsTo('sendPhoto').some((c) => String(c.args.chatId) === 'musa'), 'photo forwarded on approve');
});

test('Back to bales from the photo gate returns to the review screen', async () => {
  const { calls, requestId } = await runWizard();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:0', 'abdul')); // tick P1
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:1', 'abdul')); // tick P2
  await controller.handleCallbackQuery(bot, cb('trf:bl:nx', 'abdul'));  // review
  await controller.handleCallbackQuery(bot, cb('trf:bl:go', 'abdul'));
  const bb = createFakeBot();
  // APC-1 Phase C — gate taps must come from the gate's own prompt card
  // (in reality the button lives there); a fixed test id now gets refused.
  const gateMsgId = sessionStore.get('abdul').flowMessageId;
  await controller.handleCallbackQuery(bb, cb('trf:bl:bk', 'abdul', gateMsgId));
  assert.equal(sessionStore.get('abdul').step, 'dispatch_confirm', 'back on the review screen');
  assert.match(bb.allText(), /dispatch 2 bale\(s\)\?/i);
  // Dispatch again + photo + approve → still exactly one transition.
  await controller.handleCallbackQuery(bb, cb('trf:bl:go', 'abdul', sessionStore.get('abdul').flowMessageId));
  await sendPhoto('abdul');
  await approveAsAdmin(requestId);
  assert.equal(calls.transitions.length, 1, 'one dispatch, no double-move');
});

test('legacy Skip button answers "photos are now required" and re-arms attach', async () => {
  const { requestId } = await runWizard();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:0', 'abdul')); // tick P1
  await controller.handleCallbackQuery(bot, cb('trf:bl:t:1', 'abdul')); // tick P2
  await controller.handleCallbackQuery(bot, cb('trf:bl:nx', 'abdul'));  // review
  await controller.handleCallbackQuery(bot, cb('trf:bl:go', 'abdul'));
  await sendPhoto('abdul'); // dispatch complete
  // An old pre-TRF-6 message still carries a Skip button — tap it.
  const bs = createFakeBot();
  await controller.handleCallbackQuery(bs, cb(`trf:dsk:d:${requestId}`, 'abdul'));
  const alert = bs.callsTo('answerCallbackQuery').find((c) => c.args.opts && c.args.opts.show_alert);
  assert.ok(alert, 'alert shown');
  assert.match(alert.args.opts.text, /now required/i);
  assert.match(bs.allText(), /Send a photo or PDF/i, 'attach prompt re-armed');
});

test('receive photo gate: receipt applies on the file, stored as receiveDoc', async () => {
  const { calls, requestId } = await runWizard();
  const bd = createFakeBot();
  await controller.handleCallbackQuery(bd, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bd, cb('trf:bl:t:0', 'abdul')); // tick P1
  await controller.handleCallbackQuery(bd, cb('trf:bl:t:1', 'abdul')); // tick P2
  await controller.handleCallbackQuery(bd, cb('trf:bl:nx', 'abdul'));  // review
  await controller.handleCallbackQuery(bd, cb('trf:bl:go', 'abdul'));
  await sendPhoto('abdul');
  await approveAsAdmin(requestId); // TRF-18 — in transit only after the ✅

  const br = createFakeBot();
  await controller.handleCallbackQuery(br, cb(`trf:rcv:${requestId}`, 'musa'));
  const s = sessionStore.get('musa');
  assert.equal(s.step, 'await_doc', 'receive photo gate armed');
  assert.equal(s.gate, true);
  assert.ok(!calls.transitions.some((t) => t.from === 'in_transit'), 'no unlock before the file');
  const promptKb = lastKb(br);
  assert.ok(promptKb.some((b) => b.includes(`trf:nn:${requestId}`)), 'Not-now escape offered');

  nextArchive = { drive: { webViewLink: 'https://drive/receipt' }, readableName: 'rcv.pdf' };
  const bf = createFakeBot();
  await controller.handleFileMessage(bf, {
    chat: { id: 'musa' }, from: { id: 'musa', first_name: 'Musa' },
    document: { file_id: 'D1', mime_type: 'application/pdf', file_name: 'rcv.pdf' },
  });
  const row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.actionJSON.receiveDoc.url, 'https://drive/receipt');
  assert.equal(row.status, 'approved', 'receipt applied by the file');
  assert.match(bf.allText(), /Receipt photo attached/i);
  assert.ok(!sessionStore.get('musa'), 'session cleared after receipt upload');
});

test('receiver "Not now" stands down: card restored, still in transit', async () => {
  const { requestId } = await runWizard();
  const bd = createFakeBot();
  await controller.handleCallbackQuery(bd, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bd, cb('trf:bl:t:0', 'abdul')); // tick P1
  await controller.handleCallbackQuery(bd, cb('trf:bl:t:1', 'abdul')); // tick P2
  await controller.handleCallbackQuery(bd, cb('trf:bl:nx', 'abdul'));  // review
  await controller.handleCallbackQuery(bd, cb('trf:bl:go', 'abdul'));
  await sendPhoto('abdul');
  await approveAsAdmin(requestId); // TRF-18

  const br = createFakeBot();
  await controller.handleCallbackQuery(br, cb(`trf:rcv:${requestId}`, 'musa'));
  const bn = createFakeBot();
  await controller.handleCallbackQuery(bn, cb(`trf:nn:${requestId}`, 'musa'));
  assert.ok(!sessionStore.get('musa'), 'gate session cleared');
  const kb = lastKb(bn);
  assert.ok(kb.some((b) => b.includes(`trf:rcv:${requestId}`)), 'Received button restored');
  const row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.status, 'pending', 'nothing confirmed');
  assert.equal(row.actionJSON.stage, 'in_transit', 'still in transit');
});

test('admin short card expands to full detail then collapses', async () => {
  const { requestId } = await runWizard();
  const bd = createFakeBot();
  await controller.handleCallbackQuery(bd, cb(`trf:acc:${requestId}`, 'abdul'));
  await controller.handleCallbackQuery(bd, cb('trf:bl:t:0', 'abdul')); // tick P1
  await controller.handleCallbackQuery(bd, cb('trf:bl:t:1', 'abdul')); // tick P2
  await controller.handleCallbackQuery(bd, cb('trf:bl:nx', 'abdul'));  // review
  await controller.handleCallbackQuery(bd, cb('trf:bl:go', 'abdul'));
  await sendPhoto('abdul');
  const bp = await approveAsAdmin(requestId); // TRF-18 — the brief rides the approve

  // The approving admin was the only admin, so the brief is the EDIT of
  // their own review card into the dispatched state (notifyAdmins excludes
  // the actor).
  const adminCard = bp.callsTo('editMessageText').find((m) => /approved by you, dispatched/i.test(String(m.args.text)));
  assert.ok(adminCard, 'admin briefed on dispatch');
  const kb = adminCard.args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === `trf:info:${requestId}`), 'View details offered');

  // Expand.
  const bi = createFakeBot();
  await controller.handleCallbackQuery(bi, cb(`trf:info:${requestId}`, 777));
  const expand = bi.callsTo('editMessageText').pop();
  assert.match(expand.args.text, /Dispatcher: Abdul/);
  // TRF-12 — bale numbers ride each row in brackets; the flat "Bales:" line
  // is gone (the 📦 chip shows the full list on tap).
  assert.match(expand.args.text, /×\d+ \(/, `per-row bale brackets, got:\n${expand.args.text}`);
  assert.ok(!expand.args.text.includes('Bales:'), 'flat list removed');
  const expandKb = expand.args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(expandKb.some((b) => b.callback_data === `trf:bn:${requestId}`), 'bale chip on the expander');
  assert.ok(expandKb.some((b) => b.callback_data === `trf:less:${requestId}`), 'collapse offered');

  // Collapse.
  const bc = createFakeBot();
  await controller.handleCallbackQuery(bc, cb(`trf:less:${requestId}`, 777));
  const collapsed = bc.callsTo('editMessageText').pop();
  assert.ok(collapsed.args.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === `trf:info:${requestId}`), 'expand offered again');
});
