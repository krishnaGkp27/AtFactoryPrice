/**
 * Tappable task assignment + viewing flow (TG-7.5 Phase B slice).
 *
 * Surface:
 *   - act:assign_task        → start the 6-step in-place picker
 *   - act:my_tasks           → my-tasks view with inline Mark-done buttons
 *   - act:team_tasks         → team-tasks view (managers / admin only)
 *   - act:pending_signoff    → tasks submitted to me waiting for ✅/❌
 *
 * Callback namespace: `tsk:*`
 *   tsk:asn:<userId>          pick assignee
 *   tsk:asnpg:<page>          assignee picker pagination
 *   tsk:prio:<level>          pick priority
 *   tsk:due:<choice>          pick due preset
 *   tsk:skip:<field>          skip optional field (due, desc)
 *   tsk:back:<step>           ⬅ Back navigation
 *   tsk:cancel                ❌ Cancel
 *   tsk:confirm               ✅ Submit
 *   tsk:done:<taskId>         assignee marks done → submitted
 *   tsk:sign:ok:<taskId>      assigner approves a submitted task
 *   tsk:sign:no:<taskId>      assigner rejects a submitted task back to pending
 *
 * Sheet contract: existing Tasks sheet (9 cols, unchanged). Priority +
 * due-date are encoded into `description` as a structured prefix
 * `[P:<level>; due:<iso>]\n<free text>` so no schema migration is
 * required for v1.
 */

'use strict';

const usersRepository = require('../repositories/usersRepository');
const departmentsRepo = require('../repositories/departmentsRepository');
const tasksRepository = require('../repositories/tasksRepository');
const sessionStore = require('../utils/sessionStore');
const deptGraph = require('../org/deptGraph');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');

const PAGE_SIZE = 8;
const TITLE_MIN_LEN = 3;
const TITLE_MAX_LEN = 100;
const DESC_MAX_LEN = 500;

