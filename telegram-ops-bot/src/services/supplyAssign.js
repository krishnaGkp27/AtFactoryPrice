'use strict';

/**
 * supplyAssign — SRF-6 (owner, 23-Oct-2026): who will SUPPLY a supply request.
 *
 * Owner: "to whom it is assigned is not visible … he needs to select the
 * exact person to whom he has to assign the task, and this is also visible
 * only to the admin groups." Rulings (R1–R4, "Go as per your recommendation"):
 *   R1 the step is mandatory whenever at least one eligible person exists;
 *      `🛂 Let admin choose` appears only when the list is empty;
 *   R2 the Dispatch-review card (non-admins) does NOT show the name;
 *   R3 eligibility = today's admin-picker rule: active, in the Dispatch /
 *      Warehouse / Logistics department, attached to the store (Users col I);
 *   R4 the admin card carries a waiting line (closes STS-1 gap G5 for supply).
 *
 * ONE rule for who may be picked — the requester's chips, the admin's picker
 * and the reassign door all call `eligibleFor`.
 */
const usersRepository = require('../repositories/usersRepository');

const DEPTS = ['Dispatch', 'Warehouse', 'Logistics'];
const key = (s) => String(s == null ? '' : s).trim().toUpperCase();
const isActive = (u) => !!u && (!u.status || String(u.status).toLowerCase() === 'active');
const who = (o) => (o && (o.name || o.user_id)) ? String(o.name || o.user_id) : '';

/** Active users in any of the dispatch departments, whatever their store. */
function dispatchStaff(users) {
  return (users || []).filter((u) => isActive(u) && DEPTS.some((d) => usersRepository.inDepartment(u, d)));
}

/** The dispatch staff attached to `store` (every one of them when no store is given). */
function eligibleFor(users, store) {
  const k = key(store);
  return dispatchStaff(users).filter((u) => !k || (u.warehouses || []).some((w) => key(w) === k));
}

function chipLabel(u) { return `🧑 ${u.name || u.user_id}`; }

/** `2d ago` / `today` / '' — from an ISO timestamp. */
function daysAgo(ts) {
  const t = Date.parse(ts || '');
  if (!Number.isFinite(t)) return '';
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d <= 0) return 'today';
  return `${d}d ago`;
}

/** The 🚚 line on the ADMIN card: who will supply, and who decided it. */
function supplierLine(aj = {}) {
  if (aj.assignedDispatch && who(aj.assignedDispatch)) return `🚚 Assigned to ${who(aj.assignedDispatch)}`;
  if (aj.requestedAssignee && who(aj.requestedAssignee)) {
    return `🚚 To be supplied by ${who(aj.requestedAssignee)} · ${aj.requestedAssignee.byAdmin ? 'changed by an admin' : "requester's choice"}`;
  }
  return '🚚 Supplier: an admin will choose';
}

/** Where the request sits and with whom — the transfer cards' grammar (TRF-19). */
function waitingLine(aj = {}) {
  const stage = String(aj.stage || 'dispatch_review');
  const withAgo = (o) => { const a = daysAgo(o && o.ts); return a ? ` ${a}` : ''; };
  switch (stage) {
    case 'dispatch_review': return '⏳ Waiting on Dispatch to confirm';
    case 'admin_review': {
      let s = '🛂 Waiting on an admin to approve';
      if (aj.confirmedByDispatch) s += ` · confirmed by ${who(aj.confirmedByDispatch) || 'Dispatch'}${withAgo(aj.confirmedByDispatch)}`;
      else if (aj.dispatchSkipped) s += ' · Dispatch stage skipped';
      return s;
    }
    case 'dispatch_acceptance': return `🚚 Waiting on ${who(aj.assignedDispatch) || 'the assignee'} to accept · assigned${withAgo(aj.assignedDispatch)}`;
    case 'admin_repick': return `↩️ Declined by ${who(aj.dispatchDecline) || 'the assignee'} — an admin must assign someone else`;
    case 'completed': return `✅ Accepted by ${who(aj.assignedDispatch) || 'the assignee'}`;
    case 'rejected_by_dispatch': return `❌ Rejected by ${who(aj.dispatchRejection) || 'Dispatch'}`;
    default: return '';
  }
}

module.exports = { DEPTS, dispatchStaff, eligibleFor, chipLabel, daysAgo, supplierLine, waitingLine };
