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

/**
 * STK-PG — run `fn(client)` inside BEGIN…COMMIT on ONE pooled client,
 * rolling back on any throw. The 07-Aug audit named the absence of this
 * helper as prerequisite #1 for any transactional ledger work: pool.query
 * gives implicit single-statement transactions only, so a multi-row
 * atomic write was previously impossible to express.
 *
 * Returns null when Postgres is disabled (the layer's usual contract).
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T|null>}
 */
async function withTransaction(fn) {
  // Via the export so tests can stub the pool at the module seam.
  const pool = module.exports.getPool();
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection died */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Close the pool (tests / graceful shutdown). */
async function close() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = { isEnabled, getPool, query, withTransaction, close };
