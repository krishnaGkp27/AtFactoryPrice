'use strict';

/**
 * SAB-1 — the sale_bundle approval card shows the goods, not just numbers
 * (owner, 06-Aug-2026: "I cannot see complete details in this approval").
 *
 * The card resolves each bale from Inventory: design, shade, warehouse,
 * quantities — in the CARD-2 grammar the other sale cards already use. The
 * rule that shapes the edge cases is BUSINESS_RULES §2: a printed number
 * whose live rows span two designs is never guessed onto one.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const crmService = require(path.join(SRC, 'services/crmService'));
const designCategoriesRepository = require(path.join(SRC, 'repositories/designCategoriesRepository'));

crmService.getCustomer = async () => null;
designCategoriesRepository.categoryOfSync = () => '';

function row(pkg, design, shade, wh, thanNo, status = 'available') {
  return {
    packageNo: pkg, design, shade, warehouse: wh, thanNo,
    status, yards: 50, pricePerYard: 0,
  };
}

function seed(rows) { inventoryRepository.getAll = async () => rows; }

test('a bare bale number becomes design, shade, warehouse and quantities', async () => {
  seed([
    row('516', '9060-A', '01', 'IDUMOTA', 1),
    row('516', '9060-A', '01', 'IDUMOTA', 2),
    row('516', '9060-A', '01', 'IDUMOTA', 3),
  ]);
  const text = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', customer: '', salesPerson: 'Abdul',
    salesDate: '2026-08-05', items: [{ type: 'package', packageNo: '516' }],
    totalYards: 150, sale_doc_file_id: 'F1',
  });
  // CARD-3 — the same facts, without the words repeated on every line.
  assert.match(text, /👤 set at approval/);
  assert.match(text, /🧑 Abdul/);
  assert.match(text, /🧾 Sale · IDUMOTA/, 'one store rides the header, not every line');
  // CARD-5 — a whole-bale item tallies as its printed number: 1B, not
  // "3 than · 1 bale"; its internal than count stays in the ×3 token.
  assert.match(text, /🧵 9060-A — 1B · 150 yd/);
  assert.match(text, /#01 → 516 ×3/);
  assert.match(text, /Σ 1B · 150 yd/);
  assert.match(text, /📎 Sales bill/);
  assert.ok(!text.includes('see below'), 'the stale pointer is gone');
});

test('a number living under TWO designs stays bare — never guessed (§2)', async () => {
  seed([
    row('516', '9060-A', '01', 'IDUMOTA', 1),
    row('516', '77008', '05', 'Kano office', 1),
  ]);
  const text = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', items: [{ type: 'package', packageNo: '516' }], totalYards: 150,
  });
  assert.match(text, /🧵 not resolved/, 'no design attached');
  assert.match(text, /\n {2}516/, 'the number still shows');
  assert.ok(!text.includes('9060-A') && !text.includes('77008'), 'no design was invented');
  assert.match(text, /Queued total: 150 yards/, 'the requester’s figure still shows');
});

test('a single-than sale names its than', async () => {
  seed([
    row('516', '9060-A', '01', 'IDUMOTA', 1),
    row('516', '9060-A', '01', 'IDUMOTA', 2),
  ]);
  const text = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', items: [{ type: 'than', packageNo: '516', thanNo: 2 }],
  });
  // CARD-3 — the than rides the bale in the grammar Abdul already types.
  // CARD-5 — and a than item tallies in thans: 1t, never "1 bale".
  assert.match(text, /🧵 9060-A — 1t · 50 yd/);
  assert.match(text, /#01 → 516\/2/);
  assert.match(text, /Σ 1t · 50 yd/);
});

test('CARD-5: the tally speaks each item’s packaging — t, B, and B + t', async () => {
  seed([
    row('516', '9060-A', '01', 'IDUMOTA', 1),
    row('516', '9060-A', '01', 'IDUMOTA', 2),
    row('700', '77014', '11', 'Kano office', 1),
    row('700', '77014', '11', 'Kano office', 2),
    row('700', '77014', '11', 'Kano office', 3),
  ]);
  // Than-only (the Kano case behind CARD-5): thans, and NO bale figure.
  const thanOnly = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle',
    items: [
      { type: 'than', packageNo: '700', thanNo: 1 },
      { type: 'than', packageNo: '700', thanNo: 2 },
    ],
  });
  assert.match(thanOnly, /🧵 77014 — 2t · 100 yd/);
  assert.match(thanOnly, /Σ 2t · 100 yd/);
  assert.ok(!/\d+ bale/.test(thanOnly), 'no "· N bale" tail on a than sale');
  // Whole-bale: distinct printed numbers as B.
  const wholeBale = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle',
    items: [
      { type: 'package', packageNo: '516' },
      { type: 'package', packageNo: '700' },
    ],
  });
  assert.match(wholeBale, /Σ 2B · 250 yd/);
  // Mixed: both units, each speaking its own goods.
  const mixed = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle',
    items: [
      { type: 'package', packageNo: '516' },
      { type: 'than', packageNo: '700', thanNo: 3 },
    ],
  });
  assert.match(mixed, /🧵 9060-A — 1B · 100 yd/);
  assert.match(mixed, /🧵 77014 — 1t · 50 yd/);
  assert.match(mixed, /Σ 1B \+ 1t · 150 yd/);
});

test('an Inventory outage degrades to the bare list — the card never fails', async () => {
  inventoryRepository.getAll = async () => { throw new Error('Sheets unreachable'); };
  const text = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', items: [{ type: 'package', packageNo: '516' }], totalYards: 150,
  });
  assert.match(text, /\n {2}516/);
  assert.match(text, /Queued total: 150 yards/);
});

test('the persisted bill-check verdict rides the card', async () => {
  seed([row('516', '9060-A', '01', 'IDUMOTA', 1)]);
  const bad = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', items: [{ type: 'package', packageNo: '516' }],
    docVerify: { ok: 0, differs: 0, missing: 1, extra: 1 },
  });
  assert.match(bad, /🔬 Bill check: 0 confirmed · 0 differ · 1 missing · 1 extra ⚠️/);
  const good = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', items: [{ type: 'package', packageNo: '516' }],
    docVerify: { ok: 3, differs: 0, missing: 0, extra: 0 },
  });
  assert.match(good, /🔬 Bill check: 3 confirmed · 0 differ · 0 missing · 0 extra ✅/);
});

/* VRF-4 (owner 08-Sep-2026: "I cannot precisely see the exact bill number
 * where I need to find the ambiguity") — the card NAMES the flagged bales
 * under the 🔬 summary, with the checker's one-word reason. Confirmed bales
 * stay a count: they need no eye. */
