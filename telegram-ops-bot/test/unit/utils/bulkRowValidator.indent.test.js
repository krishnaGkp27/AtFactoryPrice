'use strict';

/**
 * BULK-INDENT — the optional Indent + CSNo upload columns ride through the
 * validator into the normalized than rows (and from there via bulkReceiveFlow
 * submit → bulk_receive_goods executor → Inventory Indent/CSNo columns).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const validator = require('../../../src/utils/bulkRowValidator');

function parsed(headers, rows) {
  return { ok: true, headers, rows: rows.map((r, i) => ({ ...r, _rowNum: i + 2 })) };
}

const BASE = ['packageno', 'thanno', 'design', 'yards', 'warehouse'];

test('indent + csno are accepted headers and carried into than rows', () => {
  const v = validator.validate(parsed([...BASE, 'shade', 'indent', 'csno'], [
    { packageno: '6012', thanno: '1', design: '80046', yards: '30', warehouse: 'IDUMOTA store', shade: '10', indent: 'SA/2521', csno: '2' },
    { packageno: '6012', thanno: '2', design: '80046', yards: '30', warehouse: 'IDUMOTA store', shade: '10', indent: 'SA/2521', csno: '2' },
  ]));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.bales.length, 2);
  assert.equal(v.bales[0].indent, 'SA/2521');
  assert.equal(v.bales[0].csNo, '2');
});

test('files without indent/csno stay valid (columns are optional)', () => {
  const v = validator.validate(parsed(BASE, [
    { packageno: '1', thanno: '1', design: 'D1', yards: '30', warehouse: 'Kano office' },
  ]));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.bales[0].indent, '');
  assert.equal(v.bales[0].csNo, '');
});

test('over-long indent is rejected like other name fields', () => {
  const v = validator.validate(parsed([...BASE, 'indent'], [
    { packageno: '1', thanno: '1', design: 'D1', yards: '30', warehouse: 'Kano office', indent: 'X'.repeat(81) },
  ]));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.column === 'indent'));
});
