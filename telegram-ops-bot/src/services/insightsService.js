'use strict';

/**
 * AGT-1 — the reports behind the agent data door.
 *
 * Owner, 10-Nov-2026: "make an arrangement in such a way that you can read
 * the Railway logs as well as the database … such that these data can be
 * utilised to make bot changes and make it adaptive to the usage of the
 * users going ahead."
 *
 * Every report is a READ over the Railway Postgres. There is no free SQL:
 * a report is a named, parameterised SELECT with a row cap, and the one
 * generic reader (`table`) takes its table name from an allow-list. Nothing
 * here writes, and nothing here reads a Google Sheet.
 *
 *   summary   what is in the database: tables, row counts, date spans
 *   usage     which features are used — per feature, optionally one person
 *   people    who uses the bot, and each person's top features (the input
 *             a usage-ranked menu needs)
 *   flows     per guided flow: started / completed / abandoned / interrupted
 *   events    the raw usage events, newest first, filterable
 *   typed     the typed-line census (TXT-C1): what people type, what it became
 *   logs      the bot's console lines (the Railway log), filterable
 *   errors    the failing log lines grouped by message, most frequent first
 *   table     the newest rows of one allow-listed event table
 */

const pool = require('../db/postgresPool');

const MAX_ROWS = 500;
const TABLES = {
  usage_events: 'ts', usage_daily: 'day', app_logs: 'ts',
  payment_events: 'at', payment_reasons: null, payment_reason_codes: null,
  transfers: null, transfer_events: 'at', stock_events: null,
  share_events: null, channel_usage: null, schema_migrations: 'applied_at',
};

const clampInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : def));
};
const text = (v, max = 80) => String(v == null ? '' : v).slice(0, max);

async function rows(sql, params = []) {
  const res = await pool.query(sql, params);
  return (res && res.rows) || [];
}

const SINCE = "ts >= now() - ($1::int * interval '1 day')";

async function summary() {
  const tables = await rows(
    `SELECT c.relname AS table, c.reltuples::bigint AS approx_rows,
            pg_size_pretty(pg_total_relation_size(c.oid)) AS size
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC`);
  const span = async (table, col) => {
    try {
      const r = await rows(`SELECT COUNT(*)::int AS n, MIN(${col}) AS first, MAX(${col}) AS last FROM ${table}`);
      return r[0] || null;
    } catch (_) { return null; }
  };
  return {
    tables,
    usage_events: await span('usage_events', 'ts'),
    app_logs: await span('app_logs', 'ts'),
    migrations: await rows('SELECT id, applied_at FROM schema_migrations ORDER BY applied_at').catch(() => []),
    reports: Object.keys(REPORTS),
    readable_tables: Object.keys(TABLES),
  };
}

async function usage(q = {}) {
  const days = clampInt(q.days, 30, 1, 730);
  const params = [days];
  let who = '';
  if (q.user) { params.push(text(q.user, 40)); who = ` AND user_id = $${params.length}`; }
  const features = await rows(
    `SELECT feature, surface, COUNT(*)::int AS events, COUNT(DISTINCT user_id)::int AS people,
            SUM(CASE WHEN event IN ('tile_tapped','hub_opened','flow_started') THEN 1 ELSE 0 END)::int AS opens,
            SUM(CASE WHEN event = 'flow_completed' THEN 1 ELSE 0 END)::int AS completed,
            SUM(CASE WHEN event = 'flow_abandoned' THEN 1 ELSE 0 END)::int AS abandoned,
            SUM(CASE WHEN event LIKE '%error%' THEN 1 ELSE 0 END)::int AS errors,
            MAX(ts) AS last_used
       FROM usage_events WHERE ${SINCE}${who}
      GROUP BY feature, surface ORDER BY events DESC LIMIT ${MAX_ROWS}`, params);
  const byDay = await rows(
    `SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD') AS day, COUNT(*)::int AS events,
            COUNT(DISTINCT user_id)::int AS people
       FROM usage_events WHERE ${SINCE}${who} GROUP BY 1 ORDER BY 1`, params);
  const byHour = await rows(
    `SELECT EXTRACT(hour FROM ts AT TIME ZONE 'Africa/Lagos')::int AS hour, COUNT(*)::int AS events
       FROM usage_events WHERE ${SINCE}${who} GROUP BY 1 ORDER BY 1`, params);
  return { days, user: q.user || null, features, byDay, byHour };
}

