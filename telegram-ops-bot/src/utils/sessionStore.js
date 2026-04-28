/**
 * In-memory conversation session store for guided multi-step flows.
 * Keyed by Telegram user ID. Sessions auto-expire after TTL.
 *
 * Per-flow TTL override: include `ttlMs` in the session data and that
 * value will be used instead of DEFAULT_TTL_MS. Subsequent set() calls
 * carry it forward as long as the session data is read-modify-written
 * (which is the standard pattern in our flows).
 *
 * lastSession: a short-lived snapshot of the most recent expired/cleared
 * session for each user, so the controller can detect orphan replies
 * (e.g. typed shade names that arrived after expiry) and show a helpful
 * "session expired — please restart" message instead of falling through
 * to the AI intent parser.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;          // 5 minutes
const ORPHAN_HINT_TTL_MS = 30 * 60 * 1000;     // 30 minutes — keep "what flow expired" hint around longer

const sessions = new Map();
const lastSessions = new Map(); // userId -> { type, step, expiredAt }

function _stashHint(userId, s) {
  if (!s) return;
  lastSessions.set(String(userId), {
    type: s.type,
    step: s.step,
    expiredAt: Date.now() + ORPHAN_HINT_TTL_MS,
  });
}

function _ttlFor(data) {
  return (data && typeof data.ttlMs === 'number' && data.ttlMs > 0) ? data.ttlMs : DEFAULT_TTL_MS;
}

function get(userId) {
  const key = String(userId);
  const s = sessions.get(key);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    _stashHint(key, s);
    sessions.delete(key);
    return null;
  }
  return s;
}

function set(userId, data) {
  const ttl = _ttlFor(data);
  sessions.set(String(userId), { ...data, expiresAt: Date.now() + ttl });
}

function clear(userId) {
  const key = String(userId);
  const s = sessions.get(key);
  if (s) _stashHint(key, s);
  sessions.delete(key);
}

function touch(userId) {
  const s = get(userId);
  if (s) s.expiresAt = Date.now() + _ttlFor(s);
}

/**
 * Return a hint about the most recently expired/cleared session for this
 * user (within the last 30 minutes). Used by message handlers to recognise
 * orphan flow replies and route them to a helpful message instead of the
 * AI fallback. Returns null if no recent expiry.
 */
function getLastSessionHint(userId) {
  const key = String(userId);
  const h = lastSessions.get(key);
  if (!h) return null;
  if (Date.now() > h.expiredAt) { lastSessions.delete(key); return null; }
  return h;
}

function clearLastSessionHint(userId) {
  lastSessions.delete(String(userId));
}

module.exports = {
  get, set, clear, touch,
  getLastSessionHint, clearLastSessionHint,
  DEFAULT_TTL_MS,
};
