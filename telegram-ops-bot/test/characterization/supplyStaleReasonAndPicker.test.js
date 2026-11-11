'use strict';
/**
 * FIX-SUPPLY2 — the two doors FIX-SUPPLY left open beside its tap guards.
 *
 *  1. The TYPED reason that completes a Dispatch ❌ Reject (kind
 *     `manager_reject`) or a supplier's ❌ Decline (kind `dispatch_decline`)
 *     has no expiry. Typed after the request was decided, or after it moved
 *     past the stage the prompt was armed for, it used to stamp the request
 *     anyway (rejected_by_dispatch / admin_repick) and tell the requester.
 *     Now it writes nothing, tells nobody, clears the prompt and answers
 *     `Already <status> — nothing to do.`
 *  2. Two admins each get the supplier picker; the second pick used to
 *     re-assign a request the first pick had already assigned. Now it changes
 *     nothing and answers `Already assigned to <name>`.
 *  3. The Dispatch confirmer's own card quotes the short R-XXXX reference and
 *     says `waiting for admin approval` (one admin approves a supply).
 *
 * The normal paths — a reason typed at the right stage, the first pick, a
 * re-pick after a decline, ✎ Assign someone else before approval — are
 * pinned unchanged.
 */
process.env.ADMIN_IDS = '777,778';
process.env.EMPLOYEE_IDS = '4242,4343,4444';
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

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
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
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
const textsTo = (bot, id) => toChat(bot, id).map((c) => c.args.text);
const sends = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText', 'sendPhoto', 'sendDocument'].includes(c.method));
const wipes = (bot) => bot.calls.filter((c) => c.method === 'editMessageReplyMarkup').map((c) => c.args.replyMarkup);
const msg = (text, uid) => ({ from: { id: uid }, chat: { id: uid }, text });
const short = (id) => `R-${String(id).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4)}`;
const promptsOf = (uid) => (approvalEvents._internals.pendingReason.get(String(uid)) || []);

