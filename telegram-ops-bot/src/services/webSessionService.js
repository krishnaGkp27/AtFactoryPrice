/**
 * ANA-1a — Telegram-as-identity web sessions (owner-locked 20-Jul-2026).
 *
 * The bot mints a SINGLE-USE, short-lived login token for the tapping
 * user; GET /auth?t=<token> redeems it into a role-scoped web session
 * (cookie). No passwords anywhere — Telegram is the identity provider.
 *
 * Scope carried on every session (the ANA-1 owner decisions):
 *   role 'admin'    → sees everything
 *   role 'manager'  → department-scoped (their departments' numbers only)
 *   warehouses[]    → region scoping (e.g. the Kano-region person sees
 *                     their own warehouses' numbers)
 *
 * PG-1b (22-Jul): SESSIONS are Postgres-backed when DATABASE_URL exists,
 * so dashboard logins survive redeploys; in-memory remains the fallback
 * (and the cache). Login TOKENS stay in-memory on purpose — 5-minute
 * single-use links don't need durability.
 */

'use strict';

const crypto = require('crypto');
const pool = require('../db/postgresPool');
const auditLogRepository = require('../repositories/auditLogRepository');
const logger = require('../utils/logger');

const TOKEN_TTL_MS = 5 * 60 * 1000;        // magic link: 5 minutes, single use
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // web session: 12 hours

const _tokens = new Map();   // token → { identity, expiresAt }
const _sessions = new Map(); // sessionId → { identity, expiresAt }

function _sweep(map, now) {
  for (const [k, v] of map) if (v.expiresAt <= now) map.delete(k);
}

/**
 * Mint a single-use login token for a Telegram user.
 * @param {{userId:string, name:string, role:'admin'|'manager', departments:string[], warehouses:string[]}} identity
 * @returns {string} the token to embed in the /auth link
 */
function mintLoginToken(identity) {
  const now = Date.now();
  _sweep(_tokens, now);
  const token = crypto.randomBytes(24).toString('base64url');
  _tokens.set(token, {
    identity: {
      userId: String(identity.userId),
      name: identity.name || String(identity.userId),
      role: identity.role === 'admin' ? 'admin' : 'manager',
      departments: Array.isArray(identity.departments) ? identity.departments : [],
      warehouses: Array.isArray(identity.warehouses) ? identity.warehouses : [],
    },
    expiresAt: now + TOKEN_TTL_MS,
  });
  auditLogRepository.append('web_login_minted', { userId: identity.userId, role: identity.role }, identity.userId)
    .catch(() => {});
  return token;
}

/**
 * Redeem a login token (single use) into a session.
 * @returns {Promise<{sessionId:string, identity:object}|null>} null when invalid/expired/used
 */
async function redeemLoginToken(token) {
  const now = Date.now();
  _sweep(_tokens, now);
  const entry = _tokens.get(String(token || ''));
  if (!entry) return null;
  _tokens.delete(String(token)); // single use — burn before anything else
  const sessionId = crypto.randomBytes(24).toString('base64url');
  _sessions.set(sessionId, { identity: entry.identity, expiresAt: now + SESSION_TTL_MS });
  if (pool.isEnabled()) {
    try {
      await pool.query(
        'INSERT INTO web_sessions (token, identity, expires_at) VALUES ($1, $2, $3)',
        [sessionId, JSON.stringify(entry.identity), new Date(now + SESSION_TTL_MS).toISOString()]);
    } catch (e) { logger.warn(`webSession pg store: ${e.message}`); }
  }
  auditLogRepository.append('web_login_redeemed', { userId: entry.identity.userId, role: entry.identity.role }, entry.identity.userId)
    .catch(() => {});
  logger.info(`webSession: ${entry.identity.role} ${entry.identity.userId} logged in via magic link`);
  return { sessionId, identity: entry.identity };
}

/** Resolve a session id to its identity, or null. Memory first, then PG. */
async function getSession(sessionId) {
  const now = Date.now();
  _sweep(_sessions, now);
  const s = _sessions.get(String(sessionId || ''));
  if (s) return s.identity;
  if (pool.isEnabled()) {
    try {
      const r = await pool.query(
        'SELECT identity FROM web_sessions WHERE token = $1 AND expires_at > now()', [String(sessionId || '')]);
      if (r.rows.length) {
        const identity = r.rows[0].identity;
        _sessions.set(String(sessionId), { identity, expiresAt: now + SESSION_TTL_MS });
        return identity;
      }
    } catch (e) { logger.warn(`webSession pg read: ${e.message}`); }
  }
  return null;
}

/** Read the session identity off an Express request's cookie, or null. */
async function identityFromRequest(req) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 'afp_session') return getSession(rest.join('='));
  }
  return null;
}

/** Destroy one session (logout). */
async function destroySession(sessionId) {
  _sessions.delete(String(sessionId || ''));
  if (pool.isEnabled()) {
    try { await pool.query('DELETE FROM web_sessions WHERE token = $1', [String(sessionId || '')]); }
    catch (e) { logger.warn(`webSession pg delete: ${e.message}`); }
  }
}

/** Test hook. */
function _resetForTests() { _tokens.clear(); _sessions.clear(); }

module.exports = {
  mintLoginToken, redeemLoginToken, getSession, identityFromRequest, destroySession,
  TOKEN_TTL_MS, SESSION_TTL_MS, _resetForTests,
};
