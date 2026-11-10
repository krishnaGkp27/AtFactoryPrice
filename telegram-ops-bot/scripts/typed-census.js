#!/usr/bin/env node
'use strict';
/**
 * TXT-C1 — typed-line census: what people TYPE at the bot, and what it did.
 *
 * Owner, 10-Nov-2026: "Since you are already maintaining the statistics of
 * activities on the SQL DB in Railway … I will go through the census of
 * that … to give me a proper recommendation of those which you are thinking
 * of retiring."
 *
 * Every typed message has been counted in Postgres `usage_events` (surface
 * `nlp`) since ANL-1:
 *   nlp_intent  the line was read (feature = the action it became; since
 *               TXT-3 `meta.local` marks a script line read without the AI)
 *   nlp_off     the chips card — a line the script does not know
 *               (meta.head = its first 40 characters)
 *   nlp_hint    a known verb with a bad body (feature = the verb)
 *   nlp_tile    a one-word door (feature = the tile it offered)
 *   nlp_help    Help
 *
 * This prints, for the last N days:
 *   1. the totals per outcome;
 *   2. what the typed lines BECAME (per action);
 *   3. the three write actions whose only door was the AI — record_payment,
 *      revert_last_transaction, add_contact — with their monthly counts, the
 *      evidence for "build a tap door" vs "retire";
 *   4. the lines that BOUNCED (chips card / hint), most frequent first —
 *      the candidates for a new script line;
 *   5. who types the most.
 *
 * READ-ONLY. Needs DATABASE_URL (the Railway Postgres):
 *   railway run node scripts/typed-census.js            # last 90 days
 *   railway run node scripts/typed-census.js --days 30
 *   railway run node scripts/typed-census.js --json
 * Without DATABASE_URL it explains itself and exits 0.
 */
const path = require('path');

const args = process.argv.slice(2);
const di = args.indexOf('--days');
const DAYS = Math.max(1, parseInt(di >= 0 ? args[di + 1] : '90', 10) || 90);
const JSON_OUT = args.includes('--json');
const LEGACY = ['record_payment', 'revert_last_transaction', 'add_contact', 'add_customer'];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('typed-census: DATABASE_URL is not set — nothing was read.');
    console.log('Run it where the Railway Postgres is reachable, e.g.:');
    console.log('  railway run node scripts/typed-census.js --days 90');
    return 0;
  }
  const pool = require(path.join(__dirname, '..', 'src', 'db', 'postgresPool'));
  const q = async (sql, params) => (await pool.query(sql, params)).rows || [];
  const since = `ts >= now() - ($1::int * interval '1 day')`;

  const totals = await q(
    `SELECT event, COUNT(*)::int AS n, COUNT(DISTINCT user_id)::int AS people
       FROM usage_events WHERE surface = 'nlp' AND ${since}
      GROUP BY event ORDER BY n DESC`, [DAYS]);
  const became = await q(
    `SELECT feature, COUNT(*)::int AS n, COUNT(DISTINCT user_id)::int AS people,
            SUM(CASE WHEN (meta->>'local') = 'true' THEN 1 ELSE 0 END)::int AS local
       FROM usage_events WHERE surface = 'nlp' AND event = 'nlp_intent' AND ${since}
      GROUP BY feature ORDER BY n DESC`, [DAYS]);
  const legacy = await q(
    `SELECT feature, to_char(date_trunc('month', ts), 'YYYY-MM') AS month, COUNT(*)::int AS n,
            COUNT(DISTINCT user_id)::int AS people
       FROM usage_events WHERE surface = 'nlp' AND event = 'nlp_intent' AND feature = ANY($2) AND ${since}
      GROUP BY feature, month ORDER BY feature, month`, [DAYS, LEGACY]);
  const bounced = await q(
    `SELECT event, feature, lower(meta->>'head') AS head, COUNT(*)::int AS n, COUNT(DISTINCT user_id)::int AS people
       FROM usage_events WHERE surface = 'nlp' AND event IN ('nlp_off', 'nlp_hint') AND ${since}
        AND COALESCE(meta->>'head', '') <> ''
      GROUP BY event, feature, head ORDER BY n DESC LIMIT 60`, [DAYS]);
  const people = await q(
    `SELECT user_id, COUNT(*)::int AS n,
            SUM(CASE WHEN event IN ('nlp_off', 'nlp_hint') THEN 1 ELSE 0 END)::int AS bounced
       FROM usage_events WHERE surface = 'nlp' AND ${since}
      GROUP BY user_id ORDER BY n DESC LIMIT 15`, [DAYS]);

  if (JSON_OUT) {
    console.log(JSON.stringify({ days: DAYS, totals, became, legacy, bounced, people }, null, 2));
    return 0;
  }
  const L = (s = '') => console.log(s);
  const pad = (s, n) => String(s).padEnd(n);
  L(`Typed-line census — last ${DAYS} days`);
  L('');
  L('1. Outcomes');
  for (const r of totals) L(`   ${pad(r.event, 12)} ${pad(r.n, 7)} lines · ${r.people} people`);
  if (!totals.length) L('   (no typed lines recorded in the window)');
  L('');
  L('2. What a typed line became (nlp_intent)');
  for (const r of became) L(`   ${pad(r.feature, 28)} ${pad(r.n, 6)} · ${r.people} people · ${r.local} read by the script, ${r.n - r.local} by the AI`);
  L('');
  L('3. The write actions whose only door was the AI');
  for (const a of LEGACY) {
    const rows = legacy.filter((r) => r.feature === a);
    L(`   ${a}: ${rows.length ? rows.map((r) => `${r.month} ${r.n} (${r.people}p)`).join(' · ') : 'never typed in the window'}`);
  }
  L('   → typed often and recently = build its tap door first; never typed = retire the typed handler.');
  L('');
  L('4. Lines that bounced (chips card / hint), most frequent first');
  for (const r of bounced) L(`   ${pad(r.n, 5)} ${pad(r.event === 'nlp_hint' ? `hint:${r.feature}` : 'chips', 14)} ${r.people}p  "${r.head}"`);
  if (!bounced.length) L('   (none recorded — heads are kept since TXT-3, 04-Nov-2026)');
  L('');
  L('5. Who types the most');
  for (const r of people) L(`   ${pad(r.user_id, 14)} ${pad(r.n, 6)} lines · ${r.bounced} bounced`);
  L('');
  L('Read-only. A line nobody typed produces NO row — silence here means unused, not broken.');
  return 0;
}

main().then((c) => process.exit(c || 0)).catch((e) => { console.error(`typed-census failed: ${e.message}`); process.exit(1); });
