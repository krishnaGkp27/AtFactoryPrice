'use strict';

/**
 * MNU-1 — one live menu per chat, kept where the user is looking.
 *
 * THE BUG (owner brief, 17-Aug-2026; audit finding L-2): navigation edits a
 * message in place, which is right until that message has scrolled away. A
 * Telegram edit does not move the message, does not scroll the client, and
 * keeps the original timestamp. So a tap on an old menu renders its answer
 * wherever that menu already sat — in one observed case eleven hours up the
 * scrollback, off-screen, with no toast and no new message. The user's
 * reasonable inference is "the button is dead".
 *
 * THE SIGNAL. The bot cannot see scroll position; no update carries it. But
 * in a bot DM the bot sees every message and `message_id` is a per-chat
 * sequential counter, so:
 *
 *     messagesBelowAnchor = latestMessageId - anchorMessageId
 *
 * is a direct count of how many messages sit BELOW the anchor — exactly the
 * quantity that decides whether it has scrolled off. Time is NOT used as a
 * staleness signal (a user can tap an hour later with the anchor still on
 * screen, or receive twenty notifications in five minutes and lose it); it is
 * used for one thing only, the 48-hour delete boundary, and even there as an
 * error path rather than a gate.
 *
 * STATE LIVES IN MEMORY, per chat. Justified, not assumed: railway.json sets
 * no numReplicas, the Dockerfile runs one process, and sessionStore is
 * already an in-memory Map — so the bot is single-replica by construction
 * today and this adds no new hazard. Losing anchors on restart degrades to
 * exactly today's behaviour (a fresh send), which is why that is safe.
 *
 * NOTHING HERE TOUCHES A SHEET. Storage rule 5b: UI cursors are not business
 * records, and a sheet round-trip in the navigation path is what makes taps
 * feel dead in the first place.
 */

const mutex = require('../utils/asyncMutex');
const logger = require('../utils/logger');

/**
 * How many messages may sit below the anchor before we stop trusting that it
 * is still on screen. A tuning knob, not a truth — and deliberately biased
 * low: a spurious re-anchor costs one extra message, a missed one costs a
 * silent failure the user reads as a dead button.
 */
const REANCHOR_AFTER_N_MESSAGES = 2;

/** chatId -> { anchorMessageId, view, viewParams, anchoredAtMsgId, anchoredAt } */
const _anchors = new Map();

/** chatId -> highest message_id seen in that chat, from any direction. */
const _latest = new Map();

/**
 * Anchors are only useful while their message is still deletable, and a bot
 * may only delete its own messages for 48 hours. Past that an entry is dead
 * weight, so the sweep drops it rather than letting the Map grow for ever.
 */
const ANCHOR_TTL_MS = 48 * 60 * 60 * 1000;

function _now() { return Date.now(); }

/**
 * Record the highest message_id seen for a chat.
 *
 * EVERY message must reach this — the user's, the bot's menus, and above all
 * the event messages (approval cards, digests, reminders). Those are not
 * menus and never become anchors, but they are precisely what pushes the
 * anchor up the scrollback, so a tracker that cannot see them would think a
 * buried menu was still fresh. That is AC9.
 */
function noteMessage(chatId, messageId) {
  const id = Number(messageId);
  if (!chatId || !Number.isFinite(id) || id <= 0) return;
  const key = String(chatId);
  const prev = _latest.get(key) || 0;
  if (id > prev) _latest.set(key, id);
}

function latestMessageId(chatId) {
  return _latest.get(String(chatId)) || 0;
}

function get(chatId) {
  const a = _anchors.get(String(chatId));
  if (!a) return null;
  if (_now() - (a.anchoredAt || 0) > ANCHOR_TTL_MS) {
    _anchors.delete(String(chatId));
    return null;
  }
  return { ...a };
}

/**
 * Compare-and-swap the anchor.
 *
 * Two rapid taps produce overlapping executions for one chat. Without CAS
 * they both send a menu and both delete — leaving a duplicate, or worse,
 * deleting the one the other just created. `expectedMessageId` is what the
 * caller read before it decided; if the stored value has moved since, the
 * other execution won and this one must clean up after itself.
 *
 * @returns {boolean} true when this caller's write landed.
 */
