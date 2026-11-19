'use strict';

/**
 * REQ-1 — 📨 My Requests, through the REAL controller.
 *
 * Owner, 19-Nov-2026: "every employee admin can see the list of requests
 * for his own, along with the other employees, with the meaningful chips".
 *
 *   · an employee sees ONLY the requests they raised — a crafted or
 *     forwarded button cannot widen that;
 *   · an admin switches 🙋 Mine · 👥 Everyone · 👤 By person;
 *   · ⏳ Waiting · ✅ Approved · ❌ Rejected chips carry the counts;
 *   · a number chip opens the request's status card, with 🔔 Remind
 *     approvers while it waits;
 *   · the tile is in every menu, beside 📋 My Tasks.
 *
 * Nothing is stored: every screen is read from the ApprovalQueue at the tap.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242,5151';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const activityRegistry = require(path.join(SRC, 'services/activityRegistry'));
const myRequests = require(path.join(SRC, 'services/myRequests'));
const myRequestsFlow = require(path.join(SRC, 'flows/myRequestsFlow'));

const NOW = Date.now();
const ago = (hours) => new Date(NOW - hours * 3600000).toISOString();
const ABDUL = '4242';
const YARIMA = '5151';
const KRISHNA = '777';

let QUEUE;
let settings;
function seed() {
  settings = {};
  QUEUE = [
    // Abdul: two waiting (one with a first signature), one approved, one rejected, one decided long ago
    { requestId: 'aaaa1111-0000-4000-8000-000000000001', user: ABDUL, status: 'pending', createdAt: ago(50), actionJSON: { action: 'sale_bundle', customer: 'ABBA', items: [{ type: 'package', packageNo: '771' }], totalYards: 150 } },
    { requestId: 'bbbb2222-0000-4000-8000-000000000002', user: ABDUL, status: 'pending', createdAt: ago(3), actionJSON: { action: 'return_bundle', customer: 'CJE', approvals: [{ id: '888', at: ago(1) }], signoffs: [{ id: '888', name: 'Musa', at: ago(1) }] } },
    { requestId: 'cccc3333-0000-4000-8000-000000000003', user: ABDUL, status: 'approved', createdAt: ago(30), resolvedAt: ago(20), approver: 'Musa', actionJSON: { action: 'add_contact', name: 'Mariam Salisu', type: 'customer' } },
    { requestId: 'dddd4444-0000-4000-8000-000000000004', user: ABDUL, status: 'rejected', createdAt: ago(40), resolvedAt: ago(26), approver: 'Krishna', actionJSON: { action: 'update_price', design: '9006', price: 1500, rejectNote: 'Wrong design' } },
    { requestId: '01d00000-0000-4000-8000-000000000005', user: ABDUL, status: 'approved', createdAt: ago(24 * 40), resolvedAt: ago(24 * 39), approver: 'Musa', actionJSON: { action: 'add_bank', bank_name: 'UBA' } },
    // Yarima: one waiting supply request at Dispatch, one transfer on the road
    { requestId: 'eeee5555-0000-4000-8000-000000000006', user: YARIMA, status: 'pending', createdAt: ago(5), actionJSON: { action: 'supply_request', customer: 'Kafaya', warehouse: 'IDUMOTA', stage: 'dispatch_review' } },
    { requestId: 'ffff6666-0000-4000-8000-000000000007', user: YARIMA, status: 'pending', createdAt: ago(80), actionJSON: { action: 'transfer_stock', toWarehouse: 'Kano office', stage: 'in_transit' } },
    // Krishna (admin): one waiting
    { requestId: 'abcd7777-0000-4000-8000-000000000008', user: KRISHNA, status: 'pending', createdAt: ago(2), actionJSON: { action: 'add_bank', bank_name: 'Zenith — AFP' } },
    // not requests: no action / no id
    { requestId: 'dead0000-0000-4000-8000-000000000009', user: ABDUL, status: 'pending', createdAt: ago(1), actionJSON: {} },
    { requestId: '', user: ABDUL, status: 'pending', createdAt: ago(1), actionJSON: { action: 'add_bank' } },
  ];
}
approvalQueueRepository.getAllWithRowIndex = async () => QUEUE.map((q, i) => ({ ...q, rowIndex: i + 2 }));
approvalQueueRepository.getByRequestId = async (id) => QUEUE.find((q) => q.requestId === id) || null;
settingsRepository.getAll = async () => ({ ...settingsRepository.DEFAULTS, ...settings });
approvalCards.resolveUserLabel = async (id) => ({ 777: 'Krishna', 888: 'Musa', 4242: 'Abdul', 5151: 'Yarima' }[String(id)] || 'Unknown');

const cq = (uid, data) => ({ id: `cq-${data}`, data, from: { id: Number(uid) }, message: { chat: { id: Number(uid) }, message_id: 77 } });
const card = (bot) => bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').at(-1);
const text = (bot) => String(card(bot).args.text || '');
const rowsOf = (bot) => card(bot).args.opts.reply_markup.inline_keyboard.map((r) => r.map((b) => `${b.text}|${b.callback_data}`));
const chips = (bot) => rowsOf(bot).flat();

test.beforeEach(seed);

/* ── the tile ────────────────────────────────────────────────────────── */

