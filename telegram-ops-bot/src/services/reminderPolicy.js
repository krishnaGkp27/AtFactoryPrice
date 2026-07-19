/**
 * APR-2 — the single source of truth for WHO receives reminder nudges.
 *
 * Owner mandate (14-Jul, delivered 20-Jul): reminders are off by default,
 * switchable per department from inside the bot behind approval, one ⏰
 * screen rules every nudge the bot sends.
 *
 * Settings keys (sheet-editable, no deploy; all default 0 = silent):
 *   REMINDER_HOURS_ADMIN      admin-directed nudges (approval sweep cadence
 *                             in hours; also gates sample/follow-up/cold
 *                             alert jobs: >0 = on). Falls back to the
 *                             legacy APPROVAL_REMINDER_HOURS when unset.
 *   REMINDER_HOURS.<Dept>     department members' nudges (e.g. the order
 *                             reminder DM to a salesperson): >0 = on.
 *   REMINDER_MAX_AGE_DAYS     backlog guard for the approval sweep —
 *                             items older than this stay silent (the
 *                             historic 40+ row backlog never floods again).
 */

'use strict';

const settingsRepository = require('../repositories/settingsRepository');
const usersRepository = require('../repositories/usersRepository');
const logger = require('../utils/logger');

const DEPT_KEY_PREFIX = 'REMINDER_HOURS.';
const ADMIN_KEY = 'REMINDER_HOURS_ADMIN';
const MAX_AGE_KEY = 'REMINDER_MAX_AGE_DAYS';
const DEFAULT_MAX_AGE_DAYS = 14;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Cadence (hours) for admin-directed nudges. 0 = off. */
async function hoursForAdmin() {
  const all = await settingsRepository.getAll().catch(() => ({}));
  if (all[ADMIN_KEY] !== undefined && all[ADMIN_KEY] !== '') return num(all[ADMIN_KEY]);
  // Back-compat: the key the owner set to 0 when pausing APR-1.
  return num(all.APPROVAL_REMINDER_HOURS);
}

/** Cadence (hours) for a department's member nudges. 0 = off. */
async function hoursForDept(deptName) {
  if (!deptName) return 0;
  const all = await settingsRepository.getAll().catch(() => ({}));
  const key = Object.keys(all).find(
    (k) => k.toLowerCase() === `${DEPT_KEY_PREFIX}${deptName}`.toLowerCase());
  return key ? num(all[key]) : 0;
}

/** Backlog guard: pending items older than this many days stay silent. */
async function maxAgeDays() {
  const all = await settingsRepository.getAll().catch(() => ({}));
  return num(all[MAX_AGE_KEY], DEFAULT_MAX_AGE_DAYS) || DEFAULT_MAX_AGE_DAYS;
}

/**
 * Should this user receive member-directed reminder DMs (e.g. the order
 * reminder to its salesperson)? True when ANY of their departments has
 * reminders on. Unknown users → false (silent by default).
 */
async function shouldRemindUser(userId) {
  try {
    const u = await usersRepository.findByUserId(String(userId));
    if (!u) return false;
    const depts = Array.isArray(u.departments) ? u.departments : [];
    for (const d of depts) {
      if ((await hoursForDept(d)) > 0) return true;
    }
    return false;
  } catch (e) {
    logger.warn(`reminderPolicy.shouldRemindUser(${userId}) failed: ${e.message}`);
    return false;
  }
}

/** Settings key for a scope — used by the executor and the config flow. */
function keyFor(scope, deptName) {
  return scope === 'admin' ? ADMIN_KEY : `${DEPT_KEY_PREFIX}${deptName}`;
}

module.exports = {
  hoursForAdmin, hoursForDept, maxAgeDays, shouldRemindUser, keyFor,
  ADMIN_KEY, DEPT_KEY_PREFIX, MAX_AGE_KEY, DEFAULT_MAX_AGE_DAYS,
};
