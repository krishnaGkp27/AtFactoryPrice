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
const { todayInLagos, lagosDayPlus } = require('../utils/dates');
const departmentsRepo = require('../repositories/departmentsRepository');
const tasksRepository = require('../repositories/tasksRepository');
const taskEventsRepository = require('../repositories/taskEventsRepository');
const incentivesRepository = require('../repositories/incentivesRepository');
const taskStateMachine = require('./taskStateMachine');
const sessionStore = require('../utils/sessionStore');
// TSK-V3 — the stall threshold (TASK_STALL_DAYS) is owner-tunable from the
// Settings sheet; 30s repo cache keeps this off the hot path.
const settingsRepository = require('../repositories/settingsRepository');
// TSK-V2 — the LOCAL fmtDate below is date-only; clock times come from the
// shared util, which is also Lagos-aware (TIME-1). Kept under a distinct
// name so the 14 existing fmtDate call sites are untouched.
const dateUtil = require('../utils/formatDate');
const deptGraph = require('../org/deptGraph');
const auth = require('../middlewares/auth');
const config = require('../config');
const logger = require('../utils/logger');
const adminFeed = require('../services/adminFeed');
// taskFlow renders incentives in DMs/inline rows where the symbol form
// ("₦5,000") reads better than the long form. Centralized helpers live in
// utils/format and utils/telegramUI.
const { fmtMoneyShort: fmtMoney } = require('../utils/format');
const { editOrSend, isNotModified } = require('../utils/telegramUI');

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

/* TSK-V2 (owner, 26-Aug-2026) — the time chart. Twelve values, tap only.
 * The typed "custom hours" entry is GONE: a free-text number is the one
 * place this flow could take a mistyped or nonsense figure into the sheet,
 * and every downstream reading of effort (the Gantt bar, ETA-vs-actual,
 * any future assessment) is only as clean as this input. Two rows so the
 * worker reads it as a chart, not a list. */
// TSK-V2 — chips per page. Bounds the message so the 4096-char ceiling
// that used to break these lists silently cannot be reached.
const MY_TASKS_PAGE = 9;

const HOURS_CHART = [1, 2, 3, 4, 6, 8];
const DAYS_CHART = [
  ['1d', 24], ['2d', 48], ['3d', 72], ['4d', 96], ['5d', 120], ['1w', 168],
];
/** The two chart rows as inline-keyboard rows, ticking the current pick. */
function timeChartRows(current, cbPrefix) {
  const tick = (v) => (Number(current) === v ? ' ✓' : '');
  return [
    HOURS_CHART.map((h) => ({ text: `${h}h${tick(h)}`, callback_data: `${cbPrefix}${h}` })),
    DAYS_CHART.map(([label, h]) => ({ text: `${label}${tick(h)}`, callback_data: `${cbPrefix}${h}` })),
  ];
}

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
  return lagosDayPlus(days);  // TIME-1 — offsets from the Lagos day
}

function todayYM() {
  // TIME-1 — the calendar's min month follows the Lagos day too.
  return todayInLagos().slice(0, 7);
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
    { text: '⬅ Back to Tasks', callback_data: 'act:__hub__:planning' },
    { text: '🏠 Menu',          callback_data: 'act:__back__' },
  ];
}

