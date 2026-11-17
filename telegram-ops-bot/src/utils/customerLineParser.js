'use strict';

/**
 * CUS-4 — the typed customer line, read LOCALLY (no AI).
 *
 * Owner, 17-Nov-2026, on a screenshot of three typed lines answered by the
 * chips card ("Amib international" / "0806 256 2752" / "Kano"): "My office
 * employees aren't able to add customer by direct typing."
 *
 * Two shapes are read:
 *
 *   bare    the name, the phone number and the town, each on its own line
 *           or separated by commas — exactly what staff type:
 *               Amib international
 *               0806 256 2752
 *               Kano
 *   worded  the same after `Customer` (also `Add customer`, `New customer`):
 *               Customer Amib international, 0806 256 2752, Kano
 *           with or without commas.
 *
 * THE PHONE NUMBER IS THE SIGNAL. A message with no phone number is never a
 * customer line — so `Customer Abba` keeps opening Abba's details, and an
 * ordinary sentence is never mistaken for a person.
 *
 * Reading a line writes nothing: it only pre-fills the ➕ Add Contact
 * door's confirm card. The employee taps Submit and an admin approves, as
 * for every contact (BUSINESS_RULES §20: typed words never change the sheet
 * on their own).
 *
 * Pure: no I/O, no settings.
 */

const MAX_PART = 80;
const MAX_PARTS = 6;
const MAX_NAME_WORDS = 8;

const WORDED = /^\s*(?:please\s+)?(?:(?:add|new|register|create)\s+(?:a\s+)?(?:new\s+)?)?customer\b[\s:,;.\-–—]*/i;
const LABEL = /^(name|customer|customer name|phone|phone no|phone number|tel|telephone|mobile|number|no|address|location|city|town|place|store)\s*[:=\-–—]\s*/i;
const PHONE_LABELS = new Set(['phone', 'phone no', 'phone number', 'tel', 'telephone', 'mobile', 'number', 'no']);
const PLACE_LABELS = new Set(['address', 'location', 'city', 'town', 'place', 'store']);
const PHONE_WHOLE = /^\+?\d[\d\s\-().]{5,24}$/;
const PHONE_INSIDE = /\+?\d[\d\s\-().]{5,24}\d/;

const digits = (s) => String(s).replace(/\D/g, '');
/** Markdown control characters would break the door's card; a name has no use for them. */
const clean = (s) => String(s == null ? '' : s).replace(/[*_`[\]]/g, ' ').replace(/\s+/g, ' ').trim();
const hasLetter = (s) => /\p{L}/u.test(String(s));

/** A whole part that is a phone number: 7 to 15 digits, with the usual separators. */
function isPhone(part) {
  const t = String(part || '').trim();
  if (!PHONE_WHOLE.test(t)) return false;
  const n = digits(t).length;
  return n >= 7 && n <= 15;
}

function tidyPhone(part) {
  return String(part).trim().replace(/\s+/g, ' ');
}

/** Split a body into its parts: lines first, then commas / semicolons inside each line. */
function partsOf(body) {
  return String(body || '')
    .split(/\r?\n/)
    .flatMap((line) => line.split(/[,;]/))
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Sort parts into name / phones / place. A label in front of a part
 * ("Phone: 0806…", "Address: Kano") decides its role and is dropped.
 * @returns {{name:string, phone:string, address:string, otherPhones:string[]}|null}
 */
function assemble(parts) {
  if (parts.length < 2 || parts.length > MAX_PARTS) return null;
  let name = '';
  const phones = [];
  const place = [];
  for (const raw of parts) {
    if (raw.length > MAX_PART) return null;
    const m = LABEL.exec(raw);
    const label = m ? m[1].toLowerCase() : '';
    const value = m ? raw.slice(m[0].length).trim() : raw;
    if (!value) continue;
    if (isPhone(value) && !PLACE_LABELS.has(label)) { phones.push(tidyPhone(value)); continue; }
    if (PHONE_LABELS.has(label)) return null; // labelled a phone, but it is not one
    if (PLACE_LABELS.has(label)) { place.push(clean(value)); continue; }
    if (!name) { name = clean(value); continue; }
    place.push(clean(value));
  }
  if (!phones.length || !name) return null;
  if (name.length < 2 || !hasLetter(name) || name.split(' ').length > MAX_NAME_WORDS) return null;
  return {
    name,
    phone: phones[0],
    address: place.filter(Boolean).join(', '),
    otherPhones: phones.slice(1),
  };
}

/**
 * Read a typed message as a customer line.
 * @param {string} text the whole message
 * @returns {{name:string, phone:string, address:string, otherPhones:string[], form:'worded'|'bare'}|null}
 *          null = not a customer line (the caller carries on as before)
 */
function parseCustomerLine(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw || raw.startsWith('/') || raw.length > 400) return null;

  const worded = WORDED.exec(raw);
  if (worded) {
    const body = raw.slice(worded[0].length).trim();
    if (!body) return null;
    let parts = partsOf(body);
    if (parts.length === 1) {
      // No commas, no new lines: "Customer Amib international 0806 256 2752 Kano".
      // The phone number divides the name from the place.
      const m = PHONE_INSIDE.exec(body);
      if (!m) return null;
      parts = [body.slice(0, m.index).trim(), m[0], body.slice(m.index + m[0].length).trim()].filter(Boolean);
    }
    const got = assemble(parts);
    return got ? { ...got, form: 'worded' } : null;
  }

  // Bare: there must be separate parts (lines or commas). One undivided
  // sentence is never read as a person, whatever number it carries.
  const got = assemble(partsOf(raw));
  return got ? { ...got, form: 'bare' } : null;
}

module.exports = { parseCustomerLine, _internals: { isPhone, partsOf, assemble } };
