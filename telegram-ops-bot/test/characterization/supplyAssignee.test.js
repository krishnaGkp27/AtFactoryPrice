'use strict';
/**
 * SRF-6 — the requester names who will supply; the admin card shows it and
 * where the request sits; ✅ Approve assigns that person straight away (no
 * picker); ✎ Assign someone else lets an admin override before approving;
 * a request raised without a choice still goes through the picker; the
 * Dispatch-review card never shows the name (R2).
 */
process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,4343,4444';
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, lastKb } = require('../helpers/charFixture');

const USERS_HEADER = ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'departments', 'warehouses', 'manages', 'notification_prefs'];
const userRow = (id, name, dept, whs) => [id, name, 'employee', 'Lagos', 'branch_only', 'active', '', dept, whs, '', ''];
installFakeSheets(createFakeSheets({
  Users: [
    USERS_HEADER,
    userRow('777', 'Owner', '', ''),
    userRow('4242', 'Ajeet', 'Sales', 'IDUMOTA'),
    userRow('4343', 'Musa', 'Dispatch', 'IDUMOTA,Lagos'),
    userRow('4444', 'Bello', 'Warehouse', 'Kano office'),
  ],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
auditLogRepository.append = async () => {};

const EMP = '4242';
const ADMIN = '777';
const MUSA = '4343';
const FLOW_MSG = 50;
const cart = [{ design: '44200', shade: 'BLACK', shadeName: '', quantity: 11 }];
const lastText = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).pop().args.text;
const cbs = (bot) => lastKb(bot).map((b) => b.callback_data);
const texts = (bot) => lastKb(bot).map((b) => b.text);
const toChat = (bot, id) => bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === String(id)).map((c) => c.args.text);

function armQueue() {
  const rows = new Map();
  approvalQueueRepository.append = async (rec) => { rows.set(rec.requestId, { ...rec, status: 'pending' }); return rec; };
  approvalQueueRepository.getByRequestId = async (id) => (rows.has(id) ? JSON.parse(JSON.stringify(rows.get(id))) : null);
  approvalQueueRepository.getAllPending = async () => [...rows.values()].filter((r) => r.status === 'pending').map((r) => JSON.parse(JSON.stringify(r)));
  approvalQueueRepository.updateStatus = async (id, status) => { rows.get(id).status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { const r = rows.get(id); r.actionJSON = { ...r.actionJSON, ...patch }; return true; };
  return rows;
}
function seed(uid, step, extra = {}) {
  sessionStore.set(uid, {
    type: 'supply_req_flow', warehouse: 'IDUMOTA', productType: 'fabric', step, cart,
    customer: 'Ketu madam', salesperson: 'Office', flowMessageId: FLOW_MSG, ...extra,
  });
}

test('after the salesperson: the eligible dispatch people of the store, no admin door; the pick lands on payment', async () => {
  seed(EMP, 'salesperson');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_sp:Office', EMP, FLOW_MSG));
  assert.match(lastText(bot), /^🚚 \*Who will supply it\?\* · 🏭 IDUMOTA\nPick the person who will prepare and hand over the goods\.$/);
  assert.deepEqual(texts(bot), ['🧑 Musa', '📋 See all (2)', '⬅️ Back to salesperson'], 'Musa only; Bello is Kano; no Let admin choose (R1)');
  await controller.handleCallbackQuery(bot, cb(`srf_su:${MUSA}`, EMP, FLOW_MSG));
  assert.deepEqual(sessionStore.get(EMP).supplier, { user_id: MUSA, name: 'Musa' });
  assert.equal(sessionStore.get(EMP).step, 'payment');
  assert.ok(cbs(bot).includes('srf_back:supplier'));
  await controller.handleCallbackQuery(bot, cb('srf_back:supplier', EMP, FLOW_MSG));
  assert.match(lastText(bot), /Who will supply it/);
});

test('a store with nobody attached offers 🛂 Let admin choose and See all', async () => {
  seed(EMP, 'salesperson', { warehouse: 'Abuja' });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_sp:Office', EMP, FLOW_MSG));
  assert.match(lastText(bot), /_No dispatch person is attached to Abuja — an admin will choose\._/);
  assert.deepEqual(cbs(bot), ['srf_su:__more__', 'srf_su:__admin__', 'srf_back:salesperson']);
});

async function submitWith(bot, supplier) {
  seed(EMP, 'confirm', { supplier, paymentMode: 'Zenith', supplyDate: '2026-09-11' });
  await controller.handleCallbackQuery(bot, cb('srf_conf:yes', EMP, FLOW_MSG));
  const rows = await approvalQueueRepository.getAllPending();
  return rows[rows.length - 1];
}

test('submit: the row carries requestedAssignee; the requester sees the name; Dispatch review card shows no name (R2)', async () => {
  armQueue();
  const bot = createFakeBot();
  const row = await submitWith(bot, { user_id: MUSA, name: 'Musa' });
  assert.deepEqual({ user_id: row.actionJSON.requestedAssignee.user_id, name: row.actionJSON.requestedAssignee.name }, { user_id: MUSA, name: 'Musa' });
  assert.equal(row.actionJSON.stage, 'dispatch_review', 'Musa is Dispatch, so stage 1 runs');
  const receipt = bot.calls.filter((c) => c.method === 'editMessageText').pop().args.text;
  assert.match(receipt, /🧑 Office\n🚚 Musa\n💳 Zenith/);
  const dispatchCard = toChat(bot, MUSA).find((t) => /Show details|Confirm/.test(t) || true);
  assert.ok(dispatchCard, 'Musa got the Dispatch-review card');
  assert.ok(!/🚚/.test(dispatchCard), 'the Dispatch card does not carry the supplier line');
});

test('admin card shows the choice and the waiting line; ✅ Approve assigns Musa at once, no picker', async () => {
  const rows = armQueue();
  const bot = createFakeBot();
  const row = await submitWith(bot, { user_id: MUSA, name: 'Musa' });
  const requestId = row.requestId;
  // Dispatch confirmed → admin stage
  await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review', confirmedByDispatch: { user_id: MUSA, name: 'Musa', ts: new Date().toISOString() } });
  const approvalCards = require(path.join(SRC, 'services/approvalCards'));
  const card = await approvalCards.buildCardFromActionJSON((await approvalQueueRepository.getByRequestId(requestId)).actionJSON);
  assert.match(card, /🧑 Office\n🚚 To be supplied by Musa · requester's choice\n💳 Zenith/);
  assert.match(card, /\n\n🛂 Waiting on an admin to approve · confirmed by Musa today$/);

  const abot = createFakeBot();
  await controller.handleCallbackQuery(abot, cb(`approve:${requestId}`, ADMIN, 60));
  const after = rows.get(requestId).actionJSON;
  assert.equal(after.stage, 'dispatch_acceptance');
  assert.equal(after.assignedDispatch.user_id, MUSA);
  assert.ok(!abot.allText().includes('Assign to a warehouse boy'), 'no picker');
  assert.match(abot.allText(), /assigned to \*Musa\*, as the requester asked/);
  const intimation = toChat(abot, MUSA).find((t) => /New supply assignment/.test(t));
  assert.ok(intimation, 'Musa got the Accept card');
  assert.match(intimation, /Named by the requester and approved by admin/);
  assert.equal(after.stage === 'dispatch_acceptance' && (await approvalQueueRepository.getByRequestId(requestId)).status, 'pending', 'still pending until Musa accepts');
  const live = await approvalCards.buildCardFromActionJSON(after);
  assert.match(live, /🚚 Assigned to Musa[\s\S]*🚚 Waiting on Musa to accept · assigned today$/);
});

test('✎ Assign someone else before approval overrides the choice; a row without a choice still opens the picker', async () => {
  const rows = armQueue();
  const bot = createFakeBot();
  const row = await submitWith(bot, { user_id: MUSA, name: 'Musa' });
  const requestId = row.requestId;
  await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review' });
  const abot = createFakeBot();
  await controller.handleCallbackQuery(abot, cb(`srf_rea:${requestId}`, ADMIN, 61));
  assert.match(lastText(abot), /Who should supply R-[0-9A-Z]{4} instead of \*Musa\*\? · 🏭 IDUMOTA/);
  assert.deepEqual(cbs(abot), [`srf_reas:${requestId}|${MUSA}`, `srf_reas:${requestId}|__keep__`]);
  // pick through the fallback of every dispatch person is not offered here (Musa is eligible); override to Bello via a direct tap
  await controller.handleCallbackQuery(abot, cb(`srf_reas:${requestId}|4444`, ADMIN, 62));
  const aj = rows.get(requestId).actionJSON;
  assert.equal(aj.requestedAssignee.user_id, '4444');
  assert.equal(aj.requestedAssignee.byAdmin, ADMIN);
  assert.match(lastText(abot), /will be supplied by \*Bello\* \(changed by you\)/);
  const bbot = createFakeBot();
  await controller.handleCallbackQuery(bbot, cb(`approve:${requestId}`, ADMIN, 63));
  assert.equal(rows.get(requestId).actionJSON.assignedDispatch.user_id, '4444');
  assert.ok(!bbot.allText().includes('as the requester asked'), 'an admin change is not "as the requester asked"');

  // legacy / "let admin choose": the picker as before
  const cbot = createFakeBot();
  const row2 = await submitWith(cbot, null);
  await approvalQueueRepository.updateActionJSON(row2.requestId, { stage: 'admin_review' });
  const dbot = createFakeBot();
  await controller.handleCallbackQuery(dbot, cb(`approve:${row2.requestId}`, ADMIN, 64));
  assert.match(dbot.allText(), /Assign to a warehouse boy/);
  assert.ok(cbs(dbot).includes(`srf_assign:${row2.requestId}|${MUSA}`), 'the picker offers the store\'s dispatch person');
});
