'use strict';
/**
 * TRF-22 (owner, 07-Oct-2026) — the receipt gate, end to end through the
 * real controller: the receiver reports with the document, nothing moves,
 * the admins get the transfer card with 🛂 Confirm Receipt n and the PDF,
 * the drill-down shows that delivery, ↩️ Send back returns the card with a
 * reason, ✅ Confirm flips exactly the reported bales; the row stays yellow
 * until the last delivery; one dispatch document, one receipt document per
 * report, all on one card.
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
telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('bytes'), mimeType: 'application/pdf', ext: 'pdf' });
driveBackup.archiveFile = async () => ({ drive: { webViewLink: 'https://drive/xyz' }, readableName: 'file.pdf' });
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
  { user_id: '777', name: 'Ajeet', role: 'admin', status: 'active' },
  { user_id: '888', name: 'John', role: 'admin', status: 'active' },
];
let seq = 1;
const invRow = (pkg, status = 'available', wh = 'Lagos') => { seq += 1; return { rowIndex: seq, baleUid: `U-${pkg}`, packageNo: pkg, design: '9006', shade: '3', warehouse: wh, status, productType: 'fabric', yards: 100, pricePerYard: 0 }; };
const STORE = [];
inventoryRepository.getAll = async () => JSON.parse(JSON.stringify(STORE));
inventoryRepository.ensureRowUids = async (rows) => new Map(rows.map((r) => [r.rowIndex, r.baleUid]));
const transitions = [];
inventoryRepository.transitionBales = async (pkgs, from, to, wh, opts = {}) => {
  transitions.push({ pkgs, from, to, wh, opts });
  const uidSet = Array.isArray(opts.uids) && opts.uids.length ? new Set(opts.uids.map(String)) : null;
  const set = new Set((pkgs || []).map(String));
  const low = (v) => String(v == null ? '' : v).trim().toLowerCase();
  const rows = STORE.filter((r) => r.status === from && (uidSet ? uidSet.has(r.baleUid) : (set.has(r.packageNo) && (!opts.warehouse || low(r.warehouse) === low(opts.warehouse)))));
  rows.forEach((r) => { r.status = to; if (wh != null) r.warehouse = wh; });
  return rows.map((r) => ({ ...r }));
};
const txt = (text, uid) => ({ chat: { id: uid }, from: { id: uid, first_name: 'T' }, text });
const pdf = (uid, fid) => ({ chat: { id: uid }, from: { id: uid, first_name: 'T' }, document: { file_id: fid, mime_type: 'application/pdf', file_name: `${fid}.pdf` } });
const byStatus = (s) => STORE.filter((r) => r.status === s).map((r) => r.packageNo).sort();
const flips = () => transitions.filter((t) => t.from === 'in_transit' && t.to === 'available');

/** Admin raises Lagos → Kano office (3 fresh bales), Abdul dispatches, admin releases: the load is on the road. */
let loadNo = 0;
async function onTheRoad(n = 3) {
  sessionStore.clear('777'); sessionStore.clear('888'); sessionStore.clear('abdul'); sessionStore.clear('musa');
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
  await controller.handleFileMessage(createFakeBot(), { chat: { id: 'abdul' }, from: { id: 'abdul', first_name: 'Abdul' }, photo: [{ file_id: 'F1' }] });
  const r1 = await approvalQueueRepository.getByRequestId(requestId);
  const tok = (Date.parse(((r1.actionJSON || {}).pendingDispatch || {}).submittedAt || '') || 0).toString(36);
  await controller.handleCallbackQuery(createFakeBot(), cb(`trf:adok:${requestId}:${tok}`, 777));
  assert.equal(byStatus('in_transit').length, n);
  return requestId;
}

