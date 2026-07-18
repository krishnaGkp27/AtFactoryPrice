/**
 * Vision provider dispatcher (P5-C1).
 *
 * The single public entry-point for photo / PDF OCR. The caller (the
 * Photo Receive flow, in P5-C3) hands us a raw file buffer and a MIME
 * type; we route to the configured provider and return a uniform
 * structured shape regardless of which provider actually ran.
 *
 * Locked decisions (2026-05-14, after user sign-off):
 *   - Stub provider is the default. Real OpenAI / Google providers plug
 *     in once the stub UX is approved.
 *   - We never auto-commit. The caller is expected to walk the operator
 *     through a per-row review before submitting through the existing
 *     `bulk_receive_goods` action.
 *   - All extracted rows carry per-row `confidence`. Rows below
 *     `config.ocr.lowConfidenceThreshold` are rendered red in the
 *     review UI and force a manual edit before they can be accepted.
 *
 * Uniform return shape (all providers MUST return this):
 *   {
 *     ok: boolean,
 *     provider: string,           // 'stub' | 'openai' | 'anthropic'
 *     bales: Array<{
 *       packageNo:   string,
 *       thanNo:      number,
 *       design:      string,
 *       shade?:      string,
 *       yards:       number,
 *       netMtrs?:    number,
 *       netWeight?:  number,
 *       supplier?:   string,
 *       notes?:      string,
 *       confidence:  number,      // 0..1, per-row
 *     }>,
 *     rawText: string,            // raw OCR dump for audit
 *     overallConfidence: number,  // 0..1, aggregate
 *     warnings: string[],         // human-readable, e.g. "Row 3 shade unclear"
 *     error?: string,             // present when ok=false
 *   }
 *
 * Failure semantics:
 *   - Provider errors (network, API, parse) are caught here and surface
 *     as `{ ok: false, error: '…' }`. The flow falls back to manual
 *     entry rather than blowing up.
 *   - Unknown provider names → `{ ok: false, error: '…' }`.
 *   - OCR disabled in config → `{ ok: false, error: 'ocr_disabled' }`.
 */

'use strict';

const config = require('../../config');
const stub = require('./stub');
const openai = require('./openai');
const anthropic = require('./anthropic');
const logger = require('../../utils/logger');

const PROVIDERS = {
  stub,
  openai,
  anthropic,
  // google: require('./google'),   // wired in a future commit
};

/**
 * SNAP-2: OCR_PROVIDER=auto picks the best available real provider by
 * which API keys exist — Claude first (stronger at the handwritten label
 * values), then OpenAI, then the stub. Returns the chain, not just the
 * head: in auto mode a thrown provider error falls through to the next
 * entry so one provider outage doesn't take Snap Sale down.
 */
function resolveChain(providerName) {
  if (providerName !== 'auto') return [providerName];
  const chain = [];
  if ((config.anthropic && config.anthropic.apiKey) || process.env.ANTHROPIC_API_KEY) chain.push('anthropic');
  if ((config.openai && config.openai.apiKey) || process.env.OPENAI_API_KEY) chain.push('openai');
  if (!chain.length) chain.push('stub');
  return chain;
}

const SUPPORTED_MIMES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
];

/**
 * Run OCR over a file buffer.
 *
 * @param {Buffer} buffer       raw bytes (image or PDF)
 * @param {string} mimeType     e.g. 'image/jpeg', 'application/pdf'
 * @param {object} [opts]
 * @param {string} [opts.providerOverride]  force a specific provider (tests)
 * @returns {Promise<object>}   uniform shape — see file header
 */
async function extractBales(buffer, mimeType, opts = {}) {
  if (!config.ocr.enabled && !opts.providerOverride) {
    return errorResp('ocr_disabled', 'OCR is disabled in config. Set OCR_ENABLED=true.');
  }

  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return errorResp('empty_buffer', 'Empty or invalid file buffer.');
  }

  if (buffer.length > config.ocr.maxFileBytes) {
    const mb = (config.ocr.maxFileBytes / 1024 / 1024).toFixed(1);
    return errorResp('file_too_large',
      `File too large (${(buffer.length / 1024 / 1024).toFixed(2)} MB). Limit is ${mb} MB.`);
  }

  const mime = (mimeType || '').toLowerCase();
  if (!SUPPORTED_MIMES.includes(mime)) {
    return errorResp('unsupported_mime',
      `Unsupported file type "${mime || '(unknown)'}". Use JPG, PNG, WEBP, HEIC, or PDF.`);
  }

  const requested = opts.providerOverride || config.ocr.provider || 'stub';
  const chain = resolveChain(requested);

  let last = null;
  for (const providerName of chain) {
    const provider = PROVIDERS[providerName];
    if (!provider) {
      return errorResp('unknown_provider',
        `Unknown OCR provider "${providerName}". Configured providers: ${Object.keys(PROVIDERS).join(', ')}.`);
    }
    try {
      const result = await provider.extractBales(buffer, mime, opts);
      return normalise(result, providerName);
    } catch (e) {
      logger.warn(`vision: provider "${providerName}" threw: ${e.message}`);
      last = errorResp('provider_error', `Provider "${providerName}" failed: ${e.message}`);
      // auto mode only: fall through to the next provider in the chain
    }
  }
  return last || errorResp('unknown_provider', `No OCR provider available for "${requested}".`);
}

function errorResp(code, message) {
  return {
    ok: false, provider: '',
    bales: [], rawText: '', overallConfidence: 0,
    warnings: [], error: `${code}: ${message}`,
  };
}

/**
 * Normalise a provider response — fill in missing fields, coerce types,
 * sanity-clip confidence values, etc.
 *
 * Keeps the rest of the codebase from having to defend against each
 * provider's idiosyncrasies.
 */
function normalise(raw, providerName) {
  if (!raw || raw.ok === false) {
    return {
      ok: false, provider: providerName,
      bales: [], rawText: raw?.rawText || '', overallConfidence: 0,
      warnings: raw?.warnings || [],
      error: raw?.error || 'provider_returned_not_ok',
    };
  }
  const bales = Array.isArray(raw.bales) ? raw.bales : [];
  const norm = bales.map((b, idx) => {
    const conf = clampConfidence(b.confidence);
    return {
      packageNo: String(b.packageNo || '').trim(),
      thanNo: Number.isInteger(b.thanNo) ? b.thanNo : parseInt(b.thanNo, 10) || (idx + 1),
      design: String(b.design || '').trim(),
      shade: String(b.shade || '').trim(),
      yards: Number(b.yards) || 0,
      netMtrs: b.netMtrs == null ? 0 : Number(b.netMtrs) || 0,
      netWeight: b.netWeight == null ? 0 : Number(b.netWeight) || 0,
      supplier: String(b.supplier || '').trim(),
      notes: String(b.notes || '').trim(),
      confidence: conf,
      lowConfidence: conf < config.ocr.lowConfidenceThreshold,
    };
  });
  return {
    ok: true,
    provider: providerName,
    bales: norm,
    rawText: String(raw.rawText || ''),
    overallConfidence: clampConfidence(raw.overallConfidence ?? avg(norm.map((b) => b.confidence))),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
  };
}

function clampConfidence(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, n) => s + n, 0) / arr.length;
}

module.exports = {
  extractBales,
  PROVIDERS,
  SUPPORTED_MIMES,
};