function firstStepFooterRow() {
  return [
    { text: '⬅ Back to Tasks', callback_data: 'act:__hub__:planning' },
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
  if (canManage(user, isAdm)) codes.push('assign_task', 'snap_task', 'team_tasks', 'pending_signoff'); // PTK-1: snap_task rides the same gate
  // Payouts is finance-only — it's the one surface that reads the
  // Incentives sheet and writes paid_status. Money stays gated.
  if (isFinance(userId)) codes.push('payouts');
  return codes;
}

const { mdEscape: escapeMd } = require('../utils/flowKit');

/* TSK-V2 — the description follows the task onto every card. It used to
 * live only in the first DM, which the propose flow then edited away: one
 * tap and the worker could never read their instruction again. Carrying it
 * is what makes editing in place safe. */
function descLine(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return `\n\u{1F5D2} ${escapeMd(t.length > 400 ? `${t.slice(0, 400)}\u2026` : t)}`;
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

  sessionStore.clear(userId, 'completed');
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
    // TSK-V2 — the tracks ask different questions. Salaried work needs one
    // number (the time they commit to); incentivized work opens a deal.
    const salaried = task.track !== 'incentivized';
    const ask = salaried
      ? '*How much time do you need for this work?*'
      : `*How long do you need, and by when?*${incentiveHint}`;
    const firstChip = salaried
      ? { text: '⏱ Accept — give time', callback_data: `tsk:est:${task.task_id}` }
      : { text: '⏱ Propose timeline', callback_data: `tsk:prp:${task.task_id}` };
    await bot.sendMessage(task.assigned_to,
      `${pm.icon} *New Task — ${pm.label}*\n${tm.icon} ${tm.label}\n\n` +
      `📝 *${escapeMd(task.title)}*${descLine}${fromLine}\n\n` +
      `${ask}\n\n` +
      `ID: \`${task.task_id}\``,
      {
        parse_mode: 'Markdown',
        disable_notification: priorityIsSilent(task.priority),
        reply_markup: {
          inline_keyboard: [[
            firstChip,
            { text: '❌ Decline', callback_data: `tsk:dec:${task.task_id}` },
          ]],
        },
      });
    // PTK-1 — a snapped task carries its note photo; the doer reads the
    // original (the object of the task can BE the image). Best-effort.
    if (task.source_file_id) {
      try {
        await bot.sendPhoto(task.assigned_to, task.source_file_id, {
          caption: `📎 The task note — ${task.task_id}`,
          disable_notification: true,
        });
      } catch (e2) {
        logger.warn(`taskFlow.dmAssigneeNewTask: note photo failed for ${task.task_id}: ${e2.message}`);
      }
    }
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
    await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, { reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  if (task.assigned_to !== userId) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assignee can propose a timeline.', show_alert: true }).catch(() => {});
    return;
  }
  if (task.status !== 'assigned') {
    await editOrSend(bot, chatId, messageId,
      `ℹ️ Task ${taskId} is *${task.status}* — proposing a timeline is no longer possible.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  // TSK-V2 — salaried work no longer negotiates. Cards minted before the
  // split still carry this chip, so send them to the one that works rather
  // than letting them walk the wizard and fail at the end.
  if (task.track !== 'incentivized') {
    await editOrSend(bot, chatId, messageId,
      `📋 *${escapeMd(task.title)}*${descLine(task.description)}\n\n`
      + 'This one just needs the time you need — no date to agree.',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '⏱ Accept — give time', callback_data: `tsk:est:${taskId}` },
          { text: '❌ Decline', callback_data: `tsk:dec:${taskId}` }],
        navFooterRow(),
      ] } });
    return;
  }

  // PTK-1 — if the task came from a photo whose text named a date, offer
  // it as the FIRST deadline chip (suggestion only: the doer still
  // proposes — the owner's agreed-not-assigned-at rule stays intact).
  let noteDue = null;
  try {
    const events = await require('../repositories/taskEventsRepository').getByTaskId(taskId);
    const ocrEv = (events || []).find((e) => e.meta && e.meta.ocr);
    const iso = ocrEv && ocrEv.meta.ocr.dueDateISO;
    if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) && iso >= new Date().toISOString().slice(0, 10)) noteDue = iso;
  } catch (_) { /* suggestion only — never blocks the picker */ }

  sessionStore.set(userId, {
    type: 'task_propose_flow',
    step: 'hours',
    flowMessageId: messageId,
    data: {
      taskId, taskTitle: task.title, taskDescription: task.description,
      taskPriority: task.priority, taskTrack: task.track, noteDue,
    },
  });
  await renderHoursPicker(bot, chatId, userId);
}

async function renderHoursPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const cur = session.data?.hours;
  const rows = timeChartRows(cur, 'tsk:phr:');
  rows.push([{ text: '⬅️ Back', callback_data: 'tsk:pcn' }]);
  const t = session.data;
  const pm = PRIORITY_META[t.taskPriority] || PRIORITY_META.normal;
  await anchor(bot, chatId, userId,
    `⏱ *Time needed — tap one*\n\n${pm.icon} *${escapeMd(t.taskTitle)}*${descLine(t.taskDescription)}\n\n`
    + 'How much time do you need for this work?\n_Step 1 of 2 — the date comes next._',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

/* ───────────────────────────────────────────────────────────────────────
 * TSK-V2 — SALARIED: the whole doer side, in one card edited in place.
 *
 *   task card  →  time chart  →  clock running  →  (Mark done)
 *
 * No deadline is ever asked for and none is stored: the implied finish is
 * start + ETA, computed wherever it is shown (§10 — a derived fact must
 * not become a second source of truth). No negotiation, no rounds — a
 * salary instruction is not a bargain.
 * ─────────────────────────────────────────────────────────────────────── */

/**
 * TSK-V2 — the doer's per-task card. ONE card, edited in place, carrying
 * the description and only the chips legal in the task's current state.
 * Every list drills into this; Back from the chart returns to it.
 */
async function renderDoerTaskCard(bot, chatId, userId, taskId, messageId) {
  const task = await tasksRepository.getById(taskId);
  if (!task) {
    await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`,
      { reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  const pm = PRIORITY_META[getPriority(task)] || PRIORITY_META.normal;
  const tm = TRACK_META[task.track] || TRACK_META.salaried;
  const salaried = task.track !== 'incentivized';

  const lines = [
    `${pm.icon} *${escapeMd(task.title)}*`,
    `${tm.icon} ${tm.label} · ${statusBadge(task.status)}`,
    descLine(task.description),
    '',
  ];
  if (task.status === 'active' && task.proposed_hours) {
    lines.push(salaried
      ? `⏱ Time you gave: *${fmtHours(task.proposed_hours)}* · finish by about *${escapeMd(impliedEnd(task))}*`
      : `⏱ *${fmtHours(task.proposed_hours)}* · 📅 by *${fmtDate(task.proposed_deadline)}*`);
  } else if (task.proposed_hours && task.proposed_deadline) {
    lines.push(`⏱ *${fmtHours(task.proposed_hours)}* · 📅 *${fmtDate(task.proposed_deadline)}*`);
  }
  try {
    const from = await usersRepository.findByUserId(task.assigned_by);
    if (from) lines.push(`👤 From: ${escapeMd(from.name || task.assigned_by)}`);
  } catch (_) { /* name is a nicety */ }
  lines.push('', `ID: \`${task.task_id}\``);

  const rows = [];
  const act = buttonsForMyTask(task);
  if (act) rows.push(act);
  rows.push([
    { text: '⬅ My Tasks', callback_data: 'tsk:mine' },
    { text: '🏠 Menu', callback_data: 'act:__back__' },
  ]);
  await editOrSend(bot, chatId, messageId, lines.filter((l) => l !== null).join('\n'),
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

/**
 * TSK-V2 — "ETA 4h · took 5h 20m": the work-assessment line. Both numbers
 * are already on the row (the committed hours, and start→submit from the
 * timestamps), so this is read-time arithmetic, never a stored figure.
 */
function etaVsActual(task) {
  const hrs = Number(task.proposed_hours);
  const start = task.started_at ? new Date(task.started_at) : null;
  const end = task.submitted_at ? new Date(task.submitted_at) : null;
  if (!Number.isFinite(hrs)) return '';
  const eta = `⏱ ETA *${fmtHours(hrs)}*`;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return eta;
  const mins = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const took = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
  return `${eta} · took *${took}*`;
}

/** Open the time chart for a salaried task, editing the task card itself. */
async function startEstimateFlow(bot, callbackQuery, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  const task = await tasksRepository.getById(taskId);
  if (!task) {
    await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`,
      { reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  // The pre-ACK at the top of handleCallback makes a show_alert toast a
  // no-op, so every refusal is rendered into the card the tapper is looking
  // at instead of a popup they would never see.
  if (String(task.assigned_to) !== userId) {
    await editOrSend(bot, chatId, messageId,
      'ℹ️ Only the person this task was given to can accept it.',
      { reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  if (task.status !== 'assigned') {
    await editOrSend(bot, chatId, messageId,
      `ℹ️ This task is *${escapeMd(task.status)}* — it is no longer waiting on your time.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  sessionStore.set(userId, {
    type: 'task_estimate_flow',
    step: 'hours',
    flowMessageId: messageId,
    data: {
      taskId,
      taskTitle: task.title,
      taskDescription: task.description,
      taskPriority: task.priority,
    },
  });
  await renderEstimateChart(bot, chatId, userId);
}

async function renderEstimateChart(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'task_estimate_flow') return;
  const t = session.data;
  const pm = PRIORITY_META[t.taskPriority] || PRIORITY_META.normal;
  const rows = timeChartRows(null, 'tsk:ehr:');
  rows.push([
    { text: '⬅️ Back', callback_data: `tsk:eback:${t.taskId}` },
    { text: '❌ Decline task', callback_data: `tsk:dec:${t.taskId}` },
  ]);
  await anchor(bot, chatId, userId,
    `⏱ *Time needed — tap one*\n\n${pm.icon} *${escapeMd(t.taskTitle)}*${descLine(t.taskDescription)}\n\n`
    + 'How much time do you need for this work?\n_The clock starts when you pick._',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

/** The tap that commits the time AND starts the clock. */
async function submitEstimate(bot, chatId, userId, hours) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'task_estimate_flow') return;
  const t = session.data;
  let task;
  try {
    const res = await taskStateMachine.transition(t.taskId, 'accept_estimate', userId, { hours });
    task = res.task;
  } catch (e) {
    logger.error(`taskFlow.submitEstimate: ${e.message}`);
    sessionStore.clear(userId);
    await editOrSend(bot, chatId, session.flowMessageId,
      `❌ Couldn't start this task: ${escapeMd(e.message)}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  sessionStore.clear(userId, 'completed');
  await editOrSend(bot, chatId, session.flowMessageId, runningCardText(task),
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '✅ Mark done', callback_data: `tsk:done:${t.taskId}` }],
    ] } });

  // The assigner learns the commitment — information, not an approval step.
  try {
    const pm = PRIORITY_META[task.priority] || PRIORITY_META.normal;
    const doer = await usersRepository.findByUserId(userId);
    await bot.sendMessage(task.assigned_by,
      `⏱ *Time given — clock started*\n\n`
      + `${pm.icon} ${escapeMd(task.title)}\n`
      + `👤 ${escapeMd(doer?.name || userId)} needs *${fmtHours(hours)}* · finish by about *${impliedEnd(task)}*\n`
      + `ID: \`${t.taskId}\``,
      { parse_mode: 'Markdown', disable_notification: priorityIsSilent(task.priority) });
  } catch (e) {
    logger.warn(`taskFlow.submitEstimate: assigner DM failed: ${e.message}`);
  }
}

/** "Working" card — the same message, now showing the running commitment. */
function runningCardText(task) {
  const pm = PRIORITY_META[task.priority] || PRIORITY_META.normal;
  const started = task.started_at ? dateUtil.withTime(task.started_at) : '';
  return `🟢 *Working — clock started*\n\n`
    + `${pm.icon} *${escapeMd(task.title)}*${descLine(task.description)}\n\n`
    + `⏱ Time you gave: *${fmtHours(task.proposed_hours)}*${started ? ` · started ${escapeMd(started)}` : ''}\n`
    + `🎯 Finish by about *${escapeMd(impliedEnd(task))}*\n\n`
    + `When done, tap *Mark done*.\nID: \`${task.task_id}\``;
}

/**
 * The implied finish of a salaried task: start + committed hours. COMPUTED,
 * never stored — the sheet keeps the two facts it was given and this is
 * derived from them at read time (§10).
 */
function impliedEnd(task) {
  const start = task.started_at ? new Date(task.started_at) : null;
  const hrs = Number(task.proposed_hours);
  if (!start || Number.isNaN(start.getTime()) || !Number.isFinite(hrs)) return '—';
  const end = new Date(start.getTime() + hrs * 3600 * 1000);
  const sameDay = end.toDateString() === start.toDateString();
  const hhmm = dateUtil.withTime(end.toISOString());
  return sameDay ? `${String(hhmm).slice(-5)} today` : String(hhmm);
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
  // PTK-1 — the note's own date leads, marked as such.
  if (session.data?.noteDue) {
    rows.unshift([{
      text: `📅 ${fmtDate(session.data.noteDue)} — from the note${cur === session.data.noteDue ? ' ✓' : ''}`,
      callback_data: 'tsk:pdl:note',
    }]);
  }
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

  // TIME-1 — anchor the grid on the LAGOS day, like todayYM()/addDays() above.
  // Leaving this on the server clock made the two deadline pickers disagree:
  // the chips offered one day while the grid marked and permitted another.
  const [_ty, _tm, _td] = todayInLagos().split('-').map(Number);
  const today = new Date(_ty, _tm - 1, _td);
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
      `❌ Couldn\'t submit proposal: ${escapeMd(e.message)}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  sessionStore.clear(userId, 'completed');
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
      // screen already correct — success, not a reason to send a new card
      if (isNotModified(e)) return opts.editMessageId;
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
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, { reply_markup: { inline_keyboard: [navFooterRow()] } }); return; }
  if (task.assigned_to !== userId) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assignee can decline.', show_alert: true }).catch(() => {});
    return;
  }
  try {
    await taskStateMachine.transition(taskId, 'decline', userId);
  } catch (e) {
    await editOrSend(bot, chatId, messageId, `❌ Couldn\'t decline: ${e.message}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
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
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, { reply_markup: { inline_keyboard: [navFooterRow()] } }); return; }
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
    await editOrSend(bot, chatId, messageId, `❌ Couldn\'t accept: ${e.message}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
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
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, { reply_markup: { inline_keyboard: [navFooterRow()] } }); return; }
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
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
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
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, { reply_markup: { inline_keyboard: [navFooterRow()] } }); return; }
  if (task.assigned_by !== userId && !isAdmin(userId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assigner or an admin can counter.', show_alert: true }).catch(() => {});
    return;
  }
  if ((task.negotiation_rounds || 0) >= taskStateMachine.MAX_NEGOTIATION_ROUNDS) {
    await editOrSend(bot, chatId, messageId,
      `⚠️ Negotiation cap reached (${task.negotiation_rounds}/${taskStateMachine.MAX_NEGOTIATION_ROUNDS}). Accept the proposal or cancel the task.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
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
    await editOrSend(bot, chatId, session.flowMessageId, `❌ Couldn\'t counter: ${e.message}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  sessionStore.clear(userId, 'completed');
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
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, { reply_markup: { inline_keyboard: [navFooterRow()] } }); return; }
  try {
    await taskStateMachine.transition(taskId, 'cancel', userId);
  } catch (e) {
    await editOrSend(bot, chatId, messageId, `❌ Couldn\'t cancel: ${e.message}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
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
  sessionStore.clear(userId, 'completed');
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
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, { reply_markup: { inline_keyboard: [navFooterRow()] } }); return; }
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
        [{ text: '⬅ Back to Tasks', callback_data: 'act:__hub__:planning' }],
      ] },
    });
}

