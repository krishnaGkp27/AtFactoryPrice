/**
 * USR-C3b / USR-C4 — Promote Admin & Deactivate User flows.
 *
 * Two small admin activities that share a common 3-step pattern:
 *   1. Pick the target user (paginated list of active employees/managers)
 *   2. Confirm
 *   3. Submit → dual-admin approval queue
 *
 * They are intentionally bundled in one file because they share ~90% of
 * scaffolding (target picker, confirm card, submit wiring). The differ-
 * entiator is the `action` field on the submitted approval payload and
 * the post-approval execution branch in inventoryService:
 *
 *   promote_admin    → role: 'admin'.   APPROVAL gated by SUPER_ADMIN_IDS
 *                                       (enforced in approvalEvents).
 *   deactivate_user  → status: 'inactive'. Dual-admin (any two admins).
 *
 * Callback namespace: `umg:*`
 *   umg:start:<promote|deactivate>     entry (from activity hub)
 *   umg:pick:<tgId>                    select target
 *   umg:page:<n>                       paginate picker
 *   umg:submit                         submit confirm
 *   umg:back:<step>                    back navigation
 *   umg:cancel                         cancel
 *
 * Session shape:
 *   { type: 'user_manage_flow', flow: 'promote'|'deactivate',
 *     step: 'pick'|'confirm', flowMessageId, page,
 *     target: { telegram_id, name, role, status, departments[] } | null }
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const auth = require('../middlewares/auth');
const usersRepo = require('../repositories/usersRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const approvalEvents = require('../events/approvalEvents');
const riskEvaluate = require('../risk/evaluate');
const idGenerator = require('../utils/idGenerator');
const logger = require('../utils/logger');

const PAGE_SIZE = 8;

/**
 * Escape Telegram Markdown-v1 reserved characters in user-supplied values so a
 * stray "_", "*", "`" or "[" in a name/department cannot break entity parsing
 * on the confirm card (USR-C4 deactivate bug: ETELEGRAM 400 "can't parse
 * entities" / "can't find end of the entity").
 */
