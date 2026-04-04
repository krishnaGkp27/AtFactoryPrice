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
const usersRepository = require('../repositories/usersRepository');
const driveClient = require('../repositories/driveClient');
const fmtDate = require('../utils/formatDate');

const SALE_ACTIONS = ['sell_than', 'sell_package', 'sale_bundle'];
const DEFAULT_SALE_UNIT = 'yard';

const pendingEnrichment = new Map();

/**
 * Send a notification to the employee who raised the request.
 * Uses direct ID lookup (getByRequestId) as primary, falls back to provided userId.
 * Logs failures instead of silently swallowing them.
 */
async function notifyEmployee(bot, requestingUser, requestId, message) {
  let userId = requestingUser;
  if (!userId) {
    try {
      const row = await approvalQueueRepository.getByRequestId(requestId);
      if (row && row.user) userId = row.user;
    } catch (e) {
      logger.error(`notifyEmployee: failed to look up user for request ${requestId}`, e.message);
    }
  }
  if (!userId) {
    logger.warn(`notifyEmployee: no user ID found for request ${requestId} — cannot notify employee`);
    return false;
  }
  try {
    await bot.sendMessage(userId, message);
    return true;
  } catch (e) {
    logger.error(`notifyEmployee: failed to send message to user ${userId} for request ${requestId}`, e.message);
    return false;
  }
}

/** Resolve the approval queue item and requesting user, with fallback. */
async function resolveRequest(requestId) {
  let item = null;
  let requestingUser = null;
  try {
    item = await approvalQueueRepository.getByRequestId(requestId);
    if (item) requestingUser = item.user;
  } catch (e) {
    logger.error(`resolveRequest: failed to fetch request ${requestId}`, e.message);
  }
  if (!item) {
    try {
      const pending = await approvalQueueRepository.getAllPending();
      item = pending.find((p) => p.requestId === requestId);
      if (item) requestingUser = item.user;
    } catch (e) {
      logger.error(`resolveRequest: fallback getAllPending also failed for ${requestId}`, e.message);
    }
  }
  return { item, requestingUser };
}

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

async function startApprovalEnrichment(bot, adminId, chatId, requestId, item, requestingUser) {
  const designs = await getDesignsForSale(item);
  const unit = DEFAULT_SALE_UNIT;
  pendingEnrichment.set(adminId, {
    requestId, step: 'rate', item, requestingUser, designs, unit,
  });
  const designList = designs.length ? designs.join(', ') : 'this item';
  await bot.sendMessage(chatId, `📋 *Confirm sale details*\n\nDesign(s): ${designList}\nUnit: ${unit} (Naira per ${unit})\n\n*Step 1 — Rate:* Reply with rate per ${unit}.\n• Single design: e.g. \`1500\`\n• Multiple: e.g. \`44200:1500, 44201:1200\``);
}

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

async function uploadSaleDocToDrive(bot, item, requestId) {
  const aj = item?.actionJSON || {};
  if (!aj.sale_doc_file_id) return null;
  try {
    const file = await bot.getFile(aj.sale_doc_file_id);
    const url = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
    const https = require('https');
    const buffer = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
    const ext = file.file_path.split('.').pop() || (aj.sale_doc_type === 'document' ? 'pdf' : 'jpg');
    const customer = (aj.customer || 'unknown').replace(/\s+/g, '_');
    const fileName = `sale_bill_${customer}_${requestId.slice(0, 12)}.${ext}`;
    const mimeType = aj.sale_doc_type === 'document' ? 'application/pdf' : 'image/jpeg';
    return await driveClient.uploadFile(buffer, fileName, mimeType);
  } catch (e) {
    logger.error(`Failed to upload sale doc for ${requestId}`, e.message);
    return null;
  }
}

async function runApprovedSaleWithEnrichment(bot, chatId, adminId, requestId, item, requestingUser, enrichment, fmt) {
  try {
    const result = await inventoryService.executeApprovedAction(requestId, adminId, enrichment);
    if (result.ok) {
      let driveInfo = null;
      try { driveInfo = await uploadSaleDocToDrive(bot, item, requestId); } catch (_) {}
      let msg = `✅ Request ${requestId} approved. Sale and ledger updated.`;
      if (driveInfo) msg += `\n📎 [View Sales Bill](${driveInfo.webViewLink})`;
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
      await notifyEmployee(bot, requestingUser, requestId, `✅ Your request (${requestId}) has been approved by admin. Sale and ledger updated.`);
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
      await notifyEmployee(bot, requestingUser, requestId, `⚠️ Your request (${requestId}) was approved but could not be completed. Admin has been notified. Please follow up.`);
    }
  } catch (e) {
    logger.error('Enrichment execution error', e);
    await bot.sendMessage(chatId, `⚠️ Error: ${e.message}`);
    await notifyEmployee(bot, requestingUser, requestId, `⚠️ Your request (${requestId}) encountered an error during processing. Admin has been notified. Please follow up.`);
  }
}

