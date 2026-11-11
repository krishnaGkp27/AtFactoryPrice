'use strict';
/**
 * VRF-6 fix (11-Nov-2026) — the local bill reader reads bale NUMBERS only.
 *
 * The fault: a row the reader returned without a piece count left the
 * dispatcher (`vision/index.js` normalise) carrying its POSITION on the
 * paper as `thanNo` (1, 2, 3 …), and the bill check compared that with the
 * bale's than count — a bale that IS on the bill read
 * `pcs: bill says 1, request says 5`, and with most lines flagged the
 * marks went off.
 *
 * Pinned here: the reader states "no count read" (0), the dispatcher keeps
 * it, the verifier compares a count only when one was read from the paper,
 * and an unknown count never counts towards the flagged share that drives
 * the `marks off` rule. A provider that does read counts is unchanged.
 *
 * No network, no Tesseract, no PDF library: the readers are injected.
 */
process.env.ADMIN_IDS = '777,888';
process.env.OCR_ENABLED = 'true';
process.env.OCR_PROVIDER = 'local';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '..', '..', '..', '..', 'src');
const local = require(path.join(SRC, 'services/vision/local'));
const vision = require(path.join(SRC, 'services/vision'));
const { mapParsedBales } = require(path.join(SRC, 'services/vision/labelExtraction'));
const svc = require(path.join(SRC, 'services/saleDocVerifyService'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const designAssetsRepository = require(path.join(SRC, 'repositories/designAssetsRepository'));
const locationService = require(path.join(SRC, 'services/locationService'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const { compareItemsToLabels, docVerifyRecord, buildVerdictMessage, runCheck } = svc._internals;

settingsRepository.getAll = async () => ({});
designAssetsRepository.getAll = async () => [];
designAssetsRepository.findActive = async () => null;
designAssetsRepository.findLatest = async () => null;
locationService.shipsOnlyFromStores = async () => false;
telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('%PDF-1.4 fake'), mimeType: 'application/pdf' });

const PDF = Buffer.from('%PDF-1.4 fake');
// a real 1×1 PNG so sharp can decode it
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** The bill as the local reader + the dispatcher hand it to the bill check. */
async function readLocal(text) {
  local._internals.setPdfText(async () => text);
  try {
    return await vision.extractBales(PDF, 'application/pdf', { providerOverride: 'local' });
  } finally {
    local._internals.setPdfText(null);
  }
}

/* ── the reader's output shape ───────────────────────────────────────── */

test('reader: every bale number is reported with NO piece count (thanNo 0), keyed or not', () => {
  const keyed = local.balesFromText('Bale 1148  Bale 1100  Bale 6189');
  assert.deepEqual(keyed.bales.map((b) => [b.packageNo, b.thanNo]), [['1148', 0], ['1100', 0], ['6189', 0]]);
  const loose = local.balesFromText('1148 150 yds · 1100 30 m · 772');
  assert.deepEqual(loose.bales.map((b) => [b.packageNo, b.thanNo]), [['1148', 0], ['1100', 0], ['772', 0]]);
});

test('reader: a typed PDF and a photo both come back with no count on any row', async () => {
  local._internals.setPdfText(async () => 'INVOICE  Bale No: 1234  Bale No: 1235  Bale No: 1236');
  local._internals.setRecognizer(async () => ({ text: 'BALE 1148\nBALE 1100', words: [{ text: '1148', confidence: 88 }] }));
  try {
    const pdf = await local.extractBales(PDF, 'application/pdf');
    assert.equal(pdf.ok, true);
    assert.deepEqual(pdf.bales.map((b) => [b.packageNo, b.thanNo]), [['1234', 0], ['1235', 0], ['1236', 0]]);
    const photo = await local.extractBales(PNG, 'image/png');
    assert.equal(photo.ok, true);
    assert.deepEqual(photo.bales.map((b) => [b.packageNo, b.thanNo]), [['1148', 0], ['1100', 0]]);
  } finally {
    local._internals.setPdfText(null);
    local._internals.setRecognizer(null);
  }
});

test('dispatcher: a local read keeps "no count" on every row — never the row\'s position on the paper', async () => {
  const r = await readLocal('Bale No: 1234  Bale No: 1235  Bale No: 1236  Bale No: 1237  Bale No: 1238');
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'local');
  assert.deepEqual(r.bales.map((b) => b.packageNo), ['1234', '1235', '1236', '1237', '1238'], 'document order kept (VRF-5)');
  assert.deepEqual(r.bales.map((b) => b.thanNo), [0, 0, 0, 0, 0], 'not 1, 2, 3, 4, 5');
  assert.ok(r.bales.every((b) => b.yards === 0 && b.design === '' && b.shade === ''), 'nothing else is made up either');
});

test('dispatcher: a provider that DOES read counts is passed through exactly as before', async () => {
  const saved = vision.PROVIDERS.counted;
  vision.PROVIDERS.counted = {
    extractBales: async () => ({
      ok: true, provider: 'counted', rawText: '', warnings: [],
      // what the paid label readers return: pcs read → the number; pcs unread → 0
      bales: mapParsedBales({ bales: [
        { packageNo: '896', design: '77016', shade: '5', pcs: 5, meters: 137, confidence: 0.9 },
        { packageNo: '897', design: '77016', shade: '5', pcs: null, meters: null, confidence: 0.9 },
        { packageNo: '898', design: '77016', shade: '5', pcs: '4', meters: 110, confidence: 0.9 },
      ] }).bales,
    }),
  };
  try {
    const r = await vision.extractBales(PNG, 'image/png', { providerOverride: 'counted' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.bales.map((b) => [b.packageNo, b.thanNo]), [['896', 5], ['897', 0], ['898', 4]]);
    assert.equal(r.bales[0].yards, 150);
  } finally {
    if (saved === undefined) delete vision.PROVIDERS.counted; else vision.PROVIDERS.counted = saved;
  }
  // The stub's per-than receive rows (Photo Receive) keep their own than numbers.
  const stub = await vision.extractBales(PNG, 'image/png', { providerOverride: 'stub' });
  assert.deepEqual(stub.bales.map((b) => b.thanNo), [1, 2, 3, 4, 5]);
});

/* ── the verifier ────────────────────────────────────────────────────── */

const item = (no, thans = 5) => ({ packageNo: String(no), design: '9006', shade: 'BLACK', thans, yards: thans * 30 });
/** Inventory rows of sealed 5-than bales, for the card's own enrichment. */
const stockOf = (nos) => nos.flatMap((no) => [1, 2, 3, 4, 5].map((t) => ({
  packageNo: String(no), thanNo: t, design: '9006', shade: 'BLACK', yards: 30, status: 'available', warehouse: 'Lagos',
})));

test('verifier: count unknown → not compared, the bale found on the bill is confirmed', () => {
  for (const unknown of [0, null, undefined, '', '0']) {
    const { results, extras } = compareItemsToLabels([item(1234)], [{ packageNo: '1234', thanNo: unknown }]);
    assert.equal(results[0].status, 'ok', `thanNo ${JSON.stringify(unknown)} → confirmed`);
    assert.deepEqual(results[0].diffs, []);
    assert.deepEqual(results[0].notes, [], 'no invented "partial" note either');
    assert.deepEqual(extras, []);
  }
  const { results, extras } = compareItemsToLabels([item(1234)], [{ packageNo: '1234', thanNo: 0 }]);
  assert.equal(buildVerdictMessage('REQ1', results, extras),
    '🔬 Bill check — request REQ1\n✅ Bale 1234 — on the bill\n\nVerdict: 1 confirmed · 0 differ · 0 missing · 0 extra\nThe bill and the request agree.');
});

test('verifier: a count really read and DIFFERENT (fewer pieces on the paper) is flagged, as before', () => {
  const { results } = compareItemsToLabels([item(1234)], [{ packageNo: '1234', thanNo: 3 }]);
  assert.equal(results[0].status, 'differs');
  assert.deepEqual(results[0].diffs, ['pcs: bill says 3, request says 5']);
});

test('verifier: a count really read and EQUAL is confirmed; more pieces on the label than sold stays a note (VRF-1b)', () => {
  const same = compareItemsToLabels([item(1234)], [{ packageNo: '1234', thanNo: 5 }]).results[0];
  assert.equal(same.status, 'ok');
  assert.deepEqual(same.notes, []);
  const partial = compareItemsToLabels([item(1234, 2)], [{ packageNo: '1234', thanNo: 5 }]).results[0];
  assert.equal(partial.status, 'ok');
  assert.deepEqual(partial.notes, ['partial: selling 2 of the 5 pcs on the label']);
});

test('verifier + local read: every bale on the bill is confirmed whatever its position on the paper', async () => {
  // Seven sealed 5-than bales; the bill lists them 1st … 7th. Before the fix
  // position 1–4 read "pcs: bill says N, request says 5", position 5 passed
  // by luck and 6–7 got an invented "partial" note.
  const nos = ['1234', '1235', '1236', '1237', '1238', '1239', '1240'];
  const ocr = await readLocal(nos.map((n) => `Bale No: ${n}`).join('  150 yds\n'));
  const { results, extras } = compareItemsToLabels(nos.map((n) => item(n)), ocr.bales);
  assert.deepEqual(results.map((r) => r.status), nos.map(() => 'ok'));
  assert.ok(results.every((r) => !r.diffs.length && !r.notes.length));
  assert.deepEqual(extras, []);
  const rec = docVerifyRecord(results, extras, { provider: ocr.provider });
  assert.deepEqual([rec.ok, rec.differs, rec.missing, rec.extra], [7, 0, 0, 0]);
  assert.deepEqual(rec.okNos, nos);
  assert.deepEqual(rec.okNoted, []);
  assert.deepEqual(rec.billSeq, nos);
});

/* ── the flagged share behind the `marks off` rule ───────────────────── */

test('marks: an unknown count is not a flag — 0 of 4 flagged keeps the ticks on; one bale off the bill is the only red dot', async () => {
  const nos = ['483', '490', '526', '577'];
  const items = nos.map((n) => ({ ...item(n), type: 'package', warehouse: 'Lagos' }));

  const all = await readLocal('Bale 483\nBale 490\nBale 526\nBale 577');
  const a = compareItemsToLabels(items, all.bales);
  const recAll = docVerifyRecord(a.results, a.extras, { provider: 'local' });
  const marksAll = approvalCards.billMarks(recAll, 75);
  assert.equal(marksAll.checked, 4);
  assert.equal(recAll.differs + recAll.missing, 0, 'flagged share 0%');
  assert.equal(marksAll.marksOff, false);
  assert.equal(approvalCards.billMarks(recAll, 0).marksOff, false, 'even a 0% cut stays on: nothing at all is flagged');
  assert.deepEqual(nos.map((n) => marksAll.markOf(n)), [' ✅', ' ✅', ' ✅', ' ✅']);

  // 526 is not on the paper: 1 of 4 = 25% flagged, under the 75% cut.
  const three = await readLocal('Bale 483\nBale 490\nBale 577');
  const b = compareItemsToLabels(items, three.bales);
  const rec = docVerifyRecord(b.results, b.extras, { provider: 'local' });
  assert.deepEqual([rec.ok, rec.differs, rec.missing, rec.extra], [3, 0, 1, 0]);
  const marks = approvalCards.billMarks(rec, 75);
  assert.equal(marks.marksOff, false, '25% is not above 75');
  assert.deepEqual(nos.map((n) => marks.markOf(n)), [' ✅', ' ✅', ' 🔴', ' ✅']);
  inventoryRepository.getAll = async () => stockOf(nos);
  const card = await approvalCards.buildSaleBundleCard({ action: 'sale_bundle', items, docVerify: rec, totalYards: 600 });
  assert.match(card, /\n {2}1\. 483 · 150 yd ✅\n {2}2\. 490 · 150 yd ✅\n {2}3\. 577 · 150 yd ✅\n {2}4\. 526 · 150 yd 🔴\n/, card);
  assert.match(card, /\n🔬 Bill check \(local\): 3 confirmed · 0 differ · 1 missing · 0 extra ⚠️\n {2}❌ 526 not on bill$/, card);
  assert.ok(!/marks off/.test(card), card);
});

test('marks: counts really read and short on most bales still switch the marks off (a counting reader, unchanged)', () => {
  const nos = ['483', '490', '526', '577'];
  const labels = nos.map((n, i) => ({ packageNo: n, thanNo: i === 0 ? 5 : 3 })); // three labels show 3 pcs, the request sells 5
  const { results, extras } = compareItemsToLabels(nos.map((n) => item(n)), labels);
  const rec = docVerifyRecord(results, extras);
  assert.deepEqual([rec.ok, rec.differs, rec.missing], [1, 3, 0]);
  assert.equal(approvalCards.billMarks(rec, 50).marksOff, true, '75% flagged > 50');
  assert.equal(approvalCards.billMarks(rec, 75).marksOff, false, '75% is not above 75');
});

/* ── the whole check, as the approval card runs it ───────────────────── */

test('bill check with OCR_PROVIDER=local: two sealed bales on a typed bill → both confirmed, ticks on, "(local)" on the line', async () => {
  // The typed sell line loads a whole bale as its thans (type 'than'); the
  // check counts them against Inventory and compares the bale as one.
  const thanLines = (no) => [1, 2, 3, 4, 5].map((t) => ({ type: 'than', packageNo: no, thanNo: t, design: '9006', shade: 'BLACK', thans: 1, yards: 30, warehouse: 'Lagos' }));
  const aj = {
    action: 'sale_bundle', customer: 'ABBA', sale_doc_file_id: 'bill-1', sale_doc_type: 'document',
    items: [...thanLines('1234'), ...thanLines('1235')],
  };
  inventoryRepository.getAll = async () => stockOf(['1234', '1235']);
  const saved = {};
  approvalQueueRepository.updateActionJSON = async (id, p) => { Object.assign(saved, p); return true; };
  const sent = [];
  const bot = { sendMessage: async (chatId, text) => { sent.push(`${chatId}:${text}`); return { message_id: sent.length }; } };

  local._internals.setPdfText(async () => 'SALES BILL\nBale No: 1234   9006 BLACK   150 yds\nBale No: 1235   9006 BLACK   150 yds\n');
  let out;
  try {
    out = await runCheck(bot, aj, 'REQ-L1', { admins: ['777'] });
  } finally {
    local._internals.setPdfText(null);
  }
  assert.equal(out.status, 'done');
  assert.deepEqual(sent, [
    '777:🔬 Bill check — request REQ-L1\n✅ Bale 1234 — on the bill\n✅ Bale 1235 — on the bill\n\n'
    + 'Verdict: 2 confirmed · 0 differ · 0 missing · 0 extra\nThe bill and the request agree.',
  ]);
  const rec = saved.docVerify;
  assert.equal(rec.provider, 'local');
  assert.deepEqual([rec.ok, rec.differs, rec.missing, rec.extra], [2, 0, 0, 0]);
  assert.deepEqual(rec.differRows, []);
  assert.deepEqual(rec.billSeq, ['1234', '1235']);
  const marks = approvalCards.billMarks(rec, 75);
  assert.equal(marks.marksOff, false);
  assert.equal(marks.markOf('1234'), ' ✅');
  assert.equal(marks.markOf('1235'), ' ✅');
  // The card every admin opens is rebuilt from the saved record.
  const card = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', docVerify: rec, totalYards: 300,
    items: ['1234', '1235'].map((n) => ({ type: 'package', packageNo: n, design: '9006', shade: 'BLACK', thans: 5, yards: 150, warehouse: 'Lagos' })),
  });
  assert.match(card, /\n {2}1\. 1234 · 150 yd ✅\n {2}2\. 1235 · 150 yd ✅\n🔬 Bill check \(local\): 2 confirmed · 0 differ · 0 missing · 0 extra ✅$/, card);
  assert.ok(!/🔴|marks off/.test(card), card);
});
