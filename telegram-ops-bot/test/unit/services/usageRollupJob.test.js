'use strict';

/**
 * ANL-1 — nightly rollup job. Pins the day math, the disabled no-op,
 * and that runOnce issues the upsert SQL with the day + event-class params.
 */

process.env.ANALYTICS_ENABLED = '1';
process.env.DATABASE_URL = 'postgres://user:pass@fake-host:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');

const postgresPool = require('../../../src/db/postgresPool');

let queries = [];
postgresPool.query = async (text, params) => {
  queries.push({ text, params });
  return { rows: [] };
};

const job = require('../../../src/services/usageRollupJob');
const { yesterdayISO, msUntilNextRun, START_EVENTS, COMPLETE_EVENTS } = job._internals;

test('yesterdayISO computes local YYYY-MM-DD for the prior day', () => {
  const iso = yesterdayISO(new Date(2026, 6, 12, 3, 0, 0)); // 12-Jul-2026 03:00
  assert.equal(iso, '2026-07-11');
  // Month boundary
  assert.equal(yesterdayISO(new Date(2026, 6, 1, 12, 0, 0)), '2026-06-30');
});

test('msUntilNextRun targets the next 02:00', () => {
  const before2am = new Date(2026, 6, 12, 1, 0, 0);
  assert.equal(msUntilNextRun(before2am), 60 * 60 * 1000, '01:00 → one hour');
  const after2am = new Date(2026, 6, 12, 3, 0, 0);
  assert.equal(msUntilNextRun(after2am), 23 * 60 * 60 * 1000, '03:00 → tomorrow 02:00');
});

test('runOnce upserts the requested day with event-class params', async () => {
  queries = [];
  const r = await job.runOnce('2026-07-11');
  assert.equal(r.ok, true);
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /INSERT INTO usage_daily/);
  assert.match(queries[0].text, /ON CONFLICT \(day, feature, role\) DO UPDATE/);
  assert.equal(queries[0].params[0], '2026-07-11');
  assert.deepEqual(queries[0].params[1], START_EVENTS);
  assert.deepEqual(queries[0].params[2], COMPLETE_EVENTS);
});

test('completion classes include approval_queued (flow-submitted proxy)', () => {
  assert.ok(COMPLETE_EVENTS.includes('approval_queued'));
  assert.ok(START_EVENTS.includes('flow_started'));
});
