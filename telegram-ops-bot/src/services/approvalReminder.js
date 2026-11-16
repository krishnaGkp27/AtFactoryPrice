'use strict';

/**
 * APR-1 — pending-approval reminder.
 *
 * Approval requests reach admins as one-shot Telegram cards. When a card is
 * missed (phone offline, chat cleared) or the request was queued outside the
 * bot process (CAT-C2 Drive batch import runs on machines that may not be
 * able to reach Telegram), the request sits in the ApprovalQueue sheet with
 * nobody the wiser. This sweep re-sends cards for stale pending requests so
 * every approval eventually reaches an admin, no matter where it was queued.
 *
 * Cadence: server.js calls sweep() once shortly after boot and then hourly;
 * the service itself decides whether a pass is due (APPROVAL_REMINDER_HOURS,
 * Settings-tunable, 0 disables). Per-process memory keeps one card per
 * request per window — a redeploy resets that memory, which is acceptable:
 * a still-pending approval deserves the nudge.
 */

const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const approvalEvents = require('../events/approvalEvents');
const approvalCards = require('./approvalCards');
const settingsRepository = require('../repositories/settingsRepository');
const config = require('../config');
const logger = require('../utils/logger');

// Requests younger than this already produced a live card from their own
// queueing path moments ago — don't double-ping.
const MIN_AGE_MS = 10 * 60 * 1000;
// Safety cap per sweep so a large backlog can't flood admin chats.
const MAX_CARDS_PER_SWEEP = 10;
const HOUR_MS = 60 * 60 * 1000;

// requestId → epoch-ms of the last reminder sent by THIS process.
const _remindedAt = new Map();
let _lastSweepMs = 0;
// PAY-2 §2 H — payment_id → epoch-ms of the last finance reminder sent by
// THIS process. The durable clock is the `payment_events` trail; this is
// the floor that keeps a Postgres-less deploy from nudging every hour.
const _financeRemindedAt = new Map();
// PRC-2b — requestIds this process already widened (the floor under a
// failed askWidenedAt write: never a second card).
const _widened = new Set();
// PRC-2b review — requestId → { ids, at }: the admins the widen pass carded
// and when. The reminder round leaves THEM out for one reminder window (they
// were just told); the asked admin keeps his own reminder.
const _widenCarded = new Map();

/**
 * APU-1 3.3: rows whose next step is NOT a standard approve:/reject: tap
 * must never get a standard card — Approve dead-ends ("Unknown action
 * type") and Reject skips the flow's own cleanup (a rejected
 * transfer_stock would strand in-transit bales at neither warehouse).
 *  - transfer_stock: whole lifecycle rides trf:* buttons.
 *  - supply_request: admins only act at stage 'admin_review'; every other
 *    stage belongs to the dispatch team's own buttons (smc:/srf_*).
 */
function isStandardApprovable(aj) {
  if (!aj || typeof aj !== 'object') return true;
  if (aj.action === 'transfer_stock') return false;
  if (aj.action === 'supply_request' && aj.stage !== 'admin_review') return false;
  return true;
}

function summarize(aj) {
  if (!aj || typeof aj !== 'object') return 'pending action';
  // LBL-1 — owner vocabulary, one shared map (sale_bundle → "sale bale").
  const parts = [require('./approvalCards').actionLabel(aj.action)];
  if (aj.design) parts.push(`design ${aj.design}`);
  if (aj.arrivalBatch) parts.push(`container ${aj.arrivalBatch}`);
  if (aj.warehouse) parts.push(`@ ${aj.warehouse}`);
  return parts.join(' — ');
}

/**
 * One reminder pass: the pending-approval cards, then the PAY-2 finance
 * nudge on the same tick. Returns the number of APPROVAL cards sent (0
 * when disabled, not yet due, or nothing qualifies) — the finance count is
 * `sweepFinance`'s own. Never throws.
 */