const PRIORITY_META = {
  critical: { icon: '🔴', label: 'Critical' },
  high:     { icon: '🟠', label: 'High' },
  normal:   { icon: '🟡', label: 'Normal' },
  low:      { icon: '⚪', label: 'Low' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAdmin(userId) {
  return auth.isAdmin(userId);
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const dd = String(d.getDate()).padStart(2, '0');
    const mmm = d.toLocaleString('en-US', { month: 'short' });
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}-${mmm}-${yy}`;
  } catch (_) {
    return iso;
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function encodeDescription({ priority, dueDate, description }) {
  const meta = `[P:${priority || 'normal'}${dueDate ? `; due:${dueDate}` : ''}]`;
  return description ? `${meta}\n${description}` : meta;
}

function decodeDescription(raw) {
  if (!raw) return { priority: 'normal', dueDate: null, text: '' };
  const m = raw.match(/^\[P:([a-z]+)(?:;\s*due:([0-9\-]+))?\]\n?([\s\S]*)$/i);
  if (!m) return { priority: 'normal', dueDate: null, text: String(raw) };
  return {
    priority: (m[1] || 'normal').toLowerCase(),
    dueDate: m[2] || null,
    text: (m[3] || '').trim(),
  };
}

async function editOrSend(bot, chatId, messageId, text, opts = {}) {
  if (messageId) {
    try {
      return await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...opts,
      });
    } catch (_) {
      // fall through to fresh send
    }
  }
  return bot.sendMessage(chatId, text, opts);
}

async function anchor(bot, chatId, userId, text, opts = {}) {
  const session = sessionStore.get(userId);
  const msgId = session && session.flowMessageId;
  const res = await editOrSend(bot, chatId, msgId, text, opts);
  if (session && res && typeof res === 'object' && res.message_id) {
    session.flowMessageId = res.message_id;
    sessionStore.set(userId, session);
  }
  return res;
}

function backRow(step) {
  return [
    { text: '⬅️ Back', callback_data: `tsk:back:${step}` },
    { text: '❌ Cancel', callback_data: 'tsk:cancel' },
  ];
}

function cancelRow() {
  return [{ text: '❌ Cancel', callback_data: 'tsk:cancel' }];
}

function canManage(user, isAdm) {
  if (isAdm) return true;
  return !!(user && Array.isArray(user.manages) && user.manages.length);
}

/** Returns the set of activity codes the Tasks hub should expose for this user. */
async function visibleTaskActivityCodes(userId) {
  const user = await usersRepository.findByUserId(userId);
  const isAdm = isAdmin(userId);
  // My Tasks is always available to any active user.
  const codes = ['my_tasks'];
  if (canManage(user, isAdm)) {
    codes.push('assign_task', 'team_tasks', 'pending_signoff');
  }
  return codes;
}

// ---------------------------------------------------------------------------
// Assign-task flow
// ---------------------------------------------------------------------------

async function startAssign(bot, chatId, userId, messageId) {
  const user = await usersRepository.findByUserId(userId);
  const isAdm = isAdmin(userId);
  if (!canManage(user, isAdm)) {
    await bot.sendMessage(chatId,
      'You can\'t assign tasks. Ask an admin to set you as manager of a department (Users sheet → `manages` column).');
    return;
  }

  sessionStore.set(userId, {
    type: 'task_assign_flow',
    step: 'assignee',
    flowMessageId: messageId || null,
    page: 0,
    data: { priority: 'normal' },
    actorIsAdmin: isAdm,
  });

  await renderAssigneePicker(bot, chatId, userId);
}

async function renderAssigneePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'task_assign_flow') return;

  const actor = await usersRepository.findByUserId(userId);
  const allUsers = await usersRepository.getAll();
  const depts = await departmentsRepo.getAll();
  const { graph } = deptGraph.validateForest(depts);

  const assignable = deptGraph.listAssignableUsers(actor, allUsers, graph, {
    isAdmin: !!session.actorIsAdmin,
    excludeSelf: true,
  });
  assignable.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  if (!assignable.length) {
    await anchor(bot, chatId, userId,
      '❗ No users available to assign tasks to.\n\nMake sure:\n• The Users sheet has active users.\n• Their `department` column is set.\n• If you\'re not admin, your `manages` column lists at least one department.',
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [cancelRow()] },
      });
    return;
  }

  const page = Math.max(0, session.page || 0);
  const totalPages = Math.max(1, Math.ceil(assignable.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  if (safePage !== page) {
    session.page = safePage;
    sessionStore.set(userId, session);
  }

  const slice = assignable.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const a = slice[i];
    const b = slice[i + 1];
    const row = [{
      text: `👤 ${a.name || a.user_id}`,
      callback_data: `tsk:asn:${a.user_id}`,
    }];
    if (b) {
      row.push({
        text: `👤 ${b.name || b.user_id}`,
        callback_data: `tsk:asn:${b.user_id}`,
      });
    }
    rows.push(row);
  }

  if (totalPages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: '⬅️ Prev', callback_data: `tsk:asnpg:${safePage - 1}` });
    nav.push({ text: `Page ${safePage + 1}/${totalPages}`, callback_data: 'tsk:noop' });
    if (safePage < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `tsk:asnpg:${safePage + 1}` });
    rows.push(nav);
  }

  rows.push(cancelRow());

  await anchor(bot, chatId, userId,
    '📌 *Assign Task*\n\nStep 1/6 — Who do you want to assign to?',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function renderTitlePrompt(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const assignee = session.data?.assigneeName || session.data?.assigneeUserId || '?';
  const titleShown = session.data?.title ? `\n\n_Current:_ ${escapeMd(session.data.title)}` : '';
  await anchor(bot, chatId, userId,
    `📌 *Assign Task*\n\nStep 2/6 — Reply with the *task title*.\n\nAssignee: *${escapeMd(assignee)}*${titleShown}\n\n_Min ${TITLE_MIN_LEN}, max ${TITLE_MAX_LEN} characters._`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [backRow('assignee')] },
    });
}

async function renderPriorityPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const cur = session.data?.priority || 'normal';
  const row = ['critical', 'high', 'normal', 'low'].map((p) => ({
    text: `${PRIORITY_META[p].icon} ${PRIORITY_META[p].label}${cur === p ? ' ✓' : ''}`,
    callback_data: `tsk:prio:${p}`,
  }));
  const rows = [row.slice(0, 2), row.slice(2, 4), backRow('title')];
  await anchor(bot, chatId, userId,
    `📌 *Assign Task*\n\nStep 3/6 — Pick *priority*.\n\nTitle: ${escapeMd(session.data.title)}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function renderDuePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const rows = [
    [
      { text: '📅 Today', callback_data: 'tsk:due:today' },
      { text: '📅 Tomorrow', callback_data: 'tsk:due:tomorrow' },
    ],
    [
      { text: '📅 In 3 days', callback_data: 'tsk:due:3d' },
      { text: '📅 This week', callback_data: 'tsk:due:week' },
    ],
    [{ text: '⏭️ Skip (no due date)', callback_data: 'tsk:skip:due' }],
    backRow('priority'),
  ];
  await anchor(bot, chatId, userId,
    '📌 *Assign Task*\n\nStep 4/6 — Pick a *due date* (optional).',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function renderDescriptionPrompt(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const rows = [
    [{ text: '⏭️ Skip (no description)', callback_data: 'tsk:skip:desc' }],
    backRow('due'),
  ];
  await anchor(bot, chatId, userId,
    `📌 *Assign Task*\n\nStep 5/6 — Reply with an optional *description* (max ${DESC_MAX_LEN} chars), or skip.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function renderConfirmCard(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const d = session.data || {};
  const pm = PRIORITY_META[d.priority || 'normal'];
  const lines = [
    '📌 *Assign Task — Confirm*',
    '',
    `👤 *Assignee:* ${escapeMd(d.assigneeName || d.assigneeUserId || '?')}`,
    `📝 *Title:* ${escapeMd(d.title || '')}`,
    `${pm.icon} *Priority:* ${pm.label}`,
    `📅 *Due:* ${d.dueDate ? fmtDate(d.dueDate) : '_none_'}`,
    `🗒 *Description:* ${d.description ? escapeMd(d.description) : '_none_'}`,
  ];
  const rows = [
    [{ text: '✅ Submit', callback_data: 'tsk:confirm' }],
    backRow('desc'),
  ];
  await anchor(bot, chatId, userId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

function escapeMd(s) {
  return String(s == null ? '' : s).replace(/([_*`\[\]])/g, '\\$1');
}

// ---------------------------------------------------------------------------
// Callback dispatcher
// ---------------------------------------------------------------------------

/**
 * Handle any callback whose data starts with `tsk:`. Returns true if
 * handled, false otherwise.
 */
async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('tsk:')) return false;
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // Always answer the callback so Telegram clears the spinner.
  try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) { /* noop */ }

  // Cancel — clear any active task_assign_flow session.
  if (data === 'tsk:cancel') {
    const s = sessionStore.get(userId);
    if (s && s.type === 'task_assign_flow') sessionStore.clear(userId);
    await editOrSend(bot, chatId, messageId, '❌ Task assignment cancelled.', {});
    return true;
  }

  if (data === 'tsk:noop') return true;

  // Standalone leaf callbacks: mark done / sign off — no flow session
  // required. These come from task cards previously DMed to users.
  if (data.startsWith('tsk:done:')) {
    await handleMarkDone(bot, callbackQuery, data.slice('tsk:done:'.length));
    return true;
  }
  if (data.startsWith('tsk:sign:ok:')) {
    await handleSignOff(bot, callbackQuery, data.slice('tsk:sign:ok:'.length), true);
    return true;
  }
  if (data.startsWith('tsk:sign:no:')) {
    await handleSignOff(bot, callbackQuery, data.slice('tsk:sign:no:'.length), false);
    return true;
  }

  // The remaining callbacks all require a live task_assign_flow session.
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'task_assign_flow') {
    await editOrSend(bot, chatId, messageId,
      '⏳ This task picker has expired. Open the menu and tap *Assign Task* again.',
      { parse_mode: 'Markdown' });
    return true;
  }
  session.flowMessageId = messageId;
  sessionStore.set(userId, session);

  if (data.startsWith('tsk:asnpg:')) {
    session.page = parseInt(data.slice('tsk:asnpg:'.length), 10) || 0;
    sessionStore.set(userId, session);
    await renderAssigneePicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('tsk:asn:')) {
    const targetId = data.slice('tsk:asn:'.length);
    const target = await usersRepository.findByUserId(targetId);
    if (!target) {
      await renderAssigneePicker(bot, chatId, userId);
      return true;
    }
    session.data.assigneeUserId = String(target.user_id);
    session.data.assigneeName = target.name || target.user_id;
    session.step = 'title';
    sessionStore.set(userId, session);
    await renderTitlePrompt(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('tsk:prio:')) {
    session.data.priority = data.slice('tsk:prio:'.length);
    session.step = 'due';
    sessionStore.set(userId, session);
    await renderDuePicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('tsk:due:')) {
    const choice = data.slice('tsk:due:'.length);
    const dueDate = choice === 'today' ? todayIso()
      : choice === 'tomorrow' ? addDays(1)
      : choice === '3d' ? addDays(3)
      : choice === 'week' ? addDays(7)
      : null;
    session.data.dueDate = dueDate;
    session.step = 'desc';
    sessionStore.set(userId, session);
    await renderDescriptionPrompt(bot, chatId, userId);
    return true;
  }

  if (data === 'tsk:skip:due') {
    session.data.dueDate = null;
    session.step = 'desc';
    sessionStore.set(userId, session);
    await renderDescriptionPrompt(bot, chatId, userId);
    return true;
  }

  if (data === 'tsk:skip:desc') {
    session.data.description = '';
    session.step = 'confirm';
    sessionStore.set(userId, session);
    await renderConfirmCard(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('tsk:back:')) {
    const target = data.slice('tsk:back:'.length);
    if (target === 'assignee') {
      session.step = 'assignee';
      sessionStore.set(userId, session);
      await renderAssigneePicker(bot, chatId, userId);
    } else if (target === 'title') {
      session.step = 'title';
      sessionStore.set(userId, session);
      await renderTitlePrompt(bot, chatId, userId);
    } else if (target === 'priority') {
      session.step = 'priority';
      sessionStore.set(userId, session);
      await renderPriorityPicker(bot, chatId, userId);
    } else if (target === 'due') {
      session.step = 'due';
      sessionStore.set(userId, session);
      await renderDuePicker(bot, chatId, userId);
    } else if (target === 'desc') {
      session.step = 'desc';
      sessionStore.set(userId, session);
      await renderDescriptionPrompt(bot, chatId, userId);
    }
    return true;
  }

  if (data === 'tsk:confirm') {
    await submitTask(bot, chatId, userId);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Text-step handler (title + description)
// ---------------------------------------------------------------------------

/**
 * Process a free-text message when a task_assign_flow session is active.
 * Returns true if it consumed the message, false otherwise (so the
 * caller can fall through to other handlers / NL).
 */
async function handleTextStep(bot, msg) {
  const userId = String(msg.from?.id || '');
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'task_assign_flow') return false;
  const text = (msg.text || '').trim();
  if (!text) return false;
  const chatId = msg.chat.id;

  if (session.step === 'title') {
    if (text.length < TITLE_MIN_LEN || text.length > TITLE_MAX_LEN) {
      await bot.sendMessage(chatId,
        `⚠️ Title must be between ${TITLE_MIN_LEN} and ${TITLE_MAX_LEN} characters. Please reply again.`);
      return true;
    }
    session.data.title = text;
    session.step = 'priority';
    sessionStore.set(userId, session);
    await renderPriorityPicker(bot, chatId, userId);
    return true;
  }

  if (session.step === 'desc') {
    if (text.length > DESC_MAX_LEN) {
      await bot.sendMessage(chatId,
        `⚠️ Description must be ≤ ${DESC_MAX_LEN} characters. Please reply again, or tap Skip.`);
      return true;
    }
    session.data.description = text;
    session.step = 'confirm';
    sessionStore.set(userId, session);
    await renderConfirmCard(bot, chatId, userId);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Submit / notify
// ---------------------------------------------------------------------------

async function submitTask(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'task_assign_flow') return;
  const d = session.data || {};
  if (!d.assigneeUserId || !d.title) {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, '⚠️ Missing required fields. Please restart.');
    return;
  }

  const description = encodeDescription({
    priority: d.priority || 'normal',
    dueDate: d.dueDate || null,
    description: d.description || '',
  });

  let created;
  try {
    created = await tasksRepository.append({
      title: d.title,
      description,
      assigned_to: d.assigneeUserId,
      assigned_by: userId,
      status: 'assigned',
    });
  } catch (e) {
    logger.error(`taskFlow.submit: append failed: ${e.message}`);
    await bot.sendMessage(chatId, '❌ Could not save the task. Please try again.');
    return;
  }

  sessionStore.clear(userId);
  const pm = PRIORITY_META[d.priority || 'normal'];

  // Confirm to assigner — edit the flow message.
  await editOrSend(bot, chatId, session.flowMessageId,
    `✅ Task assigned to *${escapeMd(d.assigneeName)}*\n\n` +
    `${pm.icon} *${escapeMd(d.title)}*\n` +
    `Due: ${d.dueDate ? fmtDate(d.dueDate) : '_none_'}\n` +
    `ID: \`${created.task_id}\``,
    { parse_mode: 'Markdown' });

  // DM the assignee with a card + Mark-done button.
  try {
    const dueLine = d.dueDate ? `\n📅 Due: ${fmtDate(d.dueDate)}` : '';
    const descLine = d.description ? `\n🗒 ${escapeMd(d.description)}` : '';
    const assignerUser = await usersRepository.findByUserId(userId);
    const fromLine = assignerUser ? `\n_From: ${escapeMd(assignerUser.name || userId)}_` : '';
    const silent = (d.priority === 'normal' || d.priority === 'low');
    await bot.sendMessage(d.assigneeUserId,
      `${pm.icon} *New Task — ${pm.label}*\n\n` +
      `📝 *${escapeMd(d.title)}*${dueLine}${descLine}${fromLine}\n\n` +
      `ID: \`${created.task_id}\``,
      {
        parse_mode: 'Markdown',
        disable_notification: silent,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Mark done', callback_data: `tsk:done:${created.task_id}` },
          ]],
        },
      });
  } catch (e) {
    logger.warn(`taskFlow.submit: could not DM assignee ${d.assigneeUserId}: ${e.message}`);
    await bot.sendMessage(chatId,
      '⚠️ Task saved but I couldn\'t message the assignee directly (they may not have started a chat with the bot yet).');
  }
}

