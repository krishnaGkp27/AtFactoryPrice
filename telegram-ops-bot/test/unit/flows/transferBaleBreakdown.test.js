'use strict';

/**
 * TRF-17 — the transfer bale list, grouped design → shade with the printed
 * numbers comma-separated (owner, 04-Aug-2026: "list of designs with the
 * shade and along with the shade in the bale number separated by comma so
 * that I can check with the doc and perform reconciliation").
 *
 * Same grammar as the SBL-2 sold card. The load-bearing rule is
 * BUSINESS_RULES §2: the bot never picks stock. A printed number can exist in
 * two warehouses, so a transfer that stored numbers WITHOUT row ids must say
 * so rather than guess a design — that refusal is what most of these pin.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const flow = require(path.join(SRC, 'flows/transferFlow'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const designCategoriesRepository = require(path.join(SRC, 'repositories/designCategoriesRepository'));

const { buildBaleBreakdown, baleCardRows } = flow._internals;

designCategoriesRepository.categoryOfSync = (d) => (String(d) === '9060-A' ? 'Cashmere' : '');

/** One than row. Four of these with the same pkg = one bale. */
function than(pkg, design, shade, uid, wh = 'Kano office') {
  return {
    packageNo: pkg, design, shade, thanNo: 1, yards: 60, status: 'available',
    warehouse: wh, baleUid: uid, pricePerYard: 0, arrivalBatch: 'Jul26',
  };
}

function seed(rows) { inventoryRepository.getAll = async () => rows; }

const REQ = 'TRF-0002';
function transferRow(over = {}) {
  return {
    requestId: REQ, user: '777',
    actionJSON: {
      from: 'IDUMOTA', to: 'Kano office', stage: 'in_transit',
      bales: ['869', '843', '874'],
      baleUids: ['u1', 'u2', 'u3'],
      dispatchDoc: { fileId: 'DOC-1', kind: 'photo' },
      ...over,
    },
  };
}

test('designs carry their shade and the bale numbers, comma-separated', async () => {
  seed([
    than('869', '9060-A', '01', 'u1'),
    than('843', '9060-A', '01', 'u2'),
    than('874', '9037-D', '12', 'u3'),
  ]);
  const { text } = await buildBaleBreakdown(REQ, transferRow());

  assert.match(text, /🧵 \*9060-A\* · Cashmere/, 'design heading carries its category');
  assert.match(text, /• Shade 01 ×2B \(869, 843\)/, 'both numbers on the shade line, comma-separated');
  assert.match(text, /🧵 \*9037-D\*/);
  assert.match(text, /• Shade 12 ×1B \(874\)/);
  assert.match(text, /IDUMOTA → Kano office/, 'the route is stated');
  assert.ok(!/design not recoverable/.test(text), 'everything resolved — no caveat block');
});

test('a reconciliation dots the verified numbers in place', async () => {
  seed([
    than('869', '9060-A', '01', 'u1'),
    than('843', '9060-A', '01', 'u2'),
    than('874', '9037-D', '12', 'u3'),
  ]);
  const { text } = await buildBaleBreakdown(REQ, transferRow(), {
    status: { done: true, matched: 2, missing: ['874'], docOnly: [] },
    verified: ['869', '843'],
  });
  assert.match(text, /📑 Doc check: \*2\/3\* matched/);
  assert.match(text, /⚠️ Not in doc: 874/);
  assert.match(text, /\(🟢869, 🟢843\)/, 'matched numbers dotted');
  assert.match(text, /• Shade 12 ×1B \(874\)/, 'unmatched number left bare');
});

test('numbers with no row id are declared, never guessed onto a design', async () => {
  // A legacy transfer: numbers only, no baleUids. 869 exists in Inventory
  // under TWO designs — exactly why guessing is forbidden.
  seed([
    than('869', '9060-A', '01', 'u1'),
    than('869', '77008', '05', 'uX'),
  ]);
  const { text } = await buildBaleBreakdown(REQ, transferRow({ baleUids: [] }));
  assert.match(text, /design not recoverable/, 'says so plainly');
  assert.match(text, /869, 843, 874/, 'every number is still listed');
  assert.ok(!/🧵 \*9060-A\*/.test(text), 'no design was invented for them');
  assert.ok(!/🧵 \*77008\*/.test(text));
});

test('a partially-resolvable transfer shows both blocks and loses no number', async () => {
  seed([than('869', '9060-A', '01', 'u1')]);
  const { text } = await buildBaleBreakdown(REQ, transferRow({ baleUids: ['u1'] }));
  assert.match(text, /🧵 \*9060-A\*/);
  assert.match(text, /• Shade 01 ×1B \(869\)/);
  assert.match(text, /design not recoverable.*\(2\)/s, 'the other two are accounted for');
  assert.match(text, /843, 874/);
});

test('the reconcile chip appears only when a dispatch doc exists, and reads it', async () => {
  const withDoc = baleCardRows(REQ, transferRow().actionJSON, null).flat();
  assert.ok(withDoc.some((b) => b.text === '🧮 Reconcile dispatch doc'
    && b.callback_data === `trf:bnr:${REQ}`));

  const done = baleCardRows(REQ, transferRow().actionJSON, { done: true }).flat();
  assert.ok(done.some((b) => b.text === '🔁 Re-check dispatch doc'), 'label flips after a check');

  const noDoc = baleCardRows(REQ, transferRow({ dispatchDoc: null }).actionJSON, null).flat();
  assert.ok(!noDoc.some((b) => String(b.callback_data).startsWith('trf:bnr:')),
    'nothing to reconcile against, so no chip');
});

test('the viewer and the reconcile callbacks cannot be confused for each other', async () => {
  // Both routes anchor the trailing colon, so they are disjoint and the
  // request id survives whichever is tested first. Pinned because a future
  // change to startsWith() would silently hand showBaleNumbers "r:TRF-0002".
  assert.equal('trf:bnr:TRF-0002'.match(/^trf:bn:(.+)$/), null,
    'the viewer pattern must not match a reconcile callback');
  assert.equal('trf:bnr:TRF-0002'.match(/^trf:bnr:(.+)$/)[1], 'TRF-0002');
  assert.equal('trf:bn:TRF-0002'.match(/^trf:bnr:(.+)$/), null);
  assert.equal('trf:bn:TRF-0002'.match(/^trf:bn:(.+)$/)[1], 'TRF-0002');
  // And a startsWith would NOT be safe — this is the trap being guarded.
  assert.equal('trf:bnr:TRF-0002'.startsWith('trf:bn'), true);
  assert.equal(typeof flow._internals.reconcileBaleNumbers, 'function');
});
