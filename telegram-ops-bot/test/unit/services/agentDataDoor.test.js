'use strict';

/**
 * AGT-1 — the agent data door, offline: the log sink (redaction, level
 * filter, one batched insert, a failed flush drops), the key service
 * (mint once, hash stored, replace revokes, fail-closed), the reports
 * service (allow-list, caps, no free SQL) and the HTTP gate (401 / 429).
 *
 * postgresPool.query is stubbed with a tiny in-memory `agent_keys`; no real
 * pool, no network.
 */

process.env.DATABASE_URL = 'postgres://user:pass@fake-host:5432/fake';
process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');

const postgresPool = require('../../../src/db/postgresPool');

let queries = [];
let keys = [];
let failNext = false;
let reportRows = [];
postgresPool.query = async (text, params = []) => {
  if (failNext) { failNext = false; throw new Error('pg down'); }
  queries.push({ text, params });
  if (/^UPDATE agent_keys SET revoked_at/.test(text)) {
    const live = keys.filter((k) => !k.revoked);
    live.forEach((k) => { k.revoked = true; });
    return { rows: [], rowCount: live.length };
  }
  if (/^INSERT INTO agent_keys/.test(text)) {
    keys.push({ id: keys.length + 1, hash: params[0], by: params[1], name: params[2], revoked: false });
    return { rows: [], rowCount: 1 };
  }
  if (/^SELECT id FROM agent_keys/.test(text)) {
    const k = keys.find((x) => x.hash === params[0] && !x.revoked);
    return { rows: k ? [{ id: k.id }] : [] };
  }
  if (/FROM agent_keys WHERE revoked_at IS NULL/.test(text)) {
    const k = keys.filter((x) => !x.revoked).pop();
    return { rows: k ? [{ created_by: k.by, created_name: k.name, created_at: '2026-11-10T09:00:00Z', last_used_at: null, uses: 0 }] : [] };
  }
  return { rows: reportRows, rowCount: reportRows.length };
};

const logger = require('../../../src/utils/logger');
const logSink = require('../../../src/services/logSink');
const agentKeyService = require('../../../src/services/agentKeyService');
const insightsService = require('../../../src/services/insightsService');
const insightsController = require('../../../src/controllers/insightsController');

function reset() {
  queries = []; keys = []; failNext = false; reportRows = [];
  logSink._internals.buffer.length = 0;
  insightsController._internals.fails.clear();
}

function fakeRes() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

/* ── the log sink ─────────────────────────────────────────────────────── */

test('redact: a bot token, an API key, a database password and a bearer token never reach the table', () => {
  const out = logSink.redact('GET https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage failed; '
    + 'key sk-abcdefghijklmnopqrstuvwx; db postgres://admin:hunter2secret@host:5432/x; Authorization: Bearer abc.def.ghijklmnop; apiKey=supersecretvalue1');
  assert.ok(!out.includes('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'));
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwx'));
  assert.ok(!out.includes('hunter2secret'));
  assert.ok(!out.includes('abc.def.ghijklmnop'));
  assert.ok(!out.includes('supersecretvalue1'));
  assert.match(out, /bot<redacted>\/sendMessage/);
  assert.match(out, /postgres:\/\/admin:<redacted>@host/);
});

test('redact: an ordinary business line is stored as written; a very long one is cut and says so', () => {
  const line = 'approvalGate: twin source for request_payment failed (allowing): timeout — R-4F72, 70,000 to Muhammad';
  assert.equal(logSink.redact(line), line);
  const long = logSink.redact('x'.repeat(5000));
  assert.ok(long.length < 4100);
  assert.match(long, /\(\+1000 chars\)$/);
});

test('the sink keeps INFO and above, buffers, and flushes as ONE insert', async () => {
  reset();
  const { accept, buffer } = logSink._internals;
  accept({ ts: '2026-11-10T09:00:00.000Z', level: 'DEBUG', msg: 'noise' });
  accept({ ts: '2026-11-10T09:00:01.000Z', level: 'INFO', msg: 'Server listening' });
  accept({ ts: '2026-11-10T09:00:02.000Z', level: 'ERROR', msg: 'Callback error' });
  assert.equal(buffer.length, 2);
  const n = await logSink.flush();
  assert.equal(n, 2);
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /^INSERT INTO app_logs \(ts, level, msg\) VALUES \(\$1, \$2, \$3\), \(\$4, \$5, \$6\)$/);
  assert.deepEqual(queries[0].params.slice(1, 3), ['INFO', 'Server listening']);
  assert.equal(buffer.length, 0);
});

test('a failed flush drops the batch and never throws — and never logs through the logger', async () => {
  reset();
  let loggerLines = 0;
  const off = logger.addSink(() => { loggerLines += 1; });
  logSink._internals.accept({ level: 'WARN', msg: 'one' });
  failNext = true;
  const realError = console.error;
  console.error = () => {};
  try { assert.equal(await logSink.flush(), 0); } finally { console.error = realError; off(); }
  assert.equal(logSink._internals.buffer.length, 0);
  assert.equal(loggerLines, 0);
});

test('logger.addSink: every line reaches the sink rendered as text; a throwing sink is ignored', () => {
  const seen = [];
  const offBad = logger.addSink(() => { throw new Error('boom'); });
  const off = logger.addSink((l) => seen.push(l));
  const realLog = console.log;
  console.log = () => {};
  try { logger.warn('queue read failed', new Error('quota'), { requestId: 'R-1' }); } finally { console.log = realLog; off(); offBad(); }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].level, 'WARN');
  assert.match(seen[0].msg, /^queue read failed Error: quota/);
  assert.match(seen[0].msg, /requestId: 'R-1'/);
});

/* ── the key ──────────────────────────────────────────────────────────── */

