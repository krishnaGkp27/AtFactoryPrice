'use strict';

/**
 * EDB-1 — ✏️ Edit Bale, driven through the REAL controller on the owner's
 * 6061 case: a 60-yd than that is really two 30-yd pieces, one of them sold.
 *
 *   admin types 6061 → the card → than #1: 60 → 30 → ➕ add a 30-yd than →
 *   📎 label photo → ✅ Send → ONE dual-admin approval (edit_bale) → the
 *   requester cannot self-approve → the 2nd admin approves → the sheet: cell
 *   G of than 1 rewritten, a than 6 appended with a generated uid.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

const HEADER = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];
const row = (than, yards, status = 'available', soldTo = '', soldDate = '') => ['6061', 'ST/1321', '', '9043-A', '6', String(than), String(yards), status, 'Kano office',
  '3500', '2026-02-10', soldTo, soldDate, '', '', '', 'fabric', `BAL-20260210-6061-${than}`, '2026-02-10', '', '', 'Feb26', ''];

const fakeSheets = createFakeSheets({
  Inventory: [HEADER, row(1, 60, 'sold', 'Qaribullah', '2026-08-18'), row(2, 30, 'sold', 'Ahmad (Mai Glass)', '2026-02-27'), row(3, 25), row(4, 24), row(5, 27, 'sold', 'Qaribullah', '2026-08-06')],
  ApprovalQueue: [['requestId', 'user', 'actionJSON', 'riskReason', 'status', 'createdAt', 'resolvedAt']],
});
installFakeSheets(fakeSheets);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));

auditLogRepository.append = async () => {};
usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}` });
settingsRepository.getAll = async () => ({});

const flat = (kb) => (kb ? kb.inline_keyboard.flat() : []);
const lastCard = (bot) => bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').pop();
const msg = (text, uid = '777') => ({ from: { id: uid }, chat: { id: uid }, text });
const rowIndexOfThan = (n) => fakeSheets._store.get('Inventory').findIndex((x) => x[0] === '6061' && x[5] === String(n)) + 1;

test('employee is refused; admin opens the card by typing the bale number', async () => {
  const botE = createFakeBot();
  await controller.handleCallbackQuery(botE, cb('act:edit_bale', '4242'));
  assert.match(botE.allText(), /admin-only/);

  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:edit_bale', '777'));
  assert.match(lastCard(bot).args.text, /Type the bale number/);
  await controller.handleMessage(bot, msg('9999'));
  assert.match(lastCard(bot).args.text, /No bale \*9999\* on the sheet/);
  await controller.handleMessage(bot, msg('6061'));
  const card = lastCard(bot).args.text;
  assert.match(card, /Edit Bale 6061\* · 9043-A · #6 · Kano office/);
  assert.match(card, /5 thans · 166 yd/);
  assert.match(card, /#1 · 60 yd · 🔴 sold → Qaribullah \(18-Aug-2026\)/);
  assert.match(card, /#3 · 25 yd · 🟢/);
  assert.match(card, /📎 Label photo: ❗ needed/);
  const texts = flat(lastCard(bot).args.opts.reply_markup).map((b) => b.text);
  assert.ok(texts.includes('#1 · 60 yd') && texts.includes('➕ Add a than') && texts.includes('📎 Label photo'), `card chips, got ${texts}`);
  assert.ok(!texts.some((t) => /Send for approval/.test(t)), 'no send chip before any change');
});

test('the 6061 correction: 60 → 30, add a 30, photo, send → dual-admin → the sheet changes', async () => {
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:edit_bale', '777'));
  await controller.handleMessage(bot, msg('6061'));
  const r1 = rowIndexOfThan(1);

  // Than #1 → chips offer the lengths already in the bale → tap 30.
  await controller.handleCallbackQuery(bot, cb(`edb:t:${r1}`, '777'));
  let texts = flat(lastCard(bot).args.opts.reply_markup).map((b) => b.text);
  assert.deepEqual(texts.slice(0, 5), ['24 yd', '25 yd', '27 yd', '30 yd', '60 yd'], 'chips are the bale’s own lengths');
  await controller.handleCallbackQuery(bot, cb(`edb:y:${r1}:30`, '777'));
  let card = lastCard(bot).args.text;
  assert.match(card, /#1 · 60 → \*30\* yd · 🔴 sold → Qaribullah/);
  assert.match(card, /5 thans · 166 yd {2}→ {2}\*5 thans · 136 yd\*/);
  assert.match(card, /⚠️ A sold than changes yards/);

  // ➕ Add a than → 30.
  await controller.handleCallbackQuery(bot, cb('edb:add', '777'));
  await controller.handleCallbackQuery(bot, cb('edb:ay:30', '777'));
  card = lastCard(bot).args.text;
  assert.match(card, /🆕 #6 · \*30\* yd · 🟢 new/);
  assert.match(card, /\*6 thans · 166 yd\*/, 'the label total is back');
  assert.match(card, /_2 change\(s\) pending_/);

  // Send without the photo → refused (rule 3).
  await controller.handleCallbackQuery(bot, cb('edb:send', '777'));
  assert.match(lastCard(bot).args.text, /Attach the label photo first/);
  await controller.handleCallbackQuery(bot, cb('edb:photo', '777'));
  await controller.handleFileMessage(bot, { from: { id: '777' }, chat: { id: '777' }, photo: [{ file_id: 'LBL_s' }, { file_id: 'LBL_L' }] });
  assert.match(lastCard(bot).args.text, /📎 Label photo: ✅ attached/);

  await controller.handleCallbackQuery(bot, cb('edb:send', '777'));
  assert.match(lastCard(bot).args.text, /Submitted for approval/);
  assert.ok(!sessionStore.get('777'), 'session cleared');
  const pending = await approvalQueueRepository.getAllPending();
  const req = pending.find((p) => p.actionJSON && p.actionJSON.action === 'edit_bale');
  assert.ok(req, 'one edit_bale approval queued');
  assert.equal(req.actionJSON.packageNo, '6061');
  assert.equal(req.actionJSON.label_file_id, 'LBL_L');
  assert.deepEqual(req.actionJSON.edits.add, [{ yards: 30 }]);
  const notified = bot.callsTo('sendMessage').filter((c) => /Approval required/.test(c.args.text || '')).map((c) => String(c.args.chatId));
  assert.deepEqual(notified, ['888'], 'the OTHER admin is asked, never the requester');
  const adminCard = bot.callsTo('sendMessage').find((c) => String(c.args.chatId) === '888' && /Approval required/.test(c.args.text)).args.text.replace(/\\/g, '');
  assert.match(adminCard, /Edit bale 6061 · 9043-A · Kano office — 2 change\(s\): #1: 60 → 30 yd \(sold → Qaribullah\); \+ #6: 30 yd \(new, available\)/);
  assert.ok(bot.callsTo('sendPhoto').some((c) => String(c.args.chatId) === '888' && c.args.photo === 'LBL_L'), 'the label photo reaches the approver first');

  // Requester cannot self-approve.
  const botSelf = createFakeBot();
  await controller.handleCallbackQuery(botSelf, cb(`approve:${req.requestId}`, 777));
  assert.ok(botSelf.callsTo('answerCallbackQuery').some((c) => /cannot approve your own/i.test((c.args.opts && c.args.opts.text) || '')));
  assert.equal((await approvalQueueRepository.getAllPending()).length, 1);

  // Second admin approves → the sheet changes exactly as the card promised.
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`approve:${req.requestId}`, 888));
  assert.match(bot2.allText(), /Bale 6061 corrected — 1 row\(s\) updated, 1 than\(s\) added\. Now 6 thans · 166 yd/);
  const sheet = fakeSheets._store.get('Inventory');
  const than1 = sheet.find((x) => x[0] === '6061' && x[5] === '1');
  assert.equal(String(than1[6]), '30');
  assert.equal(than1[11], 'Qaribullah', 'the sale itself is untouched');
  const than6 = sheet.find((x) => x[0] === '6061' && String(x[5]) === '6');
  assert.ok(than6, 'than 6 exists');
  assert.equal(than6[7], 'available');
  assert.equal(than6[21], 'Feb26', 'container copied from the bale-mates');
  assert.match(than6[17], /^BAL-\d{8}-6061-/);
  assert.equal(sheet.indexOf(than6), sheet.length - 1, 'appended at the bottom, never inserted');
  assert.equal((await approvalQueueRepository.getAllPending()).length, 0);
});

