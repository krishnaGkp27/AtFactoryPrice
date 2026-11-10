'use strict';
/**
 * APG-1 — the approval gate, the registry behind it and the duplicate
 * detector's registry awareness. No sheet, no network: the queue is an
 * in-memory array.
 *
 * Pinned, in the order the risks bite:
 *  - a payment to the same account for the same amount is REFUSED while one
 *    is open, whoever raised it, and a refused request writes NOTHING
 *    (the door's own record is prepared only after the check passes);
 *  - an admin's force raises it marked ⧉ (twinOf, sentAnywayBy);
 *  - one request id is one row — a retry never runs `prepare` twice;
 *  - a type with no declared rule is never refused (flag is the default);
 *  - the valve APPROVAL_TWIN_GUARD = 0 stops the refusal;
 *  - 🔔 Remind approvers: only the requester (or an admin), only while
 *    pending, once per REQUEST_NUDGE_HOURS, only to admins who have not
 *    signed;
 *  - ⧉ Reject as duplicate stamps the reason and hands over to the ordinary
 *    reject path, and declines when the twin is gone.
 */
process.env.ADMIN_IDS = '777,888,999';
process.env.EMPLOYEE_IDS = '555,556';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const registry = require(path.join(SRC, 'services/approvalRegistry'));
const gate = require(path.join(SRC, 'services/approvalGate'));
const { findDuplicateGroups } = require(path.join(SRC, 'utils/duplicateApprovals'));
const { createFakeBot } = require('../../helpers/fakeBot');

let QUEUE = [];
let AUDIT = [];
let SETTINGS = {};
let NOTIFIED = [];
let REJECTED = [];
approvalQueueRepository.getAllPending = async () => QUEUE.filter((q) => q.status === 'pending');
approvalQueueRepository.getByRequestId = async (id) => QUEUE.find((q) => String(q.requestId) === String(id)) || null;
approvalQueueRepository.appendOnce = async (rec) => {
  if (QUEUE.some((q) => q.requestId === rec.requestId)) return { created: false, existing: QUEUE.find((q) => q.requestId === rec.requestId) };
  QUEUE.push({ createdAt: new Date().toISOString(), ...rec });
  return { created: true, existing: null };
};
approvalQueueRepository.updateActionJSON = async (id, patch) => {
  const row = QUEUE.find((q) => q.requestId === id);
  if (row) row.actionJSON = { ...row.actionJSON, ...patch };
  return true;
};
auditLogRepository.append = async (kind, meta, by) => { AUDIT.push({ kind, meta, by }); };
settingsRepository.getAll = async () => SETTINGS;
const NAMES = { 555: 'Muhammad', 556: 'Abdul', 777: 'Musa', 888: 'Krishna', 999: 'John' };
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);
approvalEvents.notifyAdminsApprovalRequest = async (...a) => { NOTIFIED.push(a); return { sent: 1, failed: 0 }; };
approvalEvents.handleApprovalCallback = async (bot, cq, action) => { REJECTED.push({ data: cq.data, action }); };

const PAY = { payee_name: 'Muhammad', payee_type: 'employee', amount_ngn: 70000, account_number: '7044196792', bank: 'OPAY', reason: 'Salary' };
function reset() { QUEUE = []; AUDIT = []; SETTINGS = {}; NOTIFIED = []; REJECTED = []; gate._internals.twinSources.clear(); }
const cq = (from, data) => ({ id: 'q1', data, from: { id: Number(from) }, message: { chat: { id: Number(from) }, message_id: 9 } });

