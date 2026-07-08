'use strict';

/**
 * P3 — tiny in-memory sliding-window rate limiter (per key, single process).
 *
 * Used to cap spend/abuse ahead of expensive upstreams (OpenAI parses).
 * Same single-process caveat as asyncMutex: the bot runs as one Railway
 * instance; if it is ever scaled out, move this to a shared store.
 */

/** Keys with no hits inside the window are swept once the map grows past this. */
const SWEEP_THRESHOLD = 1000;

/**
 * Create an isolated limiter.
 * @param {object} p Params.
 * @param {number} p.windowMs Rolling window length in milliseconds.
 * @param {number} p.max Max allowed hits per key inside the window.
 * @returns {{allow: (key: string) => boolean}} Limiter instance.
 */
function createLimiter({ windowMs, max }) {
  if (!(windowMs > 0) || !(max > 0)) throw new Error('rateLimiter: windowMs and max must be > 0');
  /** @type {Map<string, number[]>} key → hit timestamps (ms) inside window */
  const hits = new Map();

  function sweep(now) {
    if (hits.size <= SWEEP_THRESHOLD) return;
    for (const [key, arr] of hits) {
      const live = arr.filter((t) => now - t < windowMs);
      if (live.length) hits.set(key, live); else hits.delete(key);
    }
  }

  /**
   * Record an attempt for `key`. True = allowed (and counted); false = over
   * the cap, not counted (retry after the oldest hit ages out).
   * @param {string} key Bucket key (e.g. Telegram user id).
   * @returns {boolean} Whether the attempt is within the limit.
   */
  function allow(key) {
    const now = Date.now();
    const k = String(key);
    const live = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (live.length >= max) {
      hits.set(k, live);
      return false;
    }
    live.push(now);
    hits.set(k, live);
    sweep(now);
    return true;
  }

  return { allow };
}

module.exports = { createLimiter };
