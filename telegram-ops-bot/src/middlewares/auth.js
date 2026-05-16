/**
 * Telegram user authorisation gate.
 *
 * USR-C1 (in-bot self-managed roster):
 *   - The allow-list is the union of env-driven IDs (ADMIN_IDS, EMPLOYEE_IDS)
 *     AND active users from the `Users` sheet (`status=active`).
 *   - The sheet read is cached for 10 seconds. A stale-while-revalidate
 *     pattern keeps `isAllowed()` synchronous (it runs on every incoming
 *     message) while a background refresh updates the cache.
 *   - `invalidate()` is called by the user-onboarding pipeline immediately
 *     after a write to Users so a newly approved person can use the bot
 *     without waiting for the TTL.
 *   - ADMIN_IDS env is still mandatory for admin entry: in-bot promotion
 *     to admin requires SUPER_ADMIN approval (USR-C3b). Employee env
 *     becomes optional bootstrap-only once the sheet has rows.
 */

'use strict';

const config = require('../config');

const TTL_MS = 10_000;

function envAdminIds() { return config.access.adminIds.map(String); }
function envEmployeeIds() { return config.access.employeeIds.map(String); }
function envSuperAdminIds() { return (config.access.superAdminIds || []).map(String); }

// Cache the FULL allow-set (env ∪ sheet). Seeded synchronously with env IDs
// at module load so the very first message after boot — before any refresh
// has completed — still admits admins. The first sheet refresh runs lazily.
let _allowed = new Set([...envAdminIds(), ...envEmployeeIds()]);
// USR-C3b: sheet-driven admin set (Users.role === 'admin' AND status='active').
// `isAdmin` returns true if id is in env ADMIN_IDS OR in this set. Refreshed
// alongside `_allowed`.
let _sheetAdmins = new Set();
let _lastRefresh = 0;
let _refreshing = false;

/**
 * Re-read Users sheet and rebuild the allow-set. Idempotent; safe to call
 * concurrently — overlapping calls collapse into the first.
 * Errors do NOT clear the existing cache (we keep last-known-good).
 */
async function refresh() {
  if (_refreshing) return;
  _refreshing = true;
  try {
    const usersRepo = require('../repositories/usersRepository');
    const users = await usersRepo.getAll();
    const activeUsers = users.filter((u) => (u.status || 'active') === 'active' && u.user_id);
    const active = activeUsers.map((u) => String(u.user_id));
    _allowed = new Set([
      ...envAdminIds(),
      ...envEmployeeIds(),
      ...active,
    ]);
    _sheetAdmins = new Set(
      activeUsers.filter((u) => String(u.role || '').toLowerCase() === 'admin')
        .map((u) => String(u.user_id)),
    );
    _lastRefresh = Date.now();
  } catch (e) {
    try { require('../utils/logger').warn(`auth.refresh failed: ${e.message}`); } catch (_) {}
  } finally {
    _refreshing = false;
  }
}

function _maybeScheduleRefresh() {
  if (_refreshing) return;
  if (Date.now() - _lastRefresh > TTL_MS) {
    // Fire-and-forget; current call uses last-known-good set.
    refresh().catch(() => {});
  }
}

/** Force a fresh read on the NEXT isAllowed() call. Used post-approval. */
function invalidate() {
  _lastRefresh = 0;
  // Return the promise so callers (e.g. approval handlers) can await if
  // they want the next sync check to definitely see the change.
  return refresh();
}

function isAdmin(telegramId) {
  const id = String(telegramId);
  if (envAdminIds().includes(id)) return true;
  // USR-C3b: sheet-promoted admins. _sheetAdmins is rebuilt by refresh();
  // the lazy schedule below ensures we converge within one TTL window
  // after a promote_admin approval (which also calls invalidate()).
  _maybeScheduleRefresh();
  return _sheetAdmins.has(id);
}

/**
 * Super-admin is the role allowed to APPROVE promote_admin requests.
 * Lives in env only — there is no path to grant super-admin from inside
 * the bot. This is the one true gate against in-bot privilege escalation.
 */
function isSuperAdmin(telegramId) {
  return envSuperAdminIds().includes(String(telegramId));
}

function isEmployee(telegramId) {
  // True if env says so OR they're in the Users sheet as active and
  // not currently a recognised admin.
  const id = String(telegramId);
  if (envEmployeeIds().includes(id)) return true;
  _maybeScheduleRefresh();
  return _allowed.has(id) && !envAdminIds().includes(id) && !_sheetAdmins.has(id);
}

function isAllowed(telegramId) {
  _maybeScheduleRefresh();
  return _allowed.has(String(telegramId));
}

module.exports = {
  isAdmin,
  isSuperAdmin,
  isEmployee,
  isAllowed,
  refresh,
  invalidate,
  // exported for tests:
  _internals: {
    snapshot: () => Array.from(_allowed),
    snapshotAdmins: () => Array.from(_sheetAdmins),
    lastRefresh: () => _lastRefresh,
    ttlMs: TTL_MS,
  },
};
