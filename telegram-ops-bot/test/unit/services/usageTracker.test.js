'use strict';

/**
 * ANL-1 (specs/ANL-1_USAGE_ANALYTICS.md): usage event capture.
 *
 * Pins the fire-and-forget contract: classification of callback data,
 * buffer cap with drop-oldest, batched flush SQL, session observers
 * (flow_started dedup + flow_abandoned duration/steps), and that a
 * failed flush drops events without throwing.
 *
 * Env seeds analytics ON + a fake DATABASE_URL before the require chain
 * loads config; postgresPool.query is stubbed so no real pool exists.
 */

process.env.ANALYTICS_ENABLED = '1';
process.env.DATABASE_URL = 'postgres://user:pass@fake-host:5432/fake';
process.env.ANALYTICS_BUFFER_MAX = '5';
process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '555';

const test = require('node:test');
const assert = require('node:assert/strict');

const postgresPool = require('../../../src/db/postgresPool');

let queries = [];
let failNext = false;
postgresPool.query = async (text, params) => {
  if (failNext) { failNext = false; throw new Error('pg down'); }
  queries.push({ text, params });
  return { rows: [] };
};

const tracker = require('../../../src/services/usageTracker');
const {
  buffer, classifyCallback, handleSessionSet, handleSessionExpired,
  handleSessionCleared, flowState,
} = tracker._internals;

function reset() {
  buffer.length = 0;
  flowState.clear();
  queries = [];
  failNext = false;
}

test('classifyCallback maps taps, hubs and flow prefixes', () => {
  assert.deepEqual(classifyCallback('act:check_stock'),
    { surface: 'tap', feature: 'check_stock', event: 'tile_tapped' });
  assert.deepEqual(classifyCallback('act:__hub__:inventory'),
    { surface: 'tap', feature: 'inventory', event: 'hub_opened' });
  assert.equal(classifyCallback('gr:accept:3').feature, 'receive_goods');
  assert.equal(classifyCallback('atd_rpt:7').feature, 'attendance_report');
  const unknown = classifyCallback('zzq:whatever');
  assert.equal(unknown.feature, 'other');
  assert.equal(unknown.meta.prefix, 'zzq');
});

test('track buffers events and honors the cap (drop-oldest)', () => {
  reset();
  for (let i = 0; i < 8; i++) {
    tracker.track({ userId: '555', surface: 'tap', feature: `f${i}`, event: 'tile_tapped' });
  }
  assert.equal(buffer.length, 5, 'cap = ANALYTICS_BUFFER_MAX');
  assert.equal(buffer[0].feature, 'f3', 'oldest events dropped first');
  assert.equal(buffer[0].role, 'employee');
});

test('track resolves admin role from env auth', () => {
  reset();
  tracker.track({ userId: '777', surface: 'tap', feature: 'x', event: 'tile_tapped' });
  assert.equal(buffer[0].role, 'admin');
});

test('flushNow writes one multi-row INSERT and empties the buffer', async () => {
  reset();
  tracker.track({ userId: '555', surface: 'tap', feature: 'a', event: 'tile_tapped' });
  tracker.track({ userId: '555', surface: 'nlp', feature: 'sell', event: 'nlp_intent', meta: { confidence: 0.9 } });
  const n = await tracker.flushNow();
  assert.equal(n, 2);
  assert.equal(buffer.length, 0);
  assert.equal(queries.length, 1, 'single batched INSERT');
  assert.match(queries[0].text, /INSERT INTO usage_events/);
  assert.equal(queries[0].params.length, 22, '11 params per event');
});

test('flushNow drops the batch without throwing when Postgres is down', async () => {
  reset();
  tracker.track({ userId: '555', surface: 'tap', feature: 'a', event: 'tile_tapped' });
  failNext = true;
  const n = await tracker.flushNow();
  assert.equal(n, 0);
  assert.equal(buffer.length, 0, 'failed batch is dropped, not retried forever');
});

test('session observer: flow_started once per type change, abandoned carries duration+steps', () => {
  reset();
  handleSessionSet('555', { type: 'bundle_sale_flow', step: 'design' });
  handleSessionSet('555', { type: 'bundle_sale_flow', step: 'shade' }); // same flow — no new start
  assert.equal(buffer.filter((e) => e.event === 'flow_started').length, 1);

  tracker.trackCallback('555', 'bs:pick:1');
  tracker.trackCallback('555', 'bs:pick:2');

  handleSessionExpired({ userId: '555', type: 'bundle_sale_flow', step: 'shade' });
  const abandoned = buffer.find((e) => e.event === 'flow_abandoned');
  assert.ok(abandoned, 'abandonment event emitted');
  assert.equal(abandoned.steps, 2, 'steps counted from callbacks during the flow');
  assert.ok(abandoned.durationMs >= 0, 'duration measured');
  assert.equal(flowState.size, 0, 'flow state cleaned up');
});

