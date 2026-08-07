'use strict';

/**
 * stockEngine — STK-E1 (owner-approved plan, specs/DATA-INTEGRITY_PLAN.md §3).
 *
 * THE one door to stock state. The 07-Aug audit counted 19 doors that
 * could flip an Inventory row's Status/Warehouse, each re-implementing
 * the safety rules itself — and every recent stock bug was one door
 * forgetting one rule (/revert_packages logging corrections as customer
 * returns being the canonical example).
 *
 * From STK-E1 on, EVERY stock mutation passes through here and must
 * declare two things:
 *
 *   event      what physically happened — sale · return · correction ·
 *              dispatch · receive · reject · repair · intake · rename
 *   authority  who authorised it — an approval requestId, an admin's
 *              userId, or a named system job (boot repair, CLI import)
 *
 * The engine validates both, then delegates to the repository writers,
 * which are PRIVATE to it: smoke S53 lints that no other file under src/
 * calls them, so a new door cannot appear by accident. The engine adds no
 * business logic of its own — approval gating stays in risk/evaluate +
 * the queue, exactly as before.
 *
 * Movement-log kinds are derived from the event, so a caller can no
 * longer write a `return` movement while meaning a correction.
 */

const inventoryRepository = require('../repositories/inventoryRepository');

const EVENTS = new Set([
  'sale', 'return', 'correction', 'dispatch', 'receive', 'reject',
  'repair', 'intake', 'rename',
]);

/**
 * @typedef {{event:string, approvalId?:string, adminId?:string, system?:string}} Authority
 */

/** Refuse any mutation that does not name its event and its authority. */
function assertAuthority(op, auth) {
  if (!auth || typeof auth !== 'object') {
    throw new Error(`stockEngine.${op}: authority required ({event, approvalId|adminId|system})`);
  }
  if (!EVENTS.has(auth.event)) {
    throw new Error(`stockEngine.${op}: unknown event '${auth.event}'`);
  }
  if (!auth.approvalId && !auth.adminId && !auth.system) {
    throw new Error(`stockEngine.${op}: no authority given (approvalId, adminId or system)`);
  }
  return auth;
}

/** The movement-log actor string for an authority. */
function userOf(auth) {
  return String(auth.adminId || auth.system || `approval:${auth.approvalId}`);
}

/* ── available → sold ─────────────────────────────────────────────────── */

async function sellThan(packageNo, thanNo, customer, salesDate, opts, auth) {
  assertAuthority('sellThan', auth);
  return inventoryRepository.markThanSold(packageNo, thanNo, customer, salesDate,
    { ...opts, user: userOf(auth) });
}

async function sellPackage(packageNo, customer, salesDate, opts, auth) {
  assertAuthority('sellPackage', auth);
  return inventoryRepository.markPackageSold(packageNo, customer, salesDate,
    { ...opts, user: userOf(auth) });
}

/* ── sold → available ─────────────────────────────────────────────────── */

/** The movement kind comes from the EVENT — a correction can never pose
 *  as a customer return again (RET-2). */
function returnKind(op, auth) {
  if (auth.event === 'return') return 'return';
  if (auth.event === 'correction') return 'correction';
  throw new Error(`stockEngine.${op}: event must be 'return' or 'correction', got '${auth.event}'`);
}

async function returnThan(packageNo, thanNo, opts, auth) {
  assertAuthority('returnThan', auth);
  return inventoryRepository.markThanAvailable(packageNo, thanNo,
    { ...opts, kind: returnKind('returnThan', auth), user: userOf(auth) });
}

async function returnPackage(packageNo, opts, auth) {
  assertAuthority('returnPackage', auth);
  return inventoryRepository.markPackageAvailable(packageNo,
    { ...opts, kind: returnKind('returnPackage', auth), user: userOf(auth) });
}

/* ── transfers: available ⇄ in_transit ────────────────────────────────── */

async function transition(packageNos, fromStatus, toStatus, toWarehouse, opts, auth) {
  assertAuthority('transition', auth);
  if (!['dispatch', 'receive', 'reject', 'repair'].includes(auth.event)) {
    throw new Error(`stockEngine.transition: event must be a transfer event, got '${auth.event}'`);
  }
  return inventoryRepository.transitionBales(packageNos, fromStatus, toStatus, toWarehouse,
    { ...opts, kind: auth.event === 'repair' ? 'transfer' : auth.event, user: userOf(auth) });
}

/* ── births: intake ───────────────────────────────────────────────────── */

async function intakeBale(baleRows, auth) {
  assertAuthority('intakeBale', auth);
  if (auth.event !== 'intake') throw new Error(`stockEngine.intakeBale: event must be 'intake', got '${auth.event}'`);
  return inventoryRepository.appendBale(baleRows);
}

async function intakeThans(rows, auth) {
  assertAuthority('intakeThans', auth);
  if (auth.event !== 'intake') throw new Error(`stockEngine.intakeThans: event must be 'intake', got '${auth.event}'`);
  return inventoryRepository.appendThans(rows);
}

/* ── warehouse rename (column I rewrite — a label, not a movement) ────── */

async function renameWarehouse(oldName, newName, auth) {
  assertAuthority('renameWarehouse', auth);
  if (auth.event !== 'rename') throw new Error(`stockEngine.renameWarehouse: event must be 'rename', got '${auth.event}'`);
  return inventoryRepository.renameWarehouse(oldName, newName);
}

module.exports = {
  sellThan, sellPackage, returnThan, returnPackage,
  transition, intakeBale, intakeThans, renameWarehouse,
  _internals: { EVENTS, assertAuthority, userOf },
};