/**
 * TSK-V3 — the same 4-priority pick rendered ONTO the admin task card
 * (minimum depth: the card becomes the picker, the pick returns the card).
 */
async function renderInlinePriorityPicker(bot, callbackQuery, taskId, ctx) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task || !OPEN_STATUSES.has(task.status)) {
    await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx);
    return;
  }
  if (!(await _guardAssignerOrAdmin(bot, callbackQuery, task))) return;
  const cur = getPriority(task);
  const cs = ctxStr(ctx);
  const btns = ['critical', 'high', 'normal', 'low'].map((p) => ({
    text: `${PRIORITY_META[p].icon} ${PRIORITY_META[p].label}${cur === p ? ' ✓' : ''}`,
    callback_data: `tsk:tps:${cs}:${p}:${taskId}`,
  }));
  await editOrSend(bot, chatId, messageId,
    `🔝 *Priority*\n\n${escapeMd(task.title)}\n\nCurrent: ${PRIORITY_META[cur]?.icon || ''} *${PRIORITY_META[cur]?.label || cur}* — tap the new one:`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        btns.slice(0, 2), btns.slice(2, 4),
        [{ text: '⬅ Back', callback_data: `tsk:tt:${cs}:${taskId}` }],
      ] },
    });
}

async function applyPriority(bot, callbackQuery, taskId, newPriority, opts = {}) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  if (!PRIORITY_META[newPriority]) {
    await editOrSend(bot, chatId, messageId, '❌ Invalid priority.', { reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, { reply_markup: { inline_keyboard: [navFooterRow()] } }); return; }
  if (!(await _guardAssignerOrAdmin(bot, callbackQuery, task))) return;

  const oldPriority = getPriority(task);
  if (oldPriority === newPriority) {
    // TSK-V3 in-place path: tapping the current priority just returns the card.
    if (opts.afterRender) { await opts.afterRender(); return; }
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
  if (opts.afterRender) {
    // TSK-V3 — return to the card (now wearing the new dot) instead of a
    // terminal "changed" screen; the doer DM + feed below still go out.
    await opts.afterRender();
  } else {
    await editOrSend(bot, chatId, messageId,
      `🔝 *Priority changed*\n\n${escapeMd(task.title)}\n${oldPm.icon} ${oldPm.label} → ${newPm.icon} *${newPm.label}*`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
  }

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

/**
 * Show the drop confirm card with optional reason reply. `returnCtx`
 * (TSK-V3) is the list position to land on after the drop — the drop
 * session already exists for the typed reason, so the context rides it.
 */
async function startDropAsk(bot, callbackQuery, taskId, returnCtx = null) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, { reply_markup: { inline_keyboard: [navFooterRow()] } }); return; }
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
    data: { taskId, taskTitle: task.title, doerName, returnCtx },
  });
  await editOrSend(bot, chatId, messageId,
    `🚫 *Drop task*\n\n${escapeMd(task.title)}\n👤 From: *${escapeMd(doerName)}*\n\n` +
    `_Optional: reply with a 1-line reason so the doer knows why._\n_Or just tap_ *Confirm drop* _to remove it from their plate._\n\nMax ${DROP_REASON_MAX_LEN} chars.`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '🚫 Yes, drop', callback_data: `tsk:drop_go:${taskId}` },
         { text: '⬅ Keep',       callback_data: 'tsk:drop_cancel' }],
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
  sessionStore.clear(userId, 'completed');
  const reasonLine = reason ? `\n💬 _Reason:_ ${escapeMd(reason)}` : '';
  if (t.returnCtx) {
    // TSK-V3 — back to the list, task gone; that IS the confirmation.
    await renderTeamList(bot, chatId, userId, session.flowMessageId, parseListCtx(t.returnCtx));
  } else {
    await editOrSend(bot, chatId, session.flowMessageId,
      `🚫 *Task dropped*\n\n${escapeMd(t.taskTitle)}\n👤 ${escapeMd(t.doerName)} has been notified.${reasonLine}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
  }
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
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, { reply_markup: { inline_keyboard: [navFooterRow()] } }); return; }
  if (task.assigned_to !== userId) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assignee can confirm the deal.', show_alert: true }).catch(() => {});
    return;
  }
  try {
    await taskStateMachine.transition(taskId, 'final_ack', userId);
  } catch (e) {
    await editOrSend(bot, chatId, messageId, `❌ Couldn\'t accept: ${e.message}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
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
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, { reply_markup: { inline_keyboard: [navFooterRow()] } }); return; }
  if (task.assigned_to !== userId) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assignee can renegotiate.', show_alert: true }).catch(() => {});
    return;
  }
  if ((task.negotiation_rounds || 0) >= taskStateMachine.MAX_NEGOTIATION_ROUNDS) {
    await editOrSend(bot, chatId, messageId,
      `⚠️ Negotiation cap reached. Accept the deal or it will need to be cancelled.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  try {
    await taskStateMachine.transition(taskId, 'renegotiate', userId);
  } catch (e) {
    await editOrSend(bot, chatId, messageId, `❌ Couldn\'t renegotiate: ${e.message}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
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
  // TSK-V2 — salaried: open the chart, or commit the time. `tsk:eback:`
  // returns the untouched task card so Back never strands the worker.
  // TSK-V2 — the list/detail pair, both in the one anchored message.
  if (data === 'tsk:mine') { await showMyTasks(bot, chatId, userId, messageId); return true; }
  if (data.startsWith('tsk:t:')) { await renderDoerTaskCard(bot, chatId, userId, data.slice('tsk:t:'.length), messageId); return true; }
  if (data.startsWith('tsk:est:')) { await startEstimateFlow(bot, callbackQuery, data.slice('tsk:est:'.length)); return true; }
  if (data.startsWith('tsk:ehr:')) {
    const est = sessionStore.get(userId);
    if (!est || est.type !== 'task_estimate_flow') {
      await editOrSend(bot, chatId, messageId,
        '⏳ This card has expired. Open the task again and tap *Accept — give time*.',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
      return true;
    }
    est.flowMessageId = messageId;
    sessionStore.set(userId, est);
    await submitEstimate(bot, chatId, userId, Number(data.slice('tsk:ehr:'.length)));
    return true;
  }
  if (data.startsWith('tsk:eback:')) {
    sessionStore.clear(userId, 'cancelled');
    await renderDoerTaskCard(bot, chatId, userId, data.slice('tsk:eback:'.length), messageId);
    return true;
  }
  // TSK-V3 — the Team Tasks admin list. List context (mode:filter:page)
  // rides in the callback_data, never in a session: a restart or a week-old
  // message can't strand the pager. Session-free by construction.
  if (data.startsWith('tsk:tp:')) {
    await renderTeamList(bot, chatId, userId, messageId, parseListCtx(data.slice('tsk:tp:'.length)));
    return true;
  }
  if (data.startsWith('tsk:tt:')) {
    const p = data.slice('tsk:tt:'.length).split(':');
    await renderAdminTaskCard(bot, chatId, userId, p.slice(3).join(':'), messageId,
      parseListCtx(p.slice(0, 3).join(':')));
    return true;
  }
  if (data.startsWith('tsk:tpp:')) {
    const p = data.slice('tsk:tpp:'.length).split(':');
    await renderInlinePriorityPicker(bot, callbackQuery, p.slice(3).join(':'),
      parseListCtx(p.slice(0, 3).join(':')));
    return true;
  }
  if (data.startsWith('tsk:tps:')) {
    // tsk:tps:<mode>:<filter>:<page>:<priority>:<taskId>
    const p = data.slice('tsk:tps:'.length).split(':');
    const ctx = parseListCtx(p.slice(0, 3).join(':'));
    const tid = p.slice(4).join(':');
    await applyPriority(bot, callbackQuery, tid, p[3], {
      afterRender: () => renderAdminTaskCard(bot, chatId, userId, tid, messageId, ctx),
    });
    return true;
  }
  if (data.startsWith('tsk:sg:')) {
    // tsk:sg:<y|n>:<mode>:<filter>:<page>:<taskId> — sign-off from the admin
    // card; on success the LIST re-renders with the task gone, so the next
    // one is right there.
    const p = data.slice('tsk:sg:'.length).split(':');
    const ctx = parseListCtx(p.slice(1, 4).join(':'));
    await handleSignOff(bot, callbackQuery, p.slice(4).join(':'), p[0] === 'y', {
      afterRender: () => renderTeamList(bot, chatId, userId, messageId, ctx),
    });
    return true;
  }
  if (data.startsWith('tsk:rmon:')) {
    const p = data.slice('tsk:rmon:'.length).split(':');
    await requestAutoRemind(bot, callbackQuery, parseListCtx(p.slice(0, 3).join(':')), p.slice(3).join(':'));
    return true;
  }
  if (data.startsWith('tsk:rmoff:')) {
    const p = data.slice('tsk:rmoff:'.length).split(':');
    await stopAutoRemind(bot, callbackQuery, parseListCtx(p.slice(0, 3).join(':')), p.slice(3).join(':'));
    return true;
  }
  if (data.startsWith('tsk:rmd:')) {
    const p = data.slice('tsk:rmd:'.length).split(':');
    await handleRemind(bot, callbackQuery, parseListCtx(p.slice(0, 3).join(':')), p.slice(3).join(':'));
    return true;
  }
  if (data.startsWith('tsk:tdd:')) {
    const p = data.slice('tsk:tdd:'.length).split(':');
    await startDropAsk(bot, callbackQuery, p.slice(3).join(':'), p.slice(0, 3).join(':'));
    return true;
  }
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
    const back = s && s.type === 'task_drop_flow' ? s.data : null;
    if (s && s.type === 'task_drop_flow') sessionStore.clear(userId, 'cancelled');
    if (back && back.returnCtx) {
      // TSK-V3 — "Keep" returns the untouched task card, not a dead end.
      await renderAdminTaskCard(bot, chatId, userId, back.taskId, messageId,
        parseListCtx(back.returnCtx));
      return true;
    }
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
              || s.type === 'task_drop_flow' || s.type === 'task_estimate_flow')) {
      sessionStore.clear(userId, 'cancelled');
    }
    await editOrSend(bot, chatId, messageId, '❌ Cancelled.', {
      reply_markup: { inline_keyboard: [navFooterRow()] },
    });
    return true;
  }

  // ----- Propose-timeline flow (`task_propose_flow`) ----------------------
  if (data === 'tsk:pcn') {
    sessionStore.clear(userId, 'cancelled');
    await editOrSend(bot, chatId, messageId, '❌ Proposal cancelled.', {
      reply_markup: { inline_keyboard: [navFooterRow()] },
    });
    return true;
  }
  if (data.startsWith('tsk:phr:')
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
    if (data.startsWith('tsk:pdl:')) {
      const key = data.slice('tsk:pdl:'.length);
      if (key === 'note' && session.data.noteDue) {
        session.data.deadline = session.data.noteDue; // PTK-1
      } else {
        const preset = DEADLINE_PRESETS.find(([k]) => k === key);
        if (preset) session.data.deadline = addDays(preset[2]);
      }
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
        sessionStore.clear(userId, 'cancelled');
        await editOrSend(bot, chatId, messageId, '❌ Counter cancelled.', {
          reply_markup: { inline_keyboard: [navFooterRow()] },
        });
        return true;
      }
      await submitCounter(bot, chatId, userId, '');
      return true;
    }
    // Expired: say so instead of silently doing nothing forever.
    await editOrSend(bot, chatId, messageId,
      '⏳ This counter-offer card has expired. Open the task DM and tap Counter again.', {
        reply_markup: { inline_keyboard: [navFooterRow()] },
      });
    return true;
  }

  // ----- Incentive flow ---------------------------------------------------
  if (data.startsWith('tsk:sip:')) {
    const session = sessionStore.get(userId);
    if (session && session.type === 'task_incentive_flow') {
      await finalizeIncentive(bot, chatId, userId, 0);
      return true;
    }
    await editOrSend(bot, chatId, messageId,
      '⏳ This incentive card has expired. Open the task DM and set the incentive again.', {
        reply_markup: { inline_keyboard: [navFooterRow()] },
      });
    return true;
  }
  if (data.startsWith('tsk:sib:')) {
    const session = sessionStore.get(userId);
    if (session && session.type === 'task_incentive_flow' && session.data.returnToProposalCard) {
      const cardMsgId = session.flowMessageId;
      const taskId = session.data.taskId;
      sessionStore.clear(userId);
      await renderProposalCardForAssigner(bot, taskId, { editChatId: chatId, editMessageId: cardMsgId });
      return true;
    }
    // No live session — rebuild the proposal card from the task id instead
    // of leaving the button inert.
    await renderProposalCardForAssigner(bot, data.slice('tsk:sib:'.length),
      { editChatId: chatId, editMessageId: messageId }).catch(async () => {
      await editOrSend(bot, chatId, messageId, '⏳ This card has expired.', {
        reply_markup: { inline_keyboard: [navFooterRow()] },
      });
    });
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
    // TSK-V2 — effort is chart-only now; nothing typed reaches the sheet.
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
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, { reply_markup: { inline_keyboard: [navFooterRow()] } }); return; }
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
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  // TSK-V2 — keep the POST-transition row: submitted_at is stamped by the
  // transition, and the sign-off card's "took" figure is computed from it.
  // Using the pre-read row would have silently dropped half that line.
  let submitted = task;
  try {
    const res = await taskStateMachine.transition(taskId, 'mark_done', userId);
    if (res && res.task) submitted = res.task;
  } catch (e) {
    logger.error(`taskFlow.handleMarkDone: ${e.message}`);
    await editOrSend(bot, chatId, messageId, `❌ Could not submit: ${e.message}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  const pm = PRIORITY_META[getPriority(task)] || PRIORITY_META.normal;
  await editOrSend(bot, chatId, messageId,
    `⏳ *Submitted for sign-off*\n\n${pm.icon} ${escapeMd(task.title)}\nID: \`${taskId}\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });

  try {
    await bot.sendMessage(task.assigned_by,
      `📨 *Task awaiting your sign-off*\n\n` +
      `${pm.icon} ${escapeMd(task.title)}${descLine(task.description)}\n` +
      `👤 By: ${escapeMd((await usersRepository.findByUserId(task.assigned_to))?.name || task.assigned_to)}\n` +
      `${etaVsActual(submitted)}\n` +
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

async function handleSignOff(bot, callbackQuery, taskId, approve, opts = {}) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`, { reply_markup: { inline_keyboard: [navFooterRow()] } }); return; }
  if (task.assigned_by !== userId && !isAdmin(userId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assigner or an admin can sign off.', show_alert: true }).catch(() => {});
    return;
  }
  if (task.status !== 'submitted') {
    await editOrSend(bot, chatId, messageId, `ℹ️ Task ${taskId} is *${task.status}*, not submitted.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  try {
    await taskStateMachine.transition(taskId, approve ? 'approve' : 'reject', userId);
  } catch (e) {
    await editOrSend(bot, chatId, messageId, `❌ Couldn\'t ${approve ? 'approve' : 'reject'}: ${e.message}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
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
    if (opts.afterRender) {
      // TSK-V3 — approving from the admin card re-renders the LIST with
      // this task gone; the next sign-off is right there. DMs still go out.
      await opts.afterRender();
    } else {
      await editOrSend(bot, chatId, messageId,
        `✅ Task *${escapeMd(task.title)}* marked completed.\nID: \`${taskId}\`${assignerIncentiveLine}`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    }
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
    if (opts.afterRender) {
      await opts.afterRender();
    } else {
      await editOrSend(bot, chatId, messageId,
        `↩ Task *${escapeMd(task.title)}* sent back to active.\nID: \`${taskId}\``,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navFooterRow()] } });
    }
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
      // TSK-V2 — salaried commits time and starts; incentivized opens a deal.
      return task.track !== 'incentivized'
        ? [
          { text: '⏱ Accept — give time', callback_data: `tsk:est:${task.task_id}` },
          { text: '❌ Decline', callback_data: `tsk:dec:${task.task_id}` },
        ]
        : [
          { text: '⏱ Propose timeline', callback_data: `tsk:prp:${task.task_id}` },
          { text: '❌ Decline', callback_data: `tsk:dec:${task.task_id}` },
        ];
    case 'awaiting_final_ack':
      return [
        { text: '✅ Accept the deal', callback_data: `tsk:fa:${task.task_id}` },
        { text: '↩ Renegotiate', callback_data: `tsk:rng:${task.task_id}` },
      ];
    case 'active':
      return [
        { text: '✅ Mark done', callback_data: `tsk:done:${task.task_id}` },
      ];
    default:
      return null;
  }
}

