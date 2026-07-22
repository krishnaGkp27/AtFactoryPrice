'use strict';

/**
 * SNAP-1 — photo → OCR → bale match → customer tap → sell_package queued
 * with the label photo as the attached sale document; fallback on no match.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

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
const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const vision = require(path.join(SRC, 'services/vision'));

inventoryRepository.getAll = async () => [
  { packageNo: '896', design: '77016', shade: '5', warehouse: 'IDUMOTA', status: 'available', yards: 30 },
  { packageNo: '896', design: '77016', shade: '5', warehouse: 'IDUMOTA', status: 'available', yards: 30 },
  { packageNo: '897', design: '77016', shade: '2', warehouse: 'IDUMOTA', status: 'available', yards: 55 },
];
transactionsRepository.getCustomersByDesign = async () => ['ALABI', 'CJE'];
usersRepository.findByUserId = async () => ({ user_id: '4242', name: 'Yarima' });
auditLogRepository.append = async () => {};
const queued = [];
approvalQueueRepository.append = async (r) => { queued.push(r); };

telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('img'), ext: 'jpg', mimeType: 'image/jpeg' });
let ocrResult = {
  ok: true, provider: 'stub', rawText: '', overallConfidence: 0.9, warnings: [],
  bales: [{ packageNo: '896', thanNo: 1, design: '77016', shade: '5', yards: 150, confidence: 0.92 }],
};
vision.extractBales = async () => ocrResult;

function cb(data, uid = '4242') {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 71 } };
}
function photoMsg(uid = '4242') {
  return { from: { id: uid }, chat: { id: uid }, photo: [{ file_id: 'small' }, { file_id: 'label-photo-file-id' }] };
}
function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}

test('photo → match card with OCR read-back → customer tap → queued with label as document', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  assert.match(bot.allText(), /Send a clear photo of the \*bale label\*/);
  await controller.handleFileMessage(bot, photoMsg());
  assert.match(bot.allText(), /Read from label: Bale \*896\* · Design \*77016\* · Colour \*5\*/);
  assert.match(bot.allText(), /Matched bale/);
  assert.match(bot.allText(), /IDUMOTA · 2 thans · 60 yds available/, 'inventory values shown, not OCR values');
  let kb = lastKb(bot);
  const alabi = kb.find((b) => b.text === '👤 ALABI');
  assert.ok(alabi, 'recent-buyer chip');
  await controller.handleCallbackQuery(bot, cb(alabi.callback_data));
  assert.match(bot.allText(), /Confirm sale/);
  await controller.handleCallbackQuery(bot, cb('sns:ok'));
  assert.equal(queued.length, 1, 'approval queued');
  const aj = queued[0].actionJSON;
  assert.equal(aj.action, 'sell_package');
  assert.equal(aj.packageNo, '896');
  assert.equal(aj.customer, 'ALABI');
  assert.equal(aj.warehouse, 'IDUMOTA', 'warehouse persisted on the queued action');
  assert.equal(aj.sale_doc_file_id, 'label-photo-file-id', 'label photo attached as the sale document');
  assert.equal(aj.salesPerson, 'Yarima');
  assert.equal(aj.source, 'snap_sale');
  // APU-1 Phase 1 — admins get the gold-standard sale card + the label photo.
  // notifyAdminsApprovalRequest MarkdownV2-escapes the card — strip the
  // escape backslashes so assertions read like the rendered text.
  const adminMsgs = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '777').map((c) => c.args.text).join('\n').replace(/\\/g, '');
  assert.match(adminMsgs, /Sale Request \(Snap Sale\)/, 'gold-standard headline');
  assert.match(adminMsgs, /Customer: ALABI/);
  assert.match(adminMsgs, /Salesperson: Yarima/);
  assert.match(adminMsgs, /Bale 896: 77016 5, 2 thans, 60 yds \(IDUMOTA\)/, 'full item line');
  assert.match(adminMsgs, /Total: 1 Bale \(2 thans\), 60 yards/);
  assert.match(adminMsgs, /Sales bill \(label photo\) attached/);
  const adminPhotos = bot.calls.filter((c) => c.method === 'sendPhoto' && String(c.args.chatId) === '777');
  assert.equal(adminPhotos.length, 1, 'label photo forwarded to the admin');
  assert.equal(adminPhotos[0].args.photo, 'label-photo-file-id');
  assert.match(adminPhotos[0].args.opts.caption, /Sales bill for request/);
  // Adversarial-review fix: the seller's Submitted confirmation was dead
  // code (session cleared before the anchored render) — pin it now.
  const sellerMsgs = bot.calls.filter((c) => {
    if (c.method === 'sendMessage') return String(c.args.chatId) === '4242';
    if (c.method === 'editMessageText') return String((c.args.opts || {}).chat_id) === '4242';
    return false;
  }).map((c) => c.args.text).join('\n');
  assert.match(sellerMsgs, /Submitted/, 'seller sees the Submitted confirmation');
  assert.ok(!sessionStore.get('4242'), 'session cleared after submit');
});

