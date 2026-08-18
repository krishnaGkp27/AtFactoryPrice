'use strict';

/**
 * MNU-1 — the staleness decision, the compare-and-swap, and the retire path.
 *
 * The bug: navigation edits a message in place, which is right until that
 * message has scrolled away. An edit does not move the message, does not
 * scroll the client, and keeps the original timestamp — so a tap on a buried
 * menu renders its answer off-screen and reads as a dead button.
 *
 * Pinned here:
 *  - the delta table (0/1 edit, >=2 re-anchor) — the whole heuristic;
 *  - a user-sent message re-anchors unconditionally, whatever the delta;
 *  - EVERY message bumps the tracker, including event messages that never
 *    become anchors but are exactly what buries one (AC9);
 *  - the CAS: a double-tap cannot leave two menus, because the loser is told
 *    it lost and cleans up after itself;
 *  - retire() deletes, falls back to stripping the keyboard, and NEVER throws
 *    — a failure there must not reach the user, whose new menu already exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const menuAnchor = require('../../../src/services/menuAnchor');

function reset() { menuAnchor._resetForTests(); }

/* ── the signal ── */

test('the staleness table: 0 or 1 below edits in place, 2+ re-anchors', () => {
  for (const [below, expected] of [[0, 'edit'], [1, 'edit'], [2, 'reanchor'], [9, 'reanchor']]) {
    reset();
    menuAnchor.compareAndSet('chat-1', null, { anchorMessageId: 100, view: 'main_menu' });
    menuAnchor.noteMessage('chat-1', 100 + below);
    const d = menuAnchor.decide({ chatId: 'chat-1' });
    assert.equal(d.action, expected, `${below} message(s) below → ${expected}`);
    assert.equal(d.below, below);
  }
  assert.equal(menuAnchor.REANCHOR_AFTER_N_MESSAGES, 2,
    'the threshold is a named, low-biased knob — a spurious re-anchor costs one message, a missed one costs a silent failure');
});

test('no anchor yet means send, not edit', () => {
  reset();
  const d = menuAnchor.decide({ chatId: 'chat-new' });
  assert.equal(d.action, 'send');
  assert.equal(d.anchorMessageId, null);
});

test('a user-sent message re-anchors unconditionally, even with the anchor last', () => {
  reset();
  menuAnchor.compareAndSet('chat-1', null, { anchorMessageId: 100 });
  menuAnchor.noteMessage('chat-1', 100); // delta 0 — would otherwise edit
  const d = menuAnchor.decide({ chatId: 'chat-1', userInitiated: true });
  assert.equal(d.action, 'reanchor',
    'their message is below the anchor and their viewport is at the bottom — the strongest signal, no heuristic needed');
});

test('event messages bury the anchor even though they never become one (AC9)', () => {
  reset();
  menuAnchor.compareAndSet('chat-1', null, { anchorMessageId: 500 });
  assert.equal(menuAnchor.decide({ chatId: 'chat-1' }).action, 'edit', 'fresh anchor');

  // An approval card and a digest land. Neither is a menu; both bury one.
  menuAnchor.noteMessage('chat-1', 501);
  menuAnchor.noteMessage('chat-1', 502);
  assert.equal(menuAnchor.decide({ chatId: 'chat-1' }).action, 'reanchor',
    'the next tap must land somewhere visible');
});

test('the tracker keeps the HIGHEST id, so out-of-order notes cannot rewind it', () => {
  reset();
  menuAnchor.noteMessage('chat-1', 900);
  menuAnchor.noteMessage('chat-1', 880);
  assert.equal(menuAnchor.latestMessageId('chat-1'), 900);
  for (const junk of [null, undefined, 0, -5, 'abc', NaN]) menuAnchor.noteMessage('chat-1', junk);
  assert.equal(menuAnchor.latestMessageId('chat-1'), 900, 'garbage is ignored, never throws');
});

test('chats do not leak into each other', () => {
  reset();
  menuAnchor.compareAndSet('A', null, { anchorMessageId: 10 });
  menuAnchor.compareAndSet('B', null, { anchorMessageId: 20 });
  menuAnchor.noteMessage('A', 50);
  assert.equal(menuAnchor.decide({ chatId: 'A' }).action, 'reanchor');
  assert.equal(menuAnchor.decide({ chatId: 'B' }).action, 'edit', 'B is untouched by A’s traffic');
});

