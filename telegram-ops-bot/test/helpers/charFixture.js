'use strict';

/**
 * Shared characterization-test fixture helpers.
 *
 * Deduplicates the per-file `cb()` callback-query builder and the
 * last-rendered-keyboard inspectors that were copy-pasted across
 * test/characterization/*. Behavior is byte-identical to the local
 * definitions they replace.
 */

/**
 * Build a Telegram callback-query update object.
 * @param {string} data callback_data payload
 * @param {string} [uid] user/chat id (default '4242')
 * @param {number} [msgId] message_id of the tapped message (default 5)
 */
function cb(data, uid = '4242', msgId = 5) {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: msgId } };
}

/**
 * Flattened buttons of the LAST sendMessage/editMessageText keyboard.
 * @param {object} bot fakeBot recorder
 * @returns {Array<object>} inline_keyboard buttons, flattened; [] if none
 */
function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}

/**
 * Same as lastKb but mapped to `${text}|${callback_data}` strings.
 * @param {object} bot fakeBot recorder
 * @returns {Array<string>}
 */
function kbTexts(bot) {
  return lastKb(bot).map((b) => `${b.text}|${b.callback_data}`);
}

module.exports = { cb, lastKb, kbTexts };
