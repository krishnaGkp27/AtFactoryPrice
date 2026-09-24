'use strict';

/**
 * src/services/salesAccessService.js — SSA-1 SALES ACCESS (owner, 24-Sep-2026).
 *
 * "Grant access to see the sales from different warehouses to different
 * employees … through checkboxes." One question, asked by two report doors
 * and by the menu: **which places' SALES may this person see?**
 *
 *   - An ADMIN is never scoped: every place, every door, as before.
 *   - Anyone else sees exactly the places an admin ticked for them in
 *     🔐 Sales Access (Users column L `store_sales_places`). With nothing
 *     ticked they see NOTHING: the 🏬 Store Sales and 📒 Customer Supplies
 *     tiles are hidden and a stale tap is refused in one line (owner
 *     ruling 24-Sep: "nothing until you tick").
 *
 * The grant is a master record about a person, so it lives on the Users
 * sheet beside `warehouses` (the supply-door scope, deliberately separate:
 * granting a report never changes where someone may raise a supply from).
 * Reads never throw: a failed Users read scopes to nothing, never to all.
 */

const logger = require('../utils/logger');

// Resolved at call time (not at load) so a harness that swaps the auth or
// Users module after this service loaded is still honoured — the same
// reason usageTracker.roleOf requires auth lazily.
const auth = () => require('../middlewares/auth');
const usersRepository = () => require('../repositories/usersRepository');

/** The report doors this grant opens (activity codes). */
const SCOPED_CODES = ['store_sales', 'sold_bales_lookup'];

/** Grouping key for a place name: trimmed, case-folded. */
function placeKey(name) { return String(name || '').trim().toUpperCase(); }

/**
 * @typedef {object} SalesScope
 * @property {boolean} admin   true = unscoped (every place)
 * @property {Set<string>} keys  placeKey of every granted place ('' never present)
 * @property {string[]} places   the granted names as stored (first spelling)
 */

/** Build a scope from a Users row (or null). */
function scopeOfUser(user, isAdmin) {
  if (isAdmin) return { admin: true, keys: new Set(), places: [] };
  const places = [];
  const keys = new Set();
  for (const p of (user && Array.isArray(user.store_sales_places)) ? user.store_sales_places : []) {
    const k = placeKey(p);
    if (!k || keys.has(k)) continue;
    keys.add(k);
    places.push(String(p).trim());
  }
  return { admin: false, keys, places };
}

/**
 * The sales scope of a Telegram user id.
 * @param {string} userId
 * @returns {Promise<SalesScope>}
 */
async function scopeFor(userId) {
  const id = String(userId);
  if (auth().isAdmin(id)) return scopeOfUser(null, true);
  let user = null;
  try { user = await usersRepository().findByUserId(id); } catch (e) {
    logger.warn(`salesAccess: Users read failed for ${id} — scoping to nothing: ${e.message}`);
  }
  return scopeOfUser(user, false);
}

/** true when a sold Inventory row's warehouse is inside the scope. */
function rowInScope(row, scope) {
  if (!scope || scope.admin) return true;
  return scope.keys.has(placeKey(row && row.warehouse));
}

/** Filter sold rows to the scope (identity for admins). */
function filterRows(rows, scope) {
  if (!scope || scope.admin) return rows;
  return (rows || []).filter((r) => rowInScope(r, scope));
}

/**
 * Menu injection (called by the greeting grid AND the hub renderer so the
 * tiles never differ between the two): a non-admin with a grant gets both
 * doors whether or not a department CSV lists them; one without a grant
 * loses both even if a CSV lists them. Admins: untouched.
 * @param {object|null} user   the Users row
 * @param {boolean} isAdmin
 * @param {Array<object>} allowed  registry entries, mutated in place and returned
 * @param {object} registry activityRegistry (injected for tests)
 */
function adjustMenu(user, isAdmin, allowed, registry) {
  if (isAdmin) return allowed;
  const scope = scopeOfUser(user, false);
  if (scope.keys.size) {
    for (const a of registry.filterByCodes(SCOPED_CODES)) {
      if (!allowed.find((x) => x.code === a.code)) allowed.push(a);
    }
    return allowed;
  }
  for (let i = allowed.length - 1; i >= 0; i -= 1) {
    if (SCOPED_CODES.includes(allowed[i].code)) allowed.splice(i, 1);
  }
  return allowed;
}

/**
 * Every place an admin may tick: the LOC-1 register merged with the
 * places holding stock and the WAREHOUSE_LIST CSV, active only, sorted.
 * @returns {Promise<string[]>}
 */
async function listPlaces() {
  try {
    const locationService = require('./locationService');
    const places = await locationService.allPlaces();
    return places
      .filter((p) => p && p.name && String(p.status || 'active') !== 'closed')
      .map((p) => String(p.name).trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  } catch (e) {
    logger.warn(`salesAccess: place list failed: ${e.message}`);
    return [];
  }
}

/**
 * Persist a grant: write column L, log it, DM the person. Never throws on
 * the DM or the log — the sheet write is the record.
 * @param {object} p
 * @param {object} p.bot
 * @param {string} p.adminId
 * @param {object} p.user      the Users row being granted
 * @param {string[]} p.places  the ticked names (may be empty = revoke)
 * @returns {Promise<{ok:boolean, changed:boolean, told:boolean}>}
 */
async function grant({ bot, adminId, user, places }) {
  const before = scopeOfUser(user, false);
  const after = scopeOfUser({ store_sales_places: places }, false);
  const changed = before.keys.size !== after.keys.size
    || [...after.keys].some((k) => !before.keys.has(k));
  const ok = await usersRepository().updateStoreSalesPlaces(user.user_id, after.places);
  if (!ok) return { ok: false, changed: false, told: false };
  try {
    await require('../repositories/auditLogRepository').append('sales_access_updated', {
      user_id: user.user_id, name: user.name, places: after.places, before: before.places,
    }, String(adminId));
  } catch (e) { logger.warn(`salesAccess: audit write failed: ${e.message}`); }
  // Owner (24-Sep-2026): the person is told what they can NOW see; a
  // removal is silent — no removal message ever reaches an employee.
  let told = false;
  if (changed && after.places.length && bot) {
    const text = `🏬 You can now see the sales of ${after.places.join(', ')}.\nOpen 📊 Reporting → 🏬 Store Sales or 📒 Customer Supplies.`;
    try { await bot.sendMessage(user.user_id, text); told = true; } catch (e) {
      logger.warn(`salesAccess: could not DM ${user.user_id}: ${e.message}`);
    }
  }
  return { ok: true, changed, told };
}

module.exports = {
  SCOPED_CODES,
  placeKey,
  scopeOfUser,
  scopeFor,
  rowInScope,
  filterRows,
  adjustMenu,
  listPlaces,
  grant,
};
