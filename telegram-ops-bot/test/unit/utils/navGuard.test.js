'use strict';
// NAV-1 — the navigation foundation: one guard at the controller's entry
// points gives every screen in the acting person's chat a way back.
const test = require('node:test');
const assert = require('node:assert');
const navGuard = require('../../../src/utils/navGuard');
const sessionStore = require('../../../src/utils/sessionStore');
const sessionJanitor = require('../../../src/services/sessionJanitor');
const { createFakeBot } = require('../../helpers/fakeBot');

const UID = '4242';
const kbOf = (c) => ((c.args.opts && c.args.opts.reply_markup) || c.args.replyMarkup || {}).inline_keyboard;
const texts = (kb) => (kb || []).flat().map((b) => b.text);
const last = (bot) => bot.calls[bot.calls.length - 1];
const wrap = (bot, tapped) => navGuard.wrap(bot, { chatId: UID, userId: UID, tapped });

test.afterEach(() => { sessionStore.clear(UID); navGuard.rememberHub(UID, null); });

test('an inline keyboard with no way out gains the footer; one that has it, an emptied one and a reply keyboard are untouched', async () => {
  const bot = wrap(createFakeBot());
  await bot.sendMessage(UID, 'pick', { reply_markup: { inline_keyboard: [[{ text: 'A', callback_data: 'x:a' }]] } });
  assert.deepEqual(texts(kbOf(last(bot))), ['A', '🏠 Back to menu'], 'no hub remembered → the plain menu row');

  navGuard.rememberHub(UID, 'sales');
  await bot.sendMessage(UID, 'pick', { reply_markup: { inline_keyboard: [[{ text: 'A', callback_data: 'x:a' }]] } });
  assert.deepEqual(texts(kbOf(last(bot))), ['A', '⬅ Back to Sales & Marketing', '🏠 Menu']);
  assert.deepEqual(kbOf(last(bot))[1].map((b) => b.callback_data), ['act:__hub__:sales', 'act:__back__']);

  for (const kb of [[[{ text: '❌ Cancel', callback_data: 'x:c' }]], [[{ text: '⬅️ Back', callback_data: 'x:b' }]], [[{ text: '📦 Tile', callback_data: 'act:check_stock' }]], []]) {
    await bot.sendMessage(UID, 'card', { reply_markup: { inline_keyboard: kb } });
    assert.deepEqual(kbOf(last(bot)), kb, `untouched: ${JSON.stringify(kb)}`);
  }
  await bot.sendMessage(UID, 'reply kb', { reply_markup: { keyboard: [['yes']], one_time_keyboard: true } });
  assert.deepEqual(last(bot).args.opts.reply_markup, { keyboard: [['yes']], one_time_keyboard: true });
});

test('a bare text gains the footer on a tap (once per update) or while a typed step waits — never otherwise', async () => {
  let bot = wrap(createFakeBot(), false);
  await bot.sendMessage(UID, 'noted');
  assert.equal(last(bot).args.opts, undefined, 'typed, no session: plain');

  sessionStore.set(UID, { type: 'order_flow', step: 'quantity_custom' });
  await bot.sendMessage(UID, 'Enter the quantity:');
  assert.deepEqual(texts(kbOf(last(bot))), ['🏠 Back to menu'], 'typed step waiting: the prompt can be left');
  sessionStore.clear(UID);

  bot = wrap(createFakeBot(), true);
  await bot.sendMessage(UID, 'You have no accepted orders.');
  await bot.sendMessage(UID, 'second line');
  await bot.editMessageText('sealed', { chat_id: UID, message_id: 7 });
  assert.deepEqual(bot.calls.map((c) => texts(kbOf(c))), [['🏠 Back to menu'], [], []], 'tap: the first bare text carries it, the rest stay clean');
});

test('other chats, photos without a keyboard and non-message methods are untouched; a bare keyboard edit is guarded too', async () => {
  const bot = wrap(createFakeBot(), true);
  await bot.sendMessage('777', 'admin card', { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: 'approve:1' }]] } });
  assert.deepEqual(texts(kbOf(last(bot))), ['✅ Approve'], 'another chat: byte-identical');
  await bot.sendPhoto(UID, 'file_1', { caption: 'pic' });
  assert.equal(kbOf(last(bot)), undefined, 'a keyboard-less photo stays so');
  await bot.sendPhoto(UID, 'file_1', { caption: 'pic', reply_markup: { inline_keyboard: [[{ text: '➕ Add', callback_data: 'x:add' }]] } });
  assert.deepEqual(texts(kbOf(last(bot))), ['➕ Add', '🏠 Back to menu']);
  await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '☐ 771', callback_data: 'x:t:0' }]] }, { chat_id: UID, message_id: 9 });
  assert.deepEqual(texts(kbOf(last(bot))), ['☐ 771', '🏠 Back to menu'], 'a redrawn keyboard keeps its footer');
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: UID, message_id: 9 });
  assert.deepEqual(kbOf(last(bot)), [], 'a wipe stays a wipe');
  await bot.deleteMessage(UID, 9);
  assert.equal(last(bot).method, 'deleteMessage');
});

test('wrap is idempotent and only ever guards the private chat of the acting person', () => {
  const bot = createFakeBot();
  const once = wrap(bot);
  assert.equal(wrap(once), once, 'wrapping twice returns the same guard');
  assert.equal(navGuard.wrap(bot, { chatId: '-100123', userId: UID }), bot, 'a group chat is left alone');
  assert.equal(navGuard.wrap(bot, { chatId: undefined, userId: UID }), bot);
});

test('leaveFlow ends the session and takes the flow\'s other messages down, keeping the one that becomes the menu', async () => {
  const bot = createFakeBot();
  assert.equal(await sessionJanitor.leaveFlow(bot, UID, 5), false, 'nothing live: nothing to do');
  sessionStore.set(UID, { type: 'supply_request_flow', step: 'shade', flowMessageId: 5, recordPhotoId: 9, auxMsgIds: [11, 12] });
  assert.equal(await sessionJanitor.leaveFlow(bot, UID, 5), true);
  assert.equal(sessionStore.get(UID), null, 'the session is gone');
  assert.deepEqual(bot.callsTo('deleteMessage').map((c) => c.args.messageId), [9, 11, 12], 'the tapped card (5) is kept — it is becoming the menu');
});
