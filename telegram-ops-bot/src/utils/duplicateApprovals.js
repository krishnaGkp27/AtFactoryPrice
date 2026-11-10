'use strict';

/**
 * duplicateApprovals — find approval-queue rows that are the SAME request
 * queued more than once (a double-tapped Submit, a retry after a timeout).
 *
 * Why content, not just timing: the obvious rule — "same requester, same
 * action, same minute" — flags two GENUINELY DIFFERENT sales queued a minute
 * apart, and rejecting one of those loses a real order. So a duplicate here
 * must match on the business payload as well:
 *
 *   same requester  AND  same action  AND  same payload fingerprint
 *   AND queued within WINDOW minutes of the previous identical row
 *
 * The time window is what keeps a legitimate REPEAT order (same customer,
 * same design, same quantity, next week) from being called a duplicate.
 *
 * This module only ever FLAGS. Nothing here rejects, merges or mutates a
 * row — the admin decides, exactly as with every other approval.
 *
 * Pure and side-effect free: no sheet reads, no clock reads except the
 * timestamps handed in, so it is fully unit-testable.
 */

/** Default clustering window; overridable from the Settings sheet. */
const DEFAULT_WINDOW_MINUTES = 10;

/**
 * Payload keys that legitimately differ between two copies of the SAME
 * request, so they must not break the match:
 *  - identifiers and lifecycle bookkeeping written by the queue itself;
 *  - attachments, because re-sending a bill produces a fresh Telegram
 *    file id for byte-identical content.
 */
const VOLATILE_KEYS = new Set([
  'requestId', 'request_id',
  'approvals', 'approvedByAdmin', 'approvedBy',
  // APG-1 — the signature trail, the requester's reminders and the "sent
  // anyway" mark are bookkeeping about a request, never part of what it asks.
  'signoffs', 'nudges', 'twinOf', 'sentAnywayBy', 'rejectNote',
  'stage', 'dispatchedAt', 'bales', 'dispatched', 'short',
  'createdAt', 'created_at', 'timestamp', 'ts', 'updatedAt',
  'sale_doc_file_id', 'sale_doc_file_unique_id',
  'photo_file_id', 'file_id', 'fileHash', 'file_hash',
  'driveLink', 'driveFileId', 'archivedPath',
]);

/**
 * Deterministic JSON: object keys sorted at every depth, volatile keys
 * dropped, so two structurally equal payloads always produce one string
 * regardless of key insertion order.
 *
 * @param {*} value
 * @returns {string}
 */
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => !VOLATILE_KEYS.has(k)).sort();
    return `{${keys.map((k) => `${k}:${canonical(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'string') return JSON.stringify(value.trim());
  return JSON.stringify(value);
}

/**
 * Identity of a request for duplicate purposes: requester + action +
 * canonical payload. Rows with different requesters are never duplicates of
 * each other, even with identical payloads — two people submitting the same
 * thing is a coordination problem, not a double-tap, and silently grouping
 * them would hide one person's request behind another's.
 *
 * @param {object} row approval-queue row
 * @returns {string}
 */
function fingerprintOf(row) {
  const aj = (row && row.actionJSON) || {};
  const action = String(aj.action || '');
  const user = String((row && row.user) || '');
  // APG-1 — a request type may DECLARE what makes two of it the same thing
  // (a payment: account + amount). Without that, every payment request is
  // unique by its own payment id and two identical ones never matched —
  // which is how two ₦70,000 salary cards reached the admins unflagged.
  const registry = require('../services/approvalRegistry');
  const key = registry.twinKeyOf(aj);
  if (key) return `${registry.entryFor(action).twin.anyRequester ? '*' : user}|${action}|k:${key}`;
  return `${user}|${action}|${canonical(aj)}`;
}

/** APG-1 — how a row's type wants twins judged: { policy, scope }. */
function twinRuleOf(row) {
  const aj = (row && row.actionJSON) || {};
  return require('../services/approvalRegistry').entryFor(aj.action).twin;
}

/** Parse a timestamp; NaN when absent or malformed. */
function timeOf(row) {
  return Date.parse((row && row.createdAt) || '');
}

/**
 * Group rows into duplicate clusters.
 *
 * Rows sharing a fingerprint are sorted by time and split wherever the gap
 * to the previous row exceeds the window, so four taps in one minute form
 * ONE cluster while the same request a month later stands alone. A row with
 * an unparseable timestamp is never clustered — without a time we cannot
 * tell a double-tap from a repeat order, and the safe answer is "not a
 * duplicate".
 *
 * @param {Array<object>} rows pending approval rows
 * @param {number} [windowMinutes]
 * @returns {Array<Array<object>>} clusters of 2+ rows, largest first
 */
function findDuplicateGroups(rows, windowMinutes = DEFAULT_WINDOW_MINUTES) {
  const windowMs = Math.max(1, Number(windowMinutes) || DEFAULT_WINDOW_MINUTES) * 60000;
  const byPrint = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    if (!isFinite(timeOf(r))) continue; // undateable → never a duplicate
    if (twinRuleOf(r).policy === 'off') continue; // APG-1 — the type opted out
    const p = fingerprintOf(r);
    if (!byPrint.has(p)) byPrint.set(p, []);
    byPrint.get(p).push(r);
  }

  const groups = [];
  for (const list of byPrint.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => timeOf(a) - timeOf(b));
    // APG-1 — scope 'open': twins for as long as both are open, however far
    // apart they were raised (rows handed in are the PENDING ones).
    const gapMs = twinRuleOf(sorted[0]).scope === 'open' ? Infinity : windowMs;
    let run = [sorted[0]];
    for (let i = 1; i < sorted.length; i += 1) {
      if (timeOf(sorted[i]) - timeOf(sorted[i - 1]) <= gapMs) {
        run.push(sorted[i]);
      } else {
        if (run.length > 1) groups.push(run);
        run = [sorted[i]];
      }
    }
    if (run.length > 1) groups.push(run);
  }
  // Biggest pile first — that is where the wasted taps are.
  return groups.sort((a, b) => b.length - a.length || timeOf(a[0]) - timeOf(b[0]));
}

/**
 * requestId → its duplicate cluster, for O(1) lookup while rendering a list
 * or a single card.
 *
 * @param {Array<object>} rows
 * @param {number} [windowMinutes]
 * @returns {Map<string, Array<object>>}
 */
function duplicateIndex(rows, windowMinutes = DEFAULT_WINDOW_MINUTES) {
  const index = new Map();
  for (const group of findDuplicateGroups(rows, windowMinutes)) {
    for (const r of group) index.set(String(r.requestId), group);
  }
  return index;
}

module.exports = {
  findDuplicateGroups,
  duplicateIndex,
  fingerprintOf,
  DEFAULT_WINDOW_MINUTES,
  _internals: { canonical, VOLATILE_KEYS },
};
