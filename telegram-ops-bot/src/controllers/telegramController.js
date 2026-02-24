/**
 * Telegram message and callback handler. Passes structured intent to service layer.
 */

const intentParser = require('../ai/intentParser');
const inventoryService = require('../services/inventoryService');
const riskEvaluate = require('../risk/evaluate');
const approvalEvents = require('../events/approvalEvents');
const auth = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const auditLogRepository = require('../repositories/auditLogRepository');
const logger = require('../utils/logger');
const config = require('../config');

const CURRENCY = config.currency || 'NGN';

function formatQty(n) {
  return Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

/**
 * Handle incoming text message from Telegram.
 */
async function handleMessage(bot, msg) {
  const chatId = msg.chat?.id;
  const userId = String(msg.from?.id || '');
  const text = (msg.text || '').trim();

  if (!auth.isAllowed(userId)) {
    await bot.sendMessage(chatId, 'You are not authorized to use this bot.');
    return;
  }

  await auditLogRepository.append('telegram_message', { chatId, text: text.slice(0, 200) }, userId);

  if (!text) {
    await bot.sendMessage(chatId, 'Send a command like: "Sell 100 yards design ABC red from Main" or "Check stock for blue" or "Analyze stock".');
    return;
  }

  const intent = await intentParser.parse(text);

  if (intent.confidence < 0.75 && intent.clarification) {
    await bot.sendMessage(chatId, `Need a bit more info: ${intent.clarification}`);
    return;
  }

  switch (intent.action) {
    case 'check': {
      const design = intent.design || null;
      const color = intent.color || null;
      const warehouse = intent.warehouse || null;
      const stock = await inventoryService.checkStock(design, color, warehouse);
      const label = [stock.design || 'Any', stock.color || 'Any', stock.warehouse || 'Any'].filter(Boolean).join(' / ');
      let reply = `📦 Stock (${label}): ${formatQty(stock.qty)} yards. Price: ${CURRENCY} ${Number(stock.price).toLocaleString('en-NG')}.`;
      const thresholds = await riskEvaluate.getThresholds();
      if (stock.qty > 0 && stock.qty < thresholds.lowStockThreshold) {
        reply += `\n⚠️ Low stock (below ${thresholds.lowStockThreshold} yards).`;
      } else if (stock.qty <= 0) {
        reply += '\n⚠️ Out of stock.';
      }
      await bot.sendMessage(chatId, reply);
      return;
    }

    case 'sell': {
      const qVal = validate.validateQty(intent.qty);
      if (!qVal.valid) {
        await bot.sendMessage(chatId, qVal.message);
        return;
      }
      const dVal = validate.validateRequired(intent.design, 'design');
      const cVal = validate.validateRequired(intent.color, 'color');
      const wVal = validate.validateRequired(intent.warehouse, 'warehouse');
      if (!dVal.valid || !cVal.valid || !wVal.valid) {
        await bot.sendMessage(chatId, dVal.message || cVal.message || wVal.message);
        return;
      }
      const result = await inventoryService.deductStock(dVal.value, cVal.value, wVal.value, qVal.value, userId);
      if (result.status === 'approval_required') {
        await bot.sendMessage(chatId, `⏳ This action needs admin approval. Request ID: ${result.requestId}. You will be notified when it is reviewed.`);
        const userLabel = msg.from?.username ? `@${msg.from.username}` : userId;
        const actionSummary = `Sell ${qVal.value} yd ${dVal.value} ${cVal.value} @ ${wVal.value}`;
        await approvalEvents.notifyAdminsApprovalRequest(bot, result.requestId, userLabel, actionSummary, result.reason);
      } else {
        await bot.sendMessage(chatId, `✅ Sold ${formatQty(qVal.value)} yards. Stock: ${formatQty(result.before)} → ${formatQty(result.after)}.`);
      }
      return;
    }

    case 'add': {
      const qVal = validate.validateQty(intent.qty);
      if (!qVal.valid) {
        await bot.sendMessage(chatId, qVal.message);
        return;
      }
      const dVal = validate.validateRequired(intent.design, 'design');
      const cVal = validate.validateRequired(intent.color, 'color');
      const wVal = validate.validateRequired(intent.warehouse, 'warehouse');
      if (!dVal.valid || !cVal.valid || !wVal.valid) {
        await bot.sendMessage(chatId, dVal.message || cVal.message || wVal.message);
        return;
      }
      const result = await inventoryService.addStock(dVal.value, cVal.value, wVal.value, qVal.value, userId);
      await bot.sendMessage(chatId, `✅ Added ${formatQty(qVal.value)} yards. Stock: ${formatQty(result.before)} → ${formatQty(result.after)}.`);
      return;
    }

    case 'analyze': {
      const summary = await inventoryService.analyzeStock();
      await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
      return;
    }

    case 'modify': {
      await bot.sendMessage(chatId, 'Modifying past transactions requires admin approval. Please contact an admin.');
      return;
    }

    default: {
      await bot.sendMessage(chatId, 'I didn’t understand. Try: "Check stock for red", "Sell 50 design X blue Main", or "Analyze stock".');
    }
  }
}

/**
 * Handle inline button callbacks (approve/reject).
 */
async function handleCallbackQuery(bot, callbackQuery) {
  const data = (callbackQuery.data || '').trim();
  if (data.startsWith('approve:')) {
    await approvalEvents.handleApprovalCallback(bot, callbackQuery, 'approve');
  } else if (data.startsWith('reject:')) {
    await approvalEvents.handleApprovalCallback(bot, callbackQuery, 'reject');
  } else {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Unknown action.' });
  }
}

module.exports = { handleMessage, handleCallbackQuery };