test('trackCallback is a no-op that never throws on junk input', () => {
  reset();
  tracker.trackCallback(undefined, null);
  tracker.track(null);
  tracker.track({ userId: '5' }); // missing feature/event
  assert.equal(buffer.length, 0);
});

// ---------------------------------------------------------------------------
// ANL-2 — deliberate flow endings, interruptions, errors, media, text steps.

test('cleared with outcome completed → flow_completed with duration+steps, state freed', () => {
  reset();
  handleSessionSet('555', { type: 'attendance_flow', step: 'pick' });
  tracker.trackCallback('555', 'atd:loc:1');
  handleSessionCleared({ userId: '555', type: 'attendance_flow', step: 'confirm' }, 'completed');
  const done = buffer.find((e) => e.event === 'flow_completed');
  assert.ok(done, 'flow_completed emitted');
  assert.equal(done.feature, 'attendance_flow');
  assert.equal(done.steps, 1);
  assert.ok(done.durationMs >= 0);
  assert.equal(flowState.size, 0, 'flowState freed so a restart counts as a new flow');
});

test('cleared with outcome cancelled → flow_cancelled; unannotated → flow_ended', () => {
  reset();
  handleSessionSet('555', { type: 'bundle_sale_flow', step: 'design' });
  handleSessionCleared({ userId: '555', type: 'bundle_sale_flow', step: 'design' }, 'cancelled');
  assert.ok(buffer.find((e) => e.event === 'flow_cancelled'));

  handleSessionSet('555', { type: 'bundle_sale_flow', step: 'design' });
  assert.equal(buffer.filter((e) => e.event === 'flow_started').length, 2,
    'restarting the SAME type after a clear emits a fresh flow_started (pre-ANL-2 it was suppressed)');
  handleSessionCleared({ userId: '555', type: 'bundle_sale_flow', step: 'design' }, undefined);
  const ended = buffer.find((e) => e.event === 'flow_ended');
  assert.ok(ended, 'unannotated clear stays visible as flow_ended');
  assert.equal(ended.meta.step, 'design');
});

test('a different flow type replacing a live one emits flow_interrupted (raw-only)', () => {
  reset();
  handleSessionSet('555', { type: 'sell_bale_flow', step: 'cart' });
  handleSessionSet('555', { type: 'transfer_flow', step: 'source' });
  const intr = buffer.find((e) => e.event === 'flow_interrupted');
  assert.ok(intr, 'interruption recorded');
  assert.equal(intr.feature, 'sell_bale_flow');
  assert.equal(intr.meta.next, 'transfer_flow');
});

test('trackError attributes the error to the live flow, else other', () => {
  reset();
  handleSessionSet('555', { type: 'payment_flow', step: 'amount' });
  tracker.trackError('555', 'message', 'boom happened');
  const err = buffer.find((e) => e.event === 'flow_error');
  assert.equal(err.feature, 'payment_flow');
  assert.equal(err.meta.kind, 'message');
  assert.equal(err.meta.error, 'boom happened');
  tracker.trackError('999', 'callback', 'x');
  assert.equal(buffer.filter((e) => e.event === 'flow_error')[1].feature, 'other');
});

test('trackMedia counts a flow step and records media_received; trackTextStep bumps steps only', () => {
  reset();
  handleSessionSet('555', { type: 'photo_receive_flow', step: 'await_file' });
  tracker.trackMedia('555', 'photo');
  tracker.trackTextStep('555');
  const media = buffer.find((e) => e.event === 'media_received');
  assert.equal(media.feature, 'photo_receive_flow');
  assert.equal(media.meta.kind, 'photo');
  handleSessionCleared({ userId: '555', type: 'photo_receive_flow', step: 'await_file' }, 'cancelled');
  const cancelled = buffer.find((e) => e.event === 'flow_cancelled');
  assert.equal(cancelled.steps, 2, 'photo + typed message both counted as steps');
  // No live flow: both are silent no-ops.
  tracker.trackMedia('999', 'document');
  assert.equal(buffer.find((e) => e.userId === '999' && e.event === 'media_received').feature, 'media');
  tracker.trackTextStep('999'); // must not throw
});

test('sessionStore.clear() drives the tracker end-to-end via the onCleared observer', () => {
  reset();
  const sessionStore = require('../../../src/utils/sessionStore');
  sessionStore.onSet(handleSessionSet);
  sessionStore.onCleared(handleSessionCleared);
  try {
    sessionStore.set('661', { type: 'role_edit_flow', step: 'pick' });
    sessionStore.clear('661', 'completed');
    assert.ok(buffer.find((e) => e.event === 'flow_completed' && e.feature === 'role_edit_flow'));
    sessionStore.set('661', { type: 'role_edit_flow', step: 'pick' });
    sessionStore.clear('661'); // unannotated
    assert.ok(buffer.find((e) => e.event === 'flow_ended'));
    sessionStore.clear('661'); // no session — observer must not fire
    assert.equal(buffer.filter((e) => e.event === 'flow_ended').length, 1);
  } finally {
    sessionStore.onSet(null);
    sessionStore.onCleared(null);
  }
});
