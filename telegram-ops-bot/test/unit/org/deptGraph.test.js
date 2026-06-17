'use strict';

/**
 * Unit suite for src/org/deptGraph.js — the pure department-tree helpers.
 *
 * Runner: Node's built-in `node:test` (Node >=18). Zero credentials, fully
 * offline. Run with `npm test` or `node --test test/unit/org/deptGraph.test.js`.
 *
 * This suite is the proper-runner successor to the assertions in
 * scripts/check-org-graph.js and section S1 of scripts/smoke.js: same fixtures,
 * but isolated per-test, with per-assertion reporting and coverage support, and
 * extended to cover functions the legacy harnesses skip (notably
 * listAssignableUsers).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const dg = require('../../../src/org/deptGraph');

/** Canonical no-cycle fixture: Sales-Lagos is a child of Sales; Dispatch is a root. */
const DEPTS = [
  { dept_name: 'Sales', parent_department: '', allowed_activities: ['a1', 'a2'] },
  { dept_name: 'Sales-Lagos', parent_department: 'Sales', allowed_activities: ['a3'] },
  { dept_name: 'Dispatch', parent_department: '', allowed_activities: ['d1'] },
];

test('norm()', async (t) => {
  await t.test('lowercases and trims', () => {
    assert.equal(dg.norm('  Sales-Lagos  '), 'sales-lagos');
  });

  await t.test('coerces null/undefined to empty string', () => {
    assert.equal(dg.norm(null), '');
    assert.equal(dg.norm(undefined), '');
  });
});

test('buildGraph()', async (t) => {
  await t.test('indexes departments by normalized name', () => {
    const { byNorm } = dg.buildGraph(DEPTS);
    assert.equal(byNorm.size, 3);
    assert.ok(byNorm.has('sales-lagos'));
    assert.equal(byNorm.get('sales-lagos').parentNorm, 'sales');
    assert.deepEqual(byNorm.get('sales').activities, ['a1', 'a2']);
  });

  await t.test('skips rows with a blank dept_name', () => {
    const { byNorm } = dg.buildGraph([{ dept_name: '' }, { dept_name: 'Ops' }]);
    assert.equal(byNorm.size, 1);
    assert.ok(byNorm.has('ops'));
  });

  await t.test('first row wins on duplicate names (case-insensitive)', () => {
    const { byNorm } = dg.buildGraph([
      { dept_name: 'Sales', parent_department: '' },
      { dept_name: 'sales', parent_department: 'Dispatch' },
    ]);
    assert.equal(byNorm.size, 1);
    assert.equal(byNorm.get('sales').parentNorm, '');
  });

  await t.test('tolerates null/undefined input', () => {
    assert.equal(dg.buildGraph(null).byNorm.size, 0);
    assert.equal(dg.buildGraph(undefined).byNorm.size, 0);
  });
});

test('getAncestorChain()', async (t) => {
  const { graph } = dg.validateForest(DEPTS);

  await t.test('walks child up through its parent chain', () => {
    const { chainNorm, names } = dg.getAncestorChain('Sales-Lagos', graph);
    assert.deepEqual(chainNorm, ['sales-lagos', 'sales']);
    assert.deepEqual(names, ['Sales-Lagos', 'Sales']);
  });

  await t.test('root department resolves to itself', () => {
    const { chainNorm } = dg.getAncestorChain('Dispatch', graph);
    assert.deepEqual(chainNorm, ['dispatch']);
  });

  await t.test('flags a cycle instead of looping forever', () => {
    const { graph: g } = dg.validateForest([
      { dept_name: 'A', parent_department: 'B' },
      { dept_name: 'B', parent_department: 'A' },
    ]);
    const res = dg.getAncestorChain('A', g);
    assert.equal(res.cycle, true);
  });
});

test('deptUnderAncestor()', async (t) => {
  const { graph } = dg.validateForest(DEPTS);

  await t.test('true for a descendant', () => {
    assert.equal(dg.deptUnderAncestor('Sales-Lagos', 'Sales', graph), true);
  });

  await t.test('true for self (reflexive)', () => {
    assert.equal(dg.deptUnderAncestor('Sales', 'Sales', graph), true);
  });

  await t.test('case-insensitive matching', () => {
    assert.equal(dg.deptUnderAncestor('sales-lagos', 'SALES', graph), true);
  });

  await t.test('false across unrelated branches', () => {
    assert.equal(dg.deptUnderAncestor('Sales-Lagos', 'Dispatch', graph), false);
  });

  await t.test('false for an empty ancestor', () => {
    assert.equal(dg.deptUnderAncestor('Sales-Lagos', '', graph), false);
  });
});

