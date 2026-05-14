/**
 * Centralized Telegram UI primitives used by every controller / flow.
 *
 * Replaces three near-identical `editOrSend` definitions (telegramController,
 * taskFlow, catalogFlowController), two anchored variants, and one each of
 * `sendLong`, `cbSafe`, and `safeDelete` that had drifted across the codebase.
 *
 *   editOrSend(bot, chatId, msgId, text, opts)     — edit in place or fresh send
 *   editOrSendAnchored(bot, chatId, userId, ...)   — same, but anchors session.flowMessageId
 *   sendLong(bot, chatId, text, opts)              — splits past Telegram's 4096-char cap
 *   cbSafe(data)                                   — trims callback_data to 64-byte limit
 *   safeDelete(bot, chatId, msgId)                 — best-effort delete, swallows errors
 */

const sessionStore = require('./sessionStore');

/**
 * Edit `messageId` in place when supplied; otherwise send a fresh message.
 * `opts` accepts any Telegram options (parse_mode, reply_markup, etc.).
 * Returns the resulting Message object — or `true` in the rare case
 * `bot.editMessageText` returns a boolean.
 */
async function editOrSend(bot, chatId, messageId, text, opts = {}) {
  if (messageId) {
    try {
      return await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...opts,
      });
    } catch (_) {
      // fall through to fresh send (message gone, identical content, etc.)
    }
  }
  return bot.sendMessage(chatId, text, opts);
}

/**
 * Edit-in-place OR fresh-send a flow message, AND keep the session's
 * `flowMessageId` anchored on whichever message_id results.
 *
 * Each step of a multi-step picker (e.g. supply flow: warehouse → design
 * → shade → quantity → cart → customer) edits a single message in place,
 * which requires every render to write the current message_id back to the
 * session — otherwise an interruption (e.g. a photo preview clearing the
 * anchor) leaves later steps unable to find the picker they should edit.
 */
async function editOrSendAnchored(bot, chatId, userId, text, opts = {}) {
  const session = userId ? sessionStore.get(userId) : null;
  const msgId = session && session.flowMessageId;
  const result = await editOrSend(bot, chatId, msgId, text, opts);
  if (session && result && typeof result === 'object' && result.message_id) {
    session.flowMessageId = result.message_id;
    sessionStore.set(userId, session);
  }
  return result;
}

/**
 * Send a (potentially long) message, splitting on line boundaries so each
 * chunk fits inside Telegram's 4096-char limit. `reply_markup` is attached
 * only to the FINAL chunk so an inline keyboard doesn't repeat across the
 * split.
 */
async function sendLong(bot, chatId, text, opts = {}) {
  const MAX = 4000;
  if (text.length <= MAX) {
    return bot.sendMessage(chatId, text, opts);
  }
  const lines = text.split('\n');
  const optsNoKeyboard = { ...opts };
  delete optsNoKeyboard.reply_markup;
  const chunks = [];
  let chunk = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > MAX && chunk) {
      chunks.push(chunk);
      chunk = line;
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk) chunks.push(chunk);
  let last;
  for (let i = 0; i < chunks.length; i++) {
    const useOpts = i === chunks.length - 1 ? opts : optsNoKeyboard;
    last = await bot.sendMessage(chatId, chunks[i], useOpts);
  }
  return last;
}

/**
 * Telegram caps callback_data at 64 bytes. Truncates the tail until the
 * payload fits — callers should make sure prefix carries the routing info.
 */
function cbSafe(data) {
  if (Buffer.byteLength(data, 'utf8') <= 64) return data;
  let s = data;
  while (Buffer.byteLength(s, 'utf8') > 64) s = s.slice(0, -1);
  return s;
}

/** Best-effort delete; swallows the "message can't be deleted" error class. */
async function safeDelete(bot, chatId, messageId) {
  if (!messageId) return;
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  editOrSend,
  editOrSendAnchored,
  sendLong,
  cbSafe,
  safeDelete,
};
