'use strict';

/**
 * BKP-2 — `job_runs` (Postgres, migration 005): one row per run of a
 * scheduled job. Read to answer "did today's run already happen?" across
 * redeploys, and to show the last run on a status card.
 *
 * Without Postgres every function is a quiet no-op (null / false): the
 * caller then keeps the day in memory, as every scheduler did before.
 */

const pool = require('../db/postgresPool');

/**
 * Record one run.
 * @param {string} job  @param {string} day ISO day (the job's own calendar)
 * @param {'ok'|'manual'|'failed'} status  @param {object} [detail]
 */
async function record(job, day, status, detail = {}) {
  if (!pool.isEnabled()) return null;
  const res = await pool.query(
    'INSERT INTO job_runs (job, day, status, detail) VALUES ($1, $2, $3, $4::jsonb) RETURNING id',
    [String(job), String(day), String(status), JSON.stringify(detail || {})]);
  return res && res.rows && res.rows[0] ? res.rows[0].id : null;
}

/** Has this job a successful SCHEDULED run recorded for the day? */
async function hasOk(job, day) {
  if (!pool.isEnabled()) return false;
  const res = await pool.query(
    "SELECT 1 FROM job_runs WHERE job = $1 AND day = $2 AND status = 'ok' LIMIT 1",
    [String(job), String(day)]);
  return Boolean(res && res.rows && res.rows.length);
}

/** The newest run with one of the given statuses, or null. */
async function latest(job, statuses = ['ok', 'manual']) {
  if (!pool.isEnabled()) return null;
  const res = await pool.query(
    'SELECT day, status, detail, created_at FROM job_runs WHERE job = $1 AND status = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1',
    [String(job), statuses]);
  return (res && res.rows && res.rows[0]) || null;
}

module.exports = { record, hasOk, latest };
