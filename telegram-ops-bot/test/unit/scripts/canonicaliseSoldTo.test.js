'use strict';

/**
 * ISC-1 Phase 2b — the guarded one-off that rewrites Inventory!L to the
 * registry's spelling, driven against a fake workbook with no credentials.
 *
 * Pinned:
 *  - dry-run writes nothing at all;
 *  - --commit writes ONLY column L, only the planned rows, nothing else
 *    on those rows;
 *  - a cell that changed between the plan and the write is skipped and
 *    reported (the CUS-ID1 guard), the rest still land;
 *  - a blocked cluster contributes no write;
 *  - --cluster narrows, an unknown name is a hard failure, --map replaces
 *    the ruling and a bad map file stops the run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const script = require(path.join(__dirname, '../../../scripts/canonicalise-sold-to'));

const HEADERS = inventoryRepository.HEADERS;

/** One Inventory row (23 cells) — only the columns the script reads or must leave alone are meaningful. */
function inv(pkg, soldTo, soldDate = '2026-04-22') {
  const r = new Array(HEADERS.length).fill('');
  r[0] = pkg; r[1] = 'SA/1326'; r[3] = '44200'; r[4] = '3'; r[5] = '1'; r[6] = '30';
  r[7] = soldTo ? 'sold' : 'available'; r[8] = 'Lagos'; r[9] = '2500'; r[10] = '2026-02-24';
  r[11] = soldTo; r[12] = soldTo ? soldDate : ''; r[15] = '2026-04-22T10:00:00.000Z'; r[21] = 'Mar26';
  return r;
}

function cust(id, name, status = 'Active', aliases = []) {
  return [id, name, '', '', 'Retail', '0', '0', 'COD', '', status, '2026-03-01T00:00:00.000Z',
    '2026-03-01T00:00:00.000Z', JSON.stringify(aliases)];
}

const CUSTOMER_HEADERS = ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit',
  'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases'];

function workbook({ merged = true } = {}) {
  return {
    Inventory: [
      [...HEADERS],
      inv('6001', 'Awunawu'),        // row 2 — already canonical
      inv('6002', 'Awurawu'),        // row 3
      inv('6003', 'awunawu'),        // row 4
      inv('6004', 'madam oshodi'),   // row 5
      inv('6005', 'Ketu madam'),     // row 6 — never touched
      inv('6006', ''),               // row 7 — available
    ],
    Customers: [
      CUSTOMER_HEADERS,
      cust('CUST-A', 'Awunawu', 'Active', merged ? ['Awurawu'] : []),
      cust('CUST-O', 'Alhaja Oshodi', 'Active', merged ? ['madam oshodi', 'oshodi madam', 'Oshodi alaja'] : []),
      cust('CUST-K', 'Ketu madam'),
    ],
  };
}

function seed(opts) {
  const fake = createFakeSheets(workbook(opts));
  installFakeSheets(fake);
  inventoryRepository.invalidateCache();
  customersRepository.invalidateCache();
  return fake;
}

const snapshot = (fake) => JSON.stringify(fake._store.get('Inventory'));
const colL = (fake) => fake._store.get('Inventory').slice(1).map((r) => r[11]);

test('dry-run: the plan is built and the workbook is untouched', async () => {
  const fake = seed();
  const before = snapshot(fake);
  const result = await script.plan(script.loadClusters(null));
  assert.deepEqual(result.plan.map((p) => `${p.rowIndex}:${p.current}>${p.next}`),
    ['3:Awurawu>Awunawu', '4:awunawu>Awunawu', '5:madam oshodi>Alhaja Oshodi']);
  assert.equal(snapshot(fake), before, 'reading never writes');
  const text = script.render(result);
  assert.match(text, /Cluster "Awunawu" → Customers row 2 "Awunawu" \(CUST-A\)\s+READY/);
  assert.match(text, /row 3\s+L: "Awurawu"\s+→\s+"Awunawu"/);
  assert.match(text, /"Awunawu" ×1 \(already canonical\)/);
});

