/**
 * Telegram message and callback handler — Package/Than model.
 */

const intentParser = require('../ai/intentParser');
const inventoryService = require('../services/inventoryService');
const approvalEvents = require('../events/approvalEvents');
const auth = require('../middlewares/auth');
const riskEvaluate = require('../risk/evaluate');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const analytics = require('../ai/analytics');
const crmService = require('../services/crmService');
const accountingService = require('../services/accountingService');
const salesFlow = require('../services/salesFlowService');
const sessionStore = require('../utils/sessionStore');
const settingsRepo = require('../repositories/settingsRepository');
const config = require('../config');

function genId() {
  try { return require('crypto').randomUUID(); }
  catch { return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
}

async function sendLong(bot, chatId, text, opts = {}) {
  const MAX = 4000;
  if (text.length <= MAX) {
    await bot.sendMessage(chatId, text, opts);
    return;
  }
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > MAX && chunk) {
      await bot.sendMessage(chatId, chunk, opts);
      chunk = line;
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk) await bot.sendMessage(chatId, chunk, opts);
}

async function requireApproval(bot, chatId, msg, userId, action, actionJSON, summary) {
  const risk = await riskEvaluate.evaluate({ action, userId });
  if (risk.risk !== 'approval_required') return false;
  const requestId = genId();
  await approvalQueueRepository.append({
    requestId, user: userId, actionJSON, riskReason: risk.reason, status: 'pending',
  });
  await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);
  await bot.sendMessage(chatId, `⏳ Needs admin approval (${risk.reason}). Request: ${requestId}`);
  const userLabel = msg.from?.username ? `@${msg.from.username}` : userId;
  await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, risk.reason);
  return true;
}

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

  // Handle active sale flow sessions (guided step-by-step)
  const activeSession = salesFlow.getSession(userId);
  if (activeSession) {
    const handled = await handleSaleSession(bot, chatId, msg, userId, text, activeSession);
    if (handled) return;
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
        await sendLong(bot, chatId, reply, { parse_mode: 'Markdown' });
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
        await sendLong(bot, chatId, reply, { parse_mode: 'Markdown' });
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
        await sendLong(bot, chatId, reply, { parse_mode: 'Markdown' });
        return;
      }

      case 'sell_than': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Sell than 3 from package 5801 to Ibrahim"'); return; }
        if (!intent.thanNo) { await bot.sendMessage(chatId, 'Which than number?'); return; }
        const items = [{ type: 'than', packageNo: intent.packageNo, thanNo: intent.thanNo }];
        await startSaleFlow(bot, chatId, msg, userId, 'sell_than', items, intent);
        return;
      }

      case 'sell_package': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Sell package 5801 to Adamu"'); return; }
        const items = [{ type: 'package', packageNo: intent.packageNo }];
        await startSaleFlow(bot, chatId, msg, userId, 'sell_package', items, intent);
        return;
      }

      case 'sell_batch': {
        if (!intent.packageNos || !intent.packageNos.length) { await bot.sendMessage(chatId, 'Which packages? e.g. "Sell packages 5801, 5802, 5803 to Ibrahim"'); return; }
        const items = intent.packageNos.map((p) => ({ type: 'package', packageNo: p }));
        await startSaleFlow(bot, chatId, msg, userId, 'sell_batch', items, intent);
        return;
      }

      case 'sell_mixed': {
        if (!intent.thanItems || !intent.thanItems.length) { await bot.sendMessage(chatId, 'Which thans? e.g. "Sell than 1 from 5801, than 2 from 5804 to Customer"'); return; }
        const mixedItems = intent.thanItems.map((t) => ({ type: 'than', packageNo: t.packageNo, thanNo: t.thanNo }));
        await startSaleFlow(bot, chatId, msg, userId, 'sell_mixed', mixedItems, intent);
        return;
      }

      case 'return_than': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Return than 2 from package 5801"'); return; }
        if (!intent.thanNo) { await bot.sendMessage(chatId, 'Which than number?'); return; }
        const rtQueued = await requireApproval(bot, chatId, msg, userId, 'return_than',
          { action: 'return_than', packageNo: intent.packageNo, thanNo: intent.thanNo },
          `Return than ${intent.thanNo} from pkg ${intent.packageNo}`);
        if (rtQueued) return;
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
        const rpQueued = await requireApproval(bot, chatId, msg, userId, 'return_package',
          { action: 'return_package', packageNo: intent.packageNo },
          `Return package ${intent.packageNo}`);
        if (rpQueued) return;
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
        const filters = {};
        if (intent.packageNo) filters.packageNo = intent.packageNo;
        if (intent.design) filters.design = intent.design;
        if (intent.shade) filters.shade = intent.shade;
        const upQueued = await requireApproval(bot, chatId, msg, userId, 'update_price',
          { action: 'update_price', filters, price: intent.price },
          `Update price ${filters.design || filters.packageNo || '?'} to ${intent.price}/yd`);
        if (upQueued) return;
        const priceResult = await inventoryService.updatePrice(filters, intent.price, userId);
        if (priceResult.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Updated price for ${priceResult.label}: ${fmtMoney(priceResult.newPrice)}/yard (${priceResult.updated} rows).`);
        } else {
          await bot.sendMessage(chatId, priceResult.message || 'Could not update price.');
        }
        return;
      }

      case 'transfer_than': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Transfer than 3 from package 5801 to Kano"'); return; }
        if (!intent.thanNo) { await bot.sendMessage(chatId, 'Which than number?'); return; }
        if (!intent.warehouse) { await bot.sendMessage(chatId, 'To which warehouse? e.g. "Transfer than 3 from package 5801 to Kano"'); return; }
        const ttInfo = await inventoryService.getPackageSummary(intent.packageNo);
        const ttThan = ttInfo?.thans?.find((t) => t.thanNo === intent.thanNo);
        const ttFrom = ttInfo?.warehouse || '?';
        const ttDetail = `Transfer Than\nPackage: ${intent.packageNo}\nThan: ${intent.thanNo} (${ttThan ? fmtQty(ttThan.yards) + ' yds' : '?'})\nDesign: ${ttInfo?.design || '?'} ${ttInfo?.shade || ''}\nFrom: ${ttFrom}\nTo: ${intent.warehouse}`;
        const ttQueued = await requireApproval(bot, chatId, msg, userId, 'transfer_than',
          { action: 'transfer_than', packageNo: intent.packageNo, thanNo: intent.thanNo, toWarehouse: intent.warehouse },
          ttDetail);
        if (ttQueued) return;
        const ttRes = await inventoryService.transferThan(intent.packageNo, intent.thanNo, intent.warehouse, userId);
        if (ttRes.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Transferred than ${intent.thanNo} from package ${intent.packageNo} (${fmtQty(ttRes.than.yards)} yds): ${ttRes.than.fromWarehouse} → ${intent.warehouse}`);
        } else {
          await bot.sendMessage(chatId, ttRes.message || 'Could not transfer.');
        }
        return;
      }

      case 'transfer_package': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Transfer package 5801 to Kano"'); return; }
        if (!intent.warehouse) { await bot.sendMessage(chatId, 'To which warehouse?'); return; }
        const tpInfo = await inventoryService.getPackageSummary(intent.packageNo);
        const tpFrom = tpInfo?.warehouse || '?';
        const tpDetail = `Transfer Package\nPackage: ${intent.packageNo}\nDesign: ${tpInfo?.design || '?'} ${tpInfo?.shade || ''}\nThans: ${tpInfo?.availableThans || '?'} available\nYards: ${tpInfo ? fmtQty(tpInfo.availableYards) : '?'}\nFrom: ${tpFrom}\nTo: ${intent.warehouse}`;
        const tpQueued = await requireApproval(bot, chatId, msg, userId, 'transfer_package',
          { action: 'transfer_package', packageNo: intent.packageNo, toWarehouse: intent.warehouse },
          tpDetail);
        if (tpQueued) return;
        const tpRes = await inventoryService.transferPackage(intent.packageNo, intent.warehouse, userId);
        if (tpRes.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Transferred package ${intent.packageNo}: ${tpRes.transferredThans} thans, ${fmtQty(tpRes.totalYards)} yds — ${tpRes.fromWarehouse} → ${intent.warehouse}`);
        } else {
          await bot.sendMessage(chatId, tpRes.message || 'Could not transfer.');
        }
        return;
      }

      case 'transfer_batch': {
        if (!intent.packageNos || !intent.packageNos.length) { await bot.sendMessage(chatId, 'Which packages? e.g. "Transfer packages 5801, 5802, 5803 to Kano"'); return; }
        if (!intent.warehouse) { await bot.sendMessage(chatId, 'To which warehouse?'); return; }
        let batchDetail = `Transfer Batch\nPackages: ${intent.packageNos.join(', ')}\nTo: ${intent.warehouse}\n\nDetails:\n`;
        let batchTotalThans = 0, batchTotalYards = 0;
        for (const pkgNo of intent.packageNos) {
          const pkgInfo = await inventoryService.getPackageSummary(pkgNo);
          if (pkgInfo) {
            batchDetail += `  Pkg ${pkgNo}: ${pkgInfo.design} ${pkgInfo.shade}, ${pkgInfo.availableThans} thans, ${fmtQty(pkgInfo.availableYards)} yds (from ${pkgInfo.warehouse})\n`;
            batchTotalThans += pkgInfo.availableThans;
            batchTotalYards += pkgInfo.availableYards;
          } else {
            batchDetail += `  Pkg ${pkgNo}: not found\n`;
          }
        }
        batchDetail += `\nTotal: ${batchTotalThans} thans, ${fmtQty(batchTotalYards)} yards`;
        const tbQueued = await requireApproval(bot, chatId, msg, userId, 'transfer_batch',
          { action: 'transfer_batch', packageNos: intent.packageNos, toWarehouse: intent.warehouse },
          batchDetail);
        if (tbQueued) return;
        const tbRes = await inventoryService.transferBatch(intent.packageNos, intent.warehouse, userId);
        let tbReply = `✅ Batch transfer to ${intent.warehouse}:\n`;
        tbRes.details.forEach((d) => {
          const icon = d.status === 'completed' ? '✅' : '⚠️';
          tbReply += `${icon} Pkg ${d.packageNo}: ${d.status === 'completed' ? `${d.transferredThans} thans, ${fmtQty(d.totalYards)} yds` : (d.message || d.status)}\n`;
        });
        tbReply += `\n*Total: ${tbRes.totalPackages} packages, ${tbRes.totalThans} thans, ${fmtQty(tbRes.totalYards)} yards*`;
        await sendLong(bot, chatId, tbReply, { parse_mode: 'Markdown' });
        return;
      }

      case 'add': {
        await bot.sendMessage(chatId, 'To add stock, use the CSV import or add data directly to the Inventory sheet. Bulk import: place CSV in the project folder and run the import script.');
        return;
      }

      case 'analyze': {
        const summary = await analytics.getAnalysisSummary(intent.design, intent.shade);
        await sendLong(bot, chatId, summary, { parse_mode: 'Markdown' });
        return;
      }

      case 'add_customer': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'Customer name is required. e.g. "Add customer Ibrahim, phone +234..."'); return; }
        const rawText = text;
        const phoneMatch = rawText.match(/phone\s+([+\d\s-]+)/i);
        const addressMatch = rawText.match(/address\s+([^,]+)/i);
        const catMatch = rawText.match(/\b(wholesale|retail)\b/i);
        const limitMatch = rawText.match(/credit\s*limit\s+(\d+)/i);
        const termsMatch = rawText.match(/\b(net\s*\d+|cod|credit)\b/i);
        const custData = {
          name: intent.customer,
          phone: phoneMatch ? phoneMatch[1].trim() : '',
          address: addressMatch ? addressMatch[1].trim() : '',
          category: catMatch ? catMatch[1] : 'Retail',
          credit_limit: limitMatch ? parseInt(limitMatch[1]) : 0,
          payment_terms: termsMatch ? termsMatch[1] : 'COD',
        };
        const acQueued = await requireApproval(bot, chatId, msg, userId, 'add_customer',
          { action: 'add_customer', ...custData },
          `Add customer ${intent.customer}`);
        if (acQueued) return;
        const res = await crmService.addCustomer(custData);
        if (res.status === 'exists') {
          await bot.sendMessage(chatId, `Customer "${res.customer.name}" already exists (${res.customer.customer_id}).`);
        } else {
          await bot.sendMessage(chatId, `✅ Customer "${res.customer.name}" created (${res.customer.customer_id}).`);
        }
        return;
      }

      case 'check_customer': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'Which customer? e.g. "Show customer Ibrahim"'); return; }
        const cust = await crmService.getCustomer(intent.customer);
        if (!cust) { await bot.sendMessage(chatId, `Customer "${intent.customer}" not found.`); return; }
        let r = `👤 *${cust.name}* (${cust.customer_id})\n`;
        r += `Category: ${cust.category} | Status: ${cust.status}\n`;
        if (cust.phone) r += `Phone: ${cust.phone}\n`;
        if (cust.address) r += `Address: ${cust.address}\n`;
        r += `Credit limit: ${fmtMoney(cust.credit_limit)}\n`;
        r += `Outstanding: ${fmtMoney(cust.outstanding_balance)}\n`;
        r += `Terms: ${cust.payment_terms}`;
        await bot.sendMessage(chatId, r, { parse_mode: 'Markdown' });
        return;
      }

      case 'check_balance': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'Which customer?'); return; }
        const cb = await crmService.getCustomer(intent.customer);
        if (!cb) { await bot.sendMessage(chatId, `Customer "${intent.customer}" not found.`); return; }
        await bot.sendMessage(chatId, `💰 ${cb.name}: Outstanding balance ${fmtMoney(cb.outstanding_balance)} (limit: ${fmtMoney(cb.credit_limit)})`);
        return;
      }

      case 'record_payment': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'From which customer?'); return; }
        const amt = intent.price;
        if (!amt || amt <= 0) { await bot.sendMessage(chatId, 'How much was paid? e.g. "Record payment 50000 from Ibrahim via bank"'); return; }
        const methodMatch = text.match(/\b(bank|cash|transfer)\b/i);
        const payMethod = methodMatch ? methodMatch[1] : 'cash';
        const rpQueued2 = await requireApproval(bot, chatId, msg, userId, 'record_payment',
          { action: 'record_payment', customer: intent.customer, amount: amt, method: payMethod },
          `Record payment ${fmtMoney(amt)} from ${intent.customer} via ${payMethod}`);
        if (rpQueued2) return;
        const payRes = await crmService.recordPayment({ customer: intent.customer, amount: amt, method: payMethod, userId });
        if (payRes.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Payment recorded: ${fmtMoney(payRes.paid)} from ${payRes.customer}.\nBalance: ${fmtMoney(payRes.previousBalance)} → ${fmtMoney(payRes.newBalance)}`);
        } else {
          await bot.sendMessage(chatId, payRes.message || 'Could not record payment.');
        }
        return;
      }

      case 'show_ledger': {
        if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Ledger access is admin-only.'); return; }
        const today = new Date().toISOString().split('T')[0];
        const entries = await accountingService.getDaybook(today);
        if (!entries.length) { await bot.sendMessage(chatId, `No ledger entries for ${today}.`); return; }
        let ledgerText = `📒 *Ledger — ${today}*\n\n`;
        entries.forEach((e) => {
          const dr = e.debit ? `DR ${fmtMoney(e.debit)}` : '';
          const cr = e.credit ? `CR ${fmtMoney(e.credit)}` : '';
          ledgerText += `${e.ledger_name}: ${dr}${cr} — ${e.narration}\n`;
        });
        await sendLong(bot, chatId, ledgerText, { parse_mode: 'Markdown' });
        return;
      }

      case 'trial_balance': {
        if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Trial balance is admin-only.'); return; }
        const tb = await accountingService.getTrialBalance();
        if (!tb.length) { await bot.sendMessage(chatId, 'No ledger entries yet.'); return; }
        let tbText = `📊 *Trial Balance*\n\n`;
        let totalDr = 0, totalCr = 0;
        tb.forEach((a) => {
          tbText += `${a.account_name}: DR ${fmtMoney(a.totalDebit)} | CR ${fmtMoney(a.totalCredit)}\n`;
          totalDr += a.totalDebit; totalCr += a.totalCredit;
        });
        tbText += `\n*Totals: DR ${fmtMoney(totalDr)} | CR ${fmtMoney(totalCr)}*`;
        await sendLong(bot, chatId, tbText, { parse_mode: 'Markdown' });
        return;
      }

      case 'add_bank': {
        if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Only admin can manage banks.'); return; }
        if (!intent.bankName) { await bot.sendMessage(chatId, 'Which bank? e.g. "Add bank GTBank"'); return; }
        const all = await settingsRepo.getAll();
        const banks = (all.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean);
        if (banks.map((b) => b.toLowerCase()).includes(intent.bankName.toLowerCase())) {
          await bot.sendMessage(chatId, `Bank "${intent.bankName}" already exists.`);
          return;
        }
        banks.push(intent.bankName);
        await settingsRepo.set('BANK_LIST', banks.join(','));
        await bot.sendMessage(chatId, `✅ Bank "${intent.bankName}" added. Banks: ${banks.join(', ')}`);
        return;
      }

      case 'remove_bank': {
        if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Only admin can manage banks.'); return; }
        if (!intent.bankName) { await bot.sendMessage(chatId, 'Which bank? e.g. "Remove bank GTBank"'); return; }
        const allS = await settingsRepo.getAll();
        let banksList = (allS.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean);
        const before = banksList.length;
        banksList = banksList.filter((b) => b.toLowerCase() !== intent.bankName.toLowerCase());
        if (banksList.length === before) { await bot.sendMessage(chatId, `Bank "${intent.bankName}" not found.`); return; }
        await settingsRepo.set('BANK_LIST', banksList.join(','));
        await bot.sendMessage(chatId, `✅ Bank "${intent.bankName}" removed. Banks: ${banksList.join(', ') || 'none'}`);
        return;
      }

      case 'list_banks': {
        const allB = await settingsRepo.getAll();
        const bankList = (allB.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean);
        await bot.sendMessage(chatId, bankList.length ? `Registered banks: ${bankList.join(', ')}` : 'No banks registered. Admin can add with "Add bank GTBank".');
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

*Inventory:*
📦 "How much 44200 BLACK do we have?"
📋 "Show packages for design 44200"
🔍 "Details of package 5801"
💰 "Sell than 3 from package 5801 to Ibrahim, salesperson Abdul, cash, date today"
📦 "Sell package 5802 to Adamu, salesperson Yarima, via GTBank"
📦 "Sell packages 5801, 5802 to Ibrahim, salesperson Abdul, cash"
↩️ "Return than 2 from package 5801"
🔄 "Transfer package 5801 to Kano"
🔄 "Transfer packages 5801, 5802 to Kano"
🔄 "Transfer than 3 from package 5801 to Kano"
💲 "Update price of 44200 BLACK to 1500"
📊 "Analyze stock"

*CRM:*
👤 "Add customer Ibrahim, phone +234..., wholesale"
🔍 "Show customer Ibrahim"
💰 "Record payment 50000 from Ibrahim via bank"
💳 "What is Ibrahim's outstanding?"

*Accounting (admin):*
📒 "Show ledger for today"
📊 "Show trial balance"
🏦 "Add bank GTBank" / "List banks" (admin)`;

}

/**
 * Start a sale flow: collect all required fields, then show summary for confirmation.
 */
async function startSaleFlow(bot, chatId, msg, userId, saleType, items, intent) {
  salesFlow.startSession(userId, saleType, items, intent);
  const session = salesFlow.getSession(userId);
  const missing = salesFlow.getMissingFields(session.collected);

  if (!missing.length) {
    session.awaitingConfirmation = true;
    sessionStore.set(userId, session);
    const summary = await salesFlow.buildSummary(session);
    const keyboard = { inline_keyboard: [[
      { text: '✅ Confirm', callback_data: `confirm_sale:${userId}` },
      { text: '❌ Cancel', callback_data: `cancel_sale:${userId}` },
    ]] };
    await bot.sendMessage(chatId, summary, { reply_markup: keyboard });
    return;
  }

  const payOpts = await salesFlow.getPaymentOptions();
  session.pendingField = missing[0];
  sessionStore.set(userId, session);
  await bot.sendMessage(chatId, salesFlow.getNextQuestion(missing[0], payOpts));
}

/**
 * Handle responses during an active sale flow session.
 */
async function handleSaleSession(bot, chatId, msg, userId, text, session) {
  if (text.toLowerCase() === 'cancel') {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, 'Sale cancelled.');
    return true;
  }

  if (!session.pendingField) return false;

  const validation = await salesFlow.validateField(session.pendingField, text);
  if (!validation.valid) {
    await bot.sendMessage(chatId, validation.message);
    return true;
  }

  session.collected[session.pendingField] = validation.value;
  session.pendingField = null;
  const missing = salesFlow.getMissingFields(session.collected);

  if (missing.length) {
    const payOpts = await salesFlow.getPaymentOptions();
    session.pendingField = missing[0];
    sessionStore.set(userId, session);
    await bot.sendMessage(chatId, salesFlow.getNextQuestion(missing[0], payOpts));
    return true;
  }

  session.awaitingConfirmation = true;
  sessionStore.set(userId, session);
  const summary = await salesFlow.buildSummary(session);
  const keyboard = { inline_keyboard: [[
    { text: '✅ Confirm', callback_data: `confirm_sale:${userId}` },
    { text: '❌ Cancel', callback_data: `cancel_sale:${userId}` },
  ]] };
  await bot.sendMessage(chatId, summary, { reply_markup: keyboard });
  return true;
}

/**
 * Execute a confirmed sale (after user taps Confirm).
 */
async function executeSale(bot, chatId, userId) {
  const session = salesFlow.getSession(userId);
  if (!session) return;
  const details = salesFlow.getSaleDetails(session);

  const sDate = details.salesDate || new Date().toISOString().split('T')[0];
  for (const item of session.items) {
    if (item.type === 'package') {
      const result = await inventoryService.sellPackage(item.packageNo, session.collected.customer, userId, sDate);
      if (result.status === 'approval_required') {
        const userLabel = userId;
        const info = await inventoryService.getPackageSummary(item.packageNo);
        const detailText = `Sale\nPackage: ${item.packageNo}\nDesign: ${info?.design || '?'} ${info?.shade || ''}\nCustomer: ${session.collected.customer}\nSalesperson: ${details.salesPerson}\nPayment: ${details.paymentMode}\nDate: ${details.salesDate}`;
        await approvalEvents.notifyAdminsApprovalRequest(bot, result.requestId, userLabel, detailText, result.reason);
        await bot.sendMessage(chatId, `⏳ Pkg ${item.packageNo}: needs admin approval. Request: ${result.requestId}`);
      } else if (result.status === 'completed') {
        await bot.sendMessage(chatId, `✅ Pkg ${item.packageNo}: sold ${result.soldThans} thans, ${fmtQty(result.soldYards)} yds to ${session.collected.customer}`);
      } else {
        await bot.sendMessage(chatId, `⚠️ Pkg ${item.packageNo}: ${result.message || 'failed'}`);
      }
    } else if (item.type === 'than') {
      const result = await inventoryService.sellThan(item.packageNo, item.thanNo, session.collected.customer, userId, sDate);
      if (result.status === 'approval_required') {
        const detailText = `Sale\nPackage: ${item.packageNo} Than: ${item.thanNo}\nCustomer: ${session.collected.customer}\nSalesperson: ${details.salesPerson}\nPayment: ${details.paymentMode}\nDate: ${details.salesDate}`;
        await approvalEvents.notifyAdminsApprovalRequest(bot, result.requestId, userId, detailText, result.reason);
        await bot.sendMessage(chatId, `⏳ Pkg ${item.packageNo} Than ${item.thanNo}: needs admin approval. Request: ${result.requestId}`);
      } else if (result.status === 'completed') {
        await bot.sendMessage(chatId, `✅ Pkg ${item.packageNo} Than ${item.thanNo}: sold ${fmtQty(result.than.yards)} yds to ${session.collected.customer}`);
      } else {
        await bot.sendMessage(chatId, `⚠️ Pkg ${item.packageNo} Than ${item.thanNo}: ${result.message || 'failed'}`);
      }
    }
  }
  sessionStore.clear(userId);
}

async function handleCallbackQuery(bot, callbackQuery) {
  const data = (callbackQuery.data || '').trim();
  if (data.startsWith('approve:')) {
    await approvalEvents.handleApprovalCallback(bot, callbackQuery, 'approve');
  } else if (data.startsWith('reject:')) {
    await approvalEvents.handleApprovalCallback(bot, callbackQuery, 'reject');
  } else if (data.startsWith('confirm_sale:')) {
    const saleUserId = data.replace('confirm_sale:', '');
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Processing sale...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id,
    });
    await executeSale(bot, callbackQuery.message.chat.id, saleUserId);
  } else if (data.startsWith('cancel_sale:')) {
    const cancelUserId = data.replace('cancel_sale:', '');
    sessionStore.clear(cancelUserId);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled.' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id,
    });
    await bot.sendMessage(callbackQuery.message.chat.id, 'Sale cancelled.');
  } else {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Unknown action.' });
  }
}

module.exports = { handleMessage, handleCallbackQuery };
