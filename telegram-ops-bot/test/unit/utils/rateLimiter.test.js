'use strict';

/**
 * P3 — sliding-window rate limiter: per-key isolation, cap enforcement,
 * window expiry, and input validation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLimiter } = require('../../../src/utils/rateLimiter');

test('allows up to max hits, then blocks', () => {
  const limiter = createLimiter({ windowMs: 60_000, max: 3 });
  assert.equal(limiter.allow('u1'), true);
  assert.equal(limiter.allow('u1'), true);
  assert.equal(limiter.allow('u1'), true);
  assert.equal(limiter.allow('u1'), false, '4th hit inside the window is blocked');
  assert.equal(limiter.allow('u1'), false, 'blocked attempts are not counted (still blocked, not extended)');
});

test('keys are isolated buckets', () => {
  const limiter = createLimiter({ windowMs: 60_000, max: 1 });
  assert.equal(limiter.allow('u1'), true);
  assert.equal(limiter.allow('u1'), false);
  assert.equal(limiter.allow('u2'), true, 'a different user is unaffected');
});

test('hits age out of the window', async () => {
  const limiter = createLimiter({ windowMs: 50, max: 1 });
  assert.equal(limiter.allow('u1'), true);
  assert.equal(limiter.allow('u1'), false);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(limiter.allow('u1'), true, 'allowed again after the window passed');
});

test('rejects nonsense configs', () => {
  assert.throws(() => createLimiter({ windowMs: 0, max: 5 }), /must be > 0/);
  assert.throws(() => createLimiter({ windowMs: 1000, max: 0 }), /must be > 0/);
});