/* ── concurrency ── */

test('compare-and-swap: the loser of a double-tap is told it lost', () => {
  reset();
  assert.equal(menuAnchor.compareAndSet('chat-1', null, { anchorMessageId: 100 }), true,
    'first write from no anchor');

  // Two executions both read 100. The first one re-anchors to 200.
  assert.equal(menuAnchor.compareAndSet('chat-1', 100, { anchorMessageId: 200 }), true);
  // The second still believes the anchor is 100 — it must NOT win.
  assert.equal(menuAnchor.compareAndSet('chat-1', 100, { anchorMessageId: 300 }), false,
    'the stale writer is refused, so it can delete the message it just sent');
  assert.equal(menuAnchor.get('chat-1').anchorMessageId, 200, 'the winner stands');
});

test('view and params ride the anchor so a re-anchor can rebuild the SAME screen (AC7)', () => {
  reset();
  menuAnchor.compareAndSet('chat-1', null, {
    anchorMessageId: 100, view: 'approvals.group', viewParams: { group: 'sales', page: 4 },
  });
  const a = menuAnchor.get('chat-1');
  assert.equal(a.view, 'approvals.group');
  assert.deepEqual(a.viewParams, { group: 'sales', page: 4 },
    'without these a re-anchor could only rebuild the root menu — trading one state-loss bug for another');
});

test('get() returns a copy — a caller cannot mutate stored state by accident', () => {
  reset();
  menuAnchor.compareAndSet('chat-1', null, { anchorMessageId: 100, viewParams: { page: 2 } });
  const a = menuAnchor.get('chat-1');
  a.anchorMessageId = 999;
  a.viewParams.page = 99;
  assert.equal(menuAnchor.get('chat-1').anchorMessageId, 100);
});

/* ── retiring the old menu ── */

test('retire deletes; if the delete fails it strips the keyboard; it never throws', async () => {
  reset();
  const deleted = [];
  const okBot = { deleteMessage: async (c, m) => { deleted.push([c, m]); return true; } };
  assert.equal(await menuAnchor.retire(okBot, 'chat-1', 100), 'deleted');
  assert.deepEqual(deleted, [['chat-1', '100']]);

  // Past 48h a bot may not delete its own message. An abandoned menu that
  // stays tappable is its own bug, so the keyboard comes off instead.
  const stripped = [];
  const oldBot = {
    deleteMessage: async () => { throw new Error('message can\'t be deleted'); },
    editMessageReplyMarkup: async (markup, opts) => { stripped.push([markup, opts]); return true; },
  };
  assert.equal(await menuAnchor.retire(oldBot, 'chat-1', 100), 'stripped');
  assert.deepEqual(stripped[0][0], { inline_keyboard: [] }, 'no tappable corpse');

  // Both failing is survivable: the NEW menu already exists by this point.
  const deadBot = {
    deleteMessage: async () => { throw new Error('gone'); },
    editMessageReplyMarkup: async () => { throw new Error('also gone'); },
  };
  assert.equal(await menuAnchor.retire(deadBot, 'chat-1', 100), 'failed',
    'reported, not thrown — a cleanup failure must never surface to the user');
});

test('retire is a no-op on missing arguments rather than an exception', async () => {
  assert.equal(await menuAnchor.retire(null, 'c', 1), 'failed');
  assert.equal(await menuAnchor.retire({}, null, 1), 'failed');
  assert.equal(await menuAnchor.retire({}, 'c', null), 'failed');
});

/* ── the lock ── */

test('withChatLock serialises one chat and leaves other chats concurrent', async () => {
  reset();
  const order = [];
  const slow = (tag, ms) => menuAnchor.withChatLock('same', async () => {
    order.push(`${tag}:start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${tag}:end`);
  });
  await Promise.all([slow('A', 20), slow('B', 1)]);
  assert.deepEqual(order, ['A:start', 'A:end', 'B:start', 'B:end'],
    'read → decide → write cannot interleave for one chat');
});
