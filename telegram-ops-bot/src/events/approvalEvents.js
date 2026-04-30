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
const departmentsRepository = require('../repositories/departmentsRepository');
const driveClient = require('../repositories/driveClient');
const fmtDate = require('../utils/formatDate');

const SALE_ACTIONS = ['sell_than', 'sell_package', 'sale_bundle'];
const DEFAULT_SALE_UNIT = 'yard';

const pendingEnrichment = new Map();

// Tracks dispatch users currently typing a free-text rejection or
// decline reason. Keyed by user_id so the controller's text handler
// can route the next message back to the right Stage 1 / Stage 3
// callback. Values: { kind: 'manager_reject'|'dispatch_decline',
// requestId, chatId }.
const pendingReason = new Map();

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
      // Fix B — if any items silently failed inside the bundle, show them
      // loudly to both the approving admin and the requesting employee.
      const rep = result.bundleReport;
      const partial = rep && rep.failedItems && rep.failedItems.length > 0;
      let partialTail = '';
      if (partial) {
        const lines = rep.failedItems.map((f) => {
          const base = f.type === 'than'
            ? `Bale ${f.packageNo} Than ${f.thanNo}`
            : `Bale ${f.packageNo}`;
          return `  • ${base}: ${f.reason}`;
        }).join('\n');
        const balesWord = rep.appliedPkgCount === 1 ? 'Bale' : 'Bales';
        partialTail = `\n\n⚠️ Partial apply — ${rep.failedItems.length} of ${rep.requestedItems} item(s) did NOT apply (${rep.appliedPkgCount} ${balesWord} / ${rep.appliedThans} thans / ${rep.appliedYards} yds were recorded):\n${lines}`;
      }
      const balesWordMsg = rep && rep.appliedPkgCount === 1 ? 'Bale' : 'Bales';
      let msg = partial
        ? `⚠️ Request ${requestId} approved, but applied only ${rep.appliedPkgCount} of ${rep.requestedItems} ${balesWordMsg}. Ledger updated for what was applied.`
        : `✅ Request ${requestId} approved. Sale and ledger updated.`;
      msg += partialTail;
      if (driveInfo) msg += `\n📎 [View Sales Bill](${driveInfo.webViewLink})`;
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
      const employeeMsg = partial
        ? `⚠️ Your request (${requestId}) was approved, but only ${rep.appliedPkgCount} of ${rep.requestedItems} ${balesWordMsg} could be applied. ${rep.failedItems.length} item(s) were stale/invalid and skipped. Please check with admin.${partialTail}`
        : `✅ Your request (${requestId}) has been approved by admin. Sale and ledger updated.`;
      await notifyEmployee(bot, requestingUser, requestId, employeeMsg);
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

/**
 * Notify all admins (excluding the one who raised the request, if applicable)
 * that an approval is pending.
 *
 * @param {object} bot
 * @param {string} requestId
 * @param {string} userLabel
 * @param {string} actionSummary
 * @param {string} riskReason
 * @param {string} [excludeUserId]
 * @param {object} [opts]                  optional decoration
 * @param {string} [opts.previewPhoto]     Telegram file_id or HTTPS URL — shown above the approval message
 */
/**
 * Build a compact Stage-1 summary for a supply_request actionJSON.
 * Surfaces only what a Dispatch person needs to confirm feasibility:
 * warehouse, total Bales, # designs, customer, requested date.
 *
 * Full cart lines / payment / salesperson stay behind the "Show
 * details" button to keep the card scannable on small screens.
 */
function buildSupplyDispatchCompactSummary(aj) {
  const cart = Array.isArray(aj && aj.cart) ? aj.cart : [];
  const totalQty = cart.reduce((s, c) => s + (Number(c.quantity) || 0), 0);
  const distinctDesigns = new Set(cart.map((c) => c.design)).size;
  let s = `📦 *Supply Request — needs Dispatch confirmation*\n\n`;
  s += `🏭 Warehouse: *${(aj && aj.warehouse) || '-'}*\n`;
  s += `📦 Total: *${totalQty} bales* across *${distinctDesigns} design${distinctDesigns === 1 ? '' : 's'}*\n`;
  s += `👤 Customer: *${(aj && aj.customer) || '-'}*\n`;
  s += `📅 Date: *${fmtDate(aj && aj.salesDate)}*`;
  return s;
}

