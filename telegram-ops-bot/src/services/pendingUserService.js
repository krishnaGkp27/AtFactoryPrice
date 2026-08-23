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

/**
 * IDR-3 (owner, 21-Aug-2026) — ONE living card per stranger.
 *
 * The bug he saw: two messages from Ekwealor Chukwudi ("Hii", then
 * "/menu") produced two identical onboarding cards a minute apart. The old
 * rule was "notify on every capture", capped only by a GLOBAL 10/hour —
 * which both cluttered the feed and let one chatty stranger eat the budget
 * a genuinely new person needs.
 *
 * The fix is his own idea, and it is the better one: notify when a person
 * ENTERS the pending state, then EDIT that same card as they keep talking,
 * carrying a running log of what they said. The log is the triage evidence
 * — three lines together often answer "who are they?" outright, which is
 * exactly the question the chips ask.
 *
 * State is in memory, keyed by telegram id (the entity key). Losing it on
 * restart costs one extra card and self-heals — the same trade menuAnchor
 * makes, and safe for the same reason: single replica by construction.
 *
 * The log lives on the CARD only, never in a sheet: a chat message is
 * neither identity nor a business record (storage rule 5b), and the card
 * text survives in Telegram permanently anyway.
 */
const _liveCards = new Map(); // telegramId → { deliveries, messages:[{at,text}], at }
const CARD_LOG_MAX = 5;               // lines kept before older ones collapse
const CARD_TTL_MS = 12 * 60 * 60 * 1000;  // a card older than this starts fresh

function _liveCard(telegramId) {
  const c = _liveCards.get(String(telegramId));
  if (!c) return null;
  if (Date.now() - (c.at || 0) > CARD_TTL_MS) { _liveCards.delete(String(telegramId)); return null; }
  return c;
}

/** Drop the living card so the NEXT message starts a new one (resolution). */
function _clearLiveCard(telegramId) { _liveCards.delete(String(telegramId)); }

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

/**
 * Reset the per-test service state: the flood window AND (IDR-3) the living
 * cards. Every caller wants "a fresh scenario"; leaving a card behind makes
 * the next test's first message look like a returning stranger's second.
 */
function _resetRateLimitForTests() {
  _windowStart = Date.now();
  _windowCount = 0;
  _liveCards.clear();
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

/**
 * IDR-3 — the same card, with the running message log the owner asked for:
 * "you can still log the subsequent messages edited in place rather than
 * popping up separate card". Three lines together usually answer the very
 * question the chips ask, so the log IS the triage evidence.
 *
 * Capped at CARD_LOG_MAX lines with the older ones collapsed to a count —
 * a chatty stranger must not grow the card past Telegram's size limit.
 */
function _adminCardWithLog(entry, messages) {
  const handle = entry.username ? `@${_mdEscape(entry.username)}` : 'no username';
  const name = _mdEscape([entry.first_name, entry.last_name].filter(Boolean).join(' '));
  const who = name ? `${name} · ${handle}` : handle;

  const list = Array.isArray(messages) ? messages : [];
  const shown = list.slice(-CARD_LOG_MAX);
  const hidden = list.length - shown.length;

  // IDR-2 still stands for a SINGLE message: a bare "hi" or "/start"
  // carries nothing the card does not already show, so quoting it would be
  // noise. From the SECOND message on, the log earns its place — the
  // pattern itself is information (they came back, at these times), which
  // is what the owner asked to see instead of a second card.
  const singleBare = list.length === 1 && !_firstMessageLine(list[0] && list[0].text);

  let log = '';
  if (shown.length && !singleBare) {
    log = `\n💬 *Messages (${list.length})*\n`;
    if (hidden > 0) log += `_…and ${hidden} earlier_\n`;
    log += shown.map((m) => {
      const when = _mdEscape(fmtDate.withTime(m.at).slice(-5)); // HH:MM
      const said = _mdEscape(String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 90)) || '_(no text)_';
      return `${when} — _${said}_`;
    }).join('\n');
    log += '\n';
  }

  return (
    '🆕 *Unknown user messaged the bot*\n\n'
    + `👤 ${who}\n`
    + `🆔 \`${entry.telegram_id}\`\n`
    + `🕓 ${_mdEscape(fmtDate.withTime(entry.arrived_at))}\n`
    + log
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
      // MYP-1 §16 — a marketer is NOT company: they LINK, never Add Employee.
      [{ text: '📣 Link as marketer', callback_data: `pu:mkt:${telegramId}` }],
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

  // IDR-3 — ONE living card per stranger. A NEW card is sent only when this
  // person enters the pending state; while they are already pending, the
  // card each admin holds is EDITED with the growing message log. That is
  // the edge-vs-level rule: notify on the transition, not on every
  // observation — which is what removes the clutter structurally rather
  // than throttling it.
  //
  // Still decoupled from the sheet write: a PendingUsers hiccup must not
  // swallow the one signal that gets the person onboarded.
  const card = _liveCard(telegramId);
  const opts = { parse_mode: 'Markdown', reply_markup: _adminCardKeyboard(telegramId) };
  try {
    if (card) {
      card.messages.push({ at: entry.arrived_at, text: entry.first_message });
      card.at = Date.now();
      const { edited } = await adminFeed.editDelivered(
        bot, card.deliveries, _adminCardWithLog(entry, card.messages), opts);
      if (!edited) {
        // Every copy is gone or too old to edit (deleted card, restart):
        // start ONE fresh card rather than leaving the admins with nothing.
        const res = await adminFeed.notify(bot, 'user.pending',
          _adminCardWithLog(entry, card.messages), opts);
        card.deliveries = (res && res.deliveries) || [];
      }
    } else {
      const messages = [{ at: entry.arrived_at, text: entry.first_message }];
      const res = await adminFeed.notify(bot, 'user.pending',
        _adminCardWithLog(entry, messages), opts);
      _liveCards.set(String(telegramId), {
        deliveries: (res && res.deliveries) || [], messages, at: Date.now(),
      });
    }
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
  // IDR-3 — the card's life ends with the decision. If this person comes
  // back later, that is a NEW arrival and deserves a fresh card rather than
  // silent appends to a log an admin has already acted on.
  _clearLiveCard(telegramId);
  return pendingUsersRepo.updateStatus(telegramId, 'ignored', adminUserId);
}

/**
 * Called after a USR-C3 Add Employee approval lands successfully.
 * Flips the matching PendingUser row to status=onboarded so admins
 * stop seeing them in the queue.
 */
async function markOnboarded(telegramId, adminUserId) {
  _clearLiveCard(telegramId); // IDR-3 — see ignore()
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
    _liveCards,
    _clearLiveCard,
    _adminCardWithLog,
    CARD_LOG_MAX,
    _adminCard,
    _mdEscape,
  },
};
