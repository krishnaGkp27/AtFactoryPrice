'use strict';

/**
 * VRF-3 (owner, 15-Aug-2026, with a screenshot of ten false ❌ lines).
 *
 * "You have to stop doing bill checks for the sale which is made in
 * thans… selling in thans doesn't have detailed information in the image
 * attached inside the PDF of the bill, therefore there is no use of
 * wasting the credit unless you find that there is a complete bale sold
 * in the approval card."
 *
 * His 10-than Kano sale produced ten "Bale XXXX — NOT found on the bill"
 * lines, every one false: a than sale's bill is a handwritten receipt
 * that names no bale numbers, so the bale-row OCR can only ever report
 * everything missing — after burning a vision credit to do it.
 *
 * Pinned:
 *  - a than-only sale spends NO credit (the gate sits before the
 *    download, not after) and says nothing;
 *  - a sale carrying any whole bale still verifies, exactly as before;
 *  - a MIXED sale verifies its bales and names its thans once, instead of
 *    dressing them as failures;
 *  - goods that cannot be classified still get checked — uncertainty
 *    degrades towards verifying, never away from it.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
loadController();

const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const designAssetsRepository = require(path.join(SRC, 'repositories/designAssetsRepository'));
const locationsRepository = require(path.join(SRC, 'repositories/locationsRepository'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const vision = require(path.join(SRC, 'services/vision'));
const svc = require(path.join(SRC, 'services/saleDocVerifyService'));

settingsRepository.getAll = async () => ({});
inventoryRepository.getAll = async () => [];
inventoryRepository.getWarehouses = async () => ['IDUMOTA', 'Kano office'];
designAssetsRepository.getAll = async () => [];
// Locations is NOT seeded — exactly the owner's live state, which is why
// VRF-2's store skip never fired on his Kano sale. VRF-3 must not depend
// on it.
locationsRepository.getAll = async () => [];
approvalQueueRepository.updateActionJSON = async () => true;

let downloads = 0;
let ocrCalls = 0;
telegramFiles.downloadTelegramFile = async () => {
  downloads += 1;
  return { buffer: Buffer.from('bill'), mimeType: 'application/pdf' };
};
/** A real bill naming two bales, so a bale sale can genuinely confirm. */
vision.extractBales = async () => {
  ocrCalls += 1;
  return {
    ok: true,
    bales: [
      { packageNo: '6143', design: 'D1', shade: '3', thanNo: 3, yards: 90 },
      { packageNo: '6130', design: 'D1', shade: '3', thanNo: 3, yards: 90 },
    ],
  };
};

const ROWS = new Map();
approvalQueueRepository.getByRequestId = async (id) => ROWS.get(id) || null;

function queue(requestId, items, extra = {}) {
  ROWS.set(requestId, {
    requestId,
    user: '4242',
    status: 'pending',
    actionJSON: {
      action: 'sale_bundle',
      customer: 'Qaribullah',
      sale_doc_file_id: `bill-${requestId}`,
      sale_doc_type: 'document',
      items,
      ...extra,
    },
  });
  return requestId;
}

const than = (packageNo, thanNo = 1, warehouse = 'Kano office') => ({
  type: 'than', packageNo, thanNo, warehouse, design: 'D1', shade: '3', thans: 1, yards: 30,
});
const bale = (packageNo, warehouse = 'IDUMOTA') => ({
  type: 'package', packageNo, warehouse, design: 'D1', shade: '3', thans: 3, yards: 90,
});

async function run(requestId) {
  const before = { downloads, ocrCalls };
  const bot = createFakeBot();
  const verified = await svc.maybeVerify(bot, requestId, { adminIds: ['777'] });
  return {
    verified,
    spentCredit: ocrCalls > before.ocrCalls,
    downloaded: downloads > before.downloads,
    dms: bot.calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.args.text)),
  };
}

/* ── the owner's screenshot ── */