/**
 * Build a fully-expanded Stage-1 summary (cart lines + customer +
 * salesperson + payment + date). Used when the dispatch user taps
 * 🔍 Show details on the compact card.
 */
async function buildSupplyDispatchFullSummary(aj) {
  const productTypesRepo = require('../repositories/productTypesRepository');
  const labels = await productTypesRepo.getLabels((aj && aj.productType) || 'fabric');
  const cShort = labels.container_short;
  const cart = Array.isArray(aj && aj.cart) ? aj.cart : [];
  const cartLines = cart.map((c) => {
    const m = productTypesRepo.getMaterialInfo(c.design);
    const shadeName = c.shadeName || '';
    const shadeRef = shadeName ? `${c.shade} - ${shadeName}` : String(c.shade || '');
    return `${m.icon} ${c.design} [${m.name}] │ Shade: ${shadeRef} │ ×${c.quantity} ${cShort}`;
  }).join('\n');
  const totalQty = cart.reduce((s, c) => s + (Number(c.quantity) || 0), 0);
  const containerPlural = productTypesRepo.pluralize(labels.container_label, totalQty).toLowerCase();
  let s = `📦 *Supply Request — full details*\n\n`;
  s += `🏭 Warehouse: *${(aj && aj.warehouse) || '-'}*\n`;
  s += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  s += `${cartLines}\n`;
  s += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  s += `📦 Total: *${totalQty} ${containerPlural}*\n`;
  s += `👤 Customer: *${(aj && aj.customer) || '-'}*\n`;
  s += `🧑 Salesperson: *${(aj && aj.salesperson) || '-'}*\n`;
  s += `💳 Payment: *${(aj && aj.paymentMode) || '-'}*\n`;
  s += `📅 Date: *${fmtDate(aj && aj.salesDate)}*`;
  if (aj && aj.sale_doc_file_id) s += `\n📎 Document attached`;
  return s;
}

/**
 * Stage 1 routing: send the dispatch confirmation card to every
 * active user who belongs to the Dispatch department, excluding the
 * requester. Self-heals by ensuring the Dispatch department row
 * exists. Returns:
 *   { routed: true, recipients: [...] }   if at least one was notified,
 *   { routed: false, reason: 'no_users' } if no Dispatch users exist
 *                                          (caller should fall back
 *                                          to admin Stage-2 directly).
 */
async function notifyDispatchManagers(bot, requestId, item, requesterUserId) {
  // Self-heal: ensure the Dispatch department row exists so admins
  // never need to hand-edit the Departments sheet.
  try {
    await departmentsRepository.ensureDept({ dept_name: 'Dispatch' });
  } catch (e) {
    logger.warn(`notifyDispatchManagers: ensureDept failed — ${e.message}`);
  }

  const dispatchUsers = await usersRepository.findByDepartment('Dispatch');
  const recipients = dispatchUsers.filter((u) => String(u.user_id) !== String(requesterUserId));
  if (!recipients.length) {
    logger.warn(`notifyDispatchManagers(${requestId}): no active Dispatch users found, falling back to admin stage`);
    return { routed: false, reason: 'no_users' };
  }

  const aj = (item && item.actionJSON) || {};
  const compact = buildSupplyDispatchCompactSummary(aj);
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔍 Show details', callback_data: `smc:d:${requestId}` }],
      [
        { text: '✅ Confirm', callback_data: `smc:c:${requestId}` },
        { text: '❌ Reject',  callback_data: `smc:r:${requestId}` },
      ],
    ],
  };

  const sent = [];
  for (const u of recipients) {
    try {
      await bot.sendMessage(u.user_id, compact, { parse_mode: 'Markdown', reply_markup: keyboard });
      sent.push(u);
    } catch (e) {
      logger.warn(`notifyDispatchManagers: failed to notify ${u.user_id} (${u.name || ''}) — ${e.message}`);
    }
  }
  return { routed: sent.length > 0, recipients: sent };
}

/**
 * Stage 1 actions — confirm / reject / show-details. Wired from the
 * controller's callback dispatcher (`smc:` prefix).
 */
