'use strict';

/**
 * asyncMutex — in-process, per-key async serialization.
 *
 * Google Sheets has no transactions, row locks, or compare-and-set, so the
 * repository layer's "read status → act → write status" sequences race when
 * two Telegram updates land at the same instant (the classic case: two admins
 * both tapping Approve on the same request, or a dispatcher double-tapping
 * Dispatch). The bot runs as a SINGLE Node process (webhook mode), so
 * serializing the critical section BY KEY (the request id) inside the process
 * makes those sequences atomic against concurrent taps of the SAME row —
 * while leaving unrelated keys fully concurrent.
 *
 * This is deliberately NOT a distributed lock. It protects one process only.
 * If the bot is ever scaled to multiple instances, this must be replaced with
 * a sheet-level claim (conditional write) or an external lock (Redis, etc.).
 */

/** key -> Promise tail of the queued critical sections for that key. */
const _chains = new Map();

/**
 * Run `fn` exclusively for `key`. Calls sharing a key run one-at-a-time in
 * arrival order; different keys run concurrently. The key's queue entry is
 * released once it drains, so long-lived processes don't leak Map entries.
 *
 * The returned promise settles with `fn`'s result (or rejection). A thrown
 * `fn` never wedges the chain — the next waiter still runs.
 *
 * @template T
 * @param {string|number} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function runExclusive(key, fn) {
  const k = String(key);
  const prev = _chains.get(k) || Promise.resolve();
  // Chain onto the previous tail regardless of how it settled.
  const run = prev.then(() => fn());
  // The tail swallows errors so a failed critical section doesn't reject the
  // NEXT waiter's `prev.then(...)`.
  const tail = run.then(() => {}, () => {});
  _chains.set(k, tail);
  tail.then(() => {
    // Only clear if we're still the current tail (no newer waiter queued).
    if (_chains.get(k) === tail) _chains.delete(k);
  });
  return run;
}

module.exports = {
  runExclusive,
  /** @internal test hook: number of live keys. */
  _internals: { activeKeys: () => _chains.size },
};
