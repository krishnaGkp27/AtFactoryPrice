'use strict';

/**
 * APF-1 (owner report, 08-Aug-2026) — an approved request must be DEAD on
 * every card, everywhere. The R-9CEB screenshot: a sale executed days ago
 * still showed live ✅ Approve / ❌ Reject in the Approvals Inbox.
 *
 * Pinned:
 *  - tap-time guard: approve:/reject: on a resolved row answers "already
 *    …", clears the tapped card's keyboard, runs NOTHING (no wizard);
 *  - the inbox card re-reads live status and renders a record, not a
 *    decision, when the row resolved after the list snapshot;
 *  - apz:done closes an executed-but-unresolved row without re-execution;
 *  - the sale card warns loudly when nothing in the request is available.
 */

process.env.ADMIN_IDS = '777,778';
process.env.EMPLOYEE_IDS = '888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const inboxFlow = require(path.join(SRC, 'flows/approvalsInboxFlow'));

const ADMIN = '777';

const ROW = {
  requestId: 'R-9CEB-FULL', user: '888', status: 'approved',
  createdAt: '2026-08-05T09:00:00.000Z', resolvedAt: '2026-08-05T10:00:00.000Z',
  actionJSON: { action: 'sale_bundle', customer: 'OKSON', salesDate: '2026-08-04', items: [{ packageNo: '516', type: 'package' }] },
};

approvalQueueRepository.getByRequestId = async (id) => (String(id) === ROW.requestId ? { ...ROW } : null);
approvalQueueRepository.getAllPending = async () => [];
approvalQueueRepository.getResolved = async () => [ROW];
auditLogRepository.append = async () => {};
inventoryRepository.getAll = async () => []; // bale 516: nothing available

function texts(bot) { return bot.callsTo('sendMessage').map((c) => String(c.args.text || '')); }
const cb = (data) => ({ data, id: 'q1', from: { id: ADMIN }, message: { message_id: 9, chat: { id: ADMIN } } });

test('tap-time guard: Approve on a resolved row runs nothing and says so', async () => {
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cb(`approve:${ROW.requestId}`), 'approve');
  const all = texts(bot).join('\n');
  assert.match(all, /already approved/i, `got: ${all}`);
  assert.ok(!/customer/i.test(all) || !/rate/i.test(all), 'no enrichment wizard started');
  const wipe = bot.callsTo('editMessageReplyMarkup');
  assert.ok(wipe.length >= 1, 'the stale card keyboard is cleared');
  assert.deepEqual(wipe[0].args.replyMarkup, { inline_keyboard: [] });
});

test('inbox card: a row resolved after the snapshot renders as a record, no buttons', async () => {
  const bot = createFakeBot();
  sessionStore.set(ADMIN, {
    type: inboxFlow.SESSION_TYPE, step: 'pick_item', flowMessageId: 9,
    category: 'sales', page: 0, _items: [{ ...ROW, status: 'pending' }], // stale snapshot
  });
  await inboxFlow.handleCallback(bot, cb('abx:i:0'));
  const calls = bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  const last = calls[calls.length - 1];
  assert.match(String(last.args.text), /Already approved/i);
  const kb = ((last.args.opts || {}).reply_markup || {}).inline_keyboard || [];
  const flat = kb.flat().map((b) => b.callback_data || '');
  assert.ok(!flat.some((d) => d.startsWith('abx:ok:') || d.startsWith('abx:no:')),
    `no Approve/Reject on a resolved row, got: ${flat}`);
  sessionStore.clear(ADMIN);
});

test('apz:done closes a pending zombie without touching stock or money', async () => {
  const pendingZombie = { ...ROW, requestId: 'R-ZOMBIE', status: 'pending', resolvedAt: '' };
  const statusWrites = [];
  approvalQueueRepository.getByRequestId = async (id) => (String(id) === 'R-ZOMBIE' ? { ...pendingZombie } : null);
  approvalQueueRepository.updateStatus = async (id, status) => { statusWrites.push({ id, status }); return true; };
  const bot = createFakeBot();
  const handled = await approvalEvents.handleMarkDone(bot, cb('apz:done:R-ZOMBIE'));
  assert.equal(handled, true);
  assert.deepEqual(statusWrites, [{ id: 'R-ZOMBIE', status: 'approved' }]);
  const edits = bot.callsTo('editMessageText').map((c) => String(c.args.text));
  assert.match(edits.join('\n'), /WITHOUT re-executing/);
});