test('report (two bales + PDF) → nothing moves, admins get the card with 🛂 Confirm Receipt 1 and the PDF; Musa\'s card is frozen; the row is yellow with the badge', async () => {
  const requestId = await onTheRoad(3);
  txns.length = 0; transitions.length = 0;
  const bot = createFakeBot();
  // Musa ticks L1B1 + L1B2 and sends the receipt PDF
  await controller.handleCallbackQuery(bot, cb(`trf:rcvp:${requestId}`, 'musa', 5));
  const pid = sessionStore.get('musa').flowMessageId;
  await controller.handleCallbackQuery(bot, cb('trf:rp:t:0', 'musa', pid));
  await controller.handleCallbackQuery(bot, cb('trf:rp:t:1', 'musa', pid));
  await controller.handleCallbackQuery(bot, cb('trf:rp:go', 'musa', pid));
  await controller.handleFileMessage(bot, pdf('musa', 'PDF1'));
  assert.equal(flips().length, 0, 'nothing flips on a report');
  assert.deepEqual(byStatus('in_transit'), ['L1B1', 'L1B2', 'L1B3']);
  const row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.status, 'pending');
  assert.equal(row.actionJSON.pendingReceipt, 1);
  assert.deepEqual(row.actionJSON.receiptReports[0].bales, ['L1B1', 'L1B2']);
  assert.equal(row.actionJSON.receiptReports[0].doc.fileId, 'PDF1', 'the PDF belongs to receipt 1');
  assert.match(bot.allText(), /receipt 1 reported[\s\S]*With the admins to confirm/);
  // both admins: the PDF and the card with the confirm button
  for (const a of ['777', '888']) {
    assert.ok(bot.callsTo('sendDocument').some((c) => String(c.args.chatId) === a && c.args.doc === 'PDF1'), `${a} got the PDF`);
    const card = bot.callsTo('sendMessage').find((c) => String(c.args.chatId) === a && /Receipt 1 to confirm/.test(c.args.text));
    assert.ok(card, `${a} got the review card`);
    const kb = card.args.opts.reply_markup.inline_keyboard.flat().map((b) => `${b.text}|${b.callback_data}`);
    assert.ok(kb.includes(`🛂 Confirm Receipt 1|trf:rcok:${requestId}:1`), `confirm button, got ${kb}`);
    assert.ok(kb.includes(`📎 Receipt 1|trf:vd:r:${requestId}:1`), 'the receipt document chip');
    assert.match(card.args.text, /L1B1 🛂, L1B2 🛂, L1B3\)/, 'per-bale marks');
    assert.match(card.args.text, /📎 Receipt 1 · Musa · .* · L1B1, L1B2 · 🛂 awaiting an admin/);
  }
  // Musa's own card: frozen
  const m = createFakeBot();
  await controller.handleCallbackQuery(m, cb(`trf:card:${requestId}`, 'musa', 5));
  assert.match(m.allText(), /Receipt 1 \(L1B1, L1B2\) is with the admins to confirm/);
  assert.ok(!kbTexts(m).some((t) => t.includes('trf:rcv:') || t.includes('trf:rcvp:')), 'no Received / tick door while a receipt waits');
  const again = createFakeBot();
  await controller.handleCallbackQuery(again, cb(`trf:rcv:${requestId}`, 'musa', 5));
  assert.ok(again.callsTo('answerCallbackQuery').some((c) => /Receipt 1 is with the admins/.test((c.args.opts && c.args.opts.text) || '')));
  // the list
  const l = createFakeBot();
  await controller.handleCallbackQuery(l, cb('trf:list', '777'));
  assert.match(l.allText(), /🛂 receipt 1 awaiting admin/);
  assert.match(l.allText(), /waiting on an admin/);
  assert.ok(kbTexts(l).some((t) => t.includes('🟡') && t.includes(`trf:lcard:${requestId}`)), 'the row stays yellow');
});

