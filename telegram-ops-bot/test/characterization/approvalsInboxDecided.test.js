'use strict';

/**
 * DEC-1 — ✅❌ Decided: the record of what was already approved or rejected.
 *
 * Owner, 14-Sep-2026, after rejecting a sale and looking for it: "If it is
 * rejected can you show me the queue or the inboxes which holds the
 * rejected request?" It held none — the inbox lists pending rows only and
 * the web table the same, so a decision vanished from every screen the
 * moment it was made, even though its ApprovalQueue row is permanent.
 *
 * Pinned here: the group exists and is reachable, it carries BOTH verdicts
 * newest-decision-first, a transfer's "approved" is worded as RECEIVED (the
 * receiver flips that row, no admin approves it), the record names who
 * decided, and nothing in the group can be approved or rejected.
 */

process.env.ADMIN_IDS = '777';
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

loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const settingsRepo = require(path.join(SRC, 'repositories/settingsRepository'));
const flow = require(path.join(SRC, 'flows/approvalsInboxFlow'));

const ADMIN = '777';
const EMPLOYEE = '4242';
const NAMES = { 7430648262: 'Abdul', 8700676816: 'John' };
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const RESOLVED = [
  { requestId: 'REJ-SALE', user: '7430648262', status: 'rejected', createdAt: daysAgo(2), resolvedAt: daysAgo(0), approver: 'Krishna', actionJSON: { action: 'sale_bundle', customer: 'CJE', items: [] } },
  { requestId: 'OK-CONTACT', user: '8700676816', status: 'approved', createdAt: daysAgo(3), resolvedAt: daysAgo(1), approver: 'Krishna', actionJSON: { action: 'add_contact', name: 'ACME' } },
  { requestId: 'TR-20260901-004', user: '7430648262', status: 'approved', createdAt: daysAgo(5), resolvedAt: daysAgo(2), approver: 'Krishna', actionJSON: { action: 'transfer_stock', from: 'Lagos', to: 'Kano office', stage: 'in_transit', lines: [] } },
  // Outside the 7-day default window — present on the sheet, absent here.
  { requestId: 'OLD-ONE', user: '8700676816', status: 'rejected', createdAt: daysAgo(40), resolvedAt: daysAgo(30), approver: 'Krishna', actionJSON: { action: 'add_user', name: 'Musa' } },
];

approvalQueueRepository.getAllPending = async () => [
  { requestId: 'P-1', user: '7430648262', status: 'pending', createdAt: daysAgo(1), actionJSON: { action: 'add_contact', name: 'Still waiting' } },
];
approvalQueueRepository.getResolved = async () => RESOLVED;
approvalQueueRepository.getByRequestId = async (id) => RESOLVED.find((r) => r.requestId === id) || null;

function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)
    && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}
function lastText(bot) {
  const withText = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
  return withText.length ? withText[withText.length - 1].args.text : '';
}

test('DEC-1: the categories screen offers a Decided group with both verdict counts', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  const chip = lastKb(bot).find((b) => b.callback_data === 'abx:cat:decided');
  assert.ok(chip, 'the Decided group is reachable from the category list');
  assert.match(chip.text, /Decided — 3/, `3 inside the window, got: ${chip.text}`);
  assert.match(chip.text, /2 ✅ · 1 ❌/, `split by verdict, got: ${chip.text}`);
  sessionStore.clear(ADMIN);
});

test('DEC-1: the group lists approved AND rejected, newest decision first', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  await flow.handleCallback(bot, cb('abx:cat:decided', ADMIN));
  const chips = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:')).map((b) => b.text);
  assert.equal(chips.length, 3, `the 30-day-old decision is outside the default window, got: ${chips}`);
  assert.match(chips[0], /^❌ /, 'the newest decision (today, a rejection) leads');
  assert.match(chips[0], /Abdul/, 'the chip names who asked');
  assert.ok(chips.some((c) => /^🚚✅/.test(c)), `a received transfer is marked as a transfer, got: ${chips}`);
  assert.match(lastText(bot), /3\* decided/, 'the header counts decisions, not pending work');
  assert.match(lastText(bot), /Record only/, 'the screen says it cannot be acted on');
  sessionStore.clear(ADMIN);
});

test('DEC-1: opening a decided item shows the verdict, the decider, and no buttons', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  await flow.handleCallback(bot, cb('abx:cat:decided', ADMIN));
  await flow.handleCallback(bot, cb('abx:i:0', ADMIN));
  const text = lastText(bot);
  assert.match(text, /Already rejected by Krishna/, `the record names the decider, got: ${text}`);
  const kb = lastKb(bot).map((b) => b.callback_data);
  assert.ok(!kb.some((c) => c.startsWith('abx:ok:') || c.startsWith('abx:no:')),
    `a decided request offers no Approve/Reject, got: ${kb}`);
  sessionStore.clear(ADMIN);
});

test('DEC-1: a received transfer is worded as received, never as approved', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  await flow.handleCallback(bot, cb('abx:cat:decided', ADMIN));
  const chips = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
  const idx = chips.findIndex((c) => /🚚/.test(c.text));
  assert.ok(idx >= 0, 'the transfer row is on the list');
  await flow.handleCallback(bot, cb(chips[idx].callback_data, ADMIN));
  assert.match(lastText(bot), /Already received by Krishna/, `got: ${lastText(bot)}`);
  sessionStore.clear(ADMIN);
});

test('DEC-1: the retention window is a Settings knob, and 0 means everything', async () => {
  const origGetAll = settingsRepo.getAll;
  settingsRepo.getAll = async () => ({ APPROVALS_DECIDED_DAYS: '0' });
  try {
    flow._internals._resetResolvedCache();
    const all = await flow._internals.recentDecided();
    assert.equal(all.length, 4, '0 = no window at all, the 30-day-old decision returns');
  } finally {
    settingsRepo.getAll = origGetAll;
    flow._internals._resetResolvedCache();
  }
  assert.equal(settingsRepo.DEFAULTS.APPROVALS_DECIDED_DAYS, 7, 'the in-code default');
});

test('DEC-1: the group is admin-only, like the rest of the inbox', async () => {
  const bot = createFakeBot();
  await flow.start(bot, EMPLOYEE, EMPLOYEE, null);
  assert.match(lastText(bot), /admin-only/);
  assert.equal(lastKb(bot).length, 0, 'no doors for a non-admin');
  sessionStore.clear(EMPLOYEE);
});
