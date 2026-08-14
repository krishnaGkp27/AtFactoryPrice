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
 * "Stranger" = any Telegram ID that auth.isAllowed() rejects — a brand-new
 * /start OR a previously-onboarded user who was later DEACTIVATED and is
 * reaching out again. Every such /start re-notifies admins with a fresh
 * Onboard card (capped by the rate limit) and (re-)flags the PendingUsers
 * row to `pending` so the person resurfaces in the Add Employee picker. The
 * admin notification is decoupled from the sheet write: a PendingUsers write
 * failure is logged but never suppresses the notification.
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

/**
 * Escape Telegram Markdown-v1 reserved chars so a stray "_", "*", "`" or "["
 * in a user's name/username can't break entity parsing on the admin card —
 * which would make bot.sendMessage throw and silently drop the notification
 * (e.g. a user literally named "Office_BPanther").
 */
const { mdEscape: _mdEscape } = require('../utils/flowKit');
const fmtDate = require('../utils/formatDate');

/**
 * CARD-3 + TIME-1 (owner, 12-Aug-2026) — the card carried four `Label:`
 * prefixes and a raw UTC ISO stamp (`When: 2026-08-12T15:58:34.018Z`).
 * Symbols replace the labels, name and handle fold onto one line, and the
 * arrival is the Lagos wall-clock the owner actually reads.
 *
 * 🕓 not 📅 on purpose: this is an INSTANT something happened, distinct from
 * the 📅 business date a human chose on the sale cards.
 *
 * The id keeps its monospace — tap-to-copy is the one load-bearing
 * affordance here — and the footer stays a full sentence, because an
 * instruction is the one thing that must never be terse.
 */
/** How much of a stranger's opening message the card quotes. */
const FIRST_MSG_MAX = 180;

function _adminCard(entry) {
  const handle = entry.username ? `@${_mdEscape(entry.username)}` : 'no username';
  const name = _mdEscape([entry.first_name, entry.last_name].filter(Boolean).join(' '));
  const who = name ? `${name} · ${handle}` : handle;
  // IDR-2 (owner, 14-Aug-2026) — quote what they actually said. A bare
  // "/start" tells you nothing, but "I want 5 bales of 9037" tells you at
  // a glance whether this is a customer, a marketer, or noise — which is
  // the whole decision the chips below ask you to make.
  const said = _firstMessageLine(entry.first_message);
  return (
    '🆕 *Unknown user messaged the bot*\n\n'
    + `👤 ${who}\n`
    + `🆔 \`${entry.telegram_id}\`\n`
    + `🕓 ${_mdEscape(fmtDate.withTime(entry.arrived_at))}\n`
    + said
    + '\nWho are they? Employee opens Add Employee; the other two record them '
    + 'and remember this Telegram account for them.'
  );
}

/** The quoted-message line, or '' for a bare greeting. */
function _firstMessageLine(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  // A greeting or /start carries no information the card doesn't already
  // show — quoting it would be noise on every ordinary first contact.
  if (/^\/start\b/i.test(text) || /^(hi|hello|hey)[\s!.]*$/i.test(text)) return '';
  const clipped = text.length > FIRST_MSG_MAX ? `${text.slice(0, FIRST_MSG_MAX)}…` : text;
  return `💬 _${_mdEscape(clipped.replace(/\s+/g, ' '))}_\n`;
}

/**
 * IDR-2 (owner, 14-Aug-2026) — the card is a TRIAGE, not a hire form.
 *
 * Until now the only door out of this card led to Add Employee, so an
 * arriving CUSTOMER could only be ignored and re-entered by hand — and
 * their Telegram identity was thrown away in the process. The owner's
 * three destinations each get a chip; whichever is chosen, the account is
 * bound in the identity register (IDR-1) so the business can reach that
 * person on Telegram afterwards.
 */
function _adminCardKeyboard(telegramId) {
  return {
    inline_keyboard: [
      [{ text: '👔 Onboard as employee', callback_data: `pu:onboard:${telegramId}` }],
      [{ text: '🤝 Link to existing customer', callback_data: `pu:cust:${telegramId}` }],
      [{ text: '🕸 Add to network', callback_data: `pu:net:${telegramId}` }],
      [{ text: '🚫 Ignore', callback_data: `pu:ignore:${telegramId}` }],
    ],
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

  // Look up any existing pending row (best-effort — drives append-vs-update).
  let existing = null;
  try { existing = await pendingUsersRepo.findByTelegramId(telegramId); } catch (_) {}

  // Rate-limit EVERY capture — brand-new strangers AND re-pings from someone
  // who already has a row (e.g. a deactivated user saying "hi" again). This
  // lets us re-notify admins on each /start so a returning user reliably
  // resurfaces, while still capping how fast a spammer can flood the feed.
  // Beyond the cap we stay silent (no reply, no notify).
  if (!_checkRateLimit()) {
    logger.warn(`pendingUser: rate-limit drop for ${telegramId} (${_windowCount}/${RATE_LIMIT_MAX} in window)`);
    return { captured: false, reason: 'rate_limited' };
  }

  // Always send the polite reply (re-pings included — they may have lost it).
  try {
    await bot.sendMessage(chatId, _politeReply());
  } catch (e) {
    logger.warn(`pendingUser: polite reply failed for ${telegramId}: ${e.message}`);
  }

  const entry = {
    telegram_id: telegramId,
    username: msg.from.username || '',
    first_name: msg.from.first_name || '',
    last_name: msg.from.last_name || '',
    arrived_at: new Date().toISOString(),
    status: 'pending',
    // IDR-2 — carried to the admin card only. Deliberately NOT persisted:
    // the register holds identity, and a chat message is neither identity
    // nor a business record (storage rule 5b).
    first_message: msg.text || msg.caption || '',
  };

  // Upsert the PendingUsers row so the person shows up in the Add Employee
  // picker. BEST-EFFORT: a sheet failure here must NOT suppress the admin
  // notification below — the notification (with its Onboard button) is what
  // actually gets the person onboarded, even if the picker is unavailable.
  try {
    if (!existing) {
      await pendingUsersRepo.append(entry);
    } else if (existing.status !== 'pending') {
      // Previously onboarded (then deactivated) or ignored, now reaching out
      // again — re-flag as pending so they reappear in the picker.
      await pendingUsersRepo.updateStatus(telegramId, 'pending', '');
    }
    // else: already pending — leave the row as-is.
  } catch (e) {
    logger.error(`pendingUser: PendingUsers upsert failed for ${telegramId} (admin will still be notified): ${e.message}`);
  }

  // ALWAYS notify admins — a fresh Onboard card on every /start from an
  // unknown or deactivated user (capped by the rate limit above). Decoupled
  // from the sheet write so a PendingUsers hiccup can't silently swallow the
  // one signal that gets the person onboarded.
  try {
    await adminFeed.notify(
      bot, 'user.pending',
      _adminCard(entry),
      { parse_mode: 'Markdown', reply_markup: _adminCardKeyboard(telegramId) },
    );
  } catch (e) {
    logger.warn(`pendingUser: admin notify failed for ${telegramId}: ${e.message}`);
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
    _adminCard,
    _mdEscape,
  },
};
