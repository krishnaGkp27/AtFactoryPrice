'use strict';

/**
 * MNU-1 — the menu funnel, driven through the REAL controller.
 *
 * The owner's non-negotiable was "no existing functionality gets disrupted at
 * any cost". That is enforced structurally: MENU_ANCHOR_ENABLED defaults to 0
 * and the whole anchored path is behind it. So the first thing pinned here is
 * that with the flag OFF the behaviour is byte-for-byte what shipped before —
 * because that, not a promise, is what makes the rollback a single cell.
 *
 * Then, with the flag ON:
 *  - AC1 a fresh anchor edits in place, creating NO new message;
 *  - AC2 a buried anchor re-anchors to the bottom and retires the old menu;
 *  - AC3 the re-anchor is announced, so the menu never vanishes silently;
 *  - AC6 walking in and back out adds zero messages;
 *  - D-2 More Options edits in place like its six siblings instead of
 *    appending and destroying the user's place.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const settingsRepo = require(path.join(SRC, 'repositories/settingsRepository'));
const menuAnchor = require(path.join(SRC, 'services/menuAnchor'));

const ADMIN = '777';
const CHAT = '777';

let anchorEnabled = 0;
const realGetAll = settingsRepo.getAll;
settingsRepo.getAll = async () => ({ ...settingsRepo.DEFAULTS, MENU_ANCHOR_ENABLED: anchorEnabled });

function reset(enabled) {
  anchorEnabled = enabled;
  menuAnchor._resetForTests();
}

const tap = (data, messageId = 500) => ({
  data, id: `q-${data}-${messageId}`, from: { id: ADMIN },
  message: { message_id: messageId, chat: { id: CHAT } },
});

const sends = (bot) => bot.calls.filter((c) => c.method === 'sendMessage');
const edits = (bot) => bot.calls.filter((c) => c.method === 'editMessageText');
const deletes = (bot) => bot.calls.filter((c) => c.method === 'deleteMessage');

test.after(() => { settingsRepo.getAll = realGetAll; });

/* ── the guarantee the owner asked for ── */

test('flag OFF: the legacy path is untouched — a tapped hub still edits the tapped message', async () => {
  reset(0);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, tap('act:__hub__:finance', 4321));

  const e = edits(bot);
  assert.ok(e.length >= 1, 'the hub rendered by editing');
  assert.equal(e[e.length - 1].args.opts.message_id, 4321,
    'the TAPPED message — no anchor logic in play');
  assert.equal(deletes(bot).length, 0, 'nothing is deleted while the flag is off');
});

test('flag OFF: More Options still works (its physics change only when anchoring is on)', async () => {
  reset(0);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, tap('act:__more__', 4321));
  const painted = [...edits(bot), ...sends(bot)];
  assert.ok(painted.length >= 1, 'the expanded menu was rendered');
});

/* ── AC1 — a fresh anchor edits in place ── */

test('AC1: with the anchor last in the chat, a tap edits it and creates NO new message', async () => {
  reset(1);
  menuAnchor.compareAndSet(CHAT, null, { anchorMessageId: 900, view: 'main_menu' });
  menuAnchor.noteMessage(CHAT, 900); // delta 0 — the anchor IS the last message

  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, tap('act:__hub__:finance', 900));

  const e = edits(bot);
  assert.ok(e.length >= 1, 'rendered by editing');
  assert.equal(e[e.length - 1].args.opts.message_id, 900, 'edited the anchor itself');
  assert.equal(sends(bot).length, 0, 'AC1: no new message — the chat does not grow');
  assert.equal(deletes(bot).length, 0);
});

/* ── AC2 + AC3 — a buried anchor moves to the bottom, and says so ── */

test('AC2/AC3: two messages below the anchor → re-anchor at the bottom, old one retired, user told', async () => {
  reset(1);
  menuAnchor.compareAndSet(CHAT, null, { anchorMessageId: 900, view: 'main_menu' });
  // An approval card and a digest land beneath it. Neither is a menu; both
  // bury one — which is exactly why the tracker must see them.
  menuAnchor.noteMessage(CHAT, 901);
  menuAnchor.noteMessage(CHAT, 902);

  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, tap('act:__hub__:finance', 900));

  assert.equal(sends(bot).length, 1, 'AC2: the view is re-sent at the BOTTOM');
  assert.equal(sends(bot)[0].args.opts.disable_notification, true,
    'silenced — the user just tapped a button; buzzing them about their own tap is noise');
  assert.equal(deletes(bot).length, 1, 'the buried menu is retired');
  assert.equal(String(deletes(bot)[0].args.messageId), '900');

  const toasts = bot.callsTo('answerCallbackQuery')
    .map((c) => (c.args.opts || {}).text).filter(Boolean);
  assert.ok(toasts.some((t) => /moved to the bottom/i.test(t)),
    'AC3: a silent re-anchor would be as disorienting as the bug it fixes');

  const newAnchor = menuAnchor.get(CHAT).anchorMessageId;
  assert.ok(Number.isFinite(newAnchor) && newAnchor !== 900,
    'the anchor now points at the newly sent message, not the buried one');
});

test('a failed delete degrades to stripping the keyboard, so no abandoned menu stays tappable', async () => {
  reset(1);
  menuAnchor.compareAndSet(CHAT, null, { anchorMessageId: 900, view: 'main_menu' });
  menuAnchor.noteMessage(CHAT, 903);

  const bot = createFakeBot();
  // Past 48h a bot may not delete its own message.
  bot.deleteMessage = async () => { throw new Error("message can't be deleted"); };

  await controller.handleCallbackQuery(bot, tap('act:__hub__:finance', 900));

  const strips = bot.callsTo('editMessageReplyMarkup')
    .filter((c) => String(c.args.opts.message_id) === '900');
  assert.equal(strips.length, 1, 'the corpse loses its buttons instead');
  assert.deepEqual(strips[0].args.replyMarkup, { inline_keyboard: [] });
  assert.equal(sends(bot).length, 1, 'and the user still got their menu');
});

/* ── AC6 — drill-downs do not spam ── */

test('AC6: hub → back → hub from a fresh anchor adds ZERO messages', async () => {
  reset(1);
  menuAnchor.compareAndSet(CHAT, null, { anchorMessageId: 900, view: 'main_menu' });
  menuAnchor.noteMessage(CHAT, 900);

  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, tap('act:__hub__:finance', 900));
  await controller.handleCallbackQuery(bot, tap('act:__back__', 900));
  await controller.handleCallbackQuery(bot, tap('act:__hub__:crm', 900));

  assert.equal(sends(bot).length, 0, 'three navigations, zero new messages');
  assert.ok(edits(bot).length >= 3, 'each one repainted the same anchor');
});

/* ── D-2 — the button that broke the model ── */

test('D-2: More Options edits in place instead of appending and destroying your place', async () => {
  reset(1);
  menuAnchor.compareAndSet(CHAT, null, { anchorMessageId: 900, view: 'main_menu' });
  menuAnchor.noteMessage(CHAT, 900);

  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, tap('act:__more__', 900));

  assert.equal(sends(bot).length, 0,
    'it used to post a new message and strip the old keyboard — one button under different physics from its six siblings');
  const e = edits(bot);
  assert.equal(e[e.length - 1].args.opts.message_id, 900, 'the expanded grid replaces the menu in place');
});