/** One chip per task: what it is, and what it is waiting for. */
function waitingWord(t) {
  switch (t.status) {
    case 'assigned':
      return t.track !== 'incentivized' ? 'time needed' : 'timeline needed';
    case 'awaiting_timeline_ack': return 'with your assigner';
    case 'awaiting_final_ack': return 'your OK needed';
    case 'active':
      return t.track !== 'incentivized' && t.started_at && t.proposed_hours
        ? `ends ~${impliedEnd(t)}`
        : (t.proposed_deadline ? `by ${fmtDate(t.proposed_deadline)}` : 'in progress');
    case 'submitted': return 'at sign-off';
    default: return statusBadge(t.status);
  }
}

/**
 * TSK-V2 — My Tasks is a LIST OF CHIPS, not a wall of text.
 *
 * The old view rendered every task plus its buttons into one message: past
 * roughly fifteen tasks it silently exceeded Telegram's 4096-char limit and
 * simply failed to render, and the action chips sat far from the rows they
 * belonged to. Now each task is one chip that opens its own card, so the
 * message length is bounded by the page size and every action is beside the
 * task it acts on.
 */
async function showMyTasks(bot, chatId, userId, messageId) {
  // TRF-5 — transfers waiting on this user (dispatch / receive) surface at
  // the top of My Tasks. Session-free: rebuilt from the live ApprovalQueue.
  let transferQueue = { lines: [], rows: [] };
  try {
    transferQueue = await require('./transferFlow').myQueueSection(userId);
  } catch (e) {
    logger.warn(`taskFlow: transfer queue section failed: ${e.message}`);
  }
  const tasks = await tasksRepository.getByAssignedTo(userId);
  if (!tasks.length && !transferQueue.lines.length) {
    await editOrSend(bot, chatId, messageId, 'You have no assigned tasks.', {
      reply_markup: { inline_keyboard: [navFooterRow()] },
    });
    return;
  }

  const open = tasks.filter((t) => OPEN_STATUSES.has(t.status));
  open.sort((a, b) => {
    const pa = PRIORITY_RANK[getPriority(a)] ?? 2;
    const pb = PRIORITY_RANK[getPriority(b)] ?? 2;
    if (pa !== pb) return pa - pb;
    const da = a.proposed_deadline ? new Date(a.proposed_deadline).getTime() : Infinity;
    const db = b.proposed_deadline ? new Date(b.proposed_deadline).getTime() : Infinity;
    return da - db;
  });
  const doneCount = tasks.filter((t) => t.status === 'completed').length;

  const lines = [];
  const rows = [];
  if (transferQueue.lines.length) {
    lines.push(...transferQueue.lines, '');
    rows.push(...transferQueue.rows);
  }
  lines.push(`📋 *My Tasks* — ${open.length} open`);
  lines.push('_Tap a task to open it._');

  for (const t of open.slice(0, MY_TASKS_PAGE)) {
    const pm = PRIORITY_META[getPriority(t)] || PRIORITY_META.normal;
    rows.push([{
      text: `${pm.icon} ${truncate(t.title, 26)} — ${waitingWord(t)}`,
      callback_data: `tsk:t:${t.task_id}`,
    }]);
  }
  if (open.length > MY_TASKS_PAGE) {
    lines.push(`_Showing the first ${MY_TASKS_PAGE} of ${open.length}._`);
  }
  if (!open.length) lines.push('', '_Nothing open right now._');
  if (doneCount) lines.push('', `✅ ${doneCount} completed so far.`);
  rows.push(navFooterRow());

  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows },
  });
}

