'use strict';

/**
 * STK-PG — minimal versioned migrations (audit §1d prerequisite #3).
 *
 * The existing PG domains ship idempotent boot-DDL (`CREATE TABLE IF NOT
 * EXISTS`), which is fine for ADDING tables but structurally cannot evolve
 * one — a new column or constraint on an existing table has nowhere to
 * live. This runner is the smallest thing that can: an ordered list of
 * named steps, each applied exactly once, recorded in `schema_migrations`.
 *
 * Rules:
 *   - migrations are APPEND-ONLY: never edit or reorder a shipped step,
 *     add a new one (the id is the contract);
 *   - each step runs in its own transaction (withTransaction), so a failed
 *     step leaves the database at the previous version, recorded honestly;
 *   - no-op without DATABASE_URL, like every PG consumer.
 */

const pool = require('./postgresPool');
const logger = require('../utils/logger');

/** @type {Array<{id: string, sql: string}>} append-only, never reordered. */
const MIGRATIONS = [
  {
    id: '001_stock_events',
    sql: `
      CREATE TABLE IF NOT EXISTS stock_events (
        id             BIGSERIAL PRIMARY KEY,
        at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        business_day   DATE,
        event          TEXT NOT NULL CHECK (event IN
          ('sale','return','correction','dispatch','receive','reject',
           'repair','intake','rename')),
        design         TEXT NOT NULL DEFAULT '',
        bale_no        TEXT NOT NULL DEFAULT '',
        container      TEXT NOT NULL DEFAULT '',
        shade          TEXT NOT NULL DEFAULT '',
        warehouse_from TEXT NOT NULL DEFAULT '',
        warehouse_to   TEXT NOT NULL DEFAULT '',
        thans          INTEGER NOT NULL DEFAULT 0 CHECK (thans >= 0),
        customer       TEXT NOT NULL DEFAULT '',
        authority      TEXT NOT NULL,
        approval_id    TEXT NOT NULL DEFAULT '',
        actor          TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS stock_events_day_idx
        ON stock_events (business_day);
      CREATE INDEX IF NOT EXISTS stock_events_bale_idx
        ON stock_events (design, bale_no, container);
      CREATE INDEX IF NOT EXISTS stock_events_event_idx
        ON stock_events (event);
    `,
  },
];

/**
 * Apply every unapplied migration, in order. Safe to run on every boot.
 * @returns {Promise<{applied: string[], skipped: number}|null>} null when PG is off.
 */
async function migrate() {
  if (!pool.isEnabled()) return null;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const done = new Set(
    ((await pool.query('SELECT id FROM schema_migrations')) || { rows: [] })
      .rows.map((r) => r.id),
  );
  const applied = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await pool.withTransaction(async (client) => {
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
    });
    applied.push(m.id);
    logger.info(`migrations: applied ${m.id}`);
  }
  return { applied, skipped: MIGRATIONS.length - applied.length };
}

module.exports = { migrate, _internals: { MIGRATIONS } };
