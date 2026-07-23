'use strict';

/**
 * SNAP-4 — the PDF batch as a WAREHOUSE TRANSFER (owner 21-Jul): admin-only
 * button on the batch review → destination + receiver taps → one staged
 * transfer PER SOURCE warehouse, exact packageNos dispatched immediately
 * (the PDF is the load doc), receiver confirms via the existing trf: cards.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,5151';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb: fxCb, lastKb } = require('../helpers/charFixture');
const cb = (data, uid = '777') => fxCb(data, uid);

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const driveBackup = require(path.join(SRC, 'services/vision/driveBackup'));
const vision = require(path.join(SRC, 'services/vision'));
const snapSaleFlow = require(path.join(SRC, 'flows/snapSaleFlow'));

// Two source stores in Lagos + the Kano destination (bale 800 already there).
inventoryRepository.getAll = async () => [
  { packageNo: '600', design: '77016', shade: '5', warehouse: 'LAGOS MAIN', status: 'available', yards: 30 },
  { packageNo: '601', design: '77016', shade: '5', warehouse: 'LAGOS MAIN', status: 'available', yards: 30 },
  { packageNo: '700', design: '88001', shade: '2', warehouse: 'IDUMOTA', status: 'available', yards: 55 },
  { packageNo: '800', design: '99001', shade: '1', warehouse: 'Kano office', status: 'available', yards: 40 },
];
const transitions = [];
inventoryRepository.transitionBales = async (pkgs, from, to, wh) => { transitions.push({ pkgs, from, to, wh }); };
transactionsRepository.getCustomersByDesign = async () => ['ALABI'];
usersRepository.getAll = async () => [
  { user_id: '5151', name: 'Sani Kano', role: 'employee', status: 'active', warehouses: ['Kano office'] },
  { user_id: '4242', name: 'Yarima', role: 'employee', status: 'active', warehouses: ['LAGOS MAIN'] },
];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: id === '777' ? 'Boss' : 'Yarima' });
auditLogRepository.append = async () => {};

// In-memory ApprovalQueue so transferService's create → dispatch → attach
// round-trip works without sheet plumbing.
const qrows = new Map();
approvalQueueRepository.append = async (r) => { qrows.set(r.requestId, { ...r }); return r; };
approvalQueueRepository.getByRequestId = async (id) => qrows.get(String(id)) || null;
approvalQueueRepository.updateActionJSON = async (id, patch) => {
  const row = qrows.get(String(id));
  if (!row) return false;
  row.actionJSON = { ...row.actionJSON, ...patch };
  return true;
};
approvalQueueRepository.updateStatus = async (id, status) => {
  const row = qrows.get(String(id));
  if (!row) return false;
  row.status = status;
  return true;
};

telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('pdf'), ext: 'pdf', mimeType: 'application/pdf' });
driveBackup.archiveFile = async () => ({ drive: { webViewLink: 'https://drive/x' }, readableName: 'snap-transfer.pdf' });
vision.extractBales = async () => ({
  ok: true, provider: 'anthropic', rawText: '', overallConfidence: 0.9, warnings: [],
  bales: [
    { packageNo: '600', design: '77016', shade: '5', confidence: 0.9 },
    { packageNo: '601', design: '77016', shade: '5', confidence: 0.9 },
    { packageNo: '700', design: '88001', shade: '2', confidence: 0.9 },
    { packageNo: '800', design: '99001', shade: '1', confidence: 0.9 }, // already at dest → skipped
  ],
});

function pdfMsg(uid = '777') {
  return { from: { id: uid }, chat: { id: uid }, document: { file_id: 'dispatch-pdf', mime_type: 'application/pdf', file_size: 15 * 1024 * 1024 } };
}
function plain(bot) { return bot.allText().replace(/\\/g, ''); }

test('buildTransferGroups: per-source grouping, service lines + exact picks, dest bales stay', () => {
  const items = [
    { packageNo: '600', design: '77016', shade: '5', warehouse: 'LAGOS MAIN' },
    { packageNo: '601', design: '77016', shade: '5', warehouse: 'LAGOS MAIN' },
    { packageNo: '700', design: '88001', shade: '2', warehouse: 'IDUMOTA' },
    { packageNo: '800', design: '99001', shade: '1', warehouse: 'Kano office' },
  ];
  const { groups, stay } = snapSaleFlow._internals.buildTransferGroups(items, 'Kano office');
  assert.equal(groups.length, 2, 'one group per source warehouse');
  const lagos = groups.find((g) => g.from === 'LAGOS MAIN');
  assert.deepEqual(lagos.lines, [{ design: '77016', shade: '5', qty: 2 }]);
  assert.deepEqual(lagos.picks, [['600', '601']], 'exact packageNos parallel to lines');
  assert.equal(stay.length, 1);
  assert.equal(stay[0].packageNo, '800');
});

test('admin PDF → transfer mode → dest + auto receiver → 2 transfers dispatched, receiver + admin notified', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, pdfMsg());
  assert.match(plain(bot), /PDF batch — 4 bale\(s\) matched/);
  let kb = lastKb(bot);
  const tmode = kb.find((b) => b.callback_data === 'sns:tmode');
  assert.ok(tmode, 'admin sees the transfer button on the batch review');

  await controller.handleCallbackQuery(bot, cb('sns:tmode'));
  assert.match(plain(bot), /To which warehouse\?/);
  kb = lastKb(bot);
  const kano = kb.find((b) => b.text === '🏭 Kano office');
  assert.ok(kano, 'destination chip');
  await controller.handleCallbackQuery(bot, cb(kano.callback_data));
  // Sani is the only active Kano user → auto-picked, straight to confirm.
  const confirm = plain(bot);
  assert.match(confirm, /Confirm dispatch/);
  assert.match(confirm, /LAGOS MAIN.*→.*Kano office.*— 2 bale\(s\)/);
  assert.match(confirm, /IDUMOTA.*→.*Kano office.*— 1 bale\(s\)/);
  assert.match(confirm, /1 bale\(s\) already at Kano office — skipped: 800/);
  assert.match(confirm, /Receiver:.*Sani Kano/);

  transitions.length = 0;
  await controller.handleCallbackQuery(bot, cb('sns:tok'));
  const done = plain(bot);
  assert.match(done, /Dispatched from the PDF/);
  const transfers = [...qrows.values()].filter((r) => r.actionJSON.action === 'transfer_stock');
  assert.equal(transfers.length, 2, 'one transfer per source warehouse');
  const lagosT = transfers.find((r) => r.actionJSON.from === 'LAGOS MAIN');
  const idumT = transfers.find((r) => r.actionJSON.from === 'IDUMOTA');
  assert.equal(lagosT.actionJSON.stage, 'in_transit', 'dispatched immediately');
  assert.deepEqual(lagosT.actionJSON.bales, ['600', '601'], 'exact PDF bales logged');
  assert.deepEqual(idumT.actionJSON.bales, ['700']);
  assert.equal(lagosT.actionJSON.dispatcher, '777');
  assert.equal(lagosT.actionJSON.receiver, '5151');
  assert.equal(lagosT.actionJSON.dispatchDoc.fileId, 'dispatch-pdf', 'PDF attached as the load document');
  assert.ok(transitions.some((t) => t.to === 'in_transit' && t.wh === 'Kano office'), 'bales flipped in_transit at dest');
  // Receiver got both trf: cards + the PDF.
  const rcvMsgs = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '5151').map((c) => c.args.text).join('\n');
  assert.match(rcvMsgs, /Transfer TR-.* incoming/);
  const rcvKb = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '5151' && c.args.opts && c.args.opts.reply_markup)
    .flatMap((c) => c.args.opts.reply_markup.inline_keyboard.flat());
  assert.ok(rcvKb.some((b) => b.callback_data.startsWith('trf:rcv:')), 'existing Received button — rides the trf: pipeline');
  const rcvDocs = bot.calls.filter((c) => c.method === 'sendDocument' && String(c.args.chatId) === '5151');
  assert.equal(rcvDocs.length, 2, 'PDF forwarded per transfer');
  assert.ok(!sessionStore.get('777'), 'session cleared');
});

test('non-admin never sees the transfer button and tmode is refused', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:snap_sale', '4242'));
  await controller.handleFileMessage(bot, pdfMsg('4242'));
  assert.ok(!lastKb(bot).some((b) => b.callback_data === 'sns:tmode'), 'no transfer button for non-admin');
  const before = [...qrows.values()].filter((r) => r.actionJSON.action === 'transfer_stock').length;
  await controller.handleCallbackQuery(bot, cb('sns:tmode', '4242'));
  const alert = bot.calls.filter((c) => c.method === 'answerCallbackQuery' && c.args.opts && c.args.opts.show_alert).pop();
  assert.match(alert.args.opts.text, /admins only/);
  assert.equal([...qrows.values()].filter((r) => r.actionJSON.action === 'transfer_stock').length, before, 'nothing created');
  sessionStore.clear('4242');
});

test('19 MB PDF cap: 15 MB passes (above the old 10 MB), oversize is refused with the size message', async () => {
  const config = require(path.join(SRC, 'config'));
  assert.equal(config.ocr.maxPdfBytes, 19 * 1024 * 1024, 'default raised to 19 MB (Telegram bot ceiling is 20)');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, {
    from: { id: '777' }, chat: { id: '777' },
    document: { file_id: 'huge', mime_type: 'application/pdf', file_size: 263 * 1024 * 1024 },
  });
  assert.match(plain(bot), /263\.0 MB — the limit is 19 MB/);
  sessionStore.clear('777');
});
