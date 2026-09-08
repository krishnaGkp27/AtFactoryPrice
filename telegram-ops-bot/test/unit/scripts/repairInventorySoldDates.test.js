'use strict';

/**
 * ISC-1 Phase 2a — the sold-date repair SCRIPT, driven offline against a
 * fake sheet. The planner is pinned in test/unit/services/soldDateRepair;
 * this file pins the door: dry-run writes nothing, --commit writes ISO
 * days to column M and nowhere else, the CUS-ID1 re-read guard skips a
 * cell the sheet moved under it, the cache is dropped after a write, every
 * written cell is read back FORMATTED and one that no longer reads as the
 * planned day is reported loudly with exit code 1, and the rehearsal
 * filters reach the plan.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

installFakeSheets(createFakeSheets({}));
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const script = require(path.join(__dirname, '../../../scripts/repair-inventory-sold-dates'));

function row({ pkg = '1234', design = '44200', than = 1, status = 'sold', soldTo = 'madam oshodi', soldDate = '' } = {}) {
  return [pkg, 'SA/1326', '1', design, '4', than, 30, status, 'Lagos', 0, '2026-02-24', soldTo, soldDate];
}

/** The §2a shapes, one row each, starting at sheet row 2. */
const FORMATTED = [
  row({ pkg: '1234', than: 1, soldDate: 'cashmere 12-February-2026' }),                          // row 2 (a)
  row({ pkg: '1234', than: 2, soldTo: 'Madam motunrayo', soldDate: 'cashmere 2026-07-27' }),    // row 3 (a)
  row({ pkg: '6001', design: '9037', than: 1, soldTo: 'CJE', soldDate: '07 April 2026' }),      // row 4 (b)
  row({ pkg: '6001', design: '9037', than: 2, soldTo: 'CJE', soldDate: '22-April-2026' }),      // row 5 date-typed
  row({ pkg: '6001', design: '9037', than: 3, status: 'available', soldTo: '', soldDate: '' }), // row 6 available
  row({ pkg: '6002', design: '9037', than: 1, soldTo: 'ABBA', soldDate: 'sometime soon' }),     // row 7 garbage
];
const UNFORMATTED = [
  ['cashmere 12-February-2026'], ['cashmere 2026-07-27'], ['07 April 2026'], [46134], [], ['sometime soon'],
];

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** What a written cell shows once scripts/format-date-columns.js (spec §4 Phase 0a) has given column M its dd-mmmm-yyyy look. */
function renderAs0a(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}-${MONTH_NAMES[parseInt(m, 10) - 1]}-${y}`;
}
/** A Sheets date serial (days since 1899-12-30) — only its TYPE matters to the script. */
function serial(iso) {
  const [y, m, d] = iso.split('-').map((v) => parseInt(v, 10));
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

/**
 * A fake Inventory. Serves the plan read (A2:M), the guard re-read (with
 * optionally different `fresh` rows) and the post-write read-back (M2:M,
 * formatted and unformatted). A batch write lands the way Sheets would
 * land it: the cell becomes a real date (a serial number) shown through
 * `render(iso, rowIndex)` — the 0a look by default — unless `plainText`
 * names the row, in which case the cell keeps its text format and stays
 * a string. Records every write and every cache drop.
 */
function stub({
  formatted = FORMATTED, unformatted = UNFORMATTED, fresh, freshUnformatted, render = renderAs0a, plainText = new Set(),
} = {}) {
  const state = { formatted: formatted.map((r) => [...r]), unformatted: unformatted.map((r) => [...r]) };
  const calls = { writes: [], invalidations: 0, reads: 0, unformattedReads: 0, readBacks: 0, storedReadBacks: 0 };
  sheets.readRange = async (name, range) => {
    assert.equal(name, 'Inventory');
    if (range === 'M2:M') { calls.readBacks += 1; return state.formatted.map((r) => [r[12]]); }
    assert.equal(range, 'A2:M');
    calls.reads += 1;
    if (calls.reads > 1 && fresh) state.formatted = fresh.map((r) => [...r]);
    return state.formatted.map((r) => [...r]);
  };
  sheets.readRangeUnformatted = async (name, range) => {
    assert.equal(name, 'Inventory');
    assert.equal(range, 'M2:M');
    calls.unformattedReads += 1;
    if (calls.writes.length) calls.storedReadBacks += 1;
    else if (calls.unformattedReads > 1 && freshUnformatted) state.unformatted = freshUnformatted.map((r) => [...r]);
    return state.unformatted.map((r) => [...r]);
  };
  sheets.batchUpdateRanges = async (name, updates) => {
    calls.writes.push({ name, updates });
    for (const u of updates) {
      const rowIndex = parseInt(u.range.slice(1), 10);
      const iso = u.values[0][0];
      const i = rowIndex - 2;
      state.formatted[i][12] = plainText.has(rowIndex) ? iso : render(iso, rowIndex);
      state.unformatted[i] = [plainText.has(rowIndex) ? iso : serial(iso)];
    }
  };
  inventoryRepository.invalidateCache = () => { calls.invalidations += 1; };
  return calls;
}

const quiet = () => {};

test('dry-run prints the plan and writes absolutely nothing', async () => {
  const calls = stub();
  const lines = [];
  const out = await script.run({ commit: false, log: (l) => lines.push(l) });

  assert.deepEqual(out.plan.map((e) => [e.rowIndex, e.proposed, e.reason]),
    [[2, '2026-02-12', 'a'], [3, '2026-07-27', 'a'], [4, '2026-04-07', 'b']]);
  assert.deepEqual(out.reported.map((r) => r.rowIndex), [7]);
  assert.deepEqual(out.written, []);
  assert.deepEqual(calls.writes, []);
  assert.equal(calls.invalidations, 0);
  assert.equal(calls.reads, 1, 'no guard re-read on a dry-run');
  assert.equal(calls.readBacks, 0, 'nothing written, nothing to read back');

  const text = lines.join('\n');
  assert.match(text, /DRY-RUN/);
  assert.match(text, /row 2 .*44200\/1234 #1 .*madam oshodi .*"cashmere 12-February-2026" .*→ 2026-02-12 .*\(a\)/);
  assert.match(text, /row 4 .*9037\/6001 #1 .*CJE .*"07 April 2026" .*→ 2026-04-07 .*\(b\)/);
  assert.match(text, /row 7 .*"sometime soon" .*— unparseable/);
  assert.match(lines[lines.length - 1], /^\nISC-1 sold-date repair: planned 3 \/ written 0 \/ skipped 0 · 1 reported, not planned$/);
});

test('--commit writes the ISO day to column M of the planned rows and nowhere else, then drops the cache', async () => {
  const calls = stub();
  const lines = [];
  const out = await script.run({ commit: true, log: (l) => lines.push(l) });

  assert.equal(calls.writes.length, 1, 'one batch');
  assert.equal(calls.writes[0].name, 'Inventory');
  assert.deepEqual(calls.writes[0].updates, [
    { range: 'M2', values: [['2026-02-12']] },
    { range: 'M3', values: [['2026-07-27']] },
    { range: 'M4', values: [['2026-04-07']] },
  ]);
  calls.writes[0].updates.forEach((u) => assert.match(u.range, /^M\d+$/, 'only column M, one cell each'));
  assert.equal(calls.invalidations, 1);
  assert.equal(out.written.length, 3);
  assert.deepEqual(out.skipped, []);
  assert.equal(calls.reads, 2, 'the guard re-reads immediately before writing');
  assert.equal(calls.readBacks, 1, 'the written cells are read back FORMATTED once');
  assert.equal(calls.storedReadBacks, 1, '…and unformatted, to know Sheets stored a date');
  assert.deepEqual(out.mismatched, []);
  assert.deepEqual(out.stillText, []);
  assert.match(lines.join('\n'), /✅ Wrote 3 SoldDate cell\(s\) in column M; 3 read back as the planned day/);
  assert.match(lines[lines.length - 1], /planned 3 \/ written 3 \/ skipped 0 · 1 reported, not planned$/);
});

test('after the write each cell is read back FORMATTED: a per-cell format the bot cannot read is reported loudly, exit 1', async () => {
  // Two invisible per-cell formats, the two ways they bite: row 2 carries
  // dd/mm/yy (the normaliser needs a 4-digit year → reads nothing — the
  // sale drops out of every window, the very defect being repaired); row 4
  // carries m/d/yyyy (read DMY as 4 July — silently the wrong day). Row 3
  // has the 0a look and is fine.
  const render = (iso, rowIndex) => {
    if (rowIndex === 2) return '12/02/26';
    if (rowIndex === 4) return '4/7/2026';
    return renderAs0a(iso);
  };
  const calls = stub({ render });
  const lines = [];
  const out = await script.run({ commit: true, log: (l) => lines.push(l) });

  assert.equal(calls.writes[0].updates.length, 3, 'the write itself happened — the plan was sound');
  assert.deepEqual(out.mismatched.map((m) => [m.rowIndex, m.proposed, m.display, m.readBack]), [
    [2, '2026-02-12', '12/02/26', null],
    [4, '2026-04-07', '4/7/2026', '2026-07-04'],
  ]);
  assert.deepEqual(out.written.map((e) => e.rowIndex), [2, 3, 4]);

  const text = lines.join('\n');
  assert.match(text, /⚠️ Wrote 3 SoldDate cell\(s\) in column M; 1 read back as the planned day/);
  assert.match(text, /❌ 2 written cell\(s\) do NOT read back as the planned day/);
  assert.match(text, /row 2 .*"cashmere 12-February-2026" .*→ wrote 2026-02-12, now displays "12\/02\/26", reads back as nothing/);
  assert.match(text, /row 4 .*"07 April 2026" .*→ wrote 2026-04-07, now displays "4\/7\/2026", reads back as 2026-07-04/);
  assert.match(text, /format-date-columns\.js --commit/);
  assert.match(lines[lines.length - 1], /planned 3 \/ written 3 \/ skipped 0 · 1 reported, not planned · 2 READ BACK WRONG$/);

  // The door reports it in the exit code, so a shell script cannot miss it.
  stub({ render });
  assert.equal(await script.main(['node', 'x', '--commit'], quiet), 1);
  stub();
  assert.equal(await script.main(['node', 'x', '--commit'], quiet), 0);
  stub({ render });
  assert.equal(await script.main(['node', 'x'], quiet), 0, 'a dry-run writes nothing, so nothing can read back wrong');
});

test('a cell Sheets still stores as TEXT after the write is a warning with the 0a remedy, not a failure', async () => {
  // A plain-text number format makes USER_ENTERED keep the string. The bot
  // reads the right day (the ISO string), a date filter still cannot.
  const calls = stub({ plainText: new Set([4]) });
  const lines = [];
  const out = await script.run({ commit: true, log: (l) => lines.push(l) });

  assert.deepEqual(out.mismatched, []);
  assert.deepEqual(out.stillText.map((t) => [t.rowIndex, t.display, t.storedAsDate]), [[4, '2026-04-07', false]]);
  assert.equal(calls.readBacks, 1);
  const text = lines.join('\n');
  assert.match(text, /⚠️ 1 written cell\(s\) are still stored as TEXT/);
  assert.match(text, /row 4 .*9037\/6001 #1 .*wrote 2026-04-07, stored as text/);
  assert.match(text, /format-date-columns\.js --commit/);
  assert.match(lines[lines.length - 1], /· 1 still text$/);
  stub({ plainText: new Set([4]) });
  assert.equal(await script.main(['node', 'x', '--commit'], quiet), 0);
});

test('the guard SKIPS a cell the sheet moved under the plan, and still writes the rest', async () => {
  // Between the plan and the write: row 3 was fixed by hand into a real
  // date, and row 2 now belongs to a different bale (a row was re-keyed).
  const fresh = FORMATTED.map((r) => [...r]);
  fresh[1] = row({ pkg: '1234', than: 2, soldTo: 'Madam motunrayo', soldDate: '27-July-2026' });
  fresh[0] = row({ pkg: '9999', than: 1, soldDate: 'cashmere 12-February-2026' });
  const freshUnformatted = UNFORMATTED.map((r) => [...r]);
  freshUnformatted[1] = [46230];

  const calls = stub({ fresh, freshUnformatted });
  const lines = [];
  const out = await script.run({ commit: true, log: (l) => lines.push(l) });

  assert.deepEqual(calls.writes[0].updates, [{ range: 'M4', values: [['2026-04-07']] }]);
  assert.deepEqual(out.skipped.map((s) => s.rowIndex), [2, 3]);
  assert.match(out.skipped[0].why, /packageNo now reads "9999"/);
  assert.match(out.skipped[1].why, /SoldDate now reads "27-July-2026"/);
  assert.match(lines.join('\n'), /row 2: SKIPPED/);
  assert.match(lines[lines.length - 1], /planned 3 \/ written 1 \/ skipped 2/);
  assert.equal(calls.invalidations, 1);
  assert.equal(calls.readBacks, 1, 'the one written cell is still read back');
  assert.deepEqual(out.mismatched, []);
});

test('a date-typed cell is never written, even though its display normalises', async () => {
  const calls = stub();
  await script.run({ commit: true, log: quiet });
  assert.ok(!calls.writes[0].updates.some((u) => u.range === 'M5'), 'row 5 (a real date) untouched');
});

test('with nothing to plan, --commit neither writes nor drops the cache', async () => {
  const calls = stub({ formatted: [FORMATTED[3], FORMATTED[4]], unformatted: [UNFORMATTED[3], UNFORMATTED[4]] });
  const out = await script.run({ commit: true, log: quiet });
  assert.deepEqual(out.plan, []);
  assert.deepEqual(calls.writes, []);
  assert.equal(calls.invalidations, 0);
  assert.equal(calls.reads, 1);
  assert.equal(calls.readBacks, 0);
});

test('rehearsal filters reach the plan: --design and --rows', async () => {
  stub();
  const byDesign = await script.run({ commit: false, design: '44200', log: quiet });
  assert.deepEqual(byDesign.plan.map((e) => e.rowIndex), [2, 3]);

  stub();
  const byRows = await script.run({ commit: false, rows: new Set([4, 5, 6, 7]), log: quiet });
  assert.deepEqual(byRows.plan.map((e) => e.rowIndex), [4]);
  assert.deepEqual(byRows.reported.map((r) => r.rowIndex), [7]);
});

test('parseArgs: --commit, --rows 12,13-40, --design 44200; an unknown flag is refused', () => {
  const a = script.parseArgs(['node', 'x', '--commit', '--rows', '12,13-40', '--design', '44200']);
  assert.equal(a.commit, true);
  assert.equal(a.rows.size, 29);
  assert.equal(a.design, '44200');
  const eq = script.parseArgs(['node', 'x', '--rows=2-3', '--design=9037']);
  assert.deepEqual([...eq.rows], [2, 3]);
  assert.equal(eq.design, '9037');
  assert.deepEqual(script.parseArgs(['node', 'x']), { commit: false, rows: null, design: null });
  assert.throws(() => script.parseArgs(['node', 'x', '--comit']), /unknown argument/);
  assert.throws(() => script.parseArgs(['node', 'x', '--design']), /no design given/);
});