test('registry: an unknown type gets the safe default; payments declare account + amount, any requester, while open', () => {
  const d = registry.entryFor('some_new_action');
  assert.deepEqual(d.twin, { key: null, policy: 'flag', scope: 'window', anyRequester: false });
  assert.equal(d.nudge, true);
  const p = registry.entryFor('request_payment');
  assert.equal(p.twin.policy, 'refuse');
  assert.equal(p.twin.scope, 'open');
  assert.equal(p.twin.anyRequester, true);
  assert.equal(registry.twinKeyOf({ action: 'request_payment', ...PAY }), 'acct:7044196792|opay|amt:70000');
  assert.equal(registry.twinKeyOf({ action: 'request_payment', ...PAY, account_number: '704-419 6792', bank: ' Opay ' }), 'acct:7044196792|opay|amt:70000', 'formatting never splits one account');
  assert.equal(registry.twinKeyOf({ action: 'request_payment', payee_name: 'x' }), null, 'a thin payload declares nothing');
  assert.equal(registry.twinKeyOf({ action: 'sale_bundle', items: [] }), null);
  assert.equal(registry.describe({ action: 'request_payment', ...PAY, reason: 'Salary · Nov-2026' }), '💳 Payment request · ₦70,000 → Muhammad · Salary · Nov-2026');
  assert.equal(registry.describe({ action: 'request_payment', payment_id: 'PAY-1' }), '💳 Payment request');
});

test('detector: two payment requests with their own payment ids ARE twins now — any requester, any gap; a different amount is not', () => {
  const row = (id, user, at, extra = {}) => ({ requestId: id, user, createdAt: at, actionJSON: { action: 'request_payment', payment_id: `PAY-${id}`, ...PAY, ...extra } });
  const groups = findDuplicateGroups([
    row('a', '555', '2026-11-10T09:04:00Z'), row('b', '555', '2026-11-10T09:04:02Z'),
    row('c', '777', '2026-11-14T12:00:00Z'), row('d', '555', '2026-11-10T09:04:00Z', { amount_ngn: 50000 }),
  ]);
  assert.deepEqual(groups.map((g) => g.map((r) => r.requestId)), [['a', 'b', 'c']]);
  // a type with no declared key keeps the window: a repeat hours later stands alone
  const sale = (id, at) => ({ requestId: id, user: '555', createdAt: at, actionJSON: { action: 'sale_bundle', items: [{ packageNo: '1' }] } });
  assert.deepEqual(findDuplicateGroups([sale('x', '2026-11-10T09:00:00Z'), sale('y', '2026-11-10T09:05:00Z'), sale('z', '2026-11-10T13:00:00Z')])
    .map((g) => g.map((r) => r.requestId)), [['x', 'y']]);
  // the signature trail and the reminders never break a match
  const s2 = { ...sale('y2', '2026-11-10T09:03:00Z') };
  s2.actionJSON = { ...s2.actionJSON, signoffs: [{ id: '777' }], nudges: [{ by: '555' }], approvals: ['777'] };
  assert.equal(findDuplicateGroups([sale('x', '2026-11-10T09:00:00Z'), s2]).length, 1);
});

