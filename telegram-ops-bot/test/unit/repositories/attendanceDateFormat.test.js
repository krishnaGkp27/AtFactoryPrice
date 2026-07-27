'use strict';

/**
 * ATT-DATE1 — attendance rows must be findable after Google Sheets has
 * reformatted their date (reported live 27-Jul: "Yarima has marked
 * attendance but I cannot see it").
 *
 * Writes go out with valueInputOption USER_ENTERED, so Sheets PARSES
 * "2026-07-27" into a real date cell and hands it back FORMATTED in the
 * spreadsheet's locale — "27/07/2026". Every attendance read compared that
 * raw cell to an ISO string, so the lookups returned nothing while the row
 * sat in the sheet in plain sight.
 *
 * The whole existing test suite is blind to this class of bug because the
 * fake sheets helper echoes back exactly what was written — only a fake that
 * MIMICS Google's coercion can catch it. That is what this file does.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '../../..');

/**
 * Load attendanceRepository against a sheet that behaves like Google:
 * an ISO date string written in becomes a locale-formatted date coming out.
 * @param {boolean} coerce whether the fake sheet reformats dates
 */
function loadRepoWithSheet(coerce) {
  const store = [];
  const origRequire = Module.prototype.require;
  Module.prototype.require = function patched(id) {
    if (id.endsWith('sheetsClient')) {
      return {
        readRange: async (_s, range) => (range.startsWith('A1') ? [['date']] : store),
        appendRows: async (_s, rows) => {
          for (const r of rows) {
            const c = [...r];
            if (coerce && /^\d{4}-\d{2}-\d{2}$/.test(c[0])) {
              const [y, m, d] = c[0].split('-');
              c[0] = `${d}/${m}/${y}`; // what Sheets actually returns
            }
            store.push(c);
          }
        },
        updateRange: async () => {},
      };
    }
    return origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve(path.join(ROOT, 'src/repositories/attendanceRepository'))];
  const repo = require(path.join(ROOT, 'src/repositories/attendanceRepository'));
  Module.prototype.require = origRequire;
  return repo;
}

const MARK = {
  date: '2026-07-27',
  telegram_id: '4242',
  employee_name: 'Yarima',
  status: 'present',
  location: 'Kano Office',
};

test('a date reformatted by Sheets is still found by getByDate', async () => {
  const repo = loadRepoWithSheet(true);
  await repo.append(MARK);
  const rows = await repo.getByDate('2026-07-27');
  assert.equal(rows.length, 1, 'the row is in the sheet — the admin view must see it');
  assert.equal(rows[0].employee_name, 'Yarima');
});

test('findByDateUser survives reformatting — or the user can mark twice', async () => {
  const repo = loadRepoWithSheet(true);
  await repo.append(MARK);
  const found = await repo.findByDateUser('2026-07-27', '4242');
  assert.ok(found, 'this lookup is also the "already logged today" guard');
  assert.equal(found.status, 'present');
});

test('getRange spans reformatted dates', async () => {
  const repo = loadRepoWithSheet(true);
  await repo.append(MARK);
  const rows = await repo.getRange('2026-07-01', '2026-07-31');
  assert.equal(rows.length, 1, 'monthly attendance reports must include it');
});

test('parsed rows always expose ISO, whatever the sheet returned', async () => {
  const repo = loadRepoWithSheet(true);
  await repo.append(MARK);
  const all = await repo.getAll();
  assert.equal(all[0].date, '2026-07-27', 'callers can rely on ISO downstream');
});

test('a sheet that does NOT reformat still works — normalising is a no-op on ISO', async () => {
  const repo = loadRepoWithSheet(false);
  await repo.append(MARK);
  assert.equal((await repo.getByDate('2026-07-27')).length, 1);
  assert.equal((await repo.getAll())[0].date, '2026-07-27');
});

test('a caller passing a non-ISO date still matches', async () => {
  const repo = loadRepoWithSheet(true);
  await repo.append(MARK);
  assert.equal((await repo.getByDate('27/07/2026')).length, 1,
    'the query side is normalised too, not just the stored side');
});
