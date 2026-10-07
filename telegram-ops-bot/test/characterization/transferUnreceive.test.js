'use strict';
/**
 * TRF-22 (owner, 07-Oct-2026) — "my manager has accepted all the bales, but
 * some of the bales did not arrive yet." A received transfer offers ↩️ Not
 * all arrived to the receiver / an admin; the received list is ticked, a
 * reason typed, TWO admins approve, exactly those bales go back on the road,
 * the transfer reopens and the receiver's card returns with the tick door.
 */
process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242,abdul,musa';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, kbTexts } = require('../helpers/charFixture');

// The queue is a real (fake) sheet so the transfer row and the reversal
// request can coexist; stock is a mutable row store.
const fakeSheets = createFakeSheets({
  ApprovalQueue: [['requestId', 'user', 'actionJSON', 'riskReason', 'status', 'createdAt', 'resolvedAt', 'approver']],
  Settings: [['key', 'value']],
});
installFakeSheets(fakeSheets);
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
const transferService = require(path.join(SRC, 'services/transferService'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
designAssetsRepo.findActive = async () => null;
auditLogRepository.append = async () => {};
const txns = [];
transactionsRepository.append = async (t) => { txns.push(t); };
telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('bytes'), mimeType: 'image/jpeg', ext: 'jpg' });
driveBackup.archiveFile = async () => ({ drive: { webViewLink: 'https://drive/xyz' }, readableName: 'file.jpg' });
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
  { user_id: '777', name: 'Ajeet', role: 'admin', status: 'active' },
  { user_id: '888', name: 'John', role: 'admin', status: 'active' },
];
let seq = 1;
const invRow = (pkg, status = 'available', wh = 'Lagos') => {
  seq += 1;
  return { rowIndex: seq, baleUid: `U-${pkg}`, packageNo: pkg, design: '9006', shade: '3', warehouse: wh, status, productType: 'fabric', yards: 100, pricePerYard: 0 };
};
const STORE = [invRow('P1'), invRow('P2'), invRow('P3'), invRow('P9', 'available', 'Kano office')];
inventoryRepository.getAll = async () => JSON.parse(JSON.stringify(STORE));
inventoryRepository.ensureRowUids = async (rows) => new Map(rows.map((r) => [r.rowIndex, r.baleUid]));
const transitions = [];
inventoryRepository.transitionBales = async (pkgs, from, to, wh, opts = {}) => {
  transitions.push({ pkgs, from, to, wh, opts });
  const uidSet = Array.isArray(opts.uids) && opts.uids.length ? new Set(opts.uids.map(String)) : null;
  const set = new Set((pkgs || []).map(String));
  const low = (v) => String(v == null ? '' : v).trim().toLowerCase();
  const rows = STORE.filter((r) => r.status === from && (uidSet ? uidSet.has(r.baleUid)
    : (set.has(r.packageNo) && (!opts.warehouse || low(r.warehouse) === low(opts.warehouse)))));
  rows.forEach((r) => { r.status = to; if (wh != null) r.warehouse = wh; });
  return rows.map((r) => ({ ...r }));
};
const txt = (text, uid) => ({ chat: { id: uid }, from: { id: uid, first_name: 'T' }, text });
const photo = (uid, fid) => ({ chat: { id: uid }, from: { id: uid, first_name: 'T' }, photo: [{ file_id: fid }] });
const byStatus = (s) => STORE.filter((r) => r.status === s).map((r) => r.packageNo);