test('VRF-4: the card names the flagged bales with the reason kind; confirmed stay a count', async () => {
  seed([row('516', '9060-A', '01', 'IDUMOTA', 1)]);
  const card = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', items: [{ type: 'package', packageNo: '516' }],
    docVerify: {
      ok: 14, differs: 3, missing: 1, extra: 1,
      okNos: ['4401', '4402'], okNoted: [{ no: '4403', notes: ['partial: selling 2 of the 5 pcs on the label'] }],
      differRows: [
        { no: '4412', diffs: ['qty: bill ~150 yds, request 120 yds'], notes: [] },
        // two kinds on one bale, plus a duplicate kind — deduplicated, in order
        { no: '4419', diffs: ['shade: bill says BK, request says NAVY', 'design: bill says 4420, request says 44200', 'shade: x'], notes: [] },
        // matched by details: the bill row carries the OTHER number, so say it
        { no: '847', diffs: ['bale no: bill reads "2522" — matched by details'], notes: [] },
      ],
      missingNos: ['4421'],
      extraRows: [{ no: '4430', design: '77016', shade: '5' }, { no: '', design: '77020', shade: '' }],
      truncated: false,
    },
  });
  assert.match(card, /🔬 Bill check: 14 confirmed · 3 differ · 1 missing · 1 extra ⚠️/);
  assert.match(card, /\n {2}⚠️ 4412 \(qty\) · 4419 \(shade, design\) · 847 \(bill reads 2522\)/, card);
  assert.match(card, /\n {2}❌ 4421 not on bill/, card);
  assert.match(card, /\n {2}➕ 4430 · \(no number\) on bill, not in request/, card);
  assert.doesNotMatch(card, /440[123]/, 'confirmed bales are a count, never a list');
  assert.doesNotMatch(card, /partial: selling/, 'a confirmed-with-note row does not spill its note onto the card');
});

test('VRF-4: each flagged line caps at 8 numbers then "+N more"; a counts-only record renders as before', async () => {
  seed([row('516', '9060-A', '01', 'IDUMOTA', 1)]);
  const missingNos = Array.from({ length: 11 }, (_, i) => String(9001 + i));
  const capped = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', items: [{ type: 'package', packageNo: '516' }],
    docVerify: { ok: 0, differs: 0, missing: 11, extra: 0, okNos: [], okNoted: [], differRows: [], missingNos, extraRows: [] },
  });
  assert.match(capped, /\n {2}❌ 9001 · 9002 · 9003 · 9004 · 9005 · 9006 · 9007 · 9008 \+3 more not on bill/, capped);
  assert.doesNotMatch(capped, /9009/, 'the ninth number waits behind the chip');
  assert.doesNotMatch(capped, /\n {2}[⚠️➕]/, 'no empty differ / extra lines');

  // A row checked before VRF-4: counts, no rows. Exactly the SAB-1 line, nothing under it.
  const old = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', items: [{ type: 'package', packageNo: '516' }],
    docVerify: { ok: 0, differs: 2, missing: 1, extra: 1 },
  });
  assert.match(old, /🔬 Bill check: 0 confirmed · 2 differ · 1 missing · 1 extra ⚠️$/m);
  assert.doesNotMatch(old, /\n {2}(⚠️|❌|➕)/, 'nothing to name, so no line pretends to');
});

test('VRF-4: the single-bale (sell_package) card carries the same 🔬 line and the flagged numbers', async () => {
  seed([row('516', '9060-A', '01', 'IDUMOTA', 1)]);
  const base = { action: 'sell_package', packageNo: '516', design: '9060-A', shade: '01', thans: 1, yards: 50, warehouse: 'IDUMOTA', sale_doc_file_id: 'bill-9' };
  const noCheck = await approvalCards.buildSellPackageCard(base);
  assert.doesNotMatch(noCheck, /🔬/, 'no verdict yet → no line');
  const checked = await approvalCards.buildSellPackageCard({
    ...base,
    docVerify: { ok: 0, differs: 0, missing: 1, extra: 0, okNos: [], okNoted: [], differRows: [], missingNos: ['516'], extraRows: [] },
  });
  assert.match(checked, /🔬 Bill check: 0 confirmed · 0 differ · 1 missing · 0 extra ⚠️\n {2}❌ 516 not on bill/, checked);
  // The line sits AFTER the goods and the Σ tally, like the bundle card.
  assert.ok(checked.indexOf('Σ ') < checked.indexOf('🔬'), 'verdict follows the tally');
});
