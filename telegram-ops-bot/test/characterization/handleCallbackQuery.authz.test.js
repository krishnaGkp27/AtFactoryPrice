'use strict';

/**
 * SEC-P1 characterization suite for telegramController.handleCallbackQuery.
 *
 * Pins two security guarantees added in the P1 hardening pass:
 *   - C2: button taps pass through the same allow-list gate as text messages;
 *         an unauthorized sender is answered with a rejection and NO flow runs.
 *   - C3: `confirm_sale:` / `cancel_sale:` are bound to the clicker — an allowed
 *         user cannot confirm or cancel ANOTHER user's pending sale by forging
 *         the user id in callback_data.
 *
 * Drives the real controller; only sheetsClient / intentParser / bot are faked.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController } = require('../helpers/controllerHarness');

const ADMIN_ID = 777;
const STRANGER_ID = 555;
const OTHER_USER_ID = 321;

installFakeSheets(createFakeSheets({
  Users: [['user_id', 'name', 'role', 'status', 'departments', 'manages']],
  AuditLog: [['timestamp', 'type', 'data', 'user_id']],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();

function callbackQuery(data, fromId) {
  return {
    id: 'cbq-1',
    data,
    from: { id: fromId, first_name: 'Test' },
    message: { chat: { id: fromId }, message_id: 42 },
  };
}

test('C2: an unauthorized user is rejected and no flow runs', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, callbackQuery('zzz:no-such-handler', STRANGER_ID));

  const acks = bot.callsTo('answerCallbackQuery');
  assert.ok(acks.length >= 1, 'expected the callback to be answered');
  assert.equal(acks[acks.length - 1].args.opts.text, 'You are not authorized to use this bot.');
  // Bailed before the unknown-action catch-all and before any UI mutation.
  assert.ok(!bot.allText().includes('Unknown action'));
  assert.equal(bot.callsTo('editMessageReplyMarkup').length, 0);
});

test('C2: an authorized admin still reaches the normal handler chain', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, callbackQuery('zzz:no-such-handler', ADMIN_ID));

  const acks = bot.callsTo('answerCallbackQuery');
  assert.ok(acks.length >= 1);
  // Allowed → falls through to the unknown-action acknowledgement.
  assert.equal(acks[acks.length - 1].args.opts.text, 'Unknown action.');
});

test('C3: an allowed user cannot confirm someone else\'s pending sale', async () => {
  const bot = createFakeBot();
  // Admin 777 is allowed (passes C2) but taps a confirm bound to user 321.
  await controller.handleCallbackQuery(bot, callbackQuery(`confirm_sale:${OTHER_USER_ID}`, ADMIN_ID));

  const acks = bot.callsTo('answerCallbackQuery');
  assert.equal(acks[acks.length - 1].args.opts.text, 'This confirmation is not yours to make.');
  // Proves we bailed BEFORE executeSale (which clears the keyboard first).
  assert.equal(bot.callsTo('editMessageReplyMarkup').length, 0);
});

test('C3: an allowed user cannot cancel someone else\'s pending sale', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, callbackQuery(`cancel_sale:${OTHER_USER_ID}`, ADMIN_ID));

  const acks = bot.callsTo('answerCallbackQuery');
  assert.equal(acks[acks.length - 1].args.opts.text, 'This action is not yours to make.');
  assert.equal(bot.callsTo('editMessageReplyMarkup').length, 0);
});
