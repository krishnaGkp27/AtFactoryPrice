/**
 * Manufacturing bot commands — Telegram handlers for all /mfg_* commands.
 *
 * Employee commands (guided flow):
 *   /mfg_fabric <article_no>    — Fabric receipt & cutting
 *   /mfg_emb_out <article_no>   — Dispatch to embroidery
 *   /mfg_emb_in <article_no>    — Receive from embroidery
 *   /mfg_stitch <article_no>    — Stitching
 *   /mfg_threadcut <article_no> — Thread cutting
 *   /mfg_iron <article_no>      — Ironing / press
 *   /mfg_qc <article_no>        — Quality check
 *   /mfg_package <article_no>   — Final packaging & stock
 *
 * Admin commands:
 *   /mfg_approve_article <article_no> — 2nd admin approval for new article
 *   /mfg_pending       — List pending stage approvals (with buttons)
 *   /mfg_status <article_no>  — Article production status
 *   /mfg_pipeline      — All in-progress articles and their current stage
 *   /mfg_add_vendor <fabric|emb> <code> <name> — Add vendor
 *   /mfg_remove_vendor <fabric|emb> <code>     — Deactivate vendor
 *   /mfg_vendors [fabric|emb]                   — List vendors
 *   /mfg_rejections [article_no]                — View rejections
 */

const mfgService = require('../services/manufacturingService');
const mfgFlow = require('../services/mfgFlowService');
const mfgApprovalsRepo = require('../repositories/mfgApprovalsRepository');
const mfgRejectionsRepo = require('../repositories/mfgRejectionsRepository');
const fabricVendorsRepo = require('../repositories/fabricVendorsRepository');
const embVendorsRepo = require('../repositories/embVendorsRepository');
const productionRepo = require('../repositories/productionRepository');
const auth = require('../middlewares/auth');
const config = require('../config');

// ─── Guided Flow: start a stage ───────────────────────────────────────────────

async function handleStageCommand(bot, chatId, userId, stageName, args) {
  const articleNo = (args || '').trim();
  if (!articleNo) {
    await bot.sendMessage(chatId, `Usage: /mfg_${stageName} <article_no>`);
    return;
  }
  const result = await mfgFlow.startSession(userId, articleNo, stageName);
  if (!result.ok) { await bot.sendMessage(chatId, result.message); return; }

  const prompt = await mfgFlow.buildPrompt(mfgFlow.getSession(userId));
  if (prompt) await bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
}

/** Handle text reply during an active manufacturing guided flow. Returns true if consumed. */
async function handleFlowReply(bot, chatId, userId, text) {
  const session = mfgFlow.getSession(userId);
  if (!session) return false;

  const result = await mfgFlow.processReply(userId, text);
  if (!result.ok && !result.done) {
    await bot.sendMessage(chatId, result.message);
    return true;
  }
  if (result.done) {
    if (result.approval_id) {
      await bot.sendMessage(chatId, `✅ Submitted for admin approval.\nApproval ID: ${result.approval_id}\nArticle: ${session.articleNo} — ${mfgService.STAGES[session.stage]?.label}`);
      await notifyAdminsPending(bot, result.approval_id, session.articleNo, session.stage, userId);
    } else {
      await bot.sendMessage(chatId, result.message || 'Done.');
    }
    return true;
  }
  if (result.summary) {
    const summary = mfgFlow.buildSummary(session);
    await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
    return true;
  }
  const prompt = await mfgFlow.buildPrompt(mfgFlow.getSession(userId));
  if (prompt) await bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
  return true;
}

// ─── Admin: article approval ──────────────────────────────────────────────────

async function handleApproveArticle(bot, chatId, userId, args) {
  if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Admin only.'); return; }
  const articleNo = (args || '').trim();
  if (!articleNo) { await bot.sendMessage(chatId, 'Usage: /mfg_approve_article <article_no>'); return; }
  const result = await mfgService.approveArticle(articleNo, userId);
  await bot.sendMessage(chatId, result.ok ? `✅ Article ${articleNo} approved and active.` : result.message);
}

// ─── Admin: pending approvals ─────────────────────────────────────────────────

