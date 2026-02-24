/**
 * Telegram message and callback handler — Package/Than model.
 */

const intentParser = require('../ai/intentParser');
const inventoryService = require('../services/inventoryService');
const approvalEvents = require('../events/approvalEvents');
const auth = require('../middlewares/auth');
const auditLogRepository = require('../repositories/auditLogRepository');
const analytics = require('../ai/analytics');
const config = require('../config');

const CURRENCY = config.currency || 'NGN';

function fmtQty(n) { return Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 }); }
function fmtMoney(n) { return `${CURRENCY} ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`; }

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
    await bot.sendMessage(chatId, helpText());
    return;
  }

  const intent = await intentParser.parse(text);

  if (intent.confidence < 0.75 && intent.clarification) {
    await bot.sendMessage(chatId, `Need more info: ${intent.clarification}`);
    return;
  }

  try {
    switch (intent.action) {

      case 'check': {
        const filters = {};
        if (intent.design) filters.design = intent.design;
        if (intent.shade) filters.shade = intent.shade;
        if (intent.warehouse) filters.warehouse = intent.warehouse;
        if (intent.packageNo) filters.packageNo = intent.packageNo;
        const stock = await inventoryService.checkStock(filters);
        const label = [
          intent.design ? `Design: ${intent.design}` : null,
          intent.shade ? `Shade: ${intent.shade}` : null,
          intent.warehouse ? `Warehouse: ${intent.warehouse}` : null,
        ].filter(Boolean).join(', ') || 'All stock';
        let reply = `📦 *${label}*\n`;
        reply += `Available: ${fmtQty(stock.totalYards)} yards across ${stock.totalThans} thans in ${stock.totalPackages} packages\n`;
        reply += `Value: ${fmtMoney(stock.totalValue)}`;
        if (stock.totalThans === 0) reply += '\n⚠️ No available stock matching these filters.';
        await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
        return;
      }

      case 'list_packages': {
        if (!intent.design) {
          await bot.sendMessage(chatId, 'Which design? e.g. "Show packages for design 44200"');
          return;
        }
        const packages = await inventoryService.listPackages(intent.design, intent.shade);
        if (!packages.length) {
          await bot.sendMessage(chatId, `No packages found for design ${intent.design}${intent.shade ? ' ' + intent.shade : ''}.`);
          return;
        }
        let reply = `📋 *Packages for ${intent.design}${intent.shade ? ' ' + intent.shade : ''}:*\n\n`;
        packages.forEach((p) => {
          reply += `Pkg ${p.packageNo} (${p.warehouse}): ${p.available}/${p.total} thans avail, ${fmtQty(p.availableYards)} yds\n`;
        });
        const totalAvail = packages.reduce((s, p) => s + p.availableYards, 0);
        reply += `\n*Total available: ${fmtQty(totalAvail)} yards*`;
        await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
        return;
      }

      case 'package_detail': {
        if (!intent.packageNo) {
          await bot.sendMessage(chatId, 'Which package? e.g. "Details of package 5801"');
          return;
        }
        const summary = await inventoryService.getPackageSummary(intent.packageNo);
        if (!summary) {
          await bot.sendMessage(chatId, `Package ${intent.packageNo} not found.`);
          return;
        }
        let reply = `📦 *Package ${summary.packageNo}*\n`;
        reply += `Design: ${summary.design} | Shade: ${summary.shade}\n`;
        reply += `Indent: ${summary.indent} | Warehouse: ${summary.warehouse}\n`;
        reply += `Price: ${fmtMoney(summary.pricePerYard)}/yard\n\n`;
        reply += `Thans (${summary.availableThans}/${summary.totalThans} available):\n`;
        summary.thans.forEach((t) => {
          const icon = t.status === 'available' ? '🟢' : '🔴';
          const sold = t.soldTo ? ` → ${t.soldTo} (${t.soldDate})` : '';
          reply += `${icon} Than ${t.thanNo}: ${fmtQty(t.yards)} yds${sold}\n`;
        });
        reply += `\n*Available: ${fmtQty(summary.availableYards)} yds | Sold: ${fmtQty(summary.soldYards)} yds*`;
        await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
        return;
      }

      case 'sell_than': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Sell than 3 from package 5801 to Ibrahim"'); return; }
        if (!intent.thanNo) { await bot.sendMessage(chatId, 'Which than number? e.g. "Sell than 3 from package 5801 to Ibrahim"'); return; }
        if (!intent.customer) { await bot.sendMessage(chatId, 'Who is the customer? e.g. "Sell than 3 from package 5801 to Ibrahim"'); return; }
        const result = await inventoryService.sellThan(intent.packageNo, intent.thanNo, intent.customer, userId);
        if (result.status === 'approval_required') {
          await bot.sendMessage(chatId, `⏳ Needs admin approval (${result.reason}). Request: ${result.requestId}`);
          const userLabel = msg.from?.username ? `@${msg.from.username}` : userId;
          await approvalEvents.notifyAdminsApprovalRequest(bot, result.requestId, userLabel,
            `Sell than ${intent.thanNo} from pkg ${intent.packageNo} to ${intent.customer}`, result.reason);
        } else if (result.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Sold than ${intent.thanNo} from package ${intent.packageNo} (${fmtQty(result.than.yards)} yds) to ${intent.customer}.`);
        } else {
          await bot.sendMessage(chatId, result.message || 'Could not complete the sale.');
        }
        return;
      }

      case 'sell_package': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Sell package 5801 to Adamu"'); return; }
        if (!intent.customer) { await bot.sendMessage(chatId, 'Who is the customer? e.g. "Sell package 5801 to Adamu"'); return; }
        const result = await inventoryService.sellPackage(intent.packageNo, intent.customer, userId);
        if (result.status === 'approval_required') {
          await bot.sendMessage(chatId, `⏳ Needs admin approval (${result.reason}). Request: ${result.requestId}`);
          const userLabel = msg.from?.username ? `@${msg.from.username}` : userId;
          await approvalEvents.notifyAdminsApprovalRequest(bot, result.requestId, userLabel,
            `Sell package ${intent.packageNo} to ${intent.customer}`, result.reason);
        } else if (result.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Sold package ${intent.packageNo}: ${result.soldThans} thans, ${fmtQty(result.soldYards)} yards to ${intent.customer}.`);
        } else {
          await bot.sendMessage(chatId, result.message || 'Could not complete the sale.');
        }
        return;
      }

      case 'sell_batch': {
        if (!intent.packageNos || !intent.packageNos.length) { await bot.sendMessage(chatId, 'Which packages? e.g. "Sell packages 5801, 5802, 5803 to Ibrahim"'); return; }
        if (!intent.customer) { await bot.sendMessage(chatId, 'Who is the customer?'); return; }
        const batchResult = await inventoryService.sellBatch(intent.packageNos, intent.customer, userId);
        let batchReply = `✅ Batch sale to ${intent.customer}:\n`;
        batchResult.details.forEach((d) => {
          const icon = d.status === 'completed' ? '✅' : '⚠️';
          batchReply += `${icon} Pkg ${d.packageNo}: ${d.status === 'completed' ? `${d.soldThans} thans, ${fmtQty(d.soldYards)} yds` : (d.message || d.status)}\n`;
        });
        batchReply += `\n*Total: ${batchResult.totalPackages} packages, ${batchResult.totalThans} thans, ${fmtQty(batchResult.totalYards)} yards*`;
        await bot.sendMessage(chatId, batchReply, { parse_mode: 'Markdown' });
        return;
      }

      case 'return_than': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Return than 2 from package 5801"'); return; }
        if (!intent.thanNo) { await bot.sendMessage(chatId, 'Which than number?'); return; }
        const retThan = await inventoryService.returnThan(intent.packageNo, intent.thanNo, userId);
        if (retThan.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Returned than ${intent.thanNo} from package ${intent.packageNo} (${fmtQty(retThan.than.yards)} yds) — now available.`);
        } else {
          await bot.sendMessage(chatId, retThan.message || 'Could not return.');
        }
        return;
      }

      case 'return_package': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Return package 5801"'); return; }
        const retPkg = await inventoryService.returnPackage(intent.packageNo, userId);
        if (retPkg.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Returned package ${intent.packageNo}: ${retPkg.returnedThans} thans, ${fmtQty(retPkg.returnedYards)} yards — now available.`);
        } else {
          await bot.sendMessage(chatId, retPkg.message || 'Could not return.');
        }
        return;
      }

      case 'update_price': {
        if (!intent.price) { await bot.sendMessage(chatId, 'What is the new price per yard?'); return; }
        if (!intent.packageNo && !intent.design) { await bot.sendMessage(chatId, 'Which package or design? e.g. "Update price of 44200 BLACK to 1500"'); return; }
        if (!auth.isAdmin(userId)) {
          await bot.sendMessage(chatId, 'Only admins can update prices.');
          return;
        }
        const filters = {};
        if (intent.packageNo) filters.packageNo = intent.packageNo;
        if (intent.design) filters.design = intent.design;
        if (intent.shade) filters.shade = intent.shade;
        const priceResult = await inventoryService.updatePrice(filters, intent.price, userId);
        if (priceResult.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Updated price for ${priceResult.label}: ${fmtMoney(priceResult.newPrice)}/yard (${priceResult.updated} rows).`);
        } else {
          await bot.sendMessage(chatId, priceResult.message || 'Could not update price.');
        }
        return;
      }

      case 'add': {
        await bot.sendMessage(chatId, 'To add stock, use the CSV import or add data directly to the Inventory sheet. Bulk import: place CSV in the project folder and run the import script.');
        return;
      }

      case 'analyze': {
        const summary = await analytics.getAnalysisSummary(intent.design, intent.shade);
        await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
        return;
      }

      default: {
        await bot.sendMessage(chatId, helpText());
      }
    }
  } catch (err) {
    await bot.sendMessage(chatId, `Error: ${err.message || 'Something went wrong. Please try again.'}`);
  }
}

function helpText() {
  return `Here's what I can do:

📦 *Stock check:* "How much 44200 BLACK do we have?"
📋 *List packages:* "Show packages for design 44200"
🔍 *Package detail:* "Details of package 5801"
💰 *Sell than:* "Sell than 3 from package 5801 to Ibrahim"
📦 *Sell package:* "Sell package 5802 to Adamu"
📦 *Sell batch:* "Sell packages 5801, 5802, 5803 to Ibrahim"
↩️ *Return:* "Return than 2 from package 5801" or "Return package 5803"
💲 *Update price:* "Update price of 44200 BLACK to 1500" (admin only)
📊 *Analyze:* "Analyze stock" or "Who bought 44200?"
🏭 *By warehouse:* "What's in Lagos warehouse?"`;
}

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
