'use strict';

/**
 * Characterization (golden) suite for telegramController.handleMessage — the
 * authorization gate.
 *
 * This is the FIRST rung of the TG-8 safety net: it pins the controller's
 * current observable behavior (what it sends, for whom) so the eventual
 * controller split can be proven behavior-preserving. It drives the REAL
 * controller — only the googleapis boundary (sheetsClient), OpenAI
 * (intentParser), and the Telegram `bot` are faked.
 *
 * Env must be seeded before the harness require chain pulls in auth.js.
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

// Seed empty sheets (header rows only) — a stranger is therefore not in the
// active-users roster, and an admin is authorized via env ADMIN_IDS.
const sheets = createFakeSheets({
  Users: [['user_id', 'name', 'role', 'status', 'departments', 'manages']],
  PendingUsers: [['user_id', 'name', 'username', 'requested_at', 'status']],
  AuditLog: [['timestamp', 'type', 'data', 'user_id']],
});
installFakeSheets(sheets);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();

/** Minimal Telegram message shape. */
function message(fromId, text) {
  return {
    chat: { id: fromId },
    from: { id: fromId, first_name: 'Test' },
    text,
  };
}

test('rejects an unknown user sending arbitrary text', async () => {
  const bot = createFakeBot();
  await controller.handleMessage(bot, message(STRANGER_ID, 'sell package 5801'));

  const sends = bot.callsTo('sendMessage');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].args.text, 'You are not authorized to use this bot.');
  assert.equal(sends[0].args.chatId, STRANGER_ID);
});

test('does NOT send the rejection for first-contact greetings (stranger capture path)', async () => {
  const bot = createFakeBot();
  await controller.handleMessage(bot, message(STRANGER_ID, 'hi'));

  // First contact routes to pending-user capture, never the curt rejection.
  assert.ok(!bot.allText().includes('not authorized to use this bot'));
});

test('an authorized admin with empty text gets a menu, not a rejection', async () => {
  const bot = createFakeBot();
  await controller.handleMessage(bot, message(ADMIN_ID, ''));

  assert.ok(!bot.allText().includes('not authorized'));
  // The greeting menu is rendered via at least one outbound message.
  assert.ok(bot.calls.length >= 1, 'expected the controller to send something');
});