// ---------------------------------------------------------------------------
// Assignee marks done → submitted
// ---------------------------------------------------------------------------

async function handleMarkDone(bot, callbackQuery, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  const task = await tasksRepository.getById(taskId);
  if (!task) {
    await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {});
    return;
  }
  if (task.assigned_to !== userId) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assignee can mark this done.', show_alert: true }).catch(() => {});
    return;
  }
  if (task.status !== 'assigned' && task.status !== 'active') {
    await editOrSend(bot, chatId, messageId,
      `ℹ️ Task ${taskId} is already *${task.status}*.`,
      { parse_mode: 'Markdown' });
    return;
  }

  await tasksRepository.updateStatus(taskId, 'submitted');

  const meta = decodeDescription(task.description);
  const pm = PRIORITY_META[meta.priority] || PRIORITY_META.normal;
  await editOrSend(bot, chatId, messageId,
    `⏳ *Submitted for sign-off*\n\n${pm.icon} ${escapeMd(task.title)}\nID: \`${taskId}\``,
    { parse_mode: 'Markdown' });

  // Ping the assigner with approve/reject buttons.
  try {
    await bot.sendMessage(task.assigned_by,
      `📨 *Task awaiting your sign-off*\n\n` +
      `${pm.icon} ${escapeMd(task.title)}\n` +
      `👤 By: ${escapeMd((await usersRepository.findByUserId(task.assigned_to))?.name || task.assigned_to)}\n` +
      `ID: \`${taskId}\``,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `tsk:sign:ok:${taskId}` },
            { text: '❌ Reject',  callback_data: `tsk:sign:no:${taskId}` },
          ]],
        },
      });
  } catch (e) {
    logger.warn(`taskFlow.markDone: could not notify assigner ${task.assigned_by}: ${e.message}`);
  }
}