async function sweep(bot, opts = {}) {
  // PRC-2b — on time, every call, whatever the reminder cadence: a request
  // asked of one admin reaches the others at ASKED_ADMIN_WIDEN_HOURS. Runs
  // first so the reminder pass below already sees the widened row.
  try { await sweepAskedWiden(bot, opts); } catch (e) { logger.warn(`approvalReminder widen: ${e.message}`); }
  const sent = await sweepPending(bot, opts);
  await sweepFinance(bot, opts);
  // TRF-20 (4/8) — transfers are excluded from the standard sweep above (their
  // lifecycle rides trf:* buttons); their own sweep re-sends the HOLDER's card
  // and escalates past TRANSFER_STALE_DAYS. Best-effort, never blocks the rest.
  try { await require('./transferReminder').sweep(bot, opts); } catch (e) { logger.warn(`transferReminder: ${e.message}`); }
  return sent;
}

/** The APR-1 pass: stale pending approvals get their admin card again. */
async function sweepPending(bot, { now = Date.now() } = {}) {
  try {
    // APR-2: cadence comes from the reminder policy (REMINDER_HOURS_ADMIN,
    // falling back to the legacy APPROVAL_REMINDER_HOURS), and a max-age
    // guard keeps the historic pending backlog from ever flooding again.
    const reminderPolicy = require('./reminderPolicy');
    const hours = await reminderPolicy.hoursForAdmin();
    if (!hours || hours <= 0) return 0;
    const maxAgeMs = (await reminderPolicy.maxAgeDays()) * 24 * 60 * 60 * 1000;
    const windowMs = hours * 60 * 60 * 1000;
    if (_lastSweepMs && now - _lastSweepMs < windowMs) return 0;
    _lastSweepMs = now;

    const pending = await approvalQueueRepository.getAllPending();
    const due = pending
      .filter((q) => {
        if (!isStandardApprovable(q.actionJSON)) return false;
        const created = Date.parse(q.createdAt || '') || 0;
        if (now - created < MIN_AGE_MS) return false;
        if (now - created > maxAgeMs) return false; // backlog guard
        const last = _remindedAt.get(q.requestId) || 0;
        return now - last >= windowMs;
      })
      // Newest first: recent requests are the actionable ones. A months-old
      // pending row is almost certainly abandoned — surfacing 10 of those
      // (prod has a 40+ backlog) would bury the card someone is waiting on.
      // Backlog expiry is a separate owner decision (approval semantics).
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, MAX_CARDS_PER_SWEEP);

    let sent = 0;
    // PRC-2 — read once per pass: how long a request asked of one admin
    // waits on that admin alone.
    const askedApprover = require('./askedApprover');
    const widenH = due.some((q) => q.actionJSON && q.actionJSON.askedAdmin) ? await askedApprover.widenHours() : 0;
    for (const q of due) {
      try {
        // APU-1: the reminder card carries the SAME detail as the original
        // (rebuilt from the queue row), a resolved requester name, the
        // admin-requester exclusion, and the attached sale doc re-forwarded.
        const userLabel = await approvalCards.resolveUserLabel(q.user, bot);
        const card = await approvalCards.buildCardFromActionJSON(q.actionJSON);
        const excludeId = config.access.adminIds.includes(String(q.user)) ? String(q.user) : undefined;
        // CNET-2 — an add_contact reminder rebuild keeps its destination
        // chips; every other action keeps the standard Approve/Reject pair.
        const kb = approvalCards.keyboardForRequest(q.requestId, q.actionJSON);
        // PRC-2 (owner, 16-Nov-2026) — a request asked of one named admin
        // reminds that admin alone until ASKED_ADMIN_WIDEN_HOURS, then every
        // admin; after a signature, only those who have not signed. Never
        // the requester. Un-asked rows: today's note and recipients.
        const stillWaiting = '⏰ Reminder — this approval is still waiting';
        // One send per group; an un-asked row is one group with no excludeIds.
        let groups = [{ note: stillWaiting, extra: {} }];
        const aud = askedApprover.audience({
          aj: q.actionJSON, requesterId: q.user, createdAt: q.createdAt,
          adminIds: config.access.adminIds, now, widenHours: widenH,
        });
        if (aud.asked) {
          // PRC-2b — once widened, the asked admin keeps "asked YOU" and only
          // the others read "asked: Musa · no answer for …h" (disjoint groups:
          // still one card per admin per round).
          groups = askedApprover.reminderGroups(aud, userLabel, config.access.adminIds)
            .map((g) => ({ note: g.note || stillWaiting, extra: { excludeIds: g.excludeIds } }));
          if (aud.reason === 'waited' && !q.actionJSON.askWidenedAt) {
            try {
              await approvalQueueRepository.updateActionJSON(q.requestId, { askWidenedAt: new Date(now).toISOString() });
            } catch (e) { logger.warn(`approvalReminder: askWidenedAt for ${q.requestId} not saved: ${e.message}`); }
          }
        }
        // PRC-2b review — admins the widen pass carded within this window
        // are left out (they were just told); everyone else as usual.
        const carded = _widenCarded.get(String(q.requestId));
        const justCarded = carded && now - carded.at < windowMs ? [...carded.ids] : [];
        let groupsSent = 0;
        for (const g of groups) {
          const extra = justCarded.length
            ? { ...g.extra, excludeIds: [...((g.extra && g.extra.excludeIds) || []), ...justCarded] }
            : g.extra;
          if (justCarded.length) {
            const left = new Set(extra.excludeIds.map(String));
            if (excludeId) left.add(String(excludeId));
            if (config.access.adminIds.every((a) => left.has(String(a)))) continue;
          }
          await approvalEvents.notifyAdminsApprovalRequest(
            bot, q.requestId, userLabel, card, q.riskReason || 'Pending approval', excludeId,
            { prependNote: g.note, ...(kb ? { keyboard: kb } : {}), ...extra },
          );
          groupsSent += 1;
        }
        if (!groupsSent) { _remindedAt.set(q.requestId, now); continue; } // everyone was just carded
        if (q.actionJSON && q.actionJSON.sale_doc_file_id) {
          const kind = q.actionJSON.sale_doc_type === 'document' ? 'document' : 'photo';
          await approvalCards.forwardAttachmentsToAdmins(bot, q.requestId,
            [{ fileId: q.actionJSON.sale_doc_file_id, kind, caption: `📎 Sales bill for request ${q.requestId}` }], excludeId);
        }
        // RET-4 — a return card's photo of the goods survives a scrolled-away
        // chat the same way the sales bill does.
        if (q.actionJSON && q.actionJSON.return_photo_file_id) {
          // A picture sent as a File carries a DOCUMENT file_id; sendPhoto
          // rejects it, so the recorded kind decides the sender (sale_doc_type
          // does the same two lines up).
          const rKind = q.actionJSON.return_photo_type === 'document' ? 'document' : 'photo';
          await approvalCards.forwardAttachmentsToAdmins(bot, q.requestId,
            [{ fileId: q.actionJSON.return_photo_file_id, kind: rKind, caption: `📷 Returned goods for request ${q.requestId}` }], excludeId);
        }
        _remindedAt.set(q.requestId, now);
        sent += 1;
      } catch (e) {
        logger.warn(`approvalReminder: card for ${q.requestId} failed: ${e.message}`);
      }
    }
    if (sent) logger.info(`approvalReminder: re-sent ${sent}/${pending.length} pending approval card(s)`);
    return sent;
  } catch (e) {
    logger.error('approvalReminder sweep failed:', e.message);
    return 0;
  }
}