/** Admin raises Lagos → Kano office (n fresh bales), Abdul dispatches them all, admin releases, Musa receives ALL with one tap. */
let loadNo = 0;
async function receiveAll(n = 3) {
  sessionStore.clear('777'); sessionStore.clear('abdul'); sessionStore.clear('musa');
  loadNo += 1;
  STORE.length = 0;
  for (let i = 1; i <= n; i += 1) STORE.push(invRow(`L${loadNo}B${i}`));
  STORE.push(invRow('P9', 'available', 'Kano office'));
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:transfer_stock', 777));
  await controller.handleCallbackQuery(bot, cb('trf:wh:1', 777));
  await controller.handleCallbackQuery(bot, cb('trf:dg:0', 777));
  await controller.handleCallbackQuery(bot, cb('trf:sh:0', 777));
  await controller.handleCallbackQuery(bot, cb(`trf:qty:${n}`, 777));
  await controller.handleCallbackQuery(bot, cb('trf:dest:0', 777));
  await controller.handleCallbackQuery(bot, cb('trf:send', 777));
  const requestId = (await approvalQueueRepository.getAllPending()).filter((p) => p.actionJSON.action === 'transfer_stock' && p.actionJSON.stage === 'requested').pop().requestId;
  const b2 = createFakeBot();
  await controller.handleCallbackQuery(b2, cb(`trf:acc:${requestId}`, 'abdul'));
  for (let i = 0; i < n; i += 1) await controller.handleCallbackQuery(b2, cb(`trf:bl:t:${i}`, 'abdul'));
  await controller.handleCallbackQuery(b2, cb('trf:bl:nx', 'abdul'));
  await controller.handleCallbackQuery(b2, cb('trf:bl:go', 'abdul'));
  await controller.handleFileMessage(createFakeBot(), photo('abdul', 'F1'));
  const r1 = await approvalQueueRepository.getByRequestId(requestId);
  const tok = (Date.parse(((r1.actionJSON || {}).pendingDispatch || {}).submittedAt || '') || 0).toString(36);
  await controller.handleCallbackQuery(createFakeBot(), cb(`trf:adok:${requestId}:${tok}`, 777));
  assert.equal(byStatus('in_transit').length, n);
  await controller.handleCallbackQuery(createFakeBot(), cb(`trf:rcv:${requestId}`, 'musa'));
  await controller.handleFileMessage(createFakeBot(), photo('musa', 'F2'));
  const row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.status, 'approved', 'received in one go');
  assert.equal(byStatus('available').length, n + 1);
  return requestId;
}

