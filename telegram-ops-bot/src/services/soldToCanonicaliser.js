'use strict';

/**
 * soldToCanonicaliser — ISC-1 Phase 2b: the pure planner behind
 * scripts/canonicalise-sold-to.js.
 *
 * WHY (ISC-1 §2b). Inventory column L (SoldTo) is free text with no
 * customer_id, and the 04-Sep-2026 census found one buyer under several
 * spellings: R1 `Awunawu` / `Awurawu` / `awunawu` (250 thans) and R2
 * `madam oshodi` / `oshodi madam` / `Oshodi alaja` / `Alhaja oshodi` (170
 * thans). CUS-1 Merge Customers folds a typo into `aliases` on the
 * canonical row and the alias-aware readers unify the history — but seven
 * readers still compare the RAW cell (soldBalesFlow exactly; the supply
 * details flows, queryEngine and three controller reports case-
 * insensitively), so after a merge the same buyer is one person on some
 * screens and three on others. The durable fix is the cell itself carrying
 * the registry's spelling; the alias stays behind for history.
 *
 * ORDER (BUSINESS_RULES §12 — "no guessing, only solid customers"): merge
 * first, rewrite second. This module never decides who a spelling belongs
 * to; it only checks that the Customers register ALREADY says so:
 *   (i)   the canonical spelling names exactly ONE live Customers row, and
 *         the value written is THAT row's spelling, not the map's. The
 *         resolver must also actually RETURN that row for the spelling:
 *         customerEntity.resolve excludes only Merged rows and takes the
 *         first name hit in sheet order, so an earlier Inactive / Pending /
 *         Rejected row of the same name would claim every rewritten cell
 *         for a dead husk — such a shadowed canonical blocks the cluster;
 *   (ii)  every ruled variant resolves — by customerEntity's own rule
 *         (canonical name or alias, case-insensitive, merged rows
 *         excluded) — to that very customer. A variant that resolves to
 *         somebody else, or to nobody, blocks the WHOLE cluster with
 *         "run Merge Customers first (CUS-1)";
 *   (iii) a cell already carrying the registry spelling is a no-op — counted
 *         as already canonical, never written, even when the map spells the
 *         canonical differently (map `Alhaja oshodi`, register `Alhaja Oshodi`);
 *   (iv)  only a cell that spells the canonical or a ruled variant EXACTLY
 *         (after trim) is planned — a casing nobody ruled on is reported
 *         under `unruled` and never rewritten.
 * R3 (`Ketu madam` vs `ketu police Man`) is ruled TWO people, so the
 * default map deliberately has no Ketu cluster; a custom map is honoured
 * as given, so an explicit ruling later needs no code change.
 *
 * Pure: takes parsed Inventory rows, the cluster map and parsed Customers
 * rows; returns a plan. Nothing here touches a sheet.
 */

const customerEntity = require('./customerEntity');

const { HIDDEN_STATUSES, norm } = customerEntity._internals;

/**
 * R1 and R2 exactly as ruled (ISC-1 §5, recommended answers). R3 is absent
 * on purpose — see the file docblock.
 */
const DEFAULT_CLUSTERS = Object.freeze([
  { canonical: 'Awunawu', variants: ['Awurawu', 'awunawu'] },
  { canonical: 'Alhaja oshodi', variants: ['madam oshodi', 'oshodi madam', 'Oshodi alaja'] },
]);

/** The one reason a cluster is blocked on its variants — the fix is in-bot, dual-admin. */
const REASON_MERGE_FIRST = 'run Merge Customers first (CUS-1)';

const str = (v) => String(v == null ? '' : v).trim();

/** "Live" = pickable: the same statuses customerEntity hides from every picker. */
const isLive = (c) => !HIDDEN_STATUSES.has(norm(c.status || 'Active'));

/**
 * customerEntity.resolve's NAME rule over a given row set. The real
 * resolver reads the repository itself; the planner works on the rows it
 * was handed so a dry-run and its commit reason over one register. The
 * unit tests pin this against the real resolver on the same fixture.
 * @param {object[]} customers parsed Customers rows
 * @param {string} name spelling to resolve
 * @returns {object|null} the customer row, or null when nobody claims it
 */
function resolveName(customers, name) {
  const n = norm(name);
  if (!n) return null;
  const live = customers.filter((c) => norm(c.status) !== 'merged');
  const byName = live.find((c) => norm(c.name) === n);
  if (byName) return byName;
  return live.find((c) => (c.aliases || []).some((a) => norm(a) === n)) || null;
}

/**
 * Refuse a malformed map: every cluster needs a canonical and at least one
 * variant, and no spelling may sit in two clusters (that would make two
 * rewrites compete for one cell).
 * @param {Array<{canonical:string, variants:string[]}>} clusters
 * @throws {Error} describing the first problem found
 */
function validateClusters(clusters) {
  if (!Array.isArray(clusters) || !clusters.length) {
    throw new Error('cluster map must be a non-empty array of {canonical, variants}');
  }
  const owner = new Map(); // normalised spelling → canonical it belongs to
  clusters.forEach((c, i) => {
    if (!c || typeof c !== 'object') throw new Error(`cluster #${i + 1}: not an object`);
    const canonical = str(c.canonical);
    if (!canonical) throw new Error(`cluster #${i + 1}: canonical must be a non-empty string`);
    if (!Array.isArray(c.variants) || !c.variants.length) {
      throw new Error(`cluster "${canonical}": variants must be a non-empty array`);
    }
    for (const s of [canonical, ...c.variants]) {
      const v = str(s);
      if (!v) throw new Error(`cluster "${canonical}": empty spelling in variants`);
      const key = norm(v);
      if (owner.has(key) && owner.get(key) !== canonical) {
        throw new Error(`spelling "${v}" appears in two clusters ("${owner.get(key)}" and "${canonical}")`);
      }
      owner.set(key, canonical);
    }
  });
}