/**
 * PRC-2b (owner was told "if the asked admin has not answered after 4 hours,
 * every admin is told") — the on-time widening. Runs on EVERY sweep() call
 * (hourly), independent of the reminder window and of the reminder cadence
 * being 0. For each pending, standard-approvable row asked of one admin (raw
 * `askedAdmin.id`, not the requester) with no signature, no `askWidenedAt`,
 * and a wait of at least ASKED_ADMIN_WIDEN_HOURS (0 = never by time; an
 * unreadable CreatedAt counts as waited, and its note then claims no hours):
 * the FULL card goes ONCE to every admin who holds none — every admin but the
 * requester and the asked admin — with
 * `🙋 Asked: Musa · no answer for 5h — any admin may approve`, then the row
 * is stamped. The asked admin and the requester get nothing from here.
 *
 * A request counts as widened only once its card REACHED an admin (or there
 * was nobody to send it to): a throw or a send that reached nobody leaves it
 * for the next hourly pass. The row is re-read just before the send, so a
 * signature given meanwhile stops it. Once delivered it is remembered in this
 * process even when the stamp write fails, and the stamp is retried on later
 * passes without a second card. The admins carded here are left out of the
 * reminder rounds for one reminder window (`_widenCarded`); the asked admin
 * keeps his own reminder. The backlog guard and the per-pass cap apply.
 * Returns the number of requests widened. Never throws.
 */
