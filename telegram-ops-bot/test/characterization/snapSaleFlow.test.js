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
  assert.equal(aj.sale_doc_file_id, 'label-photo-file-id', 'label photo attached as the sale document');
  assert.equal(aj.salesPerson, 'Yarima');
  assert.equal(aj.source, 'snap_sale');
  assert.ok(!sessionStore.get('4242'), 'session cleared after submit');
});

test('unreadable/unmatched label falls back to Sell Bale gracefully', async () => {
  const bot = createFakeBot();
  ocrResult = { ok: true, provider: 'stub', rawText: '', overallConfidence: 0.4, warnings: [], bales: [{ packageNo: '999', design: '11111', confidence: 0.4 }] };
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, photoMsg());
  assert.match(bot.allText(), /No AVAILABLE bale in the sheet matches/);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'act:sell_bale'), 'fallback button to the normal flow');
  assert.equal(queued.length, 1, 'nothing new queued');
  sessionStore.clear('4242');
});
