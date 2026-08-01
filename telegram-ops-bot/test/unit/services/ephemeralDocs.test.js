'use strict';

/**
 * TRF-9b — ephemeral doc views: swept on navigation, replaced on re-fetch,
 * TTL backstop honours Settings DOC_VIEW_MINUTES.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');
const settingsRepository = require('../../../src/repositories/settingsRepository');
const ephemeralDocs = require('../../../src/services/ephemeralDocs');

let settingsStub = {};
settingsRepository.getAll = async () => settingsStub;

test.beforeEach(() => { ephemeralDocs._internals._resetForTests(); settingsStub = {}; });
test.after(() => ephemeralDocs._internals._resetForTests());

test('sweep deletes every tracked view once and forgets the user', async () => {
  const bot = createFakeBot();
  ephemeralDocs.track(bot, 'u1', 500, 11);
  ephemeralDocs.track(bot, 'u1', 500, 12);
  ephemeralDocs.track(bot, 'u2', 600, 21); // another user — untouched
  assert.equal(await ephemeralDocs.sweep(bot, 'u1'), 2);
  const deleted = bot.callsTo('deleteMessage').map((c) => c.args.messageId).sort();
  assert.deepEqual(deleted, [11, 12]);
  assert.equal(await ephemeralDocs.sweep(bot, 'u1'), 0, 'second sweep is a no-op');
  assert.equal(await ephemeralDocs.sweep(bot, 'u2'), 1, 'other user swept independently');
});

test('sweep survives deleteMessage failures', async () => {
  const bot = createFakeBot();
  bot.deleteMessage = async () => { throw new Error('message to delete not found'); };
  ephemeralDocs.track(bot, 'u3', 500, 31);
  await assert.doesNotReject(ephemeralDocs.sweep(bot, 'u3'));
});

test('per-user tracking is capped', () => {
  const bot = createFakeBot();
  for (let i = 1; i <= 15; i += 1) ephemeralDocs.track(bot, 'u4', 500, 100 + i);
  assert.equal(ephemeralDocs._internals._byUser.get('u4').length, 10);
});

test('TTL pass deletes only views older than DOC_VIEW_MINUTES', async () => {
  settingsStub = { DOC_VIEW_MINUTES: 15 };
  const bot = createFakeBot();
  ephemeralDocs.track(bot, 'u5', 500, 51);
  ephemeralDocs.track(bot, 'u5', 500, 52);
  const list = ephemeralDocs._internals._byUser.get('u5');
  list[0].at = Date.now() - 16 * 60 * 1000; // stale
  await ephemeralDocs._internals._ttlPass(bot);
  const deleted = bot.callsTo('deleteMessage').map((c) => c.args.messageId);
  assert.deepEqual(deleted, [51], 'only the stale view deleted');
  assert.equal(ephemeralDocs._internals._byUser.get('u5').length, 1, 'fresh view still tracked');
});

test('DOC_VIEW_MINUTES=0 turns the backstop off (navigation sweeps still work)', async () => {
  settingsStub = { DOC_VIEW_MINUTES: 0 };
  const bot = createFakeBot();
  ephemeralDocs.track(bot, 'u6', 500, 61);
  ephemeralDocs._internals._byUser.get('u6')[0].at = Date.now() - 999 * 60 * 1000;
  await ephemeralDocs._internals._ttlPass(bot);
  assert.equal(bot.callsTo('deleteMessage').length, 0, 'timer disabled');
  assert.equal(await ephemeralDocs.sweep(bot, 'u6'), 1, 'manual sweep unaffected');
});