test('--commit writes only column L of the planned rows and nothing else', async () => {
  const fake = seed();
  const rowsBefore = fake._store.get('Inventory').map((r) => [...r]);
  const result = await script.plan(script.loadClusters(null));
  const { written, skipped } = await script.apply(result.plan);

  assert.equal(written, 3);
  assert.deepEqual(skipped, []);
  assert.deepEqual(colL(fake), ['Awunawu', 'Awunawu', 'Awunawu', 'Alhaja Oshodi', 'Ketu madam', '']);
  const rowsAfter = fake._store.get('Inventory');
  rowsAfter.forEach((r, i) => r.forEach((cell, j) => {
    if (j === 11) return;
    assert.equal(cell, rowsBefore[i][j], `row ${i + 1} col ${j + 1} untouched`);
  }));
  assert.equal(fake._store.get('Customers').length, 4, 'no Customers row created');
  assert.deepEqual(fake._store.get('Customers')[1], cust('CUST-A', 'Awunawu', 'Active', ['Awurawu']), 'no Customers row edited');
});

test('the guard: a cell that moved between plan and write is skipped, the rest still land', async () => {
  const fake = seed();
  const result = await script.plan(script.loadClusters(null));
  // Someone corrects row 3 by hand while the dry-run is being read.
  fake._store.get('Inventory')[2][11] = 'Somebody else';
  const { written, skipped } = await script.apply(result.plan);
  assert.equal(written, 2);
  assert.deepEqual(skipped, [{ rowIndex: 3, current: 'Awurawu', live: 'Somebody else' }]);
  assert.deepEqual(colL(fake), ['Awunawu', 'Somebody else', 'Awunawu', 'Alhaja Oshodi', 'Ketu madam', '']);
});

test('a blocked cluster contributes no write; the ready one still does', async () => {
  const fake = seed({ merged: false }); // no aliases yet — Merge Customers has not run
  const result = await script.plan(script.loadClusters(null));
  const [awunawu, oshodi] = result.clusters;
  assert.equal(awunawu.status, 'blocked', '"Awurawu" resolves to nobody');
  assert.equal(oshodi.status, 'blocked');
  assert.match(script.render(result), /BLOCKED — run Merge Customers first \(CUS-1\)/);
  const { written } = await script.apply(result.plan);
  assert.equal(written, 0);
  assert.deepEqual(colL(fake), ['Awunawu', 'Awurawu', 'awunawu', 'madam oshodi', 'Ketu madam', '']);

  // Case-only "awunawu" alone would resolve — but a cluster is one ruling.
  const one = script.selectClusters([{ canonical: 'Awunawu', variants: ['awunawu'] }], 'awunawu');
  const narrowed = await script.plan(one);
  assert.equal(narrowed.clusters[0].status, 'ready');
  assert.equal((await script.apply(narrowed.plan)).written, 1);
  assert.equal(colL(fake)[2], 'Awunawu');
});

test('apply with an empty plan writes nothing', async () => {
  const fake = seed();
  const before = snapshot(fake);
  assert.deepEqual(await script.apply([]), { written: 0, skipped: [] });
  assert.equal(snapshot(fake), before);
});

test('--cluster narrows to one canonical; an unknown name is a hard failure', () => {
  const clusters = script.loadClusters(null);
  assert.deepEqual(script.selectClusters(clusters, 'awunawu').map((c) => c.canonical), ['Awunawu']);
  assert.throws(() => script.selectClusters(clusters, 'Ketu madam'), /not in the map/);
});

test('--map replaces the ruling; a bad file or a bad shape stops the run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isc1-map-'));
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify([{ canonical: 'Ketu madam', variants: ['ketu police Man'] }]));
  assert.deepEqual(script.loadClusters(good), [{ canonical: 'Ketu madam', variants: ['ketu police Man'] }]);

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify([{ canonical: 'X', variants: [] }]));
  assert.throws(() => script.loadClusters(bad), /variants must be/);
  fs.writeFileSync(bad, '{not json');
  assert.throws(() => script.loadClusters(bad), /--map .*bad\.json/);
  assert.throws(() => script.loadClusters(path.join(dir, 'missing.json')), /ENOENT|no such file/);
});

