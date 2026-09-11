'use strict';

/**
 * SRF-SP (owner, 11-Sep-2026) — ONE chip set for every "who sold it?"
 * picker, so the supply-request picker in the controller and the
 * new-customer-approved continuation in approvalEvents show the identical
 * card (BUSINESS_RULES §9b: the seller is PICKED, never assumed; the
 * submitter is offered first).
 *
 * Rows, in order:
 *   1. `🙋 Me · <name>`      — only when the submitter may sell: an admin, or
 *                              an ACTIVE Users row in the Sales department.
 *                              The value is their name (name || user_id; an
 *                              admin with no Users row → the id string, the
 *                              same label today's list would have shown).
 *   2. `👤 Customer direct`  — the customer came on their own, or an admin
 *                              raised it on the customer's behalf with no
 *                              seller. Stored value is EXACTLY
 *                              {@link CUSTOMER_DIRECT}.
 *   3+ the Sales list as before — active admins + Sales users, two per row,
 *      WITHOUT the submitter (they are on row 1), capped at
 *      {@link MAX_VISIBLE} unless `showAll`, plus a `📋 See All (n)` row
 *      when the cap hid somebody.
 *
 * Pure: no sheet reads, no bot calls. Callers pass the Users rows and the
 * admin id list they already hold and append their own nav rows.
 */

const { inDepartment } = require('../repositories/usersRepository');

/** The stored salesperson value when nobody sold it — matches the wizard's word. */
const CUSTOMER_DIRECT = 'Customer direct';

/** Header of every picker built from these rows. */
const HEADER = '🧑 Who sold it?';

/** Payload (after the prefix) that asks for the full list. */
const SEE_ALL = '__more__';

/** How many Sales chips show before the See All row. */
const MAX_VISIBLE = 6;

const SALES_DEPARTMENT = 'Sales';

/** The chip label / stored value of one Users row. */
function labelOf(u) {
  return String((u && (u.name || u.user_id)) || '').trim();
}

function isActive(u) {
  return !u.status || u.status === 'active';
}

/**
 * May this Users row sell? Active, and either an admin or in Sales — the
 * same membership test the supply picker has always used for its list.
 */
function canSell(u, adminSet) {
  if (!u || !isActive(u)) return false;
  if (adminSet.has(String(u.user_id))) return true;
  return inDepartment(u, SALES_DEPARTMENT);
}

/**
 * Build the salesperson chip rows.
 *
 * @param {object} o
 * @param {string|number} o.submitterId  Telegram id of the person on the flow
 * @param {Array<object>} o.users        Users rows (usersRepository.getAll())
 * @param {Array<string>|Set<string>} [o.adminIds]  config.access.adminIds
 * @param {boolean} [o.showAll=false]    true = no cap, no See All row
 * @param {string} [o.callbackPrefix='srf_sp:']  routing prefix; the payload
 *        after it is the stored value (a name, CUSTOMER_DIRECT or SEE_ALL)
 * @returns {Array<Array<{text:string, callback_data:string}>>}
 */
function buildSalespersonRows({ submitterId, users, adminIds, showAll = false, callbackPrefix = 'srf_sp:' } = {}) {
  const me = String(submitterId == null ? '' : submitterId);
  const adminSet = new Set(Array.from(adminIds || [], (id) => String(id)));
  const all = Array.isArray(users) ? users : [];
  const chip = (text, value) => ({ text, callback_data: `${callbackPrefix}${value}` });

  const rows = [];

  // Row 1 — Me, when the submitter may sell. Prefer their ACTIVE row for the
  // name (re-onboarding appends rows, so one id can have several).
  const myRows = all.filter((u) => String(u.user_id) === me);
  const myRow = myRows.find(isActive) || myRows[myRows.length - 1] || null;
  const meIsAdmin = me && adminSet.has(me);
  const meSells = meIsAdmin || (myRow ? canSell(myRow, adminSet) : false);
  if (meSells) {
    const myName = myRow ? labelOf(myRow) : me;
    rows.push([chip(`🙋 Me · ${myName}`, myName)]);
  }

  // Row 2 — Customer direct, always.
  rows.push([chip(`👤 ${CUSTOMER_DIRECT}`, CUSTOMER_DIRECT)]);

  // Row 3+ — the Sales list, without the submitter.
  const others = all.filter((u) => String(u.user_id) !== me && canSell(u, adminSet));
  const visible = showAll ? others : others.slice(0, MAX_VISIBLE);
  for (let i = 0; i < visible.length; i += 2) {
    const row = [chip(`🧑 ${labelOf(visible[i])}`, labelOf(visible[i]))];
    if (visible[i + 1]) row.push(chip(`🧑 ${labelOf(visible[i + 1])}`, labelOf(visible[i + 1])));
    rows.push(row);
  }
  if (!showAll && others.length > MAX_VISIBLE) {
    rows.push([chip(`📋 See All (${others.length})`, SEE_ALL)]);
  }
  return rows;
}

module.exports = { buildSalespersonRows, CUSTOMER_DIRECT, HEADER, SEE_ALL, MAX_VISIBLE };
