'use strict';

/**
 * APX-1 — 🛂 Approvals Inbox: pending requests grouped by concern, oldest
 * first, each opening the standard approval card with ✅ / ❌.
 *
 * The properties that matter, pinned here:
 *  - categories carry counts and the age of their OLDEST item;
 *  - items are listed OLDEST first (this is a backlog-clearing screen —
 *    the morning digest's newest-first order is the wrong way round);
 *  - Approve/Reject DELEGATE to approvalEvents.handleApprovalCallback with
 *    the canonical `approve:<id>` / `reject:<id>` data, so the inbox owns no
 *    approval logic and every existing guard still runs;
 *  - staged transfers are NOT approvable — they route to the transfer card;
 *  - the whole surface is admin-only.
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
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const flow = require(path.join(SRC, 'flows/approvalsInboxFlow'));

const ADMIN = '777';
const EMPLOYEE = '4242';

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

const PENDING = [
  { requestId: 'S-OLD', user: 'Abdul', status: 'pending', createdAt: daysAgo(11), actionJSON: { action: 'sale_bundle', customer: 'CJE', items: [] } },
  { requestId: 'S-NEW', user: 'Abdul', status: 'pending', createdAt: daysAgo(1), actionJSON: { action: 'sale_bundle', customer: 'Ketu madam', items: [] } },
  { requestId: 'U-1', user: 'John', status: 'pending', createdAt: daysAgo(9), actionJSON: { action: 'add_user', name: 'Musa' } },
  { requestId: 'C-1', user: 'John', status: 'pending', createdAt: daysAgo(2), actionJSON: { action: 'add_contact', name: 'ACME' } },
  { requestId: 'TR-20260724-001', user: 'Abdul', status: 'pending', createdAt: daysAgo(2), actionJSON: { action: 'transfer_stock', from: 'Lagos', to: 'Kano office', stage: 'requested', lines: [] } },
];
approvalQueueRepository.getAllPending = async () => PENDING;

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

test('APX-1: categories carry counts and the oldest item\'s age', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  const kb = lastKb(bot);

  assert.match(lastText(bot), /5 pending/, 'header counts the whole queue');
  const sales = kb.find((b) => b.callback_data === 'abx:cat:sales');
  assert.match(sales.text, /💰 Sales — 2 .*🔴11d/, `sales group shows count + oldest age, got: ${sales.text}`);
  const people = kb.find((b) => b.callback_data === 'abx:cat:people');
  assert.match(people.text, /⚠️/, 'dual-admin groups are marked');
  assert.ok(kb.some((b) => b.callback_data === 'abx:cat:transfers'), 'transfers get their own group');
  sessionStore.clear(ADMIN);
});

test('APX-1: items are listed OLDEST first', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  await flow.handleCallback(bot, cb('abx:cat:sales', ADMIN));
  const items = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
  assert.equal(items.length, 2);
  assert.match(items[0].text, /🔴/, `oldest first — got: ${items.map((i) => i.text)}`);
  assert.match(items[1].text, /🟢/, 'newest last');
  sessionStore.clear(ADMIN);
});

test('APX-1: Approve delegates to the standard handler with approve:<id>', async () => {
  const bot = createFakeBot();
  const seen = [];
  const orig = approvalEvents.handleApprovalCallback;
  approvalEvents.handleApprovalCallback = async (b, query, action) => {
    seen.push({ data: query.data, action, from: String(query.from.id) });
  };
  try {
    await flow.start(bot, ADMIN, ADMIN, null);
    await flow.handleCallback(bot, cb('abx:cat:sales', ADMIN));
    await flow.handleCallback(bot, cb('abx:i:0', ADMIN));
    assert.match(lastText(bot), /Request: S-OLD/, 'the card names the request');
    const approve = lastKb(bot).find((b) => /Approve/.test(b.text));
    assert.ok(approve, 'the card carries an Approve button');

    await flow.handleCallback(bot, cb(approve.callback_data, ADMIN));
    assert.equal(seen.length, 1, 'exactly one delegation');
    assert.equal(seen[0].data, 'approve:S-OLD', 'canonical callback data is rebuilt');
    assert.equal(seen[0].action, 'approve');
    assert.equal(seen[0].from, ADMIN, 'the real admin identity is preserved for the guards');
  } finally {
    approvalEvents.handleApprovalCallback = orig;
    sessionStore.clear(ADMIN);
  }
});

test('APX-1: Reject delegates too, with reject:<id>', async () => {
  const bot = createFakeBot();
  const seen = [];
  const orig = approvalEvents.handleApprovalCallback;
  approvalEvents.handleApprovalCallback = async (b, query, action) => { seen.push({ data: query.data, action }); };
  try {
    await flow.start(bot, ADMIN, ADMIN, null);
    await flow.handleCallback(bot, cb('abx:cat:sales', ADMIN));
    await flow.handleCallback(bot, cb('abx:i:0', ADMIN));
    const reject = lastKb(bot).find((b) => /Reject/.test(b.text));
    await flow.handleCallback(bot, cb(reject.callback_data, ADMIN));
    assert.deepEqual(seen, [{ data: 'reject:S-OLD', action: 'reject' }]);
  } finally {
    approvalEvents.handleApprovalCallback = orig;
    sessionStore.clear(ADMIN);
  }
});

test('APX-1: transfers are NOT approvable — no Approve button, routed instead', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  await flow.handleCallback(bot, cb('abx:cat:transfers', ADMIN));
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => b.callback_data.startsWith('abx:trf:')), 'transfer rows use the routing callback');
  assert.ok(!kb.some((b) => b.callback_data.startsWith('abx:i:')), 'never the approvable item callback');
  assert.match(lastText(bot), /not approvals/i, 'the screen says why');
  sessionStore.clear(ADMIN);
});

test('APX-1: the inbox is admin-only', async () => {
  const bot = createFakeBot();
  await flow.start(bot, EMPLOYEE, EMPLOYEE, null);
  assert.match(lastText(bot), /admin-only/i, 'an employee is refused');
  assert.equal(sessionStore.get(EMPLOYEE), null, 'and gets no session');
});