function compareAndSet(chatId, expectedMessageId, next) {
  const key = String(chatId);
  const cur = _anchors.get(key);
  const curId = cur ? cur.anchorMessageId : null;
  const exp = expectedMessageId === undefined ? null : expectedMessageId;
  if ((curId === null ? null : Number(curId)) !== (exp === null ? null : Number(exp))) return false;
  _anchors.set(key, {
    anchorMessageId: next.anchorMessageId,
    view: next.view || null,
    viewParams: next.viewParams || {},
    anchoredAtMsgId: next.anchoredAtMsgId != null ? next.anchoredAtMsgId : latestMessageId(chatId),
    anchoredAt: _now(),
  });
  return true;
}

function clear(chatId) { _anchors.delete(String(chatId)); }

/**
 * Should the next render edit the anchor in place, or move it to the bottom?
 *
 * @param {object} p
 * @param {string|number} p.chatId
 * @param {boolean} [p.userInitiated] the render was triggered by an incoming
 *   user MESSAGE (not a button tap). Unconditional re-anchor: their message
 *   is below the anchor and their viewport is at the bottom looking at it.
 *   This is the strongest signal available and needs no heuristic.
 * @returns {{action:'send'|'edit'|'reanchor', anchorMessageId:number|null,
 *            below:number, reason:string}}
 */
function decide({ chatId, userInitiated = false }) {
  const anchor = get(chatId);
  if (!anchor || !anchor.anchorMessageId) {
    return { action: 'send', anchorMessageId: null, below: 0, reason: 'no anchor' };
  }
  if (userInitiated) {
    return {
      action: 'reanchor', anchorMessageId: anchor.anchorMessageId, below: 0,
      reason: 'user sent a message — their viewport is at the bottom',
    };
  }
  const below = Math.max(0, latestMessageId(chatId) - Number(anchor.anchorMessageId));
  if (below >= REANCHOR_AFTER_N_MESSAGES) {
    return {
      action: 'reanchor', anchorMessageId: anchor.anchorMessageId, below,
      reason: `${below} message(s) below the anchor`,
    };
  }
  return {
    action: 'edit', anchorMessageId: anchor.anchorMessageId, below,
    reason: `${below} message(s) below — still probably visible`,
  };
}

/**
 * Retire a superseded anchor message: delete it, and if that fails strip its
 * keyboard so the corpse is not tappable.
 *
 * Both halves matter independently. A bot may only delete its own messages
 * for 48 hours, and an abandoned menu that stays tappable is its own bug —
 * users tap old menus and get nothing, or a jump into unexpected state. The
 * strip is what makes a failed delete harmless instead of confusing.
 *
 * Never throws. A failure here must not surface to the user: by the time we
 * are called the NEW menu already exists and the user is fine.
 *
 * @returns {Promise<'deleted'|'stripped'|'failed'>}
 */
async function retire(bot, chatId, messageId) {
  if (!bot || !chatId || !messageId) return 'failed';
  try {
    await bot.deleteMessage(chatId, String(messageId));
    return 'deleted';
  } catch (delErr) {
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] },
        { chat_id: chatId, message_id: messageId });
      return 'stripped';
    } catch (stripErr) {
      logger.warn(`menuAnchor: could not retire ${chatId}/${messageId} `
        + `(delete: ${delErr.message}; strip: ${stripErr.message})`);
      return 'failed';
    }
  }
}

/** Serialize read -> decide -> write for one chat. Never held across API calls. */
function withChatLock(chatId, fn) {
  return mutex.runExclusive(`menuAnchor:${chatId}`, fn);
}

/** Test hook. */
function _resetForTests() { _anchors.clear(); _latest.clear(); }

module.exports = {
  REANCHOR_AFTER_N_MESSAGES,
  noteMessage, latestMessageId,
  get, compareAndSet, clear,
  decide, retire, withChatLock,
  _resetForTests,
};
