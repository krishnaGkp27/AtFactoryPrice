'use strict';

/**
 * DSP-1 — remember WHICH message the requester's "Submitted" card is, so
 * the approval result can be written back into that same card rather than
 * arriving as a loose message hours later.
 *
 * The dispatcher raises a request without knowing the customer; the admin
 * assigns it at approval. The card they are already looking at is the
 * natural place for the answer to appear, so we store its coordinates on
 * the queue row (inside actionJSON — no new sheet column) and let
 * approvalEvents edit it in place when the decision lands.
 *
 * Best-effort on purpose: if this write fails the sale is unaffected and
 * the approval simply falls back to sending a fresh message.
 */

const sessionStore = require('./sessionStore');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const logger = require('./logger');

/**
 * @param {string} requestId  queued approval id
 * @param {number|string} chatId  chat the card lives in
 * @param {string} userId  requester, whose session holds the anchored card
 * @returns {Promise<void>}
 */
async function rememberRequesterCard(requestId, chatId, userId) {
  try {
    const session = sessionStore.get(userId);
    const messageId = session && session.flowMessageId;
    if (!messageId) return; // nothing anchored — approval will send a message
    await approvalQueueRepository.updateActionJSON(requestId, {
      requesterChatId: chatId,
      requesterMessageId: messageId,
    });
  } catch (e) {
    logger.warn(`rememberRequesterCard(${requestId}) failed: ${e.message}`);
  }
}

module.exports = { rememberRequesterCard };
