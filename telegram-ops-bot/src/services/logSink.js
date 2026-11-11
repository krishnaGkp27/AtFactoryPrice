'use strict';

/**
 * AGT-1 — the log sink: the bot's own console lines, kept in Postgres.
 *
 * Owner, 10-Nov-2026: "I want you to make an arrangement in such a way that
 * you can read the Railway logs as well as the database, if not directly,
 * then indirectly." The Railway log lives only on the Railway dashboard;
 * this keeps the same lines in `app_logs`, where the agent data door
 * (/api/insights/logs) can read them back. Storage rule 5b: logging belongs
 * in Postgres, never in a sheet.
 *
 * Fire-and-forget by contract (the usageTracker's shape): lines buffer in
 * memory, a timer flushes them in one multi-row insert, a failed flush
 * drops the batch. Nothing here may call `logger` — a sink that logged its
 * own failure would feed itself.
 *
 * Every line is REDACTED before it is stored: a bot token inside a Telegram
 * API URL, an OpenAI / Anthropic key, a database URL's password, a bearer
 * token, an `apiKey=` query value. A stored log is read by more people than
 * a console is.
 */

const config = require('../config');
const pool = require('../db/postgresPool');
const logger = require('../utils/logger');

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const MAX_MSG = 4000;

const buffer = [];
let timer = null;
let pruneTimer = null;
let removeSink = null;
let lastFailureAt = 0;

const REDACTIONS = [
  [/\bbot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>'],
  [/\b\d{8,}:[A-Za-z0-9_-]{30,}\b/g, '<redacted-token>'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-<redacted>'],
  [/\b(postgres(?:ql)?:\/\/[^:\s/]+):[^@\s]+@/gi, '$1:<redacted>@'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 <redacted>'],
  [/\b((?:api[_-]?key|x-api-key|x-agent-key|token|secret|password)["']?\s*[=:]\s*["']?)[^\s"'&,}]{6,}/gi, '$1<redacted>'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted-private-key>'],
];

/** Strip secrets from one log line. Pure. */
function redact(text) {
  let s = String(text == null ? '' : text);
  for (const [re, to] of REDACTIONS) s = s.replace(re, to);
  return s.length > MAX_MSG ? `${s.slice(0, MAX_MSG)}… (+${s.length - MAX_MSG} chars)` : s;
}

function wanted(level) {
  const min = LEVELS[config.logSink.level] || LEVELS.INFO;
  return (LEVELS[String(level || '').toUpperCase()] || 0) >= min;
}

/** The logger's sink: one line in, buffered. Never throws. */
function accept(line) {
  try {
    if (!line || !wanted(line.level)) return;
    buffer.push({ ts: line.ts || new Date().toISOString(), level: String(line.level).toUpperCase(), msg: redact(line.msg) });
    // drop-oldest: a burst must never grow the process
    while (buffer.length > config.logSink.bufferMax) buffer.shift();
  } catch (_) { /* never */ }
}

async function flush() {
  if (!buffer.length || !pool.isEnabled()) return 0;
  const batch = buffer.splice(0, 500);
  const params = [];
  const values = batch.map((l, i) => {
    params.push(l.ts, l.level, l.msg);
    return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`;
  });
  try {
    await pool.query(`INSERT INTO app_logs (ts, level, msg) VALUES ${values.join(', ')}`, params);
    return batch.length;
  } catch (e) {
    // console only, and at most once a minute — never through `logger`
    if (Date.now() - lastFailureAt > 60_000) {
      lastFailureAt = Date.now();
      console.error(`[logSink] flush failed (batch of ${batch.length} dropped): ${e.message}`);
    }
    return 0;
  }
}

async function prune() {
  if (!pool.isEnabled()) return;
  try {
    await pool.query("DELETE FROM app_logs WHERE ts < now() - ($1::int * interval '1 day')", [config.logSink.days]);
  } catch (e) {
    console.error(`[logSink] prune failed: ${e.message}`);
  }
}

/** Attach to the logger and start the timers. Idempotent; a no-op without Postgres. */
function start() {
  if (removeSink || !config.logSink.enabled || !pool.isEnabled()) return false;
  removeSink = logger.addSink(accept);
  timer = setInterval(() => { flush().catch(() => {}); }, config.logSink.flushMs);
  if (timer.unref) timer.unref();
  pruneTimer = setInterval(() => { prune().catch(() => {}); }, 6 * 3600 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();
  // …and once shortly after boot: the bot redeploys on every push to main,
  // so on a busy day the six-hour timer alone might never fire.
  const first = setTimeout(() => { prune().catch(() => {}); }, 90 * 1000);
  if (first.unref) first.unref();
  return true;
}

function stop() {
  if (removeSink) { removeSink(); removeSink = null; }
  if (timer) { clearInterval(timer); timer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
}

module.exports = { start, stop, flush, prune, redact, _internals: { buffer, accept, wanted } };
