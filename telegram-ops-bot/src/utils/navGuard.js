'use strict';
/**
 * NAV-1 — one place guarantees a way back on every screen the bot draws in
 * answer to a person's own tap or message (owner, 03-Oct-2026: "check if there
 * is a card with no back navigation … fix the navigation", and on the
 * patch-per-screen draft: "improve the foundation itself").
 *
 * `wrap(bot, { chatId, userId, tapped })` returns the same bot for ONE update.
 * Every message it sends or edits into the acting person's private chat is
 * checked:
 *
 *   - an inline keyboard with no Back / Close / Cancel / Menu button (and no
 *     menu tile) gets the house footer appended — `⬅ Back to <Hub>`, the hub
 *     the person last opened a tile from, and `🏠 Menu`;
 *   - a keyboard-less text gets the same footer, once per update, while the
 *     person is in button mode (a tap) or a typed step is waiting on them —
 *     so a dead-end reply or a typed prompt can always be left.
 *
 * Messages to other chats (notifications, approval cards), reply keyboards,
 * an emptied keyboard (a deliberate wipe) and screens that already carry
 * navigation are byte-identical. The controller installs it at its three
 * entry points, so every flow — present and future — inherits it without a
 * line of its own; the footer's taps end the flow (sessionJanitor.leaveFlow).
 */
const sessionStore = require('./sessionStore');
const menuNav = require('./menuNav');
const activityRegistry = require('../services/activityRegistry');

const NAV_TEXT = /(^|[\s(])(back|close|cancel|menu|done|exit|finish)\b|⬅|◀|🏠|❌|↩|✖|🔙/i;
const WRAPPED = Symbol('navGuard');
const _hubByUser = new Map();

/** Remember the hub a person works under (every tile / hub tap); falsy forgets it (🏠 Menu). */
function rememberHub(userId, hubId) {
  if (hubId) _hubByUser.set(String(userId), String(hubId));
  else _hubByUser.delete(String(userId));
}

/** The footer row for this person: `⬅ Back to <Hub>` + `🏠 Menu`, or `🏠 Back to menu`. */
function footerFor(userId) {
  const hub = activityRegistry.getHub(_hubByUser.get(String(userId)));
  return [hub ? menuNav.hubAndMenuFooterRow(hub.id, hub.label) : menuNav.backToMenuRow()];
}

/** True when the keyboard already offers a way out (a nav word / emoji, or a menu tile). */
function hasNav(kb) {
  return kb.some((row) => Array.isArray(row) && row.some((b) => b
    && ((typeof b.callback_data === 'string' && b.callback_data.startsWith('act:')) || NAV_TEXT.test(String(b.text || '')))));
}

/** An inline keyboard without a way out gains the footer; an empty one (a wipe) or a reply keyboard is left alone. */
function guardKeyboard(rm, uid) {
  const kb = rm && rm.inline_keyboard;
  return Array.isArray(kb) && kb.length && !hasNav(kb) ? { ...rm, inline_keyboard: [...kb, ...footerFor(uid)] } : rm;
}

/** Send / edit options: the keyboard guarded, or a bare text given the footer (once per update, see the header). */
function guardOpts(opts, uid, state, bareOk) {
  if (opts && opts.reply_markup) return { ...opts, reply_markup: guardKeyboard(opts.reply_markup, uid) };
  if (!bareOk || state.bareDone || !(state.tapped || sessionStore.get(uid))) return opts;
  state.bareDone = true;
  return { ...(opts || {}), reply_markup: { inline_keyboard: footerFor(uid) } };
}

// method → where its chat id sits (absent = opts.chat_id), where its options sit,
// whether a bare text may gain the footer, and (for the one method that takes
// a keyboard directly) where that keyboard sits.
const METHODS = {
  sendMessage: { chat: 0, opts: 2, bare: true },
  editMessageText: { opts: 1, bare: true },
  sendPhoto: { chat: 0, opts: 2 },
  sendDocument: { chat: 0, opts: 2 },
  editMessageCaption: { opts: 1 },
  editMessageMedia: { opts: 1 },
  editMessageReplyMarkup: { opts: 1, markup: 0 },
};

/**
 * @param {object} bot
 * @param {{chatId:any, userId:any, tapped?:boolean}} ctx the acting person's chat and id; `tapped` = a button tap (vs a typed message)
 * @returns {object} the same bot, guarded for that private chat (any other chat: untouched)
 */
function wrap(bot, { chatId, userId, tapped }) {
  if (!bot || bot[WRAPPED] || chatId == null || String(chatId) !== String(userId)) return bot;
  const uid = String(userId);
  const state = { tapped: !!tapped, bareDone: false };
  return new Proxy(bot, {
    get(target, key) {
      if (key === WRAPPED) return true;
      const m = METHODS[key];
      const fn = target[key];
      if (!m || typeof fn !== 'function') return fn;
      return (...args) => {
        const opts = args[m.opts];
        const to = m.chat == null ? opts && opts.chat_id : args[m.chat];
        if (String(to) === uid) {
          if (m.markup != null) args[m.markup] = guardKeyboard(args[m.markup], uid);
          else args[m.opts] = guardOpts(opts, uid, state, !!m.bare);
        }
        return fn.apply(target, args);
      };
    },
  });
}

module.exports = { wrap, rememberHub, footerFor, hasNav, _internals: { _hubByUser, NAV_TEXT } };
