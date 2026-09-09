'use strict';

/**
 * PAY-2 — the chip key behind a typed payment reason.
 *
 * "Transport to Idumota", "transport  to idumota!!" and "  TRANSPORT TO
 * IDUMOTA " are one reason to the person who keeps typing it, so they must
 * be one key when phase 2 turns a requester's repeating reasons into chips.
 * The key is derived, never shown: the most recent spelling is what the
 * chip prints (`paymentReasonsRepository.topForRequester`).
 *
 * Pure. No I/O, no locale tables — deliberately dumb so the same text
 * always yields the same key across restarts and deploys.
 */

// Punctuation (Unicode category P) at either end of the text. Symbols such
// as a currency sign are NOT stripped — "₦4,000 float" keeps its meaning.
const EDGE_PUNCT = /^[\p{P}\s]+|[\p{P}\s]+$/gu;

/**
 * Lower-cased, trimmed, internal whitespace collapsed to one space,
 * punctuation stripped from both ends.
 *
 *   normaliseReasonKey('  Transport   to Idumota!! ') → 'transport to idumota'
 *
 * @param {*} text anything; non-strings are coerced, null/undefined → ''
 * @returns {string} the key ('' when nothing survives)
 */
function normaliseReasonKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EDGE_PUNCT, '')
    .trim();
}

module.exports = { normaliseReasonKey };
