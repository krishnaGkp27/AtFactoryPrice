'use strict';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

/**
 * SNAP-2 — Anthropic (Claude) vision provider: response parsing (text
 * blocks after adaptive thinking), code-fence tolerance, meters→yards,
 * failure shapes, and the dispatcher's OCR_PROVIDER=auto chain. The
 * network call is mocked; the real round-trip is exercised in production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const provider = require(path.join(SRC, 'services/vision/anthropic.js'));
const vision = require(path.join(SRC, 'services/vision'));

// Patch the SDK's create() at the prototype level, same trick as the
// openai provider tests.
const { Messages } = require('@anthropic-ai/sdk/resources/messages');

async function callWithMock(contentBlocks, fn) {
  const origCreate = Messages && Messages.prototype && Messages.prototype.create;
  if (!origCreate) throw new Error('Anthropic SDK shape changed — update the test shim');
  Messages.prototype.create = async () => ({ content: contentBlocks });
  try {
    return await (fn ? fn() : provider.extractBales(Buffer.from('fake-image-bytes'), 'image/jpeg'));
  } finally {
    Messages.prototype.create = origCreate;
  }
}

test('label JSON parses into the uniform shape, skipping thinking blocks', async () => {
  const json = JSON.stringify({
    bales: [{ packageNo: '896', design: '77016', shade: '5', pcs: 5, meters: 150, indent: '2522', confidence: 0.92 }],
    rawText: 'BALE NO 896 DESIGN 77016 COLOUR 5',
  });
  const r = await callWithMock([
    { type: 'thinking', thinking: 'the handwriting reads 896…' },
    { type: 'text', text: json },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'anthropic');
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

test('code-fenced JSON is tolerated; implausible meterage halves confidence', async () => {
  const json = JSON.stringify({
    bales: [
      { packageNo: '896', design: '77016', meters: 99999, confidence: 0.9 },
      { packageNo: '', design: '', meters: null, confidence: 0.9 },
    ],
    rawText: '',
  });
  const r = await callWithMock([{ type: 'text', text: '```json\n' + json + '\n```' }]);
  assert.equal(r.ok, true, 'fenced JSON still parsed');
  assert.equal(r.bales.length, 1, 'row with no id dropped');
  assert.ok(r.bales[0].confidence <= 0.45, 'confidence halved');
  assert.match(r.warnings.join(' '), /implausible meterage/);
});

test('unparseable output, unsupported mime, and missing key fail cleanly', async () => {
  const bad = await callWithMock([{ type: 'text', text: 'sorry, no JSON here' }]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unparseable/);
  const pdf = await provider.extractBales(Buffer.from('x'), 'application/pdf');
  assert.equal(pdf.ok, false);
  assert.match(pdf.error, /not supported by the anthropic provider|ANTHROPIC_API_KEY/);
});

test('OCR_PROVIDER=auto routes to anthropic when its key exists', async () => {
  const json = JSON.stringify({ bales: [{ packageNo: '896', design: '77016', confidence: 0.9 }], rawText: '' });
  const r = await callWithMock([{ type: 'text', text: json }], () =>
    vision.extractBales(Buffer.from('fake-image-bytes'), 'image/jpeg', { providerOverride: 'auto' }));
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'anthropic', 'auto chain preferred Claude');
});

test('auto chain falls through to openai when the anthropic call throws', async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const OpenAI = require('openai');
  const origOpenai = OpenAI.Chat.Completions.prototype.create;
  OpenAI.Chat.Completions.prototype.create = async () => ({
    choices: [{ message: { content: JSON.stringify({ bales: [{ packageNo: '77', design: '88', confidence: 0.8 }], rawText: '' }) } }],
  });
  const origCreate = Messages.prototype.create;
  Messages.prototype.create = async () => { throw new Error('529 overloaded'); };
  try {
    const r = await vision.extractBales(Buffer.from('fake-image-bytes'), 'image/jpeg', { providerOverride: 'auto' });
    assert.equal(r.ok, true, 'fell through to the next provider');
    assert.equal(r.provider, 'openai');
    assert.equal(r.bales[0].packageNo, '77');
  } finally {
    Messages.prototype.create = origCreate;
    OpenAI.Chat.Completions.prototype.create = origOpenai;
  }
});