async function handleDispatchManagerCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  // smc:<action>:<requestId>
  const m = data.match(/^smc:([cdr]):(.+)$/);
  if (!m) return;
  const verb = m[1];
  const requestId = m[2];
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  const row = await approvalQueueRepository.getByRequestId(requestId);
  if (!row) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Request no longer exists.' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
    return;
  }
  const aj = row.actionJSON || {};
  if (aj.action !== 'supply_request') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Not a supply request.' });
    return;
  }
  // Only active Dispatch users may act on this card. (Anyone else who
  // somehow taps the buttons gets a polite "not authorized" toast.)
  const acting = await usersRepository.findByUserId(userId);
  if (!acting || acting.status !== 'active' || !usersRepository.inDepartment(acting, 'Dispatch')) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only Dispatch members can act on this.' });
    return;
  }

  // Race protection: another dispatch member already confirmed or
  // rejected this request — this card is stale.
  if (aj.stage && aj.stage !== 'dispatch_review') {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: aj.confirmedByDispatch
        ? `Already confirmed by ${aj.confirmedByDispatch.name || 'another dispatch member'}.`
        : 'Already actioned.',
      show_alert: false,
    });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
    return;
  }

  if (verb === 'd') {
    // Show details — expand the card in place but keep the buttons.
    const full = await buildSupplyDispatchFullSummary(aj);
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Confirm', callback_data: `smc:c:${requestId}` },
          { text: '❌ Reject',  callback_data: `smc:r:${requestId}` },
        ],
      ],
    };
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageText(full, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => {});
    return;
  }

  if (verb === 'c') {
    // Confirm — record the confirmer, advance to Stage 2 (admin review),
    // notify the requester + the admins (excluding the requester if
    // they're an admin themselves) with the manager-confirmation note
    // prepended to the existing approval card.
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Confirming...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});

    const confirmedAt = new Date().toISOString();
    const confirmerName = acting.name || acting.user_id;
    await approvalQueueRepository.updateActionJSON(requestId, {
      stage: 'admin_review',
      confirmedByDispatch: { user_id: userId, name: confirmerName, ts: confirmedAt },
    });

    await bot.editMessageText(
      `✅ Confirmed.\n\nRequest \`${requestId}\` is now waiting for 2nd-admin approval.`,
      { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' },
    ).catch(() => {});

    // Notify creator
    await notifyEmployee(bot, row.user, requestId,
      `✅ *Dispatch confirmed* your supply request \`${requestId}\` (by ${confirmerName}). Waiting for 2nd-admin approval.`);

    // Notify admins with prepended confirmation note. Exclude the
    // requester if they're an admin themselves (mirrors the original
    // requester-excluded broadcast).
    const requesterIsAdmin = config.access.adminIds.includes(String(row.user));
    const excludeId = requesterIsAdmin ? row.user : undefined;
    const userLabel = await getRequesterDisplayName(row.user);
    const summary = await buildSupplyDispatchFullSummary(aj);
    const fmtTime = (() => { try { return new Date(confirmedAt).toLocaleString('en-NG'); } catch { return confirmedAt; } })();
    await notifyAdminsApprovalRequest(
      bot, requestId, userLabel, summary, row.riskReason || 'Supply request requires admin approval',
      excludeId,
      { prependNote: `✅ Confirmed by Dispatch: ${confirmerName} on ${fmtTime}` },
    );

    // Forward attached bill (if any) to admins. Skipped at Stage 1
    // because dispatch members don't need to see it.
    if (aj.sale_doc_file_id) {
      for (const adminId of config.access.adminIds) {
        if (excludeId && String(adminId) === String(excludeId)) continue;
        try {
          if (aj.sale_doc_type === 'photo') {
            await bot.sendPhoto(adminId, aj.sale_doc_file_id, { caption: `📎 Bill for ${requestId}` });
          } else {
            await bot.sendDocument(adminId, aj.sale_doc_file_id, { caption: `📎 Bill for ${requestId}` });
          }
        } catch (_) {}
      }
    }
    return;
  }

  if (verb === 'r') {
    // Reject — prompt for a brief reason via free-text. The next
    // message from this user lands in handleDispatchReasonReply (in
    // approvalEvents) which finalizes the rejection.
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
    pendingReason.set(userId, { kind: 'manager_reject', requestId, chatId });
    await bot.sendMessage(chatId,
      `❌ *Reject supply request* \`${requestId}\`\n\nReply with a brief reason (or type *cancel* to abort).`,
      { parse_mode: 'Markdown' });
    return;
  }
}

