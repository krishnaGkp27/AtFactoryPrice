'use strict';

/**
 * MORN-1 — ⏰ Morning Digest settings screen through the real controller:
 * admin-only access, category toggle writes + audit, time chip, test send.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const customerNotesRepository = require(path.join(SRC, 'repositories/customerNotesRepository'));

let stored = {};
settingsRepository.getAll = async () => ({
  DIGEST_ENABLED: 1, DIGEST_TIME: '09:15', DIGEST_TIMEZONE: 'Africa/Lagos',
  DIGEST_NOTES_DAYS: 7, DIGEST_CUSTOMER_NOTES: 1, DIGEST_FOLLOWUPS: 0,
  DIGEST_APPROVALS: 0, DIGEST_TASKS: 0, DIGEST_SAMPLES: 0,
  DIGEST_LOW_STOCK: 0, DIGEST_ORDERS: 0, ...stored,
});
settingsRepository.set = async (k, v) => { stored[k] = v; };
const audits = [];
auditLogRepository.append = async (event, payload) => { audits.push({ event, payload }); };
customerNotesRepository.getAll = async () => [
  { note_id: 'N1', customer: 'CJE', note: 'promised payment Friday', created_by: '777', created_at: new Date().toISOString() },
];

function cb(data, uid) {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 55 } };
}
function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}

test('employee is refused; admin sees the toggle screen', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:morning_digest', '4242'));
  assert.match(bot.allText(), /Admin only/);
  await controller.handleCallbackQuery(bot, cb('act:morning_digest', '777'));
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => /✅ 🗒 Customer notes/.test(b.text)), 'notes ON at launch');
  assert.ok(kb.some((b) => /⬜ 🛂 Pending approvals/.test(b.text)), 'approvals OFF at launch');
});

test('toggle writes the setting + audit row and re-renders', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('rmd:t:DIGEST_APPROVALS', '777'));
  assert.equal(stored.DIGEST_APPROVALS, 1, 'setting flipped on');
  assert.ok(audits.some((a) => a.event === 'digest_config_changed' && a.payload.key === 'DIGEST_APPROVALS'));
  assert.ok(lastKb(bot).some((b) => /✅ 🛂 Pending approvals/.test(b.text)), 're-rendered ticked');
  await controller.handleCallbackQuery(bot, cb('rmd:tm:0900', '777'));
  assert.equal(stored.DIGEST_TIME, '09:00', 'time chip applied');
});

test('▶ test button sends the composed digest to the admin', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('rmd:test', '777'));
  assert.match(bot.allText(), /Good morning/);
  assert.match(bot.allText(), /CJE.*promised payment Friday/);
});
