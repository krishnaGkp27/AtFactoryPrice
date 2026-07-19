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

// requestId → epoch-ms of the last reminder sent by THIS process.
const _remindedAt = new Map();
let _lastSweepMs = 0;

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
  const parts = [String(aj.action || 'action').replace(/_/g, ' ')];
  if (aj.design) parts.push(`design ${aj.design}`);
  if (aj.arrivalBatch) parts.push(`container ${aj.arrivalBatch}`);
  if (aj.warehouse) parts.push(`@ ${aj.warehouse}`);
  return parts.join(' — ');
}

/**
 * One reminder pass. Returns the number of cards sent (0 when disabled,
 * not yet due, or nothing qualifies). Never throws.
 */
async function sweep(bot, { now = Date.now() } = {}) {
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
    for (const q of due) {
      try {
        // APU-1: the reminder card carries the SAME detail as the original
        // (rebuilt from the queue row), a resolved requester name, the
        // admin-requester exclusion, and the attached sale doc re-forwarded.
        const userLabel = await approvalCards.resolveUserLabel(q.user, bot);
        const card = await approvalCards.buildCardFromActionJSON(q.actionJSON);
        const excludeId = config.access.adminIds.includes(String(q.user)) ? String(q.user) : undefined;
        await approvalEvents.notifyAdminsApprovalRequest(
          bot, q.requestId, userLabel, card, q.riskReason || 'Pending approval', excludeId,
          { prependNote: '⏰ Reminder — this approval is still waiting' },
        );
        if (q.actionJSON && q.actionJSON.sale_doc_file_id) {
          const kind = q.actionJSON.sale_doc_type === 'document' ? 'document' : 'photo';
          await approvalCards.forwardAttachmentsToAdmins(bot, q.requestId,
            [{ fileId: q.actionJSON.sale_doc_file_id, kind, caption: `📎 Sales bill for request ${q.requestId}` }], excludeId);
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

/** Test hook — reset per-process reminder memory. */
function _resetForTests() { _remindedAt.clear(); _lastSweepMs = 0; }

module.exports = { sweep, summarize, isStandardApprovable, MIN_AGE_MS, MAX_CARDS_PER_SWEEP, _resetForTests };
