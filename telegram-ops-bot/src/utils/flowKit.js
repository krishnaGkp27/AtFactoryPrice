'use strict';

/**
 * flowKit — shared building blocks for guided flow modules (src/flows/*).
 *
 * Before this util, 16 flows each re-implemented the identical anchored
 * "edit-else-send" render helper plus their own back/cancel/close rows.
 * New flows should use flowKit; existing flows migrate opportunistically
 * (behavior-identical — see makeRenderer options for the known variants).
 *
 * Conventions preserved exactly:
 *  - render edits session.flowMessageId in place when possible, else sends
 *    fresh and re-anchors the new message id on the session;
 *  - a missing session never crashes a render (message still sends);
 *  - failures to edit (deleted message, photo anchor, identical text) fall
 *    through to a fresh send silently.
 */

const sessionStore = require('./sessionStore');
const { isNotModified } = require('./telegramUI');

/**
 * Build a flow's anchored renderer.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.parseMode='Markdown']  null → plain text
 * @param {boolean} [opts.disablePreview=false]      disable_web_page_preview
 * @param {boolean} [opts.requireSession=false]      render nothing when the
 *        session is gone (the strict variant several flows use — their
 *        screens are meaningless without live state)
 * @param {string} [opts.titlePrefix='']             prepended to every text —
 *        for flows whose screens all share one header (e.g. "🏷️ *Set
 *        Design Category*\n\n")
 * @returns {(bot:object, chatId:number|string, userId:string, text:string, rows:Array) => Promise<number|null>}
 *          resolves with the message id the render landed on (null if unknown)
 */
function makeRenderer(opts = {}) {
  const { parseMode = 'Markdown', disablePreview = false, requireSession = false, titlePrefix = '' } = opts;
  return async function render(bot, chatId, userId, body, rows) {
    const text = titlePrefix + body;
    const session = sessionStore.get(userId);
    if (requireSession && !session) return null;
    const sendOpts = { reply_markup: { inline_keyboard: rows } };
    if (parseMode) sendOpts.parse_mode = parseMode;
    if (disablePreview) sendOpts.disable_web_page_preview = true;

    const mid = session && session.flowMessageId;
    if (mid) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...sendOpts });
        return mid;
      } catch (e) {
        // "message is not modified" = screen already correct — success, do
        // NOT fall through to sendMessage (that spawns a duplicate card).
        if (isNotModified(e)) return mid;
        /* deleted / photo anchor — fall through to fresh send */
      }
    }
    const sent = await bot.sendMessage(chatId, text, sendOpts);
    if (session && sent && sent.message_id) {
      session.flowMessageId = sent.message_id;
      sessionStore.set(userId, session);
    }
    return (sent && sent.message_id) || null;
  };
}

/**
 * Standard row builders for a flow's callback namespace.
 * @param {string} ns e.g. 'udf' → callbacks 'udf:back', 'udf:cancel', 'udf:close'
 * @returns {{backRow:Function, cancelRow:Function, closeRow:Function, menuRow:Function, backAndCancelRow:Function}}
 */
function rowsFor(ns) {
  return {
    backRow: (label) => [{ text: label || '⬅ Back', callback_data: `${ns}:back` }],
    cancelRow: () => [{ text: '❌ Cancel', callback_data: `${ns}:cancel` }],
    closeRow: () => [{ text: '❌ Close', callback_data: `${ns}:close` }],
    backAndCancelRow: (label) => [
      { text: label || '⬅ Back', callback_data: `${ns}:back` },
      { text: '❌ Cancel', callback_data: `${ns}:cancel` },
    ],
    /** Session-free jump back to the greeting menu (routed by the controller). */
    menuRow: () => [{ text: '🏠 Back to menu', callback_data: 'act:__back__' }],
  };
}

/**
 * Guard helper for handleCallback dispatchers: answers the callback and
 * returns the live session only when it matches the flow's SESSION_TYPE.
 * Returns null (after an optional expiry notice) otherwise.
 *
 * @param {object} bot
 * @param {object} query        Telegram callback query
 * @param {string} sessionType  the flow's SESSION_TYPE
 * @param {{expiredText?:string}} [opts] send this when the session is gone
 * @returns {Promise<{session:object, chatId:number|string, userId:string}|null>}
 */
async function guardSession(bot, query, sessionType, opts = {}) {
  const chatId = query.message && query.message.chat && query.message.chat.id;
  const userId = String(query.from.id);
  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
  const session = sessionStore.get(userId);
  if (!session || session.type !== sessionType) {
    if (opts.expiredText) {
      try { await bot.sendMessage(chatId, opts.expiredText); } catch (_) { /* ignore */ }
    }
    return null;
  }
  return { session, chatId, userId };
}

