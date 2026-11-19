'use strict';

/**
 * BKP-4 — "give it a switch inside the sheet itself": a switch's row is put
 * on the Settings sheet when the sheet has none, so the owner can SEE it —
 * and a row that is already there is never touched, whatever it holds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets } = require('../../helpers/controllerHarness');

const fake = createFakeSheets({
  Settings: [['key', 'value', 'updated_at'],
    ['RISK_THRESHOLD', '300', ''],
    ['OFFSITE_BACKUP_IDS', '', ''],          // there, with an empty cell
  ],
});
installFakeSheets(fake);
const settingsRepository = require('../../../src/repositories/settingsRepository');

const rows = () => fake._store.get('Settings').slice(1);

test('a missing switch row is added — value as given, stored as text', async () => {
  assert.equal(await settingsRepository.ensureRow('OFFSITE_BACKUP_ENABLED', 0), true);
  const row = rows().find((r) => r[0] === 'OFFSITE_BACKUP_ENABLED');
  assert.ok(row, 'the row is on the sheet');
  assert.equal(String(row[1]).replace(/^'/, ''), '0');
  assert.ok(row[2], 'with the time it was added');
  const all = await settingsRepository.getAll();
  assert.equal(Number(all.OFFSITE_BACKUP_ENABLED), 0, 'and it reads as OFF');
});

test('a row that is already there is never touched — an empty cell included, a changed value included', async () => {
  assert.equal(await settingsRepository.ensureRow('OFFSITE_BACKUP_IDS', '777,888'), false);
  assert.deepEqual(rows().find((r) => r[0] === 'OFFSITE_BACKUP_IDS'), ['OFFSITE_BACKUP_IDS', '', '']);

  // the owner switches it on; a later boot must not switch it back
  await settingsRepository.set('OFFSITE_BACKUP_ENABLED', 1);
  assert.equal(await settingsRepository.ensureRow('OFFSITE_BACKUP_ENABLED', 0), false);
  assert.equal(Number((await settingsRepository.getAll()).OFFSITE_BACKUP_ENABLED), 1);
  assert.equal(rows().filter((r) => r[0] === 'OFFSITE_BACKUP_ENABLED').length, 1, 'never a second row');
});
