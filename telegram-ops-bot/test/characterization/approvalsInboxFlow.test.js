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
  // TRM-1 review: a free-text field carrying stray Markdown. Before the fix
  // this card could not be opened at all — editMessageText AND its
  // sendMessage fallback both 400'd on "can't parse entities", the spinner
  // cleared, and the approval could be neither granted nor refused.
  { requestId: 'TRM-1', user: '8700676816', status: 'pending', createdAt: daysAgo(1), actionJSON: { action: 'task_reminder_enable', task_id: 'T9', title: 'Chase Musa_s invoice *urgent*', doer_name: 'Musa Bello' } },
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

  assert.match(lastText(bot), /6 pending/, 'header counts the whole queue');
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
  // SLC-1 (owner 14-Aug-2026) — the age traffic-light is gone from sales
  // chips: "since I can already see the list newest first, the colour
  // indicator doesn't make sense". Order is the index order itself, and
  // only a chip 3d+ old carries a quiet ⏳ age tag.
  assert.equal(items[0].callback_data, 'abx:i:0', 'newest is first');
  assert.ok(!/🟢|🟠|🔴/.test(items[0].text), `no age dots on sales chips, got: ${items[0].text}`);
  assert.ok(!/⏳/.test(items[0].text), 'a 1-day-old request is not tagged');
  assert.match(items[1].text, /⏳11d/, 'the 11-day-old one still says so, quietly');
  sessionStore.clear(ADMIN);
});

test('LBL-1: the chip speaks the owner\'s vocabulary — "sale bale", never "sale bundle"', async () => {
  // Owner, 07-Aug-2026: "'Sale bundle' is not actually a bundle. It is a
  // bale. A bale means a package." The internal action code sale_bundle is
  // locked (stamped on every pending row); only the words humans read change.
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  await flow.handleCallback(bot, cb('abx:cat:sales', ADMIN));
  // SLC-1 — the SALES chips dropped the action word entirely (it repeated
  // down every row); LBL-1's vocabulary still rules every other surface, so
  // the rule is pinned on a category that still names its action.
  await flow.handleCallback(bot, cb('abx:cat:crm', ADMIN));
  const items = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
  assert.ok(items.length, 'the CRM group has chips');
  assert.ok(!items.some((it) => /sale bundle/.test(it.text)), 'never the internal code');
  assert.equal(approvalCards.actionLabel('sale_bundle'), 'sale bale', 'the vocabulary itself');
  for (const it of items) {
    assert.doesNotMatch(it.text, /bundle/, `no "bundle" on a chip, got: ${it.text}`);
  }
  // Non-sales chips keep the dated format: dot · date · action · name.
  // The en-GB short month is 3 letters for most months and 4 for September
  // ("Sept"), so this pin must accept both or it fails every September.
  assert.match(items[0].text, /^🟢 \d{2} \w{3,4} · add contact · John$/, `got: ${items[0].text}`);
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
    // Legacy single-than transfer: LOOSE than cargo → ·1T (no route recorded).
    { requestId: 'abc1d2e3-0000-4000-8000-000000000000', user: '7430648262', status: 'pending', createdAt: daysAgo(3), actionJSON: { action: 'transfer_than', packageNo: '5801', thanNo: 3, warehouse: 'Kano office' } },
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
  try {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    const catChip = lastKb(bot).find((b) => b.callback_data === 'abx:cat:transfers');
    assert.match(catChip.text, /2 🔴 · 1 🟡 · 2 🟢/, `category mix shown, got: ${catChip.text}`);

    await flow.handleCallback(bot, cb('abx:cat:transfers', ADMIN));
    const chips = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:trf:')).map((b) => b.text);
    assert.ok(chips.includes('🔴 LAG▸KAN ·2B'), `requested = red dot + requested bales, got: ${chips}`);
    // B counts whole bales ONLY — never the thans packed inside them.
    assert.ok(chips.includes('🟡 IDU▸KAN ·3B'), `in-transit = yellow dot + bale count, got: ${chips}`);
    // T counts LOOSE thans travelling as their own cargo (legacy single-than row).
    assert.ok(chips.includes('🔴 R-ABC1 ·1T'), `loose than = T unit + ref fallback, got: ${chips}`);
    assert.ok(chips.includes('🟢 IDU▸KAN'), `received = green dot, got: ${chips}`);
    assert.ok(chips.includes('🟢 LAG▸IDU'), `old green KEPT (default: never vanish), got: ${chips}`);
    assert.equal(chips.length, 5, 'rejected resolved rows never appear');
    // No stage words, no date tokens — colour is the stage, position is the date.
    assert.ok(chips.every((t) => !/DSP|RCV|Jul·/.test(t)), `words/dates removed, got: ${chips}`);
    // Newest→oldest across open AND received: the two 1-day rows lead (either
    // order), then 2d yellow, 3d legacy, 9-day green last.
    assert.equal(chips[2], '🟡 IDU▸KAN ·3B', `2-day row third, got: ${chips}`);
    assert.equal(chips[3], '🔴 R-ABC1 ·1T', `3-day row fourth, got: ${chips}`);
    assert.equal(chips[4], '🟢 LAG▸IDU', `oldest last, got: ${chips}`);
    assert.match(lastText(bot), /3\* open · 2 🟢/, `header splits open vs received, got: ${lastText(bot)}`);
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
    sessionStore.clear(ADMIN);
  }
});

