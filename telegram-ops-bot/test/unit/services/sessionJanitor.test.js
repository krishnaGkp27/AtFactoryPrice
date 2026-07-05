'use strict';

/**
 * SJ-1 — sessionStore timeout queue + sessionJanitor tombstoning.
 * Settings/audit are stubbed; bot is the recording fake. No sheets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');
const sessionStore = require('../../../src/utils/sessionStore');
const sessionJanitor = require('../../../src/services/sessionJanitor');
const settingsRepository = require('../../../src/repositories/settingsRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');

const MIN = 60 * 1000;
const audits = [];
auditLogRepository.append = async (event, meta, userId) => { audits.push({ event, meta, userId }); };
settingsRepository.getAll = async () => ({
  FLOW_CLEANUP_MINUTES: 30,
  FLOW_CLEANUP_MINUTES_HEAVY: 60,
  FLOW_CLEANUP_HEAVY_TYPES: 'supply_req_flow',
});

function drainAll() {
  sessionStore.sweepExpired();
  sessionStore.drainExpiredForCleanup();
  sessionJanitor._internals.pending.length = 0;
  audits.length = 0;
  sessionJanitor.invalidateConfigCache();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('sweepExpired queues TIMED-OUT sessions; clear() does not', async () => {
  drainAll();
  sessionStore.set('u1', { type: 'sample_flow', flowMessageId: 11, ttlMs: 1 });
  sessionStore.set('u2', { type: 'order_flow', flowMessageId: 22 });   // alive
  sessionStore.set('u3', { type: 'grn_flow', flowMessageId: 33 });
  sessionStore.clear('u3');                                            // deliberate completion
  await sleep(5);
  sessionStore.sweepExpired();
  const q = sessionStore.drainExpiredForCleanup();
  assert.deepEqual(q.map((e) => e.userId), ['u1'], 'only the timeout is queued');
  assert.equal(q[0].flowMessageId, 11);
  sessionStore.clear('u2');
  sessionStore.drainExpiredForCleanup();
});

test('tick: young entries wait, aged entries get tombstoned with menu button', async () => {
  drainAll();
  sessionStore.set('u5', { type: 'sample_flow', step: 'shade', flowMessageId: 55, ttlMs: 1 });
  await sleep(5);
  const bot = createFakeBot();

  // First pass — expired but inside the 30-min grace: nothing cleaned.
  assert.equal(await sessionJanitor.tick(bot), 0);
  assert.equal(sessionJanitor._internals.pending.length, 1, 'held for grace');

  // Age it past the default grace and tick again.
  sessionJanitor._internals.pending[0].lastActiveAt = Date.now() - 31 * MIN;
  assert.equal(await sessionJanitor.tick(bot), 1);
  const edit = bot.callsTo('editMessageText')[0];
  assert.match(edit.args.text, /Give Sample timed out — nothing was saved/);
  assert.equal(edit.args.opts.message_id, 55);
  const kb = edit.args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === 'act:__back__'), 'menu button present');
  assert.deepEqual(audits, [{ event: 'flow_expired', meta: { type: 'sample_flow', step: 'shade' }, userId: 'u5' }]);
});

test('heavy flow honors the longer FLOW_CLEANUP_MINUTES_HEAVY grace', async () => {
  drainAll();
  sessionStore.set('u6', { type: 'supply_req_flow', flowMessageId: 66, ttlMs: 1 });
  await sleep(5);
  const bot = createFakeBot();
  await sessionJanitor.tick(bot);
  // 45 min old: past the 30-min default but inside the 60-min heavy grace.
  sessionJanitor._internals.pending[0].lastActiveAt = Date.now() - 45 * MIN;
  assert.equal(await sessionJanitor.tick(bot), 0, 'heavy flow still protected at 45 min');
  sessionJanitor._internals.pending[0].lastActiveAt = Date.now() - 61 * MIN;
  assert.equal(await sessionJanitor.tick(bot), 1, 'cleaned after heavy grace');
});

test('un-editable message falls back to stripping the keyboard; previews deleted', async () => {
  drainAll();
  sessionStore.set('u7', { type: 'supply_req_flow', flowMessageId: 77, previewMessageId: 78, comboMessageId: 79, ttlMs: 1 });
  await sleep(5);
  const bot = createFakeBot();
  bot.editMessageText = async () => { throw new Error('message is a photo'); };
  await sessionJanitor.tick(bot);
  sessionJanitor._internals.pending[0].lastActiveAt = Date.now() - 61 * MIN;
  await sessionJanitor.tick(bot);
  const strips = bot.callsTo('editMessageReplyMarkup');
  assert.equal(strips.length, 1, 'keyboard stripped as fallback');
  assert.deepEqual(strips[0].args.replyMarkup, { inline_keyboard: [] });
  const deleted = bot.callsTo('deleteMessage').map((c) => c.args.messageId).sort();
  assert.deepEqual(deleted, [78, 79], 'transient previews deleted');
});

test('humanize: known labels + generic fallback', () => {
  assert.equal(sessionJanitor._internals.humanize('supply_req_flow'), 'Supply Request');
  assert.equal(sessionJanitor._internals.humanize('add_note_flow'), 'Add note');
  assert.equal(sessionJanitor._internals.humanize(''), 'This process');
});

test('SJ-2: user returning to an expired flow triggers an INSTANT tombstone (no grace wait)', async () => {
  drainAll();
  const bot = createFakeBot();
  sessionJanitor.start(bot, { intervalMs: 3600 * 1000 }); // interval never fires in-test
  try {
    sessionStore.set('u8', { type: 'supply_req_flow', step: 'design', flowMessageId: 88, ttlMs: 1 });
    await sleep(5);
    // The user comes back: any handler reading their session discovers expiry.
    assert.equal(sessionStore.get('u8'), null);
    await sleep(10); // hook tombstones asynchronously
    const edit = bot.callsTo('editMessageText')[0];
    assert.ok(edit, 'hanging message transformed immediately on return');
    assert.match(edit.args.text, /Supply Request timed out/);
    assert.equal(edit.args.opts.message_id, 88);
    // Consumed by the hook — nothing left for the grace-period sweep.
    assert.equal(sessionStore.drainExpiredForCleanup().length, 0, 'no double-clean later');
  } finally {
    sessionJanitor.stop();
  }
});

test('SJ-2: stop() detaches the hook — expiry falls back to the grace queue', async () => {
  drainAll();
  const bot = createFakeBot();
  sessionJanitor.start(bot, { intervalMs: 3600 * 1000 });
  sessionJanitor.stop();
  sessionStore.set('u9', { type: 'sample_flow', flowMessageId: 99, ttlMs: 1 });
  await sleep(5);
  assert.equal(sessionStore.get('u9'), null);
  await sleep(10);
  assert.equal(bot.callsTo('editMessageText').length, 0, 'no instant edit after stop()');
  const q = sessionStore.drainExpiredForCleanup();
  assert.deepEqual(q.map((e) => e.userId), ['u9'], 'queued for the sweep instead');
});
