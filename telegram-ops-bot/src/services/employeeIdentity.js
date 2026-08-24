'use strict';

/**
 * PAY-ID (owner, hard rule, 23-Aug-2026) — money may only be registered
 * against a Telegram ID that was onboarded as an employee FIRST.
 *
 * > "Any approval which comes for like this has to have linked with
 * >  telegram ID associated as employee before. Make it as hard business
 * >  rules."
 *
 * The gap this closes: the Register-payment-account flow silently linked
 * the SUBMITTER's Telegram ID when they tapped "👤 Mine", but never checked
 * it against the Users sheet, and the approval card showed only a typed
 * name ("Muhammad (employee)"). Two admins were therefore approving a
 * STRING, not a person — anyone who could reach the tile could put an
 * account number in front of them without ever being onboarded.
 *
 * Enforced at BOTH ends on purpose:
 *   - at the door, so nothing unverified is ever queued;
 *   - at the executor, so a request raised while someone was still an
 *     employee cannot be approved AFTER they were deactivated or removed.
 *
 * The Users sheet is the register (HR → Add User writes it). Env-only
 * admin IDs do NOT satisfy it: a payee is a person on the payroll, and
 * "an admin is on the env list" is not that fact. Onboarding an admin
 * takes a minute and the rule stays one sentence with no exceptions.
 */

const usersRepository = require('../repositories/usersRepository');
const logger = require('../utils/logger');

/**
 * Resolve a Telegram ID to its ACTIVE Users-sheet employee row.
 *
 * @param {string|number} telegramId
 * @returns {Promise<{ok:boolean, user?:object, reason?:'missing'|'inactive'|'unverifiable', message?:string}>}
 *   ok:false always carries a `message` written for the person reading it.
 */
async function verifyEmployee(telegramId) {
  const id = String(telegramId || '').trim();
  if (!id) {
    return { ok: false, reason: 'missing', message: 'No Telegram ID is linked to this request.' };
  }
  let user;
  try {
    user = await usersRepository.findByUserId(id);
  } catch (e) {
    // FAIL CLOSED. This gate stands in front of money: an unreadable
    // Users sheet means we cannot prove employment, and "cannot prove"
    // must never read as "approved".
    logger.warn(`employeeIdentity: cannot verify ${id} (${e.message})`);
    return {
      ok: false,
      reason: 'unverifiable',
      message: 'Could not check the staff register just now. Try again in a moment — nothing was submitted.',
    };
  }
  if (!user) {
    return {
      ok: false,
      reason: 'missing',
      message: 'You are not registered as an employee yet. An admin must add you first '
        + '(Human Resources → Add User), then this can be registered against your name.',
    };
  }
  if (String(user.status || 'active').toLowerCase() !== 'active') {
    return {
      ok: false,
      reason: 'inactive',
      message: `${user.name || id} is no longer an active employee, so money cannot be registered against them.`,
    };
  }
  return { ok: true, user };
}

/**
 * The verified-identity line every money card carries, so the approving
 * admins see WHO — not just a typed name.
 * @param {object} user a row from verifyEmployee
 * @returns {string}
 */
function cardLine(user) {
  if (!user) return '';
  const bits = [user.name || user.user_id];
  if (user.user_id) bits.push(String(user.user_id));
  return `Linked Telegram: ${bits.join(' · ')} ✓ registered employee`;
}

module.exports = { verifyEmployee, cardLine };