test('validateForest()', async (t) => {
  await t.test('accepts a well-formed forest', () => {
    const v = dg.validateForest(DEPTS);
    assert.equal(v.ok, true);
    assert.deepEqual(v.errors, []);
  });

  await t.test('rejects a cycle with a descriptive error', () => {
    const v = dg.validateForest([
      { dept_name: 'A', parent_department: 'B' },
      { dept_name: 'B', parent_department: 'A' },
    ]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /cycle/i.test(e)));
  });

  await t.test('rejects a parent that references an unknown department', () => {
    const v = dg.validateForest([
      { dept_name: 'Sales-Lagos', parent_department: 'Ghost' },
    ]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /unknown parent/i.test(e)));
  });
});

test('canAssignTo()', async (t) => {
  const { graph } = dg.validateForest(DEPTS);

  await t.test('manager can assign to a worker in a managed sub-department', () => {
    const manager = { manages: ['Sales'], departments: ['Sales'] };
    const worker = { departments: ['Sales-Lagos'] };
    assert.equal(dg.canAssignTo(manager, worker, graph), true);
  });

  await t.test('manager cannot assign across an unmanaged branch', () => {
    const manager = { manages: ['Dispatch'], departments: ['Dispatch'] };
    const worker = { departments: ['Sales-Lagos'] };
    assert.equal(dg.canAssignTo(manager, worker, graph), false);
  });

  await t.test('false when the actor manages nothing', () => {
    const actor = { manages: [], departments: ['Sales'] };
    const worker = { departments: ['Sales-Lagos'] };
    assert.equal(dg.canAssignTo(actor, worker, graph), false);
  });

  await t.test('falls back to singular target.department', () => {
    const manager = { manages: ['Sales'] };
    const worker = { department: 'Sales-Lagos' };
    assert.equal(dg.canAssignTo(manager, worker, graph), true);
  });

  await t.test('every target department must be covered', () => {
    const manager = { manages: ['Sales'] };
    const worker = { departments: ['Sales-Lagos', 'Dispatch'] };
    assert.equal(dg.canAssignTo(manager, worker, graph), false);
  });

  await t.test('false on null actor or target', () => {
    assert.equal(dg.canAssignTo(null, { departments: ['Sales'] }, graph), false);
    assert.equal(dg.canAssignTo({ manages: ['Sales'] }, null, graph), false);
  });
});

test('mergeActivitiesForManages()', async (t) => {
  await t.test('unions allowed_activities across managed departments', () => {
    const acts = dg.mergeActivitiesForManages(
      { manages: ['Sales', 'Sales-Lagos'] },
      DEPTS,
    );
    assert.deepEqual(new Set(acts), new Set(['a1', 'a2', 'a3']));
  });

  await t.test('empty when the user manages nothing', () => {
    assert.deepEqual(dg.mergeActivitiesForManages({ manages: [] }, DEPTS), []);
    assert.deepEqual(dg.mergeActivitiesForManages({}, DEPTS), []);
  });

  await t.test('de-duplicates overlapping activities', () => {
    const depts = [
      { dept_name: 'X', allowed_activities: ['shared', 'x1'] },
      { dept_name: 'Y', allowed_activities: ['shared', 'y1'] },
    ];
    const acts = dg.mergeActivitiesForManages({ manages: ['X', 'Y'] }, depts);
    assert.equal(acts.length, 3);
  });
});

test('listAssignableUsers()', async (t) => {
  const { graph } = dg.validateForest(DEPTS);
  const users = [
    { user_id: '1', status: 'active', departments: ['Sales'] },
    { user_id: '2', status: 'active', departments: ['Sales-Lagos'] },
    { user_id: '3', status: 'active', departments: ['Dispatch'] },
    { user_id: '4', status: 'inactive', departments: ['Sales-Lagos'] },
  ];

  await t.test('admin sees every active user', () => {
    const actor = { user_id: '9', manages: [] };
    const out = dg.listAssignableUsers(actor, users, graph, { isAdmin: true });
    assert.deepEqual(out.map((u) => u.user_id), ['1', '2', '3']);
  });

  await t.test('manager sees only users in managed sub-departments', () => {
    const actor = { user_id: '1', manages: ['Sales'] };
    const out = dg.listAssignableUsers(actor, users, graph);
    assert.deepEqual(out.map((u) => u.user_id), ['2']);
  });

  await t.test('excludeSelf is the default', () => {
    const actor = { user_id: '1', manages: ['Sales'] };
    const out = dg.listAssignableUsers(actor, users, graph);
    assert.ok(!out.some((u) => u.user_id === '1'));
  });

  await t.test('inactive users are always filtered out', () => {
    const actor = { user_id: '9', manages: [] };
    const out = dg.listAssignableUsers(actor, users, graph, { isAdmin: true });
    assert.ok(!out.some((u) => u.user_id === '4'));
  });
});