test('the tile is 📨 My Requests, beside My Tasks, and is in an employee\'s menu without any department', async () => {
  const a = activityRegistry.getActivity('my_requests');
  assert.deepEqual([a.label, a.icon, a.hub, a.callback], ['My Requests', '📨', 'planning', 'act:my_requests']);
  assert.equal(activityRegistry.getActivity('my_tasks').hub, 'planning');
  const src = require('fs').readFileSync(path.join(SRC, 'controllers/telegramController.js'), 'utf8');
  assert.equal(src.split("filterByCodes(['payments', 'my_requests'])").length - 1, 2, 'injected in the greeting menu AND in the hub screen');
});

/* ── an employee ─────────────────────────────────────────────────────── */

test('an employee opens on their own WAITING requests, newest first, with where each sits', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(ABDUL, 'act:my_requests'));
  assert.equal(text(bot), [
    '📨 My requests · ⏳ Waiting',
    '',
    '1. Return goods · CJE',
    '    R-BBBB · 3h · 🔏 1 of 2 signed',
    '2. Sale bale · ABBA · 1B · 150 yd',
    '    R-AAAA · 2d · 🛂 with an admin',
  ].join('\n'));
  assert.deepEqual(rowsOf(bot), [
    ['⏳ Waiting · 2 ✓|myr:l:m:w:0', '✅ Approved · 1|myr:l:m:a:0', '❌ Rejected · 1|myr:l:m:r:0'],
    ['1|myr:o:m:w:0:bbbb2222-0000-4000-8000-000000000002', '2|myr:o:m:w:0:aaaa1111-0000-4000-8000-000000000001'],
    ['🏠 Menu|act:__back__'],
  ], 'no scope chips for an employee; junk rows are not requests');
});

test('the Approved and Rejected chips list what was decided in the window, with who and when', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(ABDUL, 'myr:l:m:a:0'));
  assert.match(text(bot), /^📨 My requests · ✅ Approved\nDecided in the last 7 days\.\n\n1\. Add contact · Mariam Salisu\n {4}R-CCCC · ✅ \d{2}-[A-Z][a-z]{2} \d{2}:\d{2} · Musa$/);
  assert.ok(!text(bot).includes('R-01D0'), 'a request decided 39 days ago is outside the 7-day window');

  await controller.handleCallbackQuery(bot, cq(ABDUL, 'myr:l:m:r:0'));
  assert.match(text(bot), /1\. .*9006.*\n {4}R-DDDD · ❌ .* · Krishna$/);

  settings = { APPROVALS_DECIDED_DAYS: 0 };
  await controller.handleCallbackQuery(bot, cq(ABDUL, 'myr:l:m:a:0'));
  assert.ok(text(bot).includes('R-01D0'), '0 = every decided request');
  assert.ok(!text(bot).includes('Decided in the last'));
});

