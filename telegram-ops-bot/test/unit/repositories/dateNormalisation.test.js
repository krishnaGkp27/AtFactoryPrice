'use strict';

/**
 * DATE-N1 — the ATT-DATE1 bug class, closed at the other three repositories
 * that compare raw sheet date cells: Transactions (sales reports), BranchOps
 * (daily branch dedup) and Ledger (money — the daily ledger view).
 *
 * Sheets writes go out USER_ENTERED, so an ISO date becomes a date cell and
 * comes back locale-formatted ("28/07/2026"). Any exact or lexical compare
 * against ISO then silently finds nothing. Attendance hit this live on
 * 27-Jul; these three had the identical shape and were only safe while
 * their sheets happened to hold text-formatted dates.
 *
 * Same technique as attendanceDateFormat.test.js: a fake sheet that MIMICS
 * the coercion, because the standard fakeSheets echoes writes back verbatim
 * and is structurally blind to this class.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '../../..');

/** Load a repository against a sheet whose stored rows are supplied raw. */
function loadRepo(relPath, rows) {
  const origRequire = Module.prototype.require;
  Module.prototype.require = function patched(id) {
    if (id.endsWith('sheetsClient')) {
      return {
        readRange: async (_s, range) => (String(range).startsWith('A1') ? [['h']] : rows),
        appendRows: async () => {},
        updateRange: async () => {},
      };
    }
    return origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve(path.join(ROOT, relPath))];
  const repo = require(path.join(ROOT, relPath));
  Module.prototype.require = origRequire;
  return repo;
}

test('Transactions: a locale-formatted SalesDate still lands in the ISO range filter', async () => {
  // Row shape A2:R — col J (index 9) is salesDate, exactly as Sheets returns it.
  const row = ['2026-07-28T08:00:00.000Z', '4242', 'sell_package', '77016', '5', '60',
    'available', 'sold', 'approved', '28/07/2026', 'IDUMOTA', 'CJE', 'Yarima', 'Cash', 'R-1', '1500', '90000', ''];
  const repo = loadRepo('src/repositories/transactionsRepository.js', [row]);
  const hits = await repo.getBySalesDateRange('2026-07-01', '2026-07-31');
  assert.equal(hits.length, 1, 'the sale is inside July whatever format Sheets chose');
  assert.equal(hits[0].salesDate, '2026-07-28', 'parsed rows expose ISO downstream');
});

test('BranchOps: findByBranchDate matches a coerced date — the daily dedup depends on it', async () => {
  // Row shape A2:O — col B (index 1) is date.
  const row = ['BO-1', '28/07/2026', 'Kano', 'expense', 'Fuel', '5000', '', '', '', '', '', '', '', '', ''];
  const repo = loadRepo('src/repositories/branchOpsLogRepository.js', [row]);
  const byDate = await repo.findByDate('2026-07-28');
  assert.equal(byDate.length, 1, 'findByDate must see the row');
  const byBranch = await repo.findByBranchDate('Kano', '2026-07-28');
  assert.equal(byBranch.length, 1, 'findByBranchDate is the duplicate-day guard');
});

test('Ledger: findByDateRange spans coerced dates — this is the money view', async () => {
  // Row shape — col C (index 2) is date.
  const row = ['L-1', 'JRN', '28/07/2026', '1200', 'DR', '90000', 'Sale to CJE', 'R-1'];
  const repo = loadRepo('src/repositories/ledgerRepository.js', [row]);
  const hits = await repo.findByDateRange('2026-07-28', '2026-07-28');
  assert.equal(hits.length, 1, 'the daily ledger view must include the entry');
  assert.equal(hits[0].date, '2026-07-28');
});

test('ISO passthrough: sheets that store text dates behave exactly as before', async () => {
  const row = ['2026-07-28T08:00:00.000Z', '4242', 'sell_package', '77016', '5', '60',
    'available', 'sold', 'approved', '2026-07-28', 'IDUMOTA', 'CJE', 'Yarima', 'Cash', 'R-1', '1500', '90000', ''];
  const repo = loadRepo('src/repositories/transactionsRepository.js', [row]);
  const hits = await repo.getBySalesDateRange('2026-07-28', '2026-07-28');
  assert.equal(hits.length, 1, 'normalising an ISO date is a no-op');
});