async function handleSignOff(bot, callbackQuery, taskId, approve) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  const task = await tasksRepository.getById(taskId);
  if (!task) {
    await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {});
    return;
  }
  if (task.assigned_by !== userId && !isAdmin(userId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assigner or an admin can sign off.', show_alert: true }).catch(() => {});
    return;
  }
  if (task.status !== 'submitted') {
    await editOrSend(bot, chatId, messageId,
      `ℹ️ Task ${taskId} is *${task.status}*, not submitted.`,
      { parse_mode: 'Markdown' });
    return;
  }

  if (approve) {
    await tasksRepository.updateStatus(taskId, 'completed', new Date().toISOString());
    await editOrSend(bot, chatId, messageId,
      `✅ Task *${escapeMd(task.title)}* marked completed.\nID: \`${taskId}\``,
      { parse_mode: 'Markdown' });
    try {
      await bot.sendMessage(task.assigned_to,
        `✅ Your task is approved: *${escapeMd(task.title)}*`,
        { parse_mode: 'Markdown' });
    } catch (_) { /* noop */ }
  } else {
    await tasksRepository.updateStatus(taskId, 'active');
    await editOrSend(bot, chatId, messageId,
      `↩️ Task *${escapeMd(task.title)}* sent back to pending.\nID: \`${taskId}\``,
      { parse_mode: 'Markdown' });
    try {
      await bot.sendMessage(task.assigned_to,
        `↩️ Your task was sent back: *${escapeMd(task.title)}* — please re-check and tap Mark done again.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Mark done', callback_data: `tsk:done:${taskId}` },
            ]],
          },
        });
    } catch (_) { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// Read-only views
// ---------------------------------------------------------------------------

async function showMyTasks(bot, chatId, userId, messageId) {
  const tasks = await tasksRepository.getByAssignedTo(userId);
  if (!tasks.length) {
    await editOrSend(bot, chatId, messageId, 'You have no assigned tasks.', {});
    return;
  }
  // Pending / in_progress first, then submitted, then completed (newest 5).
  const open = tasks.filter((t) => t.status === 'assigned' || t.status === 'active');
  const submitted = tasks.filter((t) => t.status === 'submitted');
  const done = tasks.filter((t) => t.status === 'completed').slice(-5);

  const lines = ['📋 *Your Tasks*', ''];
  const rows = [];

  for (const t of open) {
    const m = decodeDescription(t.description);
    const pm = PRIORITY_META[m.priority] || PRIORITY_META.normal;
    lines.push(`${pm.icon} ${escapeMd(t.title)}  \`${t.task_id}\``);
    if (m.dueDate) lines.push(`     📅 ${fmtDate(m.dueDate)}`);
    rows.push([{ text: `✅ Done — ${truncate(t.title, 30)}`, callback_data: `tsk:done:${t.task_id}` }]);
  }
  if (submitted.length) {
    lines.push('', '⏳ *Waiting on sign-off:*');
    for (const t of submitted) lines.push(`   ${escapeMd(t.title)}  \`${t.task_id}\``);
  }
  if (done.length) {
    lines.push('', '✅ *Recently completed:*');
    for (const t of done) lines.push(`   ${escapeMd(t.title)}`);
  }

  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function showTeamTasks(bot, chatId, userId, messageId) {
  const isAdm = isAdmin(userId);
  const actor = await usersRepository.findByUserId(userId);
  if (!canManage(actor, isAdm)) {
    await editOrSend(bot, chatId, messageId,
      'You don\'t manage any department, so there are no team tasks to show.', {});
    return;
  }
  const allUsers = await usersRepository.getAll();
  const depts = await departmentsRepo.getAll();
  const { graph } = deptGraph.validateForest(depts);
  const team = deptGraph.listAssignableUsers(actor, allUsers, graph, {
    isAdmin: isAdm, excludeSelf: false,
  });
  const teamIds = team.map((u) => String(u.user_id));
  const tasks = await tasksRepository.getByAssignedToMany(teamIds);
  if (!tasks.length) {
    await editOrSend(bot, chatId, messageId, 'No tasks for your team yet.', {});
    return;
  }
  const nameById = new Map(team.map((u) => [String(u.user_id), u.name || u.user_id]));
  const open = tasks.filter((t) =>
    t.status === 'assigned' || t.status === 'active' || t.status === 'submitted'
    || t.status === 'awaiting_timeline_ack' || t.status === 'awaiting_incentive'
    || t.status === 'awaiting_final_ack');
  const recent = tasks.filter((t) => t.status === 'completed').slice(-5);

  const lines = ['👥 *Team Tasks*', ''];
  if (!open.length) {
    lines.push('_No open tasks._');
  } else {
    for (const t of open) {
      const m = decodeDescription(t.description);
      const pm = PRIORITY_META[m.priority] || PRIORITY_META.normal;
      const status = t.status === 'submitted' ? ' ⏳' : '';
      lines.push(`${pm.icon} ${escapeMd(t.title)}${status}`);
      lines.push(`     👤 ${escapeMd(nameById.get(t.assigned_to) || t.assigned_to)}${m.dueDate ? ` · 📅 ${fmtDate(m.dueDate)}` : ''}  \`${t.task_id}\``);
    }
  }
  if (recent.length) {
    lines.push('', '✅ *Recently completed:*');
    for (const t of recent) {
      lines.push(`   ${escapeMd(t.title)} — ${escapeMd(nameById.get(t.assigned_to) || t.assigned_to)}`);
    }
  }
  await editOrSend(bot, chatId, messageId, lines.join('\n'), { parse_mode: 'Markdown' });
}

async function showPendingSignOff(bot, chatId, userId, messageId) {
  const isAdm = isAdmin(userId);
  const tasks = isAdm
    ? await tasksRepository.getSubmittedPendingApproval()
    : await tasksRepository.getSubmittedForAssigner(userId);
  if (!tasks.length) {
    await editOrSend(bot, chatId, messageId, 'No tasks waiting for your sign-off.', {});
    return;
  }
  const lines = ['⏳ *Pending Sign-off*', ''];
  const rows = [];
  for (const t of tasks) {
    const m = decodeDescription(t.description);
    const pm = PRIORITY_META[m.priority] || PRIORITY_META.normal;
    const by = (await usersRepository.findByUserId(t.assigned_to))?.name || t.assigned_to;
    lines.push(`${pm.icon} ${escapeMd(t.title)}  \`${t.task_id}\``);
    lines.push(`     👤 ${escapeMd(by)}`);
    rows.push([
      { text: `✅ Approve ${truncate(t.title, 22)}`, callback_data: `tsk:sign:ok:${t.task_id}` },
      { text: '❌ Reject', callback_data: `tsk:sign:no:${t.task_id}` },
    ]);
  }
  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

module.exports = {
  visibleTaskActivityCodes,
  startAssign,
  handleCallback,
  handleTextStep,
  showMyTasks,
  showTeamTasks,
  showPendingSignOff,
  // exported for unit tests / smoke
  encodeDescription,
  decodeDescription,
};
