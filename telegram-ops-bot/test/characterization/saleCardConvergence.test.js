'use strict';

/**
 * CARD-4 (owner 23-Aug-2026) — "club together all the paths from the same
 * code in the same layout without any ambiguity."
 *
 * Root cause this pins: CARD-3 landed in the SHARED approvalCards builder
 * and the than/snap doors adopted it, but the Sell Bale door (sale_flow)
 * still hand-wrote a verbose card ("Bale 1003: 9060-B , 7 thans, 210 yds
 * … Total: 1 Bale (7 thans), 210 yards") in TWO places — so the same
 * business event looked different depending on which tile was used.
 *
 * These tests fail the moment any door starts writing its own sale card
 * again, or words the BACKDATED banner its own way.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, SRC } = require('../helpers/controllerHarness');
installFakeSheets(createFakeSheets({}));

const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const salesFlowService = require(path.join(SRC, 'services/salesFlowService'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));

// Bale 1003 lives in TWO stores — the same number, different design.
inventoryRepository.getAll = async () => [
  { packageNo: '1003', thanNo: 1, design: '9060-B', shade: '3', warehouse: 'Kano office', status: 'available', yards: 30 },
  { packageNo: '1003', thanNo: 2, design: '9060-B', shade: '3', warehouse: 'Kano office', status: 'available', yards: 30 },
  { packageNo: '1003', thanNo: 1, design: '77014', shade: '2', warehouse: 'IDUMOTA', status: 'available', yards: 25 },
];

/** Every CARD-3 card carries these marks; the verbose card carried none. */
function assertCard3(text, where) {
  assert.match(text, /🧾/, `${where}: CARD-3 header`);
  assert.match(text, /Σ .*yd/, `${where}: Σ key line`);
  assert.match(text, /\(bale\/than · #shade\)/, `${where}: grammar key`);
  assert.ok(!/Total: \d+ Bale/.test(text), `${where}: no verbose "Total: N Bale" line`);
  assert.ok(!/thans, \d+ yds/.test(text), `${where}: no verbose per-line nouns`);
}

test('the seller confirm card (Sell Bale door) is CARD-3, not the old verbose block', async () => {
  const text = await salesFlowService.buildSummary({
    items: [{ type: 'package', packageNo: '1003', warehouse: 'Kano office' }],
    collected: { customer: '', salesperson: 'Muhammad', paymentMode: '', salesDate: '2026-08-21' },
    sale_doc_file_id: 'bill-1',
  });
  assertCard3(text, 'buildSummary');
  assert.match(text, /🧵 9060-B/, 'design group heading');
  assert.match(text, /📎 Sales bill/, 'attachment noted by the shared builder');
  assert.match(text, /👤 set at approval/, 'DSP-1 customer wording');
});

test('the admin approval card is rendered FROM the queued row (same builder)', async () => {
  const aj = {
    action: 'sale_bundle',
    items: [{ type: 'package', packageNo: '1003', warehouse: 'Kano office' }],
    customer: '', salesDate: '2026-08-21', salesPerson: 'Muhammad',
    totalYards: 60, sale_doc_file_id: 'bill-1', sale_doc_type: 'document',
  };
  const text = await approvalCards.buildSaleBundleCard(aj);
  assertCard3(text, 'buildSaleBundleCard');
  assert.match(text, /Kano office/, 'store shown for a single-store request');
});

test('TRF-INT4 parity: enrichment resolves a same-numbered bale inside its OWN store', async () => {
  const kano = await approvalCards.enrichBundleItems([{ type: 'package', packageNo: '1003', warehouse: 'Kano office' }]);
  assert.equal(kano[0].design, '9060-B', 'Kano copy');
  assert.equal(kano[0].thans, 2);
  const idumota = await approvalCards.enrichBundleItems([{ type: 'package', packageNo: '1003', warehouse: 'IDUMOTA' }]);
  assert.equal(idumota[0].design, '77014', 'Idumota copy — never mis-attributed');
  // No warehouse named → two designs under one number → never guesses.
  const bare = await approvalCards.enrichBundleItems([{ type: 'package', packageNo: '1003' }]);
  assert.equal(bare[0].design, undefined, 'ambiguous stays bare (BUSINESS_RULES §2)');
});

test('the BACKDATED banner has ONE wording, emitted by the shared builder', async () => {
  const viaCard = await approvalCards.buildSaleCard({
    headline: 'Sale', customer: '', items: [{ packageNo: '1003', design: '9060-B', shade: '3', thans: 2, yards: 60, warehouse: 'Kano office' }],
    backdated: true, daysBack: 41,
  });
  assert.match(viaCard, /⚠️ BACKDATED sale — 41 day\(s\) in the past\. Check the date before approving\./);
  // The queue-rebuild path words it identically — not "(41 day(s) in the past)".
  const viaBundle = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', items: [{ type: 'package', packageNo: '1003', warehouse: 'Kano office' }],
    backdated: true, daysBack: 41, totalYards: 60,
  });
  assert.match(viaBundle, /⚠️ BACKDATED sale — 41 day\(s\) in the past\. Check the date before approving\./);
  assert.ok(!/BACKDATED sale \(41/.test(viaBundle), 'old parenthetical wording is gone');
  // A normal sale carries no banner at all.
  const normal = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', items: [{ type: 'package', packageNo: '1003', warehouse: 'Kano office' }], totalYards: 60,
  });
  assert.ok(!/BACKDATED/.test(normal));
});

test('an unresolvable bale is warned by the shared builder, not silently dropped', async () => {
  const text = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', items: [{ type: 'package', packageNo: '9999', warehouse: 'Kano office' }], totalYards: 0,
  });
  assert.match(text, /no available stock/i);
  assert.match(text, /NOTHING in this request is available/);
});
