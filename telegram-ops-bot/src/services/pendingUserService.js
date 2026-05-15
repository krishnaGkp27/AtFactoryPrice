/**
 * USR-C2 — Pending User capture service.
 *
 * When an unknown Telegram user sends `/start`, the bot:
 *   1. Politely tells them they're not yet registered.
 *   2. Captures their identity into the `PendingUsers` sheet (idempotent).
 *   3. Notifies admins via the Activity Feed with [Onboard] | [Ignore] buttons.
 *
 * Rate limit: at most RATE_LIMIT_MAX captures per RATE_LIMIT_WINDOW_MS to
 * defeat spam. Hits beyond the cap are dropped silently (admins are not
 * notified at all — the bot stays quiet). The limit is GLOBAL across all
 * incoming /start messages from strangers; legitimate onboarding happens
 * in ones and twos so the cap is generous.
 *
 * "Stranger" = a Telegram ID that auth.isAllowed() rejects AND is not yet
 * sitting in PendingUsers with status=pending (re-pings from the same
 * person are absorbed without re-notifying admins, except to refresh the
 * notification message if the admin lost it).
 */

'use strict';

const pendingUsersRepo = require('../repositories/pendingUsersRepository');
const auditLogRepo = require('../repositories/auditLogRepository');
const adminFeed = require('./adminFeed');
const logger = require('../utils/logger');

const RATE_LIMIT_MAX = 10;             // captures per window
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

let _windowStart = Date.now();
let _windowCount = 0;

function _checkRateLimit() {
  const now = Date.now();
  if (now - _windowStart >= RATE_LIMIT_WINDOW_MS) {
    _windowStart = now;
    _windowCount = 0;
  }
  if (_windowCount >= RATE_LIMIT_MAX) return false;
  _windowCount += 1;
  return true;
}

function _resetRateLimitForTests() {
  _windowStart = Date.now();
  _windowCount = 0;
}

function _displayName(msg) {
  const from = msg.from || {};
  const first = (from.first_name || '').trim();
  const last = (from.last_name || '').trim();
  const name = [first, last].filter(Boolean).join(' ');
  if (name) return name;
  if (from.username) return `@${from.username}`;
  return `id:${from.id}`;
}

function _politeReply() {
  return (
    "👋 Hello! You're not yet registered with this bot.\n\n"
    + 'An admin has been notified and will set you up shortly.\n'
    + "Once they do, send /menu and you'll see your options."
  );
}

function _adminCard(entry) {
  const username = entry.username ? `@${entry.username}` : '_(no username)_';
  const name = [entry.first_name, entry.last_name].filter(Boolean).join(' ') || '_(no name set)_';
  return (
    '🆕 *New /start from an unknown user*\n\n'
    + `Name: ${name}\n`
    + `Telegram: ${username}\n`
    + `ID: \`${entry.telegram_id}\`\n`
    + `When: ${entry.arrived_at}\n\n`
    + '_Tap **Onboard** to start the Add Employee flow with these details pre-filled, or **Ignore** if this is spam._'
  );
}

function _adminCardKeyboard(telegramId) {
  return {
    inline_keyboard: [[
      { text: '✅ Onboard', callback_data: `pu:onboard:${telegramId}` },
      { text: '🚫 Ignore',  callback_data: `pu:ignore:${telegramId}` },
    ]],
  };
}

/**
 * Main entry — called from the controller for any /start (or first
 * message) from an id that auth.isAllowed rejects. Returns a small
 * descriptor of what was done; safe to ignore.
 *
 * @param {object} bot      node-telegram-bot-api instance (or stub)
 * @param {object} msg      Telegram message object
 * @returns {Promise<{captured:boolean, reason?:string}>}
 */
async function captureStranger(bot, msg) {
  if (!msg || !msg.from || !msg.chat) return { captured: false, reason: 'malformed' };
  const telegramId = String(msg.from.id);
  const chatId = msg.chat.id;

  // Idempotency: already known? Just re-send the polite reply.
  let existing = null;
  try { existing = await pendingUsersRepo.findByTelegramId(telegramId); } catch (_) {}
  const wasAlreadyPending = !!(existing && existing.status === 'pending');

  // For brand-new entries: enforce the rate limit BEFORE writing or
  // notifying. Re-pings from the same person bypass the cap because we
  // don't write a new row.
  if (!wasAlreadyPending && !existing) {
    if (!_checkRateLimit()) {
      logger.warn(`pendingUser: rate-limit drop for ${telegramId} (${_windowCount}/${RATE_LIMIT_MAX} in window)`);
      // Stay silent — do NOT confirm receipt to a likely spammer.
      return { captured: false, reason: 'rate_limited' };
    }
  }

  // Always send the polite reply (re-pings included — they may have lost it).
  try {
    await bot.sendMessage(chatId, _politeReply());
  } catch (e) {
    logger.warn(`pendingUser: polite reply failed for ${telegramId}: ${e.message}`);
  }

  // Write or refresh the pending row.
  const entry = {
    telegram_id: telegramId,
    username: msg.from.username || '',
    first_name: msg.from.first_name || '',
    last_name: msg.from.last_name || '',
    arrived_at: new Date().toISOString(),
    status: 'pending',
  };

  let notify = false;
  if (!existing) {
    try {
      await pendingUsersRepo.append(entry);
      notify = true;
    } catch (e) {
      logger.error(`pendingUser: append failed for ${telegramId}: ${e.message}`);
    }
  } else if (existing.status !== 'pending') {
    // Previously handled (onboarded or ignored) but now reaching out again
    // — re-flag as pending. This covers the rare case where an admin
    // ignored someone who then turned out to be a legitimate hire.
    try {
      await pendingUsersRepo.updateStatus(telegramId, 'pending', '');
      notify = true;
    } catch (e) {
      logger.error(`pendingUser: re-pend failed for ${telegramId}: ${e.message}`);
    }
  }

  // Notify admins (best-effort; failures don't propagate).
  if (notify) {
    try {
      const text = _adminCard(entry);
      const reply_markup = _adminCardKeyboard(telegramId);
      // adminFeed.notify dispatches to every opted-in admin and returns
      // a delivery count (no per-message id today). last_notified_msg_id
      // stays empty for now — the column is reserved for a future
      // "cross out the card once handled" enhancement.
      await adminFeed.notify(
        bot, 'user.pending',
        text,
        { parse_mode: 'Markdown', reply_markup },
      );
    } catch (e) {
      logger.warn(`pendingUser: admin notify failed for ${telegramId}: ${e.message}`);
    }
  }

  // Audit (best-effort).
  try {
    await auditLogRepo.append('user.pending_captured', {
      telegram_id: telegramId,
      username: entry.username,
      rewrite: !!existing,
    }, telegramId);
  } catch (_) {}

  return { captured: true, displayName: _displayName(msg) };
}

/**
 * Admin clicked [Ignore] — flips the row to status=ignored.
 */
async function ignore(telegramId, adminUserId) {
  return pendingUsersRepo.updateStatus(telegramId, 'ignored', adminUserId);
}

/**
 * Called after a USR-C3 Add Employee approval lands successfully.
 * Flips the matching PendingUser row to status=onboarded so admins
 * stop seeing them in the queue.
 */
async function markOnboarded(telegramId, adminUserId) {
  return pendingUsersRepo.updateStatus(telegramId, 'onboarded', adminUserId);
}

module.exports = {
  captureStranger,
  ignore,
  markOnboarded,
  // exported for tests:
  _internals: {
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
    _resetRateLimitForTests,
  },
};