test('an employee cannot widen the scope: Everyone and another person\'s chip still show only their own', async () => {
  for (const crafted of ['myr:l:e:w:0', `myr:l:u${YARIMA}:w:0`, `myr:p:w`]) {
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cq(ABDUL, crafted));
    assert.match(text(bot), /^📨 My requests · ⏳ Waiting\n/, crafted);
    assert.ok(!/Kafaya|Kano office|Zenith/.test(text(bot)), `${crafted}: nobody else's request is shown`);
    assert.ok(!chips(bot).some((c) => /Everyone|By person/.test(c)), `${crafted}: no scope chips`);
  }
});

test('an employee cannot open someone else\'s request by its id', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(ABDUL, 'myr:o:e:w:0:eeee5555-0000-4000-8000-000000000006'));
  assert.match(text(bot), /^📨 My requests · ⏳ Waiting\n/);
  assert.match(text(bot), /\n\nThat request is no longer on this list\.$/);
  assert.ok(!text(bot).includes('Kafaya'));
});

test('a number chip opens the status card; a waiting request of one\'s own carries 🔔 Remind approvers', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(ABDUL, 'myr:o:m:w:0:bbbb2222-0000-4000-8000-000000000002'));
  const t = text(bot);
  assert.match(t, /^📋 Request R-BBBB\nReturn goods · CJE\nRaised by Abdul · .* · 3h waiting\n/);
  assert.match(t, /🛂 Waiting on approval · 1 of 2 signed\n✅ Musa · /);
  assert.deepEqual(rowsOf(bot), [
    ['🔔 Remind approvers|apg:nudge:bbbb2222-0000-4000-8000-000000000002'],
    ['⬅ Back to list|myr:l:m:w:0', '🏠 Menu|act:__back__'],
  ]);

  // a decided request: the outcome, no reminder
  await controller.handleCallbackQuery(bot, cq(ABDUL, 'myr:o:m:r:0:dddd4444-0000-4000-8000-000000000004'));
  assert.match(text(bot), /❌ Rejected by Krishna · .*\n📝 Wrong design/);
  assert.deepEqual(rowsOf(bot), [['⬅ Back to list|myr:l:m:r:0', '🏠 Menu|act:__back__']]);
});

/* ── an admin ────────────────────────────────────────────────────────── */

test('an admin opens on their own, with the three scope chips', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(KRISHNA, 'act:my_requests'));
  assert.match(text(bot), /^📨 My requests · ⏳ Waiting\n\n1\. Add bank · Zenith — AFP\n {4}R-ABCD · 2h · /);
  assert.deepEqual(rowsOf(bot)[1], ['🙋 Mine ✓|myr:l:m:w:0', '👥 Everyone|myr:l:e:w:0', '👤 By person|myr:p:w']);
});

test('👥 Everyone lists every person\'s requests and names who raised each; stages read in the house words', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(KRISHNA, 'myr:l:e:w:0'));
  const t = text(bot);
  assert.match(t, /^📨 Everyone's requests · ⏳ Waiting\n/);
  assert.match(t, /\n {4}R-ABCD · Krishna · 2h · /);
  assert.match(t, /\n {4}R-BBBB · Abdul · 3h · 🔏 1 of 2 signed/);
  assert.match(t, /\n {4}R-EEEE · Yarima · 5h · ⏳ Waiting on Dispatch to confirm/);
  assert.match(t, /\n {4}R-FFFF · Yarima · 3d · 🚚 on the road, with the receiver/);
  assert.deepEqual(rowsOf(bot)[0], ['⏳ Waiting · 5 ✓|myr:l:e:w:0', '✅ Approved · 1|myr:l:e:a:0', '❌ Rejected · 1|myr:l:e:r:0']);
  assert.deepEqual(rowsOf(bot)[1], ['🙋 Mine|myr:l:m:w:0', '👥 Everyone ✓|myr:l:e:w:0', '👤 By person|myr:p:w']);
  // newest first
  assert.deepEqual([...t.matchAll(/R-[A-Z]{4}/g)].map((m) => m[0]), ['R-ABCD', 'R-BBBB', 'R-EEEE', 'R-AAAA', 'R-FFFF']);
});

