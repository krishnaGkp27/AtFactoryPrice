'use strict';

/**
 * usersRepository.findByUserId — duplicate-row resolution (USR-C4 follow-up).
 *
 * Re-onboarding a deactivated user appends a fresh Users row while the prior
 * row stays as an inactive audit trail, so one Telegram ID can have several
 * rows. findByUserId must return the ACTIVE row (else the most recent), not
 * the first — otherwise deactivate sees "already inactive" on a live user.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sheets = require('../../../src/repositories/sheetsClient');
const usersRepo = require('../../../src/repositories/usersRepository');

// Columns: A id,B name,C role,D branch,E access,F status,G created,
//          H departments,I warehouses,J manages,K prefs
function row(id, name, role, status) {
  return [id, name, role, '', '', status, '', 'Sales', 'Lagos', '', ''];
}

function withRows(rows, fn) {
  const orig = sheets.readRange;
  sheets.readRange = async () => rows;
  return Promise.resolve(fn()).finally(() => { sheets.readRange = orig; });
}

test('prefers the ACTIVE row when an inactive audit row precedes it', async () => {
  await withRows([
    row('999', 'Old Name', 'employee', 'inactive'),   // stale audit trail
    row('999', 'New Name', 'marketer', 'active'),      // current record
    row('111', 'Someone', 'employee', 'active'),
  ], async () => {
    const u = await usersRepo.findByUserId('999');
    assert.equal(u.status, 'active');
    assert.equal(u.name, 'New Name');
    assert.equal(u.role, 'marketer');
  });
});

test('returns the most recent row when none are active', async () => {
  await withRows([
    row('999', 'First', 'employee', 'inactive'),
    row('999', 'Second', 'employee', 'inactive'),
  ], async () => {
    const u = await usersRepo.findByUserId('999');
    assert.equal(u.name, 'Second');
    assert.equal(u.status, 'inactive');
  });
});

test('single row behaves normally; missing id returns null', async () => {
  await withRows([row('999', 'Solo', 'employee', 'active')], async () => {
    assert.equal((await usersRepo.findByUserId('999')).name, 'Solo');
    assert.equal(await usersRepo.findByUserId('404'), null);
  });
});

test('reactivate updates the existing row in place (no append)', async () => {
  const origRead = sheets.readRange;
  const origWrite = sheets.updateRange;
  // One inactive row at sheet row 2 (rowIndex = i + 2, i=0).
  sheets.readRange = async () => [row('999', 'Old Name', 'employee', 'inactive')];
  const writes = [];
  sheets.updateRange = async (sheet, range, values) => { writes.push({ range, values }); };
  try {
    const ok = await usersRepo.reactivate('999', { name: 'New Name', role: 'marketer', departments: ['Marketing'], warehouses: ['Lagos', 'Kano'] });
    assert.equal(ok, true);
    const byRange = Object.fromEntries(writes.map((w) => [w.range, w.values]));
    assert.deepEqual(byRange['B2:C2'], [['New Name', 'marketer']]);
    assert.deepEqual(byRange.F2, [['active']]);                   // status reactivated
    assert.deepEqual(byRange['H2:I2'], [['Marketing', 'Lagos,Kano']]); // dept, warehouses
  } finally {
    sheets.readRange = origRead;
    sheets.updateRange = origWrite;
  }
});

test('reactivate returns false when no row exists', async () => {
  const origRead = sheets.readRange;
  sheets.readRange = async () => [];
  try {
    assert.equal(await usersRepo.reactivate('404', { name: 'X' }), false);
  } finally {
    sheets.readRange = origRead;
  }
});
