'use strict';

/**
 * marketerOverlay — pure helpers for the Marketing Group Catalog feature
 * (spec: telegram-ops-bot/specs/marketing-group-catalog.md).
 *
 * MG-1 scope (this commit): identify whether a user is acting as a
 * marketer, resolve which marketing-group department they belong to,
 * and expose the group's warehouses for the supply_request pin.
 * Later commits (MG-2: price badge + design visibility, MG-3+: shade
 * controls) extend this module with more resolvers; the shape here is
 * deliberately tiny so the controller injection stays surgical.
 *
 * A "marketing group" IS a department (spec §0/§9): the department
 * row carries a non-empty `warehouses` CSV (added in MG-1's Departments
 * schema migration). No new grouping entity is introduced.
 *
 * All functions are pure-ish: they take repos via dependency injection
 * (default = the real repos) so the smoke harness can drive them with
 * inline fixtures and zero Sheets I/O.
 */

const config = require('../config');
const departmentsRepoDefault = require('../repositories/departmentsRepository');

/**
 * @typedef {object} Group
 * @property {string} dept_id
 * @property {string} dept_name
 * @property {string[]} warehouses
 */

/**
 * Is the master overlay feature flag on?
 * Reading via this helper (not inline) so every injection site uses
 * the same gate and a single flag flip disables MG everywhere.
 *
 * @returns {boolean}
 */
function isEnabled() {
  return !!(config.marketing && config.marketing.overlayEnabled);
}

/**
 * Resolve the marketing group a user belongs to.
 * First matching marketing-group department wins (spec §5.1 / A1):
 * "marketing group" = a department whose `warehouses` CSV is non-empty.
 *
 * @param {{departments?:string[], department?:string}|null|undefined} user
 * @param {object} [deps]
 * @param {{getAll: () => Promise<Array<object>>}} [deps.departmentsRepo]
 * @returns {Promise<Group|null>}
 */
async function resolveGroup(user, deps = {}) {
  if (!user) return null;
  const userDepts = Array.isArray(user.departments) && user.departments.length
    ? user.departments
    : (user.department ? [user.department] : []);
  if (!userDepts.length) return null;

  const repo = deps.departmentsRepo || departmentsRepoDefault;
  const allDepts = await repo.getAll();

  const userDeptSet = new Set(
    userDepts.map((d) => String(d).trim().toLowerCase()).filter(Boolean),
  );

  for (const d of allDepts) {
    if (!userDeptSet.has(String(d.dept_name).trim().toLowerCase())) continue;
    if (Array.isArray(d.warehouses) && d.warehouses.length) {
      return {
        dept_id: d.dept_id,
        dept_name: d.dept_name,
        warehouses: d.warehouses.slice(),
      };
    }
  }
  return null;
}

/**
 * Is this user currently acting as a marketer?
 * A user is a marketer iff:
 *   (a) the master overlay flag is on,
 *   (b) they are NOT an admin (admins always see real data), and
 *   (c) they resolve to a marketing-group department.
 *
 * @param {object|null|undefined} user
 * @param {boolean} isAdmin   pass auth.isAdmin(userId) or
 *                            config.access.adminIds.includes(userId)
 * @param {object} [deps]     optional dep injection (see resolveGroup)
 * @returns {Promise<{isMarketer:boolean, group: Group|null}>}
 */
async function isMarketer(user, isAdmin, deps = {}) {
  if (!isEnabled()) return { isMarketer: false, group: null };
  if (isAdmin) return { isMarketer: false, group: null };
  const group = await resolveGroup(user, deps);
  return { isMarketer: !!group, group };
}

/**
 * Convenience: just the warehouse list (or empty array) for a user's
 * marketing group. Used by the supply_request warehouse-pin injection
 * to swap in the group's warehouses instead of the user's own.
 *
 * @param {object|null|undefined} user
 * @param {boolean} isAdmin
 * @param {object} [deps]
 * @returns {Promise<string[]>}
 */
async function getGroupWarehouses(user, isAdmin, deps = {}) {
  const { isMarketer: ok, group } = await isMarketer(user, isAdmin, deps);
  return ok && group ? group.warehouses.slice() : [];
}

module.exports = {
  isEnabled,
  resolveGroup,
  isMarketer,
  getGroupWarehouses,
};
