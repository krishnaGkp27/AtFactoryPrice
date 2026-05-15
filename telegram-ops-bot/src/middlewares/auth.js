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

// Cache the FULL allow-set (env ∪ sheet). Seeded synchronously with env IDs
// at module load so the very first message after boot — before any refresh
// has completed — still admits admins. The first sheet refresh runs lazily.
let _allowed = new Set([...envAdminIds(), ...envEmployeeIds()]);
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
    const active = users
      .filter((u) => (u.status || 'active') === 'active' && u.user_id)
      .map((u) => String(u.user_id));
    _allowed = new Set([
      ...envAdminIds(),
      ...envEmployeeIds(),
      ...active,
    ]);
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
  return envAdminIds().includes(String(telegramId));
}

function isEmployee(telegramId) {
  // True if env says so OR they're in the Users sheet as active.
  const id = String(telegramId);
  if (envEmployeeIds().includes(id)) return true;
  _maybeScheduleRefresh();
  return _allowed.has(id) && !envAdminIds().includes(id);
}

function isAllowed(telegramId) {
  _maybeScheduleRefresh();
  return _allowed.has(String(telegramId));
}

module.exports = {
  isAdmin,
  isEmployee,
  isAllowed,
  refresh,
  invalidate,
  // exported for tests:
  _internals: {
    snapshot: () => Array.from(_allowed),
    lastRefresh: () => _lastRefresh,
    ttlMs: TTL_MS,
  },
};