test('👤 By person: one chip per person with a count; a tap lists that person alone', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(KRISHNA, 'myr:p:w'));
  assert.equal(text(bot), '📨 Requests by person · ⏳ Waiting\n\nTap a person.');
  assert.deepEqual(rowsOf(bot), [
    [`👤 Abdul · 2|myr:l:u${ABDUL}:w:0`, `👤 Yarima · 2|myr:l:u${YARIMA}:w:0`],
    [`👤 Krishna · 1|myr:l:u${KRISHNA}:w:0`],
    ['⬅ Back|myr:l:e:w:0', '🏠 Menu|act:__back__'],
  ]);
  await controller.handleCallbackQuery(bot, cq(KRISHNA, `myr:l:u${YARIMA}:w:0`));
  assert.match(text(bot), /^📨 Requests of Yarima · ⏳ Waiting\n/);
  assert.ok(!/R-AAAA|R-ABCD/.test(text(bot)));
  assert.deepEqual(rowsOf(bot)[1], ['🙋 Mine|myr:l:m:w:0', '👥 Everyone|myr:l:e:w:0', '👤 By person ✓|myr:p:w']);
});

test('an admin opening someone else\'s waiting request gets the reminder and a door to Approvals', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(KRISHNA, 'myr:o:e:w:0:eeee5555-0000-4000-8000-000000000006'));
  assert.match(text(bot), /^📋 Request R-EEEE\n.*Kafaya.*\nRaised by Yarima · /);
  assert.match(text(bot), /\n⏳ Waiting on Dispatch to confirm$/, 'a supply request says its own stage');
  assert.deepEqual(rowsOf(bot), [
    ['🔔 Remind approvers|apg:nudge:eeee5555-0000-4000-8000-000000000006'],
    ['🛂 Open Approvals|act:approvals_inbox'],
    ['⬅ Back to list|myr:l:e:w:0', '🏠 Menu|act:__back__'],
  ]);
});

/* ── paging, limits, failure ─────────────────────────────────────────── */

test('eight a page with ◀ Back / Next ▶; number chips four to a row; every callback fits 64 bytes', async () => {
  QUEUE = Array.from({ length: 19 }, (_, i) => ({
    requestId: `3f2b8c1e-7a44-4d0e-9c11-${String(i).padStart(12, '0')}`, user: ABDUL, status: 'pending', createdAt: ago(i + 1),
    actionJSON: { action: 'add_bank', bank_name: `Bank ${i}` },
  }));
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(KRISHNA, `myr:l:u${ABDUL}:w:1`));
  assert.match(text(bot), /\n9\. Add bank · Bank 8\n/);
  assert.match(text(bot), /\n\npage 2 of 3$/);
  const r = rowsOf(bot);
  assert.deepEqual(r[2].map((c) => c.split('|')[0]), ['9', '10', '11', '12']);
  assert.deepEqual(r[3].map((c) => c.split('|')[0]), ['13', '14', '15', '16']);
  assert.deepEqual(r[4], [`◀ Back|myr:l:u${ABDUL}:w:0`, `Next ▶|myr:l:u${ABDUL}:w:2`]);
  for (const c of chips(bot)) assert.ok(Buffer.byteLength(c.split('|').at(-1)) <= 64, c);

  // a UUID that had to be cut on the button still opens its own request
  const cb = myRequestsFlow._internals.openCb(`u${'9'.repeat(12)}`, 'w', 12, QUEUE[4].requestId);
  assert.ok(Buffer.byteLength(cb) <= 64);
  await controller.handleCallbackQuery(bot, cq(KRISHNA, cb.replace(`u${'9'.repeat(12)}`, `u${ABDUL}`)));
  assert.match(text(bot), /^📋 Request /);
  assert.match(text(bot), /Bank 4/);
});

