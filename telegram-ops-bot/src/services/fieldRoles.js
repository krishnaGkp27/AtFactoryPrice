'use strict';

/**
 * Field-role helpers — marketer / salesman visibility rules.
 *
 * Pure, no I/O. Two field roles sit below `employee` in capability:
 *   - marketer  → may SEE designs available in their assigned warehouse(s).
 *   - salesman  → same as marketer PLUS today's selling price.
 *
 * Roles live in `Users.role`. Warehouse scope lives in `Users.warehouses`
 * (assigned by an admin). Both are read elsewhere; this module only decides
 * "is this a field role?" and "may this role see price?".
 */

const MARKETER = 'marketer';
const SALESMAN = 'salesman';

/** @param {string} role */
function normalize(role) {
  return String(role || '').trim().toLowerCase();
}

/**
 * @param {string} role
 * @returns {'marketer'|'salesman'|null} the field role, or null if not one.
 */
function classify(role) {
  const r = normalize(role);
  return r === MARKETER || r === SALESMAN ? r : null;
}

/** True if the role is a field role (marketer or salesman). */
function isFieldRole(role) {
  return classify(role) !== null;
}

/** Only the salesman sees the selling price; the marketer does not. */
function canSeePrice(role) {
  return normalize(role) === SALESMAN;
}

module.exports = { MARKETER, SALESMAN, normalize, classify, isFieldRole, canSeePrice };
