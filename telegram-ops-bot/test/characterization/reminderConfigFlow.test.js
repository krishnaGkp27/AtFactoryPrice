'use strict';

/**
 * APR-2 — ⏰ Reminder Controls: toggles queue set_reminder_config through
 * the approval pipeline; the executor writes the Settings key; the policy
 * layer gates member + admin nudges; backlog guard in the sweep.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242,5555';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const departmentsRepository = require(path.join(SRC, 'repositories/departmentsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const reminderPolicy = require(path.join(SRC, 'services/reminderPolicy'));
const riskEvaluate = require(path.join(SRC, 'risk/evaluate'));

let settings = {};
const settingsWrites = [];
settingsRepository.getAll = async () => ({ ...settings });
settingsRepository.set = async (k, v) => { settingsWrites.push({ k, v }); settings[k] = v; };
departmentsRepository.getAll = async () => [
  { dept_id: 'D1', dept_name: 'Sales', status: 'active', allowed_activities: [] },
  { dept_id: 'D2', dept_name: 'Dispatch', status: 'active', allowed_activities: [] },
];
usersRepository.findByUserId = async (id) => ({
  4242: { user_id: '4242', name: 'Abdul', role: 'manager', departments: ['Sales'] },
  5555: { user_id: '5555', name: 'Yarima', role: 'employee', departments: ['Sales'] },
  777: { user_id: '777', name: 'Boss', role: 'admin', departments: [] },
}[String(id)] || null);
auditLogRepository.append = async () => {};

const queued = [];
approvalQueueRepository.append = async (r) => { queued.push(r); };

function cb(data, uid) {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 3 } };
}

test('policy: set_reminder_config is approval-gated for everyone (incl. admins)', async () => {
  const r = await riskEvaluate.evaluate({ action: 'set_reminder_config', userId: '777' });
  assert.equal(r.risk, 'approval_required', 'ALWAYS_APPROVAL even for admins');
});

test('manager opens ⏰, picks a department cadence → approval queued with the right key; employee blocked', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:reminder_controls', '4242'));
  assert.match(bot.allText(), /Reminder Controls/);
  assert.match(bot.allText(), /Everything is OFF unless switched on/);
  const rows = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup).pop()
    .args.opts.reply_markup.inline_keyboard.flat();
  const sales = rows.find((b) => b.text.includes('Sales'));
  assert.match(sales.text, /OFF/, 'default off');
  await controller.handleCallbackQuery(bot, cb(sales.callback_data, '4242'));
  assert.match(bot.allText(), /Pick the new setting/);
  await controller.handleCallbackQuery(bot, cb('rmn:c:6', '4242'));
  assert.equal(queued.length, 1);
  const aj = queued[0].actionJSON;
  assert.equal(aj.action, 'set_reminder_config');
  assert.equal(aj.scope, 'dept');
  assert.equal(aj.dept, 'Sales');
  assert.equal(aj.hours, 6);
  assert.equal(aj.setting_key, 'REMINDER_HOURS.Sales');
  assert.match(bot.allText(), /Submitted for approval/);
  sessionStore.clear('4242');

  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('act:reminder_controls', '5555'));
  assert.match(bot2.allText(), /for managers and admins/, 'employee blocked');
});

test('executor writes the Settings key; policy + hourly-job gating flips live', async () => {
  const inventoryService = require(path.join(SRC, 'services/inventoryService'));
  approvalQueueRepository.getAllPending = async () => [{
    requestId: 'REQ-RMN-1', user: '4242', status: 'pending',
    actionJSON: { action: 'set_reminder_config', scope: 'dept', dept: 'Sales', hours: 6, setting_key: 'REMINDER_HOURS.Sales' },
  }];
  const statusFlips = [];
  approvalQueueRepository.updateStatus = async (id, status) => { statusFlips.push({ id, status }); };
  const res = await inventoryService.executeApprovedAction('REQ-RMN-1', '888');
  assert.equal(res.ok, true);
  assert.deepEqual(settingsWrites.at(-1), { k: 'REMINDER_HOURS.Sales', v: '6' });
  assert.ok(statusFlips.some((f) => f.id === 'REQ-RMN-1' && f.status === 'approved'),
    'SEC-P2 footer marks the row approved (no early return)');

  // Policy view: Sales members now get member nudges; others stay silent.
  assert.equal(await reminderPolicy.shouldRemindUser('5555'), true, 'Sales employee now reminded');
  assert.equal(await reminderPolicy.shouldRemindUser('777'), false, 'no-dept admin not member-reminded');
  assert.equal(await reminderPolicy.hoursForDept('Dispatch'), 0, 'other departments untouched');
  // Admin nudges still off; legacy fallback honored.
  assert.equal(await reminderPolicy.hoursForAdmin(), 0);
  settings.APPROVAL_REMINDER_HOURS = '4';
  assert.equal(await reminderPolicy.hoursForAdmin(), 4, 'legacy key fallback');
  settings.REMINDER_HOURS_ADMIN = '0';
  assert.equal(await reminderPolicy.hoursForAdmin(), 0, 'explicit new key wins over legacy');
});

test('approval sweep honors the 14-day backlog guard', async () => {
  const reminder = require(path.join(SRC, 'services/approvalReminder'));
  reminder._resetForTests();
  settings = { REMINDER_HOURS_ADMIN: '6' };
  const now = Date.now();
  approvalQueueRepository.getAllPending = async () => [
    { requestId: 'FRESH', user: '4242', actionJSON: { action: 'record_payment', customer: 'CJE' }, createdAt: new Date(now - 2 * 86400000).toISOString() },
    { requestId: 'ANCIENT', user: '4242', actionJSON: { action: 'record_payment', customer: 'OLD' }, createdAt: new Date(now - 60 * 86400000).toISOString() },
  ];
  const bot = createFakeBot();
  const sent = await reminder.sweep(bot, { now });
  assert.equal(sent, 1, 'only the fresh row is re-broadcast');
  assert.match(bot.allText(), /FRESH/);
  assert.ok(!/ANCIENT/.test(bot.allText()), '60-day-old backlog row stays silent');
});
