'use strict';
/**
 * FIX-SUPPLY — a supply request that is already decided is dead on every
 * card, and the requester's notices read cleanly.
 *
 *  - A Dispatch member's ✅ Confirm / ❌ Reject on the Dispatch-review card,
 *    tapped after an admin has rejected the request, is answered `Already
 *    rejected — nothing to do.` — no fresh approval card to the admins,
 *    nothing written.
 *  - An admin's ✅ Approve on a request that is rejected, or that an admin
 *    has ALREADY approved (it waits on the supplier's Accept), is answered
 *    the same way — no second Accept card, no second notice.
 *  - A tap at the right stage on a pending request behaves as before.
 *  - The requester's supply notices are plain text (no `*`, `_`, backticks),
 *    quote the short R-XXXX reference and say `Waiting for admin approval`.
 *  - The customer step's ➕ Add New Customer card names the real tile
 *    (➕ Add Contact) and promises no typed search.
 */
process.env.ADMIN_IDS = '777,778';
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
    userRow('778', 'Krishna', '', ''),
    userRow('4242', 'Ajeet', 'Sales', 'IDUMOTA'),
    userRow('4343', 'Musa', 'Dispatch', 'IDUMOTA,Lagos'),
    userRow('4444', 'Bello', 'Dispatch', 'IDUMOTA'),
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
const ADMIN2 = '778';
const MUSA = '4343';
const BELLO = '4444';
const FLOW_MSG = 50;
const cart = [{ design: '44200', shade: 'BLACK', shadeName: '', quantity: 11 }];
const toChat = (bot, id) => bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === String(id));
const toasts = (bot) => bot.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => (c.args.opts && c.args.opts.text) || '');
const sends = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText', 'sendPhoto', 'sendDocument'].includes(c.method));
const msg = (text, uid) => ({ from: { id: uid }, chat: { id: uid }, text });
const short = (id) => `R-${String(id).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4)}`;

