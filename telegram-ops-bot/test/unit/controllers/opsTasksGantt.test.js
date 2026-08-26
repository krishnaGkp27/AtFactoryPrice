'use strict';

/**
 * GNT-1 — the employee Gantt feed.
 *
 * The two things worth pinning:
 *   1. MONEY NEVER CROSSES. The chart is a scrum-master surface; it may say
 *      a bonus exists so a bar can carry a ₦ marker, but no amount, and no
 *      field that could carry one, may appear in the payload.
 *   2. The bar's geometry is DERIVED, not stored. Salaried work sends the
 *      committed hours; incentivized work sends the agreed date; a task
 *      nobody has answered sends neither — and must still appear, because
 *      those silent stalls are the reason the chart exists.
 */

process.env.BOT_API_KEY = 'test-gantt-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const tasksRepository = require(path.join(SRC, 'repositories/tasksRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const incentivesRepository = require(path.join(SRC, 'repositories/incentivesRepository'));
const apiController = require(path.join(SRC, 'controllers/apiController'));

const TODAY = new Date().toISOString();

usersRepository.getAll = async () => ([
  { user_id: '900', name: 'Musa', status: 'active' },
  { user_id: '901', name: 'Sani', status: 'active' },
  { user_id: '902', name: 'Gone', status: 'inactive' },
  { user_id: '100', name: 'Abdul', status: 'active' },
]);
incentivesRepository.getAll = async () => ([{ task_id: 'T2', amount: 5000, currency: 'NGN' }]);
tasksRepository.getAll = async () => ([
  { task_id: 'T1', title: 'Zenith draft', assigned_to: '900', assigned_by: '100', status: 'active',
    track: 'salaried', priority: 'high', started_at: TODAY, proposed_hours: 4, proposed_deadline: '' },
  { task_id: 'T2', title: 'Deliver bales', assigned_to: '900', assigned_by: '100', status: 'active',
    track: 'incentivized', priority: 'high', started_at: TODAY, proposed_hours: 24, proposed_deadline: '2026-08-27' },
  { task_id: 'T3', title: 'Weekly round', assigned_to: '901', assigned_by: '100', status: 'assigned',
    track: 'salaried', priority: 'normal', started_at: '', proposed_hours: null, proposed_deadline: '' },
  { task_id: 'T4', title: 'Signed off today', assigned_to: '901', assigned_by: '100', status: 'completed',
    track: 'salaried', priority: 'normal', started_at: TODAY, proposed_hours: 2, approved_at: TODAY },
  { task_id: 'T5', title: 'Ancient history', assigned_to: '901', assigned_by: '100', status: 'completed',
    track: 'salaried', priority: 'normal', started_at: '2026-01-01T08:00:00Z', proposed_hours: 2,
    approved_at: '2026-01-01T10:00:00Z' },
  { task_id: 'T6', title: 'Abandoned', assigned_to: '901', assigned_by: '100', status: 'cancelled',
    track: 'salaried', priority: 'low' },
]);

function call(handler, headers = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler({ headers, query: {} }, res);
  });
}
const asAdmin = () => call(apiController.getOpsTasks, { 'x-api-key': 'test-gantt-key' });

test('not one naira reaches the chart', async () => {
  const { body } = await asAdmin();
  const blob = JSON.stringify(body);
  assert.ok(!/\bamount\b/i.test(blob), 'no amount field anywhere in the payload');
  assert.ok(!blob.includes('5000'), 'the incentive figure never leaves the Incentives sheet');
  assert.ok(!/currency/i.test(blob));
  // The existence of a bonus IS allowed — that is the ₦ marker on the bar.
  const t2 = body.tasks.find((t) => t.task_id === 'T2');
  assert.equal(t2.hasIncentive, true);
  assert.equal(body.tasks.find((t) => t.task_id === 'T1').hasIncentive, false);
});

test('each track carries the geometry its bar is drawn from', async () => {
  const { status, body } = await asAdmin();
  assert.equal(status, 200);
  const by = Object.fromEntries(body.tasks.map((t) => [t.task_id, t]));

  // Salaried: start + committed hours. No stored deadline to contradict it.
  assert.equal(by.T1.eta_hours, 4);
  assert.equal(by.T1.agreed_deadline, '');
  assert.ok(by.T1.started_at);

  // Incentivized: start → the agreed date.
  assert.equal(by.T2.agreed_deadline, '2026-08-27');

  // Waiting: neither. It must still be present — a task nobody answered has
  // no deadline and appears in no overdue count, so the chart is the only
  // place it can be seen at all.
  assert.ok(by.T3, 'an unanswered task still gets a row');
  assert.equal(by.T3.started_at, '');
  assert.equal(by.T3.eta_hours, null);
});

test('live work plus today\'s deliveries; nothing older, nothing abandoned', async () => {
  const { body } = await asAdmin();
  const ids = body.tasks.map((t) => t.task_id);
  assert.ok(ids.includes('T4'), "work signed off today stays visible — it is the day's evidence");
  assert.ok(!ids.includes('T5'), 'work finished long ago is not today\'s plan');
  assert.ok(!ids.includes('T6'), 'cancelled work is not on the plan');
});

test('every active person gets a row, so an idle one is visible too', async () => {
  const { body } = await asAdmin();
  const names = body.people.map((p) => p.name);
  assert.ok(names.includes('Abdul'), 'someone holding no tasks still appears');
  assert.ok(!names.includes('Gone'), 'inactive staff with no live work do not');
});

test('a deactivated person still holding live work keeps their row', async () => {
  // Filtering on status alone orphaned their unfinished tasks: still in the
  // payload, but with no row to draw them on, so the work silently left the
  // plan at exactly the moment someone needs to reassign it.
  const original = tasksRepository.getAll;
  tasksRepository.getAll = async () => ([
    { task_id: 'T9', title: 'Half-finished', assigned_to: '902', assigned_by: '100',
      status: 'active', track: 'salaried', priority: 'normal', started_at: TODAY, proposed_hours: 4 },
  ]);
  try {
    const { body } = await asAdmin();
    assert.ok(body.people.some((p) => p.id === '902'), 'the deactivated holder still gets a row');
    assert.ok(body.tasks.some((t) => t.person_id === '902'), 'and their work is still drawn');
  } finally {
    tasksRepository.getAll = original;
  }
});

test('admin-only, and never a write path', async () => {
  const noKey = await call(apiController.getOpsTasks, {});
  assert.equal(noKey.status, 403);
  assert.equal(typeof apiController.postOpsTasks, 'undefined', 'there is no write endpoint (§15)');
});