async function handlePending(bot, chatId, userId) {
  if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Admin only.'); return; }
  const pending = await mfgApprovalsRepo.getPending();
  if (!pending.length) { await bot.sendMessage(chatId, 'No pending manufacturing approvals.'); return; }
  for (const item of pending.slice(0, 10)) {
    const stageDef = mfgService.STAGES[item.stage];
    const text = `🔔 *MFG Approval*\nID: \`${item.approval_id}\`\nArticle: ${item.article_no}\nStage: ${stageDef?.label || item.stage}\nSubmitted by: ${item.submitted_by}\nDate: ${item.created_at?.slice(0, 10)}`;
    const keyboard = { inline_keyboard: [[
      { text: '✅ Approve', callback_data: `mfg_approve:${item.approval_id}` },
      { text: '❌ Reject', callback_data: `mfg_reject:${item.approval_id}` },
    ]] };
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

// ─── Admin: handle approval callback ──────────────────────────────────────────

async function handleApprovalCallback(bot, callbackQuery, action) {
  const adminId = String(callbackQuery.from.id);
  if (!auth.isAdmin(adminId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only admins can approve.' });
    return;
  }
  const data = callbackQuery.data || '';
  const approvalId = data.replace(/^mfg_(approve|reject):/, '');
  const chatId = callbackQuery.message.chat.id;
  const msgId = callbackQuery.message.message_id;

  try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }); } catch (_) {}

  let result;
  if (action === 'approve') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Approving...' });
    result = await mfgService.approveStageUpdate(approvalId, adminId);
    if (result.ok) {
      await bot.sendMessage(chatId, `✅ MFG Approved: ${result.article_no} — ${result.label}`);
    } else {
      await bot.sendMessage(chatId, `⚠️ ${result.message}`);
    }
  } else {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Rejecting...' });
    result = await mfgService.rejectStageUpdate(approvalId, adminId);
    if (result.ok) {
      await bot.sendMessage(chatId, `❌ MFG Rejected: ${result.article_no} — ${result.stage}`);
    } else {
      await bot.sendMessage(chatId, `⚠️ ${result.message}`);
    }
  }
}

// ─── Notify admins of new pending approval ────────────────────────────────────

async function notifyAdminsPending(bot, approvalId, articleNo, stage, submittedBy) {
  const stageDef = mfgService.STAGES[stage];
  const text = `🔔 *MFG Stage Update Pending*\nApproval: \`${approvalId}\`\nArticle: ${articleNo}\nStage: ${stageDef?.label || stage}\nSubmitted by: ${submittedBy}`;
  const keyboard = { inline_keyboard: [[
    { text: '✅ Approve', callback_data: `mfg_approve:${approvalId}` },
    { text: '❌ Reject', callback_data: `mfg_reject:${approvalId}` },
  ]] };
  for (const adminId of config.access.adminIds) {
    try { await bot.sendMessage(adminId, text, { parse_mode: 'Markdown', reply_markup: keyboard }); } catch (_) {}
  }
}

// ─── Status & pipeline ────────────────────────────────────────────────────────

