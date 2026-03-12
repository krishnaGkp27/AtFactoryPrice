/**
 * Event handlers for approval workflow: notify admins, handle approve/reject.
 * For sale approvals: admin must enter rate (Naira per unit), payment mode, and amount paid (if paid).
 * Unit foundation: 'yard' for now; structure ready for other units (metre, piece) later.
 */

const config = require('../config');
const inventoryService = require('../services/inventoryService');
const logger = require('../utils/logger');
const inventoryRepository = require('../repositories/inventoryRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');

const SALE_ACTIONS = ['sell_than', 'sell_package', 'sale_bundle'];
/** Default sale unit (foundation for future: metre, piece, etc.) */
const DEFAULT_SALE_UNIT = 'yard';

/** Admin enrichment state: adminId -> { requestId, step, item, requestingUser, designs, ratePerUnitByDesign?, paymentMode?, amountPaid?, unit? } */
const pendingEnrichment = new Map();

async function getDesignsForSale(item) {
  const aj = item?.actionJSON || {};
  if (aj.action === 'sell_than' || aj.action === 'sell_package') {
    return aj.design ? [String(aj.design).trim()] : [];
  }
  if (aj.action === 'sale_bundle' && Array.isArray(aj.items)) {
    const designs = new Set();
    for (const si of aj.items) {
      const pkg = si.packageNo ? await inventoryRepository.findByPackage(si.packageNo) : [];
      if (pkg.length && pkg[0].design) designs.add(String(pkg[0].design).trim());
    }
    return Array.from(designs);
  }
  return [];
}

/** Start post-approval enrichment for a sale: admin will enter rate, payment mode, amount paid. */
async function startApprovalEnrichment(bot, adminId, chatId, requestId, item, requestingUser) {
  const designs = await getDesignsForSale(item);
  const unit = DEFAULT_SALE_UNIT;
  pendingEnrichment.set(adminId, {
    requestId, step: 'rate', item, requestingUser, designs, unit,
  });
  const designList = designs.length ? designs.join(', ') : 'this item';
  await bot.sendMessage(chatId, `📋 *Confirm sale details*\n\nDesign(s): ${designList}\nUnit: ${unit} (Naira per ${unit})\n\n*Step 1 — Rate:* Reply with rate per ${unit}.\n• Single design: e.g. \`1500\`\n• Multiple: e.g. \`44200:1500, 44201:1200\``);
}

/** Handle admin text reply during enrichment. Returns true if message was consumed. */
async function handleEnrichmentMessage(bot, chatId, adminId, text) {
  const state = pendingEnrichment.get(adminId);
  if (!state || !text) return false;

  const t = text.trim();
  const CURRENCY = config.currency || 'NGN';
  const fmt = (n) => `${CURRENCY} ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`;

  if (state.step === 'rate') {
    const rateByDesign = {};
    if (/^\d+(\.\d+)?$/.test(t)) {
      const single = parseFloat(t);
      if (isNaN(single) || single < 0) {
        await bot.sendMessage(chatId, 'Please enter a valid number for rate (Naira per yard).');
        return true;
      }
      state.designs.forEach((d) => { rateByDesign[d] = single; });
    } else {
      const pairs = t.split(/[,;]/).map((s) => s.trim());
      for (const p of pairs) {
        const [design, rateStr] = p.split(':').map((s) => s.trim());
        const rate = parseFloat(rateStr);
        if (design && !isNaN(rate) && rate >= 0) rateByDesign[design] = rate;
      }
      if (Object.keys(rateByDesign).length === 0) {
        await bot.sendMessage(chatId, 'Could not parse rates. Use single number (e.g. 1500) or design:rate (e.g. 44200:1500, 44201:1200).');
        return true;
      }
    }
    state.ratePerUnitByDesign = rateByDesign;
    state.step = 'payment';
    await bot.sendMessage(chatId, '*Step 2 — Payment mode:* Reply with one of:\n• Cash\n• Credit\n• Paid to [Bank] (e.g. Paid to GTBank)\n• Not yet paid');
    return true;
  }

  if (state.step === 'payment') {
    const mode = t;
    state.paymentMode = mode;
    const isPaid = /^paid\s+to\s+/i.test(mode) || /^cash$/i.test(mode);
    if (isPaid) {
      state.step = 'amount_paid';
      await bot.sendMessage(chatId, '*Step 3 — Amount paid:* Reply with the amount received (Naira), e.g. 50000');
      return true;
    }
    state.amountPaid = 0;
    state.step = null;
    pendingEnrichment.delete(adminId);
    const enrichment = {
      unit: state.unit,
      ratePerUnitByDesign: state.ratePerUnitByDesign,
      paymentMode: state.paymentMode,
      amountPaid: 0,
    };
    await runApprovedSaleWithEnrichment(bot, chatId, adminId, state.requestId, state.item, state.requestingUser, enrichment, fmt);
    return true;
  }

  if (state.step === 'amount_paid') {
    const amount = parseFloat(t.replace(/[,]/g, ''));
    if (isNaN(amount) || amount < 0) {
      await bot.sendMessage(chatId, 'Please enter a valid amount (Naira), e.g. 50000');
      return true;
    }
    state.amountPaid = amount;
    state.step = null;
    pendingEnrichment.delete(adminId);
    const enrichment = {
      unit: state.unit,
      ratePerUnitByDesign: state.ratePerUnitByDesign,
      paymentMode: state.paymentMode,
      amountPaid: amount,
    };
    await runApprovedSaleWithEnrichment(bot, chatId, adminId, state.requestId, state.item, state.requestingUser, enrichment, fmt);
    return true;
  }

  return false;
}

