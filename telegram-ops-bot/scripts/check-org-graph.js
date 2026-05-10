#!/usr/bin/env node
/**
 * Offline checks for TG-7.5 org graph helpers (no Google credentials).
 * Run: npm run check-org
 */

'use strict';

const assert = require('assert');
const dg = require('../src/org/deptGraph');

const depts = [
  { dept_name: 'Sales', parent_department: '', allowed_activities: ['a1'] },
  { dept_name: 'Sales-Lagos', parent_department: 'Sales', allowed_activities: ['a2'] },
  { dept_name: 'Dispatch', parent_department: '', allowed_activities: ['d1'] },
];

const v = dg.validateForest(depts);
assert.strictEqual(v.ok, true, v.errors.join('; '));

assert.strictEqual(dg.deptUnderAncestor('Sales-Lagos', 'Sales', v.graph), true);
assert.strictEqual(dg.deptUnderAncestor('Sales-Lagos', 'Dispatch', v.graph), false);
assert.strictEqual(dg.deptUnderAncestor('Sales', 'Sales', v.graph), true);

const manager = { manages: ['Sales'], departments: ['Sales'] };
const worker = { departments: ['Sales-Lagos'] };
assert.strictEqual(dg.canAssignTo(manager, worker, v.graph), true);

const badManager = { manages: ['Dispatch'], departments: ['Dispatch'] };
assert.strictEqual(dg.canAssignTo(badManager, worker, v.graph), false);

const acts = dg.mergeActivitiesForManages(
  { manages: ['Sales', 'Sales-Lagos'] },
  depts,
);
assert(acts.includes('a1'));
assert(acts.includes('a2'));

const cycleDepts = [
  { dept_name: 'A', parent_department: 'B' },
  { dept_name: 'B', parent_department: 'A' },
];
const cv = dg.validateForest(cycleDepts);
assert.strictEqual(cv.ok, false);
assert(cv.errors.some((e) => /Cycle/i.test(e)));

console.log('check-org-graph: OK');
