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

test('IDR-2: an unknown user opening with a real request is CAPTURED, not turned away', async () => {
  // This pin is the reverse of what it was until 14-Aug-2026. The curt
  // rejection used to be sent to anyone whose first message was not a
  // greeting — so a customer who opened with "I want 5 bales of 9037"
  // vanished without a trace, which is the exact person the business most
  // wants to know about. The owner ruled: capture them, and quote what
  // they said on the admin card so a customer is distinguishable from
  // noise at a glance.
  const bot = createFakeBot();
  await controller.handleMessage(bot, message(STRANGER_ID, 'I want 5 bales of 9037'));

  assert.ok(!bot.allText().includes('not authorized to use this bot'),
    'no curt rejection for a first contact, whatever they typed');
  const toStranger = bot.callsTo('sendMessage').filter((c) => c.args.chatId === STRANGER_ID);
  assert.equal(toStranger.length, 1, 'they get exactly one polite reply');
  assert.match(toStranger[0].args.text, /not yet registered/i);
  // …and an admin gets a card carrying what they actually asked for.
  assert.match(bot.allText(), /I want 5 bales of 9037/,
    'the opening message reaches the admin card — it is the whole triage signal');
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
