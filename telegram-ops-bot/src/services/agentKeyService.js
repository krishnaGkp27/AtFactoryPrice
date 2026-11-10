'use strict';

/**
 * AGT-1 — the read-only key of the agent data door.
 *
 * An admin mints the key from Telegram (📊 Reporting → 🤖 Agent Data Access):
 * no Railway variable, no laptop. The key is shown ONCE; Postgres keeps only
 * its SHA-256 (`agent_keys`). One key is live at a time — minting a new one
 * revokes the old. An optional fixed key in the Railway variable
 * AGENT_DATA_KEY opens the same door.
 *
 * The key grants READS of the reports in insightsService and nothing else:
 * there is no write route behind it.
 */

const crypto = require('crypto');
const config = require('../config');
const pool = require('../db/postgresPool');

const PREFIX = 'agk_';
const TOUCH_MS = 60 * 1000;
let lastTouch = 0;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Mint a key; revokes any live one. @returns {Promise<{key:string}|null>} null without Postgres. */
async function create({ byUserId, byName } = {}) {
  if (!pool.isEnabled()) return null;
  const key = PREFIX + crypto.randomBytes(32).toString('base64url');
  await pool.query('UPDATE agent_keys SET revoked_at = now(), revoked_by = $1 WHERE revoked_at IS NULL', [String(byUserId || '')]);
  await pool.query('INSERT INTO agent_keys (key_hash, created_by, created_name) VALUES ($1, $2, $3)',
    [sha(key), String(byUserId || ''), String(byName || '')]);
  return { key };
}

/** Revoke the live key. @returns {Promise<number>} rows revoked */
async function revoke({ byUserId } = {}) {
  if (!pool.isEnabled()) return 0;
  const res = await pool.query('UPDATE agent_keys SET revoked_at = now(), revoked_by = $1 WHERE revoked_at IS NULL', [String(byUserId || '')]);
  return (res && res.rowCount) || 0;
}

/** The live key's record (never the key). */
async function status() {
  if (!pool.isEnabled()) return { enabled: false, live: null, envKey: Boolean(config.agentDataKey) };
  const res = await pool.query(
    `SELECT created_by, created_name, created_at, last_used_at, uses
       FROM agent_keys WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`);
  return { enabled: true, live: (res && res.rows && res.rows[0]) || null, envKey: Boolean(config.agentDataKey) };
}

/**
 * Is this the live key? Fail-CLOSED: a read error is a refusal.
 * @param {string} presented
 * @returns {Promise<boolean>}
 */
async function verify(presented) {
  const key = String(presented || '').trim();
  if (key.length < 20) return false;
  if (config.agentDataKey && safeEqual(key, config.agentDataKey)) return true;
  if (!pool.isEnabled() || !key.startsWith(PREFIX)) return false;
  try {
    const res = await pool.query('SELECT id FROM agent_keys WHERE key_hash = $1 AND revoked_at IS NULL LIMIT 1', [sha(key)]);
    const row = res && res.rows && res.rows[0];
    if (!row) return false;
    if (Date.now() - lastTouch > TOUCH_MS) {
      lastTouch = Date.now();
      pool.query('UPDATE agent_keys SET last_used_at = now(), uses = uses + 1 WHERE id = $1', [row.id]).catch(() => {});
    }
    return true;
  } catch (_) { return false; }
}

module.exports = { create, revoke, status, verify, PREFIX };
