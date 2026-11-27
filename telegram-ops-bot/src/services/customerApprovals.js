'use strict';

/**
 * ACA-1 (owner, 27-Nov-2026) — how many admins stand behind a NEW CUSTOMER.
 *
 *   "I want to make a toggle for admin to add customer through one admin
 *    approval or 2 admin. I need it on urgent basis and make it default to
 *    1 admin for now."
 *
 * One Settings cell, `ADD_CUSTOMER_APPROVALS`:
 *
 *   1 (default) — ONE admin is enough. An employee's request is approved by
 *                 one admin (as before). An admin's own entry is approved by
 *                 that admin: the self-approval guard steps aside for it.
 *   2           — TWO admins. An employee's request needs two different
 *                 admins; an admin's own entry needs one other admin (the
 *                 requester counts as the first — the DUAL-1 matrix); the
 *                 admin's ⚡ Quick Add, which writes at once, is closed.
 *
 * The rule is about what the request CREATES, not which button raised it:
 * an `add_contact` request that lands as a customer (the chip the approving
 * admin taps, else the kind the requester picked — the executor's own rule),
 * and the two legacy customer actions. A request routed to 📒 Contact or
 * 🕸 Network is not a customer and keeps its one admin.
 *
 * This module holds the VALUE; who signs is decided where it always was:
 * `risk/evaluate.needsTwoAdmins` → the DUAL-1 gate in approvalEvents and
 * `approvalGate.requiredFor`.
 *
 * Reading. The gate and the door AWAIT `count()` (the Settings sheet through
 * its 30 s cache). Card builders are synchronous and use `countNow()` — the
 * last value read, refreshed in the background when it is older than the
 * cache. A Settings read that fails keeps the last value read; before any
 * read has succeeded the in-code default (1) applies.
 */

const settingsRepository = require('../repositories/settingsRepository');
const logger = require('../utils/logger');

const KEY = 'ADD_CUSTOMER_APPROVALS';
const STALE_MS = 30 * 1000;

let _known = null; // 1 | 2 — the last value a Settings read gave
let _knownAt = 0;
let _inFlight = null;

/** A Settings cell → 1 or 2. Anything that is not clearly "two" is one. */
function parse(value) {
  if (value === null || value === undefined) return 1;
  const s = String(value).trim().toLowerCase();
  if (!s) return 1;
  if (s === 'two' || s === 'dual' || s === 'both') return 2;
  const n = Number(s);
  return Number.isFinite(n) && n >= 2 ? 2 : 1;
}

function defaultCount() {
  return parse(settingsRepository.DEFAULTS[KEY]);
}

/**
 * Does approving this request create a CUSTOMER? Mirrors the `add_contact`
 * executor: the destination an admin's chip saved, else the requested kind.
 */
function createsCustomer(aj) {
  if (!aj || typeof aj !== 'object') return false;
  if (aj.action === 'add_customer' || aj.action === 'new_customer') return true;
  if (aj.action !== 'add_contact') return false;
  const dest = aj.destination || (aj.type === 'customer' ? 'customer' : 'contact');
  return dest === 'customer';
}

/** Read the switch now. Never throws; a failed read keeps the last value. */
async function count() {
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      const all = await settingsRepository.getAllStrict();
      _known = parse(all[KEY]);
      _knownAt = Date.now();
    } catch (e) {
      logger.warn(`customerApprovals: Settings could not be read — keeping ${_known || defaultCount()} admin(s): ${e.message}`);
    }
    return _known || defaultCount();
  })();
  try { return await _inFlight; } finally { _inFlight = null; }
}

/** The last value read (synchronous). Refreshes in the background when stale. */
function countNow() {
  if (Date.now() - _knownAt > STALE_MS) count().catch(() => {});
  return _known || defaultCount();
}

/** Synchronous: this request needs two admins because it creates a customer. */
function twoAdminsNow(aj) {
  return createsCustomer(aj) && countNow() >= 2;
}

/**
 * May the admin who RAISED this request approve it themselves? Only a
 * request that creates a customer, and only while one admin is enough.
 * Read fresh; the caller has already established that the tapper is an admin.
 */
async function ownApprovalAllowed(aj) {
  if (!createsCustomer(aj)) return false;
  return (await count()) === 1;
}

/**
 * Boot: put the switch on the Settings sheet where it can be SEEN (a row
 * that is already there is never touched), and take a first reading.
 */
async function start() {
  try {
    const added = await settingsRepository.ensureRow(KEY, defaultCount());
    if (added) logger.info(`customerApprovals: ${KEY} added to the Settings sheet (${defaultCount()})`);
  } catch (e) { logger.warn(`customerApprovals: ${KEY} could not be added to Settings: ${e.message}`); }
  await count();
}

/** Test seam: forget what was read. */
function _reset() { _known = null; _knownAt = 0; _inFlight = null; }

module.exports = {
  KEY, parse, createsCustomer, count, countNow, twoAdminsNow, ownApprovalAllowed, start, _reset,
};
