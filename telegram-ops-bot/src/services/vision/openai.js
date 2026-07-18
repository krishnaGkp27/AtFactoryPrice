/**
 * OpenAI Vision provider (P5-C1, implemented 18-Jul-2026 for SNAP-1).
 *
 * Sends the photo as a data-URL to the configured vision model
 * (config.ocr.openaiModel, default gpt-4o) with an extract-as-JSON prompt
 * tuned for this trade's documents: bale-sack shipping labels (handwritten
 * INDENT/BALE/DESIGN/COLOUR/PCS/MTR values) and packing-list style photos
 * with one row per bale/than.
 *
 * Returns the uniform shape declared in vision/index.js. Confidence is the
 * model's own per-row self-report, clamped and sanity-checked (meterage
 * outside 1..2000 halves the row's confidence rather than dropping data —
 * the review UI decides, we never auto-commit).
 */

'use strict';

const OpenAI = require('openai');
const config = require('../../config');
const logger = require('../../utils/logger');
const { PROMPT, mapParsedBales } = require('./labelExtraction');

let _client = null;
function getClient() {
  const key = (config.openai && config.openai.apiKey) || process.env.OPENAI_API_KEY || '';
  if (!key) return null;
  if (!_client) _client = new OpenAI({ apiKey: key });
  return _client;
}

async function extractBales(buffer, mimeType /* , opts */) {
  const client = getClient();
  if (!client) {
    return { ok: false, provider: 'openai', bales: [], rawText: '', overallConfidence: 0, warnings: [], error: 'OPENAI_API_KEY is not configured.' };
  }
  if (mimeType === 'application/pdf') {
    return { ok: false, provider: 'openai', bales: [], rawText: '', overallConfidence: 0, warnings: [], error: 'PDF input not supported by the openai provider yet — send a photo.' };
  }
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
  const resp = await client.chat.completions.create({
    model: config.ocr.openaiModel,
    temperature: 0,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      ],
    }],
  });

  let parsed;
  try {
    parsed = JSON.parse(resp.choices[0].message.content || '{}');
  } catch (e) {
    logger.warn(`vision/openai: JSON parse failed: ${e.message}`);
    return { ok: false, provider: 'openai', bales: [], rawText: '', overallConfidence: 0, warnings: [], error: 'Model returned unparseable output — try a clearer photo.' };
  }

  const { bales, warnings } = mapParsedBales(parsed);
  const overallConfidence = bales.length
    ? bales.reduce((s, b) => s + b.confidence, 0) / bales.length
    : 0;
  if (!bales.length) warnings.push('No bale rows recognised in the photo.');

  return {
    ok: bales.length > 0,
    provider: 'openai',
    bales,
    rawText: String(parsed.rawText || ''),
    overallConfidence,
    warnings,
    ...(bales.length ? {} : { error: 'No bale rows recognised.' }),
  };
}

module.exports = { extractBales };
