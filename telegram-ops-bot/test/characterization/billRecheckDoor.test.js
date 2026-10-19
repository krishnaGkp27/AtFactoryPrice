'use strict';
// VRF-5 — the 🛂 inbox card's re-check door: the chip's three states and a tap
// that redraws the card in bill order with ✅ / 🔴.
process.env.ADMIN_IDS = '777,888';

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
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const designAssetsRepository = require(path.join(SRC, 'repositories/designAssetsRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const svc = require(path.join(SRC, 'services/saleDocVerifyService'));
const flow = require(path.join(SRC, 'flows/approvalsInboxFlow'));

const NAMES = { 777: 'Musa', 888: 'Krishna', 4242: 'Abdul' };
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);
designAssetsRepository.findActive = async () => null;
designAssetsRepository.findLatest = async () => null;
inventoryRepository.getAll = async () => ['483', '490', '526', '577'].map((pkg) => ({
  packageNo: pkg, design: '44200', shade: pkg === '526' ? 'WHITE' : 'BLACK', warehouse: 'IDUMOTA', thanNo: 1, status: 'available', yards: 150, pricePerYard: 0,
}));

const VERDICT = {
  ok: 2, differs: 1, missing: 1, extra: 0, at: '2026-10-15T10:00:00.000Z',
  okNos: ['483', '490'], okNoted: [], differRows: [{ no: '577', diffs: ['qty: bill ~300 yds, request 150 yds'], notes: [] }],
  missingNos: ['526'], extraRows: [], billSeq: ['483', '577', '490'], truncated: false, rechecks: [],
};
const ROW = {
  requestId: 'REQ-VRF5', user: '4242', status: 'pending', createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
  actionJSON: {
    action: 'sale_bundle', customer: '', sale_doc_file_id: 'bill-1', sale_doc_type: 'document',
    items: ['483', '490', '526', '577'].map((n) => ({ type: 'package', packageNo: n })),
    docVerify: { ...VERDICT, billSeq: [] }, // checked before VRF-5: no order yet
  },
};
approvalQueueRepository.getAllPending = async () => [ROW];
approvalQueueRepository.getByRequestId = async () => ROW;

function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard : [];
}
const lastText = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).pop().args.text.replace(/\\/g, '');

test('the chip, a tap, the redraw in bill order, and the three chip states', async () => {
  const bot = createFakeBot();
  await flow.start(bot, '777', '777', null);
  await flow.handleCallback(bot, cb('abx:cat:sales', '777'));
  const open = lastKb(bot).flat().find((b) => b.callback_data.startsWith('abx:i:'));
  await flow.handleCallback(bot, cb(open.callback_data, '777'));

  // Before the re-check: number order (no bill order on file), marks already on.
  let card = lastText(bot);
  assert.match(card, /1\. 483 · 150 yd ✅\n {2}2\. 490 · 150 yd ✅\n {2}3\. 577 · 150 yd 🔴\n Shade WHITE\n {2}4\. 526 · 150 yd 🔴/, card);
  let rows = lastKb(bot);
  const chipRow = rows.find((r) => r.some((b) => b.callback_data.startsWith('abx:rck:')));
  assert.deepEqual(chipRow.map((b) => b.text), ['🔬 Re-check bill'], 'the door, on its own row');
  const peekRow = rows.find((r) => r.some((b) => b.callback_data.startsWith('abx:doc:')));
  assert.deepEqual(peekRow.map((b) => b.callback_data.split(':')[1]), ['doc', 'chk'], 'the peek row is untouched');

  // The tap: the service is stubbed (the read itself is covered in its own test).
  const calls = [];
  svc.recheckBill = async (b, requestId, { by, byLabel }) => {
    calls.push({ requestId, by, byLabel });
    ROW.actionJSON.docVerify = { ...VERDICT, rechecks: [{ by, at: new Date().toISOString() }] };
    return { status: 'done', record: ROW.actionJSON.docVerify };
  };
  const tap = chipRow[0].callback_data;
  await flow.handleCallback(bot, cb(tap, '777'));
  assert.deepEqual(calls, [{ requestId: 'REQ-VRF5', by: '777', byLabel: 'Musa' }]);
  card = lastText(bot);
  assert.match(card, /1\. 483 · 150 yd ✅\n {2}2\. 577 · 150 yd 🔴\n {2}3\. 490 · 150 yd ✅\n Shade WHITE\n {2}4\. 526 · 150 yd 🔴/, `bill order after the re-check: ${card}`);
  rows = lastKb(bot);
  assert.deepEqual(rows.find((r) => r.some((b) => b.callback_data.startsWith('abx:rck'))).map((b) => [b.text, b.callback_data]),
    [['🔬 Re-check used', 'abx:rck:used']], 'the tapping admin has spent their tap');

  // The other admin sees who did it and keeps their own tap.
  const bot2 = createFakeBot();
  await flow.start(bot2, '888', '888', null);
  await flow.handleCallback(bot2, cb('abx:cat:sales', '888'));
  const open2 = lastKb(bot2).flat().find((b) => b.callback_data.startsWith('abx:i:'));
  await flow.handleCallback(bot2, cb(open2.callback_data, '888'));
  const chip2 = lastKb(bot2).flat().find((b) => b.callback_data.startsWith('abx:rck:'));
  assert.match(chip2.text, /^🔬 Re-check bill · done by Musa \d+m ago$/, chip2.text);
  assert.match(chip2.callback_data, /^abx:rck:\d+$/);
});
