'use strict';

/**
 * adminFeed.notify — a Markdown parse failure on one admin must NOT silently
 * drop the notification; it retries once as plain text. (Root cause of the
 * "deactivated user says hi but admin gets no card" bug: the pending card had
 * an unescaped "_" in the name, so the Markdown send threw and was swallowed.)
 */

process.env.ADMIN_IDS = '111,222';

const test = require('node:test');
const assert = require('node:assert/strict');

const usersRepo = require('../../../src/repositories/usersRepository');
const adminFeed = require('../../../src/services/adminFeed');

usersRepo.findByUserId = async () => ({ notification_prefs: null });

test('falls back to plain text when a Markdown send throws', async () => {
  const calls = [];
  const bot = {
    async sendMessage(id, text, opts) {
      calls.push({ id, hasParseMode: !!(opts && opts.parse_mode) });
      if (opts && opts.parse_mode) throw new Error("ETELEGRAM: 400 can't parse entities");
    },
  };
  const res = await adminFeed.notify(bot, 'goods.received', 'Name: Office_BPanther', { parse_mode: 'Markdown' });
  // Both admins delivered via the plain-text retry.
  assert.equal(res.sent, 2);
  assert.equal(res.skipped, 0);
  // Each admin: one failed Markdown attempt + one successful plain attempt.
  const plain = calls.filter((c) => !c.hasParseMode);
  assert.equal(plain.length, 2);
});

test('counts skipped only when both Markdown and plain sends fail', async () => {
  const bot = { async sendMessage() { throw new Error('chat not found'); } };
  const res = await adminFeed.notify(bot, 'goods.received', 'x', { parse_mode: 'Markdown' });
  assert.equal(res.sent, 0);
  assert.equal(res.skipped, 2);
});