/**
 * Lay out flat buttons into keyboard rows of `perRow` (the pattern every
 * flow re-implemented as a local `chunk`).
 * @param {Array} items @param {number} perRow
 * @returns {Array<Array>}
 */
/**
 * SJ-4 — track an auxiliary flow message (catalogue photo card, interim
 * prompt) for disposal when the flow completes, cancels, or goes stale.
 * Bounded at 20 ids per session; the janitor deletes them on abandonment
 * via the session snapshot.
 * @param {string} userId
 * @param {number} messageId
 */
function trackAux(userId, messageId) {
  if (!messageId) return;
  const s = sessionStore.get(userId);
  if (!s) return;
  if (!Array.isArray(s._auxMsgIds)) s._auxMsgIds = [];
  if (s._auxMsgIds.length < 20 && !s._auxMsgIds.includes(messageId)) {
    s._auxMsgIds.push(messageId);
    sessionStore.set(userId, s);
  }
}

/**
 * SJ-4 — delete every tracked auxiliary message (best-effort), leaving
 * only the sealed receipt in the chat. Call BEFORE sessionStore.clear /
 * before handing the session off to another flow type.
 * @param {object} bot @param {number|string} chatId @param {string} userId
 * @param {{except?:number|number[]}} [opts] ids to spare — pass the tapped
 *        message id when the caller is about to EDIT it into the terminal
 *        notice (a tracked prompt can carry the Cancel button itself).
 */
async function disposeAux(bot, chatId, userId, opts = {}) {
  const s = sessionStore.get(userId);
  const ids = (s && Array.isArray(s._auxMsgIds)) ? s._auxMsgIds.splice(0) : [];
  if (s && ids.length) sessionStore.set(userId, s);
  const keep = new Set([].concat(opts.except || []));
  for (const mid of ids) {
    if (keep.has(mid)) continue;
    try { await bot.deleteMessage(chatId, mid); } catch (_) { /* already gone */ }
  }
}

function chunk(items, perRow) {
  const rows = [];
  const n = Math.max(1, perRow | 0);
  for (let i = 0; i < (items || []).length; i += n) rows.push(items.slice(i, i + n));
  return rows;
}

/**
 * Escape the Markdown-v1 specials Telegram trips on inside user-supplied
 * strings (names, notes) rendered with parse_mode 'Markdown'.
 * @param {*} s @returns {string}
 */
function mdEscape(s) {
  return String(s == null ? '' : s).replace(/([_*`[\]])/g, '\\$1');
}

/**
 * MYP-3 (owner, 27-Aug-2026) — the person-facing title of the allocated-
 * products view: "🧵 Goku's Collection", never "My Products" and never a
 * warehouse name (§16 — no warehouse fact reaches their world). Possessive
 * follows English: a name already ending in s takes a bare apostrophe.
 * Falls back to "Your Collection" when no name is known. Markdown-escaped —
 * safe inside a *bold* title.
 */
function collectionTitle(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return '🧵 Your Collection';
  return `🧵 ${mdEscape(n)}${/s$/i.test(n) ? '’' : '’s'} Collection`;
}

/**
 * SUB-1 — single-flight guard for a flow's SUBMIT step.
 *
 * The incident: one Kano sale queued five times, five request ids, five
 * admin cards, all in the same minute. Two live triggers, same mechanism:
 * the sales-bill photo fires submit (an ALBUM fires it once per photo),
 * and the submit button stays tappable during the slow work (sheet append,
 * audit row, notifying every admin). The step guards all flip AFTER those
 * awaits, so every re-entry passed them.
 *
 * The fix is the first statement being SYNCHRONOUS: Node runs one JS
 * thread, so a flag flipped before the first `await` is visible to every
 * later re-entry with no window at all. Everything else (idempotent
 * append, the duplicate flag on cards) is defence behind this line.
 *
 * Usage, at the very top of a submit handler:
 *   if (!beginSubmit(session, userId)) { <toast "already submitting">; return; }
 *   try { ...slow work... }
 *   catch (e) { endSubmit(session, userId); throw/render-retry; }
 *   // on success: clear the session as usual — no endSubmit needed.
 */
function beginSubmit(session, userId) {
  if (!session) return false;
  if (session._submitting) return false;
  session._submitting = true;
  sessionStore.set(userId, session);
  return true;
}

/** Re-open the door after a FAILED submit, so the user can retry. */
function endSubmit(session, userId) {
  if (!session) return;
  delete session._submitting;
  sessionStore.set(userId, session);
}

module.exports = { makeRenderer, rowsFor, guardSession, chunk, mdEscape, collectionTitle, trackAux, disposeAux, beginSubmit, endSubmit };