async function notifyAdminsApprovalRequest(bot, requestId, userLabel, actionSummary, riskReason, excludeUserId) {
  const esc = (s) => (s || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  const text = `🔔 *Approval required*\n\nRequest ID: \`${requestId}\`\nUser: ${esc(userLabel)}\nAction: ${esc(actionSummary)}\nReason: ${esc(riskReason)}\n\nUse buttons below to approve or reject\\.`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '✅ Approve', callback_data: `approve:${requestId}` }, { text: '❌ Reject', callback_data: `reject:${requestId}` }],
    ],
  };
  for (const adminId of config.access.adminIds) {
    if (excludeUserId && String(adminId) === String(excludeUserId)) continue;
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

async function handleApprovalCallback(bot, callbackQuery, action) {
  const data = callbackQuery.data || '';
  const requestId = data.replace(/^(approve|reject):/, '');
  const adminId = String(callbackQuery.from.id);
  if (!config.access.adminIds.includes(adminId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only admins can approve.' });
    return;
  }

  const { item, requestingUser } = await resolveRequest(requestId);

  const chatIdCb = callbackQuery.message.chat.id;
  const msgIdCb = callbackQuery.message.message_id;

  try {
    if (action === 'approve') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Approving...' });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatIdCb, message_id: msgIdCb });

      const isNewCustomer = item && item.actionJSON && item.actionJSON.action === 'new_customer';
      if (isNewCustomer) {
        await handleNewCustomerApproval(bot, chatIdCb, requestId, item, requestingUser, true);
        return;
      }

      const isSupplyReq = item && item.actionJSON && item.actionJSON.action === 'supply_request';
      if (isSupplyReq) {
        await showWarehouseBoyPicker(bot, chatIdCb, requestId, item, requestingUser);
        return;
      }

      const isSale = item && item.actionJSON && SALE_ACTIONS.includes(item.actionJSON.action);
      if (isSale) {
        await startApprovalEnrichment(bot, adminId, chatIdCb, requestId, item, requestingUser);
        return;
      }

      const result = await inventoryService.executeApprovedAction(requestId, adminId);
      if (result.ok) {
        await bot.sendMessage(chatIdCb, `✅ Request ${requestId} approved. Changes applied.`);
        await notifyEmployee(bot, requestingUser, requestId, `✅ Your request (${requestId}) has been approved by admin. Changes applied.`);
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
        await notifyEmployee(bot, requestingUser, requestId, `⚠️ Your request (${requestId}) was approved but could not be completed. Admin has been notified. Please follow up.`);
      }
    } else {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Rejecting...' });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatIdCb, message_id: msgIdCb });

      const isNewCustReject = item && item.actionJSON && item.actionJSON.action === 'new_customer';
      if (isNewCustReject) {
        await handleNewCustomerApproval(bot, chatIdCb, requestId, item, requestingUser, false);
        return;
      }

      const result = await inventoryService.rejectApproval(requestId, adminId);
      if (result.ok) {
        await bot.sendMessage(chatIdCb, `❌ Request ${requestId} rejected.`);
        await notifyEmployee(bot, requestingUser, requestId, `❌ Your request (${requestId}) has been rejected by admin.`);
      } else {
        await bot.sendMessage(chatIdCb, `⚠️ Rejection failed: ${result.message || 'Unknown error'}`);
      }
    }
  } catch (e) {
    logger.error('Approval callback error', e);
    try { await bot.sendMessage(chatIdCb, `⚠️ Error processing request ${requestId}: ${e.message}`); } catch (_) {}
    await notifyEmployee(bot, requestingUser, requestId, `⚠️ Your request (${requestId}) encountered an error during processing. Admin has been notified. Please follow up.`);
  }
}

async function showWarehouseBoyPicker(bot, chatId, requestId, item, requestingUser) {
  const aj = item?.actionJSON || {};
  const warehouse = aj.warehouse || '';
  const allUsers = await usersRepository.getAll();
  const dispatchUsers = allUsers.filter((u) => {
    const dept = (u.department || '').toLowerCase();
    const whs = u.warehouses || [];
    return (dept === 'dispatch' || dept === 'warehouse' || dept === 'logistics')
      && (!warehouse || whs.includes(warehouse));
  });

  const productTypesRepo = require('../repositories/productTypesRepository');
  const labels = await productTypesRepo.getLabels(aj.productType || 'fabric');
  const cShort = labels.container_short;
  const cartLines = (aj.cart || []).map((ci) => {
    const m = productTypesRepo.getMaterialInfo(ci.design);
    return `${m.icon} ${ci.design} [${m.name}] │ Shade: ${ci.shade} │ ×${ci.quantity} ${cShort}`;
  }).join('\n');
  const totalQty = (aj.cart || []).reduce((s, c) => s + c.quantity, 0);
  const containerPlural = productTypesRepo.pluralize(labels.container_label, totalQty).toLowerCase();
  let summary = `✅ Supply request approved.\n\n`;
  summary += `🏭 Warehouse: ${warehouse}\n`;
  summary += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  summary += `${cartLines}\n`;
  summary += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  summary += `📦 Total: ${totalQty} ${containerPlural}\n`;
  summary += `👤 Customer: ${aj.customer || '-'}\n`;
  summary += `📅 Date: ${fmtDate(aj.salesDate)}\n\n`;
  summary += `Assign to a warehouse boy:`;

  if (!dispatchUsers.length) {
    const allWithWh = allUsers.filter((u) => (u.warehouses || []).includes(warehouse));
    const fallback = allWithWh.length ? allWithWh : allUsers;
    const rows = fallback.map((u) => [{
      text: `🧑 ${u.name || u.user_id}`,
      callback_data: `srf_assign:${requestId}|${u.user_id}`,
    }]);
    await bot.sendMessage(chatId, summary, { reply_markup: { inline_keyboard: rows } });
    return;
  }

  const rows = dispatchUsers.map((u) => [{
    text: `🧑 ${u.name || u.user_id}`,
    callback_data: `srf_assign:${requestId}|${u.user_id}`,
  }]);
  await bot.sendMessage(chatId, summary, { reply_markup: { inline_keyboard: rows } });
}

async function handleSupplyAssign(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  const [requestId, assigneeId] = data.replace('srf_assign:', '').split('|');
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;

  if (!config.access.adminIds.includes(adminId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' });
    return;
  }
  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Assigning...' });
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

  const { item, requestingUser } = await resolveRequest(requestId);
  if (!item) {
    await bot.sendMessage(chatId, `⚠️ Request ${requestId} not found.`);
    return;
  }

  await approvalQueueRepository.updateStatus(requestId, 'approved', new Date().toISOString());

  const aj = item.actionJSON || {};
  const productTypesRepo = require('../repositories/productTypesRepository');
  const labels = await productTypesRepo.getLabels(aj.productType || 'fabric');
  const cShort = labels.container_short;
  const cartLines = (aj.cart || []).map((ci) => {
    const m = productTypesRepo.getMaterialInfo(ci.design);
    return `${m.icon} ${ci.design} [${m.name}] │ Shade: ${ci.shade} │ ×${ci.quantity} ${cShort}`;
  }).join('\n');
  const totalQty = (aj.cart || []).reduce((s, c) => s + c.quantity, 0);
  const containerPlural = productTypesRepo.pluralize(labels.container_label, totalQty).toLowerCase();
  let intimation = `📦 *New Supply Assignment*\n\n`;
  intimation += `🏭 Warehouse: *${aj.warehouse || '-'}*\n`;
  intimation += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  intimation += `${cartLines}\n`;
  intimation += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  intimation += `📦 Total: *${totalQty} ${containerPlural}*\n\n`;
  intimation += `👤 Customer: *${aj.customer || '-'}*\n`;
  intimation += `🧑 Salesperson: *${aj.salesperson || '-'}*\n`;
  intimation += `💳 Payment: *${aj.paymentMode || '-'}*\n`;
  intimation += `📅 Date: *${fmtDate(aj.salesDate)}*\n`;
  intimation += `\n🔔 Assigned by admin. Tap below to acknowledge.`;

  try {
    await bot.sendMessage(assigneeId, intimation, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Acknowledge', callback_data: `srf_ack:${requestId}` }],
      ] },
    });
  } catch (e) {
    logger.error(`Failed to notify warehouse boy ${assigneeId}`, e.message);
    await bot.sendMessage(chatId, `⚠️ Could not send message to user ${assigneeId}. They may need to start the bot first.`);
    return;
  }

  const assignee = await usersRepository.findByUserId(assigneeId);
  const assigneeName = assignee ? assignee.name : assigneeId;
  await bot.sendMessage(chatId, `✅ Supply request ${requestId} approved and assigned to *${assigneeName}*.`, { parse_mode: 'Markdown' });
  await notifyEmployee(bot, requestingUser, requestId,
    `✅ Your supply request (${requestId}) has been approved and assigned to ${assigneeName} for dispatch.`);
}

