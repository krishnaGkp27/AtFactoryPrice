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

// SJ-1 — snapshots of sessions that died by TIMEOUT (not deliberate
// clear()), so the janitor can tombstone their hanging chat messages.
// Bounded so an unattended janitor can never leak memory.
const EXPIRED_QUEUE_MAX = 500;
const expiredQueue = [];

function _stashExpired(userId, s) {
  if (!s || !s.type) return;
  expiredQueue.push({
    userId: String(userId),
    type: s.type,
    step: s.step || null,
    flowMessageId: s.flowMessageId || null,
    previewMessageId: s.previewMessageId || null,
    comboMessageId: s.comboMessageId || null,
    lastActiveAt: s._setAt || (s.expiresAt - _ttlFor(s)),
  });
  if (expiredQueue.length > EXPIRED_QUEUE_MAX) expiredQueue.shift();
}

function get(userId) {
  const key = String(userId);
  const s = sessions.get(key);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    _stashHint(key, s);
    _stashExpired(key, s);
    sessions.delete(key);
    return null;
  }
  return s;
}

function set(userId, data) {
  const ttl = _ttlFor(data);
  sessions.set(String(userId), { ...data, _setAt: Date.now(), expiresAt: Date.now() + ttl });
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

/**
 * SJ-1 — proactively expire timed-out sessions (get() only does it lazily
 * on the next read, which never comes for abandoned flows). Expired
 * sessions are snapshotted for the janitor.
 * @returns {number} how many sessions were expired by this sweep
 */
function sweepExpired() {
  const now = Date.now();
  let swept = 0;
  for (const [key, s] of sessions) {
    if (now > s.expiresAt) {
      _stashHint(key, s);
      _stashExpired(key, s);
      sessions.delete(key);
      swept += 1;
    }
  }
  return swept;
}

/**
 * SJ-1 — hand the accumulated timeout snapshots to the janitor (drains
 * the queue; the caller owns them afterwards).
 * @returns {Array<{userId:string,type:string,step:string|null,flowMessageId:number|null,previewMessageId:number|null,comboMessageId:number|null,lastActiveAt:number}>}
 */
function drainExpiredForCleanup() {
  return expiredQueue.splice(0, expiredQueue.length);
}

module.exports = {
  get, set, clear, touch,
  getLastSessionHint, clearLastSessionHint,
  sweepExpired, drainExpiredForCleanup,
  DEFAULT_TTL_MS,
};