test('the sale card screams when NOTHING in the request is available', async () => {
  const card = await approvalCards.buildSaleBundleCard(ROW.actionJSON);
  assert.match(card, /⚠️ no available stock/);
  assert.match(card, /NOTHING in this request is available/);
});

/* ── APF-2: stock-gone rows get the real choices, everywhere ── */

test('APF-2: Approve on a PENDING zombie skips the wizard and offers Mark-done / Reject', async () => {
  const zombie = {
    requestId: 'R-GONE', user: '888', status: 'pending',
    createdAt: '2026-08-05T09:00:00.000Z',
    actionJSON: { action: 'sale_bundle', customer: '', items: [{ packageNo: '516', type: 'package' }] },
  };
  approvalQueueRepository.getByRequestId = async (id) => (String(id) === 'R-GONE' ? { ...zombie } : null);
  inventoryRepository.getAll = async () => []; // 516 gone
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cb('approve:R-GONE'), 'approve');
  const msgs = bot.callsTo('sendMessage');
  const choice = msgs.find((m) => /already sold or gone/.test(String(m.args.text)));
  assert.ok(choice, `the choice card is sent, got: ${msgs.map((m) => m.args.text)}`);
  const kb = ((choice.args.opts || {}).reply_markup || {}).inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === 'apz:done:R-GONE'), 'Mark as done offered');
  assert.ok(kb.some((b) => b.callback_data === 'reject:R-GONE'), 'Reject offered');
  assert.ok(!msgs.some((m) => /customer/i.test(String(m.args.text)) && /step/i.test(String(m.args.text))),
    'no enrichment wizard step was sent');
});

test('APF-2: the inbox card for a pending zombie shows Mark-done instead of Approve; the chip shows ⚠️', async () => {
  const zombie = {
    requestId: 'R-GONE2', user: '888', status: 'pending',
    createdAt: '2026-08-05T09:00:00.000Z',
    actionJSON: { action: 'sale_bundle', customer: '', items: [{ packageNo: '516', type: 'package' }] },
  };
  approvalQueueRepository.getByRequestId = async (id) => (String(id) === 'R-GONE2' ? { ...zombie } : null);
  approvalQueueRepository.getAllPending = async () => [zombie];
  inventoryRepository.getAll = async () => [];
  const bot = createFakeBot();
  sessionStore.set(ADMIN, {
    type: inboxFlow.SESSION_TYPE, step: 'pick_category', flowMessageId: 9,
    category: '', page: 0, _items: [],
  });
  await inboxFlow.handleCallback(bot, cb('abx:cat:sales'));
  const listCall = bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').pop();
  const chip = (((listCall.args.opts || {}).reply_markup || {}).inline_keyboard || []).flat()
    .find((b) => (b.callback_data || '').startsWith('abx:i:'));
  assert.match(chip.text, /^⚠️ /, `the zombie chip carries ⚠️, not an age dot — got: ${chip.text}`);
  assert.match(String(listCall.args.text), /⚠️ stock already gone/, 'the legend explains the icon');

  await inboxFlow.handleCallback(bot, cb('abx:i:0'));
  const cardCall = bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').pop();
  const flat = (((cardCall.args.opts || {}).reply_markup || {}).inline_keyboard || []).flat();
  assert.ok(flat.some((b) => b.callback_data === 'apz:done:R-GONE2'), 'Mark as done on the card');
  assert.ok(!flat.some((b) => (b.callback_data || '').startsWith('abx:ok:')), 'plain Approve is GONE');
  assert.ok(flat.some((b) => (b.callback_data || '').startsWith('abx:no:')), 'Reject stays');
  sessionStore.clear(ADMIN);
});
