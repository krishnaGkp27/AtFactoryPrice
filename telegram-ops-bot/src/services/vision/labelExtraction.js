/**
 * Shared bale-label extraction contract (SNAP-1/SNAP-2).
 *
 * Both real vision providers (openai, anthropic) ask their model for the
 * same strict-JSON shape and post-process it identically: meters→yards,
 * confidence clamping, and a meterage sanity check that halves a row's
 * confidence instead of dropping data (the review UI decides — we never
 * auto-commit). Keeping the prompt and the row mapper here means the two
 * providers cannot drift apart on what "a bale row" means.
 */

'use strict';

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
photo shows one sack label, return exactly one bale entry.
IMPORTANT — BALE NO. and INDENT NO. are DIFFERENT fields: the INDENT NO.
is the order number and is usually the SAME on every sack of a batch;
the BALE NO. is unique per sack. packageNo must be the BALE NO. — never
put the indent value there. If you can only read the indent, leave
packageNo "" and record the indent in "indent".`;

function clamp01(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5;
}

/**
 * Map the model's parsed JSON into the uniform bales[] shape declared in
 * vision/index.js. Rows with neither a bale number nor a design are junk
 * and get dropped.
 *
 * @param {object} parsed  the model's JSON ({bales:[...], rawText})
 * @returns {{bales: object[], warnings: string[]}}
 */
function mapParsedBales(parsed) {
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
  return { bales, warnings };
}

/**
 * Tolerant JSON extraction — models occasionally wrap JSON in code fences
 * or a stray sentence despite the strict-JSON instruction.
 * Returns the parsed object or null.
 */
function parseModelJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

/**
 * SNAP-5 — salvage a response that was cut off by max_tokens mid-JSON:
 * recover every COMPLETE `{...}` row inside the "bales" array and drop
 * the broken tail. Bale rows are flat objects (see PROMPT), so a simple
 * balanced-at-one-level scan is exact. Returns null when nothing usable
 * survives; otherwise a parseModelJson-shaped object flagged _truncated
 * so the caller can warn that rows may be missing.
 */
function salvageTruncatedBales(text) {
  const s = String(text || '');
  const at = s.indexOf('"bales"');
  if (at === -1) return null;
  const rows = [];
  const matches = s.slice(at).match(/\{[^{}]*\}/g) || [];
  for (const m of matches) {
    try { rows.push(JSON.parse(m)); } catch { /* partial row — skip */ }
  }
  if (!rows.length) return null;
  return { bales: rows, rawText: '', _truncated: true };
}

module.exports = { PROMPT, clamp01, mapParsedBales, parseModelJson, salvageTruncatedBales };