/**
 * Plan one cluster. See the file docblock for the rules.
 * @returns {{canonical:string, target:object|null, status:'ready'|'blocked', reason:string|null,
 *   problems:string[], counts:Object<string,number>, rows:Array<{rowIndex:number,current:string,next:string|null}>,
 *   unruled:Array<{rowIndex:number,current:string}>, writes:number}}
 */
function planCluster(rows, cluster, customers) {
  const canonical = str(cluster.canonical);
  const variants = cluster.variants.map(str);
  const spellings = [canonical, ...variants];
  const exact = new Set(spellings);
  const problems = [];

  // (i) the canonical names exactly one LIVE Customers row.
  const byName = customers.filter((c) => norm(c.name) === norm(canonical));
  const live = byName.filter(isLive);
  let target = null;
  let reason = null;
  if (live.length === 1) {
    target = live[0];
  } else if (live.length > 1) {
    reason = `canonical "${canonical}" matches ${live.length} live Customers rows — ambiguous`;
    problems.push(`${reason}: ${live.map((c) => `${c.customer_id || '(no id)'} row ${c.rowIndex}`).join(', ')}`);
  } else if (byName.length) {
    reason = `canonical "${canonical}" is not a live customer`;
    problems.push(`${reason}: ${byName.map((c) => `row ${c.rowIndex} status "${c.status}"`).join(', ')}`);
  } else {
    reason = `canonical "${canonical}" matches no Customers row by name`;
    problems.push(reason);
  }

  // (i) continued: the resolver must hand that very row back for the
  // spelling. resolve() drops only Merged rows and takes the FIRST name hit
  // in sheet order, so an Inactive / Pending / Rejected row of the same
  // name sitting above the live one would claim every rewritten cell.
  if (target) {
    // target is live and carries the name, so a name lookup always hits a row.
    for (const spelling of new Set([canonical, target.name])) {
      const hit = resolveName(customers, spelling);
      if (hit === target) continue;
      reason = `canonical "${canonical}" is shadowed by Customers row ${hit.rowIndex} (status "${hit.status}")`;
      problems.push(`${reason}: the bot resolves "${spelling}" to "${hit.name}" `
        + `(${hit.customer_id || 'no id'}, row ${hit.rowIndex}), not to row ${target.rowIndex} — merge that row first`);
      target = null;
      break;
    }
  }

  // The registry's own spelling is a ruled no-op: a cell already carrying it
  // is counted as already canonical, never reported as unruled.
  if (target) exact.add(target.name);

  // (ii) every variant resolves to that same customer, by the resolver's rule.
  if (target) {
    for (const v of variants) {
      const hit = resolveName(customers, v);
      if (!hit) {
        problems.push(`variant "${v}" resolves to nobody — merge it into "${target.name}" first`);
      } else if (hit !== target) {
        problems.push(`variant "${v}" resolves to "${hit.name}" (${hit.customer_id || 'no id'}, row ${hit.rowIndex}) — a different customer`);
      }
    }
    if (problems.length) reason = REASON_MERGE_FIRST;
  }

  const status = target && !problems.length ? 'ready' : 'blocked';

  // (iii)/(iv) the cells: ruled spellings exactly; near-misses reported only.
  // A blocked cluster lists its cells (so the owner sees what waits on the
  // merge) but names no `next` — nothing may be written for it.
  const counts = {};
  const affected = [];
  const unruled = [];
  for (const r of rows) {
    const current = str(r.soldTo);
    if (!current) continue;
    if (exact.has(current)) {
      counts[current] = (counts[current] || 0) + 1;
      affected.push({ rowIndex: r.rowIndex, current, next: status === 'ready' ? target.name : null });
    } else if (spellings.some((s) => norm(s) === norm(current))) {
      unruled.push({ rowIndex: r.rowIndex, current });
    }
  }

  const writes = status === 'ready' ? affected.filter((a) => a.next !== a.current).length : 0;
  return {
    canonical,
    target: target ? { rowIndex: target.rowIndex, customer_id: target.customer_id, name: target.name } : null,
    status,
    reason: status === 'ready' ? null : reason,
    problems,
    counts,
    rows: affected,
    unruled,
    writes,
  };
}

/**
 * Build the rewrite plan for column L.
 * @param {object[]} rows parsed Inventory rows (inventoryRepository shape: rowIndex, soldTo, …)
 * @param {Array<{canonical:string, variants:string[]}>} [clusterMap] defaults to R1 + R2
 * @param {object[]} [customers] parsed Customers rows (customer_id, name, status, aliases, rowIndex)
 * @returns {{clusters:object[], plan:Array<{rowIndex:number,current:string,next:string,cluster:string}>}}
 *   `plan` carries only the cells that change, and only from READY clusters.
 * @throws {Error} on a malformed cluster map
 */
function buildPlan(rows, clusterMap = DEFAULT_CLUSTERS, customers = []) {
  validateClusters(clusterMap);
  const clusters = clusterMap.map((c) => planCluster(rows || [], c, customers || []));
  const plan = [];
  for (const c of clusters) {
    if (c.status !== 'ready') continue;
    for (const r of c.rows) {
      if (r.next === r.current) continue;
      plan.push({ rowIndex: r.rowIndex, current: r.current, next: r.next, cluster: c.canonical });
    }
  }
  return { clusters, plan };
}

module.exports = {
  buildPlan,
  validateClusters,
  DEFAULT_CLUSTERS,
  REASON_MERGE_FIRST,
  _internals: { resolveName, planCluster, isLive },
};
