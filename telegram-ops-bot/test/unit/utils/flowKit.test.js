'use strict';

/**
 * flowKit + ttlCache — shared flow building blocks (dedup refactor).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');
const sessionStore = require('../../../src/utils/sessionStore');
const { makeRenderer, rowsFor, guardSession } = require('../../../src/utils/flowKit');
const { ttlCache } = require('../../../src/utils/ttlCache');

// ---- makeRenderer ----

test('render edits in place when the session has an anchor', async () => {
  sessionStore.set('r1', { type: 'x_flow', flowMessageId: 42 });
  const bot = createFakeBot();
  const render = makeRenderer();
  const mid = await render(bot, 'c', 'r1', 'hello', [[{ text: 'b', callback_data: 'x:b' }]]);
  assert.equal(mid, 42);
  const edit = bot.callsTo('editMessageText')[0];
  assert.equal(edit.args.opts.message_id, 42);
  assert.equal(edit.args.opts.parse_mode, 'Markdown');
  sessionStore.clear('r1');
});

test('render falls back to a fresh send and re-anchors when the edit fails', async () => {
  sessionStore.set('r2', { type: 'x_flow', flowMessageId: 42 });
  const bot = createFakeBot();
  bot.editMessageText = async () => { throw new Error('message not found'); };
  const render = makeRenderer();
  const mid = await render(bot, 'c', 'r2', 'hello', []);
  assert.ok(mid > 42, 'fresh message id');
  assert.equal(sessionStore.get('r2').flowMessageId, mid, 're-anchored');
  sessionStore.clear('r2');
});

test('render without a session still sends (no crash, no anchor)', async () => {
  sessionStore.clear('r3');
  const bot = createFakeBot();
  const render = makeRenderer();
  const mid = await render(bot, 'c', 'r3', 'hello', []);
  assert.ok(mid, 'sent fresh');
  assert.equal(sessionStore.get('r3'), null);
});

test('renderer option requireSession: renders nothing without a session', async () => {
  sessionStore.clear('r5');
  const bot = createFakeBot();
  const render = makeRenderer({ requireSession: true });
  const mid = await render(bot, 'c', 'r5', 'hello', []);
  assert.equal(mid, null);
  assert.equal(bot.callsTo('sendMessage').length, 0, 'strict variant sends nothing');
});

test('renderer options: plain text + disabled preview', async () => {
  sessionStore.clear('r4');
  const bot = createFakeBot();
  const render = makeRenderer({ parseMode: null, disablePreview: true });
  await render(bot, 'c', 'r4', 'hello', []);
  const sent = bot.callsTo('sendMessage')[0];
  assert.equal(sent.args.opts.parse_mode, undefined);
  assert.equal(sent.args.opts.disable_web_page_preview, true);
});

test('renderer option titlePrefix: every screen carries the flow header', async () => {
  sessionStore.clear('r6');
  const bot = createFakeBot();
  const render = makeRenderer({ titlePrefix: '🏷️ *Header*\n\n' });
  await render(bot, 'c', 'r6', 'body text', []);
  assert.equal(bot.callsTo('sendMessage')[0].args.text, '🏷️ *Header*\n\nbody text');
});

// ---- chunk + mdEscape (the per-flow clones, consolidated) ----

test('chunk lays flat buttons into rows; guards bad input', () => {
  const { chunk } = require('../../../src/utils/flowKit');
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  assert.deepEqual(chunk([1, 2], 0), [[1], [2]], 'perRow floor of 1');
});

test('mdEscape escapes Markdown-v1 specials only', () => {
  const { mdEscape } = require('../../../src/utils/flowKit');
  assert.equal(mdEscape('a_b*c`d[e]'), 'a\\_b\\*c\\`d\\[e\\]');
  assert.equal(mdEscape('plain'), 'plain');
  assert.equal(mdEscape(null), '');
});

// ---- rowsFor ----

test('rowsFor builds namespaced rows + session-free menu row', () => {
  const rows = rowsFor('udf');
  assert.deepEqual(rows.backRow(), [{ text: '⬅ Back', callback_data: 'udf:back' }]);
  assert.deepEqual(rows.cancelRow(), [{ text: '❌ Cancel', callback_data: 'udf:cancel' }]);
  assert.deepEqual(rows.closeRow(), [{ text: '❌ Close', callback_data: 'udf:close' }]);
  assert.equal(rows.backAndCancelRow('⬅ Shades').length, 2);
  assert.deepEqual(rows.menuRow(), [{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]);
});

// ---- guardSession ----

test('guardSession answers the callback and returns the matching session', async () => {
  sessionStore.set('g1', { type: 'y_flow', step: 's' });
  const bot = createFakeBot();
  const q = { id: 'cb', data: 'y:x', from: { id: 'g1' }, message: { chat: { id: 'g1' }, message_id: 1 } };
  const ctx = await guardSession(bot, q, 'y_flow');
  assert.equal(ctx.session.step, 's');
  assert.equal(bot.callsTo('answerCallbackQuery').length, 1);
  sessionStore.clear('g1');
});

test('guardSession returns null (+optional notice) on missing/mismatched session', async () => {
  sessionStore.clear('g2');
  const bot = createFakeBot();
  const q = { id: 'cb', data: 'y:x', from: { id: 'g2' }, message: { chat: { id: 'g2' }, message_id: 1 } };
  const ctx = await guardSession(bot, q, 'y_flow', { expiredText: 'expired — reopen from menu' });
  assert.equal(ctx, null);
  assert.match(bot.allText(), /expired — reopen/);
});

// ---- ttlCache ----

test('ttlCache: loads once within TTL, reloads after invalidate', async () => {
  let loads = 0;
  const cache = ttlCache(60 * 1000, async () => { loads += 1; return `v${loads}`; });
  assert.equal(await cache.get(), 'v1');
  assert.equal(await cache.get(), 'v1');
  assert.equal(loads, 1, 'served from cache');
  cache.invalidate();
  assert.equal(await cache.get(), 'v2');
  assert.equal(loads, 2);
});

test('ttlCache: expired TTL reloads; loader errors propagate on cold cache', async () => {
  let loads = 0;
  const cache = ttlCache(1, async () => { loads += 1; return loads; });
  assert.equal(await cache.get(), 1);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await cache.get(), 2, 'reloaded after expiry');

  const boom = ttlCache(1000, async () => { throw new Error('ttlCache test: loader down'); });
  await assert.rejects(() => boom.get(), /loader down/);
});
