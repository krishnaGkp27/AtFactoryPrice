'use strict';

/**
 * FIX-TRANSFERS (11-Nov-2026) — three faults found while the staff test
 * script was checked against the code, each pinned here through the real
 * controller:
 *
 *  1. ❌ Cancel on the typed-transfer preload card and inside the Transfer
 *     Stock wizard drew nothing: the session was ended first and the reply
 *     needed a live session to draw into, so the card stayed on screen with
 *     its buttons although the order was dropped.
 *  2. The inert chips on transfer cards (`trf:noop` — the 🔒 "you reported
 *     it" lock, the page counter, the calendar's blank cells) answered
 *     "This transfer session has expired …" whenever no transfer session
 *     was live.
 *  3. A typed bale number matched any bale whose number ENDS in the typed
 *     digits with no preference for the bale that IS that number: typing
 *     832 could load 1832.
 */

process.env.ADMIN_IDS = '777';
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
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const transferFlow = require(path.join(SRC, 'flows/transferFlow'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
auditLogRepository.append = async () => {};
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
  { user_id: '777', name: 'Ajeet', role: 'admin', status: 'active' },
];

/** One bale row (a transfer counts bales, so one row per bale is enough). */
function bale(pkg, extra = {}) {
  return {
    packageNo: pkg, thanNo: 1, design: extra.design || '9006', shade: extra.shade || '3',
    warehouse: extra.warehouse || 'Lagos', status: extra.status || 'available',
    yards: 100, soldTo: extra.soldTo || '',
  };
}
let STORE = [];
inventoryRepository.getAll = async () => STORE.map((r) => ({ ...r }));
const BASE = [bale('997'), bale('999'), bale('P9', { warehouse: 'Kano office' })];

const CANCELLED = '🚚 Transfer cancelled — nothing was moved.';
const EXPIRED = /transfer session has expired/i;

function msg(text, uid = '4242') {
  return { from: { id: uid }, chat: { id: uid }, text };
}
const drawn = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
const kbOf = (call) => (((call.args.opts || {}).reply_markup || {}).inline_keyboard || []).flat();

/** The cancelled line landed ON the card (an edit of `mid`), with the way out and no live transfer chip. */
function assertCancelledOn(bot, mid, label) {
  const calls = drawn(bot);
  assert.equal(calls.length, 1, `${label}: exactly one screen drawn`);
  const [call] = calls;
  assert.equal(call.method, 'editMessageText', `${label}: the card itself is replaced, no second message`);
  assert.equal(call.args.opts.message_id, mid, `${label}: the edit lands on the card`);
  assert.equal(call.args.text, CANCELLED, label);
  const kb = kbOf(call);
  assert.ok(kb.some((b) => b.text === '🏠 Menu' && b.callback_data === 'act:__back__'), `${label}: 🏠 Menu offered`);
  assert.ok(!kb.some((b) => String(b.callback_data).startsWith('trf:')), `${label}: no transfer button survives`);
}

/* ── 1. Cancel draws the cancelled line ─────────────────────────────────── */

test('Cancel on the typed-transfer preload card replaces the card and ends the session', async () => {
  STORE = BASE.slice();
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Transfer 997, 999 to kano'));
  const session = sessionStore.get('4242');
  assert.equal(session && session.step, 'preload_review');
  const mid = session.flowMessageId;
  assert.ok(mid, 'the preload card is the anchored message');
  const preload = drawn(bot).pop();
  assert.ok(kbOf(preload).some((b) => b.text === '❌ Cancel' && b.callback_data === 'trf:cancel'), 'the card carries ❌ Cancel');

  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('trf:cancel', '4242', mid));
  assertCancelledOn(bot2, mid, 'preload card');
  assert.equal(sessionStore.get('4242'), null, 'the session is over');

  // The order is gone for good: a late Continue on a stale copy starts nothing.
  const bot3 = createFakeBot();
  await controller.handleCallbackQuery(bot3, cb('trf:pl:go', '4242', mid));
  assert.match(bot3.allText(), EXPIRED);
  assert.equal(sessionStore.get('4242'), null);
});

test('Cancel inside the Transfer Stock wizard replaces the card — first screen and a later one', async () => {
  STORE = BASE.slice();

  // First screen (From which warehouse?) — its own ❌ Cancel row.
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:transfer_stock', '777', 5));
  assert.match(bot.allText(), /From which warehouse\?/);
  const mid = sessionStore.get('777').flowMessageId;
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('trf:cancel', '777', mid));
  assertCancelledOn(bot2, mid, 'source screen');
  assert.equal(sessionStore.get('777'), null, 'the session is over');

  // Deep in the wizard (How many bales?) — the ⬅ Back · ❌ Cancel row.
  const bot3 = createFakeBot();
  await controller.handleCallbackQuery(bot3, cb('act:transfer_stock', '777', 5));
  const whs = sessionStore.get('777')._whs;
  await controller.handleCallbackQuery(bot3, cb(`trf:wh:${whs.indexOf('Lagos')}`, '777', 5));
  await controller.handleCallbackQuery(bot3, cb('trf:dg:0', '777', 5));
  await controller.handleCallbackQuery(bot3, cb('trf:sh:0', '777', 5));
  assert.match(bot3.allText(), /How many bales to transfer\?/);
  const mid3 = sessionStore.get('777').flowMessageId;
  const bot4 = createFakeBot();
  await controller.handleCallbackQuery(bot4, cb('trf:cancel', '777', mid3));
  assertCancelledOn(bot4, mid3, 'quantity screen');
  assert.equal(sessionStore.get('777'), null, 'the session is over');
});

