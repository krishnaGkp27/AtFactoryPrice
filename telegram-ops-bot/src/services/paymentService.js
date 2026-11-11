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
const bankEntry = require('../utils/bankEntry');

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
    members = (all || []).filter((u) => String(u.status || 'active').trim().toLowerCase() === 'active'
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
async function canExecute(telegramId, pay = null) {
  const id = String(telegramId || '');
  if (!id) return { ok: false, reason: 'no_user' };
  const { ids, head, source } = await paymentRecipients();
  if (!ids.includes(id)) return { ok: false, reason: 'not_finance', head, source };
  // PAY-4 (owner ruling, 14-Sep-2026; BUSINESS_RULES §13 "four eyes on the
  // money") — being the finance seat is not enough. An id that gave either
  // approval has forfeited the right to release THIS payment. Checked here,
  // the one gate every money-moving tap already passes through, so a new
  // door cannot be built that skips it.
  if (pay) {
    const approvers = await approverIdsFor(pay);
    if (approvers.includes(id)) {
      return { ok: false, reason: 'approved_it', head, source, approvers };
    }
  }
  const out = { ok: true, head, source };
  if (source === 'admins') out.viaAdminFallback = true;
  return out;
}

/**
 * PAY-4 — the Telegram ids that APPROVED this payment.
 *
 * The PaymentRequests `approved_by` cell holds the pair LABEL ("Musa ‖
 * Abdul"), not ids, so it cannot answer this. The ids live on the
 * ApprovalQueue row (`actionJSON.approvals`, where DUAL-1 parks the first
 * signature and the executor adds the second); the Postgres event trail is
 * the fallback for a row that has since been archived.
 *
 * Fails CLOSED on nothing found — an empty list means "nobody is known to
 * have approved it", which correctly blocks nobody; but a THROW must never
 * silently open the gate, so every read is caught and the known ids so far
 * are returned.
 *
 * @param {object} pay a PaymentRequests row
 * @returns {Promise<string[]>} approver Telegram ids, as strings
 */
async function approverIdsFor(pay) {
  const out = [];
  const push = (v) => {
    const id = String(v == null ? '' : v).trim();
    if (id && !out.includes(id)) out.push(id);
  };
  const requestId = pay && pay.approval_request_id;
  if (requestId) {
    try {
      const row = await require('../repositories/approvalQueueRepository').getByRequestId(requestId);
      if (row && row.actionJSON) {
        const aj = row.actionJSON;
        require('./approverStamp').approverIds(aj).forEach(push);
        // PAY-4b (11-Nov-2026) — DUAL-1 parks only the FIRST signature in
        // `approvals`, so the admin who gave the second approval was unknown
        // here and could still release the money. The executor now parks the
        // whole pair (`approverIds`), and the signature trail counts too.
        if (Array.isArray(aj.approverIds)) aj.approverIds.forEach(push);
        if (Array.isArray(aj.signoffs)) aj.signoffs.forEach((s) => push(s && s.id));
        // PAY-6 — the admin who gave the last approval also named the paying
        // account; the executor parks who (`payFrom.by`). One more durable
        // record of the completing approver.
        if (aj.payFrom && aj.payFrom.by) push(aj.payFrom.by);
      }
    } catch (e) {
      logger.warn(`PAY-4 approverIdsFor: queue read failed for ${requestId}: ${e.message}`);
    }
  }
  // PAY-4b — the event trail is read ALWAYS, not only when the row gave
  // nothing: it has carried both approver ids since PAY-2, so payments
  // approved before the row held the pair are covered as well.
  {
    try {
      const events = await require('../repositories/paymentEventsRepository')
        .forPayment(pay && pay.payment_id);
      for (const ev of events || []) {
        if (String(ev.kind) !== 'approved') continue;
        const ids = ev.detail && ev.detail.approverIds;
        if (Array.isArray(ids)) ids.forEach(push);
        else push(ev.actor_id || ev.actorId);
      }
    } catch (e) {
      logger.warn(`PAY-4 approverIdsFor: event trail unavailable for ${pay && pay.payment_id}: ${e.message}`);
    }
  }
  return out;
}

/**
 * PAY-4 — can ANY finance seat release this payment, or did they all sign
 * it? Used to warn the approving admins at the moment of approval instead
 * of leaving the payment to be discovered as unpayable later.
 * @returns {Promise<{payable:boolean, eligible:string[], blocked:string[]}>}
 */
async function payableBy(pay) {
  const { ids } = await paymentRecipients();
  const approvers = await approverIdsFor(pay);
  const eligible = ids.map(String).filter((id) => !approvers.includes(id));
  const blocked = ids.map(String).filter((id) => approvers.includes(id));
  return { payable: eligible.length > 0, eligible, blocked };
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

/* ── PAY-6 (owner, 11-Nov-2026) — the COMPANY accounts a payment is paid from ── */

/**
 * The company's paying accounts, BY NAME (owner: "It will be maintained
 * through name"; numbers and QR details are a later release).
 *
 *   1. Settings `PAYMENT_SOURCE_ACCOUNTS` — entries separated by `;` or a
 *      new line (a single-line cell with neither is split on commas), each
 *      written the way the house writes a company bank account,
 *      `BANK — ACCOUNT NAME` (src/utils/bankEntry.js; a plain name with no
 *      dash is accepted as written). So `ZENITH — BLACK PANTHER CO., LTD;
 *      GTBANK — BLACK PANTHER` is two accounts, the comma kept in the name;
 *      on a comma-split cell a fragment naming no account joins the account
 *      before it, so `ZENITH — BLACK PANTHER CO., LTD` alone is ONE account.
 *      `0` / `off` / `none` / `-` / `—`, or a cell with no letter, = no
 *      paying account at all (no BANK_LIST fallback).
 *   2. That cell blank → the entries of Settings `BANK_LIST` that NAME an
 *      account (`ZENITH — BLACK PANTHER`). A plain bank name (`GTBank`) is a
 *      payee bank, not a company account, and is never offered.
 *
 * De-duplicated (case / space-insensitive), in the order written.
 *
 * THROWS when the Settings sheet cannot be read (PAY-6 review): a failed
 * read is not "no paying account configured" — reading it so would approve
 * a payment with no paying account while two are listed. The caller
 * (paymentCards.payFromStep) fails closed: nothing is approved. An empty
 * list means the read succeeded and named no account.
 *
 * @returns {Promise<Array<{label:string, bank:string, account:string}>>}
 */
async function sourceAccounts() {
  const s = (await settingsRepository.getAllStrict()) || {};
  const own = String(s.PAYMENT_SOURCE_ACCOUNTS == null ? '' : s.PAYMENT_SOURCE_ACCOUNTS).trim();
  // PAY-6 review 2: the off value. `0` / `off` / `none` / `-` / `—`, or a
  // cell with no letter at all (an account is kept by NAME), means "no
  // paying account" — never the BANK_LIST fallback, never a stamped `0`.
  if (own && (/^(0|off|none|-|—)$/i.test(own) || !/\p{L}/u.test(own))) return [];
  let entries;
  if (!own) entries = String(s.BANK_LIST == null ? '' : s.BANK_LIST).split(',');
  else if (/[;\n\r]/.test(own)) entries = own.split(/[;\n\r]+/);
  else {
    // Comma mode: a fragment that names no account (`LTD` of
    // `ZENITH — BLACK PANTHER CO., LTD`) belongs to the account before it.
    entries = [];
    for (const frag of own.split(/,+/)) {
      if (!frag.trim()) continue;
      const prev = entries[entries.length - 1];
      if (prev != null && !bankEntry.parse(frag).account && bankEntry.parse(prev).account) {
        entries[entries.length - 1] = `${prev},${frag}`;
      } else entries.push(frag);
    }
  }
  const out = [];
  const seen = new Set();
  for (const raw of entries) {
    const label = bankEntry.normalize(raw);
    if (!label || !/\p{L}/u.test(label)) continue;
    const { bank, account } = bankEntry.parse(label);
    // BANK_LIST is first of all the list of payee banks: only an entry that
    // names an account under its bank is one of the company's own.
    if (!own && !account) continue;
    const k = bankEntry.key(label);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ label, bank, account });
  }
  return out;
}

