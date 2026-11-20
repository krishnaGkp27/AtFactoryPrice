'use strict';
// CARD-8 — on the return card a bale is ONE line when EVERY than of it is on
// the return for one buyer, however it was typed; the rule is the rule-6c
// labeller's own, so the header, the buyer line and the goods lines agree.
// The buyer line says when the goods were sold. A waiting row from before
// CARD-8 is filled in from the live sheet; a decided record never is.
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const SRC = path.join(__dirname, '..', '..', '..', 'src');
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: 'Kano office' });
const { _internals: { loadLine, buildActionJSON } } = require(path.join(SRC, 'flows/returnBundleFlow'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const unitDisplay = require(path.join(SRC, 'services/unitDisplayService'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const designAssets = require(path.join(SRC, 'repositories/designAssetsRepository'));
const accounting = require(path.join(SRC, 'services/accountingService'));

designAssets.findActive = async () => null;
designAssets.findLatest = async () => null;
accounting.getCustomerLedger = async () => ({ outstandingAsOfToday: 500000 });

const row = (pkg, than, status, soldTo, extra = {}) => ({
  packageNo: pkg, thanNo: String(than), status, soldTo, yards: 30, shade: extra.shade || 'BLACK',
  design: extra.design || '44200', warehouse: extra.warehouse || 'IDUMOTA', arrivalBatch: 'Jul26',
  pricePerYard: 1000, baleUid: `U-${pkg}-${than}`, soldDate: soldTo ? (extra.day == null ? '2026-11-02' : extra.day) : '',
});
const SHEET = [
  ...[1, 2, 3, 4, 5].map((t) => row('631', t, 'sold', 'solder madam')),
  ...[1, 2, 3].map((t) => row('614', t, 'sold', 'solder madam', { day: '2026-11-09' })),
  ...[1, 2, 3].map((t) => row('640', t, 'sold', 'solder madam')), row('640', 4, 'available', ''),
  ...[1, 2].map((t) => row('650', t, 'sold', 'Kafaya')), row('650', 3, 'sold', 'ABBA'),
  row('660', 1, 'sold', 'Kafaya', { shade: 'BLACK' }), row('660', 2, 'sold', 'Kafaya', { shade: 'Black' }),
  ...[1, 2].map((t) => row('670', t, 'sold', 'Kafaya', { warehouse: 'Kano office', day: '' })),
];

async function build(items, { untick = null, rows = SHEET } = {}) {
  const { bales } = loadLine(items, rows);
  for (const b of bales) for (const t of b.thans) { t.customer = t.soldTo; t.customerId = ''; }
  if (untick) for (const b of bales) for (const t of b.thans) if (`${b.packageNo}/${t.thanNo}` === untick) t.picked = false;
  const label = await unitDisplay.createQtyLabeller(rows);
  return buildActionJSON({ bales, returnedOn: '2026-11-14', condition: 'good' }, label);
}

/** Count what the goods lines print, by the card's own grammar. */
function counted(lines) {
  let bales = 0;
  let thans = 0;
  for (const l of lines) {
    if (/^ {2}\S*\d+\. \S+ · \d+ thans? · /.test(l)) bales += 1;
    else if (/^ {2}\S*\d+\. \S+\/\S+ · /.test(l)) thans += 1;
  }
  return unitDisplay.formatCounts({ bales, thans });
}

async function agree(aj) {
  const lines = await approvalCards.returnBundleLines(aj);
  assert.equal(counted(lines), aj.qty, `header ${aj.qty} vs lines:\n${lines.join('\n')}`);
  const buyerLines = lines.filter((l) => l.startsWith('👤 '));
  assert.equal(buyerLines.length, aj.groups.length);
  aj.groups.forEach((g, i) => assert.ok(buyerLines[i].includes(` · ${g.qty} · `), `${buyerLines[i]} carries ${g.qty}`));
  return lines;
}

test('typed bare: every than of the bale → one line', async () => {
  const aj = await build([{ packageNo: '631' }]);
  assert.deepEqual(aj.wholeBales, ['631']);
  assert.equal(aj.qty, '1B');
  const lines = await agree(aj);
  assert.deepEqual(lines, ['👤 solder madam · 1B · 150 yd · sold 02-Nov-2026', '44200', ' Shade BLACK', '  1. 631 · 5 thans · 150 yd']);
});

test('typed with every than (631/1+2+3+4+5) → one line, the same as bare', async () => {
  const aj = await build([{ packageNo: '631', thans: [1, 2, 3, 4, 5] }]);
  assert.deepEqual(aj.wholeBales, ['631']);
  const lines = await agree(aj);
  assert.equal(lines[3], '  1. 631 · 5 thans · 150 yd');
  assert.equal(aj.storedFacts, 1);
  assert.deepEqual(aj.items.map((it) => it.soldOn), Array(5).fill('2026-11-02'), 'the sale day is stored on each item');
});

test('typed with some thans → one line per than; the true size comes from the sheet', async () => {
  const aj = await build([{ packageNo: '631', thans: [1, 2, 3] }]);
  assert.deepEqual(aj.wholeBales, []);
  assert.equal(aj.qty, '3t');
  const lines = await agree(aj);
  assert.deepEqual(lines.slice(3), ['  1. 631/1 · 30 yd', '  2. 631/2 · 30 yd', '  3. 631/3 · 30 yd']);
});

test('a bale with one than still in stock stays than by than', async () => {
  const aj = await build([{ packageNo: '640' }]);
  assert.deepEqual(aj.wholeBales, []);
  assert.equal(aj.qty, '3t');
  await agree(aj);
});

test('a bale whose thans went to two buyers is loose thans for each — the header too', async () => {
  const aj = await build([{ packageNo: '650' }]);
  assert.deepEqual(aj.wholeBales, []);
  assert.equal(aj.qty, '3t');
  const lines = await agree(aj);
  assert.deepEqual(lines.filter((l) => l.startsWith('👤')), ['👤 ABBA · 1t · 30 yd · sold 02-Nov-2026', '👤 Kafaya · 2t · 60 yd · sold 02-Nov-2026']);
});

test('a bale whose thans carry two shade spellings prints ONE line under the first', async () => {
  const aj = await build([{ packageNo: '660' }]);
  assert.deepEqual(aj.wholeBales, ['660']);
  const lines = await agree(aj);
  assert.deepEqual(lines, ['👤 Kafaya · 1B · 60 yd · sold 02-Nov-2026', '44200', ' Shade BLACK', '  1. 660 · 2 thans · 60 yd']);
});

test('a than unticked on the card after a whole-bale load → the rest print than by than', async () => {
  const aj = await build([{ packageNo: '631' }], { untick: '631/5' });
  assert.deepEqual(aj.wholeBales, []);
  assert.equal(aj.qty, '4t');
  const lines = await agree(aj);
  assert.equal(lines.filter((l) => /631\/\d/.test(l)).length, 4);
});

test('a than-visible store counts thans, so a whole bale there still prints per than; no sale day = nothing', async () => {
  const aj = await build([{ packageNo: '670' }]);
  assert.deepEqual(aj.wholeBales, []);
  assert.equal(aj.qty, '2t');
  const lines = await agree(aj);
  assert.equal(lines[0], '👤 Kafaya · 2t · 60 yd');
});

test('the owner\'s line: 631 whole + 614/1, sold on two days → a range, header and lines agree', async () => {
  const aj = await build([{ packageNo: '631', thans: [1, 2, 3, 4, 5] }, { packageNo: '614', thans: [1] }]);
  assert.equal(aj.qty, '1B + 1t');
  const lines = await agree(aj);
  assert.deepEqual(lines, [
    '👤 solder madam · 1B + 1t · 180 yd · sold 02-Nov-2026 to 09-Nov-2026',
    '44200',
    ' Shade BLACK',
    '  1. 631 · 5 thans · 150 yd',
    '  2. 614/1 · 30 yd',
  ]);
});

/* ── rows raised before CARD-8 ─────────────────────────────────────────── */

const legacyRow = () => ({
  action: 'return_bundle',
  items: [1, 2, 3, 4, 5].map((t) => ({
    packageNo: '631', thanNo: String(t), warehouse: 'IDUMOTA', design: '44200', shade: 'BLACK',
    arrivalBatch: 'Jul26', yards: 30, pricePerYard: 1000, soldTo: 'solder madam', customer: 'solder madam', customerId: '',
  })),
  wholeBales: [],                                   // the old rule: typed with thans = never whole
  groups: [{ customer: 'solder madam', customerId: '', thans: 5, yards: 150, amount: 150000, noRateThans: 0, qty: '1B' }],
  stores: ['IDUMOTA'], qty: '1B', thans: 5, yards: 150, returnedOn: '2026-11-14', condition: 'good',
});

test('a WAITING row from before CARD-8 is filled in from the live sheet (one cached read)', async () => {
  const orig = inventoryRepository.getAll;
  const calls = [];
  inventoryRepository.getAll = async (...a) => { calls.push(a); return SHEET; };
  try {
    const card = await approvalCards.buildCardFromActionJSON(legacyRow());
    assert.match(card, /\n👤 solder madam · 1B · 150 yd · sold 02-Nov-2026\n44200\n Shade BLACK\n {2}1\. 631 · 5 thans · 150 yd\n/);
    assert.deepEqual(calls, [[]], 'getAll without the force flag');
  } finally { inventoryRepository.getAll = orig; }
});

test('a failing live read prints the waiting row as before, never throws', async () => {
  const orig = inventoryRepository.getAll;
  inventoryRepository.getAll = async () => { throw new Error('quota'); };
  try {
    const card = await approvalCards.buildCardFromActionJSON(legacyRow());
    assert.match(card, /\n👤 solder madam · 1B · 150 yd\n44200\n Shade BLACK\n {2}1\. 631\/1 · 30 yd\n/);
  } finally { inventoryRepository.getAll = orig; }
});

test('a DECIDED record, and a row raised after CARD-8, never read live stock', async () => {
  const orig = inventoryRepository.getAll;
  let reads = 0;
  inventoryRepository.getAll = async () => { reads += 1; return SHEET; };
  try {
    const decided = await approvalCards.buildCardFromActionJSON(legacyRow(), { decided: true });
    assert.match(decided, /\n👤 solder madam · 1B · 150 yd\n44200\n Shade BLACK\n {2}1\. 631\/1 · 30 yd\n/, 'only what is stored');
    const fresh = await build([{ packageNo: '614', thans: [1] }]);
    const before = reads;
    const card = await approvalCards.buildCardFromActionJSON(fresh);
    assert.match(card, /👤 solder madam · 1t · 30 yd · sold 09-Nov-2026\n/);
    assert.equal(reads, before, 'a CARD-8 row is printed as stored');
    assert.equal(before, 0);
  } finally { inventoryRepository.getAll = orig; }
});

test('review 1 (R1-7): a waiting row from before CARD-8 gets its HEADER count recomputed too — a bale split between two buyers is loose on both', async () => {
  const sheet = [...[1, 2, 3].map((t) => row('631', t, 'sold', 'A')), ...[4, 5].map((t) => row('631', t, 'sold', 'B'))];
  const it = (t, who) => ({
    packageNo: '631', thanNo: String(t), warehouse: 'IDUMOTA', design: '44200', shade: 'BLACK',
    arrivalBatch: 'Jul26', yards: 30, pricePerYard: 1000, soldTo: who, customer: who, customerId: '',
  });
  const old = {
    action: 'return_bundle',
    items: [it(1, 'A'), it(2, 'A'), it(3, 'A'), it(4, 'B'), it(5, 'B')],
    wholeBales: [],
    groups: [
      { customer: 'A', customerId: '', thans: 3, yards: 90, amount: 90000, noRateThans: 0, qty: '3t' },
      { customer: 'B', customerId: '', thans: 2, yards: 60, amount: 60000, noRateThans: 0, qty: '2t' },
    ],
    stores: ['IDUMOTA'], qty: '1B', thans: 5, yards: 150, returnedOn: '2026-11-14', condition: 'good',
  };
  const orig = inventoryRepository.getAll;
  inventoryRepository.getAll = async () => sheet;
  try {
    const card = await approvalCards.buildCardFromActionJSON(old);
    assert.equal(card.split('\n')[0], '↩️ Return · IDUMOTA · 5t · 150 yd · 2 customers');
    assert.equal((card.match(/631\/\d · 30 yd/g) || []).length, 5, 'five than lines under the 5t header');
    // A whole bale for one buyer still reads 1B on the header and one line.
    const one = await approvalCards.buildCardFromActionJSON(legacyRow());
    assert.equal(one.split('\n')[0].includes('· 1B · 150 yd'), true);
    // The decided copy prints only what is stored.
    const decided = await approvalCards.buildCardFromActionJSON(old, { decided: true });
    assert.equal(decided.split('\n')[0], '↩️ Return · IDUMOTA · 1B · 150 yd · 2 customers');
  } finally { inventoryRepository.getAll = orig; }
});
