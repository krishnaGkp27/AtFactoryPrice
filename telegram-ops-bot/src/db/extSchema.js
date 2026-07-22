'use strict';

/**
 * PG-1b/EXT-1 — durable state for the web dashboard + the customer-facing
 * ledger channels (owner 22-Jul: WhatsApp / SMS / app with OTP login).
 *
 * web_sessions   dashboard logins (survive redeploys — the in-memory v1
 *                logged everyone out on every deploy)
 * ext_otp        one-time codes, HASHED (sha256) — never stored plain
 * ext_sessions   customer ledger sessions minted by a verified OTP
 * channel_usage  per-day per-channel counters — the "no money leakage"
 *                metric the owner reads on the WEBSITE (/api/ops/usage)
 *
 * All best-effort: without DATABASE_URL every consumer falls back to
 * in-memory maps and the bot behaves exactly as before.
 */

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS web_sessions (
    token TEXT PRIMARY KEY,
    identity JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS ws_exp ON web_sessions (expires_at)',
  `CREATE TABLE IF NOT EXISTS ext_otp (
    id BIGSERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    attempts INT NOT NULL DEFAULT 0,
    used BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS eo_phone ON ext_otp (phone, created_at)',
  `CREATE TABLE IF NOT EXISTS ext_sessions (
    token TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    channel TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS es_exp ON ext_sessions (expires_at)',
  `CREATE TABLE IF NOT EXISTS channel_usage (
    day DATE NOT NULL,
    channel TEXT NOT NULL,
    kind TEXT NOT NULL,
    count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (day, channel, kind)
  )`,
];

const pool = require('./postgresPool');
const logger = require('../utils/logger');

/** Idempotent bootstrap; silently no-ops without DATABASE_URL. */
async function ensure() {
  if (!pool.isEnabled()) return false;
  try {
    for (const ddl of DDL_STATEMENTS) await pool.query(ddl);
    logger.info('extSchema: web_sessions / ext_otp / ext_sessions / channel_usage ready');
    return true;
  } catch (e) {
    logger.error(`extSchema ensure failed: ${e.message}`);
    return false;
  }
}

module.exports = { DDL_STATEMENTS, ensure };
