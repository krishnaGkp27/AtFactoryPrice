'use strict';

/**
 * PG-1 — inventory mirror parity metric helpers (pure, no I/O).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../../../src/services/inventoryMirrorService');
const { computeMetrics, diffMetrics } = _internals;

test('computeMetrics: counts rows, bales, designs, warehouse thans', () => {
  const rows = [
    { packageNo: 'P1', design: '44200', status: 'available', warehouse: 'Lagos' },
    { packageNo: 'P1', design: '44200', status: 'available', warehouse: 'Lagos' },
    { packageNo: 'P2', design: '80045', status: 'sold', warehouse: 'Lagos' },
    { packageNo: 'P3', design: '9006', status: 'available', warehouse: 'Kano office' },
  ];
  const m = computeMetrics(rows);
  assert.equal(m.total, 4);
  assert.equal(m.availableBales, 2, 'P1 + P3 (sold P2 excluded)');
  assert.equal(m.designs, 3);
  assert.equal(m.byWarehouse.get('Lagos'), 2, 'two available thans in Lagos');
  assert.equal(m.byWarehouse.get('Kano office'), 1);
});

test('diffMetrics: empty when sheet and pg agree', () => {
  const m = computeMetrics([
    { packageNo: 'P1', design: 'A', status: 'available', warehouse: 'Lagos' },
  ]);
  assert.deepEqual(diffMetrics(m, m), []);
});

test('diffMetrics: surfaces row-count and warehouse mismatches', () => {
  const sheet = computeMetrics([
    { packageNo: 'P1', design: 'A', status: 'available', warehouse: 'Lagos' },
    { packageNo: 'P2', design: 'B', status: 'available', warehouse: 'Lagos' },
  ]);
  const pg = computeMetrics([
    { packageNo: 'P1', design: 'A', status: 'available', warehouse: 'Lagos' },
  ]);
  const diff = diffMetrics(sheet, pg);
  assert.ok(diff.some((l) => /row count/.test(l)));
  assert.ok(diff.some((l) => /available thans @ Lagos/.test(l)));
});