test('VRF-3: the 10-than sale spends no credit and says nothing', async () => {
  const items = ['6143', '6130', '6135', '6118', '6147', '6116', '6098', '6067', '6082', '6086']
    .map((n, i) => than(n, (i % 3) + 1));
  const r = await run(queue('S-THAN10', items, { totalYards: 300 }));

  assert.equal(r.verified, false, 'the check declines the request');
  assert.equal(r.downloaded, false, 'the bill is never even fetched');
  assert.equal(r.spentCredit, false,
    'the gate sits BEFORE the vision call — the credit is saved, not spent and discarded');
  assert.deepEqual(r.dms, [], 'no 🔬 message at all');
});

test('VRF-3: not one false "NOT found" line survives', async () => {
  const r = await run(queue('S-THAN2', [than('6143'), than('6130')]));
  assert.ok(!r.dms.join('').includes('NOT found on the bill'),
    'this is the exact noise the owner screenshotted');
});

test('VRF-3: a single-than sale (the inline sell_than shape) skips too', async () => {
  ROWS.set('S-ONE', {
    requestId: 'S-ONE', user: '4242', status: 'pending',
    actionJSON: {
      action: 'sell_than', customer: 'X', packageNo: '6143', thanNo: 2,
      design: 'D1', shade: '3', yards: 30,
      sale_doc_file_id: 'bill-one', sale_doc_type: 'photo',
    },
  });
  const r = await run('S-ONE');
  assert.equal(r.verified, false);
  assert.equal(r.spentCredit, false);
});

/* ── what must keep working ── */

test('VRF-3: a whole-bale sale still verifies, untouched', async () => {
  const r = await run(queue('S-BALE', [bale('6143'), bale('6130')]));
  assert.equal(r.verified, true);
  assert.equal(r.spentCredit, true, 'a bale bill DOES carry bale rows — read it');
  const msg = r.dms.join('\n');
  assert.match(msg, /🔬 Bill check — request S-BALE/);
  assert.match(msg, /✅ Bale 6143 — on the bill/);
  assert.match(msg, /Verdict: 2 confirmed/);
  assert.ok(!/than item\(s\) not machine-checked/.test(msg),
    'no than note when there are no thans');
});

test('VRF-3: the inline sell_package shape is a bale, and is checked', async () => {
  ROWS.set('S-PKG', {
    requestId: 'S-PKG', user: '4242', status: 'pending',
    actionJSON: {
      action: 'sell_package', customer: 'X', packageNo: '6143',
      design: 'D1', shade: '3', thans: 3, yards: 90,
      sale_doc_file_id: 'bill-pkg', sale_doc_type: 'document',
    },
  });
  const r = await run('S-PKG');
  assert.equal(r.verified, true);
  assert.equal(r.spentCredit, true);
});

/* ── the mixed sale ── */

test('VRF-3: a mixed sale checks its BALES and names its thans once', async () => {
  const r = await run(queue('S-MIX', [
    bale('6143'), bale('6130'), than('6098'), than('6067'), than('6082'),
  ]));
  assert.equal(r.verified, true, 'the bale half is checkable, so the request is checked');
  const msg = r.dms.join('\n');
  assert.match(msg, /✅ Bale 6143 — on the bill/);
  assert.match(msg, /✅ Bale 6130 — on the bill/);
  assert.match(msg, /ℹ️ 3 than item\(s\) not machine-checked/,
    'the verdict never silently implies it covered the whole request');
  assert.match(msg, /Verdict: 2 confirmed · 0 differ · 0 missing · 0 extra/,
    'the thans are absent from every count');
  for (const n of ['6098', '6067', '6082']) {
    assert.ok(!msg.includes(`Bale ${n}`), `than ${n} must not appear as a bale finding`);
  }
  // The closing sentence must not out-claim the comparison.
  assert.ok(!msg.includes('The bill and the request agree.'),
    'a clean bale check says NOTHING about the thans — claiming full agreement would mislead');
  assert.match(msg, /The bale lines and the bill agree — the than items above were not compared\./);
});

test('VRF-3: a fully-checked sale still gets the plain, unqualified agreement', async () => {
  const r = await run(queue('S-ALLBALE', [bale('6143'), bale('6130')]));
  assert.match(r.dms.join('\n'), /The bill and the request agree\./,
    'nothing was skipped, so nothing is hedged');
});

