'use strict';

/**
 * TRF-19 — every transfer surface says WHOSE MOVE IT IS.
 *
 * Owner, 14-Sep-2026, holding a "please dispatch" card: "I am not able to
 * see the exact status of this transfer. Where is it pending? Under whose
 * approval or acceptance?"
 *
 * The cards were each written for their own actor, so an admin opening
 * someone else's card (allowed — BUSINESS_RULES §8) saw an instruction
 * with no owner. These tests pin the one line that answers it, on the
 * helper and on the 📋 Transfers list.
 */

process.env.ADMIN_IDS = '777';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const transferFlow = require(path.join(SRC, 'flows/transferFlow'));
const transferService = require(path.join(SRC, 'services/transferService'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));

const { waitingLine, waitedFor } = transferFlow._internals;

const NAMES = { musa: 'Musa', abdul: 'Abdul', krishna: 'Krishna' };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function row(stage, extra = {}) {
  return {
    requestId: 'TR-20260911-002',
    user: 'krishna',
    status: 'pending',
    createdAt: daysAgo(3),
    actionJSON: {
      action: 'transfer_stock', from: 'Kano office', to: 'Lagos', stage,
      dispatcher: 'musa', receiver: 'abdul',
      lines: [{ design: '9006', shade: '6', qty: 1 }],
    },
    ...extra,
  };
}

test('TRF-19 waitingLine names the person each stage is waiting on', async (t) => {
  await t.test('requested → the dispatcher', () => {
    const line = waitingLine(row('requested'), NAMES);
    assert.match(line, /With Musa to dispatch/);
    assert.match(line, /raised by Krishna/);
    assert.match(line, /3d waiting/);
  });

  await t.test('admin_review → the admins, and it says who logged the package', () => {
    const line = waitingLine(row('admin_review'), NAMES);
    assert.match(line, /With the admins to approve/);
    assert.match(line, /logged by Musa/);
  });

  await t.test('in_transit → the receiver', () => {
    const line = waitingLine(row('in_transit'), NAMES);
    assert.match(line, /With Abdul to confirm arrival/);
  });

  await t.test('settled rows state the outcome, never a pending person', () => {
    const done = waitingLine(row('in_transit', { status: 'approved' }), NAMES);
    assert.match(done, /Received/);
    assert.doesNotMatch(done, /With .* to /);
    const closed = waitingLine(row('requested', { status: 'rejected' }), NAMES);
    assert.match(closed, /Closed/);
    assert.match(closed, /Kano office/, 'says where the bales went back to');
  });

  await t.test('unknown names degrade to the id — never a blank owner', () => {
    assert.match(waitingLine(row('requested'), {}), /With musa to dispatch/);
  });

  await t.test('no row at all → empty string, never a half-sentence', () => {
    assert.equal(waitingLine(null), '');
  });
});

test('TRF-19 waitedFor is day-aware and safe on junk', () => {
  assert.equal(waitedFor(''), '');
  assert.equal(waitedFor('not a date'), '');
  assert.equal(waitedFor(new Date().toISOString()), ' · today');
  assert.equal(waitedFor(daysAgo(5)), ' · 5d waiting');
});

test('TRF-19 the 📋 Transfers list names the holder and every row is tappable', async () => {
  const bot = createFakeBot();
  const openRows = [row('requested'), { ...row('in_transit'), requestId: 'TR-20260911-003' }];
  const origOpen = transferService.getOpenTransfers;
  const origUsers = usersRepository.getAll;
  transferService.getOpenTransfers = async () => openRows;
  usersRepository.getAll = async () => [
    { user_id: 'musa', name: 'Musa' },
    { user_id: 'abdul', name: 'Abdul' },
    { user_id: 'krishna', name: 'Krishna' },
  ];
  try {
    await transferFlow.showList(bot, 42, '777', null);
  } finally {
    transferService.getOpenTransfers = origOpen;
    usersRepository.getAll = origUsers;
  }

  const msg = bot.calls.find((c) => c.method === 'sendMessage');
  assert.ok(msg, 'the list was sent');
  assert.match(msg.args.text, /waiting on Musa/, 'the awaiting-dispatch row names the dispatcher');
  assert.match(msg.args.text, /waiting on Abdul/, 'the in-transit row names the receiver');

  const rows = msg.args.opts.reply_markup.inline_keyboard;
  const cbs = rows.flat().map((b) => b.callback_data);
  assert.ok(cbs.includes('trf:lcard:TR-20260911-002'), 'row 1 opens its own card');
  assert.ok(cbs.includes('trf:lcard:TR-20260911-003'), 'row 2 opens its own card');
  assert.ok(cbs.includes('act:__back__'), 'the menu row survives');
  for (const cb of cbs) {
    assert.ok(Buffer.byteLength(cb) <= 64, `callback_data within Telegram's 64 bytes: ${cb}`);
  }
});