test('a key is minted once, only its hash is stored, and it verifies', async () => {
  reset();
  const made = await agentKeyService.create({ byUserId: '777', byName: 'Krishna' });
  assert.match(made.key, /^agk_[A-Za-z0-9_-]{40,}$/);
  assert.equal(keys.length, 1);
  assert.notEqual(keys[0].hash, made.key);
  assert.match(keys[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(await agentKeyService.verify(made.key), true);
  assert.equal(await agentKeyService.verify(`${made.key}x`), false);
  assert.equal(await agentKeyService.verify(''), false);
});

test('replacing the key revokes the old one; switching off leaves none', async () => {
  reset();
  const first = await agentKeyService.create({ byUserId: '777' });
  const second = await agentKeyService.create({ byUserId: '777' });
  assert.equal(await agentKeyService.verify(first.key), false);
  assert.equal(await agentKeyService.verify(second.key), true);
  assert.equal(await agentKeyService.revoke({ byUserId: '777' }), 1);
  assert.equal(await agentKeyService.verify(second.key), false);
  assert.equal((await agentKeyService.status()).live, null);
});

test('verify is fail-closed: a database error is a refusal', async () => {
  reset();
  const made = await agentKeyService.create({ byUserId: '777' });
  failNext = true;
  assert.equal(await agentKeyService.verify(made.key), false);
});

/* ── the reports ──────────────────────────────────────────────────────── */

test('reports: an unknown report is 404 and an unknown table is 400 — there is no free SQL', async () => {
  reset();
  await assert.rejects(() => insightsService.run('drop_everything'), (e) => e.status === 404);
  await assert.rejects(() => insightsService.run('table', { name: 'users; DROP TABLE usage_events' }), (e) => e.status === 400);
  await assert.rejects(() => insightsService.run('table', { name: 'web_sessions' }), (e) => e.status === 400);
  assert.equal(queries.length, 0);
});

test('reports: every figure a caller sends is clamped and bound, never spliced into the SQL', async () => {
  reset();
  await insightsService.run('logs', { hours: '999999', limit: '100000', level: 'warn,error;--', q: "50%_'x" });
  const q = queries[0];
  assert.match(q.text, /LIMIT 500$/);
  assert.equal(q.params[0], 24 * 60);
  assert.deepEqual(q.params[1], ['WARN']);
  assert.equal(q.params[2], "%50\\%\\_'x%");
  assert.ok(!q.text.includes("'x"));
  await insightsService.run('table', { name: 'payment_events', limit: 5 });
  assert.equal(queries[1].text, 'SELECT * FROM payment_events ORDER BY at DESC LIMIT 5');
});

test('reports: people carries each person\'s most-tapped tiles — the input a usage-ranked menu needs', async () => {
  reset();
  let call = 0;
  const real = postgresPool.query;
  postgresPool.query = async () => {
    call += 1;
    return call === 1
      ? { rows: [{ user_id: '4242', role: 'employee', events: 90, features: 6, active_days: 12, last_seen: 'x' }] }
      : { rows: [{ user_id: '4242', feature: 'supply_request', n: 40 }, { user_id: '4242', feature: 'check_stock', n: 22 }] };
  };
  try {
    const out = await insightsService.run('people', { days: 30 });
    assert.deepEqual(out.people[0].topTiles, [{ feature: 'supply_request', taps: 40 }, { feature: 'check_stock', taps: 22 }]);
  } finally { postgresPool.query = real; }
});

/* ── the HTTP gate ────────────────────────────────────────────────────── */

test('the door: no key is 401 with no detail; the right key in X-Agent-Key or Bearer reads', async () => {
  reset();
  const made = await agentKeyService.create({ byUserId: '777' });
  const none = fakeRes();
  await insightsController.getReport({ headers: {}, params: { report: 'flows' }, query: {}, ip: '1.1.1.1' }, none);
  assert.equal(none.code, 401);
  assert.deepEqual(none.body, { ok: false, error: 'A valid agent key is required.' });

  const inQuery = fakeRes();
  await insightsController.getReport({ headers: {}, params: { report: 'flows' }, query: { apiKey: made.key }, ip: '1.1.1.2' }, inQuery);
  assert.equal(inQuery.code, 401, 'a key in the URL is never accepted');

  reportRows = [{ flow: 'payment_flow', started: 4 }];
  const ok = fakeRes();
  await insightsController.getReport({ headers: { 'x-agent-key': made.key }, params: { report: 'flows' }, query: { days: '7' }, ip: '1.1.1.3' }, ok);
  assert.equal(ok.code, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.report, 'flows');
  assert.deepEqual(ok.body.flows, reportRows);

  const bearer = fakeRes();
  await insightsController.getIndex({ headers: { authorization: `Bearer ${made.key}` }, ip: '1.1.1.4' }, bearer);
  assert.equal(bearer.code, 200);
  assert.ok(bearer.body.reports.includes('logs'));
});

test('the door: ten refusals in a minute from one address and it answers 429, even to the right key', async () => {
  reset();
  const made = await agentKeyService.create({ byUserId: '777' });
  for (let i = 0; i < 10; i += 1) {
    await insightsController.getIndex({ headers: { 'x-agent-key': 'agk_wrong-wrong-wrong-wrong-wrong' }, ip: '9.9.9.9' }, fakeRes());
  }
  const blocked = fakeRes();
  await insightsController.getIndex({ headers: { 'x-agent-key': made.key }, ip: '9.9.9.9' }, blocked);
  assert.equal(blocked.code, 429);
  const other = fakeRes();
  await insightsController.getIndex({ headers: { 'x-agent-key': made.key }, ip: '8.8.8.8' }, other);
  assert.equal(other.code, 200);
});
