'use strict';

/**
 * TSK-V2 — the digest must see BOTH clocks.
 *
 * The split gave salaried work no deadline column: the worker commits hours
 * and the finish is derived from start + those hours. The digest filtered
 * on proposed_deadline, so without this every salaried overrun would have
 * become invisible to the one scheduled message that reports overdue work —
 * a silent blind spot introduced by the very change meant to make work
 * visible.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const tasksRepository = require(path.join(SRC, 'repositories/tasksRepository'));
const morningDigest = require(path.join(SRC, 'services/morningDigest'));

const TASKS = morningDigest.CATEGORIES.find((c) => c.key === 'DIGEST_TASKS');
const today = new Date().toISOString().slice(0, 10);
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

test('a salaried task past its committed time counts as overdue', async () => {
  tasksRepository.getAll = async () => ([
    // Started 6h ago, committed 4h → two hours over, and no deadline column.
    { task_id: 'T1', title: 'Fix the generator', assigned_to: '900', status: 'active',
      track: 'salaried', started_at: hoursAgo(6), proposed_hours: 4, proposed_deadline: '' },
  ]);
  const { line, count } = await TASKS.summarize({}, today);
  assert.equal(count, 1, 'the overrun is counted');
  assert.match(line, /1\*? due\/overdue|\*1\* due/);
});

test('a salaried task still inside its time is not overdue', async () => {
  tasksRepository.getAll = async () => ([
    { task_id: 'T2', title: 'Sweep the store', assigned_to: '900', status: 'active',
      track: 'salaried', started_at: hoursAgo(1), proposed_hours: 8, proposed_deadline: '' },
  ]);
  const { count } = await TASKS.summarize({}, today);
  assert.equal(count, 0);
});

test('a task nobody has answered is never called overdue', async () => {
  // No start, no committed time: it is stalled, not late. Calling it overdue
  // would put a date on work that was never dated.
  tasksRepository.getAll = async () => ([
    { task_id: 'T3', title: 'Weekly round', assigned_to: '900', status: 'assigned',
      track: 'salaried', started_at: '', proposed_hours: null, proposed_deadline: '' },
  ]);
  const { count } = await TASKS.summarize({}, today);
  assert.equal(count, 0);
});

test('an incentivized task still goes by its agreed date', async () => {
  tasksRepository.getAll = async () => ([
    { task_id: 'T4', title: 'Deliver bales', assigned_to: '900', status: 'active',
      track: 'incentivized', started_at: hoursAgo(2), proposed_hours: 240,
      proposed_deadline: '2020-01-01' },
  ]);
  const { count } = await TASKS.summarize({}, today);
  assert.equal(count, 1, 'the agreed date rules on this track, not the hours');
});

test('the detail list prints a name, not a raw Telegram id', async () => {
  tasksRepository.getAll = async () => ([
    { task_id: 'T5', title: 'Fix the generator', assigned_to: '900', status: 'active',
      track: 'salaried', started_at: hoursAgo(6), proposed_hours: 4, proposed_deadline: '' },
  ]);
  const cards = require(path.join(SRC, 'services/approvalCards'));
  cards.resolveUserLabel = async (id) => (String(id) === '900' ? 'Musa' : String(id));
  const text = await TASKS.detail({}, today);
  assert.match(text, /Musa/, 'the person is named');
  assert.ok(!text.includes('@900'), 'never a bare id where a name belongs');
});