let writes = 0;
function armQueue() {
  const rows = new Map();
  writes = 0;
  approvalEvents._internals.pendingReason.clear();
  approvalQueueRepository.append = async (rec) => { rows.set(rec.requestId, { ...rec, status: 'pending' }); return rec; };
  approvalQueueRepository.getByRequestId = async (id) => (rows.has(id) ? JSON.parse(JSON.stringify(rows.get(id))) : null);
  approvalQueueRepository.getAllPending = async () => [...rows.values()].filter((r) => r.status === 'pending').map((r) => JSON.parse(JSON.stringify(r)));
  approvalQueueRepository.updateStatus = async (id, status) => { writes += 1; rows.get(id).status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { writes += 1; const r = rows.get(id); r.actionJSON = { ...r.actionJSON, ...patch }; return true; };
  return rows;
}

/**
 * Raise one supply request from Ajeet at IDUMOTA; `supplier` null = "let admin
 * choose". A second request in one test needs another `quantity`: the gate
 * treats the same person's identical request within seconds as ONE (APG-1).
 */
async function raise(supplier = { user_id: MUSA, name: 'Musa' }, quantity = 11) {
  sessionStore.set(EMP, {
    type: 'supply_req_flow', warehouse: 'IDUMOTA', productType: 'fabric', step: 'confirm',
    cart: [{ ...cart[0], quantity }],
    customer: 'Ketu madam', salesperson: 'Office', flowMessageId: FLOW_MSG,
    supplier, paymentMode: 'Zenith', supplyDate: '2026-09-11',
  });
  await controller.handleCallbackQuery(createFakeBot(), cb('srf_conf:yes', EMP, FLOW_MSG));
  const pending = await approvalQueueRepository.getAllPending();
  return pending[pending.length - 1].requestId;
}

/** The stale typed reason: one answer to the typist, nothing else, nothing written. */
function assertStaleReason(bot, typist, rows, requestId, before, word) {
  assert.deepEqual(textsTo(bot, typist), [`Already ${word} — nothing to do.`], 'the typist is answered in the tap guard\'s words');
  assert.equal(sends(bot).length, 1, 'nobody else is sent anything');
  assert.equal(toChat(bot, EMP).length, 0, 'the requester is told nothing');
  assert.equal(writes, 0, 'nothing is written');
  assert.equal(JSON.stringify(rows.get(requestId)), before, 'the row is untouched');
  assert.equal(promptsOf(typist).length, 0, 'the prompt is cleared');
}

/* ── 1. the typed reason of a Dispatch ❌ Reject ─────────────────────── */

test('Dispatch ❌ Reject reason typed after the request was confirmed, approved and accepted: nothing is stamped', async () => {
  const rows = armQueue();
  const requestId = await raise();

  // Bello taps ❌ Reject and types nothing.
  await controller.handleCallbackQuery(createFakeBot(), cb(`smc:r:${requestId}`, BELLO, 71));
  assert.equal(promptsOf(BELLO).length, 1, 'the reason prompt is armed');
  // Musa confirms, an admin approves (Musa is the named supplier), Musa accepts.
  await controller.handleCallbackQuery(createFakeBot(), cb(`smc:c:${requestId}`, MUSA, 70));
  await controller.handleCallbackQuery(createFakeBot(), cb(`approve:${requestId}`, ADMIN, 60));
  await controller.handleCallbackQuery(createFakeBot(), cb(`srf_acc:${requestId}`, MUSA, 80));
  assert.equal(rows.get(requestId).status, 'approved');
  assert.equal(rows.get(requestId).actionJSON.stage, 'completed');

  const before = JSON.stringify(rows.get(requestId));
  writes = 0;
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Not enough stock', BELLO));
  assertStaleReason(bot, BELLO, rows, requestId, before, 'approved');
  assert.equal(rows.get(requestId).status, 'approved', 'the accepted request stays approved');
  assert.ok(!rows.get(requestId).actionJSON.dispatchRejection, 'no rejection is recorded');
});

test('Dispatch ❌ Reject reason typed after an admin rejected the request: answered, no second rejection notice', async () => {
  const rows = armQueue();
  const requestId = await raise();
  await controller.handleCallbackQuery(createFakeBot(), cb(`smc:r:${requestId}`, BELLO, 71));
  await controller.handleCallbackQuery(createFakeBot(), cb(`reject:${requestId}`, ADMIN, 60));
  assert.equal(rows.get(requestId).status, 'rejected');
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_review', 'a rejection leaves the stage where it was');

  const before = JSON.stringify(rows.get(requestId));
  writes = 0;
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Not enough stock', BELLO));
  assertStaleReason(bot, BELLO, rows, requestId, before, 'rejected');
});

test('Dispatch ❌ Reject reason typed while still pending but past the Dispatch stage: confirmed, then approved', async () => {
  const rows = armQueue();
  const requestId = await raise();
  await controller.handleCallbackQuery(createFakeBot(), cb(`smc:r:${requestId}`, BELLO, 71));
  // Musa confirms: still pending, now with the admin.
  await controller.handleCallbackQuery(createFakeBot(), cb(`smc:c:${requestId}`, MUSA, 70));
  assert.equal(rows.get(requestId).status, 'pending');
  assert.equal(rows.get(requestId).actionJSON.stage, 'admin_review');

  let before = JSON.stringify(rows.get(requestId));
  writes = 0;
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Not enough stock', BELLO));
  assertStaleReason(bot, BELLO, rows, requestId, before, 'confirmed');

  // The admin approves: pending until the supplier accepts, and just as dead
  // for a Dispatch reason that was still owed.
  await controller.handleCallbackQuery(createFakeBot(), cb(`approve:${requestId}`, ADMIN, 60));
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_acceptance');
  approvalEvents._internals.armReasonPrompt(BELLO, { kind: 'manager_reject', requestId, chatId: BELLO });
  before = JSON.stringify(rows.get(requestId));
  writes = 0;
  const bot2 = createFakeBot();
  await controller.handleMessage(bot2, msg('Not enough stock', BELLO));
  assertStaleReason(bot2, BELLO, rows, requestId, before, 'approved');
});

test('a stale reason still hands over to the next reason the person owes', async () => {
  const rows = armQueue();
  const older = await raise();
  const newer = await raise(undefined, 7);
  assert.notEqual(older, newer, 'two separate requests');
  await controller.handleCallbackQuery(createFakeBot(), cb(`smc:r:${older}`, BELLO, 71));
  await controller.handleCallbackQuery(createFakeBot(), cb(`smc:r:${newer}`, BELLO, 72));
  // The newer one is rejected by an admin before Bello types anything.
  await controller.handleCallbackQuery(createFakeBot(), cb(`reject:${newer}`, ADMIN, 60));

  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Not enough stock', BELLO));
  const told = textsTo(bot, BELLO);
  assert.equal(told[0], 'Already rejected — nothing to do.');
  assert.match(told[1], new RegExp(`Reject supply request.*${older}`, 's'), 'the older request\'s reason is asked next');
  assert.equal(promptsOf(BELLO).length, 1);

  // ...and that one, still pending at the Dispatch stage, is finalized as before.
  const bot2 = createFakeBot();
  await controller.handleMessage(bot2, msg('Wrong store', BELLO));
  assert.equal(rows.get(older).status, 'rejected');
  assert.equal(rows.get(older).actionJSON.stage, 'rejected_by_dispatch');
  assert.equal(rows.get(older).actionJSON.dispatchRejection.reason, 'Wrong store');
  assert.equal(toChat(bot2, EMP).length, 1, 'the requester is told once');
  assert.match(toChat(bot2, EMP)[0].args.text, new RegExp(`^❌ Dispatch rejected your supply request ${short(older)}\\.`));
});

/* ── 1. the typed reason of a supplier's ❌ Decline ──────────────────── */

test('supplier ❌ Decline reason typed after an admin rejected the request: no re-pick, no notices', async () => {
  const rows = armQueue();
  const requestId = await raise();
  await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review' });
  await controller.handleCallbackQuery(createFakeBot(), cb(`approve:${requestId}`, ADMIN, 60));
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_acceptance');

  await controller.handleCallbackQuery(createFakeBot(), cb(`srf_dec:${requestId}`, MUSA, 80));
  assert.equal(promptsOf(MUSA).length, 1, 'the reason prompt is armed');
  await controller.handleCallbackQuery(createFakeBot(), cb(`reject:${requestId}`, ADMIN2, 61));
  assert.equal(rows.get(requestId).status, 'rejected');

  const before = JSON.stringify(rows.get(requestId));
  writes = 0;
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Out today', MUSA));
  assertStaleReason(bot, MUSA, rows, requestId, before, 'rejected');
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_acceptance', 'not bounced to admin_repick');
  assert.ok(!rows.get(requestId).actionJSON.dispatchDecline, 'no decline is recorded');
  assert.equal(toChat(bot, ADMIN).length + toChat(bot, ADMIN2).length, 0, 'no admin is asked to reassign');
  assert.ok(!bot.allText().includes('Assign to a warehouse boy'), 'no picker');
});

test('supplier ❌ Decline reason typed after the same request was accepted: it stays accepted', async () => {
  const rows = armQueue();
  const requestId = await raise();
  await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review' });
  await controller.handleCallbackQuery(createFakeBot(), cb(`approve:${requestId}`, ADMIN, 60));
  await controller.handleCallbackQuery(createFakeBot(), cb(`srf_dec:${requestId}`, MUSA, 80));
  // A second copy of the Accept card (another device) is tapped ✅ Accept.
  await controller.handleCallbackQuery(createFakeBot(), cb(`srf_acc:${requestId}`, MUSA, 81));
  assert.equal(rows.get(requestId).status, 'approved');

  const before = JSON.stringify(rows.get(requestId));
  writes = 0;
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Out today', MUSA));
  assertStaleReason(bot, MUSA, rows, requestId, before, 'approved');
  assert.equal(rows.get(requestId).actionJSON.stage, 'completed');
});

test('supplier ❌ Decline reason typed at the Accept stage is recorded as before', async () => {
  const rows = armQueue();
  const requestId = await raise();
  await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review' });
  await controller.handleCallbackQuery(createFakeBot(), cb(`approve:${requestId}`, ADMIN, 60));
  await controller.handleCallbackQuery(createFakeBot(), cb(`srf_dec:${requestId}`, MUSA, 80));
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Out today', MUSA));
  assert.equal(rows.get(requestId).status, 'pending');
  assert.equal(rows.get(requestId).actionJSON.stage, 'admin_repick');
  assert.equal(rows.get(requestId).actionJSON.dispatchDecline.reason, 'Out today');
  assert.match(textsTo(bot, MUSA)[0], /^❌ Declined\. Admin will be asked to assign someone else\./);
  assert.equal(toChat(bot, EMP).length, 1, 'the requester is told');
  assert.ok(textsTo(bot, ADMIN).some((t) => /Assign to a warehouse boy/.test(t)), 'the approving admin gets the picker again');
});

/* ── 2. the supplier picker ──────────────────────────────────────────── */

test('two admins hold the picker: the second pick changes nothing and names who has it', async () => {
  const rows = armQueue();
  const requestId = await raise(null);
  await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review' });
  // Both admins tap ✅ Approve before either picks: both get the picker.
  for (const [admin, m] of [[ADMIN, 60], [ADMIN2, 61]]) {
    const b = createFakeBot();
    await controller.handleCallbackQuery(b, cb(`approve:${requestId}`, admin, m));
    assert.match(b.allText(), /Assign to a warehouse boy/, `admin ${admin} got the picker`);
  }
  // The first picks Musa.
  const first = createFakeBot();
  await controller.handleCallbackQuery(first, cb(`srf_assign:${requestId}|${MUSA}`, ADMIN, 90));
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_acceptance');
  assert.equal(rows.get(requestId).actionJSON.assignedDispatch.user_id, MUSA);
  assert.equal(toChat(first, MUSA).length, 1, 'Musa got the Accept card');
  assert.equal(toChat(first, EMP).length, 1, 'the requester is told once');

  // The second picks Bello.
  const before = JSON.stringify(rows.get(requestId));
  writes = 0;
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`srf_assign:${requestId}|${BELLO}`, ADMIN2, 91));
  assert.equal(writes, 0, 'nothing is written');
  assert.equal(JSON.stringify(rows.get(requestId)), before, 'Musa keeps the assignment');
  assert.equal(toChat(bot, BELLO).length, 0, 'Bello gets no Accept card');
  assert.equal(toChat(bot, MUSA).length, 0, 'Musa is not disturbed');
  assert.equal(toChat(bot, EMP).length, 0, 'no second "approved and assigned" notice');
  assert.deepEqual(textsTo(bot, ADMIN2),
    ['ℹ️ Already assigned to Musa — this picker card is stale, no assignment was made.']);
  assert.equal(sends(bot).length, 1, 'only the tapping admin is told');
  assert.deepEqual(wipes(bot), [{ inline_keyboard: [] }], 'the stale picker loses its buttons');

  // Musa's Accept card is still alive.
  await controller.handleCallbackQuery(createFakeBot(), cb(`srf_acc:${requestId}`, MUSA, 80));
  assert.equal(rows.get(requestId).status, 'approved');
});