/**
 * Helper for buildSupplyDispatchFullSummary's prepend caller.
 * Resolves a label for the requester (name + dept) so the admin card
 * reads like "Yarima (Sales)" instead of a bare numeric ID.
 */
async function getRequesterDisplayName(userId) {
  try {
    const u = await usersRepository.findByUserId(userId);
    if (!u) return String(userId);
    const depts = (u.departments && u.departments.length) ? u.departments.join(', ') : (u.department || '');
    return depts ? `${u.name || u.user_id} (${depts})` : (u.name || u.user_id);
  } catch (_) {
    return String(userId);
  }
}

/**
 * Handle the free-text reply that follows a Stage-1 rejection or a
 * Stage-3 decline. Returns true if the message was consumed (so the
 * caller can early-return from its text handler), false otherwise.
 */
async function handleReasonReply(bot, msg) {
  const userId = String(msg.from.id);
  const state = pendingReason.get(userId);
  if (!state) return false;

  const text = (msg.text || '').trim();
  if (!text) {
    await bot.sendMessage(state.chatId, 'Please type a reason or *cancel*.', { parse_mode: 'Markdown' });
    return true;
  }
  if (text.toLowerCase() === 'cancel') {
    pendingReason.delete(userId);
    await bot.sendMessage(state.chatId, 'Cancelled. The request stays as it was.');
    return true;
  }
  const reason = text.slice(0, 200);
  pendingReason.delete(userId);

  const row = await approvalQueueRepository.getByRequestId(state.requestId);
  if (!row) {
    await bot.sendMessage(state.chatId, `⚠️ Request \`${state.requestId}\` no longer exists.`, { parse_mode: 'Markdown' });
    return true;
  }

  const acting = await usersRepository.findByUserId(userId);
  const actorName = (acting && acting.name) || userId;
  const ts = new Date().toISOString();

  if (state.kind === 'manager_reject') {
    // Stage-1 rejection — finalize. Admins were never involved at
    // this stage, so no admin notification is needed.
    await approvalQueueRepository.updateActionJSON(state.requestId, {
      stage: 'rejected_by_dispatch',
      dispatchRejection: { user_id: userId, name: actorName, ts, reason },
    });
    await approvalQueueRepository.updateStatus(state.requestId, 'rejected', ts);

    await bot.sendMessage(state.chatId,
      `❌ Rejected. Request \`${state.requestId}\` will not proceed.\n\nReason recorded: _${reason}_`,
      { parse_mode: 'Markdown' });

    await notifyEmployee(bot, row.user, state.requestId,
      `❌ *Dispatch rejected* your supply request \`${state.requestId}\`.\n\nReason: _${reason}_\n\nReason given by: ${actorName}\n\nYou can edit and resubmit if you want to retry.`);
    return true;
  }

  if (state.kind === 'dispatch_decline') {
    // Stage-3 decline — bounce back to the 2nd admin's picker so
    // they can pick a different dispatch person.
    const aj = row.actionJSON || {};
    await approvalQueueRepository.updateActionJSON(state.requestId, {
      stage: 'admin_repick',
      dispatchDecline: { user_id: userId, name: actorName, ts, reason },
    });

    await bot.sendMessage(state.chatId,
      `❌ Declined. Admin will be asked to assign someone else.\n\nReason recorded: _${reason}_`,
      { parse_mode: 'Markdown' });

    // Notify the creator (informational).
    await notifyEmployee(bot, row.user, state.requestId,
      `⚠️ *${actorName} declined* the dispatch assignment for \`${state.requestId}\`.\n\nReason: _${reason}_\n\nAdmin will reassign shortly.`);

    // Re-show warehouse boy picker to all admins (or the original
    // approver if recorded). For simplicity broadcast to all admins.
    const approvedBy = aj.approvedByAdmin && aj.approvedByAdmin.user_id;
    const targets = approvedBy ? [approvedBy] : (config.access.adminIds || []);
    for (const adminId of targets) {
      try {
        await bot.sendMessage(adminId,
          `⚠️ Dispatch decline on \`${state.requestId}\` — please reassign.\n\nDeclined by: *${actorName}*\nReason: _${reason}_`,
          { parse_mode: 'Markdown' });
        await showWarehouseBoyPicker(bot, adminId, state.requestId, row, row.user);
      } catch (e) {
        logger.warn(`re-show picker failed for admin ${adminId}: ${e.message}`);
      }
    }
    return true;
  }

  return true;
}

