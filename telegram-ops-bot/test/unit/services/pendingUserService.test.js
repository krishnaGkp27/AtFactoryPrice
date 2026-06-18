'use strict';

/**
 * USR-C2 — captureStranger: a stranger OR a previously-onboarded-then-
 * DEACTIVATED user who sends /start must (a) get the polite reply,
 * (b) be (re-)flagged pending in PendingUsers, and (c) ALWAYS re-notify
 * admins with a fresh Onboard card — even if the sheet write fails.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const pendingUsersRepo = require('../../../src/repositories/pendingUsersRepository');
const auditLogRepo = require('../../../src/repositories/auditLogRepository');
const adminFeed = require('../../../src/services/adminFeed');
const svc = require('../../../src/services/pendingUserService');

auditLogRepo.append = async () => {};

function fakeBot() {
  const calls = [];
  return {
    calls,
    async sendMessage(chatId, text, opts) { calls.push({ chatId, text, opts }); return { message_id: 1 }; },
  };
}

let notifies = [];
adminFeed.notify = async (bot, eventType, text, opts) => { notifies.push({ eventType, text, opts }); return { sent: 1, skipped: 0 }; };

function stubRepo({ existing = null } = {}) {
  const ops = { appended: null, statusUpdate: null };
  pendingUsersRepo.findByTelegramId = async () => existing;
  pendingUsersRepo.append = async (entry) => { ops.appended = entry; };
  pendingUsersRepo.updateStatus = async (id, status) => { ops.statusUpdate = { id: String(id), status }; return true; };
  return ops;
}

function msg(id) {
  return { from: { id, first_name: 'Office', last_name: 'BPanther', username: 'bpanther' }, chat: { id } };
}

test('brand-new stranger: polite reply + append(pending) + admin notified', async () => {
  svc._internals._resetRateLimitForTests();
  notifies = [];
  const ops = stubRepo({ existing: null });
  const bot = fakeBot();
  const res = await svc.captureStranger(bot, msg(5001));
  assert.equal(res.captured, true);
  assert.match(bot.calls[0].text, /not yet registered/i);
  assert.equal(ops.appended.status, 'pending');
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].eventType, 'user.pending');
});

test('deactivated user (row=onboarded) re-his: row re-pended + admin re-notified', async () => {
  svc._internals._resetRateLimitForTests();
  notifies = [];
  const ops = stubRepo({ existing: { telegram_id: '5002', status: 'onboarded' } });
  const bot = fakeBot();
  await svc.captureStranger(bot, msg(5002));
  assert.deepEqual(ops.statusUpdate, { id: '5002', status: 'pending' });
  assert.equal(notifies.length, 1, 'admin must be re-notified for a returning deactivated user');
});

test('re-ping while already pending: STILL re-notifies (fresh card each hi)', async () => {
  svc._internals._resetRateLimitForTests();
  notifies = [];
  const ops = stubRepo({ existing: { telegram_id: '5003', status: 'pending' } });
  const bot = fakeBot();
  await svc.captureStranger(bot, msg(5003));
  assert.equal(ops.appended, null);            // no duplicate row
  assert.equal(ops.statusUpdate, null);        // already pending, no rewrite
  assert.equal(notifies.length, 1, 'every /start re-notifies the admin');
});

test('sheet write failure does NOT suppress the admin notification', async () => {
  svc._internals._resetRateLimitForTests();
  notifies = [];
  stubRepo({ existing: null });
  pendingUsersRepo.append = async () => { throw new Error('PendingUsers tab missing'); };
  const bot = fakeBot();
  const res = await svc.captureStranger(bot, msg(5004));
  assert.equal(res.captured, true);
  assert.equal(notifies.length, 1, 'admin is notified even when the row write throws');
});

test('admin card escapes Markdown specials in the name (e.g. "Office_BPanther")', () => {
  const { _adminCard } = svc._internals;
  const card = _adminCard({
    telegram_id: '5009', username: 'b_panther',
    first_name: 'Office_BPanther', last_name: '*VIP*', arrived_at: '2026-06-18T14:45:00Z',
  });
  // The raw underscore/asterisks must be escaped so Telegram can parse it.
  assert.match(card, /Office\\_BPanther \\\*VIP\\\*/);
  assert.match(card, /@b\\_panther/);
  // No stray unescaped "**" (invalid Markdown-v1 bold) in the hint line.
  assert.doesNotMatch(card, /\*\*/);
});

test('rate limit caps the flood (no notify beyond the cap)', async () => {
  svc._internals._resetRateLimitForTests();
  notifies = [];
  stubRepo({ existing: { telegram_id: '5005', status: 'pending' } });
  const bot = fakeBot();
  const MAX = svc._internals.RATE_LIMIT_MAX;
  for (let i = 0; i < MAX; i += 1) await svc.captureStranger(bot, msg(5005));
  assert.equal(notifies.length, MAX);
  const res = await svc.captureStranger(bot, msg(5005)); // one past the cap
  assert.equal(res.reason, 'rate_limited');
  assert.equal(notifies.length, MAX, 'no extra notify once rate-limited');
});