async function people(q = {}) {
  const days = clampInt(q.days, 30, 1, 730);
  const top = clampInt(q.top, 8, 1, 30);
  const totals = await rows(
    `SELECT user_id, MAX(role) AS role, COUNT(*)::int AS events, COUNT(DISTINCT feature)::int AS features,
            COUNT(DISTINCT date_trunc('day', ts))::int AS active_days, MAX(ts) AS last_seen
       FROM usage_events WHERE ${SINCE} GROUP BY user_id ORDER BY events DESC LIMIT 200`, [days]);
  const ranked = await rows(
    `SELECT user_id, feature, n FROM (
        SELECT user_id, feature, COUNT(*)::int AS n,
               ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY COUNT(*) DESC) AS rk
          FROM usage_events
         WHERE ${SINCE} AND surface = 'tap' AND event = 'tile_tapped'
         GROUP BY user_id, feature) t
      WHERE rk <= $2 ORDER BY user_id, n DESC`, [days, top]);
  const byUser = new Map();
  for (const r of ranked) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push({ feature: r.feature, taps: r.n });
  }
  return { days, people: totals.map((p) => ({ ...p, topTiles: byUser.get(p.user_id) || [] })) };
}

async function flows(q = {}) {
  const days = clampInt(q.days, 30, 1, 730);
  const list = await rows(
    `SELECT feature AS flow,
            SUM(CASE WHEN event = 'flow_started' THEN 1 ELSE 0 END)::int AS started,
            SUM(CASE WHEN event = 'flow_completed' THEN 1 ELSE 0 END)::int AS completed,
            SUM(CASE WHEN event = 'flow_abandoned' THEN 1 ELSE 0 END)::int AS abandoned,
            SUM(CASE WHEN event = 'flow_interrupted' THEN 1 ELSE 0 END)::int AS interrupted,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE event = 'flow_completed'))::int AS p50_ms_completed,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY steps) FILTER (WHERE event = 'flow_completed'))::int AS p50_steps_completed,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY steps) FILTER (WHERE event = 'flow_abandoned'))::int AS p50_steps_abandoned,
            COUNT(DISTINCT user_id)::int AS people
       FROM usage_events
      WHERE ${SINCE} AND surface = 'flow' AND event LIKE 'flow_%'
      GROUP BY feature ORDER BY started DESC LIMIT ${MAX_ROWS}`, [days]);
  return { days, flows: list };
}

async function events(q = {}) {
  const days = clampInt(q.days, 7, 1, 730);
  const limit = clampInt(q.limit, 200, 1, MAX_ROWS);
  const params = [days];
  const where = [SINCE];
  for (const col of ['feature', 'surface', 'event']) {
    if (q[col]) { params.push(text(q[col])); where.push(`${col} = $${params.length}`); }
  }
  if (q.user) { params.push(text(q.user, 40)); where.push(`user_id = $${params.length}`); }
  if (q.request) { params.push(text(q.request)); where.push(`request_id = $${params.length}`); }
  const list = await rows(
    `SELECT ts, user_id, role, surface, feature, event, session_type, request_id, duration_ms, steps, meta
       FROM usage_events WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`, params);
  return { days, count: list.length, events: list };
}

const TYPED_LEGACY = ['record_payment', 'revert_last_transaction', 'add_contact', 'add_customer'];

async function typed(q = {}) {
  const days = clampInt(q.days, 90, 1, 730);
  const nlp = `surface = 'nlp' AND ${SINCE}`;
  return {
    days,
    totals: await rows(
      `SELECT event, COUNT(*)::int AS n, COUNT(DISTINCT user_id)::int AS people
         FROM usage_events WHERE ${nlp} GROUP BY event ORDER BY n DESC`, [days]),
    became: await rows(
      `SELECT feature, COUNT(*)::int AS n, COUNT(DISTINCT user_id)::int AS people,
              SUM(CASE WHEN (meta->>'local') = 'true' THEN 1 ELSE 0 END)::int AS local
         FROM usage_events WHERE ${nlp} AND event = 'nlp_intent'
        GROUP BY feature ORDER BY n DESC LIMIT ${MAX_ROWS}`, [days]),
    legacy: await rows(
      `SELECT feature, to_char(date_trunc('month', ts), 'YYYY-MM') AS month, COUNT(*)::int AS n,
              COUNT(DISTINCT user_id)::int AS people
         FROM usage_events WHERE ${nlp} AND event = 'nlp_intent' AND feature = ANY($2)
        GROUP BY feature, month ORDER BY feature, month`, [days, TYPED_LEGACY]),
    bounced: await rows(
      `SELECT event, feature, lower(meta->>'head') AS head, COUNT(*)::int AS n, COUNT(DISTINCT user_id)::int AS people
         FROM usage_events WHERE ${nlp} AND event IN ('nlp_off', 'nlp_hint')
          AND COALESCE(meta->>'head', '') <> ''
        GROUP BY event, feature, head ORDER BY n DESC LIMIT 100`, [days]),
    people: await rows(
      `SELECT user_id, COUNT(*)::int AS n,
              SUM(CASE WHEN event IN ('nlp_off', 'nlp_hint') THEN 1 ELSE 0 END)::int AS bounced
         FROM usage_events WHERE ${nlp} GROUP BY user_id ORDER BY n DESC LIMIT 25`, [days]),
  };
}

