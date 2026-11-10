#!/usr/bin/env node
'use strict';
/**
 * AGT-1 — read the bot's production usage records and log lines.
 *
 * For the coding agent (and anyone holding the agent key): calls the
 * read-only data door on the live bot, GET /api/insights/<report>.
 *
 *   node scripts/insights.js                      # the list of reports
 *   node scripts/insights.js summary              # what is in the database
 *   node scripts/insights.js usage --days 30
 *   node scripts/insights.js usage --days 30 --user 123456
 *   node scripts/insights.js people --days 30     # each person's top tiles
 *   node scripts/insights.js flows --days 30
 *   node scripts/insights.js typed --days 90      # the typed-line census
 *   node scripts/insights.js logs --hours 6 --level WARN,ERROR --q quota
 *   node scripts/insights.js errors --hours 72    # failing lines, grouped
 *   node scripts/insights.js events --feature payment_flow --limit 50
 *   node scripts/insights.js table --name payment_events --limit 50
 *
 * Any `--name value` pair is passed through as a query parameter.
 *
 * Where it reads:   INSIGHTS_URL  (default https://ops.atfactoryprice.live)
 * The key:          INSIGHTS_KEY  — sent as the X-Agent-Key header. In a
 *                   Claude cloud session the environment's network proxy
 *                   holds the real key and replaces the header, so the
 *                   variable may be left unset (a placeholder is sent).
 * The key is minted in Telegram: 📊 Reporting → 🤖 Agent Data Access.
 * READ-ONLY: the door has no write route.
 */

const BASE = String(process.env.INSIGHTS_URL || 'https://ops.atfactoryprice.live').replace(/\/$/, '');
const KEY = process.env.INSIGHTS_KEY || 'agk_placeholder-replaced-by-the-session-proxy';

async function main() {
  const args = process.argv.slice(2);
  const report = args[0] && !args[0].startsWith('--') ? args.shift() : '';
  const params = new URLSearchParams();
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--')) continue;
    const name = args[i].slice(2);
    const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i += 1] : '1';
    params.set(name, value);
  }
  const qs = params.toString();
  const url = `${BASE}/api/insights${report ? `/${encodeURIComponent(report)}` : ''}${qs ? `?${qs}` : ''}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'X-Agent-Key': KEY, Accept: 'application/json' } });
  } catch (e) {
    console.error(`insights: could not reach ${BASE} — ${e.message}`);
    return 2;
  }
  const body = await res.text();
  if (res.status === 401) {
    console.error('insights: the key was refused (401).');
    console.error('Mint one in Telegram: 📊 Reporting → 🤖 Agent Data Access → 🔑 Create key,');
    console.error('then save it for this host in the session (secure form) or set INSIGHTS_KEY.');
    return 1;
  }
  if (!res.ok) {
    console.error(`insights: ${res.status} — ${body.slice(0, 400)}`);
    return 1;
  }
  try { console.log(JSON.stringify(JSON.parse(body), null, 1)); } catch (_) { console.log(body); }
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e.message); process.exit(1); });
