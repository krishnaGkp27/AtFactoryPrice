'use strict';

/**
 * BANK-2 — named bank accounts (owner 21-Jul): two-step Add Bank Account
 * (bank → account, skip = bare bank), dedupe on the combined entry, the
 * same approval governance, and account chips + Manage shortcut at the
 * sale-approval payment step.
 */

process.env.ADMIN_IDS = '777,888';
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
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

let settings = { BANK_LIST: 'ZENITH — AFP LTD,GTB' };
settingsRepository.getAll = async () => ({ ...settings });
auditLogRepository.append = async () => {};
const queued = [];
approvalQueueRepository.append = async (r) => { queued.push(r); };

function cb(data, uid = '777') {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 6 } };
}
function txt(text, uid = '777') {
  return { from: { id: uid }, chat: { id: uid }, text };
}

test('two-step add: bank then account → one combined entry queued for approval', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('bkadd:0'));
  assert.match(bot.allText(), /Step 1 of 2.*BANK name/s);
  await controller.handleMessage(bot, txt('ZENITH'));
  assert.match(bot.allText(), /Step 2 of 2.*ACCOUNT name at \*ZENITH\*/s);
  await controller.handleMessage(bot, txt('MAMA KAFAYA ENT'));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].actionJSON.action, 'add_bank');
  assert.equal(queued[0].actionJSON.bank_name, 'ZENITH — MAMA KAFAYA ENT');
  // The approving admin card names both parts.
  const adminMsgs = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '888').map((c) => c.args.text).join('\n').replace(/\\/g, '');
  assert.match(adminMsgs, /Entry: ZENITH — MAMA KAFAYA ENT/);
  assert.match(adminMsgs, /Account: MAMA KAFAYA ENT/);
  assert.ok(!sessionStore.get('777'), 'flow session cleared');
});

test('skip at step 2 registers a bare bank; duplicate combined entries are refused', async () => {
  const bot = createFakeBot();
  queued.length = 0;
  await controller.handleCallbackQuery(bot, cb('bkadd:0'));
  await controller.handleMessage(bot, txt('UBA'));
  await controller.handleMessage(bot, txt('skip'));
  assert.equal(queued[0].actionJSON.bank_name, 'UBA', 'bare bank still allowed');

  queued.length = 0;
  await controller.handleCallbackQuery(bot, cb('bkadd:0'));
  await controller.handleMessage(bot, txt('ZENITH'));
  await controller.handleMessage(bot, txt('AFP LTD')); // ZENITH — AFP LTD already in BANK_LIST
  assert.match(bot.allText().replace(/\\/g, ''), /"ZENITH — AFP LTD" already exists/);
  assert.equal(queued.length, 0, 'duplicate not queued');
  sessionStore.clear('777');
});

test('sale-approval payment step: one chip per ACCOUNT + the Manage shortcut', async () => {
  const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
  settings = { BANK_LIST: 'ZENITH — AFP LTD,ZENITH — MAMA KAFAYA ENT,GTB' };
  const bot = createFakeBot();
  const state = {};
  await approvalEvents._internals.sendPaymentStep(bot, '777', state);
  const kb = bot.calls.filter((c) => c.method === 'sendMessage').pop().args.opts.reply_markup.inline_keyboard.flat();
  const bankChips = kb.filter((b) => b.text.startsWith('🏦') && b.callback_data.startsWith('enr:pay:b:'));
  assert.deepEqual(bankChips.map((b) => b.text), ['🏦 ZENITH — AFP LTD', '🏦 ZENITH — MAMA KAFAYA ENT', '🏦 GTB'],
    'both same-bank accounts are separate chips');
  assert.ok(kb.some((b) => b.callback_data === 'act:manage_banks'), 'Manage accounts shortcut present');
  assert.deepEqual(state.banks.length, 3, 'state carries the full entries for the pick handler');
});