test('SNAP-3: PDF batch → review card → one customer → ONE sale_bundle with the PDF attached', async () => {
  const bot = createFakeBot();
  ocrResult = {
    ok: true, provider: 'anthropic', rawText: '', overallConfidence: 0.9, warnings: [],
    bales: [
      { packageNo: '896', design: '77016', shade: '5', confidence: 0.9 },
      { packageNo: '897', design: '77016', shade: '2', confidence: 0.9 },
      { packageNo: '896', design: '77016', shade: '5', confidence: 0.9 }, // duplicate page → deduped
      { packageNo: '999', design: '11111', confidence: 0.8 },             // not in the sheet → skipped
    ],
  };
  const before = queued.length;
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, {
    from: { id: '4242' }, chat: { id: '4242' },
    document: { file_id: 'supply-pdf-1', mime_type: 'application/pdf', file_size: 2 * 1024 * 1024 },
  });
  const review = bot.allText().replace(/\\/g, '');
  assert.match(review, /PDF batch — 2 bale\(s\) matched/, 'duplicate deduped, unknown skipped');
  assert.match(review, /999 11111 — not available in the sheet \(skipped\)/);
  const kb = lastKb(bot);
  const buyer = kb.find((b) => b.text === '👤 ALABI');
  await controller.handleCallbackQuery(bot, cb(buyer.callback_data));
  assert.match(bot.allText(), /Confirm batch sale/);
  await controller.handleCallbackQuery(bot, cb('sns:ok'));
  assert.equal(queued.length, before + 1, 'exactly ONE approval for the whole PDF');
  const aj = queued.at(-1).actionJSON;
  assert.equal(aj.action, 'sale_bundle');
  // CARD-2: items ride in canonical order — design, then shade (897 is
  // shade 2, 896 is shade 5), then bale number.
  assert.deepEqual(aj.items, [
    { type: 'package', packageNo: '897' },
    { type: 'package', packageNo: '896' },
  ]);
  assert.equal(aj.customer, 'ALABI');
  assert.equal(aj.sale_doc_file_id, 'supply-pdf-1');
  assert.equal(aj.sale_doc_type, 'document');
  assert.equal(aj.source, 'snap_pdf');
  assert.equal(aj.totalYards, 115, '60+55 yards from the sheet, not the PDF');
  // Admin side: full card + the PDF forwarded as a document.
  const adminMsgs = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '777').map((c) => c.args.text).join('\n').replace(/\\/g, '');
  assert.match(adminMsgs, /Sale Request \(Snap PDF batch\)/);
  assert.match(adminMsgs, /Bale 896: 77016 5, 2 thans, 60 yds \(IDUMOTA\)/);
  assert.match(adminMsgs, /Skipped from the PDF \(1\): 999 11111/);
  const adminDocs = bot.calls.filter((c) => c.method === 'sendDocument' && String(c.args.chatId) === '777');
  assert.equal(adminDocs.length, 1, 'PDF forwarded to the admin');
  assert.ok(!sessionStore.get('4242'), 'session cleared');
});

test('unreadable/unmatched label falls back to Sell Bale gracefully', async () => {
  const bot = createFakeBot();
  const before = queued.length;
  ocrResult = { ok: true, provider: 'stub', rawText: '', overallConfidence: 0.4, warnings: [], bales: [{ packageNo: '999', design: '11111', confidence: 0.4 }] };
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, photoMsg());
  assert.match(bot.allText(), /No AVAILABLE bale in the sheet matches/);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'act:sell_bale'), 'fallback button to the normal flow');
  assert.equal(queued.length, before, 'nothing new queued');
  sessionStore.clear('4242');
});
