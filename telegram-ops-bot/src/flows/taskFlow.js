/**
 * Tappable task assignment + negotiation flow (TG-7.5 Phase C — commit 3).
 *
 * Surface:
 *   - act:assign_task        → 6-step in-place picker (Track replaces Due Date)
 *   - act:my_tasks           → my-tasks view; buttons reflect current status
 *   - act:team_tasks         → team-tasks view (managers / admin only) — no money
 *   - act:pending_signoff    → tasks submitted to me waiting for ✅/❌
 *
 * Workflow (drives `src/flows/taskStateMachine.js`):
 *   assigned                 →  doer taps [⏱ Propose timeline] OR [❌ Decline]
 *   awaiting_timeline_ack    →  assigner taps [✅ Accept] OR [↩ Counter]
 *   awaiting_incentive       →  assigner enters ₦ amount (or Skip → ₦0)
 *                               *only* on incentivized track
 *   awaiting_final_ack       →  doer taps [✅ Accept deal] OR [↩ Renegotiate]
 *   active                   →  doer taps [✅ Mark done]
 *   submitted                →  assigner taps [✅ Approve] OR [❌ Reject]
 *   completed                →  terminal
 *
 * Three negotiation loops (counter, renegotiate) share a hard cap of 3
 * rounds per task (enforced by the state-machine engine).
 *
 * Callback namespace: `tsk:*` (full list in inline keyboards below).
 */

'use strict';

const usersRepository = require('../repositories/usersRepository');
const departmentsRepo = require('../repositories/departmentsRepository');
const tasksRepository = require('../repositories/tasksRepository');
const taskEventsRepository = require('../repositories/taskEventsRepository');
const incentivesRepository = require('../repositories/incentivesRepository');
const taskStateMachine = require('./taskStateMachine');
const sessionStore = require('../utils/sessionStore');
const deptGraph = require('../org/deptGraph');
const auth = require('../middlewares/auth');
const config = require('../config');
const logger = require('../utils/logger');
const adminFeed = require('../services/adminFeed');
// taskFlow renders incentives in DMs/inline rows where the symbol form
// ("₦5,000") reads better than the long form. Centralized helpers live in
// utils/format and utils/telegramUI.
const { fmtMoneyShort: fmtMoney } = require('../utils/format');
const { editOrSend } = require('../utils/telegramUI');

const PAGE_SIZE = 8;
const TITLE_MIN_LEN = 3;
const TITLE_MAX_LEN = 100;
const DESC_MAX_LEN = 500;
const COUNTER_REASON_MAX_LEN = 200;
const INCENTIVE_MAX = 100_000_000;

const PRIORITY_META = {
  critical: { icon: '🔴', label: 'Critical' },
  high:     { icon: '🟠', label: 'High' },
  normal:   { icon: '🟡', label: 'Normal' },
  low:      { icon: '⚪', label: 'Low' },
};

const TRACK_META = {
  salaried:     { icon: '📋', label: 'Salaried',     hint: 'No incentive — covered by salary' },
  incentivized: { icon: '💰', label: 'Incentivized', hint: 'Doer can earn an extra ₦ bonus' },
};

const STATUS_LABEL = {
  assigned:              { icon: '📨', label: 'Waiting for you to propose timeline' },
  awaiting_timeline_ack: { icon: '⌛', label: 'Waiting for assigner to accept timeline' },
  awaiting_incentive:    { icon: '⌛', label: 'Waiting for assigner to set incentive' },
  awaiting_final_ack:    { icon: '⌛', label: 'Waiting for you to accept the deal' },
  active:                { icon: '🟢', label: 'In progress' },
  submitted:             { icon: '⏳', label: 'Waiting on sign-off' },
  completed:             { icon: '✅', label: 'Completed' },
  declined:              { icon: '🚫', label: 'Declined' },
  cancelled:             { icon: '❌', label: 'Cancelled' },
  dropped:               { icon: '🚫', label: 'Dropped by manager' },
};

// Numeric rank used to sort tasks by urgency. Critical first.
const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 };

// Tasks that are still moving (not yet terminal). Manager controls
// (re-prioritize, drop-off) gate on this set.
const OPEN_STATUSES = new Set([
  'assigned', 'awaiting_timeline_ack', 'awaiting_incentive',
  'awaiting_final_ack', 'active', 'submitted',
]);

const HOURS_PRESETS = [
  ['1h', 1], ['2h', 2], ['4h', 4], ['8h', 8],
  ['1d', 24], ['2d', 48], ['5d', 120], ['1w', 168],
];

const DEADLINE_PRESETS = [
  ['today', 'Today', 0],
  ['tomorrow', 'Tomorrow', 1],
  ['3d', '+3 days', 3],
  ['1w', '+1 week', 7],
  ['2w', '+2 weeks', 14],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAdmin(userId) { return auth.isAdmin(userId); }
function isFinance(userId) {
  const ids = (config && config.access && config.access.financeIds) || [];
  return ids.includes(String(userId));
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const dd = String(d.getDate()).padStart(2, '0');
    const mmm = d.toLocaleString('en-US', { month: 'short' });
    // 4-digit year to match the canonical fmtDate() output (DD-MMM-YYYY).
    const yyyy = String(d.getFullYear());
    return `${dd}-${mmm}-${yyyy}`;
  } catch (_) { return iso; }
}

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayYM() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function addMonthsYM(ym, delta) {
  const [y, m] = ym.split('-').map((s) => parseInt(s, 10));
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function ymCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const CAL_MAX_FORWARD_MONTHS = 6;

function fmtHours(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n)) return '?';
  if (n < 24) return `${n}h`;
  const d = Math.round(n / 24 * 10) / 10;
  return `${d}d`;
}

/**
 * Legacy reader — older tasks (created before commit 3) encoded priority
 * + due-date as a `[P:high; due:2026-05-12]\n<text>` prefix in the
 * description column. Newer tasks use real columns. This decoder is
 * tolerant of both shapes.
 */
function decodeLegacyDescription(raw) {
  if (!raw) return { priority: null, dueDate: null, text: '' };
  const m = raw.match(/^\[P:([a-z]+)(?:;\s*due:([0-9\-]+))?\]\n?([\s\S]*)$/i);
  if (!m) return { priority: null, dueDate: null, text: String(raw) };
  return {
    priority: (m[1] || '').toLowerCase() || null,
    dueDate: m[2] || null,
    text: (m[3] || '').trim(),
  };
}

function getPriority(task) {
  const dec = decodeLegacyDescription(task.description);
  return task.priority || dec.priority || 'normal';
}

