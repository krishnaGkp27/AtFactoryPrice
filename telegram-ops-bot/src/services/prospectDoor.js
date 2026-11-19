'use strict';

/**
 * PRS-1 — 🆕 Add Prospect (owner's go, 19-Nov-2026; promised in CUS-3 §7).
 *
 * A marketer or a salesperson meets a buyer who has not bought yet. The
 * prospect door is the SHORT path into the one ➕ Add Contact door
 * (BUSINESS_RULES §12b — a shortcut into it, never a second form): the kind
 * is already Customer, and it asks only
 *
 *   name → phone → business card (a photo, optional) → store → confirm.
 *
 * It raises the SAME `add_contact` request the full form raises, so an admin
 * approves it with the same triage chips, and the approved row is a `🆕`
 * customer (no first sale) placed in the adder's store — provisional until
 * the first approved sale (CRM-R1).
 *
 * The business card is EVIDENCE: its Telegram file id rides the request's
 * own ApprovalQueue row (`card_file_id` / `card_file_type`). No sheet
 * column, nothing copied; the customer card looks it up at read time.
 *
 * This module is the pure half — who is offered the tile, what a business
 * card message is, what a prospect must carry — plus the one queue lookup.
 * The steps themselves live with the door, in the controller.
 */

const { inDepartment, isActive } = require('../repositories/usersRepository');
const fieldRoles = require('./fieldRoles');

/** Registry code of the tile. */
const TILE = 'add_prospect';

/** Departments whose people meet buyers: offered the tile without a sheet edit. */
const SELLING_DEPARTMENTS = ['Sales', 'Marketing'];

/**
 * Is this person offered the tile without their department listing it?
 * A marketer or salesman (field role), or an active member of Sales or
 * Marketing. Admins see every tile already; any other department may still
 * list `add_prospect` in its allowed activities.
 * @param {object|null} user a Users row
 * @returns {boolean}
 */
function maySee(user) {
  if (!user || !isActive(user)) return false;
  if (fieldRoles.isFieldRole(user.role)) return true;
  return SELLING_DEPARTMENTS.some((d) => inDepartment(user, d));
}

/**
 * The business card in an incoming message: a photo, or an image sent as a
 * File (which carries a DOCUMENT file id and needs the other sender later).
 * @returns {{fileId: string, kind: 'photo'|'document'}|null}
 */
function cardFromMessage(msg) {
  if (!msg) return null;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    return largest && largest.file_id ? { fileId: largest.file_id, kind: 'photo' } : null;
  }
  const doc = msg.document;
  if (doc && doc.file_id && /^image\//i.test(doc.mime_type || '')) return { fileId: doc.file_id, kind: 'document' };
  return null;
}

/**
 * A prospect nobody can reach is only a name. The door asks for a phone
 * number OR a business card — one of the two is enough.
 */
function hasFollowUp(session) {
  const s = session || {};
  return !!(String(s.phone || '').trim() || (s.card && s.card.fileId));
}

/** The fields a prospect adds to the `add_contact` request. */
function requestFields(session) {
  const s = session || {};
  if (!s.prospect) return {};
  return {
    prospect: true,
    ...(s.card && s.card.fileId ? { card_file_id: s.card.fileId, card_file_type: s.card.kind === 'document' ? 'document' : 'photo' } : {}),
  };
}

const norm = (v) => String(v == null ? '' : v).trim().toUpperCase();

/**
 * The newest APPROVED `add_contact` request for a name, from decided rows
 * the caller already holds.
 * @returns {object|null} the queue row
 */
function approvedRequestFor(rows, name) {
  const want = norm(name);
  if (!want) return null;
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && String(r.status || '').trim().toLowerCase() === 'approved'
      && r.actionJSON && r.actionJSON.action === 'add_contact' && norm(r.actionJSON.name) === want)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
}

/** The business card on a request row, or null. */
function cardOfRow(row) {
  const aj = (row && row.actionJSON) || {};
  if (!aj.card_file_id) return null;
  return { fileId: String(aj.card_file_id), kind: aj.card_file_type === 'document' ? 'document' : 'photo' };
}

/**
 * The business card kept for a customer: read at the tap from the request
 * that added them. null when there is none, and on any read failure.
 * @returns {Promise<{fileId: string, kind: string, requestId: string, by: string, at: string}|null>}
 */
async function cardFor(name) {
  try {
    const rows = await require('../repositories/approvalQueueRepository').getResolved();
    const hit = approvedRequestFor(rows, name);
    const card = cardOfRow(hit);
    if (!card) return null;
    return { ...card, requestId: String(hit.requestId || ''), by: String(hit.user || ''), at: hit.createdAt || '' };
  } catch (_) { return null; }
}

module.exports = {
  TILE, SELLING_DEPARTMENTS,
  maySee, cardFromMessage, hasFollowUp, requestFields, approvedRequestFor, cardOfRow, cardFor,
};
