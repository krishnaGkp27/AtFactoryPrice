'use strict';

/**
 * Recording fake of the node-telegram-bot-api `bot` object.
 *
 * The controller takes `bot` as an injected parameter, so a recorder is all
 * we need to characterize what a handler *says* (messages, edits, callback
 * acks, photos) without any network. Every method resolves like the real
 * client (returning a message-shaped object with a fresh message_id) and
 * appends a `{ method, args }` entry to `bot.calls`.
 */

/** @returns {object} a fake bot whose calls are recorded on `bot.calls`. */
function createFakeBot() {
  const calls = [];
  let messageId = 1000;

  const record = (method, args) => {
    calls.push({ method, args });
  };

  const sent = (chatId, text) => ({ message_id: (messageId += 1), chat: { id: chatId }, text });

  return {
    calls,

    async sendMessage(chatId, text, opts) {
      record('sendMessage', { chatId, text, opts });
      return sent(chatId, text);
    },
    async editMessageText(text, opts) {
      record('editMessageText', { text, opts });
      return { message_id: (opts && opts.message_id) || (messageId += 1), text };
    },
    async editMessageReplyMarkup(replyMarkup, opts) {
      record('editMessageReplyMarkup', { replyMarkup, opts });
      return { message_id: (opts && opts.message_id) || (messageId += 1) };
    },
    async answerCallbackQuery(callbackQueryId, opts) {
      record('answerCallbackQuery', { callbackQueryId, opts });
      return true;
    },
    async sendPhoto(chatId, photo, opts) {
      record('sendPhoto', { chatId, photo, opts });
      return sent(chatId);
    },
    async sendDocument(chatId, doc, opts) {
      record('sendDocument', { chatId, doc, opts });
      return sent(chatId);
    },
    async sendChatAction(chatId, action) {
      record('sendChatAction', { chatId, action });
      return true;
    },
    async deleteMessage(chatId, messageId2) {
      record('deleteMessage', { chatId, messageId: messageId2 });
      return true;
    },
    async getFile(fileId) {
      record('getFile', { fileId });
      return { file_id: fileId, file_path: `fake/${fileId}` };
    },

    // ── assertion helpers ────────────────────────────────────────────────
    /** All recorded calls for a given method name. */
    callsTo(method) {
      return calls.filter((c) => c.method === method);
    },
    /** Concatenated text of every sendMessage + editMessageText, for substring checks. */
    allText() {
      return calls
        .filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')
        .map((c) => c.args.text || '')
        .join('\n');
    },
  };
}

module.exports = { createFakeBot };
