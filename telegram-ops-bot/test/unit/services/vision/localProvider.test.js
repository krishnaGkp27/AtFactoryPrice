'use strict';
/**
 * VRF-6 — the local bill reader. No network, no Tesseract, no PDF library:
 * the two readers are injected through _internals.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const local = require(path.join(__dirname, '../../../../src/services/vision/local.js'));
const { balesFromText } = local;

test('balesFromText: keyed numbers win, in document order, once each', () => {
  const r = balesFromText('BALE NO: 1234  Bale 1235 yds 150\nPkg# 1236  bale no 1234  No. 7788');
  assert.equal(r.method, 'keyed');
  assert.deepEqual(r.bales.map((b) => b.packageNo), ['1234', '1235', '1236', '7788']);
  assert.ok(r.bales.every((b) => b.confidence === 0.95));
  assert.deepEqual(r.warnings, []);
});

test('balesFromText: no keyword → every 3–7 digit number, quantities / years / dates skipped, with a warning', () => {
  const r = balesFromText('1148 150 yds · 1100 30 m · 2026 · 04/11/2026 · 6189 18.5 kg · 772');
  assert.equal(r.method, 'all-numbers');
  assert.deepEqual(r.bales.map((b) => b.packageNo), ['1148', '1100', '6189', '772']);
  assert.ok(r.bales.every((b) => b.confidence === 0.6));
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /No 'bale' keyword/);
});

test('balesFromText: OCR word confidence lowers a number, never raises it', () => {
  const conf = new Map([['1148', 0.4], ['1100', 0.99]]);
  const r = balesFromText('Bale 1148 Bale 1100', conf);
  assert.equal(r.bales[0].confidence, 0.4);
  assert.equal(r.bales[1].confidence, 0.95);
});

test('balesFromText: empty text → nothing, no warning', () => {
  const r = balesFromText('');
  assert.deepEqual(r.bales, []);
  assert.deepEqual(r.warnings, []);
});

test('extractBales: a PDF with a text layer answers from the text, no OCR', async () => {
  let ocrCalls = 0;
  local._internals.setPdfText(async () => 'INVOICE  Bale 1148  Bale 1100  Bale 6189');
  local._internals.setRecognizer(async () => { ocrCalls += 1; return { text: '', words: [] }; });
  const r = await local.extractBales(Buffer.from('%PDF-1.4 fake'), 'application/pdf');
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'local');
  assert.equal(r.method, 'pdf-text/keyed');
  assert.deepEqual(r.bales.map((b) => b.packageNo), ['1148', '1100', '6189']);
  assert.equal(ocrCalls, 0);
  assert.ok(r.overallConfidence > 0.9);
});

test('extractBales: a photo goes through the recognizer; word confidence rides along', async () => {
  local._internals.setPdfText(null);
  local._internals.setRecognizer(async (png) => {
    assert.ok(Buffer.isBuffer(png));
    return { text: 'BALE 1148\nBALE 1100', words: [{ text: '1148', confidence: 88 }, { text: '1100', confidence: 41 }] };
  });
  // a real 1×1 PNG so sharp can decode it
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const r = await local.extractBales(png, 'image/png');
  assert.equal(r.ok, true);
  assert.equal(r.method, 'photo/keyed');
  assert.deepEqual(r.bales.map((b) => [b.packageNo, b.confidence]), [['1148', 0.88], ['1100', 0.41]]);
});

test('extractBales: an unreadable photo fails honestly, never throws', async () => {
  local._internals.setRecognizer(async () => ({ text: 'nothing legible here', words: [] }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const r = await local.extractBales(png, 'image/png');
  assert.equal(r.ok, false);
  assert.equal(r.provider, 'local');
  assert.match(r.error, /no bale numbers/);
  assert.deepEqual(r.bales, []);
});

test('extractBales: an unsupported type is refused', async () => {
  const r = await local.extractBales(Buffer.from('x'), 'text/plain');
  assert.equal(r.ok, false);
  assert.match(r.error, /unsupported/);
});

test('extractBales: a PDF with no text and no photographs says so', async () => {
  local._internals.setPdfText(async () => '');
  // a real, minimal, image-less PDF built by pdf-lib
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const bytes = Buffer.from(await doc.save());
  const r = await local.extractBales(bytes, 'application/pdf');
  assert.equal(r.ok, false);
  assert.match(r.error, /no text layer and no photographs/);
  local._internals.setPdfText(null);
});

test('vision index, auto chain: local cannot read → the next provider answers; local reads → it answers alone', async () => {
  const idx = require(path.join(__dirname, '../../../../src/services/vision/index.js'));
  const savedLocal = idx.PROVIDERS.local;
  const savedAnth = idx.PROVIDERS.anthropic;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  let paidCalls = 0;
  idx.PROVIDERS.anthropic = { extractBales: async () => { paidCalls += 1; return { ok: true, provider: 'anthropic', bales: [{ packageNo: '77', confidence: 0.9 }], rawText: '' }; } };
  try {
    idx.PROVIDERS.local = { extractBales: async () => ({ ok: false, provider: 'local', bales: [], rawText: '', warnings: [], error: 'photo could not be read' }) };
    const a = await idx.extractBales(Buffer.from('x'), 'image/jpeg', { providerOverride: 'auto' });
    assert.equal(a.ok, true);
    assert.equal(a.provider, 'anthropic', 'the paid provider answered after the local try');
    assert.equal(paidCalls, 1);
    idx.PROVIDERS.local = { extractBales: async () => ({ ok: true, provider: 'local', method: 'photo/keyed', bales: [{ packageNo: '1148', confidence: 0.95 }], rawText: 'Bale 1148', warnings: [] }) };
    const b = await idx.extractBales(Buffer.from('x'), 'image/jpeg', { providerOverride: 'auto' });
    assert.equal(b.provider, 'local');
    assert.equal(b.method, 'photo/keyed', 'the reader name rides through normalise');
    assert.equal(paidCalls, 1, 'a successful local read never spends a paid call');
    // forced local (OCR_PROVIDER=local): a failure is reported, nothing else tried
    idx.PROVIDERS.local = { extractBales: async () => ({ ok: false, provider: 'local', bales: [], rawText: '', warnings: [], error: 'no bale numbers recognised' }) };
    const c = await idx.extractBales(Buffer.from('x'), 'image/jpeg', { providerOverride: 'local' });
    assert.equal(c.ok, false);
    assert.equal(c.provider, 'local');
    assert.match(c.error, /no bale numbers/);
    assert.equal(paidCalls, 1);
  } finally {
    idx.PROVIDERS.local = savedLocal;
    idx.PROVIDERS.anthropic = savedAnth;
    if (savedKey == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test('vision index: local is a registered provider, first in the auto chain, uncapped', async () => {
  const idx = require(path.join(__dirname, '../../../../src/services/vision/index.js'));
  const chain = idx._internals && idx._internals.resolveChain ? idx._internals.resolveChain('auto') : null;
  if (chain) assert.equal(chain[0], 'local');
  const src = require('fs').readFileSync(path.join(__dirname, '../../../../src/services/vision/index.js'), 'utf8');
  assert.match(src, /local: require\('\.\/local'\)/);
  assert.match(src, /const chain = \['local'\]/);
  assert.match(src, /providerName === 'stub' \|\| providerName === 'local'/);
});
