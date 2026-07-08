'use strict';

/**
 * CAP-1 — central capability registry: role → what a user may see or do.
 *
 * WHY: visibility rules were scattered across ~85 inline checks
 * (`config.access.adminIds.includes(uid)`, `fieldRoles.canSeePrice`,
 * `pricingService.canSeeSalePrice`, per-flow "Admin only." gates). Every new
 * partial view (owner roadmap: marketer sees a slice, salesman a bigger
 * slice, admin everything) meant hunting through the god controller. This
 * module is the single table to edit instead.
 *
 * MODEL
 *   - A CAPABILITY is a named permission (`see_sale_price`, …).
 *   - A ROLE is the `Users.role` sheet value (admin / employee / salesman /
 *     marketer). Unknown or empty roles are treated as `employee` — that is
 *     today's de-facto behaviour for sheet-onboarded users.
 *   - ADMIN is special: membership comes from auth.isAdmin() (env ADMIN_IDS
 *     ∪ sheet-promoted active admins) and grants EVERY capability.
 *
 * ADOPTION PATH (do not big-bang):
 *   - NEW code asks `can(user, CAP.xxx)` instead of inlining admin checks.
 *   - Existing gates migrate opportunistically when their file is touched.
 *   - KNOWN INCONSISTENCY (pre-existing, kept as-is): many inline controller
 *     gates check env ADMIN_IDS only, while auth.isAdmin() also admits
 *     sheet-promoted admins. When migrating such a gate to can(), the
 *     sheet-promoted admins gain access — usually correct, but flag it in
 *     the commit so it is a conscious decision per gate.
 *
 * Sync + no I/O beyond auth's cached set: safe in rendering loops.
 */

const auth = require('../middlewares/auth');

/**
 * Local role normalizer (same semantics as fieldRoles.normalize; duplicated
 * here so fieldRoles/pricingService can delegate to this module without a
 * circular require).
 * @param {string} role Raw Users.role value.
 * @returns {string} Trimmed lowercase role.
 */
function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

/** Capability names — use these constants, never raw strings. */
const CAP = {
  /** Selling price on warehouse surfaces (Check Stock, bale detail, reports). */
  SEE_SALE_PRICE: 'see_sale_price',
  /** Landed/base cost (lc_ngn_per_yard) — most restricted. */
  SEE_BASE_PRICE: 'see_base_price',
  /** Stock VALUE aggregates (₦ totals under warehouse headers, reports). */
  SEE_STOCK_VALUE: 'see_stock_value',
  /** Price badge inside the FIELD catalog (My Products classic view). */
  SEE_CATALOG_PRICE: 'see_catalog_price',
  /** Full warehouse-scoped catalog (vs allocation-scoped). */
  VIEW_FULL_CATALOG: 'view_full_catalog',
  /** Allocation-scoped category catalog (MKT-2 My Products). */
  VIEW_ALLOCATED_CATALOG: 'view_allocated_catalog',
  /** Run the Supply Request cart flow. */
  USE_SUPPLY_REQUEST: 'use_supply_request',
  /** Admin flow: allocate designs/quantities to marketers (MKT-2). */
  MANAGE_ALLOCATIONS: 'manage_allocations',
  /** Admin flow: submit design-category changes (DCAT-1, dual-admin gated). */
  SET_DESIGN_CATEGORY: 'set_design_category',
  /** Act on ApprovalQueue cards. */
  APPROVE_REQUESTS: 'approve_requests',
};

const ALL_CAPS = new Set(Object.values(CAP));

/**
 * Role grant table — the one place to edit when a role's view changes.
 * Admin is NOT listed: auth.isAdmin() short-circuits to ALL_CAPS in can().
 * @type {Record<string, Set<string>>}
 */
const ROLE_GRANTS = {
  employee: new Set([
    CAP.USE_SUPPLY_REQUEST,
    CAP.VIEW_FULL_CATALOG,
  ]),
  salesman: new Set([
    CAP.VIEW_FULL_CATALOG,
    CAP.SEE_CATALOG_PRICE,
    CAP.USE_SUPPLY_REQUEST,
  ]),
  marketer: new Set([
    CAP.VIEW_ALLOCATED_CATALOG,
    CAP.USE_SUPPLY_REQUEST,
  ]),
};

/**
 * Effective role of a user record: 'admin' (auth-derived), else the
 * normalized Users.role, else 'employee'.
 * @param {{userId?: string|number, role?: string}|string|number} user
 *   User record ({userId, role}) or a bare Telegram id.
 * @returns {string} Effective role name.
 */
function roleOf(user) {
  const u = (user && typeof user === 'object') ? user : { userId: user };
  if (u.userId != null && auth.isAdmin(String(u.userId))) return 'admin';
  const r = normalizeRole(u.role);
  return ROLE_GRANTS[r] ? r : 'employee';
}

/**
 * May this user exercise this capability?
 * @param {{userId?: string|number, role?: string}|string|number} user
 *   User record ({userId, role}) or a bare Telegram id (admin checks only
 *   need the id; role-based grants need `role` too).
 * @param {string} capability One of the CAP constants.
 * @returns {boolean} True when granted.
 */
function can(user, capability) {
  if (!ALL_CAPS.has(capability)) {
    throw new Error(`capabilities: unknown capability "${capability}"`);
  }
  const role = roleOf(user);
  if (role === 'admin') return true;
  return ROLE_GRANTS[role].has(capability);
}

/**
 * Grant check against the ROLE table only — no admin wildcard. Use when a
 * surface keys strictly off Users.role semantics (e.g. the field catalog
 * price badge, where 'salesman' is the grant and admin identity is
 * irrelevant to the rendering path).
 * @param {string} role Users.role value.
 * @param {string} capability One of the CAP constants.
 * @returns {boolean} True when the role's grant set contains it.
 */
function roleHas(role, capability) {
  if (!ALL_CAPS.has(capability)) {
    throw new Error(`capabilities: unknown capability "${capability}"`);
  }
  const r = normalizeRole(role);
  const grants = ROLE_GRANTS[ROLE_GRANTS[r] ? r : 'employee'];
  return grants.has(capability);
}

module.exports = { CAP, can, roleHas, roleOf, ROLE_GRANTS };
