/**
 * In-memory idempotency keys to prevent double execution.
 * For multi-instance deployment, replace with Redis or DB.
 */

const seen = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

function makeKey(userId, action, design, color, qty, warehouse) {
  const payload = [userId, action, design, color, String(qty), warehouse].filter(Boolean).join('|');
  return `idem:${payload}:${Date.now()}`;
}

function cleanExpired() {
  const now = Date.now();
  for (const [k, t] of seen.entries()) {
    if (now - t > TTL_MS) seen.delete(k);
  }
}

function claim(key) {
  cleanExpired();
  if (seen.has(key)) return false;
  seen.set(key, Date.now());
  return true;
}

function release(key) {
  seen.delete(key);
}

module.exports = { makeKey, claim, release };
