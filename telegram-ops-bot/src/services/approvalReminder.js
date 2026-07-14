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
const settingsRepository = require('../repositories/settingsRepository');
const logger = require('../utils/logger');

// Requests younger than this already produced a live card from their own
// queueing path moments ago — don't double-ping.
const MIN_AGE_MS = 10 * 60 * 1000;
// Safety cap per sweep so a large backlog can't flood admin chats.
const MAX_CARDS_PER_SWEEP = 10;

// requestId → epoch-ms of the last reminder sent by THIS process.
const _remindedAt = new Map();
let _lastSweepMs = 0;

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
    const settings = await settingsRepository.getAll();
    const hours = Number(settings.APPROVAL_REMINDER_HOURS);
    if (!hours || hours <= 0 || Number.isNaN(hours)) return 0;
    const windowMs = hours * 60 * 60 * 1000;
    if (_lastSweepMs && now - _lastSweepMs < windowMs) return 0;
    _lastSweepMs = now;

    const pending = await approvalQueueRepository.getAllPending();
    const due = pending
      .filter((q) => {
        const created = Date.parse(q.createdAt || '') || 0;
        if (now - created < MIN_AGE_MS) return false;
        const last = _remindedAt.get(q.requestId) || 0;
        return now - last >= windowMs;
      })
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(0, MAX_CARDS_PER_SWEEP);

    let sent = 0;
    for (const q of due) {
      try {
        await approvalEvents.notifyAdminsApprovalRequest(
          bot, q.requestId, q.user, summarize(q.actionJSON), q.riskReason || 'Pending approval', null,
          { prependNote: '⏰ Reminder — this approval is still waiting' },
        );
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

module.exports = { sweep, summarize, MIN_AGE_MS, MAX_CARDS_PER_SWEEP, _resetForTests };
