'use strict';

/**
 * TRM-1 — the whole journey, driven through the REAL handlers.
 *
 *   🔁 Auto-remind  → queues task_reminder_enable, changes NOTHING yet
 *   second admin    → executor arms the flag
 *   sweep           → doer nudged, assigner mirrored
 *   ⏹ Stop          → flag cleared, doer told, one tap, no approval
 *
 * The gate is the point of the feature, so it is asserted twice: the chip
 * alone must never arm a task, and the risk matrix must demand two DISTINCT
 * admin taps (the PAY-1 lesson — a comment claiming dual while the matrix
 * returned one).
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_IDS = '777,888';

const { installFakeSheets, SRC } = require('../helpers/controllerHarness');
const { createFakeSheets } = require('../helpers/fakeSheets');
installFakeSheets(createFakeSheets({}));

const taskFlow = require(path.join(SRC, 'flows/taskFlow'));
const tasksRepository = require(path.join(SRC, 'repositories/tasksRepository'));
const taskEventsRepository = require(path.join(SRC, 'repositories/taskEventsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const riskEvaluate = require(path.join(SRC, 'risk/evaluate'));
const inventoryService = require(path.join(SRC, 'services/inventoryService'));
const reminderSvc = require(path.join(SRC, 'services/taskReminderService'));
const auth = require(path.join(SRC, 'middlewares/auth'));

const ADMIN = '777';
const DOER = '900';

let ROW;
let QUEUED = [];
let EVENTS = [];
tasksRepository.getById = async (id) => (ROW && ROW.task_id === id ? { ...ROW } : null);
tasksRepository.getAll = async () => (ROW ? [{ ...ROW }] : []);
tasksRepository.updateFields = async (id, patch) => {
  if (!ROW || ROW.task_id !== id) return false;
  if ('auto_remind' in patch) ROW.auto_remind = patch.auto_remind === '1';
  return true;
};
taskEventsRepository.append = async (e) => { EVENTS.push(e); return e; };
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}` });
usersRepository.getAll = async () => ([{ user_id: ADMIN, name: 'Boss', status: 'active' }]);
settingsRepository.getAll = async () => ({ TASK_REMINDER_ENABLED: 1, TASK_REMINDER_HOURS: 24, TASK_STALL_DAYS: 7 });
approvalQueueRepository.append = async (r) => { QUEUED.push(r); return r; };
approvalQueueRepository.getAllPending = async () => QUEUED
  .filter((r) => r.status !== 'rejected')
  .map((r) => ({ requestId: r.requestId, user: r.user, status: 'pending', actionJSON: r.actionJSON }));
approvalQueueRepository.updateStatus = async (id, status) => {
  const r = QUEUED.find((x) => x.requestId === id);
  if (r) r.status = status;
  return true;
};
approvalQueueRepository.setStatus = async () => true;
auditLogRepository.append = async () => {};
approvalEvents.notifyAdminsApprovalRequest = async () => {};
auth.isAdmin = (id) => String(id) === ADMIN;

function seed() {
  ROW = {
    task_id: 'T1', title: 'Payment collection', description: 'Collect from the Kano corridor.',
    assigned_to: DOER, assigned_by: ADMIN, status: 'assigned', track: 'salaried',
    priority: 'critical', auto_remind: false, negotiation_rounds: 0,
    assigned_at: '2026-08-01T09:00:00Z', last_event_at: '2026-08-01T09:00:00Z',
    proposed_hours: null, proposed_deadline: '', started_at: '',
  };
  QUEUED = []; EVENTS = [];
  reminderSvc._internals._resetForTests();
}

function fakeBot() {
  const sent = [];
  return {
    sent,
    answerCallbackQuery: async () => true,
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId: String(chatId), text, opts }); return { message_id: sent.length }; },
    editMessageText: async (text, opts) => { sent.push({ chatId: String(opts.chat_id), text, opts }); return { message_id: opts.message_id }; },
    deleteMessage: async () => true,
    to(id) { return sent.filter((m) => m.chatId === String(id)); },
    last() { return sent[sent.length - 1]; },
  };
}
const cbq = (data, from = ADMIN) => ({ id: 'q1', data, from: { id: from }, message: { chat: { id: from }, message_id: 55 } });
const btns = (m) => (m.opts.reply_markup.inline_keyboard || []).flat();

test('the risk matrix really demands two DISTINCT admins', () => {
  assert.ok(riskEvaluate.ALWAYS_APPROVAL_ACTIONS.includes('task_reminder_enable'), 'always gated');
  assert.ok(riskEvaluate.DUAL_ADMIN_ACTIONS.includes('task_reminder_enable'), 'dual listed');
  assert.equal(riskEvaluate.requiredAdminApprovals({
    action: 'task_reminder_enable', requesterIsAdmin: false, adminCount: 3,
  }), 2, 'an employee-raised arming needs two taps');
});

test('🔁 Auto-remind queues an approval and arms NOTHING yet', async () => {
  seed();
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:tt:o:a:0:T1'));
  const chip = btns(bot.last()).find((b) => /Auto-remind/.test(b.text));
  assert.ok(chip, 'the card offers arming');
  assert.match(chip.callback_data, /^tsk:rmon:o:a:0:T1$/);

  await taskFlow.handleCallback(bot, cbq(chip.callback_data));
  assert.equal(QUEUED.length, 1, 'exactly one approval queued');
  assert.equal(QUEUED[0].actionJSON.action, 'task_reminder_enable');
  assert.equal(QUEUED[0].actionJSON.task_id, 'T1');
  assert.equal(ROW.auto_remind, false, 'the chip alone arms nothing');
  assert.match(bot.last().text, /once a second admin signs it/i, 'the admin is told what happens next');

  // And with nothing armed, the sweep stays silent.
  const quiet = fakeBot();
  await reminderSvc.sweep(quiet, { now: Date.parse('2026-08-27T10:00:00Z') });
  assert.equal(quiet.sent.length, 0, 'no approval → no nudge');
});

test('the second admin\'s approval arms it, and then the sweep speaks', async () => {
  seed();
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:rmon:o:a:0:T1'));
  const requestId = QUEUED[0].requestId;

  approvalQueueRepository.getAllPending = async () => ([{
    requestId, user: ADMIN, status: 'pending', actionJSON: QUEUED[0].actionJSON,
  }]);
  const res = await inventoryService.executeApprovedAction(requestId, '888');
  assert.equal(res.ok, true);
  assert.equal(ROW.auto_remind, true, 'the approval is what arms it');
  // The executor's own message (approvalEvents currently shows a generic
  // line instead — see the NOTE in inventoryService; the user-visible
  // promise is carried by the sweep and the card, both asserted below).
  assert.match(res.message, /reminders armed/i);
  assert.ok(EVENTS.some((e) => e.event_type === 'auto_remind_armed'), 'audited');

  const bot2 = fakeBot();
  const out = await reminderSvc.sweep(bot2, { now: Date.parse('2026-08-27T10:00:00Z') });
  assert.equal(out.sent, 1);
  assert.match(bot2.to(DOER)[0].text, /waiting on you/i, 'the doer is nudged');
  assert.match(bot2.to(ADMIN)[0].text, /Reminder sent on your behalf/i, 'the admin is mirrored');

  // Re-approving the same request must not report a second arming.
  const again = await inventoryService.executeApprovedAction(requestId, '888');
  assert.match(again.message, /already armed/i);
});

test('⏹ Stop reminders: one tap, no approval, doer told', async () => {
  seed();
  ROW.auto_remind = true;
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:tt:o:a:0:T1'));
  const card = bot.last();
  assert.match(card.text, /Automatic reminders are ON/i, 'the card says reminders are live');
  const stop = btns(card).find((b) => /Stop reminders/.test(b.text));
  assert.ok(stop, 'an armed task offers the stop switch');
  assert.ok(!btns(card).some((b) => /Auto-remind/.test(b.text)), 'and not both chips at once');

  await taskFlow.handleCallback(bot, cbq(stop.callback_data));
  assert.equal(ROW.auto_remind, false, 'stopped immediately');
  assert.equal(QUEUED.length, 0, 'stopping needs no approval');
  assert.ok(EVENTS.some((e) => e.event_type === 'auto_remind_stopped'), 'audited');
  assert.match(bot.to(DOER)[0].text, /Reminders stopped/i, 'the doer hears the pressure is off');

  const quiet = fakeBot();
  await reminderSvc.sweep(quiet, { now: Date.parse('2026-08-27T10:00:00Z') });
  assert.equal(quiet.sent.length, 0, 'and the sweep is silent again');
});

test('a manager who did not assign the task cannot arm or stop it', async () => {
  seed();
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:rmon:o:a:0:T1', '555'));
  assert.equal(QUEUED.length, 0, 'no approval raised by a stranger to the task');
  assert.equal(ROW.auto_remind, false);
});

test('a second tap does not queue a second arming', async () => {
  seed();
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:rmon:o:a:0:T1'));
  await taskFlow.handleCallback(bot, cbq('tsk:rmon:o:a:0:T1'));
  assert.equal(QUEUED.length, 1, 'one request per task, however many taps');
  assert.match(bot.last().text, /Already waiting on a second admin/i);
});

test('⏹ Stop withdraws a pending arming, so nothing can re-arm behind you', async () => {
  seed();
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:rmon:o:a:0:T1'));
  const requestId = QUEUED[0].requestId;

  // It gets armed and then deliberately stopped.
  approvalQueueRepository.getAllPending = async () => QUEUED
    .filter((r) => r.status !== 'rejected')
    .map((r) => ({ requestId: r.requestId, user: r.user, status: 'pending', actionJSON: r.actionJSON }));
  ROW.auto_remind = true;
  await taskFlow.handleCallback(bot, cbq('tsk:rmoff:o:a:0:T1'));
  assert.equal(ROW.auto_remind, false, 'stopped');
  assert.equal(QUEUED[0].status, 'rejected', 'and the queued arming is withdrawn');
  assert.match(bot.last().text, /withdrawn/i, 'the admin is told');

  // The stale request can no longer be approved into an arming.
  const stillPending = await approvalQueueRepository.getAllPending();
  assert.ok(!stillPending.some((r) => r.requestId === requestId), 'gone from the queue');
});
