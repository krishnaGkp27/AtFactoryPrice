'use strict';

/**
 * PAY-1 — money going OUT: registered payees, dual-admin approval, and
 * ONE hand that executes.
 *
 * The bot never moves money. A human makes the transfer at the bank and
 * tells the bot it happened; everything here exists to make sure that by
 * the time they do, two admins have agreed, the destination account was
 * registered and approved long before the payment was asked for, and the
 * whole chain is on the record.
 *
 * Owner rulings this encodes (14-Aug-2026):
 *   - every financial action is dual-admin, account registration first;
 *   - ONE finance Telegram ID makes payments at any moment in time —
 *     a business rule, not a convenience;
 *   - the ₦50,000 threshold BADGES a request, it does not gate it;
 *   - employees raise only for themselves; contractors are raised for by
 *     an admin against the contractor's registered account.
 */

const usersRepository = require('../repositories/usersRepository');
const settingsRepository = require('../repositories/settingsRepository');
const paymentAccountsRepo = require('../repositories/paymentAccountsRepository');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * The department that owns payment execution. The owner maintains
 * membership BY HAND in the Users sheet — his explicit instruction was
 * "no add by yourself… I will make it in sheet change" — so nothing in
 * this codebase ever writes a Users row for this.
 */
const FINANCE_DEPARTMENT = 'Finance';

/** Nigerian naira, grouped: 45000 → "₦45,000". */
function fmtNaira(amount) {
  const n = Math.round(Number(amount) || 0);
  return `₦${n.toLocaleString('en-NG')}`;
}

/**
 * Who may tap Mark Done right now.
 *
 * Resolved at READ TIME from the Users sheet: the single ACTIVE member of
 * the Finance department. Deliberately not a role check — the owner said
 * the office phone "can be marked as marketer or something else", so the
 * department is the fact that matters and the role label is free.
 *
 * @returns {Promise<{ok:boolean, telegramId:string, name:string, reason:string, members:number}>}
 *   ok:false never means "block the payment" — see the callers. It means
 *   the sheet does not yet name exactly one finance person, and every
 *   surface degrades to admins-with-a-warning rather than to a queue
 *   nobody can act on.
 */
async function financeHead() {
  let members = [];
  try {
    const all = await usersRepository.getAll();
    members = (all || []).filter((u) => (u.status || 'active') === 'active'
      && usersRepository.inDepartment(u, FINANCE_DEPARTMENT));
  } catch (e) {
    logger.warn(`paymentService.financeHead: Users read failed — ${e.message}`);
    return { ok: false, telegramId: '', name: '', reason: 'users_unreadable', members: 0 };
  }
  if (members.length === 1) {
    const m = members[0];
    return {
      ok: true,
      telegramId: String(m.user_id || ''),
      name: m.name || String(m.user_id || ''),
      reason: '',
      members: 1,
    };
  }
  return {
    ok: false,
    telegramId: '',
    name: '',
    reason: members.length ? 'multiple_finance_members' : 'no_finance_member',
    members: members.length,
  };
}

/** The human sentence a card shows when the register is misconfigured. */
function financeWarning(head) {
  if (head.ok) return '';
  if (head.reason === 'no_finance_member') {
    return '⚠️ No one is in the Finance department yet — this is with all admins until the Users sheet names exactly one finance person.';
  }
  if (head.reason === 'multiple_finance_members') {
    return `⚠️ ${head.members} people are in the Finance department. One finance ID makes payments — fix the Users sheet; meanwhile this is with all admins.`;
  }
  return '⚠️ The Users sheet could not be read, so the finance person is unknown — this is with all admins.';
}

/**
 * May this Telegram id execute a payment (Mark Done / Decline)?
 *
 * The one finance id when the sheet names one. When it does not, the
 * power falls back to ADMINS rather than to nobody: an unfinished sheet
 * must not strand approved money, and an admin acting is on the record
 * exactly like the finance head would be.
 */
async function canExecute(telegramId) {
  const id = String(telegramId || '');
  if (!id) return { ok: false, reason: 'no_user' };
  const head = await financeHead();
  if (head.ok) {
    if (id === head.telegramId) return { ok: true, head };
    return { ok: false, reason: 'not_finance', head };
  }
  if (config.access.adminIds.includes(id)) return { ok: true, head, viaAdminFallback: true };
  return { ok: false, reason: 'not_finance', head };
}

/** Who a payment card should go to: the finance head, else every admin. */
async function paymentRecipients() {
  const head = await financeHead();
  if (head.ok) return { ids: [head.telegramId], head };
  return { ids: [...config.access.adminIds], head };
}

/** The badge line, ₦50,000 by default, Settings-overridable, no deploy. */
async function threshold() {
  try {
    const s = await settingsRepository.getAll();
    const v = Number(s.PAYMENT_THRESHOLD_NGN);
    if (Number.isFinite(v) && v > 0) return v;
  } catch (_) { /* fall through to the in-code default */ }
  return Number(settingsRepository.DEFAULTS.PAYMENT_THRESHOLD_NGN) || 50000;
}

async function isAboveThreshold(amount) {
  return (Number(amount) || 0) >= await threshold();
}

/**
 * The accounts a person may raise a payment against.
 *
 * An employee sees ONLY their own registered accounts — the owner's
 * "Abdul can raise for himself, Yerima for himself". An admin also sees
 * CONTRACTOR accounts, because a contractor may have no Telegram at all
 * and somebody has to ask on their behalf. No one ever sees another
 * EMPLOYEE's account: that would be raising money into a colleague's
 * bank account, which is exactly what self-only forbids.
 */
async function payableAccountsFor(telegramId, isAdmin) {
  const own = await paymentAccountsRepo.activeForTelegramId(telegramId);
  if (!isAdmin) return own;
  const contractors = await paymentAccountsRepo.activeContractors();
  const seen = new Set(own.map((a) => a.account_id));
  return own.concat(contractors.filter((c) => !seen.has(c.account_id)));
}

/**
 * Validate a Nigerian bank account number as far as a bot honestly can:
 * NUBAN is 10 digits. Anything else is a typo, and a typo here sends
 * real money to a stranger.
 */
function validateAccountNumber(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return { ok: false, reason: 'Enter the account number (digits only).' };
  if (digits.length !== 10) {
    return { ok: false, reason: `Nigerian account numbers are 10 digits — that was ${digits.length}.` };
  }
  return { ok: true, value: digits };
}

/** Amounts are whole naira, positive, and sane enough to be a payment. */
function validateAmount(raw) {
  const cleaned = String(raw ?? '').replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { ok: false, reason: 'Enter the amount in figures, e.g. 45000.' };
  const n = Math.round(Number(cleaned));
  if (!n) return { ok: false, reason: 'The amount must be more than zero.' };
  if (n > 100000000) return { ok: false, reason: 'That is over ₦100,000,000 — check the figure.' };
  return { ok: true, value: n };
}

module.exports = {
  FINANCE_DEPARTMENT,
  fmtNaira,
  financeHead,
  financeWarning,
  canExecute,
  paymentRecipients,
  threshold,
  isAboveThreshold,
  payableAccountsFor,
  validateAccountNumber,
  validateAmount,
};