function getDescriptionText(task) {
  const dec = decodeLegacyDescription(task.description);
  return dec.text || '';
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

function navFooterRow() {
  return [
    { text: '⬅ Back to Tasks', callback_data: 'act:__hub__:tasks' },
    { text: '🏠 Menu',          callback_data: 'act:__back__' },
  ];
}

function firstStepFooterRow() {
  return [
    { text: '⬅ Back to Tasks', callback_data: 'act:__hub__:tasks' },
    { text: '❌ Cancel',        callback_data: 'tsk:cancel' },
  ];
}

function canManage(user, isAdm) {
  if (isAdm) return true;
  return !!(user && Array.isArray(user.manages) && user.manages.length);
}

/** Activities the Tasks hub should expose to this user. */
async function visibleTaskActivityCodes(userId) {
  const user = await usersRepository.findByUserId(userId);
  const isAdm = isAdmin(userId);
  const codes = ['my_tasks'];
  if (canManage(user, isAdm)) codes.push('assign_task', 'team_tasks', 'pending_signoff');
  // Payouts is finance-only — it's the one surface that reads the
  // Incentives sheet and writes paid_status. Money stays gated.
  if (isFinance(userId)) codes.push('payouts');
  return codes;
}

function escapeMd(s) {
  return String(s == null ? '' : s).replace(/([_*`\[\]])/g, '\\$1');
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

function priorityIsSilent(priority) {
  return priority === 'normal' || priority === 'low';
}

// ---------------------------------------------------------------------------
// ASSIGN-TASK PICKER (6 steps: assignee → title → priority → track → desc → confirm)
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
    data: { priority: 'normal', track: 'salaried' },
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
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [firstStepFooterRow()] } });
    return;
  }

  const page = Math.max(0, session.page || 0);
  const totalPages = Math.max(1, Math.ceil(assignable.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  if (safePage !== page) { session.page = safePage; sessionStore.set(userId, session); }

  const slice = assignable.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const a = slice[i];
    const b = slice[i + 1];
    const row = [{ text: `👤 ${a.name || a.user_id}`, callback_data: `tsk:asn:${a.user_id}` }];
    if (b) row.push({ text: `👤 ${b.name || b.user_id}`, callback_data: `tsk:asn:${b.user_id}` });
    rows.push(row);
  }

  if (totalPages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: '⬅️ Prev', callback_data: `tsk:asnpg:${safePage - 1}` });
    nav.push({ text: `Page ${safePage + 1}/${totalPages}`, callback_data: 'tsk:noop' });
    if (safePage < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `tsk:asnpg:${safePage + 1}` });
    rows.push(nav);
  }
  rows.push(firstStepFooterRow());

  // Admin sees the whole company; managers see only their subtree. Make
  // the active mode visible so admin understands the breadth of the list
  // and managers understand the constraint without surprise.
  const scopeBadge = session.actorIsAdmin
    ? `🛡 *Admin mode* — showing all ${assignable.length} active employees`
    : `👥 *Manager mode* — showing ${assignable.length} from your reporting subtree`;

  // UX-C3: once the list has 4+ people, the bare-button picker gets hard
  // to scan ("which Mohammad?", "which warehouse?"). Render a compact
  // subtitle list above the buttons — same order as the buttons — so the
  // admin can match by index. Under 4 people we keep the screen sparse.
  let subtitle = '';
  if (slice.length >= 4) {
    const meta = (u) => {
      const dept = u.department ? u.department : '';
      const wh = Array.isArray(u.warehouses) && u.warehouses.length
        ? u.warehouses.join('/') : '';
      const parts = [dept, wh].filter(Boolean);
      return parts.length ? ` · ${parts.join(' · ')}` : '';
    };
    subtitle = '\n\n' + slice.map((u) => `• ${u.name || u.user_id}${meta(u)}`).join('\n');
  }

  await anchor(bot, chatId, userId,
    `📌 *Assign Task*\n\nStep 1/6 — Who do you want to assign to?\n\n${scopeBadge}${subtitle}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function renderTitlePrompt(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const assignee = session.data?.assigneeName || session.data?.assigneeUserId || '?';
  const titleShown = session.data?.title ? `\n\n_Current:_ ${escapeMd(session.data.title)}` : '';
  await anchor(bot, chatId, userId,
    `📌 *Assign Task*\n\nStep 2/6 — Reply with the *task title*.\n\nAssignee: *${escapeMd(assignee)}*${titleShown}\n\n_Min ${TITLE_MIN_LEN}, max ${TITLE_MAX_LEN} characters._`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [backRow('assignee')] } });
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

async function renderTrackPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const cur = session.data?.track || 'salaried';
  const rows = [
    [{
      text: `${TRACK_META.salaried.icon} Salaried${cur === 'salaried' ? ' ✓' : ''}`,
      callback_data: 'tsk:trk:salaried',
    }],
    [{
      text: `${TRACK_META.incentivized.icon} Incentivized${cur === 'incentivized' ? ' ✓' : ''}`,
      callback_data: 'tsk:trk:incentivized',
    }],
    backRow('priority'),
  ];
  await anchor(bot, chatId, userId,
    '📌 *Assign Task*\n\nStep 4/6 — Pick a *track*:\n\n' +
    `• ${TRACK_META.salaried.icon} *Salaried* — ${TRACK_META.salaried.hint}.\n` +
    `• ${TRACK_META.incentivized.icon} *Incentivized* — ${TRACK_META.incentivized.hint}. You\'ll be asked to set the amount AFTER the doer proposes a timeline you accept.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function renderDescriptionPrompt(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const rows = [
    [{ text: '⏭️ Skip (no description)', callback_data: 'tsk:skip:desc' }],
    backRow('track'),
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
  const tm = TRACK_META[d.track || 'salaried'];
  const lines = [
    '📌 *Assign Task — Confirm*', '',
    `👤 *Assignee:* ${escapeMd(d.assigneeName || d.assigneeUserId || '?')}`,
    `📝 *Title:* ${escapeMd(d.title || '')}`,
    `${pm.icon} *Priority:* ${pm.label}`,
    `${tm.icon} *Track:* ${tm.label}`,
    `🗒 *Description:* ${d.description ? escapeMd(d.description) : '_none_'}`,
    '',
    '_Once you submit, the assignee gets a DM and must propose how long they\'ll take + by when._',
  ];
  const rows = [
    [{ text: '✅ Submit', callback_data: 'tsk:confirm' }],
    backRow('desc'),
  ];
  await anchor(bot, chatId, userId, lines.join('\n'), {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows },
  });
}

async function submitTask(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'task_assign_flow') return;
  const d = session.data || {};
  if (!d.assigneeUserId || !d.title) {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, '⚠️ Missing required fields. Please restart.');
    return;
  }

  let created;
  try {
    // Plain description: priority + track now live in real columns.
    created = await taskStateMachine.create({
      title: d.title,
      description: d.description || '',
      assigned_to: d.assigneeUserId,
      assigned_by: userId,
      track: d.track || 'salaried',
      priority: d.priority || 'normal',
    });
  } catch (e) {
    logger.error(`taskFlow.submit: create failed: ${e.message}`);
    await bot.sendMessage(chatId, '❌ Could not save the task. Please try again.');
    return;
  }

  sessionStore.clear(userId);
  const pm = PRIORITY_META[d.priority || 'normal'];
  const tm = TRACK_META[d.track || 'salaried'];

  await editOrSend(bot, chatId, session.flowMessageId,
    `✅ Task assigned to *${escapeMd(d.assigneeName)}*\n\n` +
    `${pm.icon} *${escapeMd(d.title)}*\n` +
    `${tm.icon} ${tm.label}\n` +
    `ID: \`${created.task_id}\`\n\n` +
    `_${d.assigneeName} now sees the task in their chat and will propose how long it will take + by when. You\'ll be notified to accept or counter their proposal._`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });

  await dmAssigneeNewTask(bot, created, userId);

  // T2: broadcast to opted-in admins (the assigner is excluded so the
  // person who just clicked Submit doesn't get an echo of their own action).
  try {
    const assignerName = (await usersRepository.findByUserId(userId))?.name || userId;
    await adminFeed.notify(bot, 'task.assigned',
      `📌 *Task assigned*\n\n${pm.icon} ${escapeMd(d.title)}\n` +
      `${tm.icon} ${tm.label}\n` +
      `👤 ${escapeMd(d.assigneeName)} ← ${escapeMd(assignerName)}\n` +
      `ID: \`${created.task_id}\``,
      { parse_mode: 'Markdown' }, { excludeUserId: userId });
  } catch (e) {
    logger.warn(`taskFlow.submit: adminFeed task.assigned: ${e.message}`);
  }
}

/** Send the new-task DM card to the assignee with Propose-timeline / Decline. */
async function dmAssigneeNewTask(bot, task, assignerUserId) {
  try {
    const pm = PRIORITY_META[task.priority] || PRIORITY_META.normal;
    const tm = TRACK_META[task.track] || TRACK_META.salaried;
    const descLine = task.description ? `\n🗒 ${escapeMd(task.description)}` : '';
    const assignerUser = await usersRepository.findByUserId(assignerUserId);
    const fromLine = assignerUser ? `\n_From: ${escapeMd(assignerUser.name || assignerUserId)}_` : '';
    const incentiveHint = task.track === 'incentivized'
      ? '\n\n💰 _Incentivized track — your assigner will set a bonus after they accept your timeline._'
      : '';
    await bot.sendMessage(task.assigned_to,
      `${pm.icon} *New Task — ${pm.label}*\n${tm.icon} ${tm.label}\n\n` +
      `📝 *${escapeMd(task.title)}*${descLine}${fromLine}\n\n` +
      `*How long do you need, and by when?*${incentiveHint}\n\n` +
      `ID: \`${task.task_id}\``,
      {
        parse_mode: 'Markdown',
        disable_notification: priorityIsSilent(task.priority),
        reply_markup: {
          inline_keyboard: [[
            { text: '⏱ Propose timeline', callback_data: `tsk:prp:${task.task_id}` },
            { text: '❌ Decline',          callback_data: `tsk:dec:${task.task_id}` },
          ]],
        },
      });
  } catch (e) {
    logger.warn(`taskFlow.dmAssigneeNewTask: could not DM ${task.assigned_to}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// PROPOSE-TIMELINE FLOW (doer-side)
// ---------------------------------------------------------------------------

async function startProposeFlow(bot, callbackQuery, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  const task = await tasksRepository.getById(taskId);
  if (!task) {
    await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {});
    return;
  }
  if (task.assigned_to !== userId) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assignee can propose a timeline.', show_alert: true }).catch(() => {});
    return;
  }
  if (task.status !== 'assigned') {
    await editOrSend(bot, chatId, messageId,
      `ℹ️ Task ${taskId} is *${task.status}* — proposing a timeline is no longer possible.`,
      { parse_mode: 'Markdown' });
    return;
  }

  sessionStore.set(userId, {
    type: 'task_propose_flow',
    step: 'hours',
    flowMessageId: messageId,
    data: { taskId, taskTitle: task.title, taskPriority: task.priority, taskTrack: task.track },
  });
  await renderHoursPicker(bot, chatId, userId);
}

async function renderHoursPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const cur = session.data?.hours;
  const rows = [];
  for (let i = 0; i < HOURS_PRESETS.length; i += 4) {
    rows.push(HOURS_PRESETS.slice(i, i + 4).map(([label, value]) => ({
      text: `⏱ ${label}${cur === value ? ' ✓' : ''}`,
      callback_data: `tsk:phr:${value}`,
    })));
  }
  rows.push([{ text: '⌨ Custom hours', callback_data: 'tsk:phr_custom' }]);
  rows.push([{ text: '⬅️ Back', callback_data: 'tsk:pcn' }]);
  const t = session.data;
  const pm = PRIORITY_META[t.taskPriority] || PRIORITY_META.normal;
  await anchor(bot, chatId, userId,
    `⏱ *Propose Timeline — Step 1/2*\n\n${pm.icon} *${escapeMd(t.taskTitle)}*\n\nHow long do you need?\n_Use a preset, or tap *Custom hours* to reply with a specific number._`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function renderHoursCustomPrompt(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const t = session.data;
  const pm = PRIORITY_META[t.taskPriority] || PRIORITY_META.normal;
  await anchor(bot, chatId, userId,
    `⌨ *Custom hours*\n\n${pm.icon} ${escapeMd(t.taskTitle)}\n\nReply with the number of hours (e.g. \`6\`, \`0.5\`, \`36\`).\n_Max 720 hours (= 30 days). Decimals OK._`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '⬅️ Back to presets', callback_data: 'tsk:pbk:hours' },
          { text: '❌ Cancel',           callback_data: 'tsk:pcn' },
        ]],
      },
    });
}

