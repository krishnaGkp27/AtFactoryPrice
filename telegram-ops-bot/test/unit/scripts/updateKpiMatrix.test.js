'use strict';

/**
 * ANL-1 step 6 — KPI matrix usage updater. Pins the markdown rendering
 * and the idempotent splice (re-running replaces the auto section instead
 * of appending duplicates).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../../../scripts/update-kpi-matrix');
const { renderSection, spliceDoc, MARKER } = _internals;

const rows = [
  { feature: 'bundle_sale', starts: 40, completions: 30, abandons: 4, p50_duration_ms: 62000, p50_steps: 7 },
  { feature: 'check_stock', starts: 25, completions: 25, abandons: 0, p50_duration_ms: null, p50_steps: null },
];

test('renderSection produces a table with friction % and em-dash for nulls', () => {
  const s = renderSection(rows, '2026-07-12');
  assert.match(s, /\| bundle_sale \| 40 \| 30 \| 4 \| 10% \| 7 \| 62 \|/);
  assert.match(s, /\| check_stock \| 25 \| 25 \| 0 \| 0% \| — \| — \|/);
  assert.ok(s.startsWith(MARKER));
});

test('spliceDoc appends on first run, replaces on subsequent runs', () => {
  const doc = '# Matrix\n\ncontent\n';
  const v1 = spliceDoc(doc, renderSection(rows, '2026-07-12'));
  assert.equal(v1.indexOf(MARKER), v1.lastIndexOf(MARKER), 'one marker after first splice');
  const v2 = spliceDoc(v1, renderSection([], '2026-08-12'));
  assert.equal(v2.indexOf(MARKER), v2.lastIndexOf(MARKER), 'still one marker after re-run');
  assert.match(v2, /2026-08-12/);
  assert.ok(!v2.includes('2026-07-12'), 'old section fully replaced');
  assert.ok(v2.includes('# Matrix'), 'human content preserved');
});
