'use strict';

/**
 * CNET-1a — one canonical phone shape for the whole codebase (owner
 * decision 4, 16-Jul-2026). Before this, phones were stored exactly as
 * typed across four sheets; nothing could be matched or deduped.
 *
 * Policy (Nigeria-first, international-tolerant):
 *   0803 456 7890 / 08034567890   → +2348034567890   (0 + 10 digits = NG)
 *   803 456 7890 (10, starts 7-9) → +2348034567890
 *   234803...                     → +234803...
 *   +<8..15 digits>               → kept as typed (already international)
 *   anything else with 6+ digits  → kept verbatim (ok, but not E.164)
 *   fewer than 6 digits / letters → invalid
 *
 * normalizePhone(raw) → { ok, e164|null, value, reason? }
 *   value  = what to STORE (e164 when derivable, else cleaned input)
 *   e164   = strict +NNN form or null when we could not be sure
 */

const NG_CC = '+234';

function normalizePhone(raw) {
  const cleaned = String(raw ?? '').trim().replace(/[\s\-().]/g, '');
  if (!cleaned) return { ok: false, e164: null, value: '', reason: 'empty' };
  if (/[^+\d]/.test(cleaned)) return { ok: false, e164: null, value: cleaned, reason: 'non-numeric characters' };
  const plus = cleaned.startsWith('+');
  const digits = cleaned.replace(/^\+/, '');
  if (/[+]/.test(digits)) return { ok: false, e164: null, value: cleaned, reason: 'misplaced +' };
  if (digits.length < 6) return { ok: false, e164: null, value: cleaned, reason: 'too short' };
  if (digits.length > 15) return { ok: false, e164: null, value: cleaned, reason: 'too long' };

  if (plus) return { ok: true, e164: `+${digits}`, value: `+${digits}` };
  if (digits.length === 11 && digits.startsWith('0')) {
    const e164 = `${NG_CC}${digits.slice(1)}`;
    return { ok: true, e164, value: e164 };
  }
  if (digits.length === 10 && /^[789]/.test(digits)) {
    const e164 = `${NG_CC}${digits}`;
    return { ok: true, e164, value: e164 };
  }
  if (digits.length === 13 && digits.startsWith('234')) {
    const e164 = `+${digits}`;
    return { ok: true, e164, value: e164 };
  }
  // Plausible number, origin unknown — store cleaned, don't guess a country.
  return { ok: true, e164: null, value: digits };
}

/** Loose equality across historic formats: same last-10-digits match. */
function samePhone(a, b) {
  const da = String(a || '').replace(/\D/g, '');
  const db = String(b || '').replace(/\D/g, '');
  if (!da || !db) return false;
  return da.slice(-10) === db.slice(-10) && Math.min(da.length, db.length) >= 7;
}

/** Store-shape helper: best canonical value or '' (never throws). */
function toStored(raw) {
  const r = normalizePhone(raw);
  return r.ok ? r.value : String(raw ?? '').trim();
}

/**
 * Canonical bucket key for rate-limiting / OTP storage — the SAME last-10
 * digits `samePhone` matches on, so +234803…, +1803…, 0803… all collapse
 * to one bucket (EXT-1: a per-phone limit that keys on the raw e164 is
 * bypassable via prefix variants). '' when there aren't enough digits.
 */
function phoneKey(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : '';
}

module.exports = { normalizePhone, samePhone, toStored, phoneKey, NG_CC };
