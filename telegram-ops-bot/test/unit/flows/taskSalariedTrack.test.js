'use strict';

/**
 * TSK-V2 — the salaried track: an instruction, not a bargain.
 *
 * What these pin:
 *   1. A salaried doer commits TIME and the clock starts on that same tap —
 *      no negotiation states in between.
 *   2. The tracks cannot cross: propose_timeline is illegal on salaried,
 *      accept_estimate is illegal on incentivized. That guard is the whole
 *      split; without it both tracks collapse back into one.
 *   3. No deadline is stored for salaried work — the finish is derived from
 *      start + committed hours (§10), so nothing can drift out of sync.
 *   4. Time input is a fixed chart: twelve tap-only values, no free text.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const SRC = path.join(__dirname, '../../../src');
const tasksRepository = require(path.join(SRC, 'repositories/tasksRepository'));
const taskEventsRepository = require(path.join(SRC, 'repositories/taskEventsRepository'));
const taskStateMachine = require(path.join(SRC, 'flows/taskStateMachine'));

let ROWS = {};
let EVENTS = [];

tasksRepository.getById = async (id) => (ROWS[id] ? { ...ROWS[id] } : null);
tasksRepository.updateFields = async (id, patch) => { Object.assign(ROWS[id], patch); return ROWS[id]; };
taskEventsRepository.append = async (e) => { EVENTS.push(e); return e; };

function seed(over = {}) {
  ROWS = {
    T1: {
      task_id: 'T1',
      title: 'Collect the Zenith bank draft',
      assigned_to: '900',
      assigned_by: '100',
      status: 'assigned',
      track: 'salaried',
      priority: 'normal',
      negotiation_rounds: 0,
      proposed_hours: null,
      proposed_deadline: '',
      ...over,
    },
  };
  EVENTS = [];
}

test('salaried: giving the time starts the clock in one step', async () => {
  seed();
  const { task, event } = await taskStateMachine.transition('T1', 'accept_estimate', '900', { hours: 4 });

  assert.equal(task.status, 'active', 'straight to active — no negotiation states');
  assert.equal(task.proposed_hours, 4);
  assert.ok(task.started_at, 'the clock is stamped on this tap');
  assert.equal(event.event_type, 'doer_accepted_estimate');
});

test('salaried: no deadline is ever stored — the finish is derived', async () => {
  seed();
  const { task } = await taskStateMachine.transition('T1', 'accept_estimate', '900', { hours: 8 });
  assert.equal(task.proposed_deadline, '', 'a stored deadline would be a second source of truth (§10)');
  // The derived finish is start + hours; recomputing it must be possible.
  const end = new Date(new Date(task.started_at).getTime() + 8 * 3600 * 1000);
  assert.ok(end > new Date(task.started_at));
});

test('the tracks cannot cross', async () => {
  seed();
  await assert.rejects(
    () => taskStateMachine.transition('T1', 'propose_timeline', '900', { hours: 4, deadline: '2026-08-28' }),
    /ILLEGAL_TRANSITION|Illegal transition/,
    'salaried work never opens a negotiation',
  );

  seed({ track: 'incentivized' });
  await assert.rejects(
    () => taskStateMachine.transition('T1', 'accept_estimate', '900', { hours: 4 }),
    /ILLEGAL_TRANSITION|Illegal transition/,
    'incentivized work never skips the deal',
  );
});

test('only the doer may commit the time', async () => {
  seed();
  await assert.rejects(
    () => taskStateMachine.transition('T1', 'accept_estimate', '100', { hours: 4 }),
    /NotActor/,
    'the assigner cannot commit time on the worker\'s behalf',
  );
});

test('an incentivized task still negotiates exactly as before', async () => {
  seed({ track: 'incentivized' });
  const a = await taskStateMachine.transition('T1', 'propose_timeline', '900', { hours: 24, deadline: '2026-08-28' });
  assert.equal(a.task.status, 'awaiting_timeline_ack');
  const b = await taskStateMachine.transition('T1', 'accept_timeline', '100');
  assert.equal(b.task.status, 'awaiting_final_ack');
  const c = await taskStateMachine.transition('T1', 'final_ack', '900');
  assert.equal(c.task.status, 'active');
  assert.equal(c.task.proposed_deadline, '2026-08-28', 'the agreed date is real on this track');
});

test('the time chart is tap-only: twelve fixed values, no typed entry', () => {
  const src = fs.readFileSync(path.join(SRC, 'flows/taskFlow.js'), 'utf8');
  assert.ok(!src.includes('phr_custom'), 'the custom-hours chip is gone');
  assert.ok(!src.includes('hours_text'), 'the typed-hours step is gone');
  assert.match(src, /const HOURS_CHART = \[1, 2, 3, 4, 6, 8\]/);
  assert.match(src, /const DAYS_CHART = \[/);
  // Both tracks draw from the same chart, so neither can take a stray value.
  assert.match(src, /timeChartRows\(cur, 'tsk:phr:'\)/);
  assert.match(src, /timeChartRows\(null, 'tsk:ehr:'\)/);
});

test('the description travels with the task onto every card', () => {
  const src = fs.readFileSync(path.join(SRC, 'flows/taskFlow.js'), 'utf8');
  assert.match(src, /function descLine\(/);
  // The chart, the running card and the doer's task card all carry it —
  // that is what makes editing the card in place safe.
  assert.ok(src.includes('descLine(t.taskDescription)'), 'the time chart shows it');
  assert.ok(src.includes('descLine(task.description)'), 'the running/detail cards show it');
});