async function logs(q = {}) {
  const hours = clampInt(q.hours, 24, 1, 24 * 60);
  const limit = clampInt(q.limit, 200, 1, MAX_ROWS);
  const params = [hours];
  const where = ["ts >= now() - ($1::int * interval '1 hour')"];
  if (q.level) {
    const lv = String(q.level).toUpperCase().split(',').map((s) => s.trim()).filter((s) => /^[A-Z]{4,5}$/.test(s));
    if (lv.length) { params.push(lv); where.push(`level = ANY($${params.length})`); }
  }
  if (q.q) { params.push(`%${text(q.q, 120).replace(/[%_\\]/g, (c) => `\\${c}`)}%`); where.push(`msg ILIKE $${params.length}`); }
  if (q.before) { params.push(text(q.before, 40)); where.push(`ts < $${params.length}::timestamptz`); }
  const list = await rows(
    `SELECT ts, level, msg FROM app_logs WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ${limit}`, params);
  return { hours, count: list.length, logs: list };
}

async function errors(q = {}) {
  const hours = clampInt(q.hours, 72, 1, 24 * 60);
  const list = await rows(
    `SELECT level,
            left(regexp_replace(regexp_replace(msg, '[0-9]{3,}', '#', 'g'), 'R-[0-9A-Fa-f]{4}', 'R-#', 'g'), 160) AS shape,
            COUNT(*)::int AS n, MIN(ts) AS first, MAX(ts) AS last,
            (array_agg(msg ORDER BY ts DESC))[1] AS latest
       FROM app_logs
      WHERE ts >= now() - ($1::int * interval '1 hour') AND level IN ('WARN', 'ERROR')
      GROUP BY level, shape ORDER BY n DESC LIMIT 100`, [hours]);
  return { hours, groups: list };
}

async function table(q = {}) {
  const name = String(q.name || '');
  if (!Object.prototype.hasOwnProperty.call(TABLES, name)) {
    const err = new Error(`Unknown table. Readable: ${Object.keys(TABLES).join(', ')}`);
    err.status = 400;
    throw err;
  }
  const limit = clampInt(q.limit, 100, 1, MAX_ROWS);
  const order = TABLES[name] ? ` ORDER BY ${TABLES[name]} DESC` : '';
  const list = await rows(`SELECT * FROM ${name}${order} LIMIT ${limit}`);
  return { table: name, count: list.length, rows: list };
}

const REPORTS = { summary, usage, people, flows, events, typed, logs, errors, table };

/**
 * Run one report.
 * @param {string} name
 * @param {object} [query]
 * @returns {Promise<object>}
 */
async function run(name, query = {}) {
  const fn = Object.prototype.hasOwnProperty.call(REPORTS, name) ? REPORTS[name] : null;
  if (!fn) {
    const err = new Error(`Unknown report. Available: ${Object.keys(REPORTS).join(', ')}`);
    err.status = 404;
    throw err;
  }
  if (!pool.isEnabled()) {
    const err = new Error('Postgres is not configured on this deployment (DATABASE_URL).');
    err.status = 503;
    throw err;
  }
  return fn(query);
}

/**
 * The whole picture in one object — what the Telegram "send me the file"
 * button attaches, for the days when no key is set up.
 */
async function digest({ days = 30 } = {}) {
  const part = async (name, q) => {
    try { return await run(name, q); } catch (e) { return { error: e.message }; }
  };
  return {
    generated_at: new Date().toISOString(),
    days,
    summary: await part('summary'),
    usage: await part('usage', { days }),
    people: await part('people', { days }),
    flows: await part('flows', { days }),
    typed: await part('typed', { days: Math.max(days, 90) }),
    errors: await part('errors', { hours: Math.min(days * 24, 24 * 14) }),
  };
}

module.exports = { run, digest, REPORT_NAMES: Object.keys(REPORTS), TABLES, _internals: { clampInt } };
