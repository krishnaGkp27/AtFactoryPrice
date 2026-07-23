'use strict';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

/**
 * SNAP-5 — big-PDF chunking (owner's real 46-page dispatch PDF failed with
 * "Model returned unparseable output": the 46-label JSON overflowed a 4k
 * max_tokens and arrived truncated). Pins: pdf-lib splitting, one Claude
 * call per chunk with the raised token budget, merged results, per-chunk
 * failure tolerance, and the truncation-salvage parser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const { PDFDocument } = require('pdf-lib');
const pdfChunk = require(path.join(SRC, 'services/vision/pdfChunk.js'));
const { salvageTruncatedBales } = require(path.join(SRC, 'services/vision/labelExtraction.js'));
const provider = require(path.join(SRC, 'services/vision/anthropic.js'));
const { Messages } = require('@anthropic-ai/sdk/resources/messages');

async function makePdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

function baleJson(n) {
  return JSON.stringify({ bales: [{ packageNo: String(n), design: '77016', shade: '5', confidence: 0.9 }], rawText: `p${n}` });
}

test('splitPdf: 35 pages at 15/chunk → 3 chunks with correct 1-based ranges', async () => {
  const buf = await makePdf(35);
  assert.equal(await pdfChunk.pageCount(buf), 35);
  const chunks = await pdfChunk.splitPdf(buf, 15);
  assert.deepEqual(chunks.map((c) => [c.fromPage, c.toPage]), [[1, 15], [16, 30], [31, 35]]);
  assert.equal(await pdfChunk.pageCount(chunks[0].buffer), 15);
  assert.equal(await pdfChunk.pageCount(chunks[2].buffer), 5);
});

test('splitPdf: a PDF within the limit returns the ORIGINAL buffer as one chunk', async () => {
  const buf = await makePdf(10);
  const chunks = await pdfChunk.splitPdf(buf, 15);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].buffer, buf, 'no re-save for small PDFs');
  assert.deepEqual([chunks[0].fromPage, chunks[0].toPage], [1, 10]);
});

test('salvageTruncatedBales: recovers complete rows from JSON cut off mid-array', () => {
  const cut = '{"bales":[{"packageNo":"600","design":"77016","confidence":0.9},'
    + '{"packageNo":"601","design":"77016","confidence":0.85},{"packageNo":"602","desi';
  const out = salvageTruncatedBales(cut);
  assert.equal(out.bales.length, 2, 'two complete rows recovered, broken tail dropped');
  assert.equal(out.bales[1].packageNo, '601');
  assert.equal(out._truncated, true);
  assert.equal(salvageTruncatedBales('sorry, no JSON here'), null);
});

test('big PDF → one Claude call per chunk at the raised token budget, results merged', async () => {
  const buf = await makePdf(35);
  const reqs = [];
  const orig = Messages.prototype.create;
  Messages.prototype.create = async (req) => {
    reqs.push(req);
    return { content: [{ type: 'text', text: baleJson(reqs.length) }] };
  };
  try {
    const r = await provider.extractBales(buf, 'application/pdf');
    assert.equal(reqs.length, 3, 'one call per 15-page chunk');
    assert.equal(r.ok, true);
    assert.deepEqual(r.bales.map((b) => b.packageNo), ['1', '2', '3'], 'chunk results merged in page order');
    assert.equal(r.rawText, 'p1\np2\np3');
    for (const req of reqs) {
      assert.equal(req.max_tokens, provider._internals.PDF_MAX_TOKENS, 'raised answer budget');
      assert.equal(req.model, 'claude-sonnet-4-6');
      assert.equal(req.thinking, undefined, 'still no extended thinking on the PDF path');
      assert.ok(req.messages[0].content.some((b) => b.type === 'document'), 'each chunk is a document block');
    }
  } finally {
    Messages.prototype.create = orig;
  }
});

test('SNAP-7: a small PDF (≤6 pages) uses the STRONG photo model WITH thinking', async () => {
  const buf = await makePdf(3); // a verification bill
  let captured = null;
  const orig = Messages.prototype.create;
  Messages.prototype.create = async (req) => { captured = req; return { content: [{ type: 'text', text: baleJson(1) }] }; };
  try {
    const r = await provider.extractBales(buf, 'application/pdf');
    assert.equal(r.ok, true);
    assert.equal(captured.model, 'claude-opus-4-8', 'rotated low-light handwriting needs the photo model');
    assert.deepEqual(captured.thinking, { type: 'adaptive' }, 'thinking ON for small PDFs');
  } finally {
    Messages.prototype.create = orig;
  }
});

test('VRF-1: forceStrongModel puts an 11-page verification bill on the strong model + thinking, every chunk', async () => {
  const reqs = [];
  const orig = Messages.prototype.create;
  Messages.prototype.create = async (req) => {
    reqs.push(req);
    return { content: [{ type: 'text', text: baleJson(reqs.length) }] };
  };
  try {
    // 11 pages > smartPdfMaxPages (6): without the flag this would be the
    // fast PDF model — the routing that misread the owner's clean bill.
    const bill = await makePdf(11);
    const r = await provider.extractBales(bill, 'application/pdf', { forceStrongModel: true });
    assert.equal(r.ok, true);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].model, 'claude-opus-4-8',
      'verification bills always earn the strong model (owner: precision over cost)');
    assert.deepEqual(reqs[0].thinking, { type: 'adaptive' }, 'thinking ON regardless of page count');

    // A forced PDF big enough to chunk keeps the strong model on EVERY chunk.
    reqs.length = 0;
    await provider.extractBales(await makePdf(20), 'application/pdf', { forceStrongModel: true });
    assert.equal(reqs.length, 2, 'two 15-page chunks');
    for (const req of reqs) {
      assert.equal(req.model, 'claude-opus-4-8', 'each verification chunk carries the strong model');
      assert.deepEqual(req.thinking, { type: 'adaptive' });
    }

    // Without the flag the SNAP-7 page-count routing is untouched —
    // dispatch intake PDFs keep the cost-efficient model.
    reqs.length = 0;
    await provider.extractBales(bill, 'application/pdf');
    assert.equal(reqs[0].model, 'claude-sonnet-4-6', '11 unforced pages stay on the fast PDF model');
    assert.equal(reqs[0].thinking, undefined);
  } finally {
    Messages.prototype.create = orig;
  }
});

test('one failing chunk does not kill the batch — its pages are reported missing', async () => {
  const buf = await makePdf(35);
  let call = 0;
  const orig = Messages.prototype.create;
  Messages.prototype.create = async () => {
    call += 1;
    if (call === 2) throw new Error('529 overloaded');
    return { content: [{ type: 'text', text: baleJson(call) }] };
  };
  try {
    const r = await provider.extractBales(buf, 'application/pdf');
    assert.equal(r.ok, true, 'partial success is still success');
    assert.deepEqual(r.bales.map((b) => b.packageNo), ['1', '3']);
    assert.match(r.warnings.join(' '), /pages 16–30.*missing/, 'the missing range is named');
  } finally {
    Messages.prototype.create = orig;
  }
});

test('a truncated chunk is salvaged row-by-row with a cut-short warning', async () => {
  const buf = await makePdf(5); // single chunk
  const cut = '{"bales":[{"packageNo":"700","design":"88001","confidence":0.9},{"packageNo":"701","de';
  const orig = Messages.prototype.create;
  Messages.prototype.create = async () => ({ content: [{ type: 'text', text: cut }] });
  try {
    const r = await provider.extractBales(buf, 'application/pdf');
    assert.equal(r.ok, true);
    assert.deepEqual(r.bales.map((b) => b.packageNo), ['700'], 'complete rows survive the cut');
    assert.match(r.warnings.join(' '), /cut short/);
  } finally {
    Messages.prototype.create = orig;
  }
});

test('every chunk failing on the API rethrows so the auto chain can fall through', async () => {
  const buf = await makePdf(20);
  const orig = Messages.prototype.create;
  Messages.prototype.create = async () => { throw new Error('529 overloaded'); };
  try {
    await assert.rejects(() => provider.extractBales(buf, 'application/pdf'), /529 overloaded/);
  } finally {
    Messages.prototype.create = orig;
  }
});