test('the admin taps the row → the card with 🛂 Confirm Receipt 1 → the drill-down → ↩️ Send back with a reason → Musa gets the card back; then a fresh report and ✅ Confirm flips exactly those bales', async () => {
  // four bales: a different load from the first test's (TRF-20 refuses an identical open one)
  const requestId = await onTheRoad(4);
  txns.length = 0; transitions.length = 0;
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`trf:rcvp:${requestId}`, 'musa', 5));
  const pid = sessionStore.get('musa').flowMessageId;
  await controller.handleCallbackQuery(bot, cb('trf:rp:t:0', 'musa', pid));
  await controller.handleCallbackQuery(bot, cb('trf:rp:t:1', 'musa', pid));
  await controller.handleCallbackQuery(bot, cb('trf:rp:go', 'musa', pid));
  await controller.handleFileMessage(bot, pdf('musa', 'PDF1'));

  // 1. the admin's card from the list
  const a = createFakeBot();
  await controller.handleCallbackQuery(a, cb(`trf:lcard:${requestId}`, '777', 9));
  assert.ok(kbTexts(a).includes(`🛂 Confirm Receipt 1|trf:rcok:${requestId}:1`), `got ${kbTexts(a)}`);
  assert.match(a.allText(), /Receipt 1 with the admins to confirm\* · reported by Musa/);
  // 2. the drill-down: this delivery, after-this line, the PDF beneath
  await controller.handleCallbackQuery(a, cb(`trf:rcok:${requestId}:1`, '777', 9));
  const drill = a.callsTo('editMessageText').at(-1).args.text;
  assert.match(drill, /📥 \*Receipt 1 of .* — to confirm\*/);
  assert.match(drill, /This delivery \(2\):\n • L2B1 · 9006 · Shade 3\n • L2B2 · 9006 · Shade 3/);
  assert.match(drill, /After this: 2 of 4 received — 2 still on the road/);
  assert.ok(a.callsTo('sendDocument').some((c) => c.args.doc === 'PDF1'), 'the PDF is delivered beneath the card');
  assert.deepEqual(kbTexts(a).map((t) => t.split('|')[0]), ['✅ Confirm receipt', '↩️ Send back', '⬅ Back to the transfer']);
  // 3. send back with a reason
  await controller.handleCallbackQuery(a, cb(`trf:rcno:${requestId}:1`, '777', 9));
  assert.match(a.callsTo('editMessageText').at(-1).args.text, /Why\? Reply in one line/);
  await controller.handleMessage(a, txt('bale L2B2 is not in the warehouse, only its label', '777'));
  assert.equal(flips().length, 0, 'nothing moved');
  assert.match(a.callsTo('editMessageText').at(-1).args.text, /Receipt 1 of .* — sent back by you\*\nReason: bale L2B2 is not in the warehouse/);
  const back = a.callsTo('sendMessage').find((c) => String(c.args.chatId) === 'musa');
  assert.ok(back, 'Musa has the card back');
  assert.match(back.args.text, /sent back by Ajeet\*\nReason: bale L2B2/);
  const bk = back.args.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(bk.includes(`trf:rcv:${requestId}`) && bk.includes(`trf:rcvp:${requestId}`), 'Received and the tick door are back');
  let row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.actionJSON.pendingReceipt, null);
  assert.equal(row.actionJSON.receiptReports[0].status, 'sent_back');

  // 4. Musa reports again (one bale) with a second PDF; John confirms
  const b = createFakeBot();
  await controller.handleCallbackQuery(b, cb(`trf:rcvp:${requestId}`, 'musa', 5));
  const pid2 = sessionStore.get('musa').flowMessageId;
  await controller.handleCallbackQuery(b, cb('trf:rp:t:0', 'musa', pid2));
  await controller.handleCallbackQuery(b, cb('trf:rp:go', 'musa', pid2));
  await controller.handleFileMessage(b, pdf('musa', 'PDF2'));
  row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.actionJSON.pendingReceipt, 2, 'a sent-back report keeps its number; the new one is 2');
  const j = createFakeBot();
  await controller.handleCallbackQuery(j, cb(`trf:rcyes:${requestId}:2`, '888', 11));
  assert.deepEqual(byStatus('available'), ['L2B1', 'P9'], 'exactly the reported bale flipped');
  assert.deepEqual(byStatus('in_transit'), ['L2B2', 'L2B3', 'L2B4']);
  assert.equal(flips().length, 1);
  row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.status, 'pending', 'still yellow');
  assert.deepEqual(row.actionJSON.receivedBales, ['L2B1']);
  assert.equal(row.actionJSON.receiptReports[1].confirmedBy, '888');
  assert.equal(row.actionJSON.receipts[0].doc.fileId, 'PDF2', 'the report\'s PDF is stamped on the delivery');
  assert.equal(txns.length, 1, 'one Transactions row per confirmed delivery');
  const musa = j.callsTo('sendMessage').find((c) => String(c.args.chatId) === 'musa');
  assert.match(musa.args.text, /receipt 2 confirmed by John\*[\s\S]*L2B1 now live at \*Kano office\* · 3 still on the road/);
  assert.ok(musa.args.opts.reply_markup.inline_keyboard.flat().some((x) => x.callback_data === `trf:rcvp:${requestId}`), 'the tick door is back for the next delivery');
  const other = j.callsTo('sendMessage').find((c) => String(c.args.chatId) === '777');
  assert.match(other.args.text, /partly received 📦 \(1 of 4\) · receipt 2 confirmed by John/);
  // the same card, now the transfer after the confirmation
  assert.match(j.callsTo('editMessageText').at(-1).args.text, /L2B1 ✅/);
  assert.match(j.callsTo('editMessageText').at(-1).args.text, /1 of 4 received/);

  // 5. the rest arrives: ✅ Received (everything) + PDF → Ajeet confirms → green, closed, two documents
  const c = createFakeBot();
  await controller.handleCallbackQuery(c, cb(`trf:rcv:${requestId}`, 'musa', 5));
  await controller.handleFileMessage(c, pdf('musa', 'PDF3'));
  assert.equal(byStatus('in_transit').length, 3, 'still waiting for the admin');
  const k = createFakeBot();
  await controller.handleCallbackQuery(k, cb(`trf:rcyes:${requestId}:3`, '777', 12));
  row = await approvalQueueRepository.getByRequestId(requestId);
  assert.equal(row.status, 'approved', 'every bale confirmed — closed');
  assert.deepEqual(byStatus('available'), ['L2B1', 'L2B2', 'L2B3', 'L2B4', 'P9']);
  assert.deepEqual(row.actionJSON.receiptReports.map((r) => r.status), ['sent_back', 'confirmed', 'confirmed']);
  assert.equal(row.actionJSON.receipts.length, 2);
  assert.equal(row.actionJSON.receipts[1].doc.fileId, 'PDF3');
  assert.match(k.callsTo('sendMessage').find((x) => String(x.args.chatId) === 'musa').args.text, /Every bale is received — the transfer is closed/);
  const settled = createFakeBot();
  await controller.handleCallbackQuery(settled, cb(`trf:lcard:${requestId}`, '888', 9));
  const sk = kbTexts(settled);
  assert.ok(sk.includes(`📄 Dispatch doc|trf:vd:d:${requestId}`) && sk.includes(`📎 Receipt 2|trf:vd:r:${requestId}:2`) && sk.includes(`📎 Receipt 3|trf:vd:r:${requestId}:3`) && sk.includes(`📎 Receipt 1|trf:vd:r:${requestId}:1`), `one dispatch doc, one chip per receipt document, got ${sk}`);
  assert.match(settled.allText(), /Received by Musa/);
  // fetching a numbered receipt document
  await controller.handleCallbackQuery(settled, cb(`trf:vd:r:${requestId}:2`, '888', 9));
  assert.ok(settled.callsTo('sendDocument').some((x) => x.args.doc === 'PDF2' && /Receipt 2 doc/.test(x.args.opts.caption)));
});

