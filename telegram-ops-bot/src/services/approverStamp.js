'use strict';

/**
 * approverStamp — APR-1. Who actually released a request?
 *
 * The ApprovalQueue's Status cell is flipped by whoever happened to complete
 * the last step, and on two of the highest-value actions that person is NOT
 * the approver:
 *
 *   • a TRANSFER is flipped to approved by the destination RECEIVER
 *     confirming goods arrived (transferService.confirmReceipt);
 *   • a SUPPLY REQUEST is flipped by the assigned DISPATCH hand accepting
 *     the job (approvalEvents.handleSupplyAccept).
 *
 * Both are non-admins. Filling an "Approver" column from the caller would put
 * a warehouse hand's name against stock movements as the signing authority —
 * worse than a blank cell, because it manufactures a false audit trail on
 * exactly the rows an audit would look at first. So the approver is resolved
 * from the request's OWN record, per action, and the caller's id is only ever
 * the fallback for the paths where the caller genuinely is the decider.
 *
 * The dual-admin pair is the other trap. The first tap is written to
 * `actionJSON.approvals`, but the FINAL tap never was — control leaves the
 * bookkeeping branch as soon as the requirement is satisfied. So a completed
 * dual approval recorded admin #1 and lost admin #2, and a dual action raised
 * BY an admin (which needs one more signature, not two) recorded neither.
 * `labelFor` merges the stored first signature with the deciding actor, so
 * the column shows the whole pair — the §14 rule that a claim of two admins
 * must be backed by two recorded admins, not by a comment.
 *
 * Display-only: nothing reads this back to gate anything. Approval policy
 * stays entirely in risk/evaluate.js.
 */

const logger = require('../utils/logger');

/** Ids that name a system actor rather than a person. */
const SYSTEM_ACTORS = new Set(['system', 'bot', '']);

/**
 * The ids that should be credited for releasing this request, in order,
 * de-duplicated. Pure — no I/O — so it is cheap to test.
 *
 * @param {object} actionJSON the queue row's parsed ActionJSON
 * @param {string|number} actorId whoever completed the final step
 * @returns {string[]}
 */
function approverIds(actionJSON, actorId) {
  const aj = actionJSON || {};
  const out = [];
  const push = (v) => {
    const id = String(v == null ? '' : v).trim();
    if (id && !SYSTEM_ACTORS.has(id.toLowerCase()) && !out.includes(id)) out.push(id);
  };

  // Dual-admin: the first signature was parked here when the request stayed
  // pending. It must survive into the final stamp.
  if (Array.isArray(aj.approvals)) aj.approvals.forEach(push);

  const action = String(aj.action || '').trim();
  if (action === 'transfer_stock') {
    // The receiver flips the row; the admin who released it is on the record.
    push(aj.approvedBy);
    return out;
  }
  if (action === 'supply_request') {
    // The dispatch hand accepting the job flips the row; the approving admin
    // was stamped when the warehouse boy was assigned.
    push(aj.approvedByAdmin && aj.approvedByAdmin.user_id);
    return out;
  }

  push(actorId);
  return out;
}

/**
 * A human-readable label for the sheet's Approver cell and for cards —
 * names, not raw Telegram ids (LBL-1). Never throws: a naming failure must
 * not cost the approval, so an unresolvable id degrades to the id itself.
 *
 * @param {{actionJSON?:object, actorId?:string|number, bot?:object}} args
 * @returns {Promise<string>} e.g. "Emin" or "Emin + Boss"; '' when unknown
 */
async function labelFor({ actionJSON, actorId, bot } = {}) {
  const ids = approverIds(actionJSON, actorId);
  if (!ids.length) return '';
  try {
    const { resolveUserLabel } = require('./approvalCards');
    const names = [];
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const label = await resolveUserLabel(id, bot);
      names.push(label && label !== 'Unknown' ? label : id);
    }
    return names.join(' + ');
  } catch (e) {
    logger?.warn?.(`approverStamp: name resolution failed (${e.message}); stamping ids`);
    return ids.join(' + ');
  }
}

module.exports = { labelFor, approverIds, _internals: { SYSTEM_ACTORS } };
