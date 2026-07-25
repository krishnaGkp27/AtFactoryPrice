'use strict';

/**
 * SHD-1a — CS-number writer contract, pinned end to end.
 *
 * The Add Stock packing-list path (src/flows/addStockFlow.js) builds
 * validator input rows by hand, while the CSV path reaches the validator
 * with LOWERCASED headers. On 24-Jul-2026 the packing-list path was changed
 * to emit `csNo` while the validator read `row.csno`, so every XLSX
 * packing-list intake silently wrote a BLANK cs_no to Inventory.
 *
 * These tests pin both halves of the contract so the mismatch cannot
 * reappear: the validator tolerates either spelling, and the packing-list
 * row builder actually produces a key the validator reads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const validator = require('../../../src/utils/bulkRowValidator');

const BASE = ['packageno', 'thanno', 'design', 'yards', 'warehouse'];

function parsed(headers, rows) {
  return { ok: true, headers, rows: rows.map((r, i) => ({ ...r, _rowNum: i + 2 })) };
}

function row(extra) {
  return {
    packageno: '824', thanno: '1', design: '9006', yards: '30',
    warehouse: 'IDUMOTA store', ...extra,
  };
}

test('validator reads the lowercase csno key (CSV/parseCsv contract)', () => {
  const v = validator.validate(parsed([...BASE, 'csno'], [row({ csno: 'CS-777' })]));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.bales[0].csNo, 'CS-777');
});

test('validator also tolerates a camelCase csNo key (SHD-1a guard)', () => {
  const v = validator.validate(parsed([...BASE, 'csno'], [row({ csNo: 'CS-777' })]));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.bales[0].csNo, 'CS-777', 'a camelCase slip must not blank the CS number');
});

test('a missing CS number stays empty rather than undefined', () => {
  const v = validator.validate(parsed(BASE, [row({})]));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.bales[0].csNo, '');
});

test('addStockFlow emits a CS key the validator actually reads', () => {
  // Source-level contract check: the packing-list row builder is deep inside
  // a Telegram document handler, so assert on the literal it constructs.
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/flows/addStockFlow.js'), 'utf8');
  const m = src.match(/indent:\s*t\.indent,\s*(cs[Nn]o):/);
  assert.ok(m, 'packing-list row builder should set a CS key next to indent');
  const emitted = m[1];
  const v = validator.validate(parsed([...BASE, 'csno'], [row({ [emitted]: 'CS-999' })]));
  assert.equal(v.bales[0].csNo, 'CS-999',
    `addStockFlow emits "${emitted}" — the validator must read it`);
});