test('two people on every receipt: an admin who reported cannot confirm; the valve at 0 restores the instant receipt', async () => {
  const requestId = await onTheRoad(2);
  // 777 acts in the receiver seat (BUSINESS_RULES §8) and reports
  const a = createFakeBot();
  await controller.handleCallbackQuery(a, cb(`trf:rcv:${requestId}`, '777', 5));
  await controller.handleFileMessage(a, pdf('777', 'PDFA'));
  const self = createFakeBot();
  await controller.handleCallbackQuery(self, cb(`trf:rcok:${requestId}:1`, '777', 9));
  assert.ok(self.callsTo('answerCallbackQuery').some((c) => /different admin must confirm/.test((c.args.opts && c.args.opts.text) || '')));
  assert.ok(!a.callsTo('sendMessage').some((c) => String(c.args.chatId) === '777' && /Receipt 1 to confirm/.test(c.args.text)), 'the reporter gets no review card');
  assert.ok(a.callsTo('sendMessage').some((c) => String(c.args.chatId) === '888' && /Receipt 1 to confirm/.test(c.args.text)), 'the other admin does');
  const other = createFakeBot();
  await controller.handleCallbackQuery(other, cb(`trf:rcyes:${requestId}:1`, '888', 9));
  assert.equal((await approvalQueueRepository.getByRequestId(requestId)).status, 'approved');

  // valve off
  fakeSheets._store.get('Settings').push(['TRANSFER_RECEIPT_REVIEW', '0']);
  require(path.join(SRC, 'repositories/settingsRepository')).invalidateCache();
  const rid = await onTheRoad(1);
  const v = createFakeBot();
  await controller.handleCallbackQuery(v, cb(`trf:rcv:${rid}`, 'musa', 5));
  await controller.handleFileMessage(v, pdf('musa', 'PDFV'));
  const row = await approvalQueueRepository.getByRequestId(rid);
  assert.equal(row.status, 'approved', 'instant receipt with the valve at 0');
  assert.equal(row.actionJSON.pendingReceipt, undefined);
  fakeSheets._store.get('Settings').pop();
  require(path.join(SRC, 'repositories/settingsRepository')).invalidateCache();
});
