'use strict';

/**
 * MNU-1 — the callback-answer safety net.
 *
 * Until a callback_query is answered the client keeps a spinner on the
 * button. The controller answers in 262 places, but nothing guaranteed that
 * EVERY path did, and Telegram accepts only ONE answer per query — so the
 * obvious fix (answer first, at the dispatcher) would win the race and
 * silently discard every deliberate toast and alert the branches send.
 *
 * Pinned here: branch answers are recorded and left alone; only an
 * unanswered query gets the net's empty answer; and a stale callback id
 * (the tap is long gone) is swallowed rather than thrown.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const callbackAck = require('../../../src/utils/callbackAck');

function freshBot() {
  const calls = [];
  const bot = {
    answerCallbackQuery: async (id, opts) => { calls.push({ id, opts }); return true; },
  };
  callbackAck.install(bot);
  return { bot, calls };
}

test('a branch answer is recorded, and the net does NOT answer again', async () => {
  callbackAck._resetForTests();
  const { bot, calls } = freshBot();

  // A branch answers with a real toast, exactly as the controller does today.
  await bot.answerCallbackQuery('q-1', { text: 'Opening Sales…' });
  assert.equal(callbackAck.wasAnswered('q-1'), true);

  const netAnswered = await callbackAck.ensureAnswered(bot, { id: 'q-1' });
  assert.equal(netAnswered, false, 'the net stays silent — a second answer would be discarded anyway');
  assert.equal(calls.length, 1, 'exactly one answer reached Telegram');
  assert.equal(calls[0].opts.text, 'Opening Sales…', 'and it is the branch’s, with its text intact');
});

test('a path that never answers gets an EMPTY answer — spinner cleared, nothing printed', async () => {
  callbackAck._resetForTests();
  const { bot, calls } = freshBot();

  const netAnswered = await callbackAck.ensureAnswered(bot, { id: 'q-2' });
  assert.equal(netAnswered, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'q-2');
  assert.equal(calls[0].opts, undefined,
    'no text — the net must not talk over a branch that chose to say nothing visible');
});

test('a stale callback id is swallowed, never thrown', async () => {
  callbackAck._resetForTests();
  const bot = callbackAck.install({
    answerCallbackQuery: async () => { throw new Error('query is too old'); },
  });
  assert.equal(await callbackAck.ensureAnswered(bot, { id: 'q-old' }), false,
    'an expired tap is not an error condition');
});

test('install is idempotent and tolerant of a missing bot', () => {
  callbackAck._resetForTests();
  const { bot } = freshBot();
  const wrapped = bot.answerCallbackQuery;
  callbackAck.install(bot);
  assert.equal(bot.answerCallbackQuery, wrapped, 'wrapping twice would double-count, and could double-answer');
  assert.doesNotThrow(() => callbackAck.install(null));
  assert.doesNotThrow(() => callbackAck.install({}));
});

test('the recorder is bounded — it cannot grow without limit in a long-lived process', async () => {
  callbackAck._resetForTests();
  const { bot } = freshBot();
  for (let i = 0; i < 2100; i++) await bot.answerCallbackQuery(`q-${i}`);
  assert.equal(callbackAck.wasAnswered('q-2099'), true, 'recent ids are remembered');
  assert.equal(callbackAck.wasAnswered('q-0'), false, 'the oldest have aged out');
});