// ---------------------------------------------------------------------------
// TSK-V3 — TEAM TASKS, the admin list (owner-approved layout, 26-Aug-2026).
//
// The old view rendered every task plus two buttons into one message: with
// ~16 open tasks that was a 32-button pillar under a text wall nobody could
// navigate, and past the 4096-char ceiling it silently failed. Now it is a
// paged CHIP list: one tappable chip per task (status fact FIRST — phones
// cut button text at ~28 chars, so whatever is last is what disappears),
// priority-first order, a hard cap of TEAM_PAGE chips per page with a
// Prev/Next pager, and each chip opening the task's own card edited in
// place. List context (mode:filter:page) rides in the callback_data itself,
// NOT in a session — a restart or a week-old message can never strand the
// pager, and two admins can page independently.
// ---------------------------------------------------------------------------

const TEAM_PAGE = 8;
// Statuses whose next move is the ASSIGNER'S (the 👉 group).
const NEEDS_ASSIGNER = new Set(['awaiting_timeline_ack', 'awaiting_incentive', 'submitted']);
// Statuses waiting on the WORKER — the only ones that can go ⚠️ stale.
const WAITING_ON_WORKER = new Set(['assigned', 'awaiting_final_ack']);

/** `o:a:0` → {mode, filter, page}. Tolerant: anything malformed → page 1 of All. */
function parseListCtx(s) {
  const parts = String(s || '').split(':');
  const mode = ['o', 'd', 's'].includes(parts[0]) ? parts[0] : 'o';
  const filter = /^\d+$/.test(parts[1] || '') ? parts[1] : 'a';
  const page = Math.max(0, parseInt(parts[2], 10) || 0);
  return { mode, filter, page };
}
function ctxStr(ctx) { return `${ctx.mode}:${ctx.filter}:${ctx.page}`; }

async function stallDaysSetting() {
  try {
    const s = await settingsRepository.getAll();
    const n = Number(s.TASK_STALL_DAYS);
    return Number.isFinite(n) && n > 0 ? n : 7;
  } catch (_) { return 7; }
}

/** Whole days since the task last moved (fallbacks for legacy rows). NaN → null. */
function silentDays(task, nowMs) {
  const iso = task.last_event_at || task.assigned_at || task.created_at;
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor(((nowMs ?? Date.now()) - t) / 86400000));
}

function isStalled(task, stallDays, nowMs) {
  if (!WAITING_ON_WORKER.has(task.status)) return false;
  const d = silentDays(task, nowMs);
  return d != null && d > stallDays;
}

