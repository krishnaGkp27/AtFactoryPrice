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
const queryEngine = require('../services/queryEngine');
const crmService = require('../services/crmService');
const accountingService = require('../services/accountingService');
const salesFlow = require('../services/salesFlowService');
const sessionStore = require('../utils/sessionStore');
const settingsRepo = require('../repositories/settingsRepository');
const usersRepository = require('../repositories/usersRepository');
const config = require('../config');

/** Resolve userId to display name: Users sheet name, then Telegram first_name/username, then ID. */
async function getRequesterDisplayName(userId, msgOrNull) {
  try {
    const u = await usersRepository.findByUserId(userId);
    if (u && u.name) return u.name;
  } catch (_) {}
  if (msgOrNull && msgOrNull.from) {
    if (msgOrNull.from.first_name) return msgOrNull.from.first_name;
    if (msgOrNull.from.username) return `@${msgOrNull.from.username}`;
  }
  return String(userId);
}

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
  const userLabel = await getRequesterDisplayName(userId, msg);
  await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, risk.reason);
  return true;
}

const CURRENCY = config.currency || 'NGN';

function fmtQty(n) { return Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 }); }
function fmtMoney(n) { return `${CURRENCY} ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`; }

/** Parse date string to YYYY-MM-DD for ledger range. Supports YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY. */
function parseLedgerDate(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  const ymd = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return null;
}

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

  // Industry-standard ledger commands (new architecture: LedgerTransactions + BalanceCache)
  const ledgerCommands = require('../commands/ledgerCommands');
  if (text.startsWith('/ledger ')) {
    try {
      await ledgerCommands.handleLedger(bot, chatId, userId, text.replace(/^\/ledger\s+/i, '').trim());
    } catch (e) {
      await bot.sendMessage(chatId, `Ledger error: ${e.message || 'Unknown error'}`);
    }
    return;
  }
  if (text.startsWith('/balance ')) {
    try {
      await ledgerCommands.handleBalance(bot, chatId, userId, text.replace(/^\/balance\s+/i, '').trim());
    } catch (e) {
      await bot.sendMessage(chatId, `Balance error: ${e.message || 'Unknown error'}`);
    }
    return;
  }
  if (text.startsWith('/payment ')) {
    try {
      await ledgerCommands.handlePayment(bot, chatId, userId, text.replace(/^\/payment\s+/i, '').trim());
    } catch (e) {
      await bot.sendMessage(chatId, `Payment error: ${e.message || 'Unknown error'}`);
    }
    return;
  }
  if (text.startsWith('/addledgercustomer ')) {
    try {
      await ledgerCommands.handleAddLedgerCustomer(bot, chatId, userId, text.replace(/^\/addledgercustomer\s+/i, '').trim());
    } catch (e) {
      await bot.sendMessage(chatId, `Add customer error: ${e.message || 'Unknown error'}`);
    }
    return;
  }

  // ─── Manufacturing commands (/mfg_*) ─────────────────────────────────────────
  const mfgCommands = require('../commands/manufacturingCommands');

  // Manufacturing guided flow: if user has an active mfg session, consume reply
  const mfgFlowHandled = await mfgCommands.handleFlowReply(bot, chatId, userId, text);
  if (mfgFlowHandled) return;

  // Manufacturing slash commands
  const MFG_STAGE_CMDS = { '/mfg_fabric': 'fabric', '/mfg_emb_out': 'emb_out', '/mfg_emb_in': 'emb_in', '/mfg_stitch': 'stitch', '/mfg_threadcut': 'threadcut', '/mfg_iron': 'iron', '/mfg_qc': 'qc', '/mfg_package': 'packaging' };
  for (const [cmd, stage] of Object.entries(MFG_STAGE_CMDS)) {
    if (text.toLowerCase().startsWith(cmd)) {
      try { await mfgCommands.handleStageCommand(bot, chatId, userId, stage, text.replace(new RegExp(`^${cmd.replace('/', '\\/')}\\s*`, 'i'), '').trim()); }
      catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
      return;
    }
  }
  if (text.startsWith('/mfg_approve_article')) {
    try { await mfgCommands.handleApproveArticle(bot, chatId, userId, text.replace(/^\/mfg_approve_article\s*/i, '').trim()); }
    catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
    return;
  }
  if (text === '/mfg_pending') {
    try { await mfgCommands.handlePending(bot, chatId, userId); }
    catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
    return;
  }
  if (text.startsWith('/mfg_status')) {
    try { await mfgCommands.handleStatus(bot, chatId, userId, text.replace(/^\/mfg_status\s*/i, '').trim()); }
    catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
    return;
  }
  if (text === '/mfg_pipeline') {
    try { await mfgCommands.handlePipeline(bot, chatId, userId); }
    catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
    return;
  }
  if (text.startsWith('/mfg_add_vendor')) {
    try { await mfgCommands.handleAddVendor(bot, chatId, userId, text.replace(/^\/mfg_add_vendor\s*/i, '').trim()); }
    catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
    return;
  }
  if (text.startsWith('/mfg_remove_vendor')) {
    try { await mfgCommands.handleRemoveVendor(bot, chatId, userId, text.replace(/^\/mfg_remove_vendor\s*/i, '').trim()); }
    catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
    return;
  }
  if (text.startsWith('/mfg_vendors')) {
    try { await mfgCommands.handleListVendors(bot, chatId, userId, text.replace(/^\/mfg_vendors\s*/i, '').trim()); }
    catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
    return;
  }
  if (text.startsWith('/mfg_rejections')) {
    try { await mfgCommands.handleRejections(bot, chatId, userId, text.replace(/^\/mfg_rejections\s*/i, '').trim()); }
    catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
    return;
  }

  // Post-approval enrichment: admin entering rate, payment mode, amount paid for a sale
  if (config.access.adminIds.includes(userId)) {
    const handled = await approvalEvents.handleEnrichmentMessage(bot, chatId, userId, text);
    if (handled) return;
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
        reply += `Available: ${stock.totalPackages} packages (${stock.totalThans} thans), ${fmtQty(stock.totalYards)} yards\n`;
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
        reply += `\n*Total: ${packages.length} packages, ${fmtQty(totalAvail)} yards*`;
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
        reply += `\n*Available: ${summary.availableThans} thans, ${fmtQty(summary.availableYards)} yds | Sold: ${summary.soldThans} thans, ${fmtQty(summary.soldYards)} yds*`;
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
          await bot.sendMessage(chatId, `✅ Returned package ${intent.packageNo}: 1 package (${retPkg.returnedThans} thans), ${fmtQty(retPkg.returnedYards)} yards — now available.`);
        } else {
          await bot.sendMessage(chatId, retPkg.message || 'Could not return.');
        }
        return;
      }

      case 'update_price': {
        if (!intent.price) { await bot.sendMessage(chatId, 'What is the new price per yard?'); return; }
        if (!intent.packageNo && !intent.design) { await bot.sendMessage(chatId, 'Which package or design? e.g. "Update price of 44200 BLACK to 1500" or "Set price for design 44200 at Kano to 1500"'); return; }
        const filters = {};
        if (intent.packageNo) filters.packageNo = intent.packageNo;
        if (intent.design) filters.design = intent.design;
        if (intent.shade) filters.shade = intent.shade;
        if (intent.warehouse) filters.warehouse = intent.warehouse;
        // Setting price by warehouse (design+warehouse) is admin-only
        if (filters.warehouse && !config.access.adminIds.includes(userId)) {
          await bot.sendMessage(chatId, 'Only admin can set price per warehouse. Use design and warehouse (e.g. Set price for design 44200 at Kano to 1500).');
          return;
        }
        const upQueued = await requireApproval(bot, chatId, msg, userId, 'update_price',
          { action: 'update_price', filters, price: intent.price },
          `Update price ${filters.design || filters.packageNo || '?'}${filters.warehouse ? ' at ' + filters.warehouse : ''} to ${intent.price}/yd`);
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
          await bot.sendMessage(chatId, `✅ Transferred package ${intent.packageNo}: 1 package (${tpRes.transferredThans} thans), ${fmtQty(tpRes.totalYards)} yds — ${tpRes.fromWarehouse} → ${intent.warehouse}`);
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
        batchDetail += `\nTotal: ${intent.packageNos.length} packages (${batchTotalThans} thans), ${fmtQty(batchTotalYards)} yards`;
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
        tbReply += `\n*Total: ${tbRes.totalPackages} packages (${tbRes.totalThans} thans), ${fmtQty(tbRes.totalYards)} yards*`;
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

      case 'report_stock': {
        await sendLong(bot, chatId, await queryEngine.stockSummary(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_valuation': {
        await sendLong(bot, chatId, await queryEngine.stockValuation(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_sales': {
        const period = intent.salesDate || 'all';
        await sendLong(bot, chatId, await queryEngine.salesReport(period), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_customers': {
        await sendLong(bot, chatId, await queryEngine.customerReport(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_warehouses': {
        await sendLong(bot, chatId, await queryEngine.warehouseSummary(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_fast_moving': {
        await sendLong(bot, chatId, await queryEngine.fastMovingReport(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_dead_stock': {
        await sendLong(bot, chatId, await queryEngine.deadStockReport(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_indents': {
        await sendLong(bot, chatId, await queryEngine.indentStatus(intent.design), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_low_stock': {
        await sendLong(bot, chatId, await queryEngine.lowStockAlert(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_aging': {
        await sendLong(bot, chatId, await queryEngine.agingStock(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_supply_by_design': {
        if (!intent.design || !String(intent.design).trim()) {
          await bot.sendMessage(chatId, 'Please specify a design, e.g. "Supply to customers for design 44200".');
          return;
        }
        const supplyReport = await queryEngine.supplyByCustomerByDesign(intent.design);
        await sendLong(bot, chatId, supplyReport, { parse_mode: 'Markdown' });
        return;
      }
      case 'report_sold': {
        const soldReportText = await queryEngine.soldReport(intent.warehouse, intent.customer, intent.salesDate || 'all');
        await sendLong(bot, chatId, soldReportText, { parse_mode: 'Markdown' });
        return;
      }
      case 'ask_data': {
        await bot.sendMessage(chatId, '🔍 Analyzing your data...');
        const answer = await queryEngine.freeFormQuery(text);
        await sendLong(bot, chatId, answer);
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
        const customer = intent.customer || (text.match(/ledger\s+for\s+(.+?)(?:\s+from\s|\s+to\s|$)/i) || [])[1];
        const fromMatch = text.match(/from\s+(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i);
        const toMatch = text.match(/to\s+(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i);
        let fromDate = intent.fromDate || (fromMatch && parseLedgerDate(fromMatch[1]));
        let toDate = intent.toDate || (toMatch && parseLedgerDate(toMatch[1]));
        if (!fromDate || !toDate) { fromDate = null; toDate = null; }
        if (customer && String(customer).trim()) {
          const custName = String(customer).trim();
          const { entries: custEntries, totalDebit, totalCredit, outstanding, outstandingAsOfToday } = await accountingService.getCustomerLedger(custName, fromDate, toDate);
          if (!custEntries.length) {
            await bot.sendMessage(chatId, fromDate && toDate
              ? `No ledger entries for "${custName}" between ${fromDate} and ${toDate}.`
              : `No ledger entries found for "${custName}".`);
            return;
          }
          const rangeLabel = fromDate && toDate ? ` (${fromDate} to ${toDate})` : '';
          let ledgerText = `📒 *Ledger for ${custName}${rangeLabel}*\n\n`;
          custEntries.forEach((e) => {
            const dr = e.debit ? `DR ${fmtMoney(e.debit)}` : '';
            const cr = e.credit ? `CR ${fmtMoney(e.credit)}` : '';
            ledgerText += `${e.date} | ${dr}${cr} | Bal ${fmtMoney(e.running)}\n  ${e.narration}\n`;
          });
          ledgerText += `\n*Total DR: ${fmtMoney(totalDebit)} | Total CR: ${fmtMoney(totalCredit)} | Outstanding (${fromDate && toDate ? 'end of range' : 'total'}): ${fmtMoney(outstanding)}*`;
          ledgerText += `\n*Outstanding as of today: ${fmtMoney(outstandingAsOfToday)}*`;
          await sendLong(bot, chatId, ledgerText, { parse_mode: 'Markdown' });
          return;
        }
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

      case 'report_last_transactions': {
        if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Only admin can view transactions.'); return; }
        const transactionsRepo = require('../repositories/transactionsRepository');
        const n = Math.min(parseInt(intent.price, 10) || 10, 30);
        let lastTxns = await transactionsRepo.getLast(Math.max(n, 50));
        const users = await usersRepository.getAll();
        const userById = new Map(users.map((u) => [String(u.user_id), u.name]));
        const userByName = new Map(users.map((u) => [u.name.toLowerCase(), u.user_id]));
        if (intent.customer && String(intent.customer).trim()) {
          const uid = userByName.get(String(intent.customer).trim().toLowerCase());
          if (uid) lastTxns = lastTxns.filter((t) => String(t.user) === String(uid));
          else lastTxns = lastTxns.filter((t) => (userById.get(String(t.user)) || '').toLowerCase().includes(String(intent.customer).toLowerCase()));
        }
        lastTxns = lastTxns.slice(0, n);
        if (!lastTxns.length) { await bot.sendMessage(chatId, intent.customer ? `No transactions found for "${intent.customer}".` : 'No transactions yet.'); return; }
        const escapeMd = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/\*/g, '\\*');
        let out = `📋 *Last ${lastTxns.length} transaction(s)${intent.customer ? ` for ${escapeMd(intent.customer)}` : ''}*\n\n`;
        lastTxns.forEach((t, i) => {
          const userName = userById.get(String(t.user)) || t.user || '—';
          const ts = (t.timestamp || '').toString().slice(0, 10);
          out += `${i + 1}. ${ts} | *${escapeMd(userName)}* | ${escapeMd(t.action)} | ${escapeMd(t.design || '')} ${escapeMd(t.color || '')} | Qty ${t.qty} | ${escapeMd(t.customerName || '')} | ${escapeMd(t.status)}\n`;
        });
        out += `\n_User column in sheet stores Telegram ID; here we show name from Users._`;
        await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
        return;
      }

      case 'revert_last_transaction': {
        if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Only admin can revert transactions.'); return; }
        const transactionsRepo = require('../repositories/transactionsRepository');
        const lastTxns = await transactionsRepo.getLast(1);
        if (!lastTxns.length) { await bot.sendMessage(chatId, 'No transactions to revert.'); return; }
        const t = lastTxns[0];
        if (t.status === 'reverted') { await bot.sendMessage(chatId, 'Last transaction is already reverted.'); return; }
        if (t.action !== 'sale_bundle' || !t.saleRefId) {
          await bot.sendMessage(chatId, `Last transaction is "${t.action}" (no SaleRefId). Only sale_bundle (approved sales) can be reverted.`);
          return;
        }
        const result = await inventoryService.revertSaleBundle(t.saleRefId, userId);
        if (!result.ok) {
          await bot.sendMessage(chatId, `Revert failed: ${result.message}`);
          return;
        }
        await transactionsRepo.setStatusReverted(t.timestamp, t.user, t.action);
        await bot.sendMessage(chatId, `✅ Last transaction reverted. ${result.revertedThans} thans marked available again; ledger reversed.`);
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

      case 'add_user': {
        if (!config.access.adminIds.includes(userId)) {
          await bot.sendMessage(chatId, 'Only admin can add users.');
          return;
        }
        const telegramId = intent.price != null ? String(Math.floor(Number(intent.price))) : null;
        const newUserName = intent.customer || intent.salesperson || '';
        if (!telegramId || telegramId === 'NaN' || !newUserName) {
          await bot.sendMessage(chatId, 'Usage: Add user <telegram_id> as <name>. Example: Add user 123456789 as Yarima. (Get Telegram ID from the user when they message the bot or from your logs.)');
          return;
        }
        const existing = await usersRepository.findByUserId(telegramId);
        if (existing) {
          await bot.sendMessage(chatId, `User with ID ${telegramId} already exists: ${existing.name}.`);
          return;
        }
        await usersRepository.append({
          user_id: telegramId,
          name: newUserName.trim(),
          role: 'employee',
          branch: '',
          access_level: 'branch_only',
          status: 'active',
        });
        await bot.sendMessage(chatId, `✅ User added: ${newUserName} (ID: ${telegramId}). You can now assign tasks to them.`);
        return;
      }

      case 'assign_task': {
        if (!config.access.adminIds.includes(userId)) {
          await bot.sendMessage(chatId, 'Only admins can assign tasks.');
          return;
        }
        const title = intent.taskTitle || intent.design || text.replace(/^assign\s+task\s+/i, '').trim();
        const assigneeName = intent.customer;
        if (!title || !assigneeName) {
          await bot.sendMessage(chatId, 'Please specify task title and assignee. Example: "Assign task Deliver order to Abdul".');
          return;
        }
        const tasksRepo = require('../repositories/tasksRepository');
        const users = await usersRepository.getAll();
        const assignee = users.find((u) => u.name.toLowerCase() === assigneeName.toLowerCase());
        if (!assignee) {
          await bot.sendMessage(chatId, `User "${assigneeName}" not found in Users. Add them first.`);
          return;
        }
        const created = await tasksRepo.append({ title, description: '', assigned_to: assignee.user_id, assigned_by: userId, status: 'pending' });
        await bot.sendMessage(chatId, `✅ Task assigned: "${title}" to ${assignee.name} (ID: ${created.task_id}). They can view with "My tasks" and mark done when finished.`);
        return;
      }

      case 'my_tasks': {
        const tasksRepo = require('../repositories/tasksRepository');
        const list = await tasksRepo.getByAssignedTo(userId);
        if (!list.length) {
          await bot.sendMessage(chatId, 'You have no assigned tasks.');
          return;
        }
        let out = '📋 *Your tasks*\n\n';
        for (const t of list) {
          const statusLabel = t.status === 'completed' ? '✅' : t.status === 'submitted' ? '⏳ (pending admin approval)' : '📌';
          out += `${statusLabel} ${t.task_id}: ${t.title}\n  Status: ${t.status}${t.completed_at ? `, completed ${t.completed_at.slice(0, 10)}` : ''}\n\n`;
        }
        out += 'To mark a task done, say: "Mark task <task_id> done" (e.g. Mark task ' + list[0].task_id + ' done)';
        await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
        return;
      }

      case 'add_contact': {
        const name = intent.customer || intent.salesperson || '';
        const typeMatch = text.match(/\b(worker|customer|agent|supplier|other)\b/i);
        const contactType = (intent.design && /^(worker|customer|agent|supplier|other)$/i.test(intent.design)) ? intent.design : (typeMatch ? typeMatch[1] : 'other');
        const phoneMatch = text.match(/phone\s*[:\s]*([+\d\s\-]+)/i) || text.match(/(\+\d[\d\s\-]+)/);
        const phone = phoneMatch ? phoneMatch[1].trim() : '';
        const addressMatch = text.match(/address\s*[:\s]*([^,]+)/i);
        const address = addressMatch ? addressMatch[1].trim() : '';
        const notesMatch = text.match(/notes?\s*[:\s]*([^,]+)/i);
        const notes = notesMatch ? notesMatch[1].trim() : '';
        if (!name) {
          await bot.sendMessage(chatId, 'Please provide contact name and type. Example: "Add contact Ibrahim, worker, phone +2348012345678, address Kano".');
          return;
        }
        const actionJSON = { action: 'add_contact', name, phone, type: contactType, address, notes };
        const summary = `Add contact: ${name} (${contactType})${phone ? ', ' + phone : ''}${address ? ', ' + address : ''}`;
        const addContactQueued = await requireApproval(bot, chatId, msg, userId, 'add_contact', actionJSON, summary);
        if (addContactQueued) return;
        const contactsRepo = require('../repositories/contactsRepository');
        await contactsRepo.append({ name, phone, type: contactType, address, notes });
        await bot.sendMessage(chatId, `✅ Contact added: ${name} (${contactType})${phone ? ', ' + phone : ''}.`);
        return;
      }

      case 'list_contacts': {
        const contactsRepo = require('../repositories/contactsRepository');
        const filterType = intent.design && /^(worker|customer|agent|supplier|other)$/i.test(intent.design) ? intent.design : null;
        const list = filterType ? await contactsRepo.getByType(filterType) : await contactsRepo.getAll();
        if (!list.length) {
          await bot.sendMessage(chatId, filterType ? `No ${filterType} contacts.` : 'Phonebook is empty.');
          return;
        }
        let out = filterType ? `📇 *${filterType} contacts*\n\n` : '📇 *Phonebook*\n\n';
        list.slice(0, 30).forEach((c) => { out += `${c.name} (${c.type})${c.phone ? ' — ' + c.phone : ''}\n`; });
        if (list.length > 30) out += `\n... and ${list.length - 30} more.`;
        await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
        return;
      }

      case 'search_contact': {
        const q = intent.customer || text.replace(/find|in phonebook|search/gi, '').trim();
        if (!q) {
          await bot.sendMessage(chatId, 'Who do you want to find? Example: "Find Ibrahim in phonebook".');
          return;
        }
        const contactsRepo = require('../repositories/contactsRepository');
        const found = await contactsRepo.searchByName(q);
        if (!found.length) {
          await bot.sendMessage(chatId, `No contact found for "${q}".`);
          return;
        }
        let out = `📇 *Contacts matching "${q}"*\n\n`;
        found.forEach((c) => { out += `${c.name} — ${c.type}${c.phone ? ', ' + c.phone : ''}${c.address ? ', ' + c.address : ''}\n`; });
        await bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });
        return;
      }

      case 'mark_task_done': {
        const taskId = intent.taskId || (text.match(/TASK-\d{8}-\d{3}/) || [])[0];
        if (!taskId) {
          await bot.sendMessage(chatId, 'Please specify task ID. Example: "Mark task TASK-20260224-001 done".');
          return;
        }
        const tasksRepo = require('../repositories/tasksRepository');
        const task = await tasksRepo.getById(taskId);
        if (!task) {
          await bot.sendMessage(chatId, `Task ${taskId} not found.`);
          return;
        }
        if (task.assigned_to !== userId) {
          await bot.sendMessage(chatId, 'You can only mark your own tasks as done.');
          return;
        }
        if (task.status === 'completed') {
          await bot.sendMessage(chatId, 'This task is already completed.');
          return;
        }
        await tasksRepo.updateStatus(taskId, 'submitted', new Date().toISOString());
        const requesterName = await getRequesterDisplayName(userId, msg);
        const esc = (s) => (s || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
        const notifText = `📋 *Task submitted for approval*\n\nTask: ${esc(task.title)}\nID: \`${taskId}\`\nMarked done by: ${esc(requesterName)}\n\nApprove to mark as complete for the employee\\.`;
        const keyboard = { inline_keyboard: [[{ text: '✅ Approve completion', callback_data: `approve_task:${taskId}` }]] };
        for (const adminId of config.access.adminIds) {
          try {
            await bot.sendMessage(adminId, notifText, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
          } catch (e) {
            try { await bot.sendMessage(adminId, `Task submitted: ${task.title} (${taskId}) by ${requesterName}. Approve completion?`, { reply_markup: keyboard }); } catch (_) {}
          }
        }
        await bot.sendMessage(chatId, `⏳ Task "${task.title}" submitted for admin approval. You'll be notified when it's approved.`);
        return;
      }

      // ─── Manufacturing intents (natural language → guided flow) ───────────
      case 'mfg_fabric':
      case 'mfg_emb_out':
      case 'mfg_emb_in':
      case 'mfg_stitch':
      case 'mfg_threadcut':
      case 'mfg_iron':
      case 'mfg_qc':
      case 'mfg_package': {
        const STAGE_MAP = { 'package': 'packaging' };
        const stageName = STAGE_MAP[intent.action.replace('mfg_', '')] || intent.action.replace('mfg_', '');
        const artNo = intent.articleNo;
        if (!artNo) { await bot.sendMessage(chatId, 'Which article? e.g. "Update fabric for ART-001"'); return; }
        try { await mfgCommands.handleStageCommand(bot, chatId, userId, stageName, artNo); }
        catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
        return;
      }
      case 'mfg_approve_article': {
        if (!intent.articleNo) { await bot.sendMessage(chatId, 'Which article? e.g. "Approve article ART-001"'); return; }
        try { await mfgCommands.handleApproveArticle(bot, chatId, userId, intent.articleNo); }
        catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
        return;
      }
      case 'mfg_pending': {
        try { await mfgCommands.handlePending(bot, chatId, userId); }
        catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
        return;
      }
      case 'mfg_status': {
        if (!intent.articleNo) { await bot.sendMessage(chatId, 'Which article? e.g. "Status of ART-001"'); return; }
        try { await mfgCommands.handleStatus(bot, chatId, userId, intent.articleNo); }
        catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
        return;
      }
      case 'mfg_pipeline': {
        try { await mfgCommands.handlePipeline(bot, chatId, userId); }
        catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
        return;
      }
      case 'mfg_add_vendor': {
        const vArgs = [intent.vendorType || '', intent.vendorCode || '', intent.vendorName || ''].join(' ').trim();
        try { await mfgCommands.handleAddVendor(bot, chatId, userId, vArgs); }
        catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
        return;
      }
      case 'mfg_remove_vendor': {
        const rvArgs = [intent.vendorType || '', intent.vendorCode || ''].join(' ').trim();
        try { await mfgCommands.handleRemoveVendor(bot, chatId, userId, rvArgs); }
        catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
        return;
      }
      case 'mfg_vendors': {
        try { await mfgCommands.handleListVendors(bot, chatId, userId, intent.vendorType || ''); }
        catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
        return;
      }
      case 'mfg_rejections': {
        try { await mfgCommands.handleRejections(bot, chatId, userId, intent.articleNo || ''); }
        catch (e) { await bot.sendMessage(chatId, `MFG error: ${e.message}`); }
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

*Reports:*
📦 "Stock summary" / "Stock valuation"
📊 "Sales report today" / "Sales this week"
👥 "Customer report" / "Top customers"
🏭 "Warehouse summary" / "Compare warehouses"
🔥 "Fast moving designs" / "Dead stock"
📋 "Indent status" / "Low stock alert"
📅 "Aging stock"
🔍 Ask anything: "Show all buyers of 44200 in descending order"

*CRM:*
👤 "Add customer Ibrahim, phone +234..., wholesale"
🔍 "Show customer Ibrahim"
💰 "Record payment 50000 from Ibrahim via bank"
💳 "What is Ibrahim's outstanding?"

*Accounting (admin):*
📒 "Show ledger for today"
📊 "Show trial balance"
🏦 "Add bank GTBank" / "List banks" (admin)

*Ledger commands (admin, Ledger_Customers):*
/addledgercustomer <name> [phone] [credit_limit]
/ledger <customer_id> — Customer ledger (paginated)
/balance <customer_id> — Current balance
/payment <customer_id> <amount> — Record payment

*Manufacturing (stage updates):*
/mfg_fabric <article_no> — Fabric & cutting
/mfg_emb_out <article_no> — Dispatch to EMB
/mfg_emb_in <article_no> — Receive from EMB
/mfg_stitch <article_no> — Stitching
/mfg_threadcut <article_no> — Thread cutting
/mfg_iron <article_no> — Ironing
/mfg_qc <article_no> — Quality check
/mfg_package <article_no> — Final packaging

*Manufacturing (admin):*
/mfg_approve_article <article_no>
/mfg_pending — Pending approvals
/mfg_status <article_no> — Article status
/mfg_pipeline — All in-progress articles
/mfg_add_vendor <fabric|emb> <code> <name>
/mfg_remove_vendor <fabric|emb> <code>
/mfg_vendors [fabric|emb]
/mfg_rejections [article_no]`;

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

  if (session.pendingNewCustomer) {
    if (session.pendingField === 'new_customer_name') {
      session.collected.newCustomerName = text.trim();
      session.pendingField = 'new_customer_phone';
      sessionStore.set(userId, session);
      await bot.sendMessage(chatId, 'Phone number?');
      return true;
    }
    if (session.pendingField === 'new_customer_phone') {
      session.collected.newCustomerPhone = text.trim();
      session.pendingField = 'new_customer_address';
      sessionStore.set(userId, session);
      await bot.sendMessage(chatId, 'Address? (or type Skip)');
      return true;
    }
    if (session.pendingField === 'new_customer_address') {
      session.collected.newCustomerAddress = text.trim().toLowerCase() === 'skip' ? '' : text.trim();
      const name = session.collected.newCustomerName;
      try {
        await crmService.addCustomer({
          name,
          phone: session.collected.newCustomerPhone || '',
          address: session.collected.newCustomerAddress || '',
          category: 'Retail',
          credit_limit: 0,
          payment_terms: 'COD',
        });
      } catch (e) {
        await bot.sendMessage(chatId, `Could not add customer: ${e.message}. Try again or use existing customer.`);
        return true;
      }
      session.collected.customer = name;
      delete session.collected.newCustomerName;
      delete session.collected.newCustomerPhone;
      delete session.collected.newCustomerAddress;
      session.pendingNewCustomer = false;
      session.pendingField = null;
      const missing = salesFlow.getMissingFields(session.collected);
      if (missing.length) {
        const payOpts = await salesFlow.getPaymentOptions();
        session.pendingField = missing[0];
        sessionStore.set(userId, session);
        await bot.sendMessage(chatId, `✅ Customer "${name}" added.\n\n${salesFlow.getNextQuestion(missing[0], payOpts)}`);
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
  }

  const validation = await salesFlow.validateField(session.pendingField, text);
  if (!validation.valid) {
    if (validation.message === '__NEW_CUSTOMER__') {
      session.pendingNewCustomer = true;
      session.pendingField = 'new_customer_name';
      sessionStore.set(userId, session);
      await bot.sendMessage(chatId, 'Enter new customer full name.');
      return true;
    }
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
 * Execute a confirmed sale: if admin, execute directly in batch.
 * If employee, create ONE consolidated approval request for the entire sale.
 */
async function executeSale(bot, chatId, userId) {
  const session = salesFlow.getSession(userId);
  if (!session) return;
  const details = salesFlow.getSaleDetails(session);
  const sDate = details.salesDate || new Date().toISOString().split('T')[0];

  const risk = await riskEvaluate.evaluate({ action: 'sell_batch', userId });

  if (risk.risk === 'approval_required') {
    // Create ONE approval request for the entire sale
    const requestId = genId();
    let detailText = `Sale Request\nCustomer: ${session.collected.customer}`;
    try {
      const cust = await crmService.getCustomer(session.collected.customer);
      if (cust && (cust.phone || cust.address)) {
        if (cust.phone) detailText += `\nPhone: ${cust.phone}`;
        if (cust.address) detailText += `\nAddress: ${cust.address}`;
      }
    } catch (_) {}
    detailText += `\nSalesperson: ${details.salesPerson}\nPayment: ${details.paymentMode}\nDate: ${sDate}\n\nItems:\n`;
    let totalYards = 0, totalThans = 0;
    for (const item of session.items) {
      const info = await inventoryService.getPackageSummary(item.packageNo);
      if (item.type === 'package' && info) {
        detailText += `  Pkg ${item.packageNo}: ${info.design} ${info.shade}, ${info.availableThans} thans, ${fmtQty(info.availableYards)} yds (${info.warehouse})\n`;
        totalThans += info.availableThans;
        totalYards += info.availableYards;
      } else if (item.type === 'than' && info) {
        const t = info.thans?.find((th) => th.thanNo === item.thanNo);
        detailText += `  Pkg ${item.packageNo} Than ${item.thanNo}: ${info.design} ${info.shade}, ${t ? fmtQty(t.yards) + ' yds' : '?'} (${info.warehouse})\n`;
        totalThans += 1;
        totalYards += t ? t.yards : 0;
      }
    }
    const totalPkgs = new Set(session.items.map((i) => i.packageNo)).size;
    detailText += `\nTotal: ${totalPkgs} packages (${totalThans} thans), ${fmtQty(totalYards)} yards`;

    await approvalQueueRepository.append({
      requestId, user: userId,
      actionJSON: { action: 'sale_bundle', items: session.items, customer: session.collected.customer, salesDate: sDate, salesPerson: details.salesPerson, paymentMode: details.paymentMode },
      riskReason: risk.reason, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);

    const userLabel = await getRequesterDisplayName(userId, null);
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, detailText, risk.reason);
    await bot.sendMessage(chatId, `⏳ Sale submitted for admin approval. Request: ${requestId}\n${totalPkgs} packages (${totalThans} thans), ${fmtQty(totalYards)} yards to ${session.collected.customer}`);
    sessionStore.clear(userId);
    return;
  }

  // Admin: execute all items directly in sequence
  let soldThans = 0, totalYards = 0;
  const soldPkgs = new Set();
  for (const item of session.items) {
    if (item.type === 'package') {
      const result = await inventoryService.sellPackage(item.packageNo, session.collected.customer, userId, sDate);
      if (result.status === 'completed') { soldThans += result.soldThans; totalYards += result.soldYards; soldPkgs.add(item.packageNo); }
    } else if (item.type === 'than') {
      const result = await inventoryService.sellThan(item.packageNo, item.thanNo, session.collected.customer, userId, sDate);
      if (result.status === 'completed') { soldThans += 1; totalYards += result.than?.yards || 0; soldPkgs.add(item.packageNo); }
    }
  }
  await bot.sendMessage(chatId, `✅ Sale complete: ${soldPkgs.size} packages (${soldThans} thans), ${fmtQty(totalYards)} yards to ${session.collected.customer}`);
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
  } else if (data.startsWith('approve_task:')) {
    const taskId = data.replace('approve_task:', '');
    const adminId = String(callbackQuery.from.id);
    if (!config.access.adminIds.includes(adminId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only admins can approve task completion.' });
      return;
    }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Approving...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id,
    });
    const tasksRepo = require('../repositories/tasksRepository');
    const task = await tasksRepo.getById(taskId);
    if (!task) {
      await bot.sendMessage(callbackQuery.message.chat.id, `Task ${taskId} not found.`);
      return;
    }
    await tasksRepo.updateStatus(taskId, 'completed', new Date().toISOString());
    await bot.sendMessage(callbackQuery.message.chat.id, `✅ Task "${task.title}" (${taskId}) marked complete. Employee has been notified.`);
    try {
      await bot.sendMessage(task.assigned_to, `✅ Your task "${task.title}" (${taskId}) has been approved by admin and marked complete.`);
    } catch (_) {}
  } else if (data.startsWith('mfg_approve:') || data.startsWith('mfg_reject:')) {
    const mfgCommands = require('../commands/manufacturingCommands');
    const mfgAction = data.startsWith('mfg_approve:') ? 'approve' : 'reject';
    await mfgCommands.handleApprovalCallback(bot, callbackQuery, mfgAction);
  } else {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Unknown action.' });
  }
}

module.exports = { handleMessage, handleCallbackQuery };
