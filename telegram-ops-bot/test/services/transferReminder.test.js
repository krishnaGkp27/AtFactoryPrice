'use strict';
/**
 * TRF-20 (4/8) — a stuck transfer nags its holder hourly and, past
 * TRANSFER_STALE_DAYS, every admin. Drives the sweep against a stubbed
 * open-transfer list; the cards are the flow's real dispatcher / receiver /
 * review cards.
 */
process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = 'abdul,musa';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const SRC = path.join(__dirname, '../../src');
const { createFakeBot } = require('../helpers/fakeBot');
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const reminder = require(path.join(SRC, 'services/transferReminder'));

const NOW = Date.parse('2026-09-22T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
let rows = [];
approvalQueueRepository.getAllPending = async () => rows.map((r) => JSON.parse(JSON.stringify(r)));
approvalQueueRepository.getByRequestId = async (id) => { const r = rows.find((x) => x.requestId === id); return r ? JSON.parse(JSON.stringify(r)) : null; };
let settings = { APPROVAL_REMINDER_HOURS: 6 };
settingsRepository.getAll = async () => ({ ...settings });
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active' },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active' },
];
const ten = [{ design: '9031-D', shade: '1', qty: 10 }];
const trf = (id, createdAt, stage, extra = {}) => ({
  requestId: id, user: '4242', status: 'pending', createdAt,
  actionJSON: { action: 'transfer_stock', from: 'Lagos', to: 'Kano office', lines: ten, dispatcher: 'abdul', receiver: 'musa', stage, ...extra },
});
const to = (bot, id) => bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === String(id));

test('requested → the dispatcher gets the card again with its live buttons; fresh rows and non-transfers are skipped', async () => {
  reminder._resetForTests();
  rows = [
    trf('TR-20260918-002', ago(30), 'requested'),
    trf('TR-20260922-001', ago(0.05), 'requested'),            // 3 minutes old
    { requestId: 'sale-1', user: '4242', status: 'pending', createdAt: ago(30), actionJSON: { action: 'sale_bundle' } },
  ];
  const bot = createFakeBot();
  assert.equal(await reminder.sweep(bot, { now: NOW }), 1);
  const cards = to(bot, 'abdul');
  assert.equal(cards.length, 1);
  assert.match(cards[0].args.text, /Reminder — this transfer is still waiting/);
  assert.match(cards[0].args.text, /18Sep·02/);
  const cbs = cards[0].args.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(cbs.includes('trf:acc:TR-20260918-002') && cbs.includes('trf:dec:TR-20260918-002'), `dispatcher buttons, got ${cbs}`);
  assert.equal(to(bot, '777').length, 0, 'one day old: no escalation yet');
  assert.equal(to(bot, 'musa').length, 0, 'the receiver has nothing to do yet');
});

test('window memory: a second sweep inside the window sends nothing; after it, the card comes again', async () => {
  reminder._resetForTests();
  rows = [trf('TR-20260918-002', ago(30), 'requested')];
  const bot = createFakeBot();
  assert.equal(await reminder.sweep(bot, { now: NOW }), 1);
  assert.equal(await reminder.sweep(bot, { now: NOW + 3600000 }), 0);
  assert.equal(await reminder.sweep(bot, { now: NOW + 7 * 3600000 }), 1);
});

test('in transit → the receiver; parked → every admin\'s review card', async () => {
  reminder._resetForTests();
  rows = [
    trf('TR-20260918-003', ago(30), 'in_transit', { bales: ['1', '2'] }),
    trf('TR-20260810-001', ago(48), 'admin_review', { pendingDispatch: { submittedBy: 'abdul', submittedAt: ago(47), bales: ['1'] } }),
  ];
  const bot = createFakeBot();
  assert.equal(await reminder.sweep(bot, { now: NOW }), 2);
  const rcv = to(bot, 'musa');
  assert.equal(rcv.length, 1, 'receiver card');
  assert.ok(rcv[0].args.opts.reply_markup.inline_keyboard.flat().some((b) => String(b.callback_data).startsWith('trf:rcv:')), 'Received button rides along');
  assert.ok(to(bot, '777').length >= 1 && to(bot, '888').length >= 1, 'both admins get the parked review card');
  assert.equal(to(bot, 'abdul').length, 0, 'the dispatcher is not the holder of either');
});

test('past TRANSFER_STALE_DAYS every admin is told, with an Open button; 0 turns it off', async () => {
  reminder._resetForTests();
  rows = [trf('TR-20260918-002', ago(5 * 24), 'requested')];
  settings = { APPROVAL_REMINDER_HOURS: 6 };           // default TRANSFER_STALE_DAYS = 3
  let bot = createFakeBot();
  await reminder.sweep(bot, { now: NOW });
  for (const adm of ['777', '888']) {
    const m = to(bot, adm);
    assert.equal(m.length, 1, `admin ${adm} escalated`);
    assert.match(m[0].args.text, /18Sep·02 · 🔴 LAG▸KAN · 10B\* has waited \*5d\* on Abdul to dispatch/);
    assert.ok(m[0].args.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'trf:lcard:TR-20260918-002'), 'Open button');
  }
  assert.equal(to(bot, 'abdul').length, 1, 'the holder got the card, not the escalation');

  reminder._resetForTests();
  settings = { APPROVAL_REMINDER_HOURS: 6, TRANSFER_STALE_DAYS: 0 };
  bot = createFakeBot();
  await reminder.sweep(bot, { now: NOW });
  assert.equal(to(bot, '777').length, 0, 'escalation off');
  assert.equal(to(bot, 'abdul').length, 1, 'the holder still hears it');
});

test('APPROVAL_REMINDER_HOURS=0 disables the transfer sweep too; oldest first under the cap', async () => {
  reminder._resetForTests();
  settings = { APPROVAL_REMINDER_HOURS: 0 };
  rows = [trf('TR-20260918-002', ago(30), 'requested')];
  assert.equal(await reminder.sweep(createFakeBot(), { now: NOW }), 0);

  reminder._resetForTests();
  settings = { APPROVAL_REMINDER_HOURS: 6, TRANSFER_STALE_DAYS: 0 };
  rows = Array.from({ length: 14 }, (_, i) => trf(`TR-202609${String(i + 1).padStart(2, '0')}-001`, ago(24 * (i + 1)), 'requested'));
  const bot = createFakeBot();
  assert.equal(await reminder.sweep(bot, { now: NOW }), 10, 'cap');
  const texts = to(bot, 'abdul').map((m) => m.args.text);
  assert.ok(texts[0].includes('14Sep·01') && !texts.some((t) => t.includes('01Sep·01') || t.includes('02Sep·01')), 'the oldest ten went first');
});