test('Cancel drops the order even when Telegram refuses the draw', async () => {
  STORE = BASE.slice();
  sessionStore.clear('4242');
  await controller.handleMessage(createFakeBot(), msg('Transfer 997, 999 to kano'));
  const mid = sessionStore.get('4242').flowMessageId;
  const bot = createFakeBot();
  const down = async () => { throw new Error('ETELEGRAM: 502 Bad Gateway'); };
  bot.editMessageText = down;
  bot.sendMessage = down;
  try { await controller.handleCallbackQuery(bot, cb('trf:cancel', '4242', mid)); } catch (_) { /* the draw failed — that is the point */ }
  assert.equal(sessionStore.get('4242'), null, 'the session is over all the same');
});

test('Cancel tapped while a Send is still being written is ignored — the receipt lands, never a cancelled line over an order that went out', async () => {
  STORE = BASE.slice();
  sessionStore.clear('4242');
  const transferService = require(path.join(SRC, 'services/transferService'));
  const real = transferService.createTransferRequest;
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Transfer 997, 999 to kano'));
  const mid = sessionStore.get('4242').flowMessageId;
  await controller.handleCallbackQuery(bot, cb('trf:pl:go', '4242', mid));
  assert.equal(sessionStore.get('4242').step, 'confirm');

  try {
    // The write is in flight (a slow sheet, the write governor waiting).
    let release;
    const gate = new Promise((r) => { release = r; });
    transferService.createTransferRequest = async (...a) => { await gate; return real(...a); };
    const sendBot = createFakeBot();
    const sending = controller.handleCallbackQuery(sendBot, cb('trf:send', '4242', mid));
    await new Promise((r) => setImmediate(r));

    const cancelBot = createFakeBot();
    await controller.handleCallbackQuery(cancelBot, cb('trf:cancel', '4242', mid));
    assert.equal(drawn(cancelBot).length, 0, 'nothing is drawn — the order cannot be recalled');
    assert.equal((sessionStore.get('4242') || {}).step, 'confirm', 'the session stays for the send to finish');

    release();
    await sending;
    const mine = drawn(sendBot).filter((c) => String(c.args.chatId || (c.args.opts || {}).chat_id) === '4242');
    assert.equal(mine.length, 1, 'the requester gets exactly one screen: the receipt');
    assert.equal(mine[0].method, 'editMessageText');
    assert.equal(mine[0].args.opts.message_id, mid, 'the receipt lands on the card');
    assert.match(mine[0].args.text, /^✅ \*Transfer .+ sent\*/);
    assert.ok(drawn(sendBot).some((c) => String(c.args.chatId) === 'abdul' && /please dispatch/.test(c.args.text)), 'the order did go out');
    assert.equal(sessionStore.get('4242'), null);

    // A send that FAILS re-arms the card, and Cancel works again.
    await controller.handleMessage(createFakeBot(), msg('Transfer 997, 999 to kano'));
    const mid2 = sessionStore.get('4242').flowMessageId;
    await controller.handleCallbackQuery(createFakeBot(), cb('trf:pl:go', '4242', mid2));
    transferService.createTransferRequest = async () => { throw new Error('sheet refused'); };
    const failBot = createFakeBot();
    await controller.handleCallbackQuery(failBot, cb('trf:send', '4242', mid2));
    assert.match(failBot.allText(), /Could not create the transfer: sheet refused/);
    const bot2 = createFakeBot();
    await controller.handleCallbackQuery(bot2, cb('trf:cancel', '4242', mid2));
    assertCancelledOn(bot2, mid2, 'after a failed send');
    assert.equal(sessionStore.get('4242'), null);
  } finally {
    transferService.createTransferRequest = real;
    sessionStore.clear('4242');
  }
});

/* ── 2. The inert chip stays quiet ──────────────────────────────────────── */

test('trf:noop with no live transfer session: a quiet acknowledgement, nothing sent, nothing changed', async () => {
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('trf:noop', '777', 5));
  assert.equal(drawn(bot).length, 0, 'no message, no edit');
  assert.doesNotMatch(bot.allText(), EXPIRED);
  const acks = bot.callsTo('answerCallbackQuery');
  assert.equal(acks.length, 1, 'the tap is acknowledged once');
  assert.ok(!(acks[0].args.opts && acks[0].args.opts.text), 'no toast text, no alert');
  assert.equal(sessionStore.get('777'), null, 'no session appears');

  // Another flow's live session is left exactly as it was.
  sessionStore.set('777', { type: 'some_other_flow', step: 'typing', flowMessageId: 41 });
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('trf:noop', '777', 5));
  assert.equal(drawn(bot2).length, 0);
  const still = sessionStore.get('777');
  assert.deepEqual({ type: still.type, step: still.step, flowMessageId: still.flowMessageId },
    { type: 'some_other_flow', step: 'typing', flowMessageId: 41 });
  sessionStore.clear('777');
});