async function renderDeadlinePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const cur = session.data?.deadline;
  const rows = DEADLINE_PRESETS.map(([key, label, days]) => {
    const iso = addDays(days);
    return [{
      text: `📅 ${label} (${fmtDate(iso)})${cur === iso ? ' ✓' : ''}`,
      callback_data: `tsk:pdl:${key}`,
    }];
  });
  rows.push([{ text: '📅 Pick a specific date', callback_data: 'tsk:pcal' }]);
  rows.push([
    { text: '⬅️ Back',  callback_data: 'tsk:pbk:hours' },
    { text: '❌ Cancel', callback_data: 'tsk:pcn' },
  ]);
  const t = session.data;
  await anchor(bot, chatId, userId,
    `⏱ *Propose Timeline — Step 2/2*\n\n${escapeMd(t.taskTitle)}\n\nEstimated effort: *${fmtHours(t.hours)}*\n\nBy when will it be done?`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

/**
 * Mini-calendar deadline picker. Builds a Mon-first 7-column grid for
 * `session.data.calMonth` ('YYYY-MM'). Past days render as '·' (no-op);
 * today is marked with a • prefix; future days are tappable buttons
 * that emit `tsk:cdy:YYYY-MM-DD`.
 *
 * Navigation buttons cap at today's month going back and at
 * `CAL_MAX_FORWARD_MONTHS` going forward.
 */
async function renderCalendar(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  if (!session.data.calMonth) session.data.calMonth = todayYM();
  sessionStore.set(userId, session);

  const ym = session.data.calMonth;
  const [year, month] = ym.split('-').map((s) => parseInt(s, 10));
  const monthName = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long' });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const minYm = todayYM();
  const maxYm = addMonthsYM(minYm, CAL_MAX_FORWARD_MONTHS);
  const canPrev = ymCompare(ym, minYm) > 0;
  const canNext = ymCompare(ym, maxYm) < 0;

  const header = [
    { text: canPrev ? '« Prev' : '·', callback_data: canPrev ? 'tsk:cmv:prev' : 'tsk:noop' },
    { text: `${monthName} ${year}`, callback_data: 'tsk:noop' },
    { text: canNext ? 'Next »' : '·', callback_data: canNext ? 'tsk:cmv:next' : 'tsk:noop' },
  ];
  const dowRow = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
    .map((d) => ({ text: d, callback_data: 'tsk:noop' }));

  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const daysInMonth = lastDay.getDate();
  const startCol = (firstDay.getDay() + 6) % 7; // Mon-first

  const cells = [];
  for (let i = 0; i < startCol; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const rows = [header, dowRow];
  for (let i = 0; i < cells.length; i += 7) {
    const row = [];
    for (let j = i; j < i + 7; j++) {
      const day = cells[j];
      if (day == null) { row.push({ text: ' ', callback_data: 'tsk:noop' }); continue; }
      const date = new Date(year, month - 1, day);
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (date < today) { row.push({ text: '·', callback_data: 'tsk:noop' }); }
      else if (date.getTime() === today.getTime()) {
        row.push({ text: `•${day}`, callback_data: `tsk:cdy:${iso}` });
      } else {
        row.push({ text: String(day), callback_data: `tsk:cdy:${iso}` });
      }
    }
    rows.push(row);
  }
  rows.push([{ text: '⬅ Back to presets', callback_data: 'tsk:cbk' }]);

  const t = session.data;
  await anchor(bot, chatId, userId,
    `📅 *Pick a deadline*\n\n${escapeMd(t.taskTitle)}\n\nEstimated effort: *${fmtHours(t.hours)}*\n\nTap a date below. _Past days are disabled (·). Today is marked with •._`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function renderProposeConfirmCard(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const t = session.data;
  const pm = PRIORITY_META[t.taskPriority] || PRIORITY_META.normal;
  const tm = TRACK_META[t.taskTrack] || TRACK_META.salaried;
  const rows = [
    [{ text: '✅ Submit', callback_data: 'tsk:pcf' }],
    [
      { text: '⬅️ Back',  callback_data: 'tsk:pbk:deadline' },
      { text: '❌ Cancel', callback_data: 'tsk:pcn' },
    ],
  ];
  await anchor(bot, chatId, userId,
    `⏱ *Propose Timeline — Confirm*\n\n` +
    `${pm.icon} *${escapeMd(t.taskTitle)}*\n${tm.icon} ${tm.label}\n\n` +
    `⏱ Effort: *${fmtHours(t.hours)}*\n` +
    `📅 Deadline: *${fmtDate(t.deadline)}*\n\n` +
    `_Once you submit, your assigner will accept the timeline or send back a counter-proposal._`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function submitProposal(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'task_propose_flow') return;
  const t = session.data;
  if (!t.taskId || t.hours == null || !t.deadline) {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, '⚠️ Missing values. Please restart from the task card.');
    return;
  }
  try {
    await taskStateMachine.transition(t.taskId, 'propose_timeline', userId, {
      hours: t.hours, deadline: t.deadline,
    });
  } catch (e) {
    logger.error(`taskFlow.submitProposal: ${e.message}`);
    sessionStore.clear(userId);
    await editOrSend(bot, chatId, session.flowMessageId,
      `❌ Couldn\'t submit proposal: ${e.message}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  sessionStore.clear(userId);
  await editOrSend(bot, chatId, session.flowMessageId,
    `✅ *Proposal sent*\n\n⏱ ${fmtHours(t.hours)} · 📅 ${fmtDate(t.deadline)}\n\n_Waiting for your assigner to accept or counter._`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });

  await dmAssignerProposal(bot, t.taskId, userId);
}

/**
 * Render (send OR edit) the assigner's proposal card. Used both as the
 * initial DM after the doer proposes a timeline and as a re-render
 * target after Set Incentive / Counter cancels.
 *
 *   - SALARIED:     [✅ Accept timeline] [↩ Counter] [❌ Cancel]
 *   - INCENTIVIZED & incentive NOT set:  [💰 Set incentive] [↩ Counter] [❌ Cancel]
 *   - INCENTIVIZED & incentive SET:      [✅ Accept timeline] [💰 Change incentive] [↩ Counter] [❌ Cancel]
 *
 * Accept is GATED on incentivized track until an amount has been set
 * (₦0 via Skip counts as "set").
 *
 * Returns the message_id of the rendered card (so the caller can store
 * it in session state for later edits).
 */
async function renderProposalCardForAssigner(bot, taskId, opts = {}) {
  const task = await tasksRepository.getById(taskId);
  if (!task) return null;
  const doer = await usersRepository.findByUserId(task.assigned_to);
  const pm = PRIORITY_META[task.priority] || PRIORITY_META.normal;
  const tm = TRACK_META[task.track] || TRACK_META.salaried;
  const isIncentivized = task.track === 'incentivized';

  let incentiveLine = '';
  let incentiveSet = false;
  if (isIncentivized) {
    try {
      const inc = await incentivesRepository.getByTaskId(taskId);
      if (inc) {
        incentiveSet = true;
        incentiveLine = `\n💰 Incentive: *${fmtMoney(inc.amount, inc.currency)}*`;
      } else {
        incentiveLine = `\n💰 Incentive: _not set yet_`;
      }
    } catch (_) { incentiveLine = `\n💰 Incentive: _(lookup failed)_`; }
  }

  const text =
    `📨 *Timeline proposed*\n\n` +
    `${pm.icon} *${escapeMd(task.title)}*\n${tm.icon} ${tm.label}\n\n` +
    `👤 ${escapeMd(doer?.name || task.assigned_to)} proposes:\n` +
    `   ⏱ ${fmtHours(task.proposed_hours)}\n` +
    `   📅 By ${fmtDate(task.proposed_deadline)}${incentiveLine}\n\n` +
    `Rounds used: ${task.negotiation_rounds || 0}/${taskStateMachine.MAX_NEGOTIATION_ROUNDS}\n\nID: \`${taskId}\``;

  const rows = [];
  if (!isIncentivized) {
    rows.push([
      { text: '✅ Accept timeline', callback_data: `tsk:acc:${taskId}` },
      { text: '↩ Counter',          callback_data: `tsk:cnt:${taskId}` },
    ]);
  } else if (!incentiveSet) {
    rows.push([
      { text: '💰 Set incentive', callback_data: `tsk:six:${taskId}` },
      { text: '↩ Counter',        callback_data: `tsk:cnt:${taskId}` },
    ]);
  } else {
    rows.push([
      { text: '✅ Accept timeline & lock deal', callback_data: `tsk:acc:${taskId}` },
    ]);
    rows.push([
      { text: '💰 Change incentive', callback_data: `tsk:six:${taskId}` },
      { text: '↩ Counter',           callback_data: `tsk:cnt:${taskId}` },
    ]);
  }
  rows.push([{ text: '❌ Cancel task', callback_data: `tsk:cnl:${taskId}` }]);

  const sendOpts = {
    parse_mode: 'Markdown',
    disable_notification: priorityIsSilent(task.priority),
    reply_markup: { inline_keyboard: rows },
  };

  if (opts.editChatId && opts.editMessageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: opts.editChatId, message_id: opts.editMessageId, ...sendOpts,
      });
      return opts.editMessageId;
    } catch (e) {
      logger.warn(`renderProposalCardForAssigner: edit failed, falling back to send: ${e.message}`);
    }
  }
  const res = await bot.sendMessage(task.assigned_by, text, sendOpts);
  return res?.message_id || null;
}

/** Initial DM after the doer submits a timeline. */
async function dmAssignerProposal(bot, taskId, doerUserId) {
  try {
    await renderProposalCardForAssigner(bot, taskId);
  } catch (e) {
    logger.warn(`taskFlow.dmAssignerProposal: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// DECLINE (doer-side, one-tap)
// ---------------------------------------------------------------------------

async function handleDecline(bot, callbackQuery, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {}); return; }
  if (task.assigned_to !== userId) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assignee can decline.', show_alert: true }).catch(() => {});
    return;
  }
  try {
    await taskStateMachine.transition(taskId, 'decline', userId);
  } catch (e) {
    await editOrSend(bot, chatId, messageId, `❌ Couldn\'t decline: ${e.message}`, { parse_mode: 'Markdown' });
    return;
  }
  await editOrSend(bot, chatId, messageId,
    `🚫 *Declined*\n\n${escapeMd(task.title)}\n\n_Your assigner has been notified._`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
  const doerName = (await usersRepository.findByUserId(userId))?.name || userId;
  try {
    await bot.sendMessage(task.assigned_by,
      `🚫 *Task declined*\n\n${escapeMd(task.title)}\n👤 By: ${escapeMd(doerName)}\n\nID: \`${taskId}\`\n\n_Tap Assign Task to send it to someone else._`,
      { parse_mode: 'Markdown' });
  } catch (_) { /* noop */ }
  // T2: feed event for opted-in admins (assigner already notified above).
  try {
    await adminFeed.notify(bot, 'task.declined',
      `🚫 *Task declined*\n\n${escapeMd(task.title)}\n👤 By ${escapeMd(doerName)}\nID: \`${taskId}\``,
      { parse_mode: 'Markdown' }, { excludeUserId: task.assigned_by });
  } catch (e) {
    logger.warn(`taskFlow.handleDecline: adminFeed task.declined: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// ACCEPT / COUNTER / CANCEL (assigner-side, from the proposal card)
// ---------------------------------------------------------------------------

async function handleAcceptTimeline(bot, callbackQuery, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {}); return; }
  if (task.assigned_by !== userId && !isAdmin(userId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assigner or an admin can accept.', show_alert: true }).catch(() => {});
    return;
  }
  // Gate: on incentivized track, an incentive amount MUST be set before
  // accept (₦0 via Skip counts as set). The button is normally not even
  // rendered until set, but guard server-side for safety.
  if (task.track === 'incentivized') {
    const inc = await incentivesRepository.getByTaskId(taskId);
    if (!inc) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Set the incentive amount first (or tap Skip → ₦0).',
        show_alert: true,
      }).catch(() => {});
      return;
    }
  }
  try {
    await taskStateMachine.transition(taskId, 'accept_timeline', userId);
  } catch (e) {
    await editOrSend(bot, chatId, messageId, `❌ Couldn\'t accept: ${e.message}`, { parse_mode: 'Markdown' });
    return;
  }
  await editOrSend(bot, chatId, messageId,
    `✅ *Timeline accepted*\n\n${escapeMd(task.title)}\n⏱ ${fmtHours(task.proposed_hours)} · 📅 ${fmtDate(task.proposed_deadline)}\n\n_Waiting on the doer\'s final OK._`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
  await dmDoerFinalAck(bot, taskId);
}

/**
 * Starts (or re-opens) the set-incentive input from a proposal-card
 * "💰 Set incentive" tap. Stores the proposal card's message_id so the
 * card can be re-rendered with the new amount once the user replies.
 */
async function startSetIncentiveFromCard(bot, callbackQuery, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {}); return; }
  if (task.assigned_by !== userId && !isAdmin(userId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assigner or an admin can set the incentive.', show_alert: true }).catch(() => {});
    return;
  }
  if (task.track !== 'incentivized') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'This task is salaried; no incentive applies.', show_alert: true }).catch(() => {});
    return;
  }
  if (task.status !== 'awaiting_timeline_ack') {
    await editOrSend(bot, chatId, messageId,
      `ℹ️ Task ${taskId} is *${task.status}* — incentive can only be set during timeline negotiation.`,
      { parse_mode: 'Markdown' });
    return;
  }
  sessionStore.set(userId, {
    type: 'task_incentive_flow',
    flowMessageId: messageId,
    data: { taskId, taskTitle: task.title, taskTrack: task.track, returnToProposalCard: true },
  });
  await renderIncentiveCard(bot, chatId, userId);
}

async function startCounterFlow(bot, callbackQuery, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {}); return; }
  if (task.assigned_by !== userId && !isAdmin(userId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assigner or an admin can counter.', show_alert: true }).catch(() => {});
    return;
  }
  if ((task.negotiation_rounds || 0) >= taskStateMachine.MAX_NEGOTIATION_ROUNDS) {
    await editOrSend(bot, chatId, messageId,
      `⚠️ Negotiation cap reached (${task.negotiation_rounds}/${taskStateMachine.MAX_NEGOTIATION_ROUNDS}). Accept the proposal or cancel the task.`,
      { parse_mode: 'Markdown' });
    return;
  }
  sessionStore.set(userId, {
    type: 'task_counter_flow',
    flowMessageId: messageId,
    data: { taskId, taskTitle: task.title },
  });
  await editOrSend(bot, chatId, messageId,
    `↩ *Counter proposal*\n\n${escapeMd(task.title)}\n\nReply with a one-line note for the doer (or tap *Send without note*).\n\n_Max ${COUNTER_REASON_MAX_LEN} chars._`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⏭ Send without note', callback_data: 'tsk:cnt_skip' }],
          [{ text: '❌ Cancel counter',     callback_data: 'tsk:cnt_canc' }],
        ],
      },
    });
}