test('parseArgs: the three switches, both spellings; anything else is refused', () => {
  assert.deepEqual(script.parseArgs(['node', 's']), { commit: false, mapFile: null, cluster: null });
  assert.deepEqual(script.parseArgs(['node', 's', '--commit', '--map', 'm.json', '--cluster', 'Awunawu']),
    { commit: true, mapFile: 'm.json', cluster: 'Awunawu' });
  assert.deepEqual(script.parseArgs(['node', 's', '--map=m.json', '--cluster=Awunawu']),
    { commit: false, mapFile: 'm.json', cluster: 'Awunawu' });
  assert.throws(() => script.parseArgs(['node', 's', '--comit']), /unknown argument/);
});

test('parseArgs: a dangling --map or --cluster is a hard failure, never a silent fall-back', () => {
  // Under --commit the fall-back (default map / every cluster) would widen
  // a live write past what was typed.
  assert.throws(() => script.parseArgs(['node', 's', '--commit', '--map']), /--map needs a value/);
  assert.throws(() => script.parseArgs(['node', 's', '--commit', '--cluster']), /--cluster needs a value/);
  assert.throws(() => script.parseArgs(['node', 's', '--map', '--commit']), /--map needs a value/);
  assert.throws(() => script.parseArgs(['node', 's', '--cluster', '--commit']), /--cluster needs a value/);
  assert.throws(() => script.parseArgs(['node', 's', '--map=']), /--map needs a value/);
  assert.throws(() => script.parseArgs(['node', 's', '--cluster=', '--commit']), /--cluster needs a value/);
  assert.throws(() => script.parseArgs(['node', 's', '--cluster', '  ']), /--cluster needs a value/);
});

test('render: a cell already spelled as the register (map canonical differs) is tallied, not "NOT in the ruling"', () => {
  const canon = require(path.join(SRC, 'services/soldToCanonicaliser'));
  const rows = [
    { rowIndex: 300, soldTo: 'Alhaja Oshodi' }, { rowIndex: 301, soldTo: 'Alhaja oshodi' },
    { rowIndex: 302, soldTo: 'OSHODI MADAM' },
  ];
  const register = [{ rowIndex: 4, customer_id: 'CUST-O', name: 'Alhaja Oshodi', status: 'Active',
    aliases: ['madam oshodi', 'oshodi madam', 'Oshodi alaja'] }];
  const text = script.render(canon.buildPlan(rows, [canon.DEFAULT_CLUSTERS[1]], register));
  assert.match(text, /"Alhaja Oshodi" ×1 \(already canonical\)/);
  assert.match(text, /1 cell\(s\) to rewrite, 1 already canonical:/);
  assert.match(text, /row 301\s+L: "Alhaja oshodi"\s+→\s+"Alhaja Oshodi"/);
  assert.ok(!/row 300 .*NOT in the ruling/.test(text), text);
  assert.match(text, /row 302\s+"OSHODI MADAM" — NOT in the ruling/, 'a casing nobody ruled on is still reported');
});

test('main: dry-run then commit end to end, with the one-line summary', async () => {
  const fake = seed();
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const dry = await script.main(['node', 's']);
    assert.deepEqual(dry, { planned: 3, written: 0, skipped: [] });
    assert.deepEqual(colL(fake), ['Awunawu', 'Awurawu', 'awunawu', 'madam oshodi', 'Ketu madam', '']);
    assert.ok(lines.some((l) => l === 'SUMMARY planned=3 written=0 skipped=0'), lines.join('\n'));

    const wet = await script.main(['node', 's', '--commit', '--cluster', 'Awunawu']);
    assert.equal(wet.written, 2);
    assert.ok(lines.some((l) => l === 'SUMMARY planned=2 written=2 skipped=0'), lines.join('\n'));
    assert.deepEqual(colL(fake), ['Awunawu', 'Awunawu', 'Awunawu', 'madam oshodi', 'Ketu madam', '']);
  } finally {
    console.log = orig;
  }
});