test('received by mistake: Musa ticks the two that never came → reason → two admins → back on the road, transfer reopened, card returns', async () => {
  const requestId = await receiveAll();
  txns.length = 0;

  // 1. the received card offers the door to the receiver
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:lcard:${requestId}`, 'musa', 5));
  assert.ok(kbTexts(bot).includes(`↩️ Not all arrived — put some back|trf:unrcv:${requestId}`), `door on the received card, got ${kbTexts(bot)}`);

  // 2. the received list, every bale UNTICKED; tick P2 and P3
  await controller.handleCallbackQuery(bot, cb(`trf:unrcv:${requestId}`, 'musa', 5));
  let kb = kbTexts(bot);
  assert.ok(kb.includes('⬜ L1B1|trf:rp:t:0') && kb.includes('⬜ L1B2|trf:rp:t:1') && kb.includes('⬜ L1B3|trf:rp:t:2'), `received list unticked, got ${kb}`);
  assert.match(bot.allText(), /which bales did NOT arrive\?/);
  const pid = sessionStore.get('musa').flowMessageId;
  await controller.handleCallbackQuery(bot, cb('trf:rp:t:1', 'musa', pid));
  await controller.handleCallbackQuery(bot, cb('trf:rp:t:2', 'musa', pid));
  kb = kbTexts(bot);
  assert.ok(kb.includes('↩️ 2 of 3 did not arrive — next|trf:rp:go'), `next button, got ${kb}`);

  // 3. reason (typed, validated) → confirm card → send
  await controller.handleCallbackQuery(bot, cb('trf:rp:go', 'musa', pid));
  assert.match(bot.allText(), /Reply with the reason/);
  await controller.handleMessage(bot, txt('no', 'musa'));
  assert.match(bot.allText(), /3 to 120 characters/);
  await controller.handleMessage(bot, txt('truck came half, 2 bales still at Lagos', 'musa'));
  assert.match(bot.allText(), /Back on the road: \*2\* bale\(s\) — L1B2, L1B3/);
  assert.match(bot.allText(), /Reason: truck came half, 2 bales still at Lagos/);
  assert.equal(transitions.filter((t) => t.to === 'in_transit' && t.from === 'available' && t.wh === null).length, 0, 'nothing moves before approval');
  await controller.handleCallbackQuery(bot, cb('trf:ur:go', 'musa', pid));
  assert.match(bot.allText(), /Sent for approval/);
  assert.equal(sessionStore.get('musa'), null);
  const req = (await approvalQueueRepository.getAllPending()).find((p) => p.actionJSON.action === 'transfer_unreceive');
  assert.ok(req, 'the reversal request is queued');
  assert.deepEqual(req.actionJSON.bales, ['L1B2', 'L1B3']);
  assert.equal(req.actionJSON.transferId, requestId);
  assert.equal(req.actionJSON.reason, 'truck came half, 2 bales still at Lagos');
  const asked = bot.callsTo('sendMessage').filter((c) => /Approval required/.test(c.args.text || '')).map((c) => String(c.args.chatId)).sort();
  assert.deepEqual(asked, ['777', '888'], 'both admins get the card');
  const card = bot.callsTo('sendMessage').find((c) => String(c.args.chatId) === '777' && /Approval required/.test(c.args.text)).args.text.replace(/\\/g, '');
  assert.match(card, /Not all arrived — .* Lagos → Kano office: 2 bale\(s\) back on the road \(L1B2, L1B3\)\. Reason: truck came half/);
  assert.match(card, /two-admin approval/);

  // 4. a second reversal on the same transfer is refused while this one waits
  const b4 = createFakeBot();
  await controller.handleCallbackQuery(b4, cb(`trf:unrcv:${requestId}`, '777', 5));
  assert.ok(b4.callsTo('answerCallbackQuery').some((c) => /already awaiting approval/.test((c.args.opts && c.args.opts.text) || '')));

  // 5. one admin is not enough; the second applies it
  const a1 = createFakeBot();
  await controller.handleCallbackQuery(a1, cb(`approve:${req.requestId}`, 777));
  assert.deepEqual(byStatus('in_transit'), [], 'one signature moves nothing');
  const a2 = createFakeBot();
  await controller.handleCallbackQuery(a2, cb(`approve:${req.requestId}`, 888));
  assert.deepEqual(byStatus('in_transit'), ['L1B2', 'L1B3'], 'exactly the two go back on the road');
  assert.deepEqual(byStatus('available').sort(), ['L1B1', 'P9']);
  assert.match(a2.allText(), /2 bale\(s\) back on the road .*: L1B2, L1B3/);
  const row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.status, 'pending', 'the transfer is open again');
  assert.equal(row.actionJSON.stage, 'in_transit');
  assert.deepEqual(row.actionJSON.receivedBales, ['L1B1']);
  assert.deepEqual(row.actionJSON.reversals[0].bales, ['L1B2', 'L1B3']);
  assert.deepEqual(transferService.receiptState(row.actionJSON).remaining, ['L1B2', 'L1B3']);
  assert.equal(txns.filter((t) => t.action === 'transfer_unreceive').length, 1, 'one correction row');
  // the receiver gets the card back, with the tick door and ✅ Received
  const back = a2.callsTo('sendMessage').find((c) => String(c.args.chatId) === 'musa' && /Not all arrived — approved/.test(c.args.text));
  assert.ok(back, 'receiver re-armed');
  const bk = back.args.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(bk.includes(`trf:rcv:${requestId}`) && bk.includes(`trf:rcvp:${requestId}`), `tick door + Received, got ${bk}`);
  assert.match(back.args.text, /1 of 3 received/);
  assert.match(back.args.text, /2 bale\(s\) put back on the road/);
  // the list shows it open again
  const l = createFakeBot();
  await controller.handleCallbackQuery(l, cb('trf:list', '777'));
  assert.match(l.allText(), /1 of 3 received/);
});

test('guards: a stranger cannot open the door; outside the window it is refused', async () => {
  const requestId = await receiveAll(2);
  const s = createFakeBot();
  await controller.handleCallbackQuery(s, cb(`trf:unrcv:${requestId}`, '4242', 5));
  assert.ok(s.callsTo('answerCallbackQuery').some((c) => /Only the receiver or an admin/.test((c.args.opts && c.args.opts.text) || '')));
  assert.equal(sessionStore.get('4242'), null);

  // the window: 1 day, and the receipt stamped 3 days ago on the sheet row
  const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
  fakeSheets._store.get('Settings').push(['TRANSFER_UNRECEIVE_DAYS', '1']);
  settingsRepository.invalidateCache();
  const qrow = fakeSheets._store.get('ApprovalQueue').find((r) => r[0] === requestId);
  qrow[6] = new Date(Date.now() - 3 * 86400000).toISOString();
  const w = createFakeBot();
  await controller.handleCallbackQuery(w, cb(`trf:unrcv:${requestId}`, 'musa', 5));
  const toast = w.callsTo('answerCallbackQuery').map((c) => (c.args.opts && c.args.opts.text) || '').join(' | ');
  assert.match(toast, /Received 3 days ago — past the 1-day window/, `got: ${toast}`);
  assert.equal(sessionStore.get('musa'), null);
  // and the received card hides the door
  const c = createFakeBot();
  await controller.handleCallbackQuery(c, cb(`trf:lcard:${requestId}`, 'musa', 5));
  assert.ok(!kbTexts(c).some((t) => t.includes('trf:unrcv:')), 'no door outside the window');
  fakeSheets._store.get('Settings').pop();
  settingsRepository.invalidateCache();
});
