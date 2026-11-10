'use strict';

/**
 * APG-1 — what the REQUESTER is told as their request moves.
 *
 * Owner, 10-Nov-2026: "make sure that the requester who raised the request
 * gets the notification back as and when approved by the admin, one by one,
 * with the name and number of approvers required."
 *
 * Before this the requester got three unrelated sentences — "has 1 of 2
 * admin approvals — signed by X. One more to go.", "has been approved by
 * admin. Changes applied.", "has been rejected by admin." — the last two
 * naming nobody. Now every step is ONE card in one grammar, for every
 * request type:
 *
 *   🔏 Approval 1 of 2
 *   💳 Payment request · ₦70,000 → Muhammad · Salary · Nov-2026
 *   ✅ Musa · 10-Nov 10:20
 *   ⏳ Waiting on 1 more admin
 *   Ref R-77E8
 *
 *   ✅ Approved · 2 of 2
 *   💳 Payment request · ₦70,000 → Muhammad · Salary · Nov-2026
 *   ✅ Musa · 10-Nov 10:20
 *   ✅ Krishna · 10-Nov 11:05
 *   Now with finance to pay.
 *   Ref R-77E8
 *
 *   ❌ Rejected by Musa · 10-Nov 11:05
 *   💳 Payment request · ₦70,000 → Muhammad · Salary · Nov-2026
 *   📝 Duplicate of R-B118, which is still open
 *   Ref R-77E8
 *
 * PLAIN TEXT on purpose (PAY-2 §2 I): names and reasons are free text and a
 * stray `_` must never blank a notice about someone's money.
 *
 * The signature trail rides the request's own row as
 * `actionJSON.signoffs: [{ id, name, at }]` beside the existing
 * `approvals: [id]` (which the four-eyes gate and the dual-admin counter
 * keep reading, untouched). Pure builders here; the callers do the I/O.
 */

const fmtDate = require('../utils/formatDate');
const registry = require('./approvalRegistry');

/** `10-Nov 10:20` (Lagos wall clock) — the year is noise on a same-week card. */
function when(iso) {
  const s = fmtDate.withTime(iso || new Date().toISOString());
  const m = /^(\d{2}-[A-Za-z]{3})-\d{4}, (\d{2}:\d{2})$/.exec(String(s));
  return m ? `${m[1]} ${m[2]}` : String(s);
}

function ref(requestId) {
  try { return require('./approvalCards').shortRequestRef(requestId); } catch (_) { return String(requestId || ''); }
}

/** One signature entry. `name` may be '' when the label lookup failed. */
function signoff(id, name, at) {
  return { id: String(id || ''), name: String(name || ''), at: at || new Date().toISOString() };
}

const signLine = (s) => `✅ ${s.name || s.id || 'An admin'} · ${when(s.at)}`;

/**
 * The recorded trail of a payload: `signoffs` when present, else the bare
 * ids of `approvals` (rows signed before APG-1 carry no names or times).
 * @returns {Array<{id:string, name:string, at:string}>}
 */
function trailOf(aj) {
  const a = aj || {};
  if (Array.isArray(a.signoffs) && a.signoffs.length) return a.signoffs.map((s) => ({ id: String(s.id || ''), name: String(s.name || ''), at: s.at || '' }));
  return (Array.isArray(a.approvals) ? a.approvals : []).map((id) => ({ id: String(id), name: '', at: '' }));
}

/**
 * @param {object} p
 * @param {'signed'|'approved'|'rejected'} p.state
 * @param {string} p.requestId
 * @param {object} p.aj            the request payload (names the request)
 * @param {number} [p.required]    signatures this request needs
 * @param {Array}  [p.signoffs]    every signature so far, this one included
 * @param {string} [p.by]          who rejected
 * @param {string} [p.at]          when it was rejected
 * @param {string} [p.note]        why (a duplicate, a typed reason)
 * @param {string} [p.tail]        closing lines of an approval (credit note, "with finance")
 * @returns {string} plain text
 */
function buildCard(p) {
  const state = p.state;
  const signoffs = Array.isArray(p.signoffs) ? p.signoffs : [];
  const signed = signoffs.length;
  const required = Math.max(Number(p.required) || 0, signed, 1);
  const lines = [];
  if (state === 'signed') {
    lines.push(`🔏 Approval ${signed} of ${required}`);
  } else if (state === 'approved') {
    lines.push(`✅ Approved · ${signed || required} of ${required}`);
  } else {
    lines.push(`❌ Rejected${p.by ? ` by ${p.by}` : ''} · ${when(p.at)}`);
  }
  lines.push(registry.describe(p.aj));
  for (const s of signoffs) {
    // A signature recorded before APG-1 has no time; it still counts and is named.
    lines.push(s.at ? signLine(s) : `✅ ${s.name || s.id || 'An admin'}`);
  }
  if (state === 'signed') {
    const left = required - signed;
    lines.push(`⏳ Waiting on ${left} more admin${left === 1 ? '' : 's'}`);
  }
  if (state === 'rejected' && p.note) lines.push(`📝 ${p.note}`);
  if (state === 'approved' && p.tail) lines.push(String(p.tail).trim());
  lines.push(`Ref ${ref(p.requestId)}`);
  return lines.filter(Boolean).join('\n');
}

/**
 * The status card behind 📋 Open it — where a request stands right now.
 * @param {object} p row (queue row), required, raisedByName, ageWords
 */
function buildStatus(p) {
  const row = p.row || {};
  const aj = row.actionJSON || {};
  const status = String(row.status || 'pending').toLowerCase();
  const trail = Array.isArray(p.signoffs) ? p.signoffs : trailOf(aj);
  const required = Math.max(Number(p.required) || 0, trail.length, 1);
  const lines = [`📋 Request ${ref(row.requestId)}`, registry.describe(aj)];
  lines.push(`Raised by ${p.raisedByName || row.user || '—'} · ${when(row.createdAt)}${p.ageWords ? ` · ${p.ageWords}` : ''}`);
  if (status === 'pending') {
    lines.push(`🛂 Waiting on approval · ${trail.length} of ${required} signed`);
  } else if (status === 'approved') {
    lines.push(`✅ Approved${row.approver ? ` by ${row.approver}` : ''}${row.resolvedAt ? ` · ${when(row.resolvedAt)}` : ''}`);
  } else {
    lines.push(`❌ ${status.charAt(0).toUpperCase() + status.slice(1)}${row.approver ? ` by ${row.approver}` : ''}${row.resolvedAt ? ` · ${when(row.resolvedAt)}` : ''}`);
    if (aj.rejectNote) lines.push(`📝 ${aj.rejectNote}`);
  }
  for (const s of trail) lines.push(s.at ? signLine(s) : `✅ ${s.name || s.id || 'An admin'}`);
  const nudges = Array.isArray(aj.nudges) ? aj.nudges : [];
  if (nudges.length) lines.push(`🔔 Reminded ${nudges.length}× · last ${when(nudges[nudges.length - 1].at)}`);
  if (aj.twinOf) lines.push(`⧉ Sent anyway — repeats ${ref(aj.twinOf)}`);
  return lines.filter(Boolean).join('\n');
}

module.exports = { buildCard, buildStatus, signoff, trailOf, when, ref };
