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
  {
    // PAY-2 — the reason behind every payment request, the payment event
    // trail and the (empty until seeded) phase-3 reason-code index. SQL is
    // the spec text verbatim (specs/PAY-2_PAYMENT_REASON.md §3). The owner's
    // storage ruling: this trail lives in Postgres, never on a sheet.
    id: '002_payment_reasons',
    sql: `
      CREATE TABLE IF NOT EXISTS payment_reason_codes (
        id SERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true, created_by TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS payment_reasons (
        id BIGSERIAL PRIMARY KEY, payment_id TEXT NOT NULL,
        approval_request_id TEXT NOT NULL DEFAULT '',
        requester_id TEXT NOT NULL, requester_name TEXT NOT NULL DEFAULT '',
        payee_name TEXT NOT NULL DEFAULT '', payee_type TEXT NOT NULL DEFAULT '',
        amount_ngn NUMERIC(14,2) NOT NULL,
        reason_text TEXT NOT NULL, reason_key TEXT NOT NULL,
        reason_code_id INTEGER REFERENCES payment_reason_codes(id),
        raised_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS payment_reasons_requester_idx ON payment_reasons (requester_id, reason_key);
      CREATE INDEX IF NOT EXISTS payment_reasons_payment_idx   ON payment_reasons (payment_id);
      CREATE TABLE IF NOT EXISTS payment_events (
        id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(),
        payment_id TEXT NOT NULL, approval_request_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL CHECK (kind IN ('raised','signed','approved','finance_card_sent','reminder_sent','done','declined','rejected','notified')),
        actor_id TEXT NOT NULL DEFAULT '', actor_name TEXT NOT NULL DEFAULT '',
        chat_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
        detail JSONB NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS payment_events_payment_idx ON payment_events (payment_id, kind);
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