/** "11-May-2026" → "11-May" — chips and card metadata use the short form. */
function fmtDateShort(iso) {
  const s = fmtDate(iso);
  return s && s.length > 6 ? s.slice(0, 6) : s;
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

/** The status fact that leads every chip. ~14 chars so the title survives. */
function teamChipFact(t, stallDays, nowMs) {
  switch (t.status) {
    case 'awaiting_timeline_ack': {
      const inc = t.track === 'incentivized' ? '₦ + ' : '';
      const h = Number.isFinite(Number(t.proposed_hours)) ? ` ${fmtHours(t.proposed_hours)}` : '';
      return `👉 ${inc}accept${h}?`;
    }
    case 'awaiting_incentive': return '👉 set ₦';
    case 'submitted': return '👉 sign off';
    case 'awaiting_final_ack': return '⌛ his OK';
    case 'active':
      if (t.track !== 'incentivized' && t.started_at && t.proposed_hours) {
        return `🔵 ends ~${impliedEnd(t)}`;
      }
      return t.proposed_deadline ? `🔵 by ${fmtDateShort(t.proposed_deadline)}` : '🔵 running';
    default: {
      const d = silentDays(t, nowMs);
      if (d == null) return '📨 waiting';
      const icon = d > stallDays ? '⚠️' : '📨';
      return `${icon} ${d === 0 ? 'today' : `${d}d`}`;
    }
  }
}

/**
 * Priority-first (owner's ruling over whose-move-first): 🔴→🟠→🟡→⚪;
 * inside a colour the tasks needing the ASSIGNER come first, then the
 * longest-assigned. In place.
 */
function sortForAdmin(list, nowMs) {
  const assignedMs = (t) => {
    const iso = t.assigned_at || t.created_at;
    const ms = iso ? new Date(iso).getTime() : NaN;
    return Number.isNaN(ms) ? (nowMs ?? Date.now()) : ms;
  };
  list.sort((a, b) => {
    const pa = PRIORITY_RANK[getPriority(a)] ?? 2;
    const pb = PRIORITY_RANK[getPriority(b)] ?? 2;
    if (pa !== pb) return pa - pb;
    const na = NEEDS_ASSIGNER.has(a.status) ? 0 : 1;
    const nb = NEEDS_ASSIGNER.has(b.status) ? 0 : 1;
    if (na !== nb) return na - nb;
    return assignedMs(a) - assignedMs(b);
  });
  return list;
}

/**
 * Two open tasks sharing a title are told apart by their assigned date
 * ("Catelog upload (11-May)"). Map task_id → suffixed title.
 */
function dedupeTitles(list) {
  const byTitle = new Map();
  for (const t of list) {
    const k = String(t.title || '').trim().toLowerCase();
    byTitle.set(k, (byTitle.get(k) || 0) + 1);
  }
  const out = new Map();
  for (const t of list) {
    const k = String(t.title || '').trim().toLowerCase();
    const dupe = (byTitle.get(k) || 0) > 1;
    const when = dupe ? fmtDateShort(t.assigned_at || t.created_at) : '';
    out.set(t.task_id, when ? `${t.title} (${when})` : t.title);
  }
  return out;
}

/**
 * The task pool an admin's list draws from: everyone they manage UNION
 * everything they personally assigned — a manager who assigned outside
 * their department still sees (and can act on) that task.
 */
async function _teamPoolFor(userId, actor, isAdm) {
  const allUsers = await usersRepository.getAll();
  const depts = await departmentsRepo.getAll();
  const { graph } = deptGraph.validateForest(depts);
  const team = deptGraph.listAssignableUsers(actor, allUsers, graph, {
    isAdmin: isAdm, excludeSelf: false,
  });
  const nameById = new Map(team.map((u) => [String(u.user_id), u.name || u.user_id]));
  const byTeam = await tasksRepository.getByAssignedToMany(team.map((u) => String(u.user_id)));
  const byMe = await tasksRepository.getByAssignedBy(userId);
  const seen = new Set(byTeam.map((t) => t.task_id));
  const tasks = byTeam.concat(byMe.filter((t) => !seen.has(t.task_id)));
  return { tasks, nameById };
}

/** The one renderer behind Team Tasks (o), 🗂 Completed (d), Pending Sign-off (s). */
async function renderTeamList(bot, chatId, userId, messageId, ctx) {
  const isAdm = isAdmin(userId);
  const actor = await usersRepository.findByUserId(userId);

  // Sign-off keeps its historical gate (any assigner with submitted work);
  // the team views require managing someone.
  let tasks; let nameById = new Map();
  if (ctx.mode === 's') {
    tasks = isAdm
      ? await tasksRepository.getSubmittedPendingApproval()
      : await tasksRepository.getSubmittedForAssigner(userId);
  } else {
    if (!canManage(actor, isAdm)) {
      await editOrSend(bot, chatId, messageId,
        'You don\'t manage any department, so there are no team tasks to show.',
        { reply_markup: { inline_keyboard: [navFooterRow()] } });
      return;
    }
    ({ tasks, nameById } = await _teamPoolFor(userId, actor, isAdm));
  }

  const stallDays = await stallDaysSetting();
  const nowMs = Date.now();
  const filtered = ctx.filter === 'a' ? tasks : tasks.filter((t) => t.assigned_to === ctx.filter);

  const lines = [];
  const rows = [];
  let list;

  if (ctx.mode === 'd') {
    list = filtered.filter((t) => t.status === 'completed');
    list.sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')));
  } else if (ctx.mode === 's') {
    list = sortForAdmin(filtered.filter((t) => t.status === 'submitted'), nowMs);
  } else {
    list = sortForAdmin(filtered.filter((t) => OPEN_STATUSES.has(t.status)), nowMs);
  }

  const pageCount = Math.max(1, Math.ceil(list.length / TEAM_PAGE));
  const page = Math.min(ctx.page, pageCount - 1);
  const slice = list.slice(page * TEAM_PAGE, (page + 1) * TEAM_PAGE);
  const here = { ...ctx, page };
  const filterName = ctx.filter === 'a' ? '' : firstName(nameById.get(ctx.filter) || ctx.filter);

  if (ctx.mode === 'd') {
    lines.push(`🗂 *Completed* — ${list.length}${filterName ? ` · ${escapeMd(filterName)}` : ''}`);
    if (!list.length) lines.push('', '_None completed yet._');
    else {
      lines.push('');
      for (const t of slice) {
        const took = etaVsActual(t).replace(/[*⏱]/g, '').trim(); // "ETA 4h · took 5h"
        const who = escapeMd(nameById.get(t.assigned_to) || t.assigned_to);
        const when = t.completed_at ? ` · ✅ ${fmtDateShort(t.completed_at)}` : '';
        lines.push(`• ${escapeMd(t.title)} — ${who}${took ? ` · ${escapeMd(took)}` : ''}${when}`);
      }
    }
  } else {
    const needYou = list.filter((t) => NEEDS_ASSIGNER.has(t.status)).length;
    const stalled = list.filter((t) => isStalled(t, stallDays, nowMs)).length;
    const running = list.filter((t) => t.status === 'active').length;
    if (ctx.mode === 's') {
      lines.push(`⏳ *Pending Sign-off* — ${list.length}`);
      if (!list.length) lines.push('', '_No tasks waiting for your sign-off._');
    } else {
      lines.push(`👥 *Team Tasks* — ${list.length} open${filterName ? ` · ${escapeMd(filterName)}` : ''}`);
      lines.push(`👉 *${needYou} need YOU* · ⚠️ ${stalled} stalled · 🔵 ${running} running`);
      if (!list.length) lines.push('', '_No open tasks._');
    }
    if (list.length) lines.push('', '_Tap a task to open it._');

    // Person filter — one tap narrows this same card to one employee.
    // Only on the open list, and only when there is more than one person.
    if (ctx.mode === 'o') {
      const openAll = tasks.filter((t) => OPEN_STATUSES.has(t.status));
      const counts = new Map();
      for (const t of openAll) counts.set(t.assigned_to, (counts.get(t.assigned_to) || 0) + 1);
      if (counts.size > 1 || ctx.filter !== 'a') {
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
        const frow = [{
          text: `All${ctx.filter === 'a' ? ' ✓' : ''}`,
          callback_data: `tsk:tp:o:a:0`,
        }];
        for (const [uid, n] of top) {
          frow.push({
            text: `${firstName(nameById.get(uid) || uid)} (${n})${ctx.filter === uid ? ' ✓' : ''}`,
            callback_data: `tsk:tp:o:${uid}:0`,
          });
        }
        rows.push(frow);
      }
    }

    const titleFor = dedupeTitles(list);
    for (const t of slice) {
      const pm = PRIORITY_META[getPriority(t)] || PRIORITY_META.normal;
      const fact = teamChipFact(t, stallDays, nowMs);
      rows.push([{
        text: `${pm.icon} ${fact} · ${truncate(titleFor.get(t.task_id) || t.title, 24)}`,
        callback_data: `tsk:tt:${ctxStr(here)}:${t.task_id}`,
      }]);
    }
  }

  if (pageCount > 1) {
    rows.push([
      { text: '⬅ Prev', callback_data: page > 0 ? `tsk:tp:${here.mode}:${here.filter}:${page - 1}` : 'tsk:noop' },
      { text: `Page ${page + 1}/${pageCount}`, callback_data: 'tsk:noop' },
      { text: 'Next ➡', callback_data: page < pageCount - 1 ? `tsk:tp:${here.mode}:${here.filter}:${page + 1}` : 'tsk:noop' },
    ]);
  }

  if (ctx.mode === 'o') {
    const doneCount = filtered.filter((t) => t.status === 'completed').length;
    rows.push([
      { text: `🗂 Completed (${doneCount})`, callback_data: `tsk:tp:d:${here.filter}:0` },
      { text: '🏠 Menu', callback_data: 'act:__back__' },
    ]);
  } else if (ctx.mode === 'd') {
    rows.push([
      { text: '⬅ Back', callback_data: `tsk:tp:o:${here.filter}:0` },
      { text: '🏠 Menu', callback_data: 'act:__back__' },
    ]);
  } else {
    rows.push(navFooterRow());
  }

  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows },
  });
}

/** The admin phrasing of "where this task is" — always names the worker's
 *  side as HIS move ("waiting on Abdul"), never "waiting for you" when the
 *  you is him. */