async function handleStatus(bot, chatId, userId, args) {
  const articleNo = (args || '').trim();
  if (!articleNo) { await bot.sendMessage(chatId, 'Usage: /mfg_status <article_no>'); return; }
  const s = await mfgService.getArticleStatus(articleNo);
  if (!s) { await bot.sendMessage(chatId, `Article ${articleNo} not found.`); return; }
  let text = `📊 *Article ${s.article_no}*\n`;
  text += `Description: ${s.description}\nStatus: ${s.status}\nCurrent Stage: ${s.stageLabel}\n\n`;
  text += `Cut Pieces: ${s.cut_pieces || '—'}\n`;
  text += `EMB Dispatched: ${s.emb_dispatched || '—'} | Received: ${s.emb_received || '—'}\n`;
  text += `Stitched: ${s.stitched || '—'}\nThread Cut: ${s.threadcut || '—'}\nIroned: ${s.ironed || '—'}\n`;
  text += `QC Passed: ${s.qc_passed || '—'} | Rejected: ${s.qc_rejected || '—'}\n`;
  text += `Final Stock: ${s.final_stock || '—'}`;
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

async function handlePipeline(bot, chatId, userId) {
  if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Admin only.'); return; }
  const pipeline = await mfgService.getPipeline();
  if (!pipeline.length) { await bot.sendMessage(chatId, 'No articles in production.'); return; }
  let text = `🏭 *Production Pipeline*\n\n`;
  pipeline.forEach((a, i) => { text += `${i + 1}. ${a.article_no} — ${a.description || '?'} — *${a.stage}*\n`; });
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

// ─── Vendor management ────────────────────────────────────────────────────────

async function handleAddVendor(bot, chatId, userId, args) {
  if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Admin only.'); return; }
  const parts = (args || '').trim().split(/\s+/);
  const type = (parts[0] || '').toLowerCase();
  const code = parts[1] || '';
  const name = parts.slice(2).join(' ') || '';
  if (!type || !code || (type !== 'fabric' && type !== 'emb')) {
    await bot.sendMessage(chatId, 'Usage: /mfg_add_vendor <fabric|emb> <code> <name>');
    return;
  }
  const repo = type === 'fabric' ? fabricVendorsRepo : embVendorsRepo;
  const existing = await repo.findByCode(code);
  if (existing) { await bot.sendMessage(chatId, `Vendor ${code} already exists.`); return; }
  await repo.append({ vendor_code: code, vendor_name: name });
  await bot.sendMessage(chatId, `✅ ${type === 'fabric' ? 'Fabric' : 'EMB'} vendor ${code} added.`);
}

async function handleRemoveVendor(bot, chatId, userId, args) {
  if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Admin only.'); return; }
  const parts = (args || '').trim().split(/\s+/);
  const type = (parts[0] || '').toLowerCase();
  const code = parts[1] || '';
  if (!type || !code || (type !== 'fabric' && type !== 'emb')) {
    await bot.sendMessage(chatId, 'Usage: /mfg_remove_vendor <fabric|emb> <code>');
    return;
  }
  const repo = type === 'fabric' ? fabricVendorsRepo : embVendorsRepo;
  const ok = await repo.deactivate(code);
  await bot.sendMessage(chatId, ok ? `✅ Vendor ${code} deactivated.` : `Vendor ${code} not found.`);
}

async function handleListVendors(bot, chatId, userId, args) {
  const type = (args || '').trim().toLowerCase();
  const showFabric = !type || type === 'fabric';
  const showEmb = !type || type === 'emb';
  let text = '';
  if (showFabric) {
    const vendors = await fabricVendorsRepo.getActive();
    text += `*Fabric Vendors:* ${vendors.length ? vendors.map((v) => `${v.vendor_code} (${v.vendor_name})`).join(', ') : 'None'}\n`;
  }
  if (showEmb) {
    const vendors = await embVendorsRepo.getActive();
    text += `*EMB Vendors:* ${vendors.length ? vendors.map((v) => `${v.vendor_code} (${v.vendor_name})`).join(', ') : 'None'}`;
  }
  await bot.sendMessage(chatId, text || 'No vendors.', { parse_mode: 'Markdown' });
}

// ─── Rejections ───────────────────────────────────────────────────────────────

async function handleRejections(bot, chatId, userId, args) {
  if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Admin only.'); return; }
  const articleNo = (args || '').trim();
  const items = articleNo ? await mfgRejectionsRepo.getByArticle(articleNo) : await mfgRejectionsRepo.getPending();
  if (!items.length) { await bot.sendMessage(chatId, articleNo ? `No rejections for ${articleNo}.` : 'No pending rejections.'); return; }
  let text = `🔴 *Rejections${articleNo ? ` — ${articleNo}` : ' (Pending)'}*\n\n`;
  items.forEach((r, i) => {
    text += `${i + 1}. ${r.article_no} | Qty: ${r.qty} | ${r.reason || '—'} | ${r.from_stage}→${r.to_stage} | ${r.status}\n`;
  });
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

module.exports = {
  handleStageCommand, handleFlowReply,
  handleApproveArticle, handlePending, handleApprovalCallback,
  handleStatus, handlePipeline,
  handleAddVendor, handleRemoveVendor, handleListVendors,
  handleRejections,
};