test('an empty group says so; an unreadable queue offers a retry, never a blank screen', async () => {
  QUEUE = [];
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(ABDUL, 'act:my_requests'));
  assert.equal(text(bot), '📨 My requests · ⏳ Waiting\n\nNothing is waiting.');
  assert.deepEqual(rowsOf(bot)[0], ['⏳ Waiting · 0 ✓|myr:l:m:w:0', '✅ Approved · 0|myr:l:m:a:0', '❌ Rejected · 0|myr:l:m:r:0']);

  const real = approvalQueueRepository.getAllWithRowIndex;
  approvalQueueRepository.getAllWithRowIndex = async () => { throw new Error('quota'); };
  try {
    await controller.handleCallbackQuery(bot, cq(ABDUL, 'myr:l:m:a:0'));
    assert.match(text(bot), /⚠️ The requests could not be read just now\./);
    assert.deepEqual(rowsOf(bot), [['🔁 Try again|myr:l:m:a:0'], ['🏠 Menu|act:__back__']]);
  } finally { approvalQueueRepository.getAllWithRowIndex = real; }
});

/* ── the pure half ───────────────────────────────────────────────────── */

test('scope rule: a non-admin is always held to their own, whatever is asked', () => {
  assert.equal(myRequests.effectiveScope('e', false), 'm');
  assert.equal(myRequests.effectiveScope('u777', false), 'm');
  assert.equal(myRequests.effectiveScope('e', true), 'e');
  assert.equal(myRequests.effectiveScope('u-100123', true), 'u-100123');
  assert.equal(myRequests.effectiveScope('zzz', true), 'm');
  assert.equal(myRequests.effectiveScope(undefined, true), 'm');
});

test('status groups: pending waits, approved is approved, every other word is the rejected group', () => {
  assert.deepEqual(['pending', 'Pending ', 'approved', 'rejected', 'cancelled', 'reverted', ''].map((s) => myRequests.statusKey({ status: s })),
    ['w', 'w', 'a', 'r', 'r', 'r', 'w']);
});

test('where a waiting request sits: signatures, a transfer\'s stage, a supply request\'s stage', () => {
  const w = (aj, required) => myRequests.waitingWords({ actionJSON: aj }, required);
  assert.equal(w({ action: 'add_bank' }, 1), '🛂 with an admin');
  assert.equal(w({ action: 'return_bundle' }, 2), '🔏 0 of 2 signed');
  assert.equal(w({ action: 'transfer_stock', stage: 'requested' }), '⏳ with the dispatcher');
  assert.equal(w({ action: 'transfer_stock', stage: 'admin_review' }), '🛂 with an admin to approve');
  assert.equal(w({ action: 'transfer_stock', stage: 'in_transit' }), '🚚 on the road, with the receiver');
  assert.equal(w({ action: 'supply_request', stage: 'admin_review' }), '🛂 Waiting on an admin to approve');
});

test('a transfer\'s decided words are received / closed, not approved / rejected', () => {
  const line = (status) => myRequests.rowLines({ requestId: '7777aaaa-0000-4000-8000-00000000000a', status, resolvedAt: ago(2), actionJSON: { action: 'transfer_stock', toWarehouse: 'Kano office' } }, 1)[1];
  assert.match(line('approved'), /✅ received /);
  assert.match(line('rejected'), /❌ closed /);
});
