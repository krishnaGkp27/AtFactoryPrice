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
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const paymentReasonsRepository = require('../repositories/paymentReasonsRepository');
const config = require('../config');
const logger = require('../utils/logger');
const money = require('../utils/money');

/**
 * The department that owns payment execution. The owner maintains
 * membership BY HAND in the Users sheet — his explicit instruction was
 * "no add by yourself… I will make it in sheet change" — so nothing in
 * this codebase ever writes a Users row for this.
 */
const FINANCE_DEPARTMENT = 'Finance';

/** Sanity ceiling on a single payment request (a typo guard, not a policy). */
const MAX_PAYMENT_NGN = 100_000_000;

/** PAY-2 §2 A — the typed reason: 3–120 characters, no skip. */
const REASON_MIN = 3;
const REASON_MAX = 120;

/**
 * Nigerian naira, grouped: 45000 → "₦45,000". PAY-1 rounds to the naira.
 * CUR-1 (side A): the symbol comes from `money.expense`, never the env.
 */
function fmtNaira(amount) {
  const n = Math.round(Number(amount) || 0);
  return money.expense(n);
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
 * PAY-2 §2 B — the ids Railway names as the finance seat (env FINANCE_IDS,
 * the list `config.access.financeIds` is parsed from).
 *
 * Read from the env itself, with config's own comma rule, because
 * `config.access.financeIds` DEFAULTS to the admin list when the env var
 * is blank (the FIN-V1 read-only gates depend on that) — and a blank seat
 * must fall through to the Users sheet, exactly as before PAY-2, not to
 * every admin without a warning.
 *
 * @returns {string[]} de-duplicated, in env order; [] when FINANCE_IDS is unset
 */
function financeSeatIds() {
  const raw = process.env.FINANCE_IDS;
  if (!raw || typeof raw !== 'string') return [];
  return [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))];
}

/**
 * Who a payment card should go to — PAY-2 §2 B, the owner's Q1 ruling
 * (09-Sep-2026), resolved in this order:
 *
 *   1. every id in Railway `FINANCE_IDS`            → source 'finance_ids'
 *   2. else the single Users row in department Finance → source 'users_finance'
 *   3. else every env admin, with the warning line   → source 'admins'
 *
 * `head` keeps the financeHead() shape so cards can print the warning
 * (only ever in case 3 — the seat and the sheet row are both "ok").
 *
 * @returns {Promise<{ids:string[], head:object, source:string}>}
 */
async function paymentRecipients() {
  const seat = financeSeatIds();
  if (seat.length) {
    return {
      ids: seat,
      head: { ok: true, telegramId: seat[0], name: '', reason: '', members: seat.length },
      source: 'finance_ids',
    };
  }
  const head = await financeHead();
  if (head.ok) return { ids: [head.telegramId], head, source: 'users_finance' };
  return { ids: [...config.access.adminIds], head, source: 'admins' };
}

/**
 * May this Telegram id execute a payment (Mark Done / Decline)?
 *
 * PAY-2 §2 B — honoured from any id the finance card was sent to, under
 * the SAME resolution as paymentRecipients(): the Railway finance seat,
 * else the one Users finance row, else the admins. The fallback to admins
 * rather than to nobody stands: an unfinished sheet must not strand
 * approved money, and an admin acting is on the record exactly like the
 * finance head would be.
 */
async function canExecute(telegramId) {
  const id = String(telegramId || '');
  if (!id) return { ok: false, reason: 'no_user' };
  const { ids, head, source } = await paymentRecipients();
  if (ids.includes(id)) {
    const out = { ok: true, head, source };
    if (source === 'admins') out.viaAdminFallback = true;
    return out;
  }
  return { ok: false, reason: 'not_finance', head, source };
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

/**
 * PAY-2 §2 A — the reason is typed, 3–120 characters, trimmed. No skip:
 * the owner's rule is that every payment must be tagged.
 */
function validateReason(raw) {
  const value = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (value.length < REASON_MIN || value.length > REASON_MAX) {
    return { ok: false, reason: `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.` };
  }
  return { ok: true, value };
}

/**
 * PAY-2 §1 — the reason for ONE payment: the ApprovalQueue payload (the
 * existing raw record) first, then the Postgres `payment_reasons` row.
 * Never throws; '' when neither knows.
 *
 * @param {object} pay a PaymentRequests row (needs approval_request_id / payment_id)
 * @returns {Promise<string>}
 */
async function reasonFor(pay) {
  if (!pay) return '';
  if (pay.reason) return String(pay.reason);
  if (pay.approval_request_id) {
    try {
      const row = await approvalQueueRepository.getByRequestId(pay.approval_request_id);
      const r = row && row.actionJSON && row.actionJSON.reason;
      if (r) return String(r);
    } catch (e) {
      logger.warn(`paymentService.reasonFor: queue read failed — ${e.message}`);
    }
  }
  try {
    const pg = await paymentReasonsRepository.forPayment(pay.payment_id);
    if (pg && pg.reason_text) return String(pg.reason_text);
  } catch (_) { /* fail-open: the payload is the record of truth */ }
  return '';
}

/**
 * The reasons for MANY rows (📋 My requests, the finance queue): one
 * ApprovalQueue read indexed by request id, Postgres for the leftovers.
 *
 * @param {object[]} pays PaymentRequests rows
 * @returns {Promise<Map<string,string>>} payment_id → reason ('' when unknown)
 */
async function reasonsFor(pays) {
  const out = new Map();
  const list = (pays || []).filter(Boolean);
  if (!list.length) return out;
  let byRequest = new Map();
  try {
    const rows = await approvalQueueRepository.getAllWithRowIndex();
    byRequest = new Map((rows || []).map((r) => [String(r.requestId), r.actionJSON || {}]));
  } catch (e) {
    logger.warn(`paymentService.reasonsFor: queue read failed — ${e.message}`);
  }
  for (const p of list) {
    const aj = byRequest.get(String(p.approval_request_id || ''));
    let reason = p.reason ? String(p.reason) : (aj && aj.reason ? String(aj.reason) : '');
    if (!reason) {
      try {
        const pg = await paymentReasonsRepository.forPayment(p.payment_id);
        if (pg && pg.reason_text) reason = String(pg.reason_text);
      } catch (_) { /* fail-open */ }
    }
    out.set(String(p.payment_id), reason);
  }
  return out;
}

/** Amounts are whole naira, positive, and sane enough to be a payment. */
function validateAmount(raw) {
  const cleaned = String(raw ?? '').replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { ok: false, reason: 'Enter the amount in figures, e.g. 45000.' };
  const n = Math.round(Number(cleaned));
  if (!n) return { ok: false, reason: 'The amount must be more than zero.' };
  if (n > MAX_PAYMENT_NGN) return { ok: false, reason: `That is over ${money.expense(MAX_PAYMENT_NGN)} — check the figure.` };
  return { ok: true, value: n };
}

module.exports = {
  FINANCE_DEPARTMENT,
  REASON_MIN,
  REASON_MAX,
  fmtNaira,
  financeHead,
  financeSeatIds,
  financeWarning,
  canExecute,
  paymentRecipients,
  threshold,
  isAboveThreshold,
  payableAccountsFor,
  validateAccountNumber,
  validateAmount,
  validateReason,
  reasonFor,
  reasonsFor,
};
