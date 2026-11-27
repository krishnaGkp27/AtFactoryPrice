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
 * cache.
 *
 * Fail closed. A Settings read that fails keeps the last value READ. While
 * no read has ever succeeded (a restart with the sheet unreadable) the
 * switch is UNCONFIRMED: a customer entry then needs two admins and an
 * admin may not approve their own — the owner's 2 must never become 1
 * because Google refused a read. The first read that succeeds settles it.
 * "Default 1" is what a READ sheet with no row, or an empty cell, means.
 */

const settingsRepository = require('../repositories/settingsRepository');
const logger = require('../utils/logger');

const KEY = 'ADD_CUSTOMER_APPROVALS';
const STALE_MS = 30 * 1000;

let _known = null; // 1 | 2 — the last value a Settings read gave; null = never read
let _knownAt = 0;
let _inFlight = null;
let _lastOdd = null; // the last unrecognised cell value warned about

/** While no Settings read has ever succeeded: the strict reading. */
const UNCONFIRMED = 2;

/**
 * A Settings cell → 1 or 2. Two is read generously — `2`, `2 admins`,
 * `two`, `Two admins`, `dual`, a full-width ２ — because a cell the owner
 * meant as two must never be taken for one. Everything else is one.
 */
function parse(value) {
  if (value === null || value === undefined) return 1;
  const s = String(value).normalize('NFKC').trim().toLowerCase();
  if (!s) return 1;
  if (/^(two|dual|both)\b/.test(s)) return 2;
  const lead = s.match(/^\d+(\.\d+)?/);
  return lead && Number(lead[0]) >= 2 ? 2 : 1;
}

/** Is the cell one of the values the switch documents? (for a log line) */
function recognised(value) {
  if (value === null || value === undefined) return true;
  const s = String(value).normalize('NFKC').trim().toLowerCase();
  return s === '' || s === '1' || s === '2';
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
      // getAllStrict throws on an unreadable sheet (getAll would answer the
      // in-code defaults, which here would turn the owner's 2 into 1). A
      // settings module without it is a test stub: its getAll is the read.
      const read = typeof settingsRepository.getAllStrict === 'function' ? settingsRepository.getAllStrict
        : (typeof settingsRepository.getAll === 'function' ? settingsRepository.getAll : null);
      if (!read) throw new Error('no Settings read available');
      const all = await read();
      if (!all || typeof all !== 'object') throw new Error('Settings read returned nothing');
      const next = parse(all[KEY]);
      if (!recognised(all[KEY]) && _lastOdd !== String(all[KEY])) {
        _lastOdd = String(all[KEY]);
        logger.warn(`customerApprovals: ${KEY} holds "${_lastOdd}" — read as ${next} admin(s). Type 1 or 2.`);
      }
      _known = next;
      _knownAt = Date.now();
    } catch (e) {
      logger.warn(`customerApprovals: Settings could not be read — ${_known
        ? `keeping ${_known} admin(s)` : 'not confirmed yet, so two admins are required'}: ${e.message}`);
    }
    return _known || UNCONFIRMED;
  })();
  try { return await _inFlight; } finally { _inFlight = null; }
}

/** The last value read (synchronous). Refreshes in the background when stale. */
function countNow() {
  try {
    if (Date.now() - _knownAt > STALE_MS) count().catch(() => {});
  } catch (_) { /* a card is never broken by a refresh */ }
  return _known || UNCONFIRMED;
}

/** Has a Settings read ever succeeded? */
function confirmed() { return _known !== null; }

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
  // Only on a value that was actually READ: an unconfirmed switch never
  // opens the self-approval guard.
  return (await count()) === 1 && confirmed();
}

/**
 * Boot: put the switch on the Settings sheet where it can be SEEN (a row
 * that is already there is never touched), and take a first reading.
 */
async function start() {
  try {
    const dflt = parse(((settingsRepository && settingsRepository.DEFAULTS) || {})[KEY]);
    const added = await settingsRepository.ensureRow(KEY, dflt);
    if (added) logger.info(`customerApprovals: ${KEY} added to the Settings sheet (${dflt})`);
  } catch (e) { logger.warn(`customerApprovals: ${KEY} could not be added to Settings: ${e.message}`); }
  await count();
}

/** Test seam: forget what was read. */
function _reset() { _known = null; _knownAt = 0; _inFlight = null; _lastOdd = null; }

module.exports = {
  KEY, parse, createsCustomer, count, countNow, confirmed, twoAdminsNow, ownApprovalAllowed, start, _reset,
};