test('raise: the first payment is queued once, with its audit line and the door\'s record', async () => {
  reset();
  let prepared = 0;
  const r = await gate.raise({
    userId: '555', action: 'request_payment', payload: PAY, requestId: 'REQ-1', riskReason: 'dual_admin_required',
    auditMeta: (aj) => ({ payment_id: aj.payment_id }),
    prepare: async () => { prepared += 1; return { payment_id: 'PAY-1' }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(prepared, 1);
  assert.equal(QUEUE.length, 1);
  assert.equal(QUEUE[0].actionJSON.action, 'request_payment');
  assert.equal(QUEUE[0].actionJSON.payment_id, 'PAY-1');
  assert.equal(QUEUE[0].user, '555');
  assert.deepEqual(AUDIT, [{ kind: 'approval_queued', meta: { requestId: 'REQ-1', action: 'request_payment', payment_id: 'PAY-1' }, by: '555' }]);
  // the same confirm again (same id) is that request — nothing runs twice
  const again = await gate.raise({ userId: '555', action: 'request_payment', payload: PAY, requestId: 'REQ-1', prepare: async () => { prepared += 1; return {}; } });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(prepared, 1, 'prepare is never run for a request that is already queued');
  assert.equal(QUEUE.length, 1);
});

test('raise: the same account + amount is REFUSED while one is open — by anyone — and writes nothing', async () => {
  reset();
  await gate.raise({ userId: '555', action: 'request_payment', payload: PAY, requestId: 'REQ-1' });
  let prepared = 0;
  const twin = await gate.raise({ userId: '556', action: 'request_payment', payload: { ...PAY, reason: 'salary again' }, requestId: 'REQ-2', prepare: async () => { prepared += 1; return {}; } });
  assert.equal(twin.ok, false);
  assert.equal(twin.refused, 'twin');
  assert.equal(twin.twin.requestId, 'REQ-1');
  assert.equal(twin.twin.raisedBy, '555');
  assert.equal(twin.twin.state, 'pending');
  assert.equal(prepared, 0, 'a refused request never reaches the door\'s own record');
  assert.equal(QUEUE.length, 1);
  assert.equal(AUDIT.length, 1);
  // a different amount to the same account is a different request
  const other = await gate.raise({ userId: '555', action: 'request_payment', payload: { ...PAY, amount_ngn: 20000 }, requestId: 'REQ-3' });
  assert.equal(other.ok, true);
  assert.equal(QUEUE.length, 2);
  // once the first is decided the twin is gone
  QUEUE[0].status = 'approved';
  const later = await gate.raise({ userId: '555', action: 'request_payment', payload: PAY, requestId: 'REQ-4' });
  assert.equal(later.ok, true, 'the queue only refuses against PENDING rows; the door\'s own source covers approved-unpaid');
});

test('raise: an admin may send a refused twin anyway — marked ⧉ on the row and in the audit', async () => {
  reset();
  await gate.raise({ userId: '555', action: 'request_payment', payload: PAY, requestId: 'REQ-1' });
  const forced = await gate.raise({ userId: '777', action: 'request_payment', payload: PAY, requestId: 'REQ-2', force: true, forcedBy: '777' });
  assert.equal(forced.ok, true);
  assert.equal(forced.actionJSON.twinOf, 'REQ-1');
  assert.equal(forced.actionJSON.sentAnywayBy, '777');
  assert.equal(AUDIT[1].meta.twinOf, 'REQ-1');
});

test('raise: a type\'s own twin source sees what the queue cannot (approved, not yet paid)', async () => {
  reset();
  gate.registerTwinSource('request_payment', async ({ payload }) => (payload.amount_ngn === 70000
    ? { requestId: 'REQ-OLD', raisedBy: '555', createdAt: '2026-11-01T08:00:00Z', state: 'approved', aj: { action: 'request_payment', ...PAY } } : null));
  const r = await gate.raise({ userId: '555', action: 'request_payment', payload: PAY, requestId: 'REQ-9' });
  assert.equal(r.ok, false);
  assert.equal(r.twin.state, 'approved');
  assert.equal(r.twin.requestId, 'REQ-OLD');
  assert.equal(QUEUE.length, 0);
});

test('raise: an undeclared type is never refused, and the valve switches the refusal off', async () => {
  reset();
  const a = await gate.raise({ userId: '555', action: 'edit_bale', payload: { packageNo: '6061' }, requestId: 'E-1' });
  const b = await gate.raise({ userId: '555', action: 'edit_bale', payload: { packageNo: '6061' }, requestId: 'E-2' });
  assert.equal(a.ok && b.ok, true, 'flag is the default: both queue, the admin card warns');
  assert.equal(QUEUE.length, 2);
  await gate.raise({ userId: '555', action: 'request_payment', payload: PAY, requestId: 'REQ-1' });
  SETTINGS = { APPROVAL_TWIN_GUARD: 0 };
  const open = await gate.raise({ userId: '555', action: 'request_payment', payload: PAY, requestId: 'REQ-2' });
  assert.equal(open.ok, true, 'APPROVAL_TWIN_GUARD = 0 → nothing is refused');
});

test('🔔 Remind approvers: the same card to the admins who have NOT signed, once per window, by the requester only', async () => {
  reset();
  await gate.raise({ userId: '555', action: 'request_payment', payload: PAY, requestId: 'REQ-1', riskReason: 'dual_admin_required' });
  QUEUE[0].createdAt = '2026-11-09T08:00:00.000Z';
  QUEUE[0].actionJSON.approvals = ['777'];
  const bot = createFakeBot();
  const t0 = Date.parse('2026-11-10T09:00:00Z');

  assert.equal((await gate.nudge({ bot, requestId: 'REQ-1', byUserId: '556', now: t0 })).reason, 'not_yours');
  const r = await gate.nudge({ bot, requestId: 'REQ-1', byUserId: '555', now: t0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reminded, ['Krishna', 'John'], 'Musa already signed');
  assert.equal(r.count, 1);
  assert.equal(NOTIFIED.length, 1);
  const [, id, label, , , excludeId, opts] = NOTIFIED[0];
  assert.equal(id, 'REQ-1');
  assert.equal(label, 'Muhammad');
  assert.equal(excludeId, undefined);
  assert.deepEqual(opts.excludeIds, ['777']);
  assert.match(opts.prependNote, /^🔔 Muhammad asks for a decision · waiting 1d · reminder 1$/);
  assert.equal(QUEUE[0].actionJSON.nudges.length, 1);
  assert.equal(QUEUE.length, 1, 'a reminder raises nothing');

  const soon = await gate.nudge({ bot, requestId: 'REQ-1', byUserId: '555', now: t0 + 3 * 3600e3 });
  assert.equal(soon.ok, false);
  assert.equal(soon.reason, 'too_soon');
  assert.equal(soon.waitHours, 21);
  assert.equal(gate._internals.nudgeToast(soon), 'Already reminded 3h ago. You can remind again in 21h.');
  const nextDay = await gate.nudge({ bot, requestId: 'REQ-1', byUserId: '555', now: t0 + 24 * 3600e3 });
  assert.equal(nextDay.ok, true);
  assert.equal(nextDay.count, 2);
  assert.match(NOTIFIED[1][6].prependNote, /reminder 2$/);

  SETTINGS = { REQUEST_NUDGE_HOURS: 0 };
  assert.equal((await gate.nudge({ bot, requestId: 'REQ-1', byUserId: '555', now: t0 + 72 * 3600e3 })).reason, 'off');
  SETTINGS = {};
  QUEUE[0].actionJSON.approvals = ['777', '888', '999'];
  assert.equal((await gate.nudge({ bot, requestId: 'REQ-1', byUserId: '555', now: t0 + 72 * 3600e3 })).reason, 'nobody');
  QUEUE[0].status = 'approved';
  assert.equal((await gate.nudge({ bot, requestId: 'REQ-1', byUserId: '555', now: t0 + 72 * 3600e3 })).reason, 'resolved');
  assert.equal((await gate.nudge({ bot, requestId: 'NOPE', byUserId: '555' })).reason, 'not_found');
});

test('🔔 the chip: a toast either way, and one line in the chat when it went out', async () => {
  reset();
  await gate.raise({ userId: '555', action: 'request_payment', payload: PAY, requestId: 'REQ-1' });
  const bot = createFakeBot();
  assert.equal(await gate.handleCallback(bot, cq('555', 'apg:nudge:REQ-1')), true);
  const toast = bot.calls.find((c) => c.method === 'answerCallbackQuery');
  assert.equal(toast.args.opts.text, '🔔 Reminder sent to Musa, Krishna and John.');
  const line = bot.calls.find((c) => c.method === 'sendMessage');
  assert.match(line.args.text, /^🔔 Reminder 1 sent to Musa, Krishna and John for R-REQ1\.\nYou can remind again in 24h\.$/);
  const bot2 = createFakeBot();
  await gate.handleCallback(bot2, cq('555', 'apg:nudge:REQ-1'));
  const t2 = bot2.calls.find((c) => c.method === 'answerCallbackQuery');
  assert.match(t2.args.opts.text, /^Already reminded less than an hour ago\. You can remind again in 24h\.$/);
  assert.equal(t2.args.opts.show_alert, true);
  assert.equal(bot2.calls.filter((c) => c.method === 'sendMessage').length, 0);
});

test('📋 Status: the requester (or an admin) sees where it stands; a stranger does not', async () => {
  reset();
  await gate.raise({ userId: '555', action: 'request_payment', payload: { ...PAY, reason: 'Salary · Nov-2026' }, requestId: 'REQ-1' });
  QUEUE[0].actionJSON.signoffs = [{ id: '777', name: 'Musa', at: '2026-11-10T09:20:00Z' }];
  QUEUE[0].actionJSON.approvals = ['777'];
  const bot = createFakeBot();
  await gate.handleCallback(bot, cq('555', 'apg:st:REQ-1'));
  const card = bot.calls.find((c) => c.method === 'sendMessage');
  assert.match(card.args.text, /^📋 Request R-REQ1\n💳 Payment request · ₦70,000 → Muhammad · Salary · Nov-2026\nRaised by Muhammad · /);
  assert.match(card.args.text, /\n🛂 Waiting on approval · 1 of 2 signed\n✅ Musa · 10-Nov 10:20$/);
  const kb = card.args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === 'apg:nudge:REQ-1'), 'the requester can remind from here');
  const stranger = createFakeBot();
  await gate.handleCallback(stranger, cq('556', 'apg:st:REQ-1'));
  assert.equal(stranger.calls.find((c) => c.method === 'sendMessage').args.text, 'That request was not found.');
});

test('⧉ Reject as duplicate: stamps which request stays open and hands over to the ordinary reject; declines when the twin is gone', async () => {
  reset();
  await gate.raise({ userId: '555', action: 'request_payment', payload: PAY, requestId: 'REQ-1' });
  QUEUE[0].createdAt = '2026-11-10T09:04:00.000Z';
  QUEUE.push({ requestId: 'REQ-2', user: '555', status: 'pending', createdAt: '2026-11-10T09:04:02.000Z', actionJSON: { action: 'request_payment', payment_id: 'PAY-2', ...PAY } });
  const bot = createFakeBot();
  await gate.handleCallback(bot, cq('555', 'apg:dup:REQ-2'));
  assert.equal(REJECTED.length, 0, 'not an admin');
  await gate.handleCallback(bot, cq('888', 'apg:dup:REQ-2'));
  assert.deepEqual(REJECTED, [{ data: 'reject:REQ-2', action: 'reject' }]);
  assert.equal(QUEUE[1].actionJSON.rejectNote, 'Duplicate of R-REQ1, which is still open');
  // the twin was decided meanwhile → this one is no longer a duplicate
  REJECTED = [];
  QUEUE[0].status = 'rejected';
  const bot2 = createFakeBot();
  await gate.handleCallback(bot2, cq('888', 'apg:dup:REQ-2'));
  assert.equal(REJECTED.length, 0);
  assert.match(bot2.calls.find((c) => c.method === 'answerCallbackQuery').args.opts.text, /no longer open/);
});

test('twin card: names the open request, who raised it, where it stands, and that nothing new was raised', () => {
  const text = gate.twinCardText({ requestId: 'REQ-1', raisedBy: '555', createdAt: '2026-11-09T15:20:00Z', state: 'pending', signed: 1, aj: { action: 'request_payment', ...PAY } },
    { raisedByName: 'Muhammad', required: 2 });
  assert.equal(text, [
    '⏳ This request is already open',
    '💳 Payment request · ₦70,000 → Muhammad · Salary',
    'Raised by Muhammad · 09-Nov 16:20',
    '🛂 Waiting on approval · 1 of 2 signed',
    '', 'Nothing new was raised.',
  ].join('\n'));
  assert.match(gate.twinCardText({ state: 'approved', aj: { action: 'request_payment', ...PAY } }), /🏦 Approved — waiting to be paid/);
  assert.match(gate.twinCardText({ state: 'done', aj: { action: 'request_payment', ...PAY } }, { heading: '💼 Salary for Nov-2026 is already on record' }), /^💼 Salary for Nov-2026 is already on record\n[\s\S]*✅ Already paid/);
});
