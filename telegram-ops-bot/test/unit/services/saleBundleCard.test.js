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
// CARD-6 — the shade heading reads the catalogue colour; stub the lookup so
// no test reaches for a sheet. 9060-A names shade 1; 77014 has no entry.
const designAssetsRepository = require(path.join(SRC, 'repositories/designAssetsRepository'));
designAssetsRepository.findActive = async (design) => (String(design) === '9060-A' ? { design, shades: [{ number: 1, name: 'Black' }] } : null);
designAssetsRepository.findLatest = async () => null;

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
  // CARD-6 — one fact per line, the tally once on the first line, the
  // catalogue colour on the shade heading, one bale per line with its yards.
  assert.match(text, /^🧾 Sale · IDUMOTA · 1B · 150 yd\n🧑 Abdul · 📅 05-Aug-2026\n\n9060-A\n 01 - Black\n {2}516 · 150 yd$/);
  assert.ok(!/👤|Σ |×3|📎|#01|🧵|@/.test(text), 'no empty customer line, no tally repeat, no ×N, no 📎 line, no # or @ links');
  // CARD-5 — a whole-bale item still tallies as its printed number: 1B, not
  // "3 than · 1 bale".
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
  assert.match(text, /\n\nnot resolved — this number lives under more than one design/, 'no design attached');
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
  // CARD-6 — the than rides the bale in the grammar Abdul already types.
  // CARD-5 — and a than item tallies in thans: 1t, never "1 bale".
  assert.match(text, /^🧾 Sale · IDUMOTA · 1t · 50 yd\n\n9060-A\n 01 - Black\n {2}516\/2 · 50 yd$/);
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
  assert.match(thanOnly, /^🧾 Sale · Kano office · 2t · 100 yd\n\n77014\n Shade 11\n {2}700\/1 · 50 yd\n {2}700\/2 · 50 yd$/, 'no catalogue entry → "Shade 11", never a guessed colour');
  assert.ok(!/\d+ bale/.test(thanOnly), 'no "· N bale" tail on a than sale');
  // Whole-bale: distinct printed numbers as B.
  const wholeBale = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle',
    items: [
      { type: 'package', packageNo: '516' },
      { type: 'package', packageNo: '700' },
    ],
  });
  // Two stores → no store on the header, each bale names its own; several
  // designs → each design line carries its own tally under the total.
  assert.match(wholeBale, /^🧾 Sale · 2B · 250 yd\n\n9060-A · 1B · 100 yd\n 01 - Black\n {2}516 · 100 yd · IDUMOTA\n77014 · 1B · 150 yd\n Shade 11\n {2}700 · 150 yd · Kano office$/);
  // Mixed: both units, each speaking its own goods.
  const mixed = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle',
    items: [
      { type: 'package', packageNo: '516' },
      { type: 'than', packageNo: '700', thanNo: 3 },
    ],
  });
  assert.match(mixed, /^🧾 Sale · 1B \+ 1t · 150 yd\n/);
  assert.match(mixed, /\n9060-A · 1B · 100 yd\n/);
  assert.match(mixed, /\n77014 · 1t · 50 yd\n Shade 11\n {2}700\/3 · 50 yd · Kano office$/);
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
  assert.doesNotMatch(capped, /\n {2}(?:⚠️|➕)/, 'no empty differ / extra lines');

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
  // The line sits AFTER the goods, like the bundle card.
  assert.ok(checked.indexOf('516 · 50 yd') < checked.indexOf('🔬'), 'verdict follows the goods');
});

test('VRF-4: "+N more" states the persisted COUNT, not the length of a shed row list', async () => {
  seed([row('516', '9060-A', '01', 'IDUMOTA', 1)]);
  // The record kept only 3 of 12 differ rows (byte budget) — the card must still say 12.
  const card = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', items: [{ type: 'package', packageNo: '516' }],
    docVerify: {
      ok: 0, differs: 12, missing: 2, extra: 0, okNos: [], okNoted: [],
      differRows: [
        { no: '4412', diffs: ['qty: x'], notes: [] }, { no: '4413', diffs: ['qty: x'], notes: [] }, { no: '4414', diffs: ['qty: x'], notes: [] },
      ],
      missingNos: ['4421', '4422'], extraRows: [], truncated: true,
    },
  });
  assert.match(card, /\n {2}⚠️ 4412 \(qty\) · 4413 \(qty\) · 4414 \(qty\) \+9 more/, card);
  assert.match(card, /\n {2}❌ 4421 · 4422 not on bill/, 'a complete list gets no "+more"');
});

test('QTA-2: ⚠️ items that are this request\'s OWN earlier flips say so — Approve restarts, never duplicates', async () => {
  const sold = (pkg, t, design) => ({ ...row(pkg, design, '1', 'Kano office', t, 'sold'), soldTo: 'AYUBAL ANSARI', soldDate: '25/09/2026' });
  seed([
    sold('771', 1, '9037'), sold('771', 2, '9037'),
    sold('6189', 5, '9006'), { ...row('6189', '9006', '1', 'Kano office', 4, 'sold'), soldTo: 'Zakirullah', soldDate: '2026-07-08' },
    row('772', '9037', '1', 'Kano office', 1), row('772', '9037', '1', 'Kano office', 2),
  ]);
  const aj = {
    action: 'sale_bundle', customer: 'Ayubal Ansari', salesDate: '2026-09-25', warehouse: 'Kano office',
    items: [{ type: 'package', packageNo: '771' }, { type: 'than', packageNo: '6189', thanNo: 5 }, { type: 'package', packageNo: '772' }],
  };
  const text = await approvalCards.buildSaleBundleCard(aj);
  assert.match(text, /⚠️ 2 of 3 item\(s\) marked ⚠️ are sold to Ayubal Ansari on 25-Sep-2026 — this request's own half-done run\. Approve restarts it: they are put back and the whole request is sold afresh; nothing is charged twice \(a than another approved sale covers is refused as a duplicate\)\./);
  assert.ok(!text.includes('have no available stock — check before approving'), 'the generic warning is replaced, not stacked');
  // Mixed: one gone to someone else, one this sale's own.
  seed([
    sold('771', 1, '9037'),
    { ...row('779', '9037', '1', 'Kano office', 1, 'sold'), soldTo: 'Musa', soldDate: '2026-09-25' },
    row('772', '9037', '1', 'Kano office', 1),
  ]);
  const mixed = await approvalCards.buildSaleBundleCard({ ...aj, items: [{ type: 'package', packageNo: '771' }, { type: 'package', packageNo: '779' }, { type: 'package', packageNo: '772' }] });
  assert.match(mixed, /⚠️ 2 of 3 item\(s\) marked ⚠️ have no available stock — check before approving\. 1 of them are this request's own half-done run: put back and sold afresh on Approve\./);
  // Everything gone, none this sale's: the old 🚨 line, untouched.
  seed([{ ...row('779', '9037', '1', 'Kano office', 1, 'sold'), soldTo: 'Musa', soldDate: '2026-09-25' }]);
  const gone = await approvalCards.buildSaleBundleCard({ ...aj, items: [{ type: 'package', packageNo: '779' }] });
  assert.match(gone, /🚨 NOTHING in this request is available/);
});
