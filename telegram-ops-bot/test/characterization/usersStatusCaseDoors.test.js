'use strict';

/**
 * FIX-SETTINGS2 — a Users row whose status cell reads `Active` (capital A),
 * through the real controller.
 *
 * auth lower-cases the cell, so that person can use the bot; two doors still
 * compared it letter for letter:
 *
 *  1. The supply request's Dispatch stage. usersRepository.findByDepartment
 *     skipped an `Active` Dispatch person, so they never got the stage-1
 *     card (with nobody else in Dispatch the request went straight to the
 *     admins); and a tap on that card was answered `Only Dispatch members
 *     can act on this.`
 *  2. The Order flow's "Who sold it?" picker, which left an `Active` Sales
 *     person off the list.
 *
 * An `Inactive` row stays out of both.
 */

process.env.ADMIN_IDS = '777,778';
process.env.EMPLOYEE_IDS = '4242,4343,4444,4545,901,902';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, kbTexts } = require('../helpers/charFixture');

const USERS_HEADER = ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'departments', 'warehouses', 'manages', 'notification_prefs'];
const userRow = (id, name, status, dept, whs = '', role = 'employee') => [id, name, role, 'Lagos', 'branch_only', status, '', dept, whs, '', ''];
installFakeSheets(createFakeSheets({
  Users: [
    USERS_HEADER,
    userRow('777', 'Owner', 'active', '', '', 'admin'),
    userRow('778', 'Krishna', 'active', ''),
    userRow('4242', 'Ajeet', 'active', 'Sales', 'IDUMOTA'),
    userRow('4343', 'Musa', 'Active', 'Dispatch', 'IDUMOTA,Lagos'),
    userRow('4444', 'Bello', ' ACTIVE ', 'Dispatch', 'IDUMOTA'),
    userRow('4545', 'Old hand', 'Inactive', 'Dispatch', 'IDUMOTA'),
    userRow('901', 'Abdul', 'Active', 'Sales'),
    userRow('902', 'Kabir', 'Inactive', 'Sales'),
  ],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
auditLogRepository.append = async () => {};

const EMP = '4242';
const ADMIN = '777';
const MUSA = '4343';
const BELLO = '4444';
const OLD = '4545';
const FLOW_MSG = 50;
const cart = [{ design: '44200', shade: 'BLACK', shadeName: '', quantity: 11 }];
const toChat = (bot, id) => bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === String(id));
const toasts = (bot) => bot.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => (c.args.opts && c.args.opts.text) || '');
const hasButton = (call, data) => !!(call.args.opts && call.args.opts.reply_markup
  && call.args.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === data));

function armQueue() {
  const rows = new Map();
  approvalQueueRepository.append = async (rec) => { rows.set(rec.requestId, { ...rec, status: 'pending' }); return rec; };
  approvalQueueRepository.getByRequestId = async (id) => (rows.has(id) ? JSON.parse(JSON.stringify(rows.get(id))) : null);
  approvalQueueRepository.getAllPending = async () => [...rows.values()].filter((r) => r.status === 'pending').map((r) => JSON.parse(JSON.stringify(r)));
  approvalQueueRepository.updateStatus = async (id, status) => { rows.get(id).status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { const r = rows.get(id); r.actionJSON = { ...r.actionJSON, ...patch }; return true; };
  return rows;
}

/** Raise one supply request from Ajeet at IDUMOTA; returns {requestId, bot}. */
async function raise() {
  sessionStore.set(EMP, {
    type: 'supply_req_flow', warehouse: 'IDUMOTA', productType: 'fabric', step: 'confirm', cart,
    customer: 'Ketu madam', salesperson: 'Office', flowMessageId: FLOW_MSG,
    supplier: { user_id: MUSA, name: 'Musa' }, paymentMode: 'Zenith', supplyDate: '2026-09-11',
  });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_conf:yes', EMP, FLOW_MSG));
  const pending = await approvalQueueRepository.getAllPending();
  return { requestId: pending[pending.length - 1].requestId, bot };
}

test.beforeEach(() => { usersRepository.invalidateCache(); });

test('a supply request reaches the Dispatch people whose status reads `Active`, not the `Inactive` one', async () => {
  const rows = armQueue();
  const { requestId, bot } = await raise();
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_review', 'the request waits on Dispatch, not on the admins');
  for (const id of [MUSA, BELLO]) {
    const card = toChat(bot, id).find((c) => hasButton(c, `smc:c:${requestId}`));
    assert.ok(card, `${id} got the Dispatch-review card`);
    assert.ok(hasButton(card, `smc:r:${requestId}`) && hasButton(card, `smc:d:${requestId}`));
  }
  assert.equal(toChat(bot, OLD).length, 0, 'the inactive Dispatch row gets nothing');
  assert.equal(toChat(bot, ADMIN).filter((c) => hasButton(c, `approve:${requestId}`)).length, 0,
    'no admin approval card yet — Dispatch confirms first');
});

test('the `Active` Dispatch person can act on the card: ✅ Confirm moves the request to the admins', async () => {
  const rows = armQueue();
  const { requestId } = await raise();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`smc:c:${requestId}`, MUSA, 70));
  assert.deepEqual(toasts(bot), ['Confirming...'], 'it used to answer "Only Dispatch members can act on this."');
  const aj = rows.get(requestId).actionJSON;
  assert.equal(aj.stage, 'admin_review');
  assert.equal(aj.confirmedByDispatch.user_id, MUSA);
  assert.equal(aj.confirmedByDispatch.name, 'Musa');
  assert.ok(toChat(bot, ADMIN).some((c) => hasButton(c, `approve:${requestId}`)), 'the admins now get the approval card');
});

test('an `Inactive` Dispatch row is still refused on that card', async () => {
  const rows = armQueue();
  const { requestId } = await raise();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`smc:c:${requestId}`, OLD, 71));
  assert.ok(!toasts(bot).includes('Confirming...'));
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_review', 'nothing moved');
});

test('Order → "Who sold it?": a Sales person whose status reads `Active` is on the list; `Inactive` is not', async () => {
  sessionStore.set(ADMIN, { type: 'order_flow', step: 'quantity', createdBy: ADMIN, design: '202/201', shade: '1', customer: 'Chima', customerId: 'C-1' });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('oq:2', ADMIN));
  assert.equal(sessionStore.get(ADMIN).step, 'salesperson');
  const k = kbTexts(bot);
  assert.ok(k.includes('🧑 Abdul|os:901'), `Abdul (Active) is offered — got ${JSON.stringify(k)}`);
  assert.ok(k.includes('🧑 Ajeet|os:4242'), 'a lower-case active Sales person is offered as before');
  assert.ok(!k.some((b) => /Kabir/.test(b)), 'the inactive Sales row is not');
  sessionStore.clear(ADMIN);
});
