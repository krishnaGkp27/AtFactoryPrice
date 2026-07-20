/**
 * Anthropic (Claude) Vision provider — SNAP-2, 18-Jul-2026.
 *
 * Claude is markedly stronger than gpt-4o at reading handwriting, which is
 * exactly what bale-sack labels are: printed field names with handwritten
 * INDENT/BALE/DESIGN/COLOUR/PCS/MTR values. The photo goes up as a base64
 * image content block alongside the shared extraction prompt
 * (labelExtraction.PROMPT); adaptive thinking is enabled so the model can
 * deliberate over ambiguous digits before committing to a transcription.
 *
 * Model: config.ocr.anthropicModel, default claude-opus-4-8.
 * Activation: set ANTHROPIC_API_KEY (Railway) — with OCR_PROVIDER=auto the
 * dispatcher prefers this provider as soon as the key exists.
 *
 * Returns the uniform shape declared in vision/index.js; post-processing
 * (meters→yards, confidence sanity) is shared with the openai provider via
 * labelExtraction.mapParsedBales.
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');
const logger = require('../../utils/logger');
const { PROMPT, mapParsedBales, parseModelJson } = require('./labelExtraction');

let _client = null;
function getClient() {
  const key = (config.anthropic && config.anthropic.apiKey) || process.env.ANTHROPIC_API_KEY || '';
  if (!key) return null;
  if (!_client) _client = new Anthropic({ apiKey: key });
  return _client;
}

/** MIME types Claude's vision input accepts. */
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

async function extractBales(buffer, mimeType /* , opts */) {
  const client = getClient();
  if (!client) {
    return { ok: false, provider: 'anthropic', bales: [], rawText: '', overallConfidence: 0, warnings: [], error: 'ANTHROPIC_API_KEY is not configured.' };
  }
  const isPdf = mimeType === 'application/pdf';
  if (!isPdf && !IMAGE_MIMES.includes(mimeType)) {
    return { ok: false, provider: 'anthropic', bales: [], rawText: '', overallConfidence: 0, warnings: [], error: `File type ${mimeType} not supported by the anthropic provider — send a JPG/PNG photo or a PDF.` };
  }

  // SNAP-3: PDFs go up as a native document block (Claude reads every page
  // in ONE call — the whole supply run's labels together). Cost decision
  // (owner 20-Jul): Sonnet model, no extended thinking on the PDF path.
  const resp = await client.messages.create({
    model: isPdf ? config.ocr.anthropicPdfModel : config.ocr.anthropicModel,
    max_tokens: isPdf ? 4000 : 3000,
    ...(isPdf ? {} : { thinking: { type: 'adaptive' } }),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        isPdf
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
          : { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } },
      ],
    }],
  });

  const text = (Array.isArray(resp.content) ? resp.content : [])
    .filter((blk) => blk.type === 'text')
    .map((blk) => blk.text)
    .join('\n');
  const parsed = parseModelJson(text);
  if (!parsed) {
    logger.warn('vision/anthropic: JSON parse failed');
    return { ok: false, provider: 'anthropic', bales: [], rawText: '', overallConfidence: 0, warnings: [], error: 'Model returned unparseable output — try a clearer photo.' };
  }

  const { bales, warnings } = mapParsedBales(parsed);
  const overallConfidence = bales.length
    ? bales.reduce((s, b) => s + b.confidence, 0) / bales.length
    : 0;
  if (!bales.length) warnings.push('No bale rows recognised in the photo.');

  return {
    ok: bales.length > 0,
    provider: 'anthropic',
    bales,
    rawText: String(parsed.rawText || ''),
    overallConfidence,
    warnings,
    ...(bales.length ? {} : { error: 'No bale rows recognised.' }),
  };
}

module.exports = { extractBales };