/* RET-4 — the multi-than return card in the inbox. */
test('RET-4: a return_thans row lands under Returns & reversals with its photo chip', async () => {
  const orig = approvalQueueRepository.getAllPending;
  approvalQueueRepository.getAllPending = async () => [
    {
      requestId: 'RN-1', user: '8700676816', status: 'pending', createdAt: daysAgo(1),
      actionJSON: {
        action: 'return_thans', packageNo: '9037', warehouse: 'Kano office',
        thanNos: [1, 4], customer: 'ABBA', customerId: 'CUS-ABBA',
        returnedOn: '2026-08-28', condition: 'damaged', conditionNote: '6 yd cut off',
        return_photo_file_id: 'ret-photo-1', pricePerYard: 2500, yards: 60,
        design: 'Cashmere', shade: 'Blue',
      },
    },
  ];
  try {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    // Without the CATEGORIES entry the row falls into ❓ Other with no dual badge.
    const cat = lastKb(bot).find((b) => b.callback_data === 'abx:cat:returns');
    assert.ok(cat, `the returns group exists, got: ${lastKb(bot).map((b) => b.callback_data)}`);
    assert.match(cat.text, /⚠️/, 'returns are dual-admin, and the group says so');

    await flow.handleCallback(bot, cb('abx:cat:returns', ADMIN));
    const items = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
    assert.equal(items.length, 1, 'the return_thans row is here, not in ❓ Other');

    await flow.handleCallback(bot, cb(items[0].callback_data, ADMIN));
    // The rebuilt card is the RET-4 card, not the generic field list.
    assert.match(lastText(bot), /9037\/1/, `than tokens on the rebuilt card, got: ${lastText(bot)}`);
    assert.match(lastText(bot), /Damaged/, 'the condition survives the rebuild');
    const doc = lastKb(bot).find((b) => /abx:doc:/.test(b.callback_data));
    assert.ok(doc, 'the photo chip is offered');
    assert.equal(doc.text, '📎 Returned goods', 'it says goods, not sales bill');

    await flow.handleCallback(bot, cb(doc.callback_data, ADMIN));
    const photo = bot.calls.filter((c) => c.method === 'sendPhoto').pop();
    assert.ok(photo, 'the goods photo is delivered');
    assert.equal(photo.args.fileId || photo.args.photo, 'ret-photo-1');
  } finally {
    approvalQueueRepository.getAllPending = orig;
    sessionStore.clear(ADMIN);
  }
});

/* RET-4 — a picture the employee sent as a FILE (📎 → File, the SHP-1 habit)
 * has a DOCUMENT file_id: sendPhoto refuses it, so the recorded type decides
 * the sender. */
