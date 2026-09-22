'use strict';
/**
 * TRF-20 — the identity of a transfer LOAD, and what that identity exposes.
 *
 * The owner's 20-Sep export showed 32 of 67 transfer rows sitting in 12
 * groups of identical route + lines, and 8 of 16 OPEN rows that were twins
 * of a transfer which had already gone further (dispatched or received).
 * The three identical `🔴 LAG▸KAN ·10B` chips were one load of ten bales
 * raised three times on one day by two people. Nothing in the bot knew two
 * rows were the same load, because nothing defined "the same load".
 *
 * This module does, once, for every caller:
 *   - `loadKey(aj)`         route + canonical multiset of (design, shade, qty).
 *                           The REQUESTER is deliberately not part of it.
 *   - `findIdenticalOpen`   the Send-time guard's question.
 *   - `findGhosts`          the census: an open pre-dispatch row whose load was
 *                           also raised as a row that went further.
 *   - `staleOpen`           open rows older than N days that are not ghosts.
 *
 * Pure functions over ApprovalQueue rows ({requestId, user, actionJSON,
 * status, createdAt}); no I/O, so the scripts and the flow share one truth.
 */

const ACTION = 'transfer_stock';

function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function qtyOf(l) { return Math.max(0, parseInt(l && l.qty, 10) || 0); }

/** Canonical key of a line multiset: sorted `design|shade|qty`, zero-qty lines dropped. */
function linesKey(lines) {
  return (lines || [])
    .filter((l) => l && qtyOf(l) > 0)
    .map((l) => `${norm(l.design)}|${norm(l.shade)}|${qtyOf(l)}`)
    .sort()
    .join(';');
}

/** Identity of a load: route + lines. Two rows with the same key are the same load. */
function loadKey(aj) {
  const a = aj || {};
  return `${norm(a.from)}>${norm(a.to)}#${linesKey(a.lines)}`;
}

function isTransfer(row) {
  return !!(row && row.actionJSON && row.actionJSON.action === ACTION);
}
function isOpen(row) { return norm(row && row.status) === 'pending'; }
function stageOf(row) { return norm(row && row.actionJSON && row.actionJSON.stage); }
function byCreatedAsc(a, b) { return String(a.createdAt || '').localeCompare(String(b.createdAt || '')); }

/**
 * The OPEN transfer identical to the load about to be sent, or null. When
 * several exist the OLDEST is returned — that is the one the team should
 * open, and the one every later copy is a ghost of. Rows that were
 * knowingly sent as duplicates (`duplicateOf` set) never block a send.
 * @param {Array<object>} openRows pending ApprovalQueue rows
 * @param {{from:string,to:string,lines:Array<object>}} load
 * @returns {object|null}
 */
function findIdenticalOpen(openRows, load) {
  const key = loadKey(load);
  const hits = (openRows || [])
    .filter((r) => isTransfer(r) && isOpen(r) && !r.actionJSON.duplicateOf && loadKey(r.actionJSON) === key)
    .sort(byCreatedAsc);
  return hits[0] || null;
}

/**
 * Ghosts. A ghost is an OPEN row at a pre-dispatch stage (`requested` or
 * `admin_review`) whose load was ALSO raised as another row that went
 * further: received (`approved`) or in transit. The further row is the real
 * one; the open pre-dispatch row is the ghost. A twin that was merely
 * declined does not make the open row a ghost — that open row may be the
 * legitimate re-raise.
 * @param {Array<object>} rows every ApprovalQueue row (any status)
 * @returns {Array<{ghost:object, twin:object, reason:string}>} oldest ghost first
 */
function findGhosts(rows) {
  const groups = new Map();
  for (const r of (rows || []).filter(isTransfer)) {
    const k = loadKey(r.actionJSON);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const further = group
      .filter((r) => norm(r.status) === 'approved' || (isOpen(r) && stageOf(r) === 'in_transit'))
      .sort(byCreatedAsc);
    if (!further.length) continue;
    const twin = further[further.length - 1];
    for (const r of group) {
      if (r === twin || !isOpen(r) || stageOf(r) === 'in_transit') continue;
      const what = norm(twin.status) === 'approved' ? 'received' : 'in transit';
      out.push({ ghost: r, twin, reason: `same load as ${twin.requestId}, which is ${what}` });
    }
  }
  return out.sort((a, b) => byCreatedAsc(a.ghost, b.ghost));
}

/**
 * Open rows older than `days` that are NOT ghosts — stale, and a human's call.
 * @param {Array<object>} rows
 * @param {number} days
 * @param {number} [now]
 */
function staleOpen(rows, days, now = Date.now()) {
  const ghostIds = new Set(findGhosts(rows).map((g) => g.ghost.requestId));
  const cutoff = now - days * 86400000;
  return (rows || [])
    .filter((r) => isTransfer(r) && isOpen(r) && !ghostIds.has(r.requestId))
    .filter((r) => (Date.parse(r.createdAt || '') || now) < cutoff)
    .sort(byCreatedAsc);
}

function ageDays(row, now = Date.now()) {
  const t = Date.parse(String(row && row.createdAt || ''));
  return Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null;
}

module.exports = { ACTION, linesKey, loadKey, findIdenticalOpen, findGhosts, staleOpen, ageDays, _internals: { norm, isTransfer, isOpen, stageOf } };
