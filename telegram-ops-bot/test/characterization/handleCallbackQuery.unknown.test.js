'use strict';

/**
 * Characterization (golden) suite for telegramController.handleCallbackQuery —
 * the unknown-action catch-all.
 *
 * Pins the guarantee that a button tap whose callback_data matches no handler
 * is still acknowledged ("Unknown action.") rather than left spinning forever
 * in the user's client. A stable, deterministic anchor for the TG-8 split.
 *
 * Drives the real controller; only sheetsClient / intentParser / bot are faked.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({
  Users: [['user_id', 'name', 'role', 'status']],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();

function callbackQuery(data, fromId = 777) {
  return {
    id: 'cbq-1',
    data,
    from: { id: fromId, first_name: 'Test' },
    message: { chat: { id: fromId }, message_id: 42 },
  };
}

test('acknowledges an unrecognized callback with "Unknown action."', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, callbackQuery('zzz:no-such-handler'));

  const acks = bot.callsTo('answerCallbackQuery');
  assert.ok(acks.length >= 1, 'expected the callback to be answered');
  assert.equal(acks[acks.length - 1].args.opts.text, 'Unknown action.');
});
