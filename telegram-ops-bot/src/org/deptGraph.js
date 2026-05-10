/**
 * Department tree helpers for TG-7.5 (org hierarchy).
 * Pure functions — pass rows from departmentsRepository / usersRepository.
 *
 * Tree edges: child.dept_name → parent_department (parent name string).
 * Matching is case-insensitive for names.
 */

'use strict';

/** @param {string} s */
function norm(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * @param {Array<{ dept_name: string, parent_department?: string, allowed_activities?: string[] }>} departments
 * @returns {{ byNorm: Map<string, { name: string, parentNorm: string, parentRaw: string, activities: string[] }> }}
 */
function buildGraph(departments) {
  const byNorm = new Map();
  for (const d of departments || []) {
    const name = String(d.dept_name || '').trim();
    if (!name) continue;
    const key = norm(name);
    if (byNorm.has(key)) continue;
    const parentRaw = String(d.parent_department || '').trim();
    byNorm.set(key, {
      name,
      parentNorm: parentRaw ? norm(parentRaw) : '',
      parentRaw,
      activities: Array.isArray(d.allowed_activities) ? d.allowed_activities : [],
    });
  }
  return { byNorm };
}

/**
 * Walk from deptName upward through parent_department chain.
 * @returns {{ chainNorm: string[], names: string[], cycle: boolean }}
 */
function getAncestorChain(deptName, graph) {
  const chainNorm = [];
  const names = [];
  let cur = norm(deptName);
  const seen = new Set();
  while (cur) {
    if (seen.has(cur)) {
      return { chainNorm, names, cycle: true };
    }
    seen.add(cur);
    chainNorm.push(cur);
    const node = graph.byNorm.get(cur);
    if (!node) break;
    names.push(node.name);
    if (!node.parentNorm) break;
    cur = node.parentNorm;
  }
  return { chainNorm, names, cycle: false };
}

/**
 * True if ancestorDeptName is on the parent chain of deptName (including deptName === ancestor).
 */
function deptUnderAncestor(deptName, ancestorDeptName, graph) {
  const want = norm(ancestorDeptName);
  if (!want) return false;
  const { chainNorm } = getAncestorChain(deptName, graph);
  return chainNorm.includes(want);
}

/**
 * Validate: no cycles; every non-empty parent references an existing department row.
 * @param {Array<{ dept_name: string, parent_department?: string, allowed_activities?: string[] }>} departments
 * @returns {{ ok: boolean, errors: string[], graph: ReturnType<typeof buildGraph> }}
 */
function validateForest(departments) {
  const graph = buildGraph(departments);
  const errors = [];
  for (const [, node] of graph.byNorm) {
    const { chainNorm, cycle } = getAncestorChain(node.name, graph);
    if (cycle) {
      errors.push(`Cycle in department hierarchy involving "${node.name}"`);
      break;
    }
    if (node.parentNorm && !graph.byNorm.has(node.parentNorm)) {
      errors.push(
        `Department "${node.name}" references unknown parent "${node.parentRaw}"`,
      );
    }
    // silence unused
    void chainNorm;
  }
  return { ok: errors.length === 0, errors, graph };
}

/**
 * Target user's every department must lie under (or equal to) at least one department in actor.manages.
 * @param {{ manages?: string[], departments?: string[], department?: string }} actorUser
 * @param {{ departments?: string[], department?: string }} targetUser
 * @param {{ byNorm: Map<string, unknown> }} graph
 */
function canAssignTo(actorUser, targetUser, graph) {
  if (!actorUser || !targetUser) return false;
  const manages = Array.isArray(actorUser.manages)
    ? actorUser.manages.map((m) => String(m).trim()).filter(Boolean)
    : [];
  if (!manages.length) return false;

  const targetDepts = Array.isArray(targetUser.departments) && targetUser.departments.length
    ? targetUser.departments.map((d) => String(d).trim()).filter(Boolean)
    : (targetUser.department ? [String(targetUser.department).trim()] : []);

  if (!targetDepts.length) return false;

  for (const td of targetDepts) {
    let covered = false;
    for (const m of manages) {
      if (norm(td) === norm(m) || deptUnderAncestor(td, m, graph)) {
        covered = true;
        break;
      }
    }
    if (!covered) return false;
  }
  return true;
}

/**
 * Union of allowed_activities from every department row whose name is in user.manages (exact name match on sheet; compared case-insensitively here).
 * @param {{ manages?: string[] }} user
 * @param {Array<{ dept_name: string, allowed_activities?: string[] }>} allDepartments
 */
function mergeActivitiesForManages(user, allDepartments) {
  const manages = Array.isArray(user?.manages)
    ? user.manages.map((m) => norm(m)).filter(Boolean)
    : [];
  if (!manages.length) return [];
  const set = new Set();
  for (const d of allDepartments || []) {
    const dn = norm(d.dept_name);
    if (!dn || !manages.includes(dn)) continue;
    const acts = Array.isArray(d.allowed_activities) ? d.allowed_activities : [];
    for (const a of acts) {
      const t = String(a || '').trim();
      if (t) set.add(t);
    }
  }
  return [...set];
}

module.exports = {
  norm,
  buildGraph,
  getAncestorChain,
  deptUnderAncestor,
  validateForest,
  canAssignTo,
  mergeActivitiesForManages,
};
