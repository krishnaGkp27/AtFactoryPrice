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
const { PROMPT, mapParsedBales, parseModelJson, salvageTruncatedBales } = require('./labelExtraction');

/**
 * SNAP-5 (owner bug 22-Jul): real dispatch PDFs run 40–115 pages. One
 * request that size fails twice over — Claude caps PDF input at 100
 * pages, and a 46-label answer overflows a 4k max_tokens so the JSON
 * arrives truncated. Big PDFs are therefore split into page chunks
 * (pdf-lib, no re-encoding) and read sequentially; results merge into
 * one batch. A chunk that still truncates is salvaged row-by-row.
 */
const PDF_CHUNK_PAGES = 15;
const PDF_MAX_TOKENS = 8000;
const PDF_PROMPT_SUFFIX = '\nThis PDF contains one bale-label photo per page — '
  + 'return one bale entry per page, in page order. Keep rawText very brief '
  + '(just the bale numbers you read).';

let _client = null;
function getClient() {
  const key = (config.anthropic && config.anthropic.apiKey) || process.env.ANTHROPIC_API_KEY || '';
  if (!key) return null;
  if (!_client) _client = new Anthropic({ apiKey: key });
  return _client;
}

/** MIME types Claude's vision input accepts. */
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** One model round-trip; returns {parsed, truncated} or null on unparseable. */
async function callModel(client, contentBlock, isPdf, smart = false) {
  // SNAP-7: small PDFs (verification bills, short supply runs) go to the
  // STRONG photo model WITH thinking — rotated low-light handwriting broke
  // the fast model (owner's OKESON bill: 1057 read as 1657, a corner
  // scribble returned as a bale). Long dispatch PDFs keep the fast model.
  const usePhotoModel = !isPdf || smart;
  const resp = await client.messages.create({
    model: usePhotoModel ? config.ocr.anthropicModel : config.ocr.anthropicPdfModel,
    max_tokens: isPdf ? PDF_MAX_TOKENS : 3000,
    ...(usePhotoModel ? { thinking: { type: 'adaptive' } } : {}),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: isPdf ? PROMPT + PDF_PROMPT_SUFFIX : PROMPT },
        contentBlock,
      ],
    }],
  });
  const text = (Array.isArray(resp.content) ? resp.content : [])
    .filter((blk) => blk.type === 'text')
    .map((blk) => blk.text)
    .join('\n');
  const parsed = parseModelJson(text);
  if (parsed) return { parsed, truncated: false };
  const salvaged = salvageTruncatedBales(text);
  if (salvaged) return { parsed: salvaged, truncated: true };
  return null;
}

function docBlock(buffer) {
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
}

async function extractBales(buffer, mimeType, opts = {}) {
  const client = getClient();
  if (!client) {
    return { ok: false, provider: 'anthropic', bales: [], rawText: '', overallConfidence: 0, warnings: [], error: 'ANTHROPIC_API_KEY is not configured.' };
  }
  const isPdf = mimeType === 'application/pdf';
  if (!isPdf && !IMAGE_MIMES.includes(mimeType)) {
    return { ok: false, provider: 'anthropic', bales: [], rawText: '', overallConfidence: 0, warnings: [], error: `File type ${mimeType} not supported by the anthropic provider — send a JPG/PNG photo or a PDF.` };
  }

  // SNAP-3/SNAP-5: PDFs go up as native document blocks on the Sonnet
  // model (owner cost decision, no extended thinking) — big PDFs split
  // into page chunks first so no single answer overflows max_tokens and
  // Claude's 100-page input cap is never hit.
  let chunks;
  if (isPdf) {
    try {
      chunks = await require('./pdfChunk').splitPdf(buffer, PDF_CHUNK_PAGES);
    } catch (e) {
      // Unreadable by pdf-lib (odd generator/encryption) — one-shot as before.
      logger.warn(`vision/anthropic: pdf split failed (${e.message}) — sending whole file`);
      chunks = [{ buffer, fromPage: 0, toPage: 0 }];
    }
  } else {
    chunks = [{ buffer, fromPage: 0, toPage: 0 }];
  }

  // SNAP-7 — small PDFs earn the strong model + thinking (see callModel).
  // VRF-1 (owner 23-Jul: precision over cost for verification): callers
  // checking a bill against a request pass opts.forceStrongModel, which
  // applies the strong model + thinking REGARDLESS of page count — an
  // 11-page per-bale verification bill on the fast model misread digits
  // wholesale (604→634, 44200→4444, a corner scribble promoted to a
  // phantom bale). Every chunk of a big forced PDF carries the flag;
  // dispatch intake PDFs (snap batch, 40+ pages) never pass it and keep
  // the cost-efficient page-count routing untouched.
  const totalPages = (chunks.length && chunks[chunks.length - 1].toPage) || 0;
  const smart = isPdf && (opts.forceStrongModel === true
    || (totalPages > 0 && totalPages <= (config.ocr.smartPdfMaxPages || 6)));

  const allBales = [];
  const warnings = [];
  let rawText = '';
  let readFailures = 0;
  let parsedChunks = 0;
  let lastError = null;
  for (const c of chunks) {
    const range = c.fromPage ? `pages ${c.fromPage}–${c.toPage}` : 'the file';
    let out = null;
    try {
      out = await callModel(client,
        isPdf ? docBlock(c.buffer) : { type: 'image', source: { type: 'base64', media_type: mimeType, data: c.buffer.toString('base64') } },
        isPdf, smart);
    } catch (e) {
      // API-level failure on this chunk: remember it, keep reading the rest.
      logger.warn(`vision/anthropic: ${range} failed: ${e.message}`);
      lastError = e;
      readFailures += 1;
      warnings.push(`Could not read ${range} (${e.message}) — those labels are missing.`);
      continue;
    }
    if (!out) {
      logger.warn(`vision/anthropic: JSON parse failed for ${range}`);
      readFailures += 1;
      warnings.push(`Could not read ${range} — those labels are missing.`);
      continue;
    }
    if (out.truncated) {
      warnings.push(`The answer for ${range} was cut short — some of those labels may be missing.`);
    }
    parsedChunks += 1;
    const mapped = mapParsedBales(out.parsed);
    allBales.push(...mapped.bales);
    warnings.push(...mapped.warnings);
    if (out.parsed.rawText) rawText += (rawText ? '\n' : '') + String(out.parsed.rawText);
  }

  // Every chunk died on an API error → surface it so the auto chain can
  // fall through to the next provider (same contract as one-shot throws).
  if (!allBales.length && readFailures === chunks.length && lastError) throw lastError;

  if (!allBales.length) {
    if (parsedChunks > 0) warnings.push('No bale rows recognised in the photo.');
    return {
      ok: false, provider: 'anthropic', bales: [], rawText: '', overallConfidence: 0, warnings,
      error: parsedChunks > 0
        ? 'No bale rows recognised.'
        : (chunks.length > 1
          ? 'Could not read the labels in the PDF — try re-exporting it.'
          : 'Model returned unparseable output — try a clearer photo.'),
    };
  }

  const overallConfidence = allBales.reduce((s, b) => s + b.confidence, 0) / allBales.length;
  return {
    ok: true,
    provider: 'anthropic',
    bales: allBales,
    rawText,
    overallConfidence,
    warnings,
  };
}

module.exports = { extractBales, _internals: { PDF_CHUNK_PAGES, PDF_MAX_TOKENS } };