async function sweepAskedWiden(bot, { now = Date.now() } = {}) {
  try {
    const askedApprover = require('./askedApprover');
    const reminderPolicy = require('./reminderPolicy');
    const pending = await approvalQueueRepository.getAllPending();
    const rawAsked = (aj) => (aj && aj.askedAdmin && typeof aj.askedAdmin === 'object'
      ? String(aj.askedAdmin.id || '').trim() : '');
    const isSigned = (aj) => (Array.isArray(aj.approvals) && aj.approvals.length > 0)
      || (Array.isArray(aj.signoffs) && aj.signoffs.length > 0);
    const isCandidate = (q) => {
      const aj = q && q.actionJSON;
      if (!aj || typeof aj !== 'object' || !isStandardApprovable(aj)) return false;
      const asked = rawAsked(aj);
      if (!asked || asked === String(q.user)) return false;
      if (aj.askWidenedAt || isSigned(aj)) return false;
      return true;
    };
    const stamp = async (requestId) => {
      try {
        await approvalQueueRepository.updateActionJSON(requestId, { askWidenedAt: new Date(now).toISOString() });
      } catch (e) { logger.warn(`approvalReminder: askWidenedAt for ${requestId} not saved: ${e.message}`); }
    };
    const open = (pending || []).filter(isCandidate);
    // Delivered earlier in this process but the stamp never landed: retry the
    // stamp alone, never the card.
    for (const q of open.filter((r) => _widened.has(String(r.requestId))).slice(0, MAX_CARDS_PER_SWEEP)) {
      await stamp(q.requestId);
    }
    const candidates = open.filter((q) => !_widened.has(String(q.requestId)));
    if (!candidates.length) return 0;
    const widenH = Number(await askedApprover.widenHours());
    if (!(widenH > 0)) return 0;
    const maxAgeMs = (await reminderPolicy.maxAgeDays()) * 24 * HOUR_MS;
    const due = candidates
      .map((q) => ({ q, created: Date.parse(q.createdAt || '') }))
      .filter(({ created }) => !Number.isFinite(created)
        || (now - created >= widenH * HOUR_MS && now - created <= maxAgeMs))
      .sort((a, b) => String(b.q.createdAt).localeCompare(String(a.q.createdAt)))
      .slice(0, MAX_CARDS_PER_SWEEP);
    const admins = config.access.adminIds.map(String);
    let widened = 0;
    for (const { q, created } of due) {
      const id = String(q.requestId);
      try {
        const aj = q.actionJSON;
        const askedId = rawAsked(aj);
        const fullIds = admins.filter((a) => a !== String(q.user) && a !== askedId);
        if (!fullIds.length) {
          // Nobody is left to tell (the requester-admin and the asked admin
          // are the only admins): nothing to send, the row is widened as it is.
          _widened.add(id);
          widened += 1;
          await stamp(q.requestId);
          continue;
        }
        // Whole hours actually waited; an unreadable CreatedAt claims none
        // (askedLine then prints the plain `🙋 Asked: Musa`).
        const hours = Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / HOUR_MS)) : 0;
        const asked = { id: askedId, name: String(aj.askedAdmin.name || '').trim() || askedId };
        const note = askedApprover.askedLine(asked, { reason: 'waited', hours });
        const card = await approvalCards.buildCardFromActionJSON(aj);
        const kb = approvalCards.keyboardForRequest(q.requestId, aj);
        const userLabel = await approvalCards.resolveUserLabel(q.user, bot);
        // The asked admin may have signed (or another pass widened it) while
        // the card was being built: read the row again before sending.
        const fresh = await approvalQueueRepository.getByRequestId(q.requestId);
        if (!fresh || String(fresh.status || '').toLowerCase() !== 'pending' || !isCandidate(fresh)) continue;
        const res = await approvalEvents.notifyAdminsApprovalRequest(
          bot, q.requestId, userLabel, card, q.riskReason || 'Pending approval', undefined,
          { prependNote: note, excludeIds: admins.filter((a) => !fullIds.includes(a)), ...(kb ? { keyboard: kb } : {}) },
        );
        if (!res || !(Number(res.sent) > 0)) {
          logger.warn(`approvalReminder: widening ${id} reached no admin — retried next pass`);
          continue;
        }
        _widened.add(id);
        _widenCarded.set(id, { ids: new Set(fullIds), at: now });
        widened += 1;
        await stamp(q.requestId);
      } catch (e) {
        logger.warn(`approvalReminder: widening ${id} failed: ${e.message}`);
      }
    }
    if (widened) logger.info(`approvalReminder: widened ${widened} asked request(s) to every admin`);
    return widened;
  } catch (e) {
    logger.error('approvalReminder widen sweep failed:', e.message);
    return 0;
  }
}

