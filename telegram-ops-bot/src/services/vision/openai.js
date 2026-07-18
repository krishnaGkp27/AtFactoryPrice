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

let _client = null;
function getClient() {
  const key = (config.openai && config.openai.apiKey) || process.env.OPENAI_API_KEY || '';
  if (!key) return null;
  if (!_client) _client = new OpenAI({ apiKey: key });
  return _client;
}

const PROMPT = `You read photos from a textile trading warehouse in Nigeria.
The photo is either (a) a woven bale sack with a printed label and
HANDWRITTEN values — fields like SHIPPING MARK, INDENT NO., BALE NO.,
DESIGN NO., COLOUR NO., NO. OF PCS., TOTAL MTR., NET WT., GROSS WT. — or
(b) a packing list / table with one row per bale.

Extract EVERY bale you can see and return STRICT JSON only (no prose):
{"bales":[{"packageNo":"<BALE NO as written>","design":"<DESIGN NO>",
"shade":"<COLOUR NO>","pcs":<NO OF PCS as number or null>,
"meters":<TOTAL MTR as number or null>,"indent":"<INDENT NO or empty>",
"confidence":<0..1 how sure you are of THIS row's numbers>}],
"rawText":"<all text you can read, one line per field>"}

Rules: transcribe handwriting as digits exactly as written (e.g. 77016,
896, 5). Do not invent fields you cannot read — use "" or null. If the
photo shows one sack label, return exactly one bale entry.`;

function clamp01(n) { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5; }

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

  const warnings = [];
  const bales = (Array.isArray(parsed.bales) ? parsed.bales : []).map((b, i) => {
    const meters = Number(b.meters);
    const yards = Number.isFinite(meters) && meters > 0 ? Math.round(meters * 1.09361) : 0;
    let confidence = clamp01(b.confidence);
    if (meters && (meters < 1 || meters > 2000)) {
      confidence /= 2;
      warnings.push(`Row ${i + 1}: implausible meterage (${meters}).`);
    }
    return {
      packageNo: String(b.packageNo ?? '').trim(),
      thanNo: Number(b.pcs) || 0,
      design: String(b.design ?? '').trim(),
      shade: String(b.shade ?? '').trim(),
      yards,
      netMtrs: Number.isFinite(meters) ? meters : 0,
      supplier: String(b.indent ?? '').trim(),
      notes: '',
      confidence,
    };
  }).filter((b) => b.packageNo || b.design);

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
