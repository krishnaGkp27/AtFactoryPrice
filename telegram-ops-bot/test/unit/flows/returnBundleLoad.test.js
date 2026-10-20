'use strict';
// RET-5 — the typed multi-bale return: loading the line against the sheet,
// grouping every than under its own buyer, the shared goods lines and the
// admin card. Pure logic; the sheet is an array.
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const SRC = path.join(__dirname, '..', '..', '..', 'src');
const { _internals: { loadLine, buildActionJSON } } = require(path.join(SRC, 'flows/returnBundleFlow'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const designAssets = require(path.join(SRC, 'repositories/designAssetsRepository'));
const accounting = require(path.join(SRC, 'services/accountingService'));

designAssets.findActive = async () => null;
designAssets.findLatest = async (design) => (design === '9060-A' ? { shades: [{ number: '01', name: 'Black' }] } : null);
accounting.getCustomerLedger = async (name) => ({ outstandingAsOfToday: name === 'Kafaya' ? 1462500 : 250000 });

const row = (pkg, than, status, soldTo, extra = {}) => ({
  packageNo: pkg, thanNo: than, status, soldTo, yards: extra.yards || 30, shade: extra.shade || '01',
  design: extra.design || '9060-A', warehouse: extra.warehouse || 'Lagos', arrivalBatch: extra.batch || 'Jul26',
  pricePerYard: extra.rate == null ? 1250 : extra.rate, baleUid: `U-${pkg}-${than}`,
});
const SHEET = [
  ...[1, 2, 3, 4, 5].map((t) => row('771', t, 'sold', 'Kafaya')),           // whole, one buyer
  ...[1, 2, 3].map((t) => row('779', t, 'sold', 'Kafaya')), row('779', 4, 'sold', 'ABBA'), row('779', 5, 'available', ''),
  row('6189', 5, 'sold', 'ABBA', { design: '77014', shade: '11' }), row('6189', 6, 'available', '', { design: '77014', shade: '11' }),
  ...[1, 2].map((t) => row('6210', t, 'available', '')),
  row('9100', 1, 'in_transit', ''),
  row('9200', 1, 'sold', 'Kafaya', { warehouse: 'Lagos', batch: 'Mar26' }), row('9200', 1, 'sold', 'Kafaya', { warehouse: 'Kano office', batch: 'Jul26' }),
  row('9300', 1, 'sold', 'Nobody Known', { rate: 0 }),
];

test('loadLine: bare = every sold than whoever bought it; /n = that than; the reasons name what was left out', () => {
  const { bales, notLoaded } = loadLine([
    { packageNo: '771' }, { packageNo: '779' }, { packageNo: '6189', thans: [5, 6, 9] },
    { packageNo: '6210' }, { packageNo: '9999' }, { packageNo: '9100' }, { packageNo: '9200' }, { packageNo: '771' },
    { packageNo: '700', count: 3 },
  ], SHEET);
  assert.deepEqual(bales.map((b) => [b.packageNo, b.whole, b.thans.length, b.inStockThans]), [
    ['771', true, 5, []], ['779', true, 4, ['5']], ['6189', false, 1, ['6']],
  ]);
  assert.deepEqual(bales[1].thans.map((t) => `${t.thanNo}:${t.soldTo}`), ['1:Kafaya', '2:Kafaya', '3:Kafaya', '4:ABBA'], 'a split bale loads both buyers');
  assert.ok(bales.every((b) => b.thans.every((t) => t.picked)), 'chips arrive ticked');
  assert.deepEqual(notLoaded, [
    { packageNo: '6189/6+9', reason: 'not sold — left out' },
    { packageNo: '6210', reason: 'nothing sold — all 2 thans in stock' },
    { packageNo: '9999', reason: 'not found in Inventory — check the number' },
    { packageNo: '9100', reason: 'still on the road — nothing sold' },
    { packageNo: '9200', reason: 'this number was sold from two places or containers — raise it from ↩️ Return goods' },
    { packageNo: '771', reason: 'already on the list' },
    { packageNo: '700', reason: 'not found in Inventory — check the number' },
  ]);
});

test('loadLine: `771 x3` opens the bale unticked; a than that is not sold is refused by name', () => {
  const a = loadLine([{ packageNo: '771', count: 3 }], SHEET);
  assert.equal(a.bales[0].needPick, 3);
  assert.ok(a.bales[0].thans.every((t) => !t.picked));
  const b = loadLine([{ packageNo: '779', thans: [5, 7] }], SHEET);
  assert.deepEqual(b.bales, []);
  assert.deepEqual(b.notLoaded, [{ packageNo: '779/5+7', reason: 'than 5 is not sold, than 7 does not exist' }]);
});

test('buildActionJSON groups by buyer, marks whole bales, credits at each than\'s own rate', async () => {
  const { bales } = loadLine([{ packageNo: '771' }, { packageNo: '779' }, { packageNo: '6189', thans: [5] }, { packageNo: '9300' }], SHEET);
  for (const b of bales) for (const t of b.thans) { t.customer = t.soldTo; t.customerId = t.soldTo === 'Kafaya' ? 'c1' : (t.soldTo === 'ABBA' ? 'c2' : ''); }
  const label = (rows) => `${rows.length}t`;
  const aj = buildActionJSON({ bales, returnedOn: '2026-10-18', condition: 'good', photoFileId: 'ph1', photoKind: 'photo' }, label);
  assert.equal(aj.action, 'return_bundle');
  assert.equal(aj.items.length, 11);
  assert.deepEqual(aj.wholeBales, ['771', '9300'], '779 has a than on the shelf, so it is never a whole-bale line');
  assert.deepEqual(aj.groups.map((g) => [g.customer, g.thans, g.yards, g.amount, g.noRateThans, g.qty]), [
    ['ABBA', 2, 60, 75000, 0, '2t'], ['Kafaya', 8, 240, 300000, 0, '8t'], ['Nobody Known', 1, 30, 0, 1, '1t'],
  ]);
  assert.deepEqual(aj.stores, ['Lagos']);
  assert.equal(aj.return_photo_type, 'photo');

  const lines = await approvalCards.returnBundleLines(aj);
  const sp = '\u2007'; // CARD-7: serials padded with a figure space to the widest
  assert.deepEqual(lines, [
    '👤 ABBA · 2t · 60 yd',
    '9060-A',
    ' 01 - Black',
    `  ${sp}1. 779/4 · 30 yd`,
    '77014',
    ' Shade 11',
    `  ${sp}2. 6189/5 · 30 yd`,
    '👤 Kafaya · 8t · 240 yd',
    '9060-A',
    ' 01 - Black',
    `  ${sp}3. 771 · 150 yd`,
    `  ${sp}4. 779/1 · 30 yd`,
    `  ${sp}5. 779/2 · 30 yd`,
    `  ${sp}6. 779/3 · 30 yd`,
    '👤 Nobody Known · 1t · 30 yd',
    '9060-A',
    ' 01 - Black',
    `  ${sp}7. 9300 · 30 yd`,
  ], 'a bale split between buyers prints per than under each; a whole single-buyer bale is one line');

  const card = await approvalCards.buildReturnBundleCard({ ...aj, qty: '2B + 3t', approvals: ['777'] });
  assert.match(card, /^↩️ Return · Lagos · 2B \+ 3t · 330 yd · 3 customers\n📅 18-Oct-2026 · ✅ Good · 📎 Photo attached\n\n👤 ABBA/);
  assert.match(card, /\n💰 ABBA 75,000 · outstanding 250,000 → 175,000\n💰 Kafaya 300,000 · outstanding 1,462,500 → 1,162,500\n⚠️ Nobody Known: no rate on record — the stock comes back, but NO credit will post\.\n🔏 Dual-admin return — 1 signed so far\.\n⚠️ Reverses completed sales/);
});
