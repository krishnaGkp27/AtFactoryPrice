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