test('TRF-19 an admin opening someone else\'s card is told whose seat it is', async () => {
  const bot = createFakeBot();
  const transferService2 = require(path.join(SRC, 'services/transferService'));
  const origFind = transferService2.findTransfer;
  const origUsers = usersRepository.getAll;
  transferService2.findTransfer = async () => row('requested');
  usersRepository.getAll = async () => [
    { user_id: 'musa', name: 'Musa' },
    { user_id: 'abdul', name: 'Abdul' },
    { user_id: 'krishna', name: 'Krishna' },
  ];
  const query = {
    id: 'q1', from: { id: '777' },           // the admin, NOT the dispatcher
    message: { chat: { id: 42 }, message_id: 9 },
  };
  try {
    await transferFlow.showActionCard(bot, query, 'TR-20260911-002', { backCb: 'trf:list' });
  } finally {
    transferService2.findTransfer = origFind;
    usersRepository.getAll = origUsers;
  }
  const edit = bot.calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'the card was rendered in place');
  assert.match(edit.args.text, /With Musa to dispatch/, 'the stage names the holder');
  assert.match(edit.args.text, /acting for Musa/, 'the admin is told this is a stand-in');
  // The buttons stay — BUSINESS_RULES §8 lets an admin act in either seat.
  const cbs = edit.args.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(cbs.some((c) => c.startsWith('trf:acc:')), 'Accept & dispatch survives');
  assert.ok(cbs.includes('trf:list'), 'the nav row keeps 📋 Transfers');
});

test('TRF-19 the assigned dispatcher sees no stand-in note', async () => {
  const bot = createFakeBot();
  const transferService2 = require(path.join(SRC, 'services/transferService'));
  const origFind = transferService2.findTransfer;
  const origUsers = usersRepository.getAll;
  transferService2.findTransfer = async () => row('requested');
  usersRepository.getAll = async () => [{ user_id: 'musa', name: 'Musa' }, { user_id: 'abdul', name: 'Abdul' }];
  const query = { id: 'q2', from: { id: 'musa' }, message: { chat: { id: 7 }, message_id: 3 } };
  try {
    await transferFlow.showActionCard(bot, query, 'TR-20260911-002');
  } finally {
    transferService2.findTransfer = origFind;
    usersRepository.getAll = origUsers;
  }
  const edit = bot.calls.find((c) => c.method === 'editMessageText');
  assert.match(edit.args.text, /With Musa to dispatch/);
  assert.doesNotMatch(edit.args.text, /acting for/);
});

/* ── TRF-19b: the defects an adversarial read of the first cut found ── */

test('TRF-19b the clock is the STAGE\'s own stamp, not always the raise date', () => {
  const old = row('in_transit');
  old.createdAt = daysAgo(14);                       // ordered a fortnight ago
  old.actionJSON.dispatchedAt = daysAgo(1);          // but it only left yesterday
  old.actionJSON.dispatchedOn = '2026-09-13';
  const line = waitingLine(old, NAMES);
  assert.match(line, /1d waiting/, `the receiver has had it one day, got: ${line}`);
  assert.doesNotMatch(line, /14d/, 'never the raise date once it has moved on');
  assert.match(line, /left 13-Sep-2026/, 'the physical departure date rides along');

  const parked = row('admin_review');
  parked.createdAt = daysAgo(14);
  parked.actionJSON.pendingDispatch = { submittedBy: 'musa', submittedAt: daysAgo(2) };
  assert.match(waitingLine(parked, NAMES), /2d waiting/, 'the admins have held it two days');
});

test('TRF-19b a sent-back package reads as back with the dispatcher, from the send-back', () => {
  const back = row('requested');
  back.createdAt = daysAgo(9);
  back.actionJSON.reviewSentBackAt = daysAgo(1);
  back.actionJSON.reviewSentBackBy = 'krishna';
  const line = waitingLine(back, NAMES);
  assert.match(line, /Back with Musa to re-log/);
  assert.match(line, /sent back by Krishna/);
  assert.match(line, /1d waiting/);
});

test('TRF-19b names are Markdown-escaped — a card that cannot send says nothing at all', () => {
  const line = waitingLine(row('requested'), { musa: 'Musa_B *the* [one]', krishna: 'K`v' });
  assert.match(line, /Musa\\_B/, 'underscore escaped');
  assert.match(line, /\\\*the\\\*/, 'asterisks escaped');
  assert.match(line, /\\\[one\\\]/, 'brackets escaped');
  assert.match(line, /K\\`v/, 'backtick escaped');
});

test('TRF-19b a settled transfer names the person who closed it and when', () => {
  const done = row('in_transit', { status: 'approved', resolvedAt: '2026-09-13T10:00:00Z' });
  assert.match(waitingLine(done, NAMES), /Received by Abdul\* · 13-Sep-2026/);
  const closed = row('requested', { status: 'rejected', approver: 'Krishna', resolvedAt: '2026-09-13T10:00:00Z' });
  const line = waitingLine(closed, NAMES);
  assert.match(line, /Closed by Krishna/);
  assert.match(line, /bales back at Kano office/);
});