test('the 🔒 "you reported it" lock on the receipt card is that inert chip', async () => {
  const row = {
    requestId: 'TR-20261111-001', user: 'abdul', status: 'pending', createdAt: '2026-11-10T08:00:00.000Z',
    actionJSON: {
      action: 'transfer_stock', from: 'Lagos', to: 'Kano office', stage: 'in_transit',
      dispatcher: 'abdul', receiver: 'musa',
      lines: [{ design: '9006', shade: '3', qty: 2 }],
      dispatched: [{ design: '9006', shade: '3', qty: 2, bales: ['997', '999'] }],
      bales: ['997', '999'], departedAt: '2026-11-10',
      pendingReceipt: 1,
      receiptReports: [{ n: 1, by: '777', at: '2026-11-11T08:00:00.000Z', bales: ['997'], status: 'pending' }],
    },
  };
  const names = { abdul: 'Abdul', musa: 'Musa', 777: 'Ajeet' };
  const mine = await transferFlow._internals.receiptReviewCard(row.requestId, row, names, '777');
  const lock = mine.rows.flat().find((b) => /^🔒 Receipt 1/.test(b.text));
  assert.ok(lock, 'the reporter sees the lock, not a confirm button');
  assert.equal(lock.callback_data, 'trf:noop');
  assert.ok(!mine.rows.flat().some((b) => /^trf:rcok:/.test(b.callback_data)), 'the reporter gets no 🛂 Confirm');
});

/* ── 3. The bale that IS the typed number wins ──────────────────────────── */

test('exact beats ending: typing 832 loads 832, never 1832 — whichever row comes first', async () => {
  // 1832 sits ABOVE 832 in the sheet: "first hit in the store" used to take it.
  STORE = [bale('1832', { shade: '5' }), bale('832'), ...BASE];
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Transfer 832 to kano'));
  const text = bot.allText();
  assert.match(text, /preloaded 1 of 1 typed bale\(s\)/);
  assert.match(text, /📦 Bales: 832\n/);
  assert.doesNotMatch(text, /1832/, 'the longer number is not on the card');
  assert.deepEqual(sessionStore.get('4242').lines, [{ design: '9006', shade: '3', qty: 1, bales: ['832'] }]);
  sessionStore.clear('4242');
});

test('exact beats ending across stores: 832 is in another store → skipped by name, 1832 on the source shelf is NOT loaded in its place', async () => {
  STORE = [bale('1832'), bale('832', { warehouse: 'IDUMOTA' }), ...BASE];
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Transfer 832, 997, 999 to kano'));
  const text = bot.allText();
  assert.match(text, /preloaded 2 of 3 typed bale\(s\)/);
  assert.match(text, /From \*Lagos\*/);
  assert.match(text, /832 — in IDUMOTA, not Lagos — start a separate transfer \(skipped\)/);
  assert.doesNotMatch(text, /1832/);
  assert.deepEqual(sessionStore.get('4242').lines, [{ design: '9006', shade: '3', qty: 2, bales: ['997', '999'] }]);
  sessionStore.clear('4242');
});

test('exact beats ending when the exact bale is gone: 832 sold → skipped with its reason, 1832 is NOT loaded in its place', async () => {
  STORE = [bale('1832'), bale('832', { status: 'sold', soldTo: 'CJE' }), ...BASE];
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Transfer 832, 997 to kano'));
  const text = bot.allText();
  assert.match(text, /preloaded 1 of 2 typed bale\(s\)/);
  assert.match(text, /832 — already sold to CJE \(skipped\)/);
  assert.doesNotMatch(text, /1832/);
  assert.deepEqual(sessionStore.get('4242').lines, [{ design: '9006', shade: '3', qty: 1, bales: ['997'] }]);
  sessionStore.clear('4242');
});

test('ending match still works alone: no bale is exactly 832 → 1832 loads, as before', async () => {
  STORE = [bale('1832'), ...BASE];
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Transfer 832 to kano'));
  assert.match(bot.allText(), /preloaded 1 of 1 typed bale\(s\)/);
  assert.match(bot.allText(), /📦 Bales: 1832\n/);
  assert.deepEqual(sessionStore.get('4242').lines, [{ design: '9006', shade: '3', qty: 1, bales: ['1832'] }]);
  sessionStore.clear('4242');
});

test('two ending candidates and no exact bale: the first one on the source shelf loads, as before', async () => {
  STORE = [bale('2832', { shade: '7' }), bale('1832'), ...BASE];
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Transfer 832 to kano'));
  assert.match(bot.allText(), /preloaded 1 of 1 typed bale\(s\)/);
  assert.deepEqual(sessionStore.get('4242').lines, [{ design: '9006', shade: '7', qty: 1, bales: ['2832'] }]);
  sessionStore.clear('4242');
});
