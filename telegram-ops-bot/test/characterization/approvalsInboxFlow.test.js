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
const settingsRepo = require(path.join(SRC, 'repositories/settingsRepository'));
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
    assert.match(lastText(bot), /R-SNEW/, 'the card carries the short ref (newest leads), never the raw id line');
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

/* APX-3b — stage-shaded transfer chips: identical trucks hid which
 * transfers needed a hand. requested → 🟠 awaiting dispatch,
 * in_transit → 📦 receipt pending; category chip carries the mix. */
test('APX-6: transfer chips are dot+route+bales on one newest-first timeline', async () => {
  const orig = approvalQueueRepository.getAllPending;
  const origResolved = approvalQueueRepository.getResolved;
  approvalQueueRepository.getAllPending = async () => [
    { requestId: 'TR-20260724-001', user: '7430648262', status: 'pending', createdAt: daysAgo(1), actionJSON: { action: 'transfer_stock', from: 'Lagos', to: 'Kano office', stage: 'requested', lines: [{ design: '9032', shade: '2', qty: 2 }] } },
    { requestId: 'TR-20260724-003', user: '7430648262', status: 'pending', createdAt: daysAgo(2), actionJSON: { action: 'transfer_stock', from: 'IDUMOTA', to: 'Kano office', stage: 'in_transit', bales: ['B1', 'B2', 'B3'], lines: [] } },
  ];
  approvalQueueRepository.getResolved = async () => [
    // Received an hour ago → green.
    { requestId: 'TR-20260731-001', user: '7430648262', status: 'approved', createdAt: daysAgo(1), resolvedAt: new Date(Date.now() - 3600000).toISOString(), actionJSON: { action: 'transfer_stock', from: 'IDUMOTA', to: 'Kano office', stage: 'in_transit', lines: [] } },
    // Received four days ago → kept too (APX-3e: greens never vanish by
    // default until the owner's backup regime exists).
    { requestId: 'TR-20260720-001', user: '7430648262', status: 'approved', createdAt: daysAgo(9), resolvedAt: daysAgo(4), actionJSON: { action: 'transfer_stock', from: 'Lagos', to: 'IDUMOTA', stage: 'in_transit', lines: [] } },
    // Rejected transfers are not greens.
    { requestId: 'TR-20260730-002', user: '7430648262', status: 'rejected', createdAt: daysAgo(2), resolvedAt: new Date().toISOString(), actionJSON: { action: 'transfer_stock', from: 'Lagos', to: 'IDUMOTA', stage: 'requested', lines: [] } },
  ];
  const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
  const origInv = inventoryRepository.getAll;
  // One row = one than: B1 has 2, B2 has 2, B3 has 1 → the 🟡's 3 bales = 5T.
  inventoryRepository.getAll = async () => [
    { packageNo: 'B1' }, { packageNo: 'B1' }, { packageNo: 'B2' }, { packageNo: 'B2' }, { packageNo: 'B3' },
  ];
  try {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    const catChip = lastKb(bot).find((b) => b.callback_data === 'abx:cat:transfers');
    assert.match(catChip.text, /1 🔴 · 1 🟡 · 2 🟢/, `category mix shown, got: ${catChip.text}`);

    await flow.handleCallback(bot, cb('abx:cat:transfers', ADMIN));
    const chips = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:trf:')).map((b) => b.text);
    assert.ok(chips.includes('🔴 LAG▸KAN ·2B'), `requested = red dot + requested bales, got: ${chips}`);
    assert.ok(chips.includes('🟡 IDU▸KAN ·3B, 5T'), `in-transit = yellow dot + bales + thans, got: ${chips}`);
    assert.ok(chips.includes('🟢 IDU▸KAN'), `received = green dot, got: ${chips}`);
    assert.ok(chips.includes('🟢 LAG▸IDU'), `old green KEPT (default: never vanish), got: ${chips}`);
    assert.equal(chips.length, 4, 'rejected resolved rows never appear');
    // No stage words, no date tokens — colour is the stage, position is the date.
    assert.ok(chips.every((t) => !/DSP|RCV|Jul·/.test(t)), `words/dates removed, got: ${chips}`);
    // Newest→oldest across open AND received: the two 1-day rows lead (either
    // order), the 2-day yellow follows, the 9-day green is last.
    assert.equal(chips[2], '🟡 IDU▸KAN ·3B, 5T', `2-day row third, got: ${chips}`);
    assert.equal(chips[3], '🟢 LAG▸IDU', `oldest last, got: ${chips}`);
    assert.match(lastText(bot), /2\* open · 2 🟢/, `header splits open vs received, got: ${lastText(bot)}`);
    assert.match(lastText(bot), /🔴 requested · 🟡 in transit · 🟢 received · B bales · T thans/, 'legend teaches the dots and units');

    // APX-3e — a Settings row restores the display window once backups exist.
    const origSettings = settingsRepo.getAll;
    settingsRepo.getAll = async () => ({ ...(await origSettings()), TRANSFER_RECEIVED_HOURS: 48 });
    try {
      const bot2 = createFakeBot();
      sessionStore.clear(ADMIN);
      await flow.start(bot2, ADMIN, ADMIN, null);
      await flow.handleCallback(bot2, cb('abx:cat:transfers', ADMIN));
      const chips2 = lastKb(bot2).filter((b) => b.callback_data.startsWith('abx:trf:')).map((b) => b.text);
      assert.equal(chips2.filter((t) => t.includes('🟢')).length, 1, `48h window hides the old green, got: ${chips2}`);
    } finally {
      settingsRepo.getAll = origSettings;
    }
  } finally {
    approvalQueueRepository.getAllPending = orig;
    approvalQueueRepository.getResolved = origResolved;
    inventoryRepository.getAll = origInv;
    sessionStore.clear(ADMIN);
  }
});

/* APX-4 — context + short refs on approval cards. */
test('APX-4: add-warehouse card shows existing warehouses and mix-up warnings', async () => {
  const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
  const orig = inventoryRepository.getWarehouses;
  inventoryRepository.getWarehouses = async () => ['Lagos', 'Kano office', 'IDUMOTA'];
  try {
    const card = await approvalCards.buildAddWarehouseCard({ action: 'add_warehouse', name: 'Cashmere' });
    assert.match(card, /Add Warehouse — "Cashmere"/);
    assert.match(card, /Existing \(3\): Lagos · Kano office · IDUMOTA/, `context line present, got: ${card}`);
    assert.match(card, /design category/, 'category mix-up warning fires for Cashmere');

    const dup = await approvalCards.buildAddWarehouseCard({ action: 'add_warehouse', name: 'lagos' });
    assert.match(dup, /ALREADY EXISTS/, 'case-insensitive duplicate warning');

    assert.equal(approvalCards.shortRequestRef('9ddcb92e-50f6-43f5-9d42-1a0200f4a896'), 'R-9DDC', 'stable display ref from the UUID');
  } finally {
    inventoryRepository.getWarehouses = orig;
  }
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
    assert.match(text, /R-D3/, 'newest copy first (short ref)');
    assert.match(text, /3 identical requests/, `the card states the count, got: ${text}`);
    assert.match(text, /Approve ONE/, 'and says what to do about it');
    assert.match(text, /R-D1/, 'siblings are named (short refs) so the extras can be rejected');
    assert.match(text, /R-D2/);
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
    assert.match(text, /R-SOLO/);
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
