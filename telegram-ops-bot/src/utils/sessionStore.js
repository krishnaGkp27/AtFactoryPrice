/**
 * In-memory conversation session store for guided multi-step flows.
 * Keyed by Telegram user ID. Sessions auto-expire after TTL.
 */

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const sessions = new Map();

function get(userId) {
  const s = sessions.get(String(userId));
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(String(userId)); return null; }
  return s;
}

function set(userId, data) {
  sessions.set(String(userId), { ...data, expiresAt: Date.now() + TTL_MS });
}

function clear(userId) {
  sessions.delete(String(userId));
}

function touch(userId) {
  const s = get(userId);
  if (s) s.expiresAt = Date.now() + TTL_MS;
}

module.exports = { get, set, clear, touch };
