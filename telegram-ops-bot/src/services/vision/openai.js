/**
 * OpenAI Vision provider — SKELETON ONLY (P5-C1).
 *
 * The real implementation lands once the stub UX is approved (see
 * ROADMAP §2.7). For now this file exists so:
 *   1. The dispatcher in `vision/index.js` can resolve `PROVIDERS.openai`
 *      without crashing.
 *   2. `OCR_PROVIDER=openai` returns a clear "not implemented yet"
 *      error rather than silently falling back to a different provider.
 *
 * When this commit lands, it will:
 *   - Use config.openai.apiKey + config.ocr.openaiModel ('gpt-4o' by
 *     default).
 *   - Send the image (or rasterised PDF pages) as a data-URL with a
 *     "extract every than as JSON" prompt.
 *   - Return the uniform shape declared in vision/index.js's header.
 *   - Estimate per-row confidence from the model's own self-reported
 *     confidence + a yards-sanity-check (yards in 1..200 expected range).
 */

'use strict';

async function extractBales(/* buffer, mimeType, opts */) {
  return {
    ok: false,
    provider: 'openai',
    bales: [],
    rawText: '',
    overallConfidence: 0,
    warnings: [],
    error: 'not_implemented: OpenAI Vision provider is scheduled for a follow-up commit. Use OCR_PROVIDER=stub for now.',
  };
}

module.exports = { extractBales };
