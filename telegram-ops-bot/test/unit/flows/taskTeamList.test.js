'use strict';

/**
 * TSK-V3 — Team Tasks admin list: the pure pieces.
 *
 * The list's promises are mechanical: context survives round-tripping
 * through callback_data, the chip fact is honest per status, the stall
 * flag flips strictly past TASK_STALL_DAYS, priority-first ordering with
 * needs-you-first inside a colour, and duplicate titles get told apart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { _internals: I } = require(path.join(__dirname, '../../../src/flows/taskFlow'));

const DAY = 86400000;
const NOW = new Date('2026-08-26T12:00:00Z').getTime();

function t(over = {}) {
  return {
    task_id: over.task_id || 'T1',
    title: 'Office work',
    status: 'assigned',
    track: 'salaried',
    priority: 'normal',
    assigned_at: new Date(NOW - 3 * DAY).toISOString(),
    last_event_at: new Date(NOW - 3 * DAY).toISOString(),
    proposed_hours: null,
    proposed_deadline: '',
    ...over,
  };
}

test('parseListCtx round-trips and rejects garbage', () => {
  assert.deepEqual(I.parseListCtx('o:a:0'), { mode: 'o', filter: 'a', page: 0 });
  assert.deepEqual(I.parseListCtx('d:12345:2'), { mode: 'd', filter: '12345', page: 2 });
  // Malformed → page 1 of All, never a throw and never a negative page.
  assert.deepEqual(I.parseListCtx('x:__proto__:-3'), { mode: 'o', filter: 'a', page: 0 });
  assert.deepEqual(I.parseListCtx(''), { mode: 'o', filter: 'a', page: 0 });
  assert.deepEqual(I.parseListCtx(undefined), { mode: 'o', filter: 'a', page: 0 });
});

test('chip facts: every admin-facing status is honest and short', () => {
  const s = 7;
  assert.equal(I.teamChipFact(t({ status: 'awaiting_timeline_ack', proposed_hours: 48 }), s, NOW), '👉 accept 2d?');
  assert.equal(
    I.teamChipFact(t({ status: 'awaiting_timeline_ack', track: 'incentivized', proposed_hours: 24 }), s, NOW),
    '👉 ₦ + accept 1d?');
  assert.equal(I.teamChipFact(t({ status: 'awaiting_incentive' }), s, NOW), '👉 set ₦');
  assert.equal(I.teamChipFact(t({ status: 'submitted' }), s, NOW), '👉 sign off');
  assert.equal(I.teamChipFact(t({ status: 'awaiting_final_ack' }), s, NOW), '⌛ his OK');
  const running = I.teamChipFact(t({
    status: 'active', proposed_hours: 4,
    started_at: new Date(NOW - 3600000).toISOString(),
  }), s, NOW);
  assert.match(running, /^🔵 ends ~/);
  assert.equal(
    I.teamChipFact(t({ status: 'active', track: 'incentivized', proposed_deadline: '2026-08-27' }), s, NOW),
    '🔵 by 27-Aug');
});

test('waiting chips age, and ⚠️ flips strictly past the stall limit', () => {
  const s = 7;
  const at = (d) => new Date(NOW - d * DAY).toISOString();
  assert.equal(I.teamChipFact(t({ assigned_at: at(0), last_event_at: at(0) }), s, NOW), '📨 today');
  assert.equal(I.teamChipFact(t({ assigned_at: at(6), last_event_at: at(6) }), s, NOW), '📨 6d');
  // Day 7 is still 📨 (strictly greater-than) — day 8 is ⚠️.
  assert.equal(I.teamChipFact(t({ assigned_at: at(7), last_event_at: at(7) }), s, NOW), '📨 7d');
  assert.equal(I.teamChipFact(t({ assigned_at: at(8), last_event_at: at(8) }), s, NOW), '⚠️ 8d');
  assert.equal(I.isStalled(t({ assigned_at: at(107), last_event_at: at(107) }), s, NOW), true);
  // A running task can never be "stalled" — nobody's silence is involved.
  assert.equal(I.isStalled(t({ status: 'active', last_event_at: at(90) }), s, NOW), false);
});

test('unparseable dates never poison a chip with NaN', () => {
  assert.equal(I.silentDays(t({ assigned_at: 'not-a-date', last_event_at: 'nope' }), NOW), null);
  const fact = I.teamChipFact(t({ assigned_at: 'not-a-date', last_event_at: '' }), 7, NOW);
  assert.equal(fact, '📨 waiting');
  assert.ok(!/NaN/.test(fact));
});

test('order: priority colour first, needs-you inside the colour, then oldest', () => {
  const at = (d) => new Date(NOW - d * DAY).toISOString();
  const list = [
    t({ task_id: 'lowOld', priority: 'low', assigned_at: at(200) }),
    t({ task_id: 'critWaiting', priority: 'critical', assigned_at: at(5) }),
    t({ task_id: 'critNeedsYouNew', priority: 'critical', status: 'submitted', assigned_at: at(1) }),
    t({ task_id: 'critNeedsYouOld', priority: 'critical', status: 'awaiting_timeline_ack', assigned_at: at(9) }),
    t({ task_id: 'highStalled', priority: 'high', assigned_at: at(101) }),
  ];
  I.sortForAdmin(list, NOW);
  assert.deepEqual(list.map((x) => x.task_id),
    ['critNeedsYouOld', 'critNeedsYouNew', 'critWaiting', 'highStalled', 'lowOld']);
});

test('duplicate titles get their assigned date; unique titles stay verbatim', () => {
  const a = t({ task_id: 'A', title: 'Catelog upload', assigned_at: '2026-05-11T09:00:00Z' });
  const b = t({ task_id: 'B', title: 'Catelog upload', assigned_at: '2026-05-23T09:00:00Z' });
  const c = t({ task_id: 'C', title: 'Payment collection' });
  const m = I.dedupeTitles([a, b, c]);
  assert.equal(m.get('A'), 'Catelog upload (11-May)');
  assert.equal(m.get('B'), 'Catelog upload (23-May)');
  assert.equal(m.get('C'), 'Payment collection');
});

test('the page cap is 8 — the number the owner signed off', () => {
  assert.equal(I.TEAM_PAGE, 8);
});