async function notifyAdminsApprovalRequest(bot, requestId, userLabel, actionSummary, riskReason, excludeUserId, opts = {}) {
  const esc = (s) => (s || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  // Optional prepended note (used by Stage 2 of the supply-request flow
  // to surface "✅ Confirmed by Dispatch: <name> on <time>" at the top
  // of the admin card so reviewers see upstream provenance at a glance).
  const noteLine = opts && opts.prependNote ? `${esc(opts.prependNote)}\n\n` : '';
  const text = `${noteLine}🔔 *Approval required*\n\nRequest ID: \`${requestId}\`\nUser: ${esc(userLabel)}\nAction: ${esc(actionSummary)}\nReason: ${esc(riskReason)}\n\nUse buttons below to approve or reject\\.`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '✅ Approve', callback_data: `approve:${requestId}` }, { text: '❌ Reject', callback_data: `reject:${requestId}` }],
    ],
  };
  for (const adminId of config.access.adminIds) {
    if (excludeUserId && String(adminId) === String(excludeUserId)) continue;
    // Best-effort photo preview (e.g. for design_asset_upload). Never blocks the text notification.
    if (opts && opts.previewPhoto) {
      try {
        await bot.sendPhoto(adminId, opts.previewPhoto, {
          caption: opts.previewCaption || `📷 Preview for request \`${requestId}\``,
          parse_mode: 'Markdown',
        });
      } catch (e) {
        logger.warn(`Failed to send preview photo to admin ${adminId} for ${requestId}`, e.message);
      }
    }
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

        // For design_asset_upload, send the now-active photo to the
        // approving admin as a confirmation. This warms up the Telegram
        // file_id cache (first send produces a Buffer→Telegram upload;
        // the captured file_id is cached on the asset row, so every
        // subsequent consumer access is instant).
        const isDesignAsset = item && item.actionJSON && item.actionJSON.action === 'design_asset_upload';
        if (isDesignAsset) {
          try {
            const designAssetsService = require('../services/designAssetsService');
            const aj = item.actionJSON;
            const lines = (aj.shades && aj.shades.length)
              ? aj.shades.map((s) => `${s.number}. ${s.name}`).join(' • ')
              : (aj.shadeNames || []).map((n, i) => `${i + 1}. ${n}`).join(' • ');
            const ok = await designAssetsService.sendDesignPhoto({
              bot, chatId: chatIdCb, design: aj.design,
              caption: `✅ *${aj.design}* — photo activated\n${lines}\n\nNow visible in Supply Request, Sample, Order, Update Price, and Stock pickers.`,
            });
            if (!ok) logger.warn(`approval design_asset_upload: post-approval photo send failed for ${aj.design}`);
          } catch (e) {
            logger.warn('post-approval design_asset send failed', e.message);
          }
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
    if (u.status && u.status !== 'active') return false;
    const inDispatch = usersRepository.inDepartment(u, 'Dispatch')
      || usersRepository.inDepartment(u, 'Warehouse')
      || usersRepository.inDepartment(u, 'Logistics');
    if (!inDispatch) return false;
    const whs = u.warehouses || [];
    return !warehouse || whs.includes(warehouse);
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

  // Stage 3 change: keep the queue row in `pending` until the
  // dispatch person Accepts. The admin's pick now records the
  // assignment + admin identity on actionJSON; final status flips
  // happen in handleSupplyAccept (or the request bounces on Decline).
  const assignTs = new Date().toISOString();
  const assigneeUser = await usersRepository.findByUserId(assigneeId);
  await approvalQueueRepository.updateActionJSON(requestId, {
    stage: 'dispatch_acceptance',
    assignedDispatch: { user_id: assigneeId, name: (assigneeUser && assigneeUser.name) || assigneeId, ts: assignTs },
    approvedByAdmin: { user_id: adminId, ts: assignTs },
  });

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
  intimation += `\n🔔 Assigned by admin. Please *Accept* (you'll prep the stock) or *Decline* (admin will reassign).`;

  try {
    await bot.sendMessage(assigneeId, intimation, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [
          { text: '✅ Accept',  callback_data: `srf_acc:${requestId}` },
          { text: '❌ Decline', callback_data: `srf_dec:${requestId}` },
        ],
      ] },
    });
  } catch (e) {
    logger.error(`Failed to notify dispatch person ${assigneeId}`, e.message);
    await bot.sendMessage(chatId, `⚠️ Could not send message to user ${assigneeId}. They may need to start the bot first.`);
    return;
  }

  const assigneeName = (assigneeUser && assigneeUser.name) || assigneeId;
  await bot.sendMessage(chatId, `✅ Supply request \`${requestId}\` assigned to *${assigneeName}*.\n\n⏳ Waiting for them to *Accept* before stock leaves the warehouse.`, { parse_mode: 'Markdown' });
  await notifyEmployee(bot, requestingUser, requestId,
    `✅ Your supply request \`${requestId}\` was approved and assigned to *${assigneeName}*.\n\n⏳ Waiting for ${assigneeName} to *Accept* the dispatch.`);
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
    } else if (session && session.type === 'sample_flow' && session.step === 'awaiting_customer_approval') {
      // Resume Give Sample flow at the quantity step.
      session.customer = custName;
      session.step = 'quantity';
      delete session.pendingCustomerId;
      delete session.pendingCustomerName;
      delete session.customerApprovalId;
      sessionStore.set(requesterUserId, session);
      try {
        await bot.sendMessage(requesterUserId,
          `✅ Customer "*${custName}*" approved.\n\nContinuing your sample request…`,
          { parse_mode: 'Markdown' },
        );
        const telegramController = require('../controllers/telegramController');
        if (typeof telegramController.showSampleQuantityPicker === 'function') {
          await telegramController.showSampleQuantityPicker(bot, requesterUserId, requesterUserId);
        }
      } catch (e) {
        logger.error('Failed to resume sample flow for user after customer approval', e);
      }
    } else if (session && session.type === 'order_flow' && session.step === 'awaiting_customer_approval') {
      session.customer = custName;
      session.step = 'quantity';
      delete session.pendingCustomerId;
      delete session.pendingCustomerName;
      delete session.customerApprovalId;
      sessionStore.set(requesterUserId, session);
      try {
        await bot.sendMessage(requesterUserId,
          `✅ Customer "*${custName}*" approved. Continuing your order…\n\nPick quantity:`,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [
                { text: '1 Bale',  callback_data: 'oq:1' },
                { text: '2 Bales', callback_data: 'oq:2' },
                { text: '5 Bales', callback_data: 'oq:5' },
                { text: '10 Bales', callback_data: 'oq:10' },
              ],
              [{ text: '✏️ Custom', callback_data: 'oq:__custom__' }],
              [{ text: '❌ Cancel', callback_data: 'ocanc:1' }],
            ] },
          },
        );
      } catch (e) {
        logger.error('Failed to resume order flow for user after customer approval', e);
      }
    } else if (session && session.type === 'receipt_flow' && session.step === 'awaiting_customer_approval') {
      session.customer = custName;
      session.step = 'amount';
      delete session.pendingCustomerId;
      delete session.pendingCustomerName;
      delete session.customerApprovalId;
      sessionStore.set(requesterUserId, session);
      try {
        await bot.sendMessage(requesterUserId,
          `✅ Customer "*${custName}*" approved. Continuing your receipt upload…\n\nEnter the payment *amount* received (NGN):`,
          { parse_mode: 'Markdown' },
        );
      } catch (e) {
        logger.error('Failed to resume receipt flow after customer approval', e);
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
    } else if (session && session.type === 'sample_flow' && session.step === 'awaiting_customer_approval') {
      session.step = 'customer';
      delete session.pendingCustomerId;
      delete session.pendingCustomerName;
      delete session.customerApprovalId;
      sessionStore.set(requesterUserId, session);
      try {
        await bot.sendMessage(requesterUserId,
          `❌ Customer "${custName}" was rejected by admin.\n\nPlease pick a different customer for the sample request.`,
        );
        const telegramController = require('../controllers/telegramController');
        if (typeof telegramController.showSampleCustomerPicker === 'function') {
          await telegramController.showSampleCustomerPicker(bot, requesterUserId, requesterUserId);
        }
      } catch (e) {
        logger.error('Failed to resume sample flow for user after customer rejection', e);
      }
    } else if (session && session.type === 'order_flow' && session.step === 'awaiting_customer_approval') {
      sessionStore.clear(requesterUserId);
      try {
        await bot.sendMessage(requesterUserId,
          `❌ Customer "${custName}" was rejected by admin.\n\nYour order has been cancelled. Please start again with a different customer.`,
        );
      } catch (e) {
        logger.error('Failed to notify user after order-flow customer rejection', e);
      }
    } else if (session && session.type === 'receipt_flow' && session.step === 'awaiting_customer_approval') {
      sessionStore.clear(requesterUserId);
      try {
        await bot.sendMessage(requesterUserId,
          `❌ Customer "${custName}" was rejected by admin.\n\nReceipt upload cancelled. Please restart with a different customer.`,
        );
      } catch (e) {
        logger.error('Failed to notify user after receipt-flow customer rejection', e);
      }
    } else {
      await notifyEmployee(bot, requesterUserId, requestId, `❌ Customer "${custName}" registration was rejected by admin.`);
    }
  }
}

