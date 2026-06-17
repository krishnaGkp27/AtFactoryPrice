'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fr = require('../../../src/services/fieldRoles');

test('classify()', async (t) => {
  await t.test('recognizes marketer / salesman (case-insensitive, trimmed)', () => {
    assert.equal(fr.classify('marketer'), 'marketer');
    assert.equal(fr.classify('  Salesman '), 'salesman');
  });

  await t.test('returns null for other roles', () => {
    for (const r of ['admin', 'employee', 'manager', '', null, undefined]) {
      assert.equal(fr.classify(r), null);
    }
  });
});

test('isFieldRole()', () => {
  assert.equal(fr.isFieldRole('marketer'), true);
  assert.equal(fr.isFieldRole('salesman'), true);
  assert.equal(fr.isFieldRole('admin'), false);
  assert.equal(fr.isFieldRole('employee'), false);
});

test('canSeePrice()', async (t) => {
  await t.test('only the salesman sees price', () => {
    assert.equal(fr.canSeePrice('salesman'), true);
    assert.equal(fr.canSeePrice('SALESMAN'), true);
  });

  await t.test('marketer and others do not', () => {
    for (const r of ['marketer', 'admin', 'employee', '']) {
      assert.equal(fr.canSeePrice(r), false);
    }
  });
});
