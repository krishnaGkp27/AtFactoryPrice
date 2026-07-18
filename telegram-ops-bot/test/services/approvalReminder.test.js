'use strict';

/**
 * APR-1 — pending-approval reminder sweep.
 * Pending queue rows older than 10 min get their admin card re-sent via the
 * real approvalEvents card-sender; fresh rows, disabled setting and the
 * per-window memory are all respected.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../src');
const { createFakeBot } = require('../helpers/fakeBot');

const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const reminder = require(path.join(SRC, 'services/approvalReminder'));

const NOW = Date.parse('2026-07-14T12:00:00Z');
const OLD = new Date(NOW - 60 * 60 * 1000).toISOString();   // 1 h old
const FRESH = new Date(NOW - 2 * 60 * 1000).toISOString();  // 2 min old

let pendingRows = [];
approvalQueueRepository.getAllPending = async () => pendingRows;
let settings = { APPROVAL_REMINDER_HOURS: 6 };
settingsRepository.getAll = async () => ({ ...settings });

function row(id, createdAt, aj) {
  return { requestId: id, user: 'drive-import', actionJSON: aj, riskReason: 'Photo must be approved', status: 'pending', createdAt };
}

test('stale pending rows get cards to every admin; fresh rows are skipped', async () => {
  reminder._resetForTests();
  pendingRows = [
    row('req-old', OLD, { action: 'design_asset_upload', design: '77014', arrivalBatch: 'Jul26' }),
    row('req-new', FRESH, { action: 'design_asset_upload', design: '77019' }),
  ];
  const bot = createFakeBot();
  const sent = await reminder.sweep(bot, { now: NOW });
  assert.equal(sent, 1, 'only the stale request is reminded');
  const msgs = bot.calls.filter((c) => c.method === 'sendMessage');
  assert.equal(msgs.length, 2, 'one card per admin (777, 888)');
  assert.match(msgs[0].args.text, /Reminder — this approval is still waiting/);
  assert.match(msgs[0].args.text, /req\-old/);
  // APU-1: reminder cards now carry labelled per-field detail.
  assert.match(msgs[0].args.text, /design asset upload/);
  assert.match(msgs[0].args.text, /Design: 77014/);
  assert.match(msgs[0].args.text, /Container: Jul26/);
  const kb = msgs[0].args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === 'approve:req-old'), 'approve button targets the request');
});

test('window memory: second sweep inside the window sends nothing', async () => {
  const bot = createFakeBot();
  const sent = await reminder.sweep(bot, { now: NOW + 60 * 60 * 1000 }); // 1 h later, window 6 h
  assert.equal(sent, 0);
  assert.equal(bot.calls.filter((c) => c.method === 'sendMessage').length, 0);
});

test('after the window lapses still-pending requests are re-reminded', async () => {
  const bot = createFakeBot();
  const sent = await reminder.sweep(bot, { now: NOW + 7 * 60 * 60 * 1000 });
  // req-old re-reminded AND the once-fresh req-new has matured past 10 min.
  assert.equal(sent, 2);
});

test('APPROVAL_REMINDER_HOURS=0 disables the sweep entirely', async () => {
  reminder._resetForTests();
  settings = { APPROVAL_REMINDER_HOURS: 0 };
  const bot = createFakeBot();
  assert.equal(await reminder.sweep(bot, { now: NOW }), 0);
  assert.equal(bot.calls.length, 0);
  settings = { APPROVAL_REMINDER_HOURS: 6 };
});

test('cap: at most 10 cards per sweep, newest first', async () => {
  reminder._resetForTests();
  pendingRows = Array.from({ length: 14 }, (_, i) =>
    row(`req-${String(i).padStart(2, '0')}`, new Date(NOW - (i + 1) * 3600e3).toISOString(), { action: 'record_payment', customer: 'OKESON' }));
  const bot = createFakeBot();
  const sent = await reminder.sweep(bot, { now: NOW });
  assert.equal(sent, 10, 'capped at 10');
  assert.match(bot.allText(), /req\-00/, 'newest request included');
  assert.ok(!/req\-13/.test(bot.allText()), 'oldest of the backlog waits — likely abandoned');
});

test('APU-1 3.3: lifecycle rows never get standard approve/reject cards', async () => {
  reminder._resetForTests();
  pendingRows = [
    row('req-trf', OLD, { action: 'transfer_stock', fromWarehouse: 'IDUMOTA' }),
    row('req-sup-stage1', OLD, { action: 'supply_request', stage: 'dispatch_confirm' }),
    row('req-sup-assigned', OLD, { action: 'supply_request', stage: 'dispatch_acceptance' }),
    row('req-sup-admin', OLD, {
      action: 'supply_request', stage: 'admin_review', customer: 'CJE', warehouse: 'IDUMOTA',
      cart: [{ design: '77016', shade: '5', quantity: 3 }],
    }),
  ];
  const bot = createFakeBot();
  const sent = await reminder.sweep(bot, { now: NOW });
  assert.equal(sent, 1, 'only the admin_review supply request is reminded');
  assert.match(bot.allText(), /req\-sup\-admin/);
  // Review fix: the reminder card must show the requested goods (aj.cart).
  assert.match(bot.allText().replace(/\\/g, ''), /77016 Shade 5 × 3/, 'cart lines rendered');
  assert.ok(!/req\-trf/.test(bot.allText()), 'transfer lifecycle rows skipped');
  assert.ok(!/req\-sup\-stage1/.test(bot.allText()));
});

test('APU-1: sale reminders rebuild the full card and re-forward the bill', async () => {
  reminder._resetForTests();
  pendingRows = [
    row('req-sale', OLD, {
      action: 'sale_bundle', customer: 'OKESON', salesPerson: 'Abdul', paymentMode: 'cash',
      salesDate: '2026-07-14', items: [{ type: 'package', packageNo: '896' }],
      totalYards: 60, sale_doc_file_id: 'bill-1', sale_doc_type: 'photo',
    }),
  ];
  const bot = createFakeBot();
  const sent = await reminder.sweep(bot, { now: NOW });
  assert.equal(sent, 1);
  const text = bot.allText().replace(/\\/g, '');
  assert.match(text, /Customer: OKESON/);
  assert.match(text, /Salesperson: Abdul/);
  assert.match(text, /Bale 896/);
  assert.match(text, /Sales bill attached/);
  const photos = bot.calls.filter((c) => c.method === 'sendPhoto');
  assert.equal(photos.length, 2, 'bill re-forwarded to both admins');
  assert.equal(photos[0].args.photo, 'bill-1');
});