async function submitCounter(bot, chatId, userId, reason) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'task_counter_flow') return;
  const t = session.data;
  try {
    await taskStateMachine.transition(t.taskId, 'counter_timeline', userId, reason ? { reason } : {});
  } catch (e) {
    sessionStore.clear(userId);
    await editOrSend(bot, chatId, session.flowMessageId, `❌ Couldn\'t counter: ${e.message}`, { parse_mode: 'Markdown' });
    return;
  }
  sessionStore.clear(userId);
  await editOrSend(bot, chatId, session.flowMessageId,
    `↩ *Counter sent*\n\n${escapeMd(t.taskTitle)}\n\n_The doer will propose a fresh timeline._`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
  // DM the doer with fresh propose card + the counter note.
  try {
    const task = await tasksRepository.getById(t.taskId);
    const pm = PRIORITY_META[task.priority] || PRIORITY_META.normal;
    const tm = TRACK_META[task.track] || TRACK_META.salaried;
    const noteLine = reason ? `\n\n💬 _Counter note:_ ${escapeMd(reason)}` : '';
    await bot.sendMessage(task.assigned_to,
      `↩ *Counter from assigner*\n\n${pm.icon} *${escapeMd(task.title)}*\n${tm.icon} ${tm.label}${noteLine}\n\n` +
      `Please propose a fresh timeline.\n\n` +
      `Round ${task.negotiation_rounds}/${taskStateMachine.MAX_NEGOTIATION_ROUNDS}\nID: \`${t.taskId}\``,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '⏱ Propose timeline', callback_data: `tsk:prp:${t.taskId}` },
            { text: '❌ Decline',          callback_data: `tsk:dec:${t.taskId}` },
          ]],
        },
      });
  } catch (e) {
    logger.warn(`taskFlow.submitCounter: could not DM doer: ${e.message}`);
  }
}

async function handleCancelTask(bot, callbackQuery, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {}); return; }
  try {
    await taskStateMachine.transition(taskId, 'cancel', userId);
  } catch (e) {
    await editOrSend(bot, chatId, messageId, `❌ Couldn\'t cancel: ${e.message}`, { parse_mode: 'Markdown' });
    return;
  }
  await editOrSend(bot, chatId, messageId,
    `❌ *Task cancelled*\n\n${escapeMd(task.title)}\nID: \`${taskId}\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
  try {
    await bot.sendMessage(task.assigned_to,
      `❌ *Task cancelled by assigner*\n\n${escapeMd(task.title)}\nID: \`${taskId}\``,
      { parse_mode: 'Markdown' });
  } catch (_) { /* noop */ }
}

// ---------------------------------------------------------------------------
// SET-INCENTIVE FLOW (assigner-side; incentivized track only)
// ---------------------------------------------------------------------------

async function renderIncentiveCard(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const t = session.data;
  const rows = [
    [{ text: '⏭ Skip (₦0)', callback_data: `tsk:sip:${t.taskId}` }],
  ];
  if (t.returnToProposalCard) {
    rows.push([{ text: '⬅ Back to proposal', callback_data: `tsk:sib:${t.taskId}` }]);
  }
  await anchor(bot, chatId, userId,
    `💰 *Set incentive for the doer*\n\n${escapeMd(t.taskTitle)}\n\n` +
    `Reply with the ₦ amount (digits only, e.g. \`5000\`).\n` +
    `Tap Skip to use ₦0.\n\n_The amount is stored separately and is NOT visible to scrum-master admin in any Tasks view._`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function submitIncentive(bot, chatId, userId, amountRaw) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'task_incentive_flow') return;
  const t = session.data;
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0 || amount > INCENTIVE_MAX) {
    await bot.sendMessage(chatId, `⚠️ Enter a non-negative whole number ≤ ${INCENTIVE_MAX.toLocaleString()}, or tap Skip.`);
    return;
  }
  await finalizeIncentive(bot, chatId, userId, amount);
}

async function finalizeIncentive(bot, chatId, userId, amount) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'task_incentive_flow') return;
  const t = session.data;
  const currency = config.currency || 'NGN';
  try {
    await incentivesRepository.setAmount({
      task_id: t.taskId,
      amount,
      currency,
      set_by: userId,
    });
    await taskStateMachine.transition(t.taskId, 'set_incentive', userId, { amount, currency });
  } catch (e) {
    logger.error(`taskFlow.finalizeIncentive: ${e.message}`);
    sessionStore.clear(userId);
    await editOrSend(bot, chatId, session.flowMessageId,
      `❌ Couldn\'t save incentive: ${e.message}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  const returnToCard = !!t.returnToProposalCard;
  const cardMsgId = session.flowMessageId;
  sessionStore.clear(userId);
  if (returnToCard) {
    // Re-render the proposal card in-place with the new amount + Accept enabled.
    await renderProposalCardForAssigner(bot, t.taskId, {
      editChatId: chatId, editMessageId: cardMsgId,
    });
    return;
  }
  // Legacy path (no card to return to) — just confirm and DM the doer.
  await editOrSend(bot, chatId, cardMsgId,
    `💰 *Incentive saved*\n\n${escapeMd(t.taskTitle)}\nAmount: ${fmtMoney(amount, currency)}\n\n_Waiting on the doer\'s final OK._`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
  await dmDoerFinalAck(bot, t.taskId);
}

// ---------------------------------------------------------------------------
// MANAGER CONTROLS: Re-prioritize + Drop-off (assigner-side, from Team Tasks)
// ---------------------------------------------------------------------------
//
// Both fire engine transitions (update_priority, drop) so every change
// flows through the same state machine and is auditable via TaskEvents.
// update_priority is a self-transition (status unchanged), drop is
// terminal (status → 'dropped').
// ---------------------------------------------------------------------------

const DROP_REASON_MAX_LEN = 200;

async function _guardAssignerOrAdmin(bot, callbackQuery, task) {
  const userId = String(callbackQuery.from.id);
  if (task.assigned_by !== userId && !isAdmin(userId)) {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Only the assigner or an admin can change this.', show_alert: true,
    }).catch(() => {});
    return false;
  }
  return true;
}

/** Render the 4-priority picker; current priority is marked ✓. */
async function startPriorityPicker(bot, callbackQuery, taskId) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {}); return; }
  if (!(await _guardAssignerOrAdmin(bot, callbackQuery, task))) return;
  if (!OPEN_STATUSES.has(task.status)) {
    await editOrSend(bot, chatId, messageId,
      `ℹ️ Task ${taskId} is *${task.status}* — priority can only be changed on open tasks.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  const cur = getPriority(task);
  const row = ['critical', 'high', 'normal', 'low'].map((p) => ({
    text: `${PRIORITY_META[p].icon} ${PRIORITY_META[p].label}${cur === p ? ' ✓' : ''}`,
    callback_data: `tsk:prio_set:${taskId}:${p}`,
  }));
  await editOrSend(bot, chatId, messageId,
    `🔝 *Re-prioritize*\n\n${escapeMd(task.title)}\n\nCurrent: ${PRIORITY_META[cur]?.icon || ''} *${PRIORITY_META[cur]?.label || cur}*\nPick a new priority:`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        row.slice(0, 2),
        row.slice(2, 4),
        [{ text: '⬅ Back to Team Tasks', callback_data: 'act:__hub__:tasks' }],
      ] },
    });
}

async function applyPriority(bot, callbackQuery, taskId, newPriority) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  if (!PRIORITY_META[newPriority]) {
    await editOrSend(bot, chatId, messageId, '❌ Invalid priority.', {});
    return;
  }
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {}); return; }
  if (!(await _guardAssignerOrAdmin(bot, callbackQuery, task))) return;

  const oldPriority = getPriority(task);
  if (oldPriority === newPriority) {
    await editOrSend(bot, chatId, messageId,
      `ℹ️ Priority is already *${PRIORITY_META[newPriority].label}*.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  try {
    await taskStateMachine.transition(taskId, 'update_priority', userId, {
      priority: newPriority,
      from_priority: oldPriority,
    });
  } catch (e) {
    await editOrSend(bot, chatId, messageId,
      `❌ Couldn't change priority: ${e.message}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  const oldPm = PRIORITY_META[oldPriority] || PRIORITY_META.normal;
  const newPm = PRIORITY_META[newPriority];
  await editOrSend(bot, chatId, messageId,
    `🔝 *Priority changed*\n\n${escapeMd(task.title)}\n${oldPm.icon} ${oldPm.label} → ${newPm.icon} *${newPm.label}*`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });

  // Smart doer notification: silent DM when the new priority is normal/
  // low (no need to interrupt them), audible DM when it's high/critical
  // (urgency just went up — they should know now).
  try {
    const silent = priorityIsSilent(newPriority);
    await bot.sendMessage(task.assigned_to,
      `🔝 *Priority updated by your assigner*\n\n` +
      `${escapeMd(task.title)}\n` +
      `${oldPm.icon} ${oldPm.label} → ${newPm.icon} *${newPm.label}*\n\nID: \`${taskId}\``,
      { parse_mode: 'Markdown', disable_notification: silent });
  } catch (e) {
    logger.warn(`taskFlow.applyPriority: DM doer failed: ${e.message}`);
  }
  // T2: opt-in feed (defaults OFF — this can be noisy).
  try {
    const doerName = (await usersRepository.findByUserId(task.assigned_to))?.name || task.assigned_to;
    await adminFeed.notify(bot, 'task.priority',
      `🔝 *Priority changed*\n${escapeMd(task.title)}\n` +
      `${oldPm.icon} ${oldPm.label} → ${newPm.icon} *${newPm.label}*\n` +
      `👤 ${escapeMd(doerName)}\nID: \`${taskId}\``,
      { parse_mode: 'Markdown' }, { excludeUserId: userId });
  } catch (e) {
    logger.warn(`taskFlow.applyPriority: adminFeed task.priority: ${e.message}`);
  }
}

/** Show the drop confirm card with optional reason reply. */
async function startDropAsk(bot, callbackQuery, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {}); return; }
  if (!(await _guardAssignerOrAdmin(bot, callbackQuery, task))) return;
  if (task.status === 'submitted') {
    await editOrSend(bot, chatId, messageId,
      `ℹ️ ${escapeMd(task.title)} has been submitted by the doer — please approve or reject instead of dropping.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  if (!OPEN_STATUSES.has(task.status)) {
    await editOrSend(bot, chatId, messageId,
      `ℹ️ Task ${taskId} is *${task.status}* — drop is only available for open tasks.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  const doerName = (await usersRepository.findByUserId(task.assigned_to))?.name || task.assigned_to;
  sessionStore.set(userId, {
    type: 'task_drop_flow',
    flowMessageId: messageId,
    data: { taskId, taskTitle: task.title, doerName },
  });
  await editOrSend(bot, chatId, messageId,
    `🚫 *Drop task*\n\n${escapeMd(task.title)}\n👤 From: *${escapeMd(doerName)}*\n\n` +
    `_Optional: reply with a 1-line reason so the doer knows why._\n_Or just tap_ *Confirm drop* _to remove it from their plate._\n\nMax ${DROP_REASON_MAX_LEN} chars.`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '🚫 Confirm drop', callback_data: `tsk:drop_go:${taskId}` }],
        [{ text: '⬅ Cancel',         callback_data: 'tsk:drop_cancel' }],
      ] },
    });
}