test('the first pick and a re-pick after the supplier declined work as before', async () => {
  const rows = armQueue();
  const requestId = await raise(null);
  await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review' });
  await controller.handleCallbackQuery(createFakeBot(), cb(`approve:${requestId}`, ADMIN, 60));
  const first = createFakeBot();
  await controller.handleCallbackQuery(first, cb(`srf_assign:${requestId}|${MUSA}`, ADMIN, 90));
  assert.equal(rows.get(requestId).actionJSON.assignedDispatch.user_id, MUSA);
  assert.match(first.allText(), /assigned to \*Musa\*/);

  // Musa declines with a reason: back with the admin (admin_repick), picker re-sent.
  await controller.handleCallbackQuery(createFakeBot(), cb(`srf_dec:${requestId}`, MUSA, 80));
  const dbot = createFakeBot();
  await controller.handleMessage(dbot, msg('Out today', MUSA));
  assert.equal(rows.get(requestId).actionJSON.stage, 'admin_repick');
  assert.ok(dbot.calls.some((c) => c.method === 'sendMessage' && String(c.args.chatId) === ADMIN
    && c.args.opts && c.args.opts.reply_markup
    && c.args.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === `srf_assign:${requestId}|${BELLO}`)),
  'the admin is offered Bello on the new picker');

  const again = createFakeBot();
  await controller.handleCallbackQuery(again, cb(`srf_assign:${requestId}|${BELLO}`, ADMIN, 92));
  const aj = rows.get(requestId).actionJSON;
  assert.equal(aj.stage, 'dispatch_acceptance');
  assert.equal(aj.assignedDispatch.user_id, BELLO);
  assert.ok(toChat(again, BELLO).some((c) => /New supply assignment/.test(c.args.text)), 'Bello got the Accept card');
  assert.equal(toChat(again, EMP).length, 1);
  assert.equal(toChat(again, EMP)[0].args.text,
    `✅ Your supply request ${short(requestId)} was approved and assigned to Bello.\n\n⏳ Waiting for Bello to Accept the dispatch.`);
});

