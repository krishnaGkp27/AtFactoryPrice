/**
 * Branch model helpers (USR onboarding cleanup).
 *
 * A **branch** is a city/region (e.g. Lagos, Kano). A **warehouse** is a
 * specific location inside a branch (e.g. Lagos → IDUMOTA, OKE-ARIN).
 * Activities cluster per branch; warehouses scope physical stock.
 *
 * Both lists live in the Settings sheet (key/value), admin-editable:
 *   BRANCH_LIST                 = "Lagos,Kano"
 *   BRANCH_WAREHOUSES.<branch>  = "IDUMOTA,OKE-ARIN"   (one key per branch)
 *
 * Mirrors the existing `AUDIT_MODE.<warehouse>` settings convention.
 */

'use strict';

const settingsRepo = require('../repositories/settingsRepository');

const BRANCH_LIST_KEY = 'BRANCH_LIST';
const BRANCH_WH_PREFIX = 'BRANCH_WAREHOUSES.';

/** Split a comma-separated settings value into a trimmed, non-empty list. */
function csv(value) {
  return String(value == null ? '' : value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Configured branch names (city/region level). Empty array when unset —
 * callers should treat "no branches configured" gracefully.
 * @returns {Promise<string[]>}
 */
async function getBranches() {
  let s = {};
  try { s = await settingsRepo.getAll(); } catch (_) { s = {}; }
  return csv(s[BRANCH_LIST_KEY]);
}

/**
 * Warehouses that belong to a given branch (case-insensitive on the branch
 * name). Empty array when the branch has no mapping — callers should then
 * fall back to the full warehouse list.
 * @param {string} branch
 * @returns {Promise<string[]>}
 */
async function getBranchWarehouses(branch) {
  if (!branch) return [];
  let s = {};
  try { s = await settingsRepo.getAll(); } catch (_) { s = {}; }
  const wanted = `${BRANCH_WH_PREFIX}${branch}`.toLowerCase();
  const key = Object.keys(s).find((k) => k.toLowerCase() === wanted);
  return key ? csv(s[key]) : [];
}

module.exports = {
  getBranches,
  getBranchWarehouses,
  BRANCH_LIST_KEY,
  BRANCH_WH_PREFIX,
  // exported for tests:
  _internals: { csv },
};
