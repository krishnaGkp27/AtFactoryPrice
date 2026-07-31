'use strict';

/**
 * CUS-1 — the customer as ONE entity (owner concept, 29-Jul-2026).
 *
 * `customer_id` is the permanent key; the name is a display label; `aliases`
 * are former/typo spellings that resolve here after a merge. Every flow and
 * service resolves customers THROUGH this module — nobody compares raw names
 * against sheet cells any more, because raw-name matching is exactly how the
 * typo problem grew.
 *
 * Resolution order: id (exact) → canonical name (case-insensitive) → alias
 * (case-insensitive). Reads may resolve by alias; WRITES always stamp the
 * canonical id + canonical name, which is what makes the owner's cleanup
 * stick: an old spelling can find its customer, but can never propagate.
 *
 * Invariant (until Phase C completes): two ACTIVE customers may not share a
 * display name, because name-fallback reads still exist. `assertNameFree`
 * enforces it at the single creation door.
 */

const customersRepository = require('../repositories/customersRepository');
const logger = require('../utils/logger');

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** Statuses that keep a customer OUT of every picker and suggestion.
 *  CUS-2: 'rejected' added — the reject door writes it (approvalEvents),
 *  and without it a rejected registration stayed fully selectable. */
const HIDDEN_STATUSES = new Set(['inactive', 'merged', 'pending', 'rejected']);

/**
 * Resolve {id} or {name} (canonical or alias) to the canonical customer.
 * @param {{id?: string, name?: string}} q
 * @returns {Promise<object|null>}
 */
async function resolve(q = {}) {
  const all = await customersRepository.getAll();
  if (q.id) {
    const hit = all.find((c) => c.customer_id === String(q.id).trim());
    if (hit) return hit;
  }
  const n = norm(q.name);
  if (!n) return null;
  // Merged rows never win a name match: after a merge the typo's own row
  // still carries its old name, and without this exclusion it would shadow
  // the alias on the REAL customer — resolving history to a dead husk.
  const live = all.filter((c) => norm(c.status) !== 'merged');
  const byName = live.find((c) => norm(c.name) === n);
  if (byName) return byName;
  // Alias hit resolves to the row CARRYING the alias — the canonical one.
  return live.find((c) => (c.aliases || []).some((a) => norm(a) === n)) || null;
}

/** Active customers only — the ONLY legitimate source for pickers.
 *  Excludes Inactive, Merged AND Pending (Pending rows used to leak into
 *  pickers because callers filtered only 'inactive'). */
async function activeList() {
  const all = await customersRepository.getAll();
  return all.filter((c) => !HIDDEN_STATUSES.has(norm(c.status || 'Active')));
}

/** Search active customers by name OR alias substring. */
async function search(query) {
  const q = norm(query);
  if (!q) return [];
  return (await activeList()).filter((c) => norm(c.name).includes(q)
    || (c.aliases || []).some((a) => norm(a).includes(q)));
}

/**
 * Every spelling this customer's history may be filed under — canonical
 * name plus aliases. Rate memory and ledger reads use this so merged
 * history consolidates instead of going blind.
 */
function namesFor(customer) {
  if (!customer) return [];
  return [customer.name, ...(customer.aliases || [])].filter(Boolean);
}

/**
 * Picker label. When two active customers share a display name (possible
 * after Phase C), the phone tail disambiguates — the owner's "differentiate
 * this customer from that one" requirement.
 */
function labelFor(customer, allActive) {
  const name = customer.name || customer.customer_id;
  const dup = (allActive || []).filter((c) => norm(c.name) === norm(name));
  if (dup.length > 1 && customer.phone) {
    const tail = String(customer.phone).replace(/\D/g, '').slice(-4);
    return tail ? `${name} (…${tail})` : name;
  }
  return name;
}

/** Refuse a new ACTIVE customer whose name collides with an existing
 *  canonical name or alias. */
async function assertNameFree(name) {
  const hit = await resolve({ name });
  if (hit) {
    return { ok: false, existing: hit };
  }
  return { ok: true };
}

/**
 * Backfill customer_id on any Customers row missing one. Sheet-editable
 * data means hand-added rows arrive without ids; the entity model needs
 * every row keyed. Safe to run at startup — no-op when all rows have ids.
 */
async function ensureIds() {
  const all = await customersRepository.getAll();
  const idGenerator = require('../utils/idGenerator');
  let fixed = 0;
  for (const c of all) {
    if (c.customer_id || !c.name) continue;
    try {
      // updateRow keys by id, which this row lacks — write the cell directly.
      const sheets = require('../repositories/sheetsClient');
      await sheets.updateRange(customersRepository.SHEET, `A${c.rowIndex}`,
        [[idGenerator.customer()]]);
      fixed += 1;
    } catch (e) {
      logger.warn(`customerEntity.ensureIds: row ${c.rowIndex} failed: ${e.message}`);
    }
  }
  if (fixed) {
    customersRepository.invalidateCache();
    logger.info(`customerEntity.ensureIds: backfilled ${fixed} missing customer_id(s)`);
  }
  return fixed;
}

/* ── merge primitives (used by the Phase E flow's executor) ─────────────── */

/**
 * Fold `typo` into `canonical`: the typo's name (and its aliases) become
 * aliases on the canonical row; the typo row is retained with status
 * 'Merged' for audit and never appears in a picker again.
 */
async function mergeInto(canonicalId, typoId) {
  const all = await customersRepository.getAll();
  const canonical = all.find((c) => c.customer_id === canonicalId);
  const typo = all.find((c) => c.customer_id === typoId);
  if (!canonical || !typo) return { ok: false, reason: 'not_found' };
  if (canonicalId === typoId) return { ok: false, reason: 'same_customer' };
  if (norm(typo.status) === 'merged') return { ok: false, reason: 'already_merged' };

  const aliases = new Set(canonical.aliases || []);
  for (const a of namesFor(typo)) {
    if (norm(a) !== norm(canonical.name)) aliases.add(a);
  }
  await customersRepository.updateRow(canonicalId, { aliases: [...aliases] });
  await customersRepository.updateRow(typoId, {
    status: 'Merged',
    notes: `${typo.notes ? `${typo.notes} · ` : ''}Merged into ${canonical.name} (${canonicalId})`,
  });
  return { ok: true, canonical, typo, aliases: [...aliases] };
}

module.exports = {
  resolve, activeList, search, namesFor, labelFor,
  assertNameFree, ensureIds, mergeInto,
  _internals: { HIDDEN_STATUSES, norm },
};
