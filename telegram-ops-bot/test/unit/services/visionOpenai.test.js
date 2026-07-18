'use strict';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

/**
 * P5-C1/SNAP-1 — OpenAI vision provider: response parsing, meters→yards,
 * confidence clamping + sanity checks, and failure shapes. The network
 * call is mocked; the real round-trip is exercised in production only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const provider = require(path.join(SRC, 'services/vision/openai.js'));

// The provider builds its client at require time; tests patch the SDK's
// create() at the prototype level (see callWithMock below).
const OpenAI = require('openai');

test('label JSON parses into the uniform shape with meters→yards', async () => {
  // Drive the pure parsing path by calling through a patched client.
  const content = JSON.stringify({
    bales: [{ packageNo: '896', design: '77016', shade: '5', pcs: 5, meters: 150, indent: '2522', confidence: 0.92 }],
    rawText: 'BALE NO 896 DESIGN 77016 COLOUR 5',
  });
  const r = await callWithMock(content);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'openai');
  assert.equal(r.bales.length, 1);
  const b = r.bales[0];
  assert.equal(b.packageNo, '896');
  assert.equal(b.design, '77016');
  assert.equal(b.shade, '5');
  assert.equal(b.thanNo, 5);
  assert.equal(b.netMtrs, 150);
  assert.equal(b.yards, 164, '150 m → 164 yds');
  assert.equal(b.supplier, '2522');
  assert.ok(b.confidence > 0.9);
});

test('implausible meterage halves confidence with a warning; junk rows dropped', async () => {
  const content = JSON.stringify({
    bales: [
      { packageNo: '896', design: '77016', meters: 99999, confidence: 0.9 },
      { packageNo: '', design: '', meters: null, confidence: 0.9 },
    ],
    rawText: '',
  });
  const r = await callWithMock(content);
  assert.equal(r.bales.length, 1, 'row with no id dropped');
  assert.ok(r.bales[0].confidence <= 0.45, 'confidence halved');
  assert.match(r.warnings.join(' '), /implausible meterage/);
});

test('unparseable model output and PDFs fail cleanly', async () => {
  const bad = await callWithMock('this is not json');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unparseable/);
  const pdf = await provider.extractBales(Buffer.from('x'), 'application/pdf');
  assert.equal(pdf.ok, false);
  assert.match(pdf.error, /PDF input not supported|OPENAI_API_KEY/);
});

/** Invoke extractBales with the OpenAI SDK's create() mocked. */
async function callWithMock(content) {
  const origCreate = OpenAI.Chat && OpenAI.Chat.Completions && OpenAI.Chat.Completions.prototype.create;
  if (!origCreate) throw new Error('OpenAI SDK shape changed — update the test shim');
  OpenAI.Chat.Completions.prototype.create = async () => ({ choices: [{ message: { content } }] });
  try {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
    return await provider.extractBales(Buffer.from('fake-image-bytes'), 'image/jpeg');
  } finally {
    OpenAI.Chat.Completions.prototype.create = origCreate;
  }
}
