'use strict';

/**
 * QTA-1 — the Sheets write governor and the plain quota error.
 *
 * Google caps Sheets WRITE requests at 60 per minute per user (the service
 * account is one user for every flow). Every write takes a slot from a
 * rolling one-minute window first; a full window WAITS for the oldest
 * write to age out instead of sending a request Google refuses. The retry
 * stays as the backstop, and when it is spent the admin reads what to do,
 * not Google's "Quota exceeded for quota metric 'Write requests' … for
 * consumer 'project_number:…'".
 */

process.env.SHEETS_WRITES_PER_MINUTE = '3';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../../../src/repositories/sheetsClient');
const { isQuotaError, isRetryableError, withRetry, governedWrite, acquireWriteSlot, governor, quotaExhaustedError, GOOGLE_WRITE_CAP, DEFAULT_WRITE_CAP } = _internals;
const config = require('../../../src/config');

/** A fake clock the governor and the retry sleep against. */
function fakeClock() {
  let t = 1_000_000;
  const sleeps = [];
  governor.now = () => t;
  governor.sleep = async (ms) => { sleeps.push(ms); t += ms; };
  governor.stamps.length = 0;
  governor.gate = Promise.resolve();
  return { sleeps, tick: (ms) => { t += ms; }, at: () => t };
}

test('isQuotaError: every shape Google sends — numeric 429, string "429", RESOURCE_EXHAUSTED, the message', () => {
  assert.equal(isQuotaError({ code: 429 }), true);
  assert.equal(isQuotaError({ code: '429' }), true, 'gaxios reports the code as a string');
  assert.equal(isQuotaError({ response: { status: 429 } }), true);
  assert.equal(isQuotaError({ errors: [{ reason: 'rateLimitExceeded' }] }), true);
  assert.equal(isQuotaError({ response: { data: { error: { status: 'RESOURCE_EXHAUSTED' } } } }), true);
  assert.equal(isQuotaError(new Error("Quota exceeded for quota metric 'Write requests' and limit 'Write requests per minute per user'")), true);
  assert.equal(isQuotaError({ code: 500, message: 'Internal error' }), false);
  assert.equal(isRetryableError({ code: '503' }), true);
  assert.equal(isRetryableError({ code: 400 }), false);
});

test('withRetry: a quota refusal that outlives the retries becomes one plain sentence with the cause attached', async () => {
  fakeClock();
  const google = new Error("Quota exceeded for quota metric 'Write requests' and limit 'Write requests per minute per user' of service 'sheets.googleapis.com' for consumer 'project_number:660895645396'.");
  google.code = 429;
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls += 1; throw google; }, 'updateRange(Inventory)', 'writes'),
    (e) => e.code === 'SHEETS_QUOTA'
      && e.message === 'Google Sheets is rate-limiting writes right now — wait one minute, then tap again. (updateRange(Inventory))'
      && e.cause === google,
  );
  assert.equal(calls, 6, 'first try + five retries');

  // A non-quota error is thrown as it is, first time.
  calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw new Error('Unable to parse range'); }, 'x'), /Unable to parse range/);
  assert.equal(calls, 1);

  // A quota error that clears on a retry is invisible to the caller.
  let n = 0;
  const v = await withRetry(async () => { n += 1; if (n < 3) throw google; return 'ok'; }, 'x');
  assert.equal(v, 'ok');
});

test('the message names writes for a write and reads for a read', () => {
  const e = quotaExhaustedError(new Error('x'), 'appendRows(Transactions)', 'writes');
  assert.match(e.message, /^Google Sheets is rate-limiting writes right now — wait one minute, then tap again\./);
  const r = quotaExhaustedError(new Error('x'), 'readRange(Inventory)');
  assert.match(r.message, /^Google Sheets is rate-limiting reads right now/);
});

test('governedWrite meters EVERY attempt: a retry after a 429 takes a slot too', async () => {
  const clock = fakeClock();
  const google = Object.assign(new Error('Quota exceeded'), { code: 429 });
  let n = 0;
  await governedWrite(async () => { n += 1; if (n < 3) throw google; return 'ok'; }, 'appendRows(Transactions)');
  assert.equal(n, 3);
  assert.equal(governor.stamps.length, 3, 'three attempts, three slots — not one');
});

test('the cap is validated: a typo falls back to the default, a value above Google\'s cap is clamped, 0 stays off', () => {
  const saved = config.sheets.writesPerMinute;
  try {
    config.sheets.writesPerMinute = 'abc';
    assert.equal(governor.cap(), DEFAULT_WRITE_CAP);
    config.sheets.writesPerMinute = NaN;
    assert.equal(governor.cap(), DEFAULT_WRITE_CAP);
    config.sheets.writesPerMinute = 70;
    assert.equal(governor.cap(), GOOGLE_WRITE_CAP);
    config.sheets.writesPerMinute = 0;
    assert.equal(governor.cap(), 0);
    config.sheets.writesPerMinute = 30;
    assert.equal(governor.cap(), 30);
  } finally { config.sheets.writesPerMinute = saved; }
});

test('governor: the cap-th write goes at once, the next waits until the oldest write is a minute old', async () => {
  const clock = fakeClock();
  await acquireWriteSlot('w1'); clock.tick(1000);
  await acquireWriteSlot('w2'); clock.tick(1000);
  await acquireWriteSlot('w3');
  assert.deepEqual(clock.sleeps, [], 'three writes inside the cap never wait');
  clock.tick(10_000);
  await acquireWriteSlot('w4');
  // w1 went at t0; at t0+12s the window has 48s left (+50ms guard).
  assert.deepEqual(clock.sleeps, [60_000 - 12_000 + 50]);
  assert.equal(governor.stamps.length, 3, 'w1 aged out, w4 took its place');
  // A fifth write right after must wait for w2 (sent at t0+1s).
  await acquireWriteSlot('w5');
  assert.equal(clock.sleeps.length, 2);
});

test('governor: concurrent callers are served in order and never over-subscribe the window', async () => {
  const clock = fakeClock();
  const order = [];
  await Promise.all([1, 2, 3, 4, 5].map((i) => acquireWriteSlot(`c${i}`).then(() => order.push(i))));
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
  // The fourth waited a full window; by then the first three had aged out,
  // so the fifth found room without waiting again.
  assert.deepEqual(clock.sleeps, [60_050]);
  assert.ok(governor.stamps.length <= 3, 'never more than the cap inside one window');
});

test('governor: a cap of 0 switches the wait off', async () => {
  const clock = fakeClock();
  const saved = governor.cap;
  governor.cap = () => 0;
  try {
    for (let i = 0; i < 10; i += 1) await acquireWriteSlot('free');
    assert.deepEqual(clock.sleeps, []);
  } finally { governor.cap = saved; }
});