function mdEscape(s) {
  return String(s == null ? '' : s).replace(/([_*`\[\]])/g, '\\$1');
}

const FLOW_LABEL = {
  promote: { title: '👑 Promote to Admin', verb: 'promote', actionField: 'promote_admin', successHint: 'super-admin' },
  deactivate: { title: '🛑 Deactivate User',  verb: 'deactivate',  actionField: 'deactivate_user', successHint: '2nd admin' },
};

async function render(bot, chatId, userId, text, keyboardRows) {
  const session = sessionStore.get(userId);
  const reply_markup = { inline_keyboard: keyboardRows };
  // Try edit-md → edit-plain → send-md → send-plain. The plain-text fallbacks
  // guarantee the step is always delivered even if a stray Markdown character
  // in user-supplied data (name/department) trips Telegram's entity parser —
  // otherwise the throw surfaces as "Lookup failed: ETELEGRAM 400".
  if (session && session.flowMessageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: session.flowMessageId,
        parse_mode: 'Markdown', reply_markup, disable_web_page_preview: true,
      });
      return session.flowMessageId;
    } catch (e1) {
      try {
        await bot.editMessageText(text, {
          chat_id: chatId, message_id: session.flowMessageId,
          reply_markup, disable_web_page_preview: true,
        });
        return session.flowMessageId;
      } catch (_) { /* fall through to a fresh send */ }
    }
  }
  let sent;
  try {
    sent = await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown', reply_markup, disable_web_page_preview: true,
    });
  } catch (e2) {
    sent = await bot.sendMessage(chatId, text, {
      reply_markup, disable_web_page_preview: true,
    });
  }
  if (session) {
    session.flowMessageId = sent.message_id;
    sessionStore.set(userId, session);
  }
  return sent.message_id;
}

function cancelRow() { return [{ text: '❌ Cancel', callback_data: 'umg:cancel' }]; }
function backCancelRow(backStep) {
  return [
    { text: '⬅ Back', callback_data: `umg:back:${backStep}` },
    { text: '❌ Cancel', callback_data: 'umg:cancel' },
  ];
}

async function renderError(bot, chatId, userId, msg, backStep) {
  await render(bot, chatId, userId,
    `⚠️ ${msg}\n\n_Try a different choice or step back._`,
    [backCancelRow(backStep || 'pick')]);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function start(bot, chatId, userId, messageId, which /* 'promote' | 'deactivate' */) {
  if (!auth.isAdmin(userId)) {
    try { await bot.sendMessage(chatId, 'Admin only.'); } catch (_) {}
    return;
  }
  const flow = (which === 'promote' || which === 'deactivate') ? which : 'promote';
  sessionStore.set(userId, {
    type: 'user_manage_flow',
    flow,
    step: 'pick',
    flowMessageId: messageId || null,
    page: 0,
    target: null,
    startedAt: new Date().toISOString(),
  });
  await renderPickStep(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Step 1 — pick target (paginated list of active users)
// ---------------------------------------------------------------------------

async function _eligibleUsers(flow) {
  const all = await usersRepo.getAll();
  const active = all.filter((u) => (u.status || 'active') === 'active' && u.user_id);
  if (flow === 'promote') {
    // Cannot promote an existing admin to admin.
    return active.filter((u) => String(u.role || '').toLowerCase() !== 'admin');
  }
  // Deactivate: any active user (admin included — but they need to be
  // demoted to non-admin elsewhere; we still allow deactivation here).
  return active;
}

async function renderPickStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const label = FLOW_LABEL[session.flow] || FLOW_LABEL.promote;
  let users = [];
  try { users = await _eligibleUsers(session.flow); } catch (e) { logger.warn(`userManageFlow: getAll failed: ${e.message}`); }

  if (!users.length) {
    await render(bot, chatId, userId,
      `${label.title}\n\n_No eligible users to ${label.verb}._\n\nMake sure there are active employees/managers in the Users sheet.`,
      [[{ text: '🏠 Back to menu', callback_data: 'menu:home' }]],
    );
    return;
  }
  users.sort((a, b) => (a.name || a.user_id).localeCompare(b.name || b.user_id));
  const total = users.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(0, session.page || 0), pages - 1);
  const slice = users.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const rows = [];
  for (const u of slice) {
    const dept = (u.departments && u.departments[0]) || u.department || '';
    const tag = dept ? ` · ${dept}` : '';
    rows.push([{
      text: `👤 ${u.name || u.user_id}${tag} · ${u.role || 'employee'}`,
      callback_data: `umg:pick:${u.user_id}`,
    }]);
  }
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `umg:page:${page - 1}` });
    nav.push({ text: `Page ${page + 1}/${pages}`, callback_data: 'umg:noop' });
    if (page < pages - 1) nav.push({ text: 'Next ➡️', callback_data: `umg:page:${page + 1}` });
    rows.push(nav);
  }
  rows.push(cancelRow());
  await render(bot, chatId, userId,
    `${label.title}\n\n_Step 1 of 2 — pick the user to ${label.verb}._`,
    rows,
  );
}

// ---------------------------------------------------------------------------
// Step 2 — confirm + submit
// ---------------------------------------------------------------------------

async function renderConfirmStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.target) return;
  const label = FLOW_LABEL[session.flow];
  const t = session.target;
  const dept = (t.departments && t.departments.length) ? t.departments.join(', ') : (t.department || '—');
  const note = session.flow === 'promote'
    ? '\n\n_Promoting grants this user admin power: they can submit and (with one other admin) approve dual-admin actions. **Approval of this request itself requires SUPER_ADMIN.**_'
    : '\n\n_Deactivating revokes bot access on the next message; the row + full history are preserved. Re-activation requires another in-bot flow._';
  await render(bot, chatId, userId,
    `${label.title} — *Confirm*\n\n_Step 2 of 2_\n\n`
    + `*Name:* ${mdEscape(t.name || '—')}\n`
    + `*Telegram ID:* \`${t.telegram_id}\`\n`
    + `*Role today:* ${mdEscape(t.role || 'employee')}\n`
    + `*Department:* ${mdEscape(dept)}\n`
    + `${note}\n\n`
    + `_Submitting queues this for ${label.successHint} approval — you cannot self-approve._`,
    [
      [{ text: '✅ Submit for approval', callback_data: 'umg:submit' }],
      backCancelRow('pick'),
    ],
  );
}

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'user_manage_flow' || !session.target) return;
  const label = FLOW_LABEL[session.flow];
  const t = session.target;
  const aj = {
    action: label.actionField,
    telegram_id: t.telegram_id,
    name: t.name || '',
  };
  try {
    const risk = await riskEvaluate.evaluate({ action: label.actionField, userId });
    const requestId = idGenerator.requestId();
    await approvalQueueRepository.append({
      requestId, user: userId, actionJSON: aj,
      riskReason: risk.reason || 'dual_admin_required', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, action: label.actionField }, userId);
    const isAdm = auth.isAdmin(userId);
    const excludeId = isAdm ? userId : undefined;
    const safeName = mdEscape(t.name || t.telegram_id);
    const summary = session.flow === 'promote'
      ? `👑 Promote to admin: *${safeName}* (\`${t.telegram_id}\`)`
      : `🛑 Deactivate user: *${safeName}* (\`${t.telegram_id}\`)`;
    await approvalEvents.notifyAdminsApprovalRequest(
      bot, requestId, String(userId), summary, risk.reason, excludeId,
    );
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      `⏳ *Submitted for ${label.successHint} approval*\n\n${summary.replace(/^👑 |^🛑 /, '')}\nRequest: \`${requestId}\``,
      [[{ text: '🏠 Back to menu', callback_data: 'menu:home' }]],
    );
  } catch (e) {
    logger.error(`userManageFlow.submit failed: ${e.message}`);
    await renderError(bot, chatId, userId, `Could not queue: ${e.message}`, 'pick');
  }
}

