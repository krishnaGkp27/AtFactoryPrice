/**
 * APR-2 — ⏰ Reminder Controls (callback namespace `rmn:`).
 *
 * One screen rules every nudge the bot sends:
 *   - 🛂 Admin nudges — approval-sweep cadence; also switches the sample /
 *     customer-follow-up / cold-customer jobs (REMINDER_HOURS_ADMIN).
 *   - One row per active department — member nudges, e.g. the order
 *     reminder DM to a salesperson (REMINDER_HOURS.<Dept>).
 *
 * Governance (owner mandate 14-Jul): every change queues
 * `set_reminder_config` through the standard approval pipeline
 * (ALWAYS_APPROVAL — TV-2 semantics: managers may request, an admin other
 * than the requester approves; SEC-P1 H1 blocks self-approval).
 * Everything defaults OFF — silent until deliberately switched on.
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const auth = require('../middlewares/auth');
const departmentsRepository = require('../repositories/departmentsRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const usersRepository = require('../repositories/usersRepository');
const reminderPolicy = require('../services/reminderPolicy');
const idGenerator = require('../utils/idGenerator');
const { makeRenderer } = require('../utils/flowKit');
const logger = require('../utils/logger');

const SESSION_TYPE = 'reminder_config_flow';
const NS = 'rmn:';
const CADENCE_CHOICES = [0, 2, 6, 12, 24];

const render = makeRenderer({ parseMode: 'Markdown', requireSession: SESSION_TYPE });

async function isManagerOrAdmin(userId) {
  if (auth.isAdmin(userId)) return true;
  try {
    const u = await usersRepository.findByUserId(String(userId));
    return !!u && (u.role || '') === 'manager';
  } catch (_) { return false; }
}

function fmtState(hours) {
  return hours > 0 ? `ON · every ${hours}h` : 'OFF';
}

async function start(bot, chatId, userId, messageId = null) {
  if (!(await isManagerOrAdmin(userId))) {
    await bot.sendMessage(chatId, '⏰ Reminder Controls are for managers and admins.');
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'menu', flowMessageId: messageId || null,
    startedAt: new Date().toISOString(), _scopes: [],
  });
  await renderMenu(bot, chatId, userId);
}

async function renderMenu(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const adminHours = await reminderPolicy.hoursForAdmin();
  let depts = [];
  try {
    depts = (await departmentsRepository.getAll()).filter((d) => (d.status || 'active') === 'active');
  } catch (e) { logger.warn(`reminderConfig: departments load failed: ${e.message}`); }
  const scopes = [{ scope: 'admin', label: '🛂 Admin nudges', dept: '' }];
  for (const d of depts) scopes.push({ scope: 'dept', label: `👥 ${d.dept_name}`, dept: d.dept_name });
  session._scopes = scopes;
  session.step = 'menu';
  sessionStore.set(userId, session);

  const rows = [];
  for (let i = 0; i < scopes.length; i++) {
    const s = scopes[i];
    const hours = s.scope === 'admin' ? adminHours : await reminderPolicy.hoursForDept(s.dept);
    rows.push([{ text: `${s.label} — ${fmtState(hours)}`, callback_data: `${NS}s:${i}` }]);
  }
  rows.push([{ text: '❌ Close', callback_data: `${NS}close` }]);
  await render(bot, chatId, userId,
    '⏰ *Reminder Controls*\n\n'
    + '*Admin nudges* cover pending-approval sweeps, sample follow-ups, customer follow-ups and the weekly cold-customer alert.\n'
    + '*Department rows* cover nudges to that department\'s members (e.g. order reminders to a salesperson).\n\n'
    + '_Everything is OFF unless switched on. Changes need admin approval._',
    rows);
}

async function renderCadencePicker(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  if (!session || !session._scopes[idx]) return;
  const s = session._scopes[idx];
  session.step = 'cadence';
  session.scopeIdx = idx;
  sessionStore.set(userId, session);
  const current = s.scope === 'admin'
    ? await reminderPolicy.hoursForAdmin()
    : await reminderPolicy.hoursForDept(s.dept);
  const chips = CADENCE_CHOICES.map((h) => ({
    text: `${current === h ? '✅ ' : ''}${h === 0 ? '🔕 Off' : `every ${h}h`}`,
    callback_data: `${NS}c:${h}`,
  }));
  const rows = [chips.slice(0, 3), chips.slice(3)];
  rows.push([{ text: '⬅ Back', callback_data: `${NS}back` }]);
  await render(bot, chatId, userId,
    `⏰ *${s.label}*\n\nCurrent: *${fmtState(current)}*\n\nPick the new setting — it goes to admin approval before taking effect:`,
    rows);
}

async function submitChange(bot, chatId, userId, hours) {
  const session = sessionStore.get(userId);
  if (!session || session.step !== 'cadence') return;
  const s = session._scopes[session.scopeIdx];
  if (!s || !CADENCE_CHOICES.includes(hours)) return;
  const requestId = idGenerator.requestId();
  const actionJSON = {
    action: 'set_reminder_config',
    scope: s.scope, dept: s.dept || '', hours,
    setting_key: reminderPolicy.keyFor(s.scope, s.dept),
  };
  await approvalQueueRepository.append({
    requestId, user: String(userId), actionJSON,
    riskReason: 'Reminder changes require admin approval.', status: 'pending',
  });
  await auditLogRepository.append('approval_queued',
    { requestId, action: 'set_reminder_config', scope: s.scope, dept: s.dept, hours }, userId);
  try {
    const approvalEvents = require('../events/approvalEvents');
    const approvalCards = require('../services/approvalCards');
    const card = `Reminder Config Request\nTarget: ${s.label.replace(/^[^\s]+\s/, '')}${s.dept ? ` department` : ' (approvals, samples, follow-ups, cold alerts)'}\nNew setting: ${hours > 0 ? `ON — every ${hours} hours` : 'OFF (silent)'}`;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId,
      await approvalCards.resolveUserLabel(userId, bot), card,
      'Reminder changes require admin approval.',
      auth.isAdmin(userId) ? String(userId) : undefined);
  } catch (e) { logger.warn(`reminderConfig notify: ${e.message}`); }
  await render(bot, chatId, userId,
    `⏳ *Submitted for approval*\n\n${s.label} → *${hours > 0 ? `every ${hours}h` : 'OFF'}*\nRequest: \`${requestId}\`\n\n_Takes effect once another admin approves._`,
    [[{ text: '⬅ Back to Reminder Controls', callback_data: `${NS}back` }], [{ text: '❌ Close', callback_data: `${NS}close` }]]);
  session.step = 'submitted';
  sessionStore.set(userId, session);
}

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith(NS)) return false;
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  await bot.answerCallbackQuery(query.id).catch(() => {});
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    await bot.answerCallbackQuery(query.id, { text: 'This card expired — open ⏰ Reminder Controls again.', show_alert: true }).catch(() => {});
    return true;
  }
  const rest = data.slice(NS.length);
  if (rest === 'close') {
    sessionStore.clear(userId);
    await bot.editMessageText('⏰ Reminder Controls closed.',
      { chat_id: chatId, message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]] } }).catch(() => {});
    return true;
  }
  if (rest === 'back') { await renderMenu(bot, chatId, userId); return true; }
  if (rest.startsWith('s:')) { await renderCadencePicker(bot, chatId, userId, parseInt(rest.slice(2), 10)); return true; }
  if (rest.startsWith('c:')) { await submitChange(bot, chatId, userId, parseInt(rest.slice(2), 10)); return true; }
  return true;
}

module.exports = { SESSION_TYPE, start, handleCallback, _internals: { CADENCE_CHOICES, fmtState } };
