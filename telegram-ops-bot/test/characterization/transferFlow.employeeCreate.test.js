'use strict';

/**
 * TRF-8 (owner request, 23-Jul-2026) — a NON-ADMIN employee creates a
 * transfer request, end to end through the real controller:
 *
 *   employee taps act:transfer_stock → walks the wizard → Send
 *   → ApprovalQueue row appended (action transfer_stock, pending)
 *   → dispatcher gets the Accept & dispatch card (the approval gate)
 *   → EVERY admin gets the creation brief
 *   → the creator gets NO approve/accept/reject buttons of any kind —
 *     they cannot move their own stock.
 *
 * Approval governance is deliberately unchanged from the admin-created
 * path: order-only at send (no inventory touch), dispatcher photo gate,
 * receiver confirmation.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242,abdul,musa';

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
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
auditLogRepository.append = async () => {};
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
];

function invRow(pkg, wh = 'Lagos') {
  return { packageNo: pkg, design: '9006', shade: '3', warehouse: wh, status: 'available', productType: 'fabric', yards: 100, pricePerYard: 0 };
}
inventoryRepository.getAll = async () => [
  invRow('P1'), invRow('P2'), invRow('P3'),
  invRow('P9', 'Kano office'),
];

function armQueue() {
  const calls = { transitions: [], appended: null };
  let row = null;
  inventoryRepository.transitionBales = async (pkgs, from, to, wh) => { calls.transitions.push({ pkgs, from, to, wh }); return []; };
  approvalQueueRepository.append = async (rec) => { calls.appended = rec; row = { ...rec, status: 'pending' }; return rec; };
  approvalQueueRepository.getByRequestId = async () => (row ? JSON.parse(JSON.stringify(row)) : null);
  approvalQueueRepository.getAllPending = async () => (row && row.status === 'pending' ? [JSON.parse(JSON.stringify(row))] : []);
  approvalQueueRepository.updateStatus = async (id, status) => { row.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { row.actionJSON = { ...row.actionJSON, ...patch }; return true; };
  return calls;
}

/** All inline-keyboard callback_datas sent to `chatId` on this bot. */
function buttonsSentTo(bot, chatId) {
  return bot.callsTo('sendMessage')
    .concat(bot.callsTo('editMessageText'))
    .filter((m) => String(m.args.chatId ?? (m.args.opts && m.args.opts.chat_id) ?? '') === String(chatId))
    .flatMap((m) => ((m.args.opts && m.args.opts.reply_markup && m.args.opts.reply_markup.inline_keyboard) || []).flat())
    .map((b) => b.callback_data);
}

test('TRF-8: employee wizard → ApprovalQueue row, dispatcher card, admin briefs — creator has no approve buttons', async () => {
  const calls = armQueue();
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:transfer_stock', '4242')); // source
  assert.match(bot.allText(), /From which warehouse\?/, 'employee reaches the wizard');
  await controller.handleCallbackQuery(bot, cb('trf:wh:1', '4242'));           // ['Kano office','Lagos'] → Lagos
  await controller.handleCallbackQuery(bot, cb('trf:dg:0', '4242'));           // 9006
  await controller.handleCallbackQuery(bot, cb('trf:sh:0', '4242'));           // shade 3
  await controller.handleCallbackQuery(bot, cb('trf:qty:2', '4242'));          // 2 bales
  await controller.handleCallbackQuery(bot, cb('trf:dest:0', '4242'));         // Kano office → auto-picked people
  assert.match(bot.allText(), /Dispatcher: \*Abdul\*/);
  assert.match(bot.allText(), /Receiver: \*Musa\*/);
  await controller.handleCallbackQuery(bot, cb('trf:send', '4242'));

  // ApprovalQueue row: action transfer_stock, pending, creator recorded.
  assert.ok(calls.appended, 'queue row appended');
  const requestId = calls.appended.requestId;
  assert.match(requestId, /^TR-/);
  assert.equal(calls.appended.actionJSON.action, 'transfer_stock');
  assert.equal(calls.appended.status, 'pending');
  assert.equal(calls.appended.user, '4242', 'creator recorded on the row');
  assert.equal(calls.transitions.length, 0, 'order only — nothing moved at send');

  // Dispatcher (the approval gate) got the Accept/Decline card.
  const dispatcherBtns = buttonsSentTo(bot, 'abdul');
  assert.ok(dispatcherBtns.includes(`trf:acc:${requestId}`), 'dispatcher can accept');
  assert.ok(dispatcherBtns.includes(`trf:dec:${requestId}`), 'dispatcher can decline');

  // BOTH admins got the creation brief.
  for (const adminId of ['777', '888']) {
    const briefs = bot.callsTo('sendMessage').filter((m) => String(m.args.chatId) === adminId);
    assert.equal(briefs.length, 1, `admin ${adminId} briefed once`);
    assert.match(briefs[0].args.text, /requested ⏳ — awaiting dispatch/);
    assert.match(briefs[0].args.text, /Lagos → Kano office/);
  }

  // The creator got NO approve/accept/reject buttons of any kind.
  const creatorBtns = buttonsSentTo(bot, '4242');
  const forbidden = creatorBtns.filter((d) => /^(approve:|reject:|trf:acc:|trf:dec:|trf:rcv:|trf:rej:)/.test(String(d)));
  assert.deepEqual(forbidden, [], 'creator cannot approve/dispatch their own transfer');
  assert.match(bot.allText(), new RegExp(`Transfer ${requestId} sent`), 'creator got the waiting receipt');
  assert.match(bot.allText(), /Waiting for \*Abdul\* to dispatch/);

  // And the generic approval pipeline was NOT engaged anywhere.
  const allBtns = bot.calls
    .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method))
    .flatMap((c) => ((c.args.opts && c.args.opts.reply_markup && c.args.opts.reply_markup.inline_keyboard) || []).flat());
  assert.ok(!allBtns.some((b) => /^(approve:|reject:)/.test(String(b.callback_data))),
    'no generic approve:/reject: card for transfer_stock');
  sessionStore.clear('4242');
});

test('TRF-8: the creator cannot act on the dispatcher card of their own transfer', async () => {
  const calls = armQueue();
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:transfer_stock', '4242'));
  await controller.handleCallbackQuery(bot, cb('trf:wh:1', '4242'));
  await controller.handleCallbackQuery(bot, cb('trf:dg:0', '4242'));
  await controller.handleCallbackQuery(bot, cb('trf:sh:0', '4242'));
  await controller.handleCallbackQuery(bot, cb('trf:qty:2', '4242'));
  await controller.handleCallbackQuery(bot, cb('trf:dest:0', '4242'));
  await controller.handleCallbackQuery(bot, cb('trf:send', '4242'));
  const requestId = calls.appended.requestId;

  // Creator forges a tap on the dispatcher's accept callback → refused.
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`trf:acc:${requestId}`, '4242'));
  assert.equal(calls.transitions.length, 0, 'nothing moved');
  const ack = bot2.callsTo('answerCallbackQuery')[0];
  assert.match(ack.args.opts.text, /assigned person only/i, 'self-dispatch refused');
  sessionStore.clear('4242');
});
