/**
 * Stub Vision provider (P5-C1).
 *
 * Deterministic, offline, zero-cost. Used for:
 *   1. Local development without API keys.
 *   2. Smoke tests (S15) — fast + reproducible.
 *   3. Demo / dry-runs to validate the per-row review UX before the
 *      real provider is wired in.
 *
 * Behaviour:
 *   - Returns a canonical 5-than single-bale extraction matching
 *     docs/samples/bulk-receive-sample-single-bale.csv, with one
 *     intentionally-low-confidence row (row 3) so the review UI's
 *     "force-edit on low-confidence" path is always exercised.
 *   - If env var OCR_STUB_FIXTURE_PATH is set, loads a JSON fixture
 *     from that path and returns it verbatim. Lets QA pin specific
 *     edge-case payloads without touching code.
 *   - Honours the buffer (records size + hash in rawText) so the audit
 *     log still has something useful for traceability.
 *   - NEVER calls an external API. NEVER blocks on the network.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../../utils/logger');

const CANNED = {
  bales: [
    { packageNo: '9001', thanNo: 1, design: 'Beige Crepe', shade: 'B-12',
      yards: 50, netMtrs: 45.7, netWeight: 18.5, confidence: 0.95 },
    { packageNo: '9001', thanNo: 2, design: 'Beige Crepe', shade: 'B-12',
      yards: 48, netMtrs: 43.8, netWeight: 17.9, confidence: 0.93 },
    { packageNo: '9001', thanNo: 3, design: 'Beige Crepe', shade: 'B-12',
      yards: 52, netMtrs: 47.5, netWeight: 19.2, confidence: 0.55 }, // low-conf → forces edit
    { packageNo: '9001', thanNo: 4, design: 'Beige Crepe', shade: 'B-12',
      yards: 50, netMtrs: 45.7, netWeight: 18.5, confidence: 0.91 },
    { packageNo: '9001', thanNo: 5, design: 'Beige Crepe', shade: 'B-12',
      yards: 49, netMtrs: 44.8, netWeight: 18.2, confidence: 0.94 },
  ],
  rawText:
    'PACKING SLIP — SupplierA\n' +
    'Bale 9001 · Beige Crepe · Shade B-12\n' +
    'Than 1: 50 yds (45.7 m / 18.5 kg)\n' +
    'Than 2: 48 yds (43.8 m / 17.9 kg)\n' +
    'Than 3: 5? yds (4?.5 m / 19.2 kg)   <-- partially smudged\n' +
    'Than 4: 50 yds (45.7 m / 18.5 kg)\n' +
    'Than 5: 49 yds (44.8 m / 18.2 kg)\n',
  warnings: ['Row 3 has smudged yards / netMtrs — confidence 0.55 (review required).'],
  overallConfidence: 0.86,
};

async function extractBales(buffer, mimeType /* , opts */) {
  const sha = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);

  const fixturePath = process.env.OCR_STUB_FIXTURE_PATH;
  if (fixturePath) {
    try {
      const resolved = path.resolve(fixturePath);
      const raw = fs.readFileSync(resolved, 'utf8');
      const fixture = JSON.parse(raw);
      return {
        ok: true, provider: 'stub',
        ...fixture,
        rawText: (fixture.rawText || '') + `\n[stub: fixture @ ${resolved}, input ${buffer.length}B ${sha}]`,
      };
    } catch (e) {
      logger.warn(`vision.stub: fixture load failed @ ${fixturePath}: ${e.message} — falling back to canned data`);
    }
  }

  return {
    ok: true,
    provider: 'stub',
    bales: CANNED.bales.map((b) => ({ ...b })),
    rawText: CANNED.rawText + `\n[stub: input ${mimeType}, ${buffer.length}B ${sha}]`,
    warnings: CANNED.warnings.slice(),
    overallConfidence: CANNED.overallConfidence,
  };
}

module.exports = { extractBales, CANNED };