function adminStatusLine(t, doerFirst, stallDays, nowMs) {
  const d = silentDays(t, nowMs);
  const dTail = d == null ? '' : (d === 0 ? '' : ` — waiting ${d}d`);
  switch (t.status) {
    case 'assigned':
      return isStalled(t, stallDays, nowMs)
        ? `⚠️ *Silent ${d} days* — assigned ${fmtDateShort(t.assigned_at || t.created_at)}, never answered`
        : `📨 Waiting on ${escapeMd(doerFirst)} to answer${dTail}`;
    case 'awaiting_timeline_ack':
      return `👉 *His proposal needs your answer*${dTail}`;
    case 'awaiting_incentive':
      return `👉 *Your ₦ is needed to close the deal*`;
    case 'awaiting_final_ack':
      return `⌛ Deal made — waiting on his final OK${dTail}`;
    case 'active':
      return t.track !== 'incentivized' && t.started_at && t.proposed_hours
        ? `🔵 Running — ends ~${escapeMd(impliedEnd(t))}`
        : `🔵 Running${t.proposed_deadline ? ` — due ${fmtDateShort(t.proposed_deadline)}` : ''}`;
    case 'submitted':
      return `👉 *Waiting on your sign-off*`;
    default:
      return statusBadge(t.status);
  }
}

/**
 * TSK-V3 — the assigner's per-task card. ONE card, edited in place: status
 * line first, the full description, then ONLY the buttons legal in this
 * state. `ctx` is the list position to return to; a manager who neither
 * assigned the task nor is admin gets a 👁 view-only card.
 */
async function renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx, opts = {}) {
  const task = await tasksRepository.getById(taskId);
  const backRowList = [
    { text: '⬅ Back', callback_data: `tsk:tp:${ctxStr(ctx)}` },
    { text: '🏠 Menu', callback_data: 'act:__back__' },
  ];
  if (!task) {
    await editOrSend(bot, chatId, messageId, `❌ Task ${taskId} not found.`,
      { reply_markup: { inline_keyboard: [backRowList] } });
    return;
  }
  const stallDays = await stallDaysSetting();
  const nowMs = Date.now();
  const pm = PRIORITY_META[getPriority(task)] || PRIORITY_META.normal;
  const tm = TRACK_META[task.track] || TRACK_META.salaried;
  const canAct = task.assigned_by === userId || isAdmin(userId);
  const doer = await usersRepository.findByUserId(task.assigned_to);
  const doerName = doer?.name || task.assigned_to;
  const doerFirst = firstName(doerName) || doerName;
  let assignerLabel = 'you';
  if (task.assigned_by !== userId) {
    const by = await usersRepository.findByUserId(task.assigned_by);
    assignerLabel = by?.name || task.assigned_by;
  }
  const cs = ctxStr(ctx);

  const lines = [
    `${pm.icon} *${escapeMd(task.title)}*`,
    `${tm.icon} ${tm.label} · ${adminStatusLine(task, doerFirst, stallDays, nowMs)}`,
    '',
    `👤 ${escapeMd(doerName)} · assigned by ${escapeMd(assignerLabel)} ${fmtDateShort(task.assigned_at || task.created_at)}`
      + descLine(task.description),
  ];
  // The flag is a permanent record that two admins armed this task; the
  // banner is about what is happening NOW, so a closed task never claims to
  // be reminding anyone (the sweep ignores closed tasks too).
  if (task.auto_remind && OPEN_STATUSES.has(task.status)) {
    lines.push('', '🔁 _Automatic reminders are ON for this task (two admins armed them)._');
  }
  if (opts.note) lines.push('', opts.note);

  const datePassed = task.proposed_deadline
    && new Date(task.proposed_deadline).getTime() < nowMs - 86400000;
  if (task.status === 'awaiting_timeline_ack' && task.proposed_hours) {
    lines.push('', `He proposed: ⏱ *${fmtHours(task.proposed_hours)}*`
      + (task.proposed_deadline
        ? ` · 📅 by ${fmtDate(task.proposed_deadline)}${datePassed ? ' *(date passed)*' : ''}` : ''));
    if (datePassed) {
      lines.push(`_Accepting restarts his ${fmtHours(task.proposed_hours)} from today._`);
    }
  } else if (task.status === 'submitted') {
    const line = etaVsActual(task);
    if (line) lines.push('', line + (task.proposed_deadline ? ` · 📅 agreed ${fmtDateShort(task.proposed_deadline)}` : ''));
  } else if (task.status === 'active' && task.proposed_hours) {
    lines.push('', task.track !== 'incentivized'
      ? `⏱ Time he gave: *${fmtHours(task.proposed_hours)}*`
      : `⏱ *${fmtHours(task.proposed_hours)}*${task.proposed_deadline ? ` · 📅 by *${fmtDate(task.proposed_deadline)}*` : ''}`);
  }
  lines.push('', `ID: \`${task.task_id}\``);

  const rows = [];
  if (!canAct) {
    lines.splice(lines.length - 2, 0, '', `_👁 View only — this task was assigned by ${escapeMd(assignerLabel)}._`);
  } else if (OPEN_STATUSES.has(task.status)) {
    switch (task.status) {
      case 'awaiting_timeline_ack':
        rows.push([
          { text: datePassed ? `✅ Accept — restart ${fmtHours(task.proposed_hours)}` : '✅ Accept', callback_data: `tsk:acc:${task.task_id}` },
          { text: '↩ Counter', callback_data: `tsk:cnt:${task.task_id}` },
        ]);
        break;
      case 'awaiting_incentive':
        rows.push([{ text: '💰 Set incentive', callback_data: `tsk:six:${task.task_id}` }]);
        break;
      case 'submitted':
        rows.push([
          { text: '✅ Approve', callback_data: `tsk:sg:y:${cs}:${task.task_id}` },
          { text: '❌ Reject', callback_data: `tsk:sg:n:${cs}:${task.task_id}` },
        ]);
        break;
      default:
        if (WAITING_ON_WORKER.has(task.status)) {
          rows.push([{ text: `🔔 Remind ${doerFirst}`, callback_data: `tsk:rmd:${cs}:${task.task_id}` }]);
        }
    }
    // TRM-1 — automatic reminders. Arming asks two admins (the chip queues
    // an approval); stopping is one tap, because quieting a nudge is always
    // safe. Only offered while the task can still be waiting on the doer.
    // REVIEW FIX: the chip used to be hidden entirely on the assigner-move
    // statuses, so a task armed just before the doer marked it done became
    // UNSTOPPABLE from its own card. Stop is offered whenever reminders are
    // on; arming is offered only where a nudge could ever apply.
    if (task.auto_remind) {
      rows.push([{ text: '⏹ Stop reminders', callback_data: `tsk:rmoff:${cs}:${task.task_id}` }]);
    } else if (task.status !== 'submitted' && task.status !== 'awaiting_timeline_ack'
        && task.status !== 'awaiting_incentive') {
      rows.push([{ text: '🔁 Auto-remind', callback_data: `tsk:rmon:${cs}:${task.task_id}` }]);
    }
    // Drop stays hidden on 'submitted' — delivered work is approved or
    // rejected, never silently dropped (long-standing rule).
    if (task.status !== 'submitted') {
      rows.push([
        { text: '🔝 Priority', callback_data: `tsk:tpp:${cs}:${task.task_id}` },
        { text: '🚫 Drop task', callback_data: `tsk:tdd:${cs}:${task.task_id}` },
      ]);
    }
  }
  rows.push(backRowList);

  await editOrSend(bot, chatId, messageId, lines.join('\n'),
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

/**
 * TRM-1 — 🔁 Auto-remind: ask the SECOND admin to arm this task's automatic
 * reminders. Nothing changes here; the executor flips the flag only after
 * the dual-admin gate is satisfied (risk/evaluate: task_reminder_enable is
 * in ALWAYS_APPROVAL_ACTIONS *and* DUAL_ADMIN_ACTIONS).
 */
async function requestAutoRemind(bot, callbackQuery, ctx, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await renderTeamList(bot, chatId, userId, messageId, ctx); return; }
  if (!(await _guardAssignerOrAdmin(bot, callbackQuery, task))) return;
  if (task.auto_remind) {
    await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx,
      { note: '🔁 _Reminders are already armed for this task._' });
    return;
  }
  if (!OPEN_STATUSES.has(task.status)) {
    await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx,
      { note: 'ℹ️ _This task is closed — there is nothing left to remind about._' });
    return;
  }

  const idGenerator = require('../utils/idGenerator');
  const approvalQueueRepository = require('../repositories/approvalQueueRepository');
  // REVIEW FIX: two taps used to queue two armings. The second could then be
  // approved AFTER an ⏹ Stop and silently switch the nudges back on.
  try {
    const pending = await approvalQueueRepository.getAllPending();
    if (pending.some((r) => r.actionJSON && r.actionJSON.action === 'task_reminder_enable'
        && String(r.actionJSON.task_id) === String(taskId))) {
      await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx,
        { note: '🔁 _Already waiting on a second admin — one request per task._' });
      return;
    }
  } catch (e) { logger.warn(`taskFlow.requestAutoRemind: pending check failed: ${e.message}`); }
  const approvalEvents = require('../events/approvalEvents');
  const riskEvaluate = require('../risk/evaluate');
  const requestId = idGenerator.requestId();
  const doerName = (await usersRepository.findByUserId(task.assigned_to).catch(() => null))?.name
    || task.assigned_to;
  try {
    const risk = await riskEvaluate.evaluate({ action: 'task_reminder_enable', userId });
    await approvalQueueRepository.append({
      requestId,
      user: String(userId),
      actionJSON: { action: 'task_reminder_enable', task_id: taskId, title: task.title, doer_name: doerName },
      riskReason: risk.reason || 'dual_admin_required',
      status: 'pending',
    });
    await approvalEvents.notifyAdminsApprovalRequest(
      bot, requestId, (await usersRepository.findByUserId(userId).catch(() => null))?.name || userId,
      // Plain text on purpose: notifyAdminsApprovalRequest escapes the
      // summary (Markdown-v2 esc), so any *bold*/_italic_ here would reach
      // the approving admin as literal backslashed punctuation.
      `Arm automatic reminders\n📋 ${task.title}\n👤 ${doerName}\n`
      + 'Once armed the bot nudges them until the task is no longer their move, and the assigner is copied on every nudge.',
      risk.reason || 'dual_admin_required',
      isAdmin(userId) ? String(userId) : undefined,
    );
  } catch (e) {
    logger.error(`taskFlow.requestAutoRemind: ${e.message}`);
    await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx,
      { note: `⚠️ _Could not raise the request: ${escapeMd(e.message)}_` });
    return;
  }
  await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx,
    { note: '🔁 _Sent for approval — reminders start once a second admin signs it._' });
}

