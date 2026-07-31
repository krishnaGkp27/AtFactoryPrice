'use strict';

/**
 * SJ-4 — flowKit.trackAux / disposeAux: auxiliary flow messages (catalogue
 * photo cards, interim prompts, validation nags) are tracked on the session
 * and deleted when the flow completes/cancels, leaving only the sealed
 * receipt. The janitor path (abandonment) rides the session snapshot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');
const sessionStore = require('../../../src/utils/sessionStore');
const { trackAux, disposeAux } = require('../../../src/utils/flowKit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('trackAux appends to the stored session, dedupes, and survives read-modify-write set()', () => {
  sessionStore.set('a1', { type: 'sell_bale_flow', flowMessageId: 10 });
  trackAux('a1', 101);
  trackAux('a1', 102);
  trackAux('a1', 101); // dupe — ignored
  let s = sessionStore.get('a1');
  assert.deepEqual(s._auxMsgIds, [101, 102]);

  // The standard flow pattern: read, mutate, set — aux ids must ride along.
  s.step = 'next';
  sessionStore.set('a1', s);
  s = sessionStore.get('a1');
  assert.deepEqual(s._auxMsgIds, [101, 102], 'aux ids survive re-set');
  sessionStore.clear('a1');
});

test('trackAux ignores falsy ids and missing sessions; caps at 20', () => {
  trackAux('nobody', 55); // no session — must not throw or create one
  assert.equal(sessionStore.get('nobody'), null);

  sessionStore.set('a2', { type: 'grn_flow' });
  trackAux('a2', 0);
  trackAux('a2', null);
  assert.equal(sessionStore.get('a2')._auxMsgIds, undefined, 'falsy ids never tracked');
  for (let i = 1; i <= 25; i += 1) trackAux('a2', 200 + i);
  assert.equal(sessionStore.get('a2')._auxMsgIds.length, 20, 'bounded at 20');
  sessionStore.clear('a2');
});

test('disposeAux deletes every tracked message once and empties the list', async () => {
  const bot = createFakeBot();
  sessionStore.set('a3', { type: 'sale_flow', _auxMsgIds: [301, 302, 303] });
  await disposeAux(bot, 999, 'a3');
  const deleted = bot.callsTo('deleteMessage').map((c) => c.args.messageId).sort();
  assert.deepEqual(deleted, [301, 302, 303]);
  assert.deepEqual(sessionStore.get('a3')._auxMsgIds, [], 'list drained');

  // Second call is a no-op — nothing double-deleted.
  await disposeAux(bot, 999, 'a3');
  assert.equal(bot.callsTo('deleteMessage').length, 3);
  sessionStore.clear('a3');
});

test('disposeAux tolerates deleteMessage failures (already-gone messages)', async () => {
  const bot = createFakeBot();
  bot.deleteMessage = async () => { throw new Error('ETELEGRAM: 400 message to delete not found'); };
  sessionStore.set('a4', { type: 'sale_flow', _auxMsgIds: [401, 402] });
  await assert.doesNotReject(disposeAux(bot, 999, 'a4'));
  assert.deepEqual(sessionStore.get('a4')._auxMsgIds, [], 'list drained even on failure');
  sessionStore.clear('a4');
});

test('disposeAux without a session (or without aux ids) is a silent no-op', async () => {
  const bot = createFakeBot();
  await assert.doesNotReject(disposeAux(bot, 999, 'ghost'));
  sessionStore.set('a5', { type: 'order_flow', flowMessageId: 1 });
  await assert.doesNotReject(disposeAux(bot, 999, 'a5'));
  assert.equal(bot.callsTo('deleteMessage').length, 0);
  sessionStore.clear('a5');
});

test('timeout snapshot carries auxMsgIds + confirmMsgId to the janitor queue (abandonment path)', async () => {
  sessionStore.sweepExpired();
  sessionStore.drainExpiredForCleanup();
  sessionStore.set('a6', { type: 'sell_bale_flow', flowMessageId: 61, _auxMsgIds: [611, 612], confirmMsgId: 613, ttlMs: 1 });
  await sleep(5);
  sessionStore.sweepExpired();
  const q = sessionStore.drainExpiredForCleanup();
  const snap = q.find((e) => e.userId === 'a6');
  assert.ok(snap, 'expired session snapshotted');
  assert.deepEqual(snap.auxMsgIds, [611, 612], 'aux ids ride the snapshot');
  assert.equal(snap.confirmMsgId, 613, 'sale confirm card rides the snapshot');
});

test('disposeAux({except}) spares the tapped message so it can be fold-edited', async () => {
  const bot = createFakeBot();
  sessionStore.set('a7', { type: 'supply_req_flow', _auxMsgIds: [701, 702, 703] });
  await disposeAux(bot, 999, 'a7', { except: 702 });
  const deleted = bot.callsTo('deleteMessage').map((c) => c.args.messageId).sort();
  assert.deepEqual(deleted, [701, 703], 'tapped message spared');
  assert.deepEqual(sessionStore.get('a7')._auxMsgIds, [], 'list still drained');
  sessionStore.clear('a7');
});

// ORDERING CONSTRAINT (documented, not a bug pin): trackAux mutates the
// STORED session; when it must CREATE _auxMsgIds, a stale local captured
// before an intervening set() will not have the array — re-saving that
// stale local drops the freshly tracked id. Call sites must therefore run
// trackAux AFTER their last save() (see sellBaleFlow.showBales).
test('KNOWN LIMIT: re-saving a stale pre-trackAux local drops a freshly created aux list', () => {
  const stale = { type: 'grn_flow', step: 'a' };
  sessionStore.set('a8', stale);           // store now holds a spread COPY
  trackAux('a8', 801);                     // creates _auxMsgIds on the copy only
  stale.step = 'b';
  sessionStore.set('a8', stale);           // stale local overwrites the copy
  assert.equal(sessionStore.get('a8')._auxMsgIds, undefined, 'id 801 was dropped — order trackAux after the last save()');
  sessionStore.clear('a8');
});
