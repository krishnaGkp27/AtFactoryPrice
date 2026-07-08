'use strict';

/**
 * SEC-P2 — asyncMutex: per-key in-process serialization used to make the
 * Sheets "read status → act → write status" critical sections atomic against
 * concurrent Telegram taps of the same request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mutex = require('../../../src/utils/asyncMutex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('same key runs one-at-a-time in arrival order (no interleave)', async () => {
  const events = [];
  const critical = (id) => async () => {
    events.push(`start:${id}`);
    await sleep(15);
    events.push(`end:${id}`);
  };
  await Promise.all([
    mutex.runExclusive('K', critical('A')),
    mutex.runExclusive('K', critical('B')),
    mutex.runExclusive('K', critical('C')),
  ]);
  // Each critical section fully brackets before the next starts.
  assert.deepEqual(events, [
    'start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C',
  ]);
});

test('different keys run concurrently', async () => {
  const events = [];
  const critical = (id) => async () => {
    events.push(`start:${id}`);
    await sleep(20);
    events.push(`end:${id}`);
  };
  await Promise.all([
    mutex.runExclusive('K1', critical('A')),
    mutex.runExclusive('K2', critical('B')),
  ]);
  // Both start before either ends → interleaved (concurrent).
  assert.equal(events[0].startsWith('start:'), true);
  assert.equal(events[1].startsWith('start:'), true);
  assert.deepEqual(new Set(events.slice(0, 2)), new Set(['start:A', 'start:B']));
});

test('a throwing critical section does not wedge the next waiter', async () => {
  const results = [];
  const boom = mutex.runExclusive('K', async () => { throw new Error('boom'); });
  await assert.rejects(() => boom, /boom/);
  await mutex.runExclusive('K', async () => { results.push('ran'); });
  assert.deepEqual(results, ['ran']);
});

test('returns the critical section result and drains the key map', async () => {
  const out = await mutex.runExclusive('K', async () => 42);
  assert.equal(out, 42);
  // Let microtasks settle so the drain cleanup runs.
  await sleep(0);
  assert.equal(mutex._internals.activeKeys(), 0);
});