/** Six hex characters of the label, case / space-insensitive. */
function sourceFingerprint(label) {
  return require('crypto').createHash('sha1').update(bankEntry.key(label)).digest('hex').slice(0, 6);
}

/**
 * The picker chip's key for one paying account: its position in the list
 * plus a short fingerprint of its label — ASCII, at most 9 bytes. The
 * fingerprint is what makes a chip safe with no session: if the list is
 * edited between the picker and the tap, the key stops resolving and no
 * OTHER account can be stamped in its place.
 *
 * @param {Array<{label:string}>} accounts sourceAccounts()
 * @param {number} index
 * @returns {string} e.g. `0.3fa2c1`; '' for an index outside the list
 */
function sourceAccountKey(accounts, index) {
  const acct = Array.isArray(accounts) ? accounts[index] : null;
  return acct ? `${index}.${sourceFingerprint(acct.label)}` : '';
}

/**
 * The account a picker chip named, against the list as it stands NOW.
 * @param {Array<{label:string}>} accounts sourceAccounts()
 * @param {string} key sourceAccountKey()
 * @returns {{label:string, bank:string, account:string}|null} null when the
 *   key is malformed or the entry at that position is no longer that account
 */
function resolveSourceAccount(accounts, key) {
  const m = /^(\d{1,2})\.([0-9a-f]{6})$/.exec(String(key == null ? '' : key));
  if (!m || !Array.isArray(accounts)) return null;
  const acct = accounts[Number(m[1])];
  return acct && sourceFingerprint(acct.label) === m[2] ? acct : null;
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
 * PAY-1 — a REJECTED registration lets go of its account number.
 *
 * Raising `register_payment_account` writes the PaymentAccounts row as
 * `pending`. A rejection used to leave it there, and the door's clash
 * check (`findLive`: pending or active) then refused that number + bank
 * for ever as "awaiting approval", until the status cell was rewritten by
 * hand. The request's OWN row — found by its approval_request_id, the same
 * lookup the approval executor uses — goes to `inactive`: the status cell
 * alone, the row kept as the record. An account that is already `active`,
 * and any other request's row for the same number, are never touched.
 *
 * Throws on a refused sheet READ or write; the reject path logs it and
 * carries on. The read is the strict one on purpose: `getAll` answers an
 * empty register when the sheet cannot be read, which would pass here for
 * "no row" and leave the number blocked with only a wrong warning to show.
 *
 * @param {string} requestId the rejected ApprovalQueue request
 * @returns {Promise<object|null>} the row as it now stands; null when there
 *   was nothing to release
 */
async function releaseRejectedAccount(requestId) {
  if (!requestId) return null;
  const acct = (await paymentAccountsRepo.getAllStrict())
    .find((a) => a.approval_request_id === String(requestId)) || null;
  if (!acct) {
    logger.warn(`paymentService.releaseRejectedAccount: no PaymentAccounts row for ${requestId} — nothing released`);
    return null;
  }
  if (acct.status !== 'pending') return null;
  return paymentAccountsRepo.setStatus(acct.account_id, 'inactive');
}

/**
 * PAY-1 — a registration whose request NEVER REACHED the approval queue
 * lets go of its account number too.
 *
 * The approval gate writes the door's own record (the PaymentAccounts row,
 * `pending`) before the queue row. When the queue write is then refused
 * (the write quota, the network) that row names a request no admin can
 * approve or reject, and it refused every retry as "awaiting approval".
 * Released the same way as a rejected one: the status cell to `inactive`,
 * the row kept.
 *
 * Only when the request is really absent from the queue. A queue write can
 * report a failure after the row landed; that request IS awaiting approval
 * and keeps its row. A queue that cannot be read is never taken for "not
 * there" — nothing is released.
 *
 * Best-effort: never throws (the caller is already telling the person the
 * submit failed); every outcome that leaves the number blocked is logged.
 *
 * @param {string} requestId the request the door tried to raise
 * @returns {Promise<object|null>} the released row; null when nothing was released
 */
async function releaseUnqueuedAccount(requestId) {
  if (!requestId) return null;
  try {
    // Strict read (throws when the sheet cannot be read), resolved at call time.
    const onQueue = await require('../repositories/approvalQueueRepository').getByRequestId(requestId);
    if (onQueue) {
      logger.warn(`paymentService.releaseUnqueuedAccount: ${requestId} is on the approval queue — its PaymentAccounts row is kept`);
      return null;
    }
    const released = await releaseRejectedAccount(requestId);
    if (released) {
      logger.warn(`paymentService.releaseUnqueuedAccount: ${requestId} never reached the approval queue — PaymentAccounts row ${released.account_id} set to inactive so the number can be registered again`);
    }
    return released;
  } catch (e) {
    logger.error(`register_payment_account raise cleanup FAILED for ${requestId}: ${e.message} — if the request is not on the approval queue, its PaymentAccounts row still reads pending and blocks that account number until its status cell is set to inactive`);
    return null;
  }
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
 * PAY-2 — the reason for ONE payment, in the owner's order (10-Sep-2026):
 * the PaymentRequests row's own `reason` cell (column S — the sheet is
 * the complete record of an approved / paid request), then the Postgres
 * `payment_reasons` buffer, then the ApprovalQueue payload for rows that
 * predate both. Never throws; '' when nobody knows.
 *
 * @param {object} pay a PaymentRequests row (needs approval_request_id / payment_id)
 * @returns {Promise<string>}
 */
async function reasonFor(pay) {
  if (!pay) return '';
  if (pay.reason) return String(pay.reason);
  try {
    const pg = await paymentReasonsRepository.forPayment(pay.payment_id);
    if (pg && pg.reason_text) return String(pg.reason_text);
  } catch (_) { /* fail-open: the payload copy is still there */ }
  if (pay.approval_request_id) {
    try {
      const row = await approvalQueueRepository.getByRequestId(pay.approval_request_id);
      const r = row && row.actionJSON && row.actionJSON.reason;
      if (r) return String(r);
    } catch (e) {
      logger.warn(`paymentService.reasonFor: queue read failed — ${e.message}`);
    }
  }
  return '';
}

/**
 * The reasons for MANY rows (📋 My requests, the finance queue), in the
 * same order as `reasonFor`: the row's own cell first (no read at all
 * for a row raised after column S), Postgres next, and ONE ApprovalQueue
 * read — taken only when some row still needs it — for the leftovers.
 *
 * @param {object[]} pays PaymentRequests rows
 * @returns {Promise<Map<string,string>>} payment_id → reason ('' when unknown)
 */
async function reasonsFor(pays) {
  const out = new Map();
  const list = (pays || []).filter(Boolean);
  if (!list.length) return out;
  const pending = [];
  for (const p of list) {
    let reason = p.reason ? String(p.reason) : '';
    if (!reason) {
      try {
        const pg = await paymentReasonsRepository.forPayment(p.payment_id);
        if (pg && pg.reason_text) reason = String(pg.reason_text);
      } catch (_) { /* fail-open */ }
    }
    out.set(String(p.payment_id), reason);
    if (!reason) pending.push(p);
  }
  if (!pending.length) return out;
  let byRequest = new Map();
  try {
    const rows = await approvalQueueRepository.getAllWithRowIndex();
    byRequest = new Map((rows || []).map((r) => [String(r.requestId), r.actionJSON || {}]));
  } catch (e) {
    logger.warn(`paymentService.reasonsFor: queue read failed — ${e.message}`);
  }
  for (const p of pending) {
    const aj = byRequest.get(String(p.approval_request_id || ''));
    if (aj && aj.reason) out.set(String(p.payment_id), String(aj.reason));
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

/* ── PAY-5 (owner's Go, 10-Nov-2026) — salary by month, and the twin source ── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SALARY_KINDS = Object.freeze({ salary: 'Salary', salary_advance: 'Salary advance' });

/** `2026-11` → `Nov-2026`; '' when malformed. */
function periodLabel(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return '';
  return `${MONTHS[Number(m[2]) - 1]}-${m[1]}`;
}

/** The months a salary may be raised for: last, this, next (Lagos calendar). */
function periodChoices(now = new Date()) {
  const [y, mo] = now.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }).split('-').map(Number);
  return [-1, 0, 1].map((d) => {
    const dt = new Date(Date.UTC(y, mo - 1 + d, 1));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

/** The stored reason text of a salary chip: `Salary · Nov-2026`. */
function salaryReason(kind, period) {
  const word = SALARY_KINDS[kind];
  const label = periodLabel(period);
  return word && label ? `${word} · ${label}` : '';
}

/**
 * Read a reason back: `Salary · Nov-2026` → { kind: 'salary', period:
 * '2026-11' }. The sheet's column S holds the text, so the month needs no
 * column of its own. Anything else → { kind: '', period: '' }.
 */
function reasonKind(text) {
  const m = /^(Salary advance|Salary) · ([A-Z][a-z]{2})-(\d{4})$/.exec(String(text || '').trim());
  if (!m) return { kind: '', period: '' };
  const mi = MONTHS.indexOf(m[2]);
  if (mi < 0) return { kind: '', period: '' };
  return { kind: m[1] === 'Salary' ? 'salary' : 'salary_advance', period: `${m[3]}-${String(mi + 1).padStart(2, '0')}` };
}

/** A typed reason that is really a salary — it must go through the chip. */
function looksLikeSalary(text) {
  return /\bsalar(y|ies)\b/i.test(String(text || ''));
}

const digitsOf = (v) => String(v || '').replace(/\D/g, '');
const lower = (v) => String(v || '').trim().toLowerCase();

/**
 * PAY-5 — the payments twin source for the approval gate. A payment is the
 * same thing when it goes to the same account number and name for the same
 * amount and one is still OPEN (waiting on approval, or approved and not yet paid); and a
 * 💼 Salary is the same thing when that employee already has one for that
 * month — waiting, approved OR paid (declined / rejected ones do not count).
 * @returns {Promise<object|null>} twin descriptor for approvalGate
 */
async function openTwinFor({ payload, userId }) {
  const p = payload || {};
  const me = String(userId || '');
  const rows = await require('../repositories/paymentRequestsRepository').getAll();
  const acct = digitsOf(p.account_number);
  const name = lower(String(p.payee_name || '').replace(/\s+/g, ' '));
  const amt = Math.round(Number(p.amount_ngn) || 0);
  // The requester's OWN open request first (that is the one the door
  // refuses), then the oldest of anyone's (that is the one it flags).
  const byAge = (a, b) => (Number(String(b.raised_by) === me) - Number(String(a.raised_by) === me))
    || String(a.raised_at || '').localeCompare(String(b.raised_at || ''));
  let hit = null;
  let kind = 'same_request';
  if (acct && amt > 0) {
    // Owner, 11-Nov-2026: "The primary key of the duplicate transaction
    // would be account number, name, and the amount."
    hit = rows.filter((r) => ['pending_approval', 'approved'].includes(r.status)
      && digitsOf(r.account_number) === acct
      && lower(String(r.payee_name || '').replace(/\s+/g, ' ')) === name
      && Math.round(Number(r.amount_ngn) || 0) === amt).sort(byAge)[0] || null;
  }
  if (!hit && p.reason_kind === 'salary' && p.period) {
    hit = rows.filter((r) => ['pending_approval', 'approved', 'done'].includes(r.status)
      && lower(r.payee_name) === lower(p.payee_name)
      && lower(r.payee_type) === lower(p.payee_type)
      && (() => { const k = reasonKind(r.reason); return k.kind === 'salary' && k.period === p.period; })()).sort(byAge)[0] || null;
    kind = 'salary_period';
  }
  if (!hit) return null;
  const state = hit.status === 'pending_approval' ? 'pending' : (hit.status === 'approved' ? 'approved' : 'done');
  let aj = {
    action: 'request_payment', payment_id: hit.payment_id, payee_name: hit.payee_name,
    payee_type: hit.payee_type, amount_ngn: hit.amount_ngn, account_number: hit.account_number,
    bank: hit.bank, reason: hit.reason || '',
  };
  // A waiting twin's signatures live on its queue row — read it so the
  // refusal can say "1 of 2 signed".
  if (state === 'pending' && hit.approval_request_id) {
    try {
      const q = await approvalQueueRepository.getByRequestId(hit.approval_request_id);
      if (q && q.actionJSON) aj = { ...aj, ...q.actionJSON, reason: aj.reason || q.actionJSON.reason || '' };
    } catch (_) { /* the twin stands without its signature count */ }
  }
  return { requestId: hit.approval_request_id || '', raisedBy: hit.raised_by, createdAt: hit.raised_at, state, kind, aj };
}

module.exports = {
  periodLabel, periodChoices, salaryReason, reasonKind, looksLikeSalary, openTwinFor, SALARY_KINDS,
  FINANCE_DEPARTMENT,
  REASON_MIN,
  REASON_MAX,
  fmtNaira,
  financeHead,
  financeSeatIds,
  financeWarning,
  canExecute,
  approverIdsFor,
  payableBy,
  paymentRecipients,
  threshold,
  isAboveThreshold,
  payableAccountsFor,
  sourceAccounts,
  sourceAccountKey,
  resolveSourceAccount,
  releaseRejectedAccount,
  releaseUnqueuedAccount,
  validateAccountNumber,
  validateAmount,
  validateReason,
  reasonFor,
  reasonsFor,
};
