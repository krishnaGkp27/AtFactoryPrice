'use strict';

/**
 * ttlCache — tiny single-value TTL cache.
 *
 * Replaces the hand-rolled `_cache/_cacheTs` pattern that had been copied
 * into repositories and services (inventory getAll, unit-display settings,
 * janitor config, …). One value, one loader, one TTL.
 *
 * The loader's rejection propagates to the caller on a cold cache — wrap
 * fallbacks inside the loader itself when a degraded value is preferred.
 */

/**
 * @template T
 * @param {number} ttlMs        how long a loaded value stays fresh
 * @param {() => Promise<T>|T} loader produces the value on a cold/expired cache
 * @returns {{ get: () => Promise<T>, invalidate: () => void }}
 */
function ttlCache(ttlMs, loader) {
  let value;
  let loadedAt = 0;
  let has = false;
  return {
    async get() {
      if (has && Date.now() - loadedAt < ttlMs) return value;
      value = await loader();
      loadedAt = Date.now();
      has = true;
      return value;
    },
    invalidate() {
      value = undefined;
      loadedAt = 0;
      has = false;
    },
  };
}

module.exports = { ttlCache };
