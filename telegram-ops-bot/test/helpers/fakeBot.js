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
    /** SHP-1 — a photo message morphing its picture in place; answers like a sent photo. */
    async editMessageMedia(media, opts) {
      record('editMessageMedia', { media, opts });
      return {
        message_id: opts && opts.message_id, chat: { id: opts && opts.chat_id },
        photo: [{ file_id: 'morph_small' }, { file_id: 'morph_large' }],
      };
    },
    async editMessageCaption(caption, opts) {
      record('editMessageCaption', { caption, opts });
      return true;
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
      // Like the real API: the sent message carries its photo sizes, whose
      // largest file_id callers cache (SHP-1 reads it for the preview).
      const m = sent(chatId);
      return { ...m, photo: [{ file_id: `sent_${m.message_id}_small` }, { file_id: `sent_${m.message_id}_large` }] };
    },
    /**
     * CAT-P1 — albums. The real client answers with one message PER item,
     * each carrying its own photo sizes, which is what callers read to
     * collect message ids and cache file_ids. The fake must too.
     */
    async sendMediaGroup(chatId, media, opts) {
      record('sendMediaGroup', { chatId, media, opts });
      return (media || []).map((_, i) => ({
        message_id: (messageId += 1),
        chat: { id: chatId },
        photo: [{ file_id: `album_${i}_small` }, { file_id: `album_${i}_large` }],
      }));
    },
    async sendDocument(chatId, doc, opts, fileOptions) {
      record('sendDocument', { chatId, doc, opts, fileOptions });
      const m = sent(chatId);
      return { ...m, document: { file_id: `doc_${m.message_id}` } };
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
