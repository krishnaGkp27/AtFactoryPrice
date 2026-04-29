/**
 * OpenAI Vision-based shade detector for product photos.
 *
 * Takes the raw uploaded photo of a fabric bale card (a panel of color
 * tabs with printed numbers) and returns a structured list of shades
 * matching the physical tab numbers visible on the photo.
 *
 * Used by the catalog upload flow to *propose* a shade list to the
 * employee. The employee then either taps "✅ Proceed" to accept the
 * proposal or "✏️ Type manually" to fall through to the existing
 * N:name input flow. So the model's output is never trusted blindly —
 * it's an optional convenience layered on top of the manual flow.
 *
 * Failure modes (low confidence / parse error / API error / no key) all
 * resolve to `null`, which the caller treats as "skip suggestion".
 */

const OpenAI = require('openai');
const config = require('../config');
const logger = require('../utils/logger');

const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;

const SYSTEM = `You are a vision assistant that analyses photos of textile bale shade cards.

The photo shows a row or grid of fabric color tabs. Each tab has a small printed number (usually top-right of the tab) — these are the *physical* shade numbers stamped on the bale card. Numbers are not always sequential (you might see 1, 3, 4, 7, 9, 11 etc.) and you must read the actual printed number, not assign one yourself.

For each visible tab, return:
- "number": the integer printed on that tab (or your best guess if partially obscured).
- "name": a short, plain English color name that a layperson would use, e.g. "White", "Off White", "Dark Green", "Beige", "Burgundy", "Black".

CRITICAL RULES:
- Read tab numbers from the photo. Do NOT renumber them sequentially.
- Order shades in *reading order*: top-left first, then left-to-right, then next row.
- Use simple, common color names — avoid brand names or fanciful names like "Sahara Sand".
- If a tab number is not legible, omit that tab rather than guessing wildly.
- "confidence" is your overall confidence (0-1) that you read the numbers and named the colors correctly. If the image is blurry, partially occluded, or you had to guess multiple numbers, drop it below 0.5.

Reply with ONLY a JSON object (no markdown, no code fence) of this exact shape:
{
  "shades": [{"number": <int>, "name": "<short color name>"}, ...],
  "confidence": <0..1>
}`;

const USER_PROMPT = 'Detect the fabric shades visible on this bale card. Return shades in reading order with the printed tab numbers and short color names.';

/**
 * Run shade detection over a photo buffer.
 *
 * @param {Buffer} photoBuffer  raw image bytes (jpeg/png)
 * @param {string} [mimeType='image/jpeg']
 * @returns {Promise<{shades: Array<{number:number,name:string}>, confidence:number} | null>}
 *   `null` when detection isn't possible (no API key, API error, parse error, low confidence).
 */
async function detectShadesFromPhoto(photoBuffer, mimeType = 'image/jpeg') {
  if (!openai) {
    logger.info('colorDetector: skipped (no OPENAI_API_KEY)');
    return null;
  }
  if (!Buffer.isBuffer(photoBuffer) || !photoBuffer.length) {
    logger.warn('colorDetector: empty or invalid photo buffer');
    return null;
  }

  const base64 = photoBuffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;

  let resp;
  try {
    resp = await openai.chat.completions.create({
      model: config.openai.model || 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: USER_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        },
      ],
    });
  } catch (e) {
    logger.warn(`colorDetector: API call failed — ${e.message}`);
    return null;
  }

  const raw = resp?.choices?.[0]?.message?.content;
  if (!raw) {
    logger.warn('colorDetector: empty response from model');
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    logger.warn(`colorDetector: JSON parse failed — ${e.message}`);
    return null;
  }

  const shades = Array.isArray(parsed.shades) ? parsed.shades : null;
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;

  if (!shades || !shades.length) {
    logger.info('colorDetector: no shades returned');
    return null;
  }

  // Sanitize each shade entry; drop garbage rows.
  const clean = [];
  for (const s of shades) {
    const n = Number(s.number);
    const name = String(s.name || '').trim();
    if (!Number.isFinite(n) || n <= 0 || !name) continue;
    if (name.length > 30) continue;          // suspiciously long name → drop
    clean.push({ number: Math.round(n), name });
  }
  if (!clean.length) {
    logger.info('colorDetector: all shades filtered out as invalid');
    return null;
  }

  // De-duplicate by number — keep first occurrence (preserves reading order).
  const seen = new Set();
  const unique = [];
  for (const s of clean) {
    if (seen.has(s.number)) continue;
    seen.add(s.number);
    unique.push(s);
  }

  logger.info(`colorDetector: detected ${unique.length} shade(s), confidence=${confidence.toFixed(2)}`);
  return { shades: unique, confidence };
}

module.exports = { detectShadesFromPhoto };