async function handleNewCustomerApproval(bot, chatId, requestId, item, requestingUser, approved) {
  const aj = item.actionJSON || {};
  const custName = aj.customer_name || 'Unknown';
  const custId = aj.customer_id;
  const requesterUserId = aj.requesterUserId || requestingUser;

  await approvalQueueRepository.updateStatus(requestId, approved ? 'approved' : 'rejected', new Date().toISOString());

  if (approved) {
    if (custId) {
      const customersRepo = require('../repositories/customersRepository');
      await customersRepo.updateRow(custId, { status: 'Active' });
    }
    await bot.sendMessage(chatId, `✅ Customer "${custName}" approved and activated.`);

    const sessionStore = require('../services/sessionStore');
    const session = sessionStore.get(requesterUserId);
    if (session && session.type === 'supply_req_flow' && session.step === 'awaiting_customer_approval') {
      session.customer = custName;
      session.step = 'salesperson';
      delete session.pendingCustomerId;
      delete session.pendingCustomerName;
      delete session.customerApprovalId;
      sessionStore.set(requesterUserId, session);

      try {
        await bot.sendMessage(requesterUserId,
          `✅ Customer "*${custName}*" has been approved\\!\n\nContinuing your supply request\\.\\.\\. Select salesperson:`,
          { parse_mode: 'MarkdownV2' },
        );
        const telegramUsers = await usersRepository.getAll();
        const rows = [];
        for (let i = 0; i < telegramUsers.length; i += 2) {
          const row = [{ text: `🧑 ${telegramUsers[i].name || telegramUsers[i].user_id}`, callback_data: `srf_sp:${telegramUsers[i].name || telegramUsers[i].user_id}` }];
          if (telegramUsers[i + 1]) row.push({ text: `🧑 ${telegramUsers[i + 1].name || telegramUsers[i + 1].user_id}`, callback_data: `srf_sp:${telegramUsers[i + 1].name || telegramUsers[i + 1].user_id}` });
          rows.push(row);
        }
        await bot.sendMessage(requesterUserId, '🧑 Select salesperson:', { reply_markup: { inline_keyboard: rows } });
      } catch (e) {
        logger.error('Failed to resume supply flow for user after customer approval', e);
      }
    } else {
      await notifyEmployee(bot, requesterUserId, requestId, `✅ Customer "${custName}" has been approved by admin.`);
    }
  } else {
    await bot.sendMessage(chatId, `❌ Customer "${custName}" registration rejected.`);

    const sessionStore = require('../services/sessionStore');
    const session = sessionStore.get(requesterUserId);
    if (session && session.type === 'supply_req_flow' && session.step === 'awaiting_customer_approval') {
      session.step = 'customer';
      delete session.pendingCustomerId;
      delete session.pendingCustomerName;
      delete session.customerApprovalId;
      sessionStore.set(requesterUserId, session);
      try {
        await bot.sendMessage(requesterUserId,
          `❌ Customer "${custName}" was rejected by admin.\n\nPlease select a different customer:`,
        );
        const customersRepo = require('../repositories/customersRepository');
        const allCust = await customersRepo.getAll();
        const active = allCust.filter((c) => (c.status || 'Active').toLowerCase() === 'active');
        const rows = [];
        for (let i = 0; i < active.length; i += 2) {
          const row = [{ text: `👤 ${active[i].name}`, callback_data: `srf_cu:${active[i].name}` }];
          if (active[i + 1]) row.push({ text: `👤 ${active[i + 1].name}`, callback_data: `srf_cu:${active[i + 1].name}` });
          rows.push(row);
        }
        rows.push([{ text: '➕ Add New Customer', callback_data: 'srf_cu:__new__' }]);
        await bot.sendMessage(requesterUserId, '👤 Select customer:', { reply_markup: { inline_keyboard: rows } });
      } catch (e) {
        logger.error('Failed to resume supply flow for user after customer rejection', e);
      }
    } else {
      await notifyEmployee(bot, requesterUserId, requestId, `❌ Customer "${custName}" registration was rejected by admin.`);
    }
  }
}

async function handleSupplyAcknowledge(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  const requestId = data.replace('srf_ack:', '');
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;

  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Acknowledged!' });
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

  await bot.sendMessage(chatId, `✅ You acknowledged supply request ${requestId}. Proceed to the warehouse for dispatch.`);

  const user = await usersRepository.findByUserId(userId);
  const userName = user ? user.name : userId;
  for (const adminId of config.access.adminIds) {
    try {
      await bot.sendMessage(adminId, `✅ *${userName}* acknowledged supply request \`${requestId}\`.`, { parse_mode: 'Markdown' });
    } catch (_) {}
  }
}

module.exports = {
  notifyAdminsApprovalRequest, handleApprovalCallback, handleEnrichmentMessage,
  handleSupplyAssign, handleSupplyAcknowledge,
};
