#!/usr/bin/env node
'use strict';

/**
 * SUP-2 — retire customer ledger sessions minted BEFORE the phone-ambiguity
 * gate existed.
 *
 * Why this is needed even though the hole is closed: the gate refuses at
 * MINT time, but an ext_sessions row is a 30-day bearer token and
 * sessionCustomer() re-reads only the stored customer_name — it never
 * re-resolves the phone. So a session created by the old first-match-wins
 * lookup (an attacker whose number shared its last ten digits with a
 * customer's) keeps opening that customer's record for up to 30 days after
 * the fix ships. Deleting the rows is the only thing that closes that
 * window; the customer simply signs in again.
 *
 * Usage (on Railway, where DATABASE_URL is set):
 *   node scripts/purge-ext-sessions.js              # dry run — counts only
 *   node scripts/purge-ext-sessions.js --commit     # delete them
 *   node scripts/purge-ext-sessions.js --commit --before 2026-08-24T00:00:00Z
 *
 * With no --before, EVERY session is purged: the safe default while the
 * feature is new and the sessions are few. Everyone signs in again once.
 */

const pool = require('../src/db/postgresPool');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] || '');
}

async function main() {
  const commit = process.argv.includes('--commit');
  const before = arg('--before');

  if (!pool.isEnabled()) {
    console.error('DATABASE_URL is not set — sessions live in memory and are already gone on restart.');
    process.exit(1);
  }
  if (before && Number.isNaN(Date.parse(before))) {
    console.error(`--before must be an ISO timestamp, got: ${before}`);
    process.exit(1);
  }

  const where = before ? 'WHERE created_at < $1' : '';
  const params = before ? [before] : [];

  let total = 0;
  try {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ext_sessions ${where}`, params);
    total = (r.rows[0] && r.rows[0].n) || 0;
  } catch (e) {
    // created_at may not exist on older deployments; fall back to a full count.
    if (before) {
      console.error(`Could not filter by created_at (${e.message}) — re-run without --before to purge all.`);
      process.exit(1);
    }
    throw e;
  }

  console.log(`ext_sessions matching${before ? ` (created before ${before})` : ' (all)'}: ${total}`);
  if (!total) { console.log('Nothing to purge.'); return; }
  if (!commit) {
    console.log('DRY RUN — re-run with --commit to delete. Each affected customer signs in again.');
    return;
  }
  const del = await pool.query(`DELETE FROM ext_sessions ${where}`, params);
  console.log(`Purged ${del.rowCount} session(s). Customers will be asked to sign in again.`);
}

main()
  .catch((e) => { console.error(`purge-ext-sessions failed: ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.close().catch(() => {}));
