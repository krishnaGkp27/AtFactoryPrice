'use strict';

/**
 * APX-1 — 🛂 Approvals Inbox: pending requests grouped by concern, newest
 * first, each opening the standard approval card with ✅ / ❌.
 *
 * The properties that matter, pinned here:
 *  - categories carry counts and the age of their OLDEST item (staleness
 *    stays visible even though the list leads with the newest);
 *  - items are listed NEWEST first (owner 31-Jul-2026 — fresh requests are
 *    the ones a requester is actively waiting on; reverses APX-1's
 *    oldest-first choice);
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
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const flow = require(path.join(SRC, 'flows/approvalsInboxFlow'));

// Requesters are Telegram ids on the queue row; screens must show NAMES.
const NAMES = { 7430648262: 'Abdul', 8700676816: 'John' };
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);

const ADMIN = '777';
const EMPLOYEE = '4242';

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

const PENDING = [
  { requestId: 'S-OLD', user: '7430648262', status: 'pending', createdAt: daysAgo(11), actionJSON: { action: 'sale_bundle', customer: 'CJE', items: [] } },
  { requestId: 'S-NEW', user: '7430648262', status: 'pending', createdAt: daysAgo(1), actionJSON: { action: 'sale_bundle', customer: 'Ketu madam', items: [] } },
  { requestId: 'U-1', user: '8700676816', status: 'pending', createdAt: daysAgo(9), actionJSON: { action: 'add_user', name: 'Musa' } },
  { requestId: 'C-1', user: '8700676816', status: 'pending', createdAt: daysAgo(2), actionJSON: { action: 'add_contact', name: 'ACME' } },
  { requestId: 'TR-20260724-001', user: '7430648262', status: 'pending', createdAt: daysAgo(2), actionJSON: { action: 'transfer_stock', from: 'Lagos', to: 'Kano office', stage: 'requested', lines: [] } },
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

test('APX-1: items are listed NEWEST first', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  await flow.handleCallback(bot, cb('abx:cat:sales', ADMIN));
  const items = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
  assert.equal(items.length, 2);
  assert.match(items[0].text, /🟢/, `newest first — got: ${items.map((i) => i.text)}`);
  assert.match(items[1].text, /🔴/, 'oldest last, still age-badged');
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
    assert.match(lastText(bot), /Request: S-NEW/, 'the card names the request (newest leads)');
    const approve = lastKb(bot).find((b) => /Approve/.test(b.text));
    assert.ok(approve, 'the card carries an Approve button');

    await flow.handleCallback(bot, cb(approve.callback_data, ADMIN));
    assert.equal(seen.length, 1, 'exactly one delegation');
    assert.equal(seen[0].data, 'approve:S-NEW', 'canonical callback data is rebuilt');
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
    assert.deepEqual(seen, [{ data: 'reject:S-NEW', action: 'reject' }]);
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

test('APX-1b: the list shows NAMES, never raw Telegram ids', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  await flow.handleCallback(bot, cb('abx:cat:sales', ADMIN));
  const items = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
  assert.ok(items.every((b) => /Abdul/.test(b.text)), `expected names, got: ${items.map((i) => i.text)}`);
  assert.ok(items.every((b) => !/7430648262/.test(b.text)), 'a raw Telegram id must never reach the screen');
  sessionStore.clear(ADMIN);
});

/* ── APX-2: duplicate detection on the live screens ───────────────────── */

const DUP_BASE = Date.now() - 3 * 86400000;
const dupAt = (secs) => new Date(DUP_BASE + secs * 1000).toISOString();
const SALE = { action: 'sale_bundle', customer: 'CJE', items: [{ design: '9006', thans: 3 }] };

// One sale, Submit tapped three times, plus an unrelated sale minutes later.
const WITH_DUPES = [
  { requestId: 'D-1', user: '7430648262', status: 'pending', createdAt: dupAt(0), actionJSON: { ...SALE } },
  { requestId: 'D-2', user: '7430648262', status: 'pending', createdAt: dupAt(4), actionJSON: { ...SALE } },
  { requestId: 'D-3', user: '7430648262', status: 'pending', createdAt: dupAt(9), actionJSON: { ...SALE } },
  { requestId: 'SOLO', user: '7430648262', status: 'pending', createdAt: dupAt(120), actionJSON: { action: 'sale_bundle', customer: 'Ketu madam', items: [] } },
];