test('a picker opened by ✅ Approve BEFORE Dispatch confirmed still assigns (STS-1 R2 is the owner\'s)', async () => {
  const rows = armQueue();
  const requestId = await raise(null);
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_review');
  const abot = createFakeBot();
  await controller.handleCallbackQuery(abot, cb(`approve:${requestId}`, ADMIN, 60));
  assert.match(abot.allText(), /Assign to a warehouse boy/);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`srf_assign:${requestId}|${MUSA}`, ADMIN, 90));
  assert.equal(rows.get(requestId).actionJSON.stage, 'dispatch_acceptance');
  assert.equal(rows.get(requestId).actionJSON.assignedDispatch.user_id, MUSA);
});

test('✎ Assign someone else (before approval) keeps working', async () => {
  const rows = armQueue();
  const requestId = await raise();
  await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review' });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`srf_rea:${requestId}`, ADMIN, 61));
  assert.match(bot.allText(), /Who should supply R-[0-9A-Z]{4} instead of \*Musa\*\?/);
  await controller.handleCallbackQuery(bot, cb(`srf_reas:${requestId}|${BELLO}`, ADMIN, 62));
  assert.equal(rows.get(requestId).actionJSON.requestedAssignee.user_id, BELLO);
  await controller.handleCallbackQuery(createFakeBot(), cb(`approve:${requestId}`, ADMIN, 63));
  assert.equal(rows.get(requestId).actionJSON.assignedDispatch.user_id, BELLO);
});

/* ── 3. the Dispatch confirmer's own card ────────────────────────────── */

test('the confirmer\'s card quotes R-XXXX and says "waiting for admin approval"', async () => {
  armQueue();
  const requestId = await raise();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`smc:c:${requestId}`, MUSA, 70));
  const card = bot.calls.find((c) => c.method === 'editMessageText' && c.args.opts && c.args.opts.message_id === 70);
  assert.ok(card, 'the tapped card is rewritten');
  assert.equal(card.args.text, `✅ Confirmed.\n\nRequest ${short(requestId)} is now waiting for admin approval.`);
  assert.ok(!card.args.text.includes(requestId), 'the long id is gone');
});