/**
 * Stage 3 — dispatch person taps ✅ Accept on the assignment card.
 * Finalizes the queue row and broadcasts the success to all parties:
 * creator, every admin (the original 2nd-admin approver included),
 * and the Stage-1 confirmer (so they know their feasibility check
 * paid off).
 *
 * Old `srf_ack:` callbacks (from messages sent before this upgrade)
 * are delivered here too via the alias in the controller's dispatch.
 */
async function handleSupplyAccept(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  const requestId = data.replace(/^srf_(acc|ack):/, '');
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;

  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Accepted!' });
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

  const ts = new Date().toISOString();
  await approvalQueueRepository.updateStatus(requestId, 'approved', ts);
  await approvalQueueRepository.updateActionJSON(requestId, {
    stage: 'completed',
    acceptedByDispatch: { user_id: userId, ts },
  });

  const acting = await usersRepository.findByUserId(userId);
  const userName = (acting && acting.name) || userId;
  await bot.sendMessage(chatId, `✅ You accepted supply request \`${requestId}\`. Proceed to the warehouse for dispatch.`, { parse_mode: 'Markdown' });

  // Notify the creator (NEW — previously creator wasn't told).
  const row = await approvalQueueRepository.getByRequestId(requestId);
  const creator = row && row.user;
  if (creator) {
    await notifyEmployee(bot, creator, requestId,
      `✅ *${userName}* has accepted dispatch for your supply request \`${requestId}\`. Stock is being prepared.`);
  }

  // Notify every admin (existing behavior, slightly reworded).
  for (const adminId of config.access.adminIds) {
    try {
      await bot.sendMessage(adminId, `✅ *${userName}* accepted dispatch for supply request \`${requestId}\`.`, { parse_mode: 'Markdown' });
    } catch (_) {}
  }

  // Notify the Stage-1 confirmer (close the loop) — only if they're
  // not also the accepter or an admin (already notified above).
  try {
    const aj = (row && row.actionJSON) || {};
    const confirmerId = aj.confirmedByDispatch && aj.confirmedByDispatch.user_id;
    if (confirmerId
        && String(confirmerId) !== String(userId)
        && !config.access.adminIds.includes(String(confirmerId))) {
      await bot.sendMessage(confirmerId,
        `✅ *${userName}* accepted dispatch for supply request \`${requestId}\` — the one you confirmed earlier.`,
        { parse_mode: 'Markdown' });
    }
  } catch (_) {}
}

/**
 * Stage 3 — dispatch person taps ❌ Decline. Collects a reason via
 * the shared `pendingReason` channel; the actual finalization runs
 * in `handleReasonReply` once the user types their reason.
 */
async function handleSupplyDecline(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  const requestId = data.replace(/^srf_dec:/, '');
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;

  await bot.answerCallbackQuery(callbackQuery.id);
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

  pendingReason.set(userId, { kind: 'dispatch_decline', requestId, chatId });
  await bot.sendMessage(chatId,
    `❌ *Decline supply request* \`${requestId}\`\n\nReply with a brief reason (or type *cancel* to keep the assignment).`,
    { parse_mode: 'Markdown' });
}

module.exports = {
  notifyAdminsApprovalRequest,
  handleApprovalCallback,
  handleEnrichmentMessage,
  handleSupplyAssign,
  handleSupplyAccept,
  handleSupplyDecline,
  handleDispatchManagerCallback,
  handleReasonReply,
  notifyDispatchManagers,
};
