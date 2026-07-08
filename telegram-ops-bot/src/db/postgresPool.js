'use strict';

/**
 * PG-1 — lazy PostgreSQL connection pool.
 *
 * When DATABASE_URL is unset the bot behaves exactly as before (Sheets-only).
 * Mirror/sync code calls isEnabled() first and no-ops gracefully.
 */

const { Pool } = require('pg');
const config = require('../config');
const logger = require('../utils/logger');

let _pool = null;

function isEnabled() {
  return Boolean(config.postgres.url);
}

function getPool() {
  if (!isEnabled()) return null;
  if (!_pool) {
    _pool = new Pool({
      connectionString: config.postgres.url,
      ssl: config.postgres.ssl ? { rejectUnauthorized: false } : false,
      max: config.postgres.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    _pool.on('error', (err) => {
      logger.error(`postgres pool error: ${err.message}`);
    });
  }
  return _pool;
}

/**
 * Run a parameterized query. Returns null when Postgres is disabled.
 * @param {string} text SQL.
 * @param {Array} [params] Bind params.
 * @returns {Promise<import('pg').QueryResult|null>}
 */
async function query(text, params = []) {
  const pool = getPool();
  if (!pool) return null;
  return pool.query(text, params);
}

/** Close the pool (tests / graceful shutdown). */
async function close() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = { isEnabled, getPool, query, close };
