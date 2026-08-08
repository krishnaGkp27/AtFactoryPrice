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

/**
 * STK-PG Phase 1 — the SHADOW ledger write. Because the engine is the ONE
 * door (S53), this single hook mirrors every stock mutation into Postgres
 * stock_events alongside the Sheets writes. Best-effort by contract: the
 * repository never throws, PG-off is a no-op, and the sheet remains the
 * source of truth until the owner's explicit flip decision
 * (specs/STK-PG_PHASE1.md).
 */
async function shadow(rows, auth, meta = {}) {
  try {
    const stockEventsRepository = require('../repositories/stockEventsRepository');
    await stockEventsRepository.record((rows || []).filter(Boolean), {
      event: auth.event,
      authority: auth.approvalId ? 'approval' : (auth.adminId ? 'admin' : 'system'),
      approvalId: auth.approvalId || '',
      actor: userOf(auth),
      ...meta,
    });
  } catch (_) { /* shadow must never disturb the real write */ }
}

/* ── available → sold ─────────────────────────────────────────────────── */

async function sellThan(packageNo, thanNo, customer, salesDate, opts, auth) {
  assertAuthority('sellThan', auth);
  const result = await inventoryRepository.markThanSold(packageNo, thanNo, customer, salesDate,
    { ...opts, user: userOf(auth) });
  if (result) await shadow([result], auth, { customer, businessDay: require('./baleMovementLog').businessDay(salesDate) });
  return result;
}

async function sellPackage(packageNo, customer, salesDate, opts, auth) {
  assertAuthority('sellPackage', auth);
  const results = await inventoryRepository.markPackageSold(packageNo, customer, salesDate,
    { ...opts, user: userOf(auth) });
  if (results && results.length) await shadow(results, auth, { customer, businessDay: require('./baleMovementLog').businessDay(salesDate) });
  return results;
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
  const result = await inventoryRepository.markThanAvailable(packageNo, thanNo,
    { ...opts, kind: returnKind('returnThan', auth), user: userOf(auth) });
  if (result) {
    await shadow([result], auth, {
      customer: result.soldToPrior || '',
      businessDay: require('./baleMovementLog').businessDay(opts && opts.on),
    });
  }
  return result;
}

async function returnPackage(packageNo, opts, auth) {
  assertAuthority('returnPackage', auth);
  const results = await inventoryRepository.markPackageAvailable(packageNo,
    { ...opts, kind: returnKind('returnPackage', auth), user: userOf(auth) });
  if (results && results.length) {
    // A batch can span buyers (recycled numbers, RET-2) — one shadow event
    // per buyer keeps the customer column truthful.
    const byBuyer = new Map();
    for (const r of results) {
      const b = String(r.soldToPrior || '');
      if (!byBuyer.has(b)) byBuyer.set(b, []);
      byBuyer.get(b).push(r);
    }
    for (const [buyer, rows] of byBuyer) {
      await shadow(rows, auth, {
        customer: buyer,
        businessDay: require('./baleMovementLog').businessDay(opts && opts.on),
      });
    }
  }
  return results;
}

/* ── transfers: available ⇄ in_transit ────────────────────────────────── */

async function transition(packageNos, fromStatus, toStatus, toWarehouse, opts, auth) {
  assertAuthority('transition', auth);
  if (!['dispatch', 'receive', 'reject', 'repair'].includes(auth.event)) {
    throw new Error(`stockEngine.transition: event must be a transfer event, got '${auth.event}'`);
  }
  const flipped = await inventoryRepository.transitionBales(packageNos, fromStatus, toStatus, toWarehouse,
    { ...opts, kind: auth.event === 'repair' ? 'transfer' : auth.event, user: userOf(auth) });
  if (flipped && flipped.length) {
    await shadow(flipped, auth, {
      businessDay: require('./baleMovementLog').businessDay(opts && opts.on),
      warehouseFrom: (opts && opts.fromWarehouse) !== undefined ? opts.fromWarehouse : undefined,
      warehouseTo: toWarehouse || undefined,
    });
  }
  return flipped;
}

/* ── births: intake ───────────────────────────────────────────────────── */

async function intakeBale(baleRows, auth) {
  assertAuthority('intakeBale', auth);
  if (auth.event !== 'intake') throw new Error(`stockEngine.intakeBale: event must be 'intake', got '${auth.event}'`);
  const persisted = await inventoryRepository.appendBale(baleRows);
  await shadow(baleRows, auth, {
    businessDay: require('./baleMovementLog').businessDay(baleRows && baleRows[0] && baleRows[0].dateReceived),
  });
  return persisted;
}

async function intakeThans(rows, auth) {
  assertAuthority('intakeThans', auth);
  if (auth.event !== 'intake') throw new Error(`stockEngine.intakeThans: event must be 'intake', got '${auth.event}'`);
  const count = await inventoryRepository.appendThans(rows);
  await shadow(rows, auth, {
    businessDay: require('./baleMovementLog').businessDay(rows && rows[0] && rows[0].dateReceived),
  });
  return count;
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
  _internals: { EVENTS, assertAuthority, userOf, shadow },
};