async function submitDrop(bot, chatId, userId, reason) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'task_drop_flow') return;
  const t = session.data;
  try {
    const meta = reason ? { reason } : {};
    await taskStateMachine.transition(t.taskId, 'drop', userId, meta);
  } catch (e) {
    sessionStore.clear(userId);
    await editOrSend(bot, chatId, session.flowMessageId,
      `❌ Couldn't drop: ${e.message}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  sessionStore.clear(userId);
  const reasonLine = reason ? `\n💬 _Reason:_ ${escapeMd(reason)}` : '';
  await editOrSend(bot, chatId, session.flowMessageId,
    `🚫 *Task dropped*\n\n${escapeMd(t.taskTitle)}\n👤 ${escapeMd(t.doerName)} has been notified.${reasonLine}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
  // Polite DM to the doer — they should know not to do the work.
  try {
    const task = await tasksRepository.getById(t.taskId);
    if (task) {
      await bot.sendMessage(task.assigned_to,
        `🚫 *Task dropped by your assigner*\n\n${escapeMd(task.title)}${reasonLine}\n\n` +
        `_This task is no longer needed. No action required on your part._\nID: \`${t.taskId}\``,
        { parse_mode: 'Markdown' });
    }
  } catch (e) {
    logger.warn(`taskFlow.submitDrop: DM doer failed: ${e.message}`);
  }
  // T2: opt-in feed for opted-in admins (excluding the actor).
  try {
    await adminFeed.notify(bot, 'task.dropped',
      `🚫 *Task dropped*\n\n${escapeMd(t.taskTitle)}\n👤 ${escapeMd(t.doerName)}${reasonLine}\nID: \`${t.taskId}\``,
      { parse_mode: 'Markdown' }, { excludeUserId: userId });
  } catch (e) {
    logger.warn(`taskFlow.submitDrop: adminFeed task.dropped: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// FINAL-ACK FLOW (doer-side)
// ---------------------------------------------------------------------------

async function dmDoerFinalAck(bot, taskId) {
  try {
    const task = await tasksRepository.getById(taskId);
    if (!task) return;
    const pm = PRIORITY_META[task.priority] || PRIORITY_META.normal;
    const tm = TRACK_META[task.track] || TRACK_META.salaried;
    let incentiveLine = '';
    if (task.track === 'incentivized') {
      try {
        const inc = await incentivesRepository.getByTaskId(taskId);
        const amount = inc ? Number(inc.amount) : 0;
        incentiveLine = `\n💰 *Incentive:* ${fmtMoney(amount, inc?.currency || config.currency || 'NGN')}`;
      } catch (e) {
        logger.warn(`taskFlow.dmDoerFinalAck: incentive lookup failed: ${e.message}`);
      }
    }
    await bot.sendMessage(task.assigned_to,
      `🤝 *Deal ready — your final OK*\n\n` +
      `${pm.icon} *${escapeMd(task.title)}*\n${tm.icon} ${tm.label}\n\n` +
      `⏱ Effort: *${fmtHours(task.proposed_hours)}*\n📅 Deadline: *${fmtDate(task.proposed_deadline)}*${incentiveLine}\n\n` +
      `Round ${task.negotiation_rounds || 0}/${taskStateMachine.MAX_NEGOTIATION_ROUNDS}\nID: \`${taskId}\``,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Accept the deal', callback_data: `tsk:fa:${taskId}` },
            { text: '↩ Renegotiate',     callback_data: `tsk:rng:${taskId}` },
          ]],
        },
      });
  } catch (e) {
    logger.warn(`taskFlow.dmDoerFinalAck: ${e.message}`);
  }
}

async function handleFinalAck(bot, callbackQuery, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {}); return; }
  if (task.assigned_to !== userId) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assignee can confirm the deal.', show_alert: true }).catch(() => {});
    return;
  }
  try {
    await taskStateMachine.transition(taskId, 'final_ack', userId);
  } catch (e) {
    await editOrSend(bot, chatId, messageId, `❌ Couldn\'t accept: ${e.message}`, { parse_mode: 'Markdown' });
    return;
  }
  // Stamp doer_confirmed_at on the Incentives row so finance has a
  // clean record of when the doer locked in the deal.
  if (task.track === 'incentivized') {
    try { await incentivesRepository.markDoerConfirmed(taskId); }
    catch (e) { logger.warn(`taskFlow.handleFinalAck: markDoerConfirmed: ${e.message}`); }
  }
  await editOrSend(bot, chatId, messageId,
    `🟢 *Clock started*\n\n${escapeMd(task.title)}\n⏱ ${fmtHours(task.proposed_hours)} · 📅 ${fmtDate(task.proposed_deadline)}\n\nWhen done, tap *Mark done*.\nID: \`${taskId}\``,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Mark done', callback_data: `tsk:done:${taskId}` },
        ]],
      },
    });
  try {
    await bot.sendMessage(task.assigned_by,
      `🟢 *Doer accepted — clock started*\n\n${escapeMd(task.title)}\n⏱ ${fmtHours(task.proposed_hours)} · 📅 ${fmtDate(task.proposed_deadline)}\nID: \`${taskId}\``,
      { parse_mode: 'Markdown' });
  } catch (_) { /* noop */ }
}

async function handleRenegotiate(bot, callbackQuery, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {}); return; }
  if (task.assigned_to !== userId) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assignee can renegotiate.', show_alert: true }).catch(() => {});
    return;
  }
  if ((task.negotiation_rounds || 0) >= taskStateMachine.MAX_NEGOTIATION_ROUNDS) {
    await editOrSend(bot, chatId, messageId,
      `⚠️ Negotiation cap reached. Accept the deal or it will need to be cancelled.`,
      { parse_mode: 'Markdown' });
    return;
  }
  try {
    await taskStateMachine.transition(taskId, 'renegotiate', userId);
  } catch (e) {
    await editOrSend(bot, chatId, messageId, `❌ Couldn\'t renegotiate: ${e.message}`, { parse_mode: 'Markdown' });
    return;
  }
  await editOrSend(bot, chatId, messageId,
    `↩ *Renegotiating*\n\n${escapeMd(task.title)}\nPlease propose a fresh timeline.\nID: \`${taskId}\``,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '⏱ Propose timeline', callback_data: `tsk:prp:${taskId}` },
        ]],
      },
    });
  try {
    await bot.sendMessage(task.assigned_by,
      `↩ *Doer asked to renegotiate*\n\n${escapeMd(task.title)}\nID: \`${taskId}\`\n\n_They\'ll send a fresh timeline shortly._`,
      { parse_mode: 'Markdown' });
  } catch (_) { /* noop */ }
}

// ---------------------------------------------------------------------------
// CALLBACK DISPATCHER
// ---------------------------------------------------------------------------