// ---------------------------------------------------------------------------
// Callback dispatcher — umg:*
// ---------------------------------------------------------------------------

async function handleCallback(bot, query) {
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);
  const data = query.data || '';
  if (!data.startsWith('umg:')) return false;
  // `umg:start:*` is the one callback we accept WITHOUT an existing session.
  if (data.startsWith('umg:start:')) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    const which = data.slice('umg:start:'.length);
    await start(bot, query.message.chat.id, userId, query.message.message_id, which);
    return true;
  }
  if (!session || session.type !== 'user_manage_flow') return false;
  const chatId = query.message.chat.id;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === 'umg:cancel') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '_Cancelled._',
      [[{ text: '🏠 Back to menu', callback_data: 'menu:home' }]]);
    return true;
  }
  if (data === 'umg:noop') return true;
  if (data.startsWith('umg:page:')) {
    session.page = parseInt(data.slice('umg:page:'.length), 10) || 0;
    sessionStore.set(userId, session);
    await renderPickStep(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('umg:pick:')) {
    const tgId = data.slice('umg:pick:'.length);
    try {
      const target = await usersRepo.findByUserId(tgId);
      if (!target) { await renderError(bot, chatId, userId, 'User not found.'); return true; }
      if (session.flow === 'promote' && String(target.role || '').toLowerCase() === 'admin') {
        await renderError(bot, chatId, userId, 'This user is already an admin.'); return true;
      }
      // usersRepository exposes the id as `user_id` (the Users-sheet user_id
      // IS the Telegram ID); the confirm card + approval payload read
      // `telegram_id`, so populate it from the picked id.
      target.telegram_id = String(target.user_id || tgId);
      session.target = target;
      session.step = 'confirm';
      sessionStore.set(userId, session);
      await renderConfirmStep(bot, chatId, userId);
    } catch (e) {
      await renderError(bot, chatId, userId, `Lookup failed: ${e.message}`);
    }
    return true;
  }
  if (data === 'umg:back:pick') {
    session.step = 'pick';
    session.target = null;
    sessionStore.set(userId, session);
    await renderPickStep(bot, chatId, userId);
    return true;
  }
  if (data === 'umg:submit') {
    await submit(bot, chatId, userId);
    return true;
  }
  return false;
}

module.exports = {
  start,
  handleCallback,
  // exported for tests:
  _internals: { PAGE_SIZE, FLOW_LABEL, mdEscape },
};