test('VRF-3: a than\'s source bale on the bill is not re-reported as an "extra"', async () => {
  // The mixed sale's bill lists 6143 and 6130 (its bales) AND 6098, the
  // bale the loose thans were pulled from. Excluding the than lines from
  // the compare leaves that row matching nothing — it would surface as
  // "on the bill but NOT in the request", which is the same false alarm
  // this feature removes, wearing a different icon.
  const realOcr = vision.extractBales;
  vision.extractBales = async () => {
    ocrCalls += 1;
    return {
      ok: true,
      bales: [
        { packageNo: '6143', design: 'D1', shade: '3', thanNo: 3, yards: 90 },
        { packageNo: '6130', design: 'D1', shade: '3', thanNo: 3, yards: 90 },
        { packageNo: '6098', design: 'D1', shade: '3', thanNo: 5, yards: 150 },
      ],
    };
  };
  const r = await run(queue('S-MIX-SRC', [bale('6143'), bale('6130'), than('6098'), than('6098', 2)]));
  const msg = r.dms.join('\n');
  assert.ok(!/6098/.test(msg), `the excluded than's bale must not resurface: ${msg}`);
  assert.match(msg, /Verdict: 2 confirmed · 0 differ · 0 missing · 0 extra/);
  vision.extractBales = realOcr;
});

/* ── the whole bale that arrives disguised as thans ── */

test('VRF-3: "Take whole bale" IS a bale sale, even though every line says than', async () => {
  // bundleSaleService.buildApprovalPayload writes EVERY cart line as
  // type:'than', so a bale taken whole reaches the queue looking like five
  // loose pieces. Judging on shape alone would skip the exact case the
  // owner carved out. Inventory says bale 7001 has five thans; all five
  // are in this request, so it is going out whole.
  inventoryRepository.getAll = async () => ([1, 2, 3, 4, 5].map((thanNo) => ({
    packageNo: '7001', thanNo, design: 'D1', shade: '3', status: 'available', yards: 30,
  })));
  const realOcr = vision.extractBales;
  vision.extractBales = async () => {
    ocrCalls += 1;
    return { ok: true, bales: [{ packageNo: '7001', design: 'D1', shade: '3', thanNo: 5, yards: 150 }] };
  };

  const items = [1, 2, 3, 4, 5].map((n) => than('7001', n));
  const r = await run(queue('S-WHOLE', items, { totalYards: 150 }));

  assert.equal(r.verified, true, 'a complete bale is sold — the owner wants this checked');
  assert.equal(r.spentCredit, true);
  const msg = r.dms.join('\n');
  assert.match(msg, /✅ Bale 7001 — on the bill/);
  assert.match(msg, /Verdict: 1 confirmed · 0 differ · 0 missing · 0 extra/,
    'the five than lines collapse to ONE bale — five lines would report four missing');
  assert.ok(!/than item\(s\) not machine-checked/.test(msg),
    'nothing was left unchecked, so nothing is claimed to be');

  vision.extractBales = realOcr;
  inventoryRepository.getAll = async () => [];
});

test('VRF-3: a PARTIAL bale stays a than sale and is still skipped', async () => {
  // Bale 7001 has five thans; only two are being sold. That is the owner's
  // case — loose pieces, handwritten receipt, no bale row to read.
  inventoryRepository.getAll = async () => ([1, 2, 3, 4, 5].map((thanNo) => ({
    packageNo: '7001', thanNo, design: 'D1', shade: '3', status: 'available', yards: 30,
  })));
  const r = await run(queue('S-PARTIAL', [than('7001', 1), than('7001', 2)]));
  assert.equal(r.spentCredit, false, 'two of five is not a bale');
  inventoryRepository.getAll = async () => [];
});

test('VRF-3: an Inventory outage falls back to the shape, not to noise', async () => {
  // Unable to tell whether a bale is complete, the bot keeps the owner's
  // own description of the problem case — "the sale which is made in
  // thans" — rather than resurrecting ten false lines on every than sale.
  inventoryRepository.getAll = async () => { throw new Error('sheet unreachable'); };
  const r = await run(queue('S-INVDOWN', [than('7001', 1), than('7001', 2)]));
  assert.equal(r.spentCredit, false);
  assert.deepEqual(r.dms, []);
  inventoryRepository.getAll = async () => [];
});