/**
 * TRM-1 — ⏹ Stop reminders. Deliberately NOT approval-gated: quieting a
 * nudge is always safe, and a reminder nobody can stop is the reason people
 * mute bots. Open to the ASSIGNER (who may be a non-admin manager — it is
 * their own task's nudge, and their own chat receiving the mirror) or any
 * admin, exactly like 🔝 Priority and 🚫 Drop on the same card. Audited.
 */
async function stopAutoRemind(bot, callbackQuery, ctx, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) { await renderTeamList(bot, chatId, userId, messageId, ctx); return; }
  if (!(await _guardAssignerOrAdmin(bot, callbackQuery, task))) return;
  if (!task.auto_remind) {
    await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx,
      { note: 'ℹ️ _Automatic reminders were not on for this task._' });
    return;
  }
  try {
    await tasksRepository.updateFields(taskId, { auto_remind: '' });
  } catch (e) {
    logger.error(`taskFlow.stopAutoRemind: ${e.message}`);
    await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx,
      { note: `⚠️ _Could not stop them: ${escapeMd(e.message)}_` });
    return;
  }
  // REVIEW FIX: an arming still sitting in the queue would re-arm this task
  // the moment some admin got round to approving it — days later, after the
  // owner had deliberately stopped it. Stop means stop, so the pending
  // request is withdrawn in the same breath.
  let withdrawn = 0;
  try {
    const approvalQueueRepository = require('../repositories/approvalQueueRepository');
    const pending = await approvalQueueRepository.getAllPending();
    for (const r of pending) {
      if (!r.actionJSON || r.actionJSON.action !== 'task_reminder_enable') continue;
      if (String(r.actionJSON.task_id) !== String(taskId)) continue;
      // APR-1 — the admin stopping reminders is the one withdrawing this
      // pending arming; without the stamp the withdrawal named nobody
      // anywhere that could be joined back to the request.
      await approvalQueueRepository.updateStatus(r.requestId, 'rejected', new Date().toISOString(),
        await require('../services/approverStamp').labelFor({ actorId: userId }));
      withdrawn += 1;
    }
  } catch (e) { logger.warn(`taskFlow.stopAutoRemind: could not withdraw pending armings: ${e.message}`); }
  try {
    await taskEventsRepository.append({
      task_id: taskId, event_type: 'auto_remind_stopped',
      from_status: task.status, to_status: task.status,
      actor_user_id: userId, meta: { withdrawn_pending: withdrawn },
    });
  } catch (e) { logger.warn(`taskFlow.stopAutoRemind: audit failed: ${e.message}`); }
  // The doer is told the pressure is off — the same courtesy the nudge got.
  try {
    await bot.sendMessage(task.assigned_to,
      `⏹ *Reminders stopped*\n\n${escapeMd(task.title)}\n_You will no longer be nudged about this task._`,
      { parse_mode: 'Markdown', disable_notification: true });
  } catch (e) { logger.info(`taskFlow.stopAutoRemind: doer DM skipped (${e.message})`); }
  await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx,
    { note: withdrawn
      ? `⏹ _Automatic reminders stopped, and ${withdrawn} pending arming request${withdrawn === 1 ? '' : 's'} withdrawn._`
      : '⏹ _Automatic reminders stopped._' });
}

/**
 * 🔔 Remind — one polite DM to the worker, at most once per task per Lagos
 * day.
 *
 * TRM-1 REVIEW FIX (27-Aug): this door used to keep its own in-memory day
 * ledger, so the automatic sweep and a manual tap could both fire on the
 * same task the same day — and a redeploy reset it. Both doors now share
 * ONE durable record (taskReminderService, TaskEvents `reminder_sent`), so
 * "once a day" holds across doors and across restarts.
 */

async function handleRemind(bot, callbackQuery, ctx, taskId) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const task = await tasksRepository.getById(taskId);
  if (!task) {
    await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx);
    return;
  }
  if (!(await _guardAssignerOrAdmin(bot, callbackQuery, task))) return;
  if (!WAITING_ON_WORKER.has(task.status)) {
    await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx,
      { note: 'ℹ️ _This task is no longer waiting on him — no reminder needed._' });
    return;
  }
  const reminders = require('../services/taskReminderService');
  const history = await reminders.lastRemindedDays(Date.now());
  if (reminders.remindedToday(taskId, history, Date.now())) {
    await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx,
      { note: '🔔 _Already reminded today — one nudge per day is enough._' });
    return;
  }
  const pm = PRIORITY_META[getPriority(task)] || PRIORITY_META.normal;
  const assigner = await usersRepository.findByUserId(userId);
  const doerFirst = firstName((await usersRepository.findByUserId(task.assigned_to))?.name) || 'him';
  const ask = task.status === 'assigned'
    ? (task.track !== 'incentivized'
      ? 'It is waiting on your time — open it and tap *Accept — give time*.'
      : 'It is waiting on your timeline — open it and tap *Propose timeline*.')
    : 'The deal is ready — open it and give your final OK.';
  try {
    const act = buttonsForMyTask(task);
    await bot.sendMessage(task.assigned_to,
      `🔔 *Reminder from ${escapeMd(assigner?.name || 'your assigner')}*\n\n`
      + `${pm.icon} *${escapeMd(task.title)}*${descLine(task.description)}\n\n${ask}\nID: \`${taskId}\``,
      { parse_mode: 'Markdown', reply_markup: act ? { inline_keyboard: [act] } : undefined });
    await reminders.noteReminded(taskId, userId, { via: 'manual' });
    await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx,
      { note: `🔔 _Reminder sent to ${escapeMd(doerFirst)} just now._` });
  } catch (e) {
    logger.warn(`taskFlow.handleRemind: DM failed: ${e.message}`);
    await renderAdminTaskCard(bot, chatId, userId, taskId, messageId, ctx,
      { note: '⚠️ _Could not deliver the reminder (he may not have opened the bot)._' });
  }
}

async function showTeamTasks(bot, chatId, userId, messageId) {
  await renderTeamList(bot, chatId, userId, messageId, { mode: 'o', filter: 'a', page: 0 });
}

async function showPendingSignOff(bot, chatId, userId, messageId) {
  await renderTeamList(bot, chatId, userId, messageId, { mode: 's', filter: 'a', page: 0 });
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
  dmAssigneeNewTask, // PTK-1 — snapTaskFlow reuses the one DM builder
  handleCallback,
  handleTextStep,
  showMyTasks,
  showTeamTasks,
  showPendingSignOff,
  showPayouts,
  // exported for smoke harness + unit tests
  _internals: {
    fmtHours,
    fmtDate,
    decodeLegacyDescription,
    getPriority,
    // TRM-1 — the reminder sweep renders the doer's own card grammar, so
    // the automatic nudge and the manual 🔔 can never drift apart.
    PRIORITY_META,
    descLine,
    buttonsForMyTask,
    // TSK-V3
    parseListCtx,
    teamChipFact,
    silentDays,
    isStalled,
    sortForAdmin,
    dedupeTitles,
    fmtDateShort,
    TEAM_PAGE,
  },
};