test('RET-4: a File-sent return photo is delivered with sendDocument', async () => {
  const orig = approvalQueueRepository.getAllPending;
  approvalQueueRepository.getAllPending = async () => [
    {
      requestId: 'RN-2', user: '8700676816', status: 'pending', createdAt: daysAgo(1),
      actionJSON: {
        action: 'return_thans', packageNo: '9037', warehouse: 'Kano office',
        thanNos: [1], customer: 'ABBA', customerId: 'CUS-ABBA',
        returnedOn: '2026-08-28', condition: 'good', conditionNote: '',
        return_photo_file_id: 'ret-file-1', return_photo_type: 'document',
        pricePerYard: 2500, yards: 30, design: 'Cashmere', shade: 'Blue',
      },
    },
  ];
  try {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    await flow.handleCallback(bot, cb('abx:cat:returns', ADMIN));
    const items = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
    await flow.handleCallback(bot, cb(items[0].callback_data, ADMIN));
    const doc = lastKb(bot).find((b) => /abx:doc:/.test(b.callback_data));
    assert.ok(doc, 'the photo chip is offered');

    await flow.handleCallback(bot, cb(doc.callback_data, ADMIN));
    const sentDoc = bot.calls.filter((c) => c.method === 'sendDocument').pop();
    assert.ok(sentDoc, 'delivered as a document, first try');
    assert.equal(sentDoc.args.doc, 'ret-file-1');
    assert.equal(bot.calls.filter((c) => c.method === 'sendPhoto').length, 0,
      'no refused sendPhoto attempt at all');
  } finally {
    approvalQueueRepository.getAllPending = orig;
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

test('a Markdown-hostile free-text field cannot break an approval card', async () => {
  // Drive the REAL card render for the hostile row and assert on what a
  // Telegram parse would see: no unbalanced legacy-Markdown delimiter.
  const bot = createFakeBot();
  sessionStore.clear(ADMIN);
  await flow.start(bot, ADMIN, ADMIN);
  await flow.handleCallback(bot, cb('abx:cat:config', ADMIN));
  const items = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
  assert.ok(items.length, 'the arming request is filed under a real category, not ❓ Other');

  await flow.handleCallback(bot, cb(items[0].callback_data, ADMIN));
  const text = lastText(bot);
  assert.match(text, /arm task reminders/, 'the card opened');
  assert.match(text, /Chase Musa/, 'and names the task, so nobody signs blind');

  const unbalanced = (t, ch) => t.split('').filter((c, i) => c === ch && t[i - 1] !== '\\').length % 2 === 1;
  assert.equal(unbalanced(text, '_'), false, 'no unbalanced italic marker reaches Telegram');
  assert.equal(unbalanced(text, '*'), false, 'no unbalanced bold marker reaches Telegram');
  assert.equal(unbalanced(text, '`'), false, 'no unbalanced code marker reaches Telegram');
});

/* VRF-4 (owner 08-Sep-2026, on a card reading "2 differ · 1 missing · 1
 * extra": "I cannot precisely see the exact bill number where I need to find
 * the ambiguity") — the inbox card NAMES the flagged bales, and a 🔬 chip
 * replays the full verdict as an ephemeral peek beside the bill. */
test('VRF-4: the inbox card names the flagged bales; 🔬 Bill check replays the verdict and is swept on the next tap', async () => {
  const orig = approvalQueueRepository.getAllPending;
  const ephemeral = require(path.join(SRC, 'services/ephemeralDocs'));
  ephemeral._internals._resetForTests();
  approvalQueueRepository.getAllPending = async () => [
    {
      requestId: 'VRF4-WITH-ROWS', user: '7430648262', status: 'pending', createdAt: daysAgo(1),
      actionJSON: {
        action: 'sale_bundle', customer: 'CJE', sale_doc_file_id: 'bill-77', sale_doc_type: 'document',
        items: [{ type: 'package', packageNo: '4412' }, { type: 'package', packageNo: '4421' }, { type: 'package', packageNo: '4401' }],
        docVerify: {
          ok: 1, differs: 1, missing: 1, extra: 1, thanUnchecked: 0, at: '2026-09-08T10:00:00.000Z',
          okNos: ['4401'], okNoted: [],
          differRows: [{ no: '4412', diffs: ['qty: bill ~150 yds, request 120 yds'], notes: [] }],
          missingNos: ['4421'],
          extraRows: [{ no: '4430', design: '77016', shade: '5' }],
          truncated: false,
        },
      },
    },
    {
      // Checked before VRF-4: counts only. The line renders as it always did; no chip.
      requestId: 'VRF4-COUNTS-ONLY', user: '7430648262', status: 'pending', createdAt: daysAgo(2),
      actionJSON: {
        action: 'sale_bundle', customer: 'Ketu madam', sale_doc_file_id: 'bill-78', sale_doc_type: 'document',
        items: [{ type: 'package', packageNo: '516' }],
        docVerify: { ok: 0, differs: 2, missing: 1, extra: 1, at: '2026-09-01T10:00:00.000Z' },
      },
    },
  ];
  // Live stock for the bales, so APF-2 keeps the plain Approve/Reject pair
  // and the card enriches — the test is about the 🔬 lines, not stock-gone.
  const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
  const origInv = inventoryRepository.getAll;
  inventoryRepository.getAll = async () => ['4412', '4421', '4401', '516'].map((pkg) => ({
    packageNo: pkg, design: '77016', shade: '1', warehouse: 'IDUMOTA', thanNo: 1,
    status: 'available', yards: 50, pricePerYard: 0,
  }));
  try {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    await flow.handleCallback(bot, cb('abx:cat:sales', ADMIN));
    const items = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
    assert.equal(items.length, 2, `two sales listed, got: ${lastKb(bot).map((b) => b.text)}`);

    // Newest first → the row WITH detail opens first.
    await flow.handleCallback(bot, cb(items[0].callback_data, ADMIN));
    const card = lastText(bot).replace(/\\/g, ''); // MarkdownV2 escapes stripped
    assert.match(card, /🔬 Bill check: 1 confirmed · 1 differ · 1 missing · 1 extra ⚠️/, card);
    assert.match(card, /⚠️ 4412 \(qty\)/, 'the differing bale is NAMED, with the kind');
    assert.match(card, /❌ 4421 not on bill/, 'the missing bale is NAMED');
    assert.match(card, /➕ 4430 on bill, not in request/, 'the extra bill row is NAMED');
    const kb = lastKb(bot);
    const billChip = kb.find((b) => /^abx:doc:/.test(b.callback_data));
    const chkChip = kb.find((b) => /^abx:chk:/.test(b.callback_data));
    assert.ok(billChip, 'the bill chip is still there');
    assert.ok(chkChip, '🔬 Bill check chip offered when the row carries detail');
    assert.equal(chkChip.text, '🔬 Bill check');
    // Same ROW as the bill chip — one peek row, not an extra line of buttons.
    const rows = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)
      && c.args.opts && c.args.opts.reply_markup).pop().args.opts.reply_markup.inline_keyboard;
    const peekRow = rows.find((r) => r.some((b) => /^abx:doc:/.test(b.callback_data)));
    assert.deepEqual(peekRow.map((b) => b.callback_data.split(':')[1]), ['doc', 'chk'], 'bill and verdict chips share a row, bill first');
    assert.ok(kb.find((b) => b.callback_data === 'abx:ok:VRF4-WITH-ROWS'), 'Approve unchanged');
    assert.ok(kb.find((b) => b.callback_data === 'abx:no:VRF4-WITH-ROWS'), 'Reject unchanged');

    // Tap → the full verdict, plain text, headed by the SHORT ref (APX-4), never the raw id.
    const before = bot.calls.length;
    await flow.handleCallback(bot, cb(chkChip.callback_data, ADMIN));
    const sent = bot.calls.slice(before).filter((c) => c.method === 'sendMessage');
    assert.equal(sent.length, 1, 'exactly one replay message');
    const replay = sent[0].args.text;
    assert.match(replay, /^🔬 Bill check — request R-VRF4/, replay);
    assert.doesNotMatch(replay, /VRF4-WITH-ROWS/, 'raw request id never reaches the screen');
    assert.match(replay, /✅ Bale 4401 — on the bill/);
    assert.match(replay, /⚠️ Bale 4412 — qty: bill ~150 yds, request 120 yds/, 'full reason text behind the chip');
    assert.match(replay, /❌ Bale 4421 — NOT found on the bill/);
    assert.match(replay, /➕ On the bill but NOT in the request: 4430 \(77016 5\)/);
    assert.match(replay, /Verdict: 1 confirmed · 1 differ · 1 missing · 1 extra/);
    assert.match(replay, /Open the attached bill and compare before approving/);
    assert.equal(sent[0].args.opts && sent[0].args.opts.parse_mode, undefined, 'plain text — no Markdown to break on a bill string');
    assert.equal(bot.calls.filter((c) => c.method === 'sendDocument' || c.method === 'sendPhoto').length, 0,
      'the chip replays text — it does not re-send the bill, and it never calls the OCR');

    // SAB-1 contract, VRF-4 refinement: the replay is a peek. The bill and
    // the verdict COEXIST (the verdict names the bill rows to look at), a
    // re-tap replaces only its own kind, and any other inbox tap sweeps all.
    const tracked = () => ephemeral._internals._byUser.get(ADMIN) || [];
    const deleted = () => bot.calls.filter((c) => c.method === 'deleteMessage').map((c) => c.args.messageId);
    assert.equal(tracked().length, 1, 'the replay is registered as an ephemeral view');
    const replay1 = tracked()[0].messageId;
    assert.equal(deleted().length, 0, 'nothing swept yet');

    await flow.handleCallback(bot, cb(billChip.callback_data, ADMIN)); // open the bill beside it
    assert.equal(deleted().length, 0, 'opening the bill does NOT sweep the verdict');
    assert.deepEqual(tracked().map((t) => t.kind), ['chk', 'doc'], 'both peeks stand');
    const bill1 = tracked()[1].messageId;

    await flow.handleCallback(bot, cb(chkChip.callback_data, ADMIN)); // tap 🔬 again
    assert.deepEqual(deleted(), [replay1], 'a second 🔬 replaces only the first verdict; the bill stays');
    assert.deepEqual(tracked().map((t) => t.kind), ['doc', 'chk']);
    assert.ok(tracked().some((t) => t.messageId === bill1), 'the bill peek is untouched');
    const replay2 = tracked().find((t) => t.kind === 'chk').messageId;

    await flow.handleCallback(bot, cb('abx:back', ADMIN)); // navigation → everything goes
    assert.deepEqual(deleted().slice(1).sort(), [bill1, replay2].sort(), 'Back sweeps the bill AND the verdict');
    assert.equal(tracked().length, 0, 'registry emptied');

    // The counts-only row: SAB-1 line exactly as before, nothing under it, no chip.
    const list = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
    await flow.handleCallback(bot, cb(list[1].callback_data, ADMIN));
    const oldCard = lastText(bot).replace(/\\/g, '');
    assert.match(oldCard, /🔬 Bill check: 0 confirmed · 2 differ · 1 missing · 1 extra ⚠️/, oldCard);
    assert.doesNotMatch(oldCard, /not on bill|on bill, not in request/, 'no rows to name → no line pretends to');
    assert.ok(lastKb(bot).find((b) => /^abx:doc:/.test(b.callback_data)), 'the bill chip stands');
    assert.equal(lastKb(bot).find((b) => /^abx:chk:/.test(b.callback_data)), undefined,
      'no 🔬 chip when it could only repeat the card');
  } finally {
    approvalQueueRepository.getAllPending = orig;
    inventoryRepository.getAll = origInv;
    ephemeral._internals._resetForTests();
    sessionStore.clear(ADMIN);
  }
});

/* VRF-4 — a stale 🔬 tap (a card re-rendered from an older list, or a row
 * that only ever had counts) answers with a toast and sends nothing. */
test('VRF-4: a 🔬 tap on a counts-only row is a toast, not a message', async () => {
  const orig = approvalQueueRepository.getAllPending;
  approvalQueueRepository.getAllPending = async () => [
    {
      requestId: 'VRF4-STALE', user: '7430648262', status: 'pending', createdAt: daysAgo(1),
      actionJSON: {
        action: 'sale_bundle', customer: 'CJE', sale_doc_file_id: 'bill-79', sale_doc_type: 'document',
        items: [{ type: 'package', packageNo: '516' }],
        docVerify: { ok: 1, differs: 0, missing: 0, extra: 0 },
      },
    },
  ];
  try {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    await flow.handleCallback(bot, cb('abx:cat:sales', ADMIN));
    const items = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
    await flow.handleCallback(bot, cb(items[0].callback_data, ADMIN));
    assert.equal(lastKb(bot).find((b) => /^abx:chk:/.test(b.callback_data)), undefined, 'no chip offered');
    const before = bot.calls.length;
    await flow.handleCallback(bot, cb('abx:chk:0', ADMIN)); // a chip from an older render
    const after = bot.calls.slice(before);
    assert.equal(after.filter((c) => c.method === 'sendMessage').length, 0, 'nothing sent');
    const toast = after.filter((c) => c.method === 'answerCallbackQuery').pop();
    assert.match((toast && toast.args.opts && toast.args.opts.text) || '', /No bill-check detail/, 'the tap is answered with a toast');
    // An index pointing past the list is equally quiet.
    const before2 = bot.calls.length;
    await flow.handleCallback(bot, cb('abx:chk:42', ADMIN));
    assert.equal(bot.calls.slice(before2).filter((c) => c.method === 'sendMessage').length, 0);
  } finally {
    approvalQueueRepository.getAllPending = orig;
    sessionStore.clear(ADMIN);
  }
});

/* PAY-2 §2 G — payments in the inbox: their own 💳 group with the dual
 * badge, the bill as a 📄 chip, and a resolved record that says where the
 * money stands (read from PaymentRequests, names never ids). */
const paymentRequestsRepo = require(path.join(SRC, 'repositories/paymentRequestsRepository'));
const PAYMENTS = [
  { requestId: 'P-BILL', user: '7430648262', status: 'pending', createdAt: daysAgo(1), actionJSON: { action: 'request_payment', payment_id: 'PAY-1', payee_name: 'Abdul', payee_type: 'employee', amount_ngn: 4000, account_number: '7048940378', bank: 'OPAY', bill_file_id: 'bill-7' } },
  { requestId: 'P-ACCT', user: '8700676816', status: 'pending', createdAt: daysAgo(2), actionJSON: { action: 'register_payment_account', owner_name: 'Musa', owner_type: 'contractor', bank: 'GTB', account_number: '0123456789' } },
];
NAMES[999] = 'Office';
NAMES[777] = 'Ajeet';

async function openPayment(bot) {
  await flow.start(bot, ADMIN, ADMIN, null);
  await flow.handleCallback(bot, cb('abx:cat:payments', ADMIN));
  const items = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
  await flow.handleCallback(bot, cb(items[0].callback_data, ADMIN));
}

test('PAY-2: 💳 Payments is its own group, dual-badged, and holds both payment doors', async () => {
  const orig = approvalQueueRepository.getAllPending;
  approvalQueueRepository.getAllPending = async () => [...PENDING, ...PAYMENTS];
  try {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    const kb = lastKb(bot);
    const pays = kb.find((b) => b.callback_data === 'abx:cat:payments');
    assert.ok(pays, 'a Payments category');
    assert.match(pays.text, /💳 Payments — 2 ⚠️/, `count + dual badge, got: ${pays.text}`);
    const other = kb.find((b) => b.callback_data === 'abx:cat:other');
    assert.equal(other, undefined, 'nothing left in ❓ Other');
    assert.equal(flow._internals.categoryOf(PAYMENTS[0]), 'payments');
    assert.equal(flow._internals.categoryOf(PAYMENTS[1]), 'payments');
  } finally {
    approvalQueueRepository.getAllPending = orig;
    sessionStore.clear(ADMIN);
  }
});

test('PAY-2: the pending payment card offers the bill as a 📄 chip, delivered as a photo', async () => {
  const orig = approvalQueueRepository.getAllPending;
  approvalQueueRepository.getAllPending = async () => PAYMENTS;
  try {
    const bot = createFakeBot();
    await openPayment(bot);
    assert.match(lastText(bot).replace(/\\/g, ''), /Payment request: ₦4,000/);
    const chip = lastKb(bot).find((b) => /^abx:doc:/.test(b.callback_data));
    assert.ok(chip, 'a 📄 chip');
    assert.equal(chip.text, '📄 Bill');
    assert.ok(lastKb(bot).some((b) => b.callback_data === 'abx:ok:P-BILL'), 'still a decision');
    await flow.handleCallback(bot, cb(chip.callback_data, ADMIN));
    const photo = bot.calls.filter((c) => c.method === 'sendPhoto').pop();
    assert.ok(photo, 'the bill is sent');
    assert.equal(photo.args.photo, 'bill-7');
    assert.match(photo.args.opts.caption, /^📄 Bill — /);
  } finally {
    approvalQueueRepository.getAllPending = orig;
    sessionStore.clear(ADMIN);
  }
});

test('PAY-2: a resolved payment record says where the money stands', async () => {
  const orig = approvalQueueRepository.getAllPending;
  const origLive = approvalQueueRepository.getByRequestId;
  const origFind = paymentRequestsRepo.findByApprovalRequestId;
  approvalQueueRepository.getAllPending = async () => PAYMENTS;
  let live = { ...PAYMENTS[0], status: 'approved', resolvedAt: '2026-09-09T14:00:00Z', approver: 'Ajeet + John' };
  approvalQueueRepository.getByRequestId = async () => live;
  let payRow = null;
  paymentRequestsRepo.findByApprovalRequestId = async (id) => (id === 'P-BILL' ? payRow : null);
  const record = async () => {
    const bot = createFakeBot();
    await openPayment(bot);
    sessionStore.clear(ADMIN);
    return { text: lastText(bot).replace(/\\/g, ''), kb: lastKb(bot) };
  };
  try {
    payRow = { payment_id: 'PAY-1', status: 'done', done_by: '999', done_at: '09-Sep-2026, 15:10' };
    let r = await record();
    assert.match(r.text, /Already approved/);
    assert.match(r.text, /💸 Paid by Office · 09-Sep-2026, 15:10 · PAY-1/, r.text);
    assert.ok(!/999/.test(r.text), 'a name, never the raw id');
    assert.ok(r.kb.some((b) => b.text === '📄 Bill'), 'the bill chip survives on the record');
    assert.ok(!r.kb.some((b) => /^abx:ok:/.test(b.callback_data)), 'no decision on a record');

    payRow = { payment_id: 'PAY-1', status: 'approved' };
    r = await record();
    assert.match(r.text, /🏦 With finance to pay/, r.text);

    payRow = { payment_id: 'PAY-1', status: 'declined', done_by: '999', decline_reason: 'Account name does not match' };
    r = await record();
    assert.match(r.text, /✖ Declined by Office · Account name does not match/, r.text);

    live = { ...live, status: 'rejected', approver: 'Ajeet' };
    payRow = { payment_id: 'PAY-1', status: 'rejected' };
    r = await record();
    assert.match(r.text, /Already rejected/);
    assert.match(r.text, /❌ Rejected by Ajeet/, r.text);

    // No PaymentRequests row (or a read failure) → the record still renders.
    live = { ...live, status: 'approved' };
    paymentRequestsRepo.findByApprovalRequestId = async () => { throw new Error('sheet down'); };
    r = await record();
    assert.match(r.text, /Already approved/);
    assert.ok(!/With finance|Paid by/.test(r.text));
  } finally {
    approvalQueueRepository.getAllPending = orig;
    approvalQueueRepository.getByRequestId = origLive;
    paymentRequestsRepo.findByApprovalRequestId = origFind;
    sessionStore.clear(ADMIN);
  }
});