async function withDupes(fn) {
  const orig = approvalQueueRepository.getAllPending;
  approvalQueueRepository.getAllPending = async () => WITH_DUPES;
  try { await fn(); } finally {
    approvalQueueRepository.getAllPending = orig;
    sessionStore.clear(ADMIN);
  }
}

test('APX-2: the category counts duplicate GROUPS, not flagged rows', async () => {
  await withDupes(async () => {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    const dupes = lastKb(bot).find((b) => b.callback_data === 'abx:cat:dupes');
    assert.ok(dupes, 'a duplicates group appears');
    assert.match(dupes.text, /⧉ Possible duplicates — 1$/,
      `one thing was queued three times = 1 duplicate, got: ${dupes.text}`);
  });
});

test('APX-2: the duplicates group lists every copy, badged, and nothing else', async () => {
  await withDupes(async () => {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    await flow.handleCallback(bot, cb('abx:cat:dupes', ADMIN));
    const items = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
    assert.equal(items.length, 3, 'all three copies, so any of them can be rejected');
    assert.ok(items.every((b) => b.text.startsWith('⧉ ')), `every row badged, got: ${items.map((i) => i.text)}`);
  });
});

test('APX-2: an unrelated sale minutes later is NOT badged', async () => {
  await withDupes(async () => {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    await flow.handleCallback(bot, cb('abx:cat:sales', ADMIN));
    const items = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
    assert.equal(items.length, 4, 'the sales group still holds every sale');
    const badged = items.filter((b) => b.text.startsWith('⧉ '));
    assert.equal(badged.length, 3, `only the three copies carry the badge, got: ${items.map((i) => i.text)}`);
  });
});

test('APX-2: the card warns before the tap that would double-apply the sale', async () => {
  await withDupes(async () => {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    await flow.handleCallback(bot, cb('abx:cat:dupes', ADMIN));
    await flow.handleCallback(bot, cb('abx:i:0', ADMIN));
    const text = lastText(bot);
    assert.match(text, /Request: D-3/, 'newest copy first');
    assert.match(text, /3 identical requests/, `the card states the count, got: ${text}`);
    assert.match(text, /Approve ONE/, 'and says what to do about it');
    assert.match(text, /D-1/, 'siblings are named so the extras can be rejected');
    assert.match(text, /D-2/);
    // The warning must not disarm the card — approving is still one tap.
    assert.ok(lastKb(bot).some((b) => /Approve/.test(b.text)), 'Approve is still offered');
  });
});

test('APX-2: a lone request gets no duplicate warning', async () => {
  await withDupes(async () => {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    await flow.handleCallback(bot, cb('abx:cat:sales', ADMIN));
    await flow.handleCallback(bot, cb('abx:i:0', ADMIN)); // SOLO, newest — leads the list
    const text = lastText(bot);
    assert.match(text, /Request: SOLO/);
    assert.ok(!/identical requests/.test(text), `no false alarm, got: ${text}`);
  });
});

test('APX-2: the post-decision screen names the group, not the raw key', async () => {
  await withDupes(async () => {
    const bot = createFakeBot();
    const orig = approvalEvents.handleApprovalCallback;
    approvalEvents.handleApprovalCallback = async () => {};
    try {
      await flow.start(bot, ADMIN, ADMIN, null);
      await flow.handleCallback(bot, cb('abx:cat:dupes', ADMIN));
      await flow.handleCallback(bot, cb('abx:i:0', ADMIN));
      await flow.handleCallback(bot, cb('abx:ok:0', ADMIN));
      const text = lastText(bot);
      assert.match(text, /⧉ Possible duplicates/, `pseudo-categories need a real title, got: ${text}`);
      assert.ok(!/🛂 dupes/.test(text), 'never the bare lowercase key');
    } finally {
      approvalEvents.handleApprovalCallback = orig;
    }
  });
});

test('APX-2: a queue with no duplicates shows no duplicates group at all', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  assert.ok(!lastKb(bot).some((b) => b.callback_data === 'abx:cat:dupes'),
    'the group is hidden when there is nothing to warn about');
  sessionStore.clear(ADMIN);
});
