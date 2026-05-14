/**
 * Quick-Add parsers (P3).
 *
 * Tiny pure-string parsers used by admin "type one line and save" entries.
 * Extracted here so the smoke harness can exercise them without dragging
 * in the controller's huge import graph.
 */

'use strict';

/**
 * Parse one-line Quick Add Customer input into a customer record.
 *
 * Format:  "Name[, Phone[, Address]]"
 *
 * Examples:
 *   "Mariam Salisu"                            → name only
 *   "Mariam Salisu, +234-803-555-7777"         → name + phone
 *   "Wang Tex, +234-1-555-1234, Lagos"         → name + phone + address
 *   "Wang Tex, +234-1-555-1234, Lagos, Apapa"  → address rejoined with commas
 *
 * Returns { ok: true, name, phone, address } on success,
 *         { ok: false, error } on validation failure.
 */
function parseQuickAddCustomerLine(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, error: 'Empty input.' };
  const parts = raw.split(',').map((s) => s.trim());
  const name = parts[0] || '';
  if (name.length < 2) return { ok: false, error: 'Name too short (min 2 chars).' };
  if (name.length > 80) return { ok: false, error: 'Name too long (max 80 chars).' };
  const phone = parts[1] || '';
  if (phone && !/^[\d+\-()\s]{6,30}$/.test(phone)) {
    return { ok: false, error: `Phone "${phone}" looks malformed — use digits, +, -, spaces only.` };
  }
  const address = parts.slice(2).join(', ').trim();
  return { ok: true, name, phone, address };
}

module.exports = { parseQuickAddCustomerLine };