/**
 * PAY-2 §2 H — the knob: hours of silence before an approved-but-unpaid
 * payment re-sends its finance card. Settings-tunable; 0 = off. A missing
 * or unreadable cell falls back to the in-code default, never to "on
 * every hour".
 */
async function financeReminderHours() {
  const dflt = Number(settingsRepository.DEFAULTS.PAYMENT_FINANCE_REMINDER_HOURS) || 0;
  try {
    const all = await settingsRepository.getAll();
    const raw = all && all.PAYMENT_FINANCE_REMINDER_HOURS;
    if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : dflt;
  } catch (_) {
    return dflt;
  }
}

/**
 * PAY-2 §2 H — the finance nudge. For every payment the sheet says is
 * approved but not paid, if `PAYMENT_FINANCE_REMINDER_HOURS` have passed
 * since the LATER of the approval and the last finance card / reminder
 * (the `payment_events` trail), the finance card is sent again through
 * paymentCards.sendFinanceCard, which logs it as `reminder_sent`. Without
 * a trail (Postgres off, or a payment approved before PAY-2) the queue
 * row's resolve stamp is the approval time, and this process remembers
 * what it sent. Returns the number of cards re-sent. Never throws.
 */
async function sweepFinance(bot, { now = Date.now() } = {}) {
  try {
    const hours = await financeReminderHours();
    if (!hours || hours <= 0) return 0;
    const windowMs = hours * 60 * 60 * 1000;
    const paymentRequestsRepo = require('../repositories/paymentRequestsRepository');
    const paymentEventsRepo = require('../repositories/paymentEventsRepository');
    const paymentCards = require('./paymentCards');
    const waiting = await paymentRequestsRepo.awaitingPayment();
    let sent = 0;
    for (const pay of waiting || []) {
      if (sent >= MAX_CARDS_PER_SWEEP) break;
      if (!pay || !pay.payment_id || pay.status !== 'approved') continue;
      try {
        const stamps = [_financeRemindedAt.get(pay.payment_id) || 0];
        for (const kind of ['approved', 'finance_card_sent', 'reminder_sent']) {
          const at = await paymentEventsRepo.lastKindAt(pay.payment_id, kind);
          const ms = Date.parse(at || '') || 0;
          if (ms) stamps.push(ms);
        }
        let since = Math.max(...stamps);
        if (!since && pay.approval_request_id) {
          const row = await approvalQueueRepository.getByRequestId(pay.approval_request_id);
          since = Date.parse((row && row.resolvedAt) || '') || 0;
        }
        if (!since) since = Date.parse(pay.raised_at || '') || 0;
        if (!since || now - since < windowMs) continue;
        const r = await paymentCards.sendFinanceCard(bot, pay.payment_id, { kind: 'reminder_sent' });
        if (r && r.sent) {
          _financeRemindedAt.set(pay.payment_id, now);
          sent += 1;
        }
      } catch (e) {
        logger.warn(`approvalReminder: finance reminder for ${pay.payment_id} failed: ${e.message}`);
      }
    }
    if (sent) logger.info(`approvalReminder: re-sent ${sent}/${(waiting || []).length} finance card(s) awaiting payment`);
    return sent;
  } catch (e) {
    logger.error('approvalReminder finance sweep failed:', e.message);
    return 0;
  }
}

/** Test hook — reset per-process reminder memory. */
function _resetForTests() { _remindedAt.clear(); _financeRemindedAt.clear(); _widened.clear(); _widenCarded.clear(); _lastSweepMs = 0; }

module.exports = {
  sweep, sweepPending, sweepAskedWiden, sweepFinance, financeReminderHours,
  summarize, isStandardApprovable, MIN_AGE_MS, MAX_CARDS_PER_SWEEP, _resetForTests,
};
