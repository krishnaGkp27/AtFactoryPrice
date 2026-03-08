/**
 * Event handlers for approval workflow: notify admins, handle approve/reject.
 */

const config = require('../config');
const inventoryService = require('../services/inventoryService');
const logger = require('../utils/logger');

/** Send approval request to each admin's private chat. */
async function notifyAdminsApprovalRequest(bot, requestId, userLabel, actionSummary, riskReason) {
  const esc = (s) => (s || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  const text = `🔔 *Approval required*\n\nRequest ID: \`${requestId}\`\nUser: ${esc(userLabel)}\nAction: ${esc(actionSummary)}\nReason: ${esc(riskReason)}\n\nUse buttons below to approve or reject\\.`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '✅ Approve', callback_data: `approve:${requestId}` }, { text: '❌ Reject', callback_data: `reject:${requestId}` }],
    ],
  };
  for (const adminId of config.access.adminIds) {
    try {
      await bot.sendMessage(adminId, text, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
    } catch (e) {
      logger.error('Failed to notify admin', adminId, e.message);
      try {
        const plain = `🔔 Approval required\n\nRequest ID: ${requestId}\nUser: ${userLabel}\nAction: ${actionSummary}\nReason: ${riskReason}\n\nUse buttons below to approve or reject.`;
        await bot.sendMessage(adminId, plain, { reply_markup: keyboard });
      } catch (e2) {
        logger.error('Failed to notify admin (plain fallback)', adminId, e2.message);
      }
    }
  }
}

/** Handle callback from admin: approve or reject. */
async function handleApprovalCallback(bot, callbackQuery, action) {
  const data = callbackQuery.data || '';
  const requestId = data.replace(/^(approve|reject):/, '');
  const adminId = String(callbackQuery.from.id);
  if (!config.access.adminIds.includes(adminId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only admins can approve.' });
    return;
  }
  const approvalQueueRepository = require('../repositories/approvalQueueRepository');
  let requestingUser = null;
  try {
    const pending = await approvalQueueRepository.getAllPending();
    const item = pending.find((p) => p.requestId === requestId);
    if (item) requestingUser = item.user;
  } catch (_) {}

  const chatIdCb = callbackQuery.message.chat.id;
  const msgIdCb = callbackQuery.message.message_id;

  try {
    if (action === 'approve') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Approving...' });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatIdCb, message_id: msgIdCb });

      const result = await inventoryService.executeApprovedAction(requestId, adminId);
      if (result.ok) {
        await bot.sendMessage(chatIdCb, `✅ Request ${requestId} approved. Changes applied.`);
        if (requestingUser && requestingUser !== adminId) {
          try { await bot.sendMessage(requestingUser, `✅ Your request (${requestId}) has been approved by admin. Changes applied.`); } catch (_) {}
        }
        const customer = item && item.actionJSON && (item.actionJSON.customer || item.actionJSON.customerName);
        if (customer) {
          try {
            const accountingService = require('../services/accountingService');
            const config = require('../config');
            const { totalDebit, totalCredit, outstanding } = await accountingService.getCustomerLedger(customer);
            const fmt = (n) => `${config.currency || 'NGN'} ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`;
            await bot.sendMessage(chatIdCb, `📒 *${customer}* — Sales DR ${fmt(totalDebit)} | Payments CR ${fmt(totalCredit)} | Outstanding: ${fmt(outstanding)}`);
          } catch (_) {}
        }
      } else {
        await bot.sendMessage(chatIdCb, `⚠️ Approved but execution failed: ${result.message || 'Unknown error'}`);
      }
    } else {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Rejecting...' });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatIdCb, message_id: msgIdCb });

      const result = await inventoryService.rejectApproval(requestId, adminId);
      if (result.ok) {
        await bot.sendMessage(chatIdCb, `❌ Request ${requestId} rejected.`);
        if (requestingUser && requestingUser !== adminId) {
          try { await bot.sendMessage(requestingUser, `❌ Your request (${requestId}) has been rejected by admin.`); } catch (_) {}
        }
      } else {
        await bot.sendMessage(chatIdCb, `⚠️ Rejection failed: ${result.message || 'Unknown error'}`);
      }
    }
  } catch (e) {
    logger.error('Approval callback error', e);
    try { await bot.sendMessage(chatIdCb, `⚠️ Error processing request ${requestId}: ${e.message}`); } catch (_) {}
  }
}

module.exports = { notifyAdminsApprovalRequest, handleApprovalCallback };
