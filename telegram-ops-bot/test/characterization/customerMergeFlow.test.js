'use strict';

/**
 * CUS-1 Phase E — 🔀 Merge Customers ("Yes Merge, not delete", owner 29-Jul).
 *
 * The properties pinned: admin-only entry; typing searches (never creates);
 * the confirm card says exactly what will happen; the queued action is
 * DUAL-admin gated; and the executor delegates to customerEntity.mergeInto
 * so aliases and Merged status are the entity's single implementation.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const riskPolicy = require(path.join(SRC, 'risk/evaluate'));

customersRepository.getAll = async () => ([
  { rowIndex: 2, customer_id: 'CUST-1', name: 'CJE', phone: '0801', status: 'Active', aliases: [] },
  { rowIndex: 3, customer_id: 'CUST-9', name: 'C.J.E', phone: '', status: 'Active', aliases: [] },
  { rowIndex: 4, customer_id: 'CUST-2', name: 'Ketu madam', phone: '0802', status: 'Active', aliases: [] },
]);

const ADMIN = '777';

function texts(bot) {
  return bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method))
    .map((c) => c.args.text).join('\n');
}
function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)
    && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}

test('merge is DUAL-admin in policy — two people see a ledger-identity move', () => {
  assert.ok(riskPolicy.WRITE_ACTIONS.includes('merge_customers'));
  assert.ok(riskPolicy.ALWAYS_APPROVAL_ACTIONS.includes('merge_customers'));
  assert.ok(riskPolicy.DUAL_ADMIN_ACTIONS.includes('merge_customers'));
});

test('the flow is admin-only', async () => {
  const bot = createFakeBot();
  const flow = require(path.join(SRC, 'flows/customerMergeFlow'));
  await flow.start(bot, '4242', '4242', null);
  assert.match(texts(bot), /admin-only/i);
  assert.equal(sessionStore.get('4242'), null);
});

test('search → pick typo → pick real → confirm → queued with both ids', async () => {
  const bot = createFakeBot();
  const queued = [];
  approvalQueueRepository.append = async (r) => { queued.push(r); };

  await controller.handleCallbackQuery(bot, cb('act:merge_customers', ADMIN));
  assert.match(texts(bot), /type part of the DUPLICATE/i);

  await controller.handleMessage(bot, { from: { id: ADMIN }, chat: { id: ADMIN }, text: 'c.j' });
  const typoChip = lastKb(bot).find((b) => /C\.J\.E/.test(b.text));
  assert.ok(typoChip, 'the typo is offered');
  await controller.handleCallbackQuery(bot, cb(typoChip.callback_data, ADMIN));
  assert.match(texts(bot), /Step 2 of 2/);

  await controller.handleMessage(bot, { from: { id: ADMIN }, chat: { id: ADMIN }, text: 'cje' });
  const realChip = lastKb(bot).find((b) => b.text === '👤 CJE');
  assert.ok(realChip, 'the canonical target is offered (typo itself excluded)');
  await controller.handleCallbackQuery(bot, cb(realChip.callback_data, ADMIN));

  const confirm = texts(bot);
  assert.match(confirm, /becomes an alias/, 'the card says what will happen');
  assert.match(confirm, /SECOND admin/i, 'and that a second admin must approve');

  const ok = lastKb(bot).find((b) => /Queue merge/.test(b.text));
  await controller.handleCallbackQuery(bot, cb(ok.callback_data, ADMIN));
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].actionJSON, {
    action: 'merge_customers',
    typoId: 'CUST-9', typoName: 'C.J.E',
    canonicalId: 'CUST-1', canonicalName: 'CJE',
  });
  assert.equal(sessionStore.get(ADMIN), null, 'session sealed after queueing');
});

test('the executor delegates to customerEntity.mergeInto and audits', async () => {
  const inventoryService = require(path.join(SRC, 'services/inventoryService'));
  const customerEntity = require(path.join(SRC, 'services/customerEntity'));
  const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
  const approvalQueueRepo = require(path.join(SRC, 'repositories/approvalQueueRepository'));

  const calls = [];
  customerEntity.mergeInto = async (canonicalId, typoId) => { calls.push([canonicalId, typoId]); return { ok: true }; };
  const audits = [];
  auditLogRepository.append = async (type) => { audits.push(type); };
  approvalQueueRepo.getAllPending = async () => ([{
    requestId: 'M-1', user: '777', status: 'pending',
    actionJSON: {
      action: 'merge_customers',
      typoId: 'CUST-9', typoName: 'C.J.E', canonicalId: 'CUST-1', canonicalName: 'CJE',
    },
  }]);
  approvalQueueRepo.updateStatus = async () => {};

  const res = await inventoryService.executeApprovedAction('M-1', '888');
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['CUST-1', 'CUST-9']], 'canonical first, typo second');
  assert.ok(audits.includes('customers_merged'));
});

test('a failed merge surfaces the reason instead of a silent ok', async () => {
  const inventoryService = require(path.join(SRC, 'services/inventoryService'));
  const customerEntity = require(path.join(SRC, 'services/customerEntity'));
  const approvalQueueRepo = require(path.join(SRC, 'repositories/approvalQueueRepository'));
  customerEntity.mergeInto = async () => ({ ok: false, reason: 'already_merged' });
  approvalQueueRepo.getAllPending = async () => ([{
    requestId: 'M-2', user: '777', status: 'pending',
    actionJSON: { action: 'merge_customers', typoId: 'CUST-9', canonicalId: 'CUST-1' },
  }]);
  approvalQueueRepo.updateStatus = async () => {};
  const res = await inventoryService.executeApprovedAction('M-2', '888');
  assert.equal(res.ok, false);
  assert.match(res.message, /already_merged/);
});
