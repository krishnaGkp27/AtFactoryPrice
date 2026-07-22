'use strict';

/**
 * CUST-2 — ➕ New customer inside the snap/PDF sale (owner queue #1):
 * typed once, rides the standard add_customer approval, and the sale
 * continues immediately with the name. An existing name just selects
 * the profile — nothing queued.
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
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const vision = require(path.join(SRC, 'services/vision'));

inventoryRepository.getAll = async () => [
  { packageNo: '896', design: '77016', shade: '5', warehouse: 'IDUMOTA', status: 'available', yards: 30 },
];
transactionsRepository.getCustomersByDesign = async () => ['ALABI'];
customersRepository.getAll = async () => [{ name: 'OKESON STORES', status: 'active' }];
usersRepository.findByUserId = async () => ({ user_id: '4242', name: 'Yarima' });
auditLogRepository.append = async () => {};
const queued = [];
approvalQueueRepository.append = async (r) => { queued.push(r); };
telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('img'), mimeType: 'image/jpeg' });
vision.extractBales = async () => ({
  ok: true, provider: 'stub', rawText: '', overallConfidence: 0.9, warnings: [],
  bales: [{ packageNo: '896', design: '77016', shade: '5', confidence: 0.9 }],
});

function cb(data, uid = '4242') {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 5 } };
}
function txt(text, uid = '4242') { return { from: { id: uid }, chat: { id: uid }, text }; }
function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  return withKb.length ? withKb[withKb.length - 1].args.opts.reply_markup.inline_keyboard.flat() : [];
}

test('truly new name: add_customer queued + admins notified, sale continues with the name', async () => {
  const bot = createFakeBot();
  queued.length = 0;
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, { from: { id: '4242' }, chat: { id: '4242' }, photo: [{ file_id: 'p1' }] });
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'sns:newc'), '➕ New customer on the picker');
  await controller.handleCallbackQuery(bot, cb('sns:newc'));
  assert.match(bot.allText(), /Type the customer's NAME/);
  await controller.handleMessage(bot, txt('MAMA CHIDINMA'));
  // Profile approval queued for the admins…
  assert.equal(queued.length, 1);
  assert.equal(queued[0].actionJSON.action, 'add_customer');
  assert.equal(queued[0].actionJSON.name, 'MAMA CHIDINMA');
  const adminMsgs = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '777').map((c) => c.args.text).join('\n').replace(/\\/g, '');
  assert.match(adminMsgs, /New Customer Request/);
  assert.match(adminMsgs, /MAMA CHIDINMA/);
  // …and the sale marches on without waiting.
  const confirm = bot.allText().replace(/\\/g, '');
  assert.match(confirm, /Confirm sale/);
  assert.match(confirm, /MAMA CHIDINMA.*NEW — profile sent for approval/);
  await controller.handleCallbackQuery(bot, cb('sns:ok'));
  assert.equal(queued.length, 2, 'sale approval queued too');
  assert.equal(queued[1].actionJSON.action, 'sell_package');
  assert.equal(queued[1].actionJSON.customer, 'MAMA CHIDINMA');
  assert.ok(!sessionStore.get('4242'), 'session cleared after submit');
});

test('existing name (any case) selects the profile — nothing queued, no NEW tag', async () => {
  const bot = createFakeBot();
  queued.length = 0;
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, { from: { id: '4242' }, chat: { id: '4242' }, photo: [{ file_id: 'p1' }] });
  await controller.handleCallbackQuery(bot, cb('sns:newc'));
  await controller.handleMessage(bot, txt('okeson stores'));
  assert.equal(queued.length, 0, 'no add_customer for an existing profile');
  const confirm = bot.allText().replace(/\\/g, '');
  assert.match(confirm, /Customer: \*OKESON STORES\*/, 'canonical sheet spelling used');
  assert.ok(!confirm.includes('NEW — profile sent'), 'not tagged as new');
  // Junk input is refused politely and the step stays put.
  sessionStore.clear('4242');
});

test('back from the name prompt returns to the picker; junk names are refused', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, { from: { id: '4242' }, chat: { id: '4242' }, photo: [{ file_id: 'p1' }] });
  await controller.handleCallbackQuery(bot, cb('sns:newc'));
  await controller.handleMessage(bot, txt('/start'));
  assert.match(bot.allText(), /plain customer name/);
  await controller.handleCallbackQuery(bot, cb('sns:bk'));
  assert.equal(sessionStore.get('4242').step, 'pick_customer', 'back resets the step');
  sessionStore.clear('4242');
});