async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('tsk:')) return false;
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) { /* noop */ }

  if (data === 'tsk:noop') return true;

  // Standalone leaf callbacks — no flow session required.
  if (data.startsWith('tsk:done:'))    { await handleMarkDone   (bot, callbackQuery, data.slice('tsk:done:'.length));    return true; }
  if (data.startsWith('tsk:sign:ok:')) { await handleSignOff    (bot, callbackQuery, data.slice('tsk:sign:ok:'.length), true);  return true; }
  if (data.startsWith('tsk:sign:no:')) { await handleSignOff    (bot, callbackQuery, data.slice('tsk:sign:no:'.length), false); return true; }
  if (data.startsWith('tsk:prp:'))     { await startProposeFlow (bot, callbackQuery, data.slice('tsk:prp:'.length)); return true; }
  if (data.startsWith('tsk:dec:'))     { await handleDecline    (bot, callbackQuery, data.slice('tsk:dec:'.length)); return true; }
  if (data.startsWith('tsk:acc:'))     { await handleAcceptTimeline(bot, callbackQuery, data.slice('tsk:acc:'.length)); return true; }
  if (data.startsWith('tsk:six:'))     { await startSetIncentiveFromCard(bot, callbackQuery, data.slice('tsk:six:'.length)); return true; }
  if (data.startsWith('tsk:cnt:'))     { await startCounterFlow (bot, callbackQuery, data.slice('tsk:cnt:'.length)); return true; }
  if (data.startsWith('tsk:cnl:'))     { await handleCancelTask (bot, callbackQuery, data.slice('tsk:cnl:'.length)); return true; }
  if (data.startsWith('tsk:fa:'))      { await handleFinalAck   (bot, callbackQuery, data.slice('tsk:fa:'.length)); return true; }
  if (data.startsWith('tsk:rng:'))     { await handleRenegotiate(bot, callbackQuery, data.slice('tsk:rng:'.length)); return true; }
  if (data.startsWith('tsk:py:p:'))    { await handleMarkPaid   (bot, callbackQuery, data.slice('tsk:py:p:'.length)); return true; }

  // Manager controls: re-prioritize + drop-off.
  if (data.startsWith('tsk:prio_pick:')) {
    await startPriorityPicker(bot, callbackQuery, data.slice('tsk:prio_pick:'.length));
    return true;
  }
  if (data.startsWith('tsk:prio_set:')) {
    // Format: tsk:prio_set:<taskId>:<priority>
    const rest = data.slice('tsk:prio_set:'.length);
    const lastColon = rest.lastIndexOf(':');
    if (lastColon === -1) return true;
    const tid = rest.slice(0, lastColon);
    const pri = rest.slice(lastColon + 1);
    await applyPriority(bot, callbackQuery, tid, pri);
    return true;
  }
  if (data.startsWith('tsk:drop_ask:')) {
    await startDropAsk(bot, callbackQuery, data.slice('tsk:drop_ask:'.length));
    return true;
  }
  if (data.startsWith('tsk:drop_go:')) {
    // Confirm-without-reason path (the optional reason flows through
    // handleTextStep below, which then calls submitDrop).
    const tid = data.slice('tsk:drop_go:'.length);
    const session = sessionStore.get(userId);
    if (!session || session.type !== 'task_drop_flow' || session.data?.taskId !== tid) {
      await editOrSend(bot, chatId, messageId,
        '⏳ This drop card has expired. Open *Team Tasks* and tap 🚫 Drop again.',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
      return true;
    }
    session.flowMessageId = messageId;
    sessionStore.set(userId, session);
    await submitDrop(bot, chatId, userId, '');
    return true;
  }
  if (data === 'tsk:drop_cancel') {
    const s = sessionStore.get(userId);
    if (s && s.type === 'task_drop_flow') sessionStore.clear(userId);
    await editOrSend(bot, chatId, messageId, '❌ Drop cancelled.', {
      reply_markup: { inline_keyboard: [navFooterRow()] },
    });
    return true;
  }

  // Cancel — clears whichever flow session is active.
  if (data === 'tsk:cancel') {
    const s = sessionStore.get(userId);
    if (s && (s.type === 'task_assign_flow' || s.type === 'task_propose_flow'
              || s.type === 'task_counter_flow' || s.type === 'task_incentive_flow'
              || s.type === 'task_drop_flow')) {
      sessionStore.clear(userId);
    }
    await editOrSend(bot, chatId, messageId, '❌ Cancelled.', {
      reply_markup: { inline_keyboard: [navFooterRow()] },
    });
    return true;
  }

  // ----- Propose-timeline flow (`task_propose_flow`) ----------------------
  if (data === 'tsk:pcn') {
    sessionStore.clear(userId);
    await editOrSend(bot, chatId, messageId, '❌ Proposal cancelled.', {
      reply_markup: { inline_keyboard: [navFooterRow()] },
    });
    return true;
  }
  if (data.startsWith('tsk:phr:') || data === 'tsk:phr_custom'
      || data.startsWith('tsk:pdl:') || data === 'tsk:pcal' || data === 'tsk:cbk'
      || data.startsWith('tsk:cmv:') || data.startsWith('tsk:cdy:')
      || data === 'tsk:pcf' || data.startsWith('tsk:pbk:')) {
    const session = sessionStore.get(userId);
    if (!session || session.type !== 'task_propose_flow') {
      await editOrSend(bot, chatId, messageId,
        '⏳ This timeline picker has expired. Open the task DM and tap Propose timeline again.', {
          reply_markup: { inline_keyboard: [navFooterRow()] },
        });
      return true;
    }
    session.flowMessageId = messageId;
    sessionStore.set(userId, session);

    if (data.startsWith('tsk:phr:')) {
      session.data.hours = parseFloat(data.slice('tsk:phr:'.length));
      session.step = 'deadline';
      sessionStore.set(userId, session);
      await renderDeadlinePicker(bot, chatId, userId);
      return true;
    }
    if (data === 'tsk:phr_custom') {
      session.step = 'hours_text';
      sessionStore.set(userId, session);
      await renderHoursCustomPrompt(bot, chatId, userId);
      return true;
    }
    if (data.startsWith('tsk:pdl:')) {
      const key = data.slice('tsk:pdl:'.length);
      const preset = DEADLINE_PRESETS.find(([k]) => k === key);
      if (preset) session.data.deadline = addDays(preset[2]);
      session.step = 'confirm';
      sessionStore.set(userId, session);
      await renderProposeConfirmCard(bot, chatId, userId);
      return true;
    }
    if (data === 'tsk:pcal') {
      session.step = 'calendar';
      session.data.calMonth = session.data.calMonth || todayYM();
      sessionStore.set(userId, session);
      await renderCalendar(bot, chatId, userId);
      return true;
    }
    if (data === 'tsk:cbk') {
      session.step = 'deadline';
      sessionStore.set(userId, session);
      await renderDeadlinePicker(bot, chatId, userId);
      return true;
    }
    if (data.startsWith('tsk:cmv:')) {
      const dir = data.slice('tsk:cmv:'.length);
      const cur = session.data.calMonth || todayYM();
      const minYm = todayYM();
      const maxYm = addMonthsYM(minYm, CAL_MAX_FORWARD_MONTHS);
      const next = addMonthsYM(cur, dir === 'next' ? 1 : -1);
      if (ymCompare(next, minYm) >= 0 && ymCompare(next, maxYm) <= 0) {
        session.data.calMonth = next;
        sessionStore.set(userId, session);
      }
      await renderCalendar(bot, chatId, userId);
      return true;
    }
    if (data.startsWith('tsk:cdy:')) {
      const iso = data.slice('tsk:cdy:'.length);
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        session.data.deadline = iso;
        session.step = 'confirm';
        sessionStore.set(userId, session);
        await renderProposeConfirmCard(bot, chatId, userId);
      }
      return true;
    }
    if (data.startsWith('tsk:pbk:')) {
      const where = data.slice('tsk:pbk:'.length);
      if (where === 'hours') { session.step = 'hours'; sessionStore.set(userId, session); await renderHoursPicker(bot, chatId, userId); }
      else if (where === 'deadline') { session.step = 'deadline'; sessionStore.set(userId, session); await renderDeadlinePicker(bot, chatId, userId); }
      return true;
    }
    if (data === 'tsk:pcf') {
      await submitProposal(bot, chatId, userId);
      return true;
    }
  }

  // ----- Counter flow ------------------------------------------------------
  if (data === 'tsk:cnt_skip' || data === 'tsk:cnt_canc') {
    const session = sessionStore.get(userId);
    if (session && session.type === 'task_counter_flow') {
      if (data === 'tsk:cnt_canc') {
        sessionStore.clear(userId);
        await editOrSend(bot, chatId, messageId, '❌ Counter cancelled.', {
          reply_markup: { inline_keyboard: [navFooterRow()] },
        });
        return true;
      }
      await submitCounter(bot, chatId, userId, '');
    }
    return true;
  }

  // ----- Incentive flow ---------------------------------------------------
  if (data.startsWith('tsk:sip:')) {
    const session = sessionStore.get(userId);
    if (session && session.type === 'task_incentive_flow') {
      await finalizeIncentive(bot, chatId, userId, 0);
    }
    return true;
  }
  if (data.startsWith('tsk:sib:')) {
    const session = sessionStore.get(userId);
    if (session && session.type === 'task_incentive_flow' && session.data.returnToProposalCard) {
      const cardMsgId = session.flowMessageId;
      const taskId = session.data.taskId;
      sessionStore.clear(userId);
      await renderProposalCardForAssigner(bot, taskId, { editChatId: chatId, editMessageId: cardMsgId });
    }
    return true;
  }

  // ----- Assign-task flow (`task_assign_flow`) ----------------------------
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'task_assign_flow') {
    await editOrSend(bot, chatId, messageId,
      '⏳ This task picker has expired. Tap *Back to Tasks* and start *Assign Task* again.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [navFooterRow()] },
      });
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
    if (!target) { await renderAssigneePicker(bot, chatId, userId); return true; }
    session.data.assigneeUserId = String(target.user_id);
    session.data.assigneeName = target.name || target.user_id;
    session.step = 'title';
    sessionStore.set(userId, session);
    await renderTitlePrompt(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('tsk:prio:')) {
    session.data.priority = data.slice('tsk:prio:'.length);
    session.step = 'track';
    sessionStore.set(userId, session);
    await renderTrackPicker(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('tsk:trk:')) {
    session.data.track = data.slice('tsk:trk:'.length);
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
    if (target === 'assignee')     { session.step = 'assignee'; sessionStore.set(userId, session); await renderAssigneePicker(bot, chatId, userId); }
    else if (target === 'title')   { session.step = 'title';    sessionStore.set(userId, session); await renderTitlePrompt(bot, chatId, userId); }
    else if (target === 'priority'){ session.step = 'priority'; sessionStore.set(userId, session); await renderPriorityPicker(bot, chatId, userId); }
    else if (target === 'track')   { session.step = 'track';    sessionStore.set(userId, session); await renderTrackPicker(bot, chatId, userId); }
    else if (target === 'desc')    { session.step = 'desc';     sessionStore.set(userId, session); await renderDescriptionPrompt(bot, chatId, userId); }
    return true;
  }
  if (data === 'tsk:confirm') { await submitTask(bot, chatId, userId); return true; }

  return false;
}

// ---------------------------------------------------------------------------
// TEXT-STEP HANDLER (title, description, counter reason, incentive amount)
// ---------------------------------------------------------------------------