/* ── fail-safe ── */

test('VRF-3: goods that cannot be classified are still checked', async () => {
  // A malformed request names no lines at all. Skipping here would drop a
  // verification silently; the rule is to check when unsure.
  const r = await run(queue('S-EMPTY', [], { totalYards: 60 }));
  assert.equal(r.spentCredit, true, 'uncertainty degrades TOWARDS verifying');
});

test('VRF-3: every earlier skip still works — nothing was traded away', async () => {
  // snap source
  const snap = queue('S-SNAP', [bale('6143')], { source: 'snap_pdf' });
  assert.equal((await run(snap)).spentCredit, false);
  // kill switch
  settingsRepository.getAll = async () => ({ PDF_VERIFY_ENABLED: 0 });
  assert.equal((await run(queue('S-OFF', [bale('6143')]))).spentCredit, false);
  settingsRepository.getAll = async () => ({});
  // no attached bill
  ROWS.set('S-NODOC', {
    requestId: 'S-NODOC', user: '4242', status: 'pending',
    actionJSON: { action: 'sale_bundle', items: [bale('6143')] },
  });
  assert.equal((await run('S-NODOC')).spentCredit, false);
});

test('VRF-3: VRF-2 still skips a store sale of whole bales', async () => {
  // Both rules are complementary: this one is a BALE sale, so VRF-3 would
  // check it — the store register is what declines it.
  locationsRepository.getAll = async () => ([
    { name: 'Kano office', location: 'Kano', kind: 'store', status: 'active' },
  ]);
  const r = await run(queue('S-STORE', [bale('6143', 'Kano office')]));
  assert.equal(r.spentCredit, false, 'VRF-2 was not traded away for VRF-3');
  locationsRepository.getAll = async () => [];
});

/* ── the classifier itself ── */

test('VRF-3: a line is a than by its own type, or by carrying a than number', () => {
  const { itemIsThan } = svc._internals;
  assert.equal(itemIsThan({ type: 'than', packageNo: '1' }), true);
  assert.equal(itemIsThan({ type: 'package', packageNo: '1' }), false);
  assert.equal(itemIsThan({ type: 'package', packageNo: '1', thanNo: 2 }), false,
    'an explicit type wins — a bale line is a bale');
  assert.equal(itemIsThan({ packageNo: '1', thanNo: 2 }), true, 'no type: the than number tells');
  assert.equal(itemIsThan({ packageNo: '1' }), false, 'no type, no than number: a whole bale');
  assert.equal(itemIsThan({ packageNo: '1', thanNo: '' }), false, 'an empty than number is not one');
  assert.equal(itemIsThan(null), false);
});

test('VRF-3: the approval card cannot show a clean ✅ for a half-checked sale', async () => {
  // The DM says the thans were skipped, but the CARD is what an approver
  // reads days later. Persisting the count keeps the two honest together.
  const patches = [];
  approvalQueueRepository.updateActionJSON = async (id, p) => { patches.push(p); return true; };
  await run(queue('S-CARD', [bale('6143'), bale('6130'), than('6098'), than('6067')]));
  assert.equal(patches[0].docVerify.thanUnchecked, 2);

  const approvalCards = require(path.join(SRC, 'services/approvalCards'));
  const line = approvalCards._internals
    ? approvalCards._internals.docVerifyLine
    : null;
  if (line) {
    const t = line({ docVerify: patches[0].docVerify });
    assert.match(t, /2 than not checked/);
    assert.ok(!t.endsWith('✅'), 'a partly-checked request must not read as fully clean');
  }
  approvalQueueRepository.updateActionJSON = async () => true;
});

test('VRF-3: a fully-checked sale persists no unchecked count', async () => {
  const patches = [];
  approvalQueueRepository.updateActionJSON = async (id, p) => { patches.push(p); return true; };
  await run(queue('S-CARD2', [bale('6143'), bale('6130')]));
  assert.equal(patches[0].docVerify.thanUnchecked, 0);
  approvalQueueRepository.updateActionJSON = async () => true;
});
