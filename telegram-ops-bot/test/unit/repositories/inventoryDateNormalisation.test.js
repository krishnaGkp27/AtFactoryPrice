'use strict';

/**
 * SDN-2 (owner, 14-Aug-2026) — "Can you make the date format consistent."
 *
 * The owner's screenshot showed column M holding both `28-February-2026`
 * and `2026-08-06`. Neither was a bot bug: the bot writes one ISO day
 * through one door, and Sheets renders each cell through its OWN number
 * format. Because rows are read back as DISPLAYED text, the sheet's
 * cosmetics were deciding what the bot parsed — and every reader compares
 * these as ISO text (`soldDate >= from`, `.slice(0, 10)` day keys, lexical
 * sorts), so the February rows were silently missing from date-windowed
 * reports and keyed the supply statement under "28-Februar".
 *
 * Pinned: the Inventory parser hands every reader ONE ISO day whatever the
 * column displays, so the display format is free to be anything — which is
 * what lets the owner format column M without breaking a single report.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

installFakeSheets(createFakeSheets({}));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));

/** One Inventory row: only the columns this test cares about are filled. */
function row({ pkg = '9037', dateReceived = '', soldTo = '', soldDate = '' }) {
  const r = new Array(23).fill('');
  r[0] = pkg; r[3] = 'D1'; r[4] = '1'; r[5] = '1'; r[6] = '30';
  r[7] = soldDate ? 'sold' : 'available';
  r[8] = 'IDUMOTA';
  r[10] = dateReceived;
  r[11] = soldTo;
  r[12] = soldDate;
  r[17] = `BAL-${pkg}`;
  return r;
}

async function parse(rows) {
  sheets.readRange = async () => rows;
  inventoryRepository.invalidateCache();
  return inventoryRepository.getAll();
}

test('SDN-2: a day-monthname-year cell reads back as the same ISO day as an ISO cell', async () => {
  const all = await parse([
    row({ pkg: 'A', soldTo: 'Qaribullah', soldDate: '28-February-2026' }),
    row({ pkg: 'B', soldTo: 'Qaribullah', soldDate: '2026-08-06' }),
  ]);
  assert.equal(all[0].soldDate, '2026-02-28', 'the owner\'s displayed format normalises');
  assert.equal(all[1].soldDate, '2026-08-06', 'an already-ISO cell is untouched');
});

test('SDN-2: the February rows come back INTO a date window that used to miss them', async () => {
  const all = await parse([
    row({ pkg: 'A', soldTo: 'Qaribullah', soldDate: '28-February-2026' }),
    row({ pkg: 'B', soldTo: 'Qaribullah', soldDate: '2026-08-06' }),
  ]);
  // The shape every sales report uses: an ISO lexical lower bound.
  const from = '2026-01-01';
  const inWindow = all.filter((r) => r.soldDate >= from);
  assert.equal(inWindow.length, 2,
    'before SDN-2 "28-February-2026" sorted BELOW "2026-…" and dropped out of the year');
  // And the day key the supply statement builds.
  assert.equal(all[0].soldDate.slice(0, 10), '2026-02-28', 'not "28-Februar"');
});

test('SDN-2: every shape the sheet can display lands on one ISO day', async () => {
  const shapes = [
    ['28-February-2026', '2026-02-28'],
    ['28 February 2026', '2026-02-28'],
    ['28-Feb-2026', '2026-02-28'],
    ['February 28, 2026', '2026-02-28'],
    ['28/02/2026', '2026-02-28'], // Nigerian DMY, never 2 Feb
    ['2026-02-28', '2026-02-28'],
  ];
  const all = await parse(shapes.map(([display], i) => row({ pkg: `P${i}`, soldTo: 'X', soldDate: display })));
  all.forEach((r, i) => assert.equal(r.soldDate, shapes[i][1], `"${shapes[i][0]}" → ${shapes[i][1]}`));
});

test('SDN-2: column K normalises too — addedAt falls back to it', async () => {
  const all = await parse([row({ pkg: 'A', dateReceived: '15-March-2026' })]);
  assert.equal(all[0].dateReceived, '2026-03-15');
  assert.equal(all[0].addedAt, '2026-03-15',
    'addedAt inherits dateReceived when column S is empty, so it inherits the FIXED one');
});

test('SDN-2: an unreadable date keeps its text — a sold row must never vanish', async () => {
  const all = await parse([row({ pkg: 'A', soldTo: 'Qaribullah', soldDate: 'ask abdul' })]);
  assert.equal(all[0].soldDate, 'ask abdul',
    'blanking it would drop the row from every `soldTo && soldDate` sold-row filter');
  assert.equal(all[0].status, 'sold');
});

test('SDN-2: an empty date stays empty, not a fabricated today', async () => {
  const all = await parse([row({ pkg: 'A' })]);
  assert.equal(all[0].soldDate, '');
  assert.equal(all[0].dateReceived, '');
});