async function runApprovedSaleWithEnrichment(bot, chatId, adminId, requestId, item, requestingUser, enrichment, fmt) {
  try {
    const result = await inventoryService.executeApprovedAction(requestId, adminId, enrichment);
    if (result.ok) {
      await bot.sendMessage(chatId, `✅ Request ${requestId} approved. Sale and ledger updated.`);
      if (requestingUser && requestingUser !== adminId) {
        try { await bot.sendMessage(requestingUser, `✅ Your request (${requestId}) has been approved by admin. Sale and ledger updated.`); } catch (_) {}
      }
      const customer = item?.actionJSON?.customer || item?.actionJSON?.customerName;
      if (customer) {
        try {
          const accountingService = require('../services/accountingService');
          const { outstandingAsOfToday } = await accountingService.getCustomerLedger(customer);
          await bot.sendMessage(chatId, `📒 *${customer}* — Outstanding as of today: ${fmt(outstandingAsOfToday)}`);
        } catch (_) {}
      }
    } else {
      await bot.sendMessage(chatId, `⚠️ Approved but execution failed: ${result.message || 'Unknown error'}`);
    }
  } catch (e) {
    logger.error('Enrichment execution error', e);
    await bot.sendMessage(chatId, `⚠️ Error: ${e.message}`);
  }
}

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
  let item = null;
  let requestingUser = null;
  try {
    const pending = await approvalQueueRepository.getAllPending();
    item = pending.find((p) => p.requestId === requestId);
    if (item) requestingUser = item.user;
  } catch (_) {}

  const chatIdCb = callbackQuery.message.chat.id;
  const msgIdCb = callbackQuery.message.message_id;

  try {
    if (action === 'approve') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Approving...' });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatIdCb, message_id: msgIdCb });

      const isSale = item && item.actionJSON && SALE_ACTIONS.includes(item.actionJSON.action);
      if (isSale) {
        await startApprovalEnrichment(bot, adminId, chatIdCb, requestId, item, requestingUser);
        return;
      }

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
            const { outstandingAsOfToday } = await accountingService.getCustomerLedger(customer);
            const fmt = (n) => `${config.currency || 'NGN'} ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`;
            await bot.sendMessage(chatIdCb, `📒 *${customer}* — Outstanding as of today: ${fmt(outstandingAsOfToday)}`);
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

module.exports = { notifyAdminsApprovalRequest, handleApprovalCallback, handleEnrichmentMessage };