async function handleTextStep(bot, msg) {
  const userId = String(msg.from?.id || '');
  const session = sessionStore.get(userId);
  if (!session) return false;
  const text = (msg.text || '').trim();
  if (!text) return false;
  const chatId = msg.chat.id;

  if (session.type === 'task_assign_flow') {
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
        await bot.sendMessage(chatId, `⚠️ Description must be ≤ ${DESC_MAX_LEN} characters. Please reply again, or tap Skip.`);
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

  if (session.type === 'task_propose_flow') {
    if (session.step === 'hours_text') {
      if (!/^\d+(\.\d+)?$/.test(text)) {
        await bot.sendMessage(chatId, '⚠️ Reply with a number only (e.g. `6`, `0.5`, `36`).', { parse_mode: 'Markdown' });
        return true;
      }
      const hrs = Number(text);
      if (!Number.isFinite(hrs) || hrs <= 0 || hrs > 720) {
        await bot.sendMessage(chatId, '⚠️ Hours must be greater than 0 and ≤ 720 (= 30 days). Please reply again.');
        return true;
      }
      session.data.hours = hrs;
      session.step = 'deadline';
      sessionStore.set(userId, session);
      await renderDeadlinePicker(bot, chatId, userId);
      return true;
    }
    return false;
  }

  if (session.type === 'task_counter_flow') {
    if (text.length > COUNTER_REASON_MAX_LEN) {
      await bot.sendMessage(chatId, `⚠️ Counter note must be ≤ ${COUNTER_REASON_MAX_LEN} chars. Reply again or tap *Send without note*.`, { parse_mode: 'Markdown' });
      return true;
    }
    await submitCounter(bot, chatId, userId, text);
    return true;
  }

  if (session.type === 'task_incentive_flow') {
    if (!/^\d+(\.\d+)?$/.test(text)) {
      await bot.sendMessage(chatId, '⚠️ Reply with digits only (e.g. `5000`), or tap *Skip (₦0)*.', { parse_mode: 'Markdown' });
      return true;
    }
    await submitIncentive(bot, chatId, userId, text);
    return true;
  }

  if (session.type === 'task_drop_flow') {
    if (text.length > DROP_REASON_MAX_LEN) {
      await bot.sendMessage(chatId,
        `⚠️ Reason must be ≤ ${DROP_REASON_MAX_LEN} chars. Reply again, or tap *Confirm drop* with no reason.`,
        { parse_mode: 'Markdown' });
      return true;
    }
    await submitDrop(bot, chatId, userId, text);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// MARK-DONE  +  SIGN-OFF (existing simple flow; preserved + audited)
// ---------------------------------------------------------------------------

async function handleMarkDone(bot, callbackQuery, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {}); return; }
  if (task.assigned_to !== userId) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assignee can mark this done.', show_alert: true }).catch(() => {});
    return;
  }

  // Legacy back-compat: tasks already in 'assigned' before commit 3 was
  // deployed have no negotiation. The Mark-done button on their DM
  // remains in users' chat histories — keep it working by fast-forwarding
  // through 'active' (audit row tagged as `_legacy`).
  if (task.status === 'assigned') {
    try {
      await tasksRepository.updateFields(taskId, {
        status: 'active',
        started_at: new Date().toISOString(),
      });
      await taskEventsRepository.append({
        task_id: taskId,
        event_type: 'doer_marked_started_legacy',
        from_status: 'assigned',
        to_status: 'active',
        actor_user_id: userId,
        meta: { reason: 'pre-negotiation_flow_back_compat' },
      });
      task.status = 'active';
    } catch (e) {
      logger.warn(`taskFlow.handleMarkDone: pre-active pass failed: ${e.message}`);
    }
  }

  if (task.status !== 'active') {
    await editOrSend(bot, chatId, messageId,
      `ℹ️ Task ${taskId} is *${task.status}* — Mark-done isn\'t available yet.`,
      { parse_mode: 'Markdown' });
    return;
  }

  try {
    await taskStateMachine.transition(taskId, 'mark_done', userId);
  } catch (e) {
    logger.error(`taskFlow.handleMarkDone: ${e.message}`);
    await editOrSend(bot, chatId, messageId, `❌ Could not submit: ${e.message}`, { parse_mode: 'Markdown' });
    return;
  }

  const pm = PRIORITY_META[getPriority(task)] || PRIORITY_META.normal;
  await editOrSend(bot, chatId, messageId,
    `⏳ *Submitted for sign-off*\n\n${pm.icon} ${escapeMd(task.title)}\nID: \`${taskId}\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });

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
    logger.warn(`taskFlow.markDone: could not notify assigner: ${e.message}`);
  }
}

async function handleSignOff(bot, callbackQuery, taskId, approve) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, {}); return; }
  if (task.assigned_by !== userId && !isAdmin(userId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assigner or an admin can sign off.', show_alert: true }).catch(() => {});
    return;
  }
  if (task.status !== 'submitted') {
    await editOrSend(bot, chatId, messageId, `ℹ️ Task ${taskId} is *${task.status}*, not submitted.`, { parse_mode: 'Markdown' });
    return;
  }
  try {
    await taskStateMachine.transition(taskId, approve ? 'approve' : 'reject', userId);
  } catch (e) {
    await editOrSend(bot, chatId, messageId, `❌ Couldn\'t ${approve ? 'approve' : 'reject'}: ${e.message}`, { parse_mode: 'Markdown' });
    return;
  }
  if (approve) {
    // Incentivized task → flip Incentives row to awaiting_payout so
    // finance has a clean queue of what's owed but not yet disbursed.
    let incentiveInfo = null;
    if (task.track === 'incentivized') {
      try {
        await incentivesRepository.markAwaitingPayout(taskId);
        incentiveInfo = await incentivesRepository.getByTaskId(taskId);
      } catch (e) { logger.warn(`taskFlow.handleSignOff(approve): incentive lifecycle: ${e.message}`); }
    }
    const assignerIncentiveLine = incentiveInfo
      ? `\n💰 Incentive: ${fmtMoney(incentiveInfo.amount, incentiveInfo.currency)} — *queued for payout*`
      : '';
    await editOrSend(bot, chatId, messageId,
      `✅ Task *${escapeMd(task.title)}* marked completed.\nID: \`${taskId}\`${assignerIncentiveLine}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    try {
      const doerIncentiveLine = incentiveInfo
        ? `\n💰 *Incentive earned:* ${fmtMoney(incentiveInfo.amount, incentiveInfo.currency)}  _(pending payout)_`
        : '';
      await bot.sendMessage(task.assigned_to,
        `✅ *Task completed*\n\n${escapeMd(task.title)}${doerIncentiveLine}`,
        { parse_mode: 'Markdown' });
    } catch (_) { /* noop */ }
    // T2: feed for opted-in admins. Money is intentionally NOT in the
    // broadcast message — feed admins are scrum-master role, not finance.
    try {
      const doerName = (await usersRepository.findByUserId(task.assigned_to))?.name || task.assigned_to;
      await adminFeed.notify(bot, 'task.completed',
        `✅ *Task completed*\n\n${escapeMd(task.title)}\n👤 ${escapeMd(doerName)}\nID: \`${taskId}\``,
        { parse_mode: 'Markdown' }, { excludeUserId: userId });
    } catch (e) {
      logger.warn(`taskFlow.handleSignOff: adminFeed task.completed: ${e.message}`);
    }
  } else {
    await editOrSend(bot, chatId, messageId,
      `↩ Task *${escapeMd(task.title)}* sent back to active.\nID: \`${taskId}\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    try {
      await bot.sendMessage(task.assigned_to,
        `↩ Your task was sent back: *${escapeMd(task.title)}* — please re-check and tap *Mark done* again.`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '✅ Mark done', callback_data: `tsk:done:${taskId}` },
          ]] },
        });
    } catch (_) { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// READ-ONLY VIEWS
// ---------------------------------------------------------------------------
// All three views deliberately HIDE incentive amounts. Money lives only
// in the Incentives sheet (and a future finance-only Incentives report).
// ---------------------------------------------------------------------------

function statusBadge(status) {
  const s = STATUS_LABEL[status];
  return s ? `${s.icon} ${s.label}` : status;
}

function buttonsForMyTask(task) {
  switch (task.status) {
    case 'assigned':
      return [
        { text: `⏱ Propose — ${truncate(task.title, 22)}`, callback_data: `tsk:prp:${task.task_id}` },
        { text: '❌ Decline', callback_data: `tsk:dec:${task.task_id}` },
      ];
    case 'awaiting_final_ack':
      return [
        { text: `✅ Accept — ${truncate(task.title, 22)}`, callback_data: `tsk:fa:${task.task_id}` },
        { text: '↩ Renegotiate', callback_data: `tsk:rng:${task.task_id}` },
      ];
    case 'active':
      return [
        { text: `✅ Done — ${truncate(task.title, 30)}`, callback_data: `tsk:done:${task.task_id}` },
      ];
    default:
      return null;
  }
}

async function showMyTasks(bot, chatId, userId, messageId) {
  const tasks = await tasksRepository.getByAssignedTo(userId);
  if (!tasks.length) {
    await editOrSend(bot, chatId, messageId, 'You have no assigned tasks.', {
      reply_markup: { inline_keyboard: [navFooterRow()] },
    });
    return;
  }

  // Sort primarily by priority (critical → high → normal → low). When
  // two tasks share priority, the one with the soonest deadline wins
  // (urgency). When neither has a deadline, fall back to workflow phase
  // so actionable items (active) appear above blocked ones (awaiting).
  const PHASE_RANK = {
    active: 0, awaiting_final_ack: 1, assigned: 2,
    awaiting_timeline_ack: 3, awaiting_incentive: 4, submitted: 5,
  };
  function deadlineMs(t) {
    if (!t.proposed_deadline) return Number.POSITIVE_INFINITY;
    const ms = new Date(t.proposed_deadline).getTime();
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  }
  const visible = tasks
    .filter((t) => PHASE_RANK[t.status] != null)
    .sort((a, b) => {
      const pa = PRIORITY_RANK[getPriority(a)] ?? 2;
      const pb = PRIORITY_RANK[getPriority(b)] ?? 2;
      if (pa !== pb) return pa - pb;
      const da = deadlineMs(a);
      const db = deadlineMs(b);
      if (da !== db) return da - db;
      return PHASE_RANK[a.status] - PHASE_RANK[b.status];
    });
  const done = tasks.filter((t) => t.status === 'completed').slice(-5);
  const offRoll = tasks.filter((t) =>
    t.status === 'declined' || t.status === 'cancelled' || t.status === 'dropped'
  ).slice(-3);

  const lines = ['📋 *Your Tasks* — _by priority, soonest first_', ''];
  const rows = [];

  // Render with a tiny priority header that resets each time the priority
  // tier changes — easier to scan when the list is long.
  let lastPriorityTier = null;
  for (const t of visible) {
    const p = getPriority(t);
    if (p !== lastPriorityTier) {
      lastPriorityTier = p;
      const pm = PRIORITY_META[p] || PRIORITY_META.normal;
      lines.push('', `${pm.icon} *${pm.label}*`);
    }
    const tm = TRACK_META[t.track] || TRACK_META.salaried;
    lines.push(`   ${escapeMd(t.title)} · ${tm.icon} ${tm.label}  \`${t.task_id}\``);
    lines.push(`     ${statusBadge(t.status)}`);
    if (t.proposed_hours && t.proposed_deadline) {
      lines.push(`     ⏱ ${fmtHours(t.proposed_hours)} · 📅 ${fmtDate(t.proposed_deadline)}`);
    }
    const btns = buttonsForMyTask(t);
    if (btns) rows.push(btns);
  }
  if (done.length) {
    lines.push('', '✅ *Recently completed:*');
    for (const t of done) lines.push(`   ${escapeMd(t.title)}`);
  }
  if (offRoll.length) {
    lines.push('', '🚫 *Declined / cancelled / dropped:*');
    for (const t of offRoll) lines.push(`   ${escapeMd(t.title)}  (${t.status})`);
  }

  rows.push(navFooterRow());

  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows },
  });
}

