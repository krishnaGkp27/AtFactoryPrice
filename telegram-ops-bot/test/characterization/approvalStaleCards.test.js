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