test('an edit proposed on rows that then moved is refused at approval, not written', async () => {
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:edit_bale', '777'));
  await controller.handleMessage(bot, msg('6061'));
  const r3 = rowIndexOfThan(3);
  await controller.handleCallbackQuery(bot, cb(`edb:t:${r3}`, '777'));
  await controller.handleCallbackQuery(bot, cb(`edb:y:${r3}:26`, '777'));
  await controller.handleCallbackQuery(bot, cb('edb:photo', '777'));
  await controller.handleFileMessage(bot, { from: { id: '777' }, chat: { id: '777' }, photo: [{ file_id: 'L2' }] });
  await controller.handleCallbackQuery(bot, cb('edb:send', '777'));
  const req = (await approvalQueueRepository.getAllPending()).find((p) => p.actionJSON.action === 'edit_bale');
  assert.ok(req);
  // Than 3 is sold between the proposal and the approval.
  const than3 = fakeSheets._store.get('Inventory').find((x) => x[0] === '6061' && x[5] === '3');
  than3[7] = 'sold'; than3[11] = 'Musa';
  require(path.join(SRC, 'repositories/inventoryRepository')).invalidateCache();
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`approve:${req.requestId}`, 888));
  assert.match(bot2.allText(), /changed since this edit was proposed/);
  assert.equal(String(than3[6]), '25', 'nothing written onto the moved row');
});