async function showTeamTasks(bot, chatId, userId, messageId) {
  const isAdm = isAdmin(userId);
  const actor = await usersRepository.findByUserId(userId);
  if (!canManage(actor, isAdm)) {
    await editOrSend(bot, chatId, messageId,
      'You don\'t manage any department, so there are no team tasks to show.',
      { reply_markup: { inline_keyboard: [navFooterRow()] } });
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
    await editOrSend(bot, chatId, messageId, 'No tasks for your team yet.', {
      reply_markup: { inline_keyboard: [navFooterRow()] },
    });
    return;
  }
  const nameById = new Map(team.map((u) => [String(u.user_id), u.name || u.user_id]));
  const openSet = new Set([
    'assigned', 'awaiting_timeline_ack', 'awaiting_incentive', 'awaiting_final_ack',
    'active', 'submitted',
  ]);
  const open = tasks.filter((t) => openSet.has(t.status));
  const recent = tasks.filter((t) => t.status === 'completed').slice(-5);

  // Sort open tasks by priority (critical first) so the manager scans
  // urgency first, then by assignee for grouping. Within priority,
  // tasks the doer hasn't even proposed on yet sort below in-flight ones.
  const PHASE_RANK = {
    active: 0, submitted: 1, awaiting_final_ack: 2, awaiting_timeline_ack: 3,
    awaiting_incentive: 4, assigned: 5,
  };
  open.sort((a, b) => {
    const pa = PRIORITY_RANK[getPriority(a)] ?? 2;
    const pb = PRIORITY_RANK[getPriority(b)] ?? 2;
    if (pa !== pb) return pa - pb;
    return (PHASE_RANK[a.status] ?? 9) - (PHASE_RANK[b.status] ?? 9);
  });

  const lines = ['👥 *Team Tasks*\n_(scrum-master view — no money shown)_', ''];
  const rows = [];
  if (!open.length) lines.push('_No open tasks._');
  else {
    for (const t of open) {
      const pm = PRIORITY_META[getPriority(t)] || PRIORITY_META.normal;
      const tm = TRACK_META[t.track] || TRACK_META.salaried;
      lines.push(`${pm.icon} ${escapeMd(t.title)} · ${tm.icon} ${tm.label}`);
      lines.push(`     👤 ${escapeMd(nameById.get(t.assigned_to) || t.assigned_to)} · ${statusBadge(t.status)}  \`${t.task_id}\``);
      if (t.proposed_hours && t.proposed_deadline) {
        lines.push(`     ⏱ ${fmtHours(t.proposed_hours)} · 📅 ${fmtDate(t.proposed_deadline)}`);
      }
      // Manager controls: Re-prioritize + Drop-off. Drop is hidden on
      // 'submitted' (doer marked done — assigner should approve/reject,
      // not silently drop the delivered work).
      const mgrRow = [
        { text: `🔝 Prio · ${truncate(t.title, 14)}`, callback_data: `tsk:prio_pick:${t.task_id}` },
      ];
      if (t.status !== 'submitted') {
        mgrRow.push({ text: '🚫 Drop', callback_data: `tsk:drop_ask:${t.task_id}` });
      }
      rows.push(mgrRow);
    }
  }
  if (recent.length) {
    lines.push('', '✅ *Recently completed:*');
    for (const t of recent) {
      lines.push(`   ${escapeMd(t.title)} — ${escapeMd(nameById.get(t.assigned_to) || t.assigned_to)}`);
    }
  }
  rows.push(navFooterRow());
  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function showPendingSignOff(bot, chatId, userId, messageId) {
  const isAdm = isAdmin(userId);
  const tasks = isAdm
    ? await tasksRepository.getSubmittedPendingApproval()
    : await tasksRepository.getSubmittedForAssigner(userId);
  if (!tasks.length) {
    await editOrSend(bot, chatId, messageId, 'No tasks waiting for your sign-off.', {
      reply_markup: { inline_keyboard: [navFooterRow()] },
    });
    return;
  }
  const lines = ['⏳ *Pending Sign-off*', ''];
  const rows = [];
  for (const t of tasks) {
    const pm = PRIORITY_META[getPriority(t)] || PRIORITY_META.normal;
    const tm = TRACK_META[t.track] || TRACK_META.salaried;
    const by = (await usersRepository.findByUserId(t.assigned_to))?.name || t.assigned_to;
    lines.push(`${pm.icon} ${escapeMd(t.title)} · ${tm.icon} ${tm.label}  \`${t.task_id}\``);
    lines.push(`     👤 ${escapeMd(by)}`);
    if (t.proposed_hours && t.proposed_deadline) {
      lines.push(`     ⏱ ${fmtHours(t.proposed_hours)} · 📅 ${fmtDate(t.proposed_deadline)}`);
    }
    rows.push([
      { text: `✅ Approve ${truncate(t.title, 22)}`, callback_data: `tsk:sign:ok:${t.task_id}` },
      { text: '❌ Reject', callback_data: `tsk:sign:no:${t.task_id}` },
    ]);
  }
  rows.push(navFooterRow());
  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows },
  });
}

// ---------------------------------------------------------------------------
// PAYOUTS — finance-only queue of incentives awaiting disbursement.
// Reads the Incentives sheet; never touches Tasks (so admin/scrum-master
// views remain money-blind). Visibility gated by config.access.financeIds.
// ---------------------------------------------------------------------------

async function showPayouts(bot, chatId, userId, messageId) {
  if (!isFinance(userId)) {
    await editOrSend(bot, chatId, messageId,
      '🔒 *Payouts* is finance-only.\n\nIf you should have access, ask an admin to add your user ID to `FINANCE_IDS` in the environment.',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  let incentives = [];
  try {
    incentives = await incentivesRepository.getAll();
  } catch (e) {
    logger.error(`taskFlow.showPayouts: read Incentives failed: ${e.message}`);
    await editOrSend(bot, chatId, messageId,
      `❌ Couldn\'t read incentives: ${e.message}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  const queue = incentives.filter((i) => i.paid_status === 'awaiting_payout');
  const paidRecent = incentives.filter((i) => i.paid_status === 'paid')
    .sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)))
    .slice(0, 5);

  const lines = ['💰 *Payouts queue*', ''];

  if (!queue.length) {
    lines.push('_No incentives are awaiting payout._', '');
  } else {
    const totalByCcy = new Map();
    for (const i of queue) {
      const c = i.currency || 'NGN';
      totalByCcy.set(c, (totalByCcy.get(c) || 0) + (Number(i.amount) || 0));
    }
    const totals = [...totalByCcy.entries()].map(([c, n]) => fmtMoney(n, c)).join(' · ');
    lines.push(`📊 *${queue.length} incentive${queue.length === 1 ? '' : 's'}* awaiting · ${totals}`, '');
  }

  const rows = [];
  for (const inc of queue) {
    let title = inc.task_id;
    let doerName = '?';
    try {
      const task = await tasksRepository.getById(inc.task_id);
      if (task) {
        title = task.title || inc.task_id;
        const doer = await usersRepository.findByUserId(task.assigned_to);
        if (doer) doerName = doer.name || task.assigned_to;
      }
    } catch (_) { /* keep fallbacks */ }
    const amt = fmtMoney(inc.amount, inc.currency);
    lines.push(`• ${escapeMd(title)} → ${escapeMd(doerName)} · *${amt}*  \`${inc.task_id}\``);
    rows.push([
      { text: `✅ Mark paid — ${truncate(title, 22)} (${amt})`, callback_data: `tsk:py:p:${inc.task_id}` },
    ]);
  }

  if (paidRecent.length) {
    lines.push('', '🗂 *Recently paid (last 5)*');
    for (const inc of paidRecent) {
      let title = inc.task_id;
      try {
        const task = await tasksRepository.getById(inc.task_id);
        if (task) title = task.title || inc.task_id;
      } catch (_) { /* fallback */ }
      const amt = fmtMoney(inc.paid_amount != null ? inc.paid_amount : inc.amount, inc.currency);
      const when = inc.paid_at ? fmtDate(inc.paid_at) : '';
      lines.push(`  ${escapeMd(title)} · *${amt}*${when ? ' · ' + when : ''}`);
    }
  }

  rows.push(navFooterRow());

  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows },
  });
}

async function handleMarkPaid(bot, callbackQuery, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  if (!isFinance(userId)) {
    try {
      await bot.answerCallbackQuery(callbackQuery.id,
        { text: 'Only finance can mark incentives as paid.', show_alert: true });
    } catch (_) { /* noop */ }
    return;
  }

  let incentive;
  try {
    incentive = await incentivesRepository.getByTaskId(taskId);
  } catch (e) {
    logger.error(`taskFlow.handleMarkPaid: lookup failed: ${e.message}`);
    await editOrSend(bot, chatId, messageId, `❌ Lookup failed: ${e.message}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  if (!incentive) {
    await editOrSend(bot, chatId, messageId, `ℹ️ No incentive row found for \`${taskId}\`.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  if (incentive.paid_status === 'paid') {
    await editOrSend(bot, chatId, messageId,
      `ℹ️ ${fmtMoney(incentive.amount, incentive.currency)} for \`${taskId}\` is already marked paid.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  if (incentive.paid_status !== 'awaiting_payout') {
    await editOrSend(bot, chatId, messageId,
      `⚠️ Incentive for \`${taskId}\` is *${incentive.paid_status || 'pending'}* — only \`awaiting_payout\` rows can be marked paid here.\n\nThis usually means the task hasn\'t been approved yet. Approve the task first; the Payouts queue will then pick it up.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  // Update Incentives row + write a TaskEvents audit row so the trail
  // shows finance disbursement explicitly (not just the bot's clock).
  const paid_at = new Date().toISOString();
  try {
    await incentivesRepository.markPaid({
      task_id: taskId,
      paid_amount: incentive.amount,
      paid_at,
    });
    try {
      await taskEventsRepository.append({
        task_id: taskId,
        event_type: 'finance_marked_paid',
        from_status: '',
        to_status: '',
        actor_user_id: userId,
        at: paid_at,
        meta: { amount: incentive.amount, currency: incentive.currency },
      });
    } catch (e) {
      logger.warn(`taskFlow.handleMarkPaid: audit append failed: ${e.message}`);
    }
  } catch (e) {
    logger.error(`taskFlow.handleMarkPaid: markPaid failed: ${e.message}`);
    await editOrSend(bot, chatId, messageId,
      `❌ Couldn\'t mark paid: ${e.message}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  let taskTitle = taskId;
  let doerId = null;
  try {
    const task = await tasksRepository.getById(taskId);
    if (task) {
      taskTitle = task.title || taskId;
      doerId = task.assigned_to;
    }
  } catch (_) { /* fallback */ }

  // DM the doer — they earned this and they deserve to hear that it's
  // settled. The receipt is short and doesn't expose anyone else's data.
  if (doerId) {
    try {
      await bot.sendMessage(doerId,
        `💰 *Incentive paid*\n\n${escapeMd(taskTitle)}\nAmount: *${fmtMoney(incentive.amount, incentive.currency)}*\n\n_Thank you for the work._`,
        { parse_mode: 'Markdown' });
    } catch (e) {
      logger.warn(`taskFlow.handleMarkPaid: DM doer failed: ${e.message}`);
    }
  }

  // T2: feed event for opted-in admins (default ON, finance group).
  try {
    await adminFeed.notify(bot, 'payout.paid',
      `💰 *Payout disbursed*\n\n${escapeMd(taskTitle)}\nAmount: *${fmtMoney(incentive.amount, incentive.currency)}*\nID: \`${taskId}\``,
      { parse_mode: 'Markdown' }, { excludeUserId: userId });
  } catch (e) {
    logger.warn(`taskFlow.handleMarkPaid: adminFeed payout.paid: ${e.message}`);
  }

  // Re-render the queue so the row vanishes and the totals refresh.
  await showPayouts(bot, chatId, userId, messageId);
}

// ---------------------------------------------------------------------------

module.exports = {
  visibleTaskActivityCodes,
  startAssign,
  handleCallback,
  handleTextStep,
  showMyTasks,
  showTeamTasks,
  showPendingSignOff,
  showPayouts,
  // exported for smoke harness
  _internals: {
    fmtHours,
    fmtDate,
    decodeLegacyDescription,
    getPriority,
  },
};