let writes = 0;
function armQueue() {
  const rows = new Map();
  writes = 0;
  approvalQueueRepository.append = async (rec) => { rows.set(rec.requestId, { ...rec, status: 'pending' }); return rec; };
  approvalQueueRepository.getByRequestId = async (id) => (rows.has(id) ? JSON.parse(JSON.stringify(rows.get(id))) : null);
  approvalQueueRepository.getAllPending = async () => [...rows.values()].filter((r) => r.status === 'pending').map((r) => JSON.parse(JSON.stringify(r)));
  approvalQueueRepository.updateStatus = async (id, status) => { writes += 1; rows.get(id).status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { writes += 1; const r = rows.get(id); r.actionJSON = { ...r.actionJSON, ...patch }; return true; };
  return rows;
}

/** Raise one supply request from Ajeet at IDUMOTA, naming Musa as the supplier. */
async function raise() {
  sessionStore.set(EMP, {
    type: 'supply_req_flow', warehouse: 'IDUMOTA', productType: 'fabric', step: 'confirm', cart,
    customer: 'Ketu madam', salesperson: 'Office', flowMessageId: FLOW_MSG,
    supplier: { user_id: MUSA, name: 'Musa' }, paymentMode: 'Zenith', supplyDate: '2026-09-11',
  });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_conf:yes', EMP, FLOW_MSG));
  const pending = await approvalQueueRepository.getAllPending();
  return pending[pending.length - 1].requestId;
}

/** No Markdown marker may reach a notice that is sent with no parse mode. */
function assertPlain(call, why) {
  assert.ok(!(call.args.opts && call.args.opts.parse_mode), `${why}: sent with no parse mode`);
  assert.ok(!/[*_`]/.test(call.args.text), `${why}: no stray Markdown symbol in "${call.args.text}"`);
}

test('Dispatch ✅ Confirm after an admin rejected: answered, no fresh admin card, nothing written', async () => {
  const rows = armQueue();
  const requestId = await raise();
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_review');
  await controller.handleCallbackQuery(createFakeBot(), cb(`reject:${requestId}`, ADMIN, 60));
  assert.equal(rows.get(requestId).status, 'rejected', 'the admin rejection landed');
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_review', 'a rejection leaves the stage where it was');

  const before = JSON.stringify(rows.get(requestId));
  writes = 0;
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`smc:c:${requestId}`, MUSA, 70));
  assert.deepEqual(toasts(bot), ['Already rejected — nothing to do.']);
  assert.equal(sends(bot).length, 0, 'nobody is sent anything — no approval card, no requester notice');
  assert.equal(writes, 0, 'nothing is written');
  assert.equal(JSON.stringify(rows.get(requestId)), before, 'the row is untouched');
  const wipe = bot.calls.filter((c) => c.method === 'editMessageReplyMarkup');
  assert.equal(wipe.length, 1, 'the stale card loses its buttons');
  assert.deepEqual(wipe[0].args.replyMarkup, { inline_keyboard: [] });

  // ❌ Reject on the same stale card asks no reason and writes nothing either.
  const rbot = createFakeBot();
  await controller.handleCallbackQuery(rbot, cb(`smc:r:${requestId}`, BELLO, 71));
  assert.deepEqual(toasts(rbot), ['Already rejected — nothing to do.']);
  assert.equal(sends(rbot).length, 0, 'no reason prompt');
  assert.equal(writes, 0);
});

test('admin ✅ Approve after a rejection: Already rejected, nothing assigned', async () => {
  const rows = armQueue();
  const requestId = await raise();
  await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review' });
  await controller.handleCallbackQuery(createFakeBot(), cb(`reject:${requestId}`, ADMIN, 60));
  assert.equal(rows.get(requestId).status, 'rejected');

  writes = 0;
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`approve:${requestId}`, ADMIN2, 61));
  assert.deepEqual(toasts(bot), ['Already rejected — nothing to do.']);
  assert.equal(writes, 0, 'nothing is written');
  assert.equal(toChat(bot, MUSA).length, 0, 'the supplier gets no Accept card');
  assert.equal(toChat(bot, EMP).length, 0, 'the requester gets no notice');
  assert.ok(!rows.get(requestId).actionJSON.assignedDispatch, 'no assignment stamped');
  assert.equal(sends(bot).length, 1, 'only the tapping admin is told');
  assert.match(sends(bot)[0].args.text, /^ℹ️ Request \S+ was already rejected.* — no change made\.$/);
});

test('admin ✅ Approve on a request an admin already approved: Already approved, no second Accept card', async () => {
  const rows = armQueue();
  const requestId = await raise();
  await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review' });
  const first = createFakeBot();
  await controller.handleCallbackQuery(first, cb(`approve:${requestId}`, ADMIN, 60));
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_acceptance');
  assert.equal(rows.get(requestId).status, 'pending', 'still pending until the supplier accepts');
  assert.equal(toChat(first, MUSA).length, 1, 'Musa got the Accept card once');

  const before = JSON.stringify(rows.get(requestId));
  writes = 0;
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`approve:${requestId}`, ADMIN2, 61));
  assert.deepEqual(toasts(bot), ['Already approved — nothing to do.']);
  assert.equal(writes, 0, 'nothing is written');
  assert.equal(JSON.stringify(rows.get(requestId)), before, 'the first admin\'s assignment stands');
  assert.equal(toChat(bot, MUSA).length, 0, 'no second Accept card');
  assert.equal(toChat(bot, EMP).length, 0, 'no second notice to the requester');
  assert.ok(!bot.allText().includes('Assign to a warehouse boy'), 'no picker');
  // The tapping admin alone is told, in the words every decided request uses.
  assert.equal(sends(bot).length, 1);
  assert.equal(String(sends(bot)[0].args.chatId), ADMIN2);
  assert.equal(sends(bot)[0].args.text, `ℹ️ Request ${requestId} was already approved — no change made.`);
  assert.deepEqual(bot.calls.filter((c) => c.method === 'editMessageReplyMarkup').map((c) => c.args.replyMarkup),
    [{ inline_keyboard: [] }], 'the stale card loses its buttons');

  // ❌ Reject is untouched: an admin may still end it at this stage.
  await controller.handleCallbackQuery(createFakeBot(), cb(`reject:${requestId}`, ADMIN2, 62));
  assert.equal(rows.get(requestId).status, 'rejected');
});

test('the normal path is unchanged: Confirm at the Dispatch stage, then Approve at the admin stage', async () => {
  const rows = armQueue();
  const requestId = await raise();
  const ref = short(requestId);

  const dbot = createFakeBot();
  await controller.handleCallbackQuery(dbot, cb(`smc:c:${requestId}`, MUSA, 70));
  const aj = rows.get(requestId).actionJSON;
  assert.equal(aj.stage, 'admin_review');
  assert.equal(aj.confirmedByDispatch.user_id, MUSA);
  assert.deepEqual(toasts(dbot), ['Confirming...']);
  for (const adminId of [ADMIN, ADMIN2]) {
    const card = toChat(dbot, adminId).find((c) => c.args.opts && c.args.opts.reply_markup);
    assert.ok(card, `admin ${adminId} got the approval card`);
    assert.ok(card.args.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === `approve:${requestId}`));
  }
  const confirmed = toChat(dbot, EMP);
  assert.equal(confirmed.length, 1, 'one notice to the requester');
  assert.equal(confirmed[0].args.text, `✅ Dispatch confirmed your supply request ${ref} (by Musa). Waiting for admin approval.`);
  assertPlain(confirmed[0], 'Dispatch confirmed');

  const abot = createFakeBot();
  await controller.handleCallbackQuery(abot, cb(`approve:${requestId}`, ADMIN, 60));
  assert.deepEqual(toasts(abot), ['Approving...']);
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_acceptance');
  assert.equal(rows.get(requestId).actionJSON.assignedDispatch.user_id, MUSA);
  assert.ok(toChat(abot, MUSA).some((c) => /New supply assignment/.test(c.args.text)), 'Musa got the Accept card');
  const approved = toChat(abot, EMP);
  assert.equal(approved.length, 1);
  assert.equal(approved[0].args.text,
    `✅ Your supply request ${ref} was approved and assigned to Musa.\n\n⏳ Waiting for Musa to Accept the dispatch.`);
  assertPlain(approved[0], 'approved and assigned');
});

test('the declined, accepted and Dispatch-rejected notices are plain text with the short reference', async () => {
  const rows = armQueue();
  // Declined, then accepted.
  const requestId = await raise();
  const ref = short(requestId);
  await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review' });
  await controller.handleCallbackQuery(createFakeBot(), cb(`approve:${requestId}`, ADMIN, 60));
  const dbot = createFakeBot();
  await controller.handleCallbackQuery(dbot, cb(`srf_dec:${requestId}`, MUSA, 80));
  await controller.handleMessage(dbot, msg('Out today - back tomorrow', MUSA));
  assert.equal(rows.get(requestId).actionJSON.stage, 'admin_repick');
  const declined = toChat(dbot, EMP);
  assert.equal(declined.length, 1);
  assert.equal(declined[0].args.text,
    `⚠️ Musa declined the dispatch assignment for ${ref}.\n\nReason: Out today - back tomorrow\n\nAdmin will reassign shortly.`);
  assertPlain(declined[0], 'declined');

  await approvalQueueRepository.updateActionJSON(requestId, { stage: 'dispatch_acceptance' });
  const acc = createFakeBot();
  await controller.handleCallbackQuery(acc, cb(`srf_acc:${requestId}`, MUSA, 81));
  assert.equal(rows.get(requestId).status, 'approved');
  const accepted = toChat(acc, EMP);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].args.text, `✅ Musa has accepted dispatch for your supply request ${ref}. Stock is being prepared.`);
  assertPlain(accepted[0], 'accepted');

  // Rejected by Dispatch at stage 1.
  const second = await raise();
  const rbot = createFakeBot();
  await controller.handleCallbackQuery(rbot, cb(`smc:r:${second}`, MUSA, 82));
  await controller.handleMessage(rbot, msg('Test only - please ignore', MUSA));
  assert.equal(rows.get(second).status, 'rejected');
  const rejected = toChat(rbot, EMP);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].args.text,
    `❌ Dispatch rejected your supply request ${short(second)}.\n\nReason: Test only - please ignore\n\nReason given by: Musa\n\nYou can edit and resubmit if you want to retry.`);
  assertPlain(rejected[0], 'Dispatch rejected');
});

test('an Accept card that cannot be delivered hands the request back to the admin — ✅ Approve works again', async () => {
  const rows = armQueue();
  const requestId = await raise();
  await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review' });

  const deaf = createFakeBot();
  const realSend = deaf.sendMessage.bind(deaf);
  deaf.sendMessage = async (chatId, text, opts) => {
    if (String(chatId) === MUSA) throw new Error('403: bot was blocked by the user');
    return realSend(chatId, text, opts);
  };
  await controller.handleCallbackQuery(deaf, cb(`approve:${requestId}`, ADMIN, 60));
  assert.match(deaf.allText(), /Could not send message to user 4343/);
  const aj = rows.get(requestId).actionJSON;
  assert.equal(aj.stage, 'admin_review', 'back with the admin, not parked on a supplier who never got the card');
  assert.ok(!aj.assignedDispatch, 'no assignment stands');
  assert.ok(!aj.approvedByAdmin, 'no approval stands');
  assert.equal(toChat(deaf, EMP).length, 0, 'the requester is not told it was assigned');

  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`approve:${requestId}`, ADMIN, 61));
  assert.deepEqual(toasts(bot), ['Approving...'], 'not answered "Already approved"');
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_acceptance');
  assert.equal(toChat(bot, MUSA).length, 1, 'the Accept card went out this time');
});

test('the customer step\'s ➕ Add New Customer card names ➕ Add Contact and promises no typed search', async () => {
  sessionStore.set(EMP, {
    type: 'supply_req_flow', warehouse: 'IDUMOTA', productType: 'fabric', step: 'customer', cart, flowMessageId: FLOW_MSG,
  });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cu:__new__', EMP, FLOW_MSG));
  const card = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).pop();
  assert.equal(card.args.text,
    '➕ New customers are added by an admin via 👥 CRM → ➕ Add Contact.\nExisting customers are picked from the list — tap ⬅️ Back to customers.');
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'srf_back:customer' && b.text === '⬅️ Back to customers'));
  sessionStore.clear(EMP);
});
