'use strict';

/**
 * RATE-1 — the "last paid by <customer>" chip on Step 2 of the sale wizard.
 *
 * Owner, 17-Sep-2026: "There is a suggestion before this chip for the last
 * sold rate but still I am getting a request to type in the rate again."
 *
 * The chip read the Transactions sheet and matched on its design column —
 * but a BUNDLE sale writes that row with an empty design cell and only the
 * first design's rate, so for a buyer whose purchases went through the
 * bundle door the chip never appeared. Pinned here: the approved request's
 * own row (enrichDraft.ratePerUnitByDesign) is the first source — exact per
 * design, newest approval first, every spelling of the buyer, no row cap —
 * with the Transactions match kept for legacy single-item sales; and when
 * there is truly nothing, the card says so instead of silently omitting
 * the chip.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '555';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const approvalEvents = require('../../../src/events/approvalEvents');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const customerEntity = require('../../../src/services/customerEntity');
const accountingService = require('../../../src/services/accountingService');
const settingsRepository = require('../../../src/repositories/settingsRepository');

const { getLastPaidRate, pendingEnrichment, wizKey } = approvalEvents._internals;

settingsRepository.getAll = async () => ({});
approvalQueueRepository.updateActionJSON = async () => true;
accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 7353610 });
customerEntity.resolve = async ({ name }) => (String(name).toUpperCase() === 'ABBA'
  ? { customer_id: 'C1', name: 'ABBA', aliases: ['Abba Textiles'] } : null);

// The sheet the OLD lookup read: the bundle door leaves the design blank and
// keeps only the first design's rate. Nothing here can identify a 77019 sale.
transactionsRepository.getLast = async () => [
  { action: 'sale_bundle', customerName: 'ABBA', design: '', pricePerYard: '1300' },
  { action: 'sale_bundle', customerName: 'ABBA', design: '', pricePerYard: '1450' },
];

const approved = (over) => ({
  requestId: 'R', status: 'approved', createdAt: '2026-09-01T10:00:00Z', resolvedAt: '2026-09-01T11:00:00Z',
  actionJSON: { action: 'sale_bundle', customer: 'ABBA', enrichDraft: { ratePerUnitByDesign: { '77019': 1450 }, paymentMode: 'Cash' } },
  ...over,
});

test('RATE-1: a bundle sale approved with a typed rate is found on its own queue row', async () => {
  approvalQueueRepository.getResolved = async () => [approved({})];
  assert.equal(await getLastPaidRate('ABBA', '77019'), 1450);
});

test('RATE-1: the NEWEST approval wins, by resolved time not sheet order', async () => {
  approvalQueueRepository.getResolved = async () => [
    approved({ requestId: 'NEW', resolvedAt: '2026-09-15T09:00:00Z', actionJSON: { action: 'sale_bundle', customer: 'ABBA', enrichDraft: { ratePerUnitByDesign: { '77019': 1600 } } } }),
    approved({ requestId: 'OLD', resolvedAt: '2026-08-01T09:00:00Z', actionJSON: { action: 'sale_bundle', customer: 'ABBA', enrichDraft: { ratePerUnitByDesign: { '77019': 1200 } } } }),
  ];
  assert.equal(await getLastPaidRate('ABBA', '77019'), 1600);
});

test('RATE-1: exact per design — a mixed bundle offers THIS design\'s rate, not the first one', async () => {
  approvalQueueRepository.getResolved = async () => [approved({
    actionJSON: { action: 'sale_bundle', customer: 'ABBA', enrichDraft: { ratePerUnitByDesign: { '44200': 1500, '77019': 1350 } } },
  })];
  assert.equal(await getLastPaidRate('ABBA', '77019'), 1350);
  assert.equal(await getLastPaidRate('ABBA', '44200'), 1500);
  assert.equal(await getLastPaidRate('ABBA', '9037'), null, 'a design she never bought');
});

test('RATE-1: every spelling the buyer has been filed under, case-insensitive', async () => {
  approvalQueueRepository.getResolved = async () => [approved({
    actionJSON: { action: 'sale_bundle', customer: 'abba textiles ', enrichDraft: { ratePerUnitByDesign: { '77019': 1450 } } },
  })];
  assert.equal(await getLastPaidRate('ABBA', '77019'), 1450, 'alias spelling on the row, canonical name asked');
  assert.equal(await getLastPaidRate('ABBA', ' 77019 '), 1450, 'design trimmed');
});

test('RATE-1: pending and rejected rows are never a "last paid" rate', async () => {
  approvalQueueRepository.getResolved = async () => [
    approved({ status: 'rejected' }),
    approved({ status: 'pending' }),
  ];
  assert.equal(await getLastPaidRate('ABBA', '77019'), null);
});

test('RATE-1: legacy single-item sales still come from Transactions when no approved row carries a rate', async () => {
  approvalQueueRepository.getResolved = async () => [];
  transactionsRepository.getLast = async () => [
    { action: 'sell_package', customerName: 'ABBA', design: '77019', pricePerYard: '1400' },
  ];
  assert.equal(await getLastPaidRate('ABBA', '77019'), 1400);
  transactionsRepository.getLast = async () => [];
});

test('RATE-1: a failing queue read falls through to Transactions and never throws', async () => {
  approvalQueueRepository.getResolved = async () => { throw new Error('sheets down'); };
  transactionsRepository.getLast = async () => [
    { action: 'sell_package', customerName: 'ABBA', design: '77019', pricePerYard: '1250' },
  ];
  assert.equal(await getLastPaidRate('ABBA', '77019'), 1250);
  transactionsRepository.getLast = async () => [];
});

/* ── Step 2 as rendered ─────────────────────────────────────────────── */

function lastCard(bot) {
  const c = bot.calls.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)).pop();
  return { text: c.args.text, buttons: c.args.opts.reply_markup.inline_keyboard.flat().map((b) => b.text) };
}
const ITEM = { requestId: 'R6555', user: '555', actionJSON: { action: 'sale_bundle', customer: 'ABBA', items: [] } };

test('RATE-1: Step 2 offers the chip when the buyer has bought this design before', async () => {
  approvalQueueRepository.getResolved = async () => [approved({})];
  const bot = createFakeBot();
  pendingEnrichment.delete(wizKey('777', 'R6555'));
  // startApprovalEnrichment derives designs from Inventory (empty here), so
  // drive the rate step through the same entry the wizard uses after Step 1
  // by pre-seeding the state and re-entering Step 2 via the customer chip.
  await approvalEvents.startApprovalEnrichment(bot, '777', 1, 'R6555', ITEM, '555');
  const state = pendingEnrichment.get(wizKey('777', 'R6555'));
  state.designs = ['77019'];
  await approvalEvents._internals.sendRateStep(bot, 1, state);
  const { text, buttons } = lastCard(bot);
  assert.match(text, /Step 2 — Rate/);
  assert.ok(buttons.some((b) => /1,450\/yd — last paid by ABBA/.test(b)), `the chip, got: ${buttons}`);
  assert.doesNotMatch(text, /No earlier sale/);
  assert.equal(state.lastPaidRate, 1450);
});

test('RATE-1: Step 2 says when there is no earlier sale instead of silently dropping the chip', async () => {
  approvalQueueRepository.getResolved = async () => [];
  const bot = createFakeBot();
  pendingEnrichment.delete(wizKey('777', 'R6555'));
  await approvalEvents.startApprovalEnrichment(bot, '777', 1, 'R6555', ITEM, '555');
  const state = pendingEnrichment.get(wizKey('777', 'R6555'));
  state.designs = ['77019'];
  await approvalEvents._internals.sendRateStep(bot, 1, state);
  const { text, buttons } = lastCard(bot);
  assert.match(text, /No earlier sale of 77019 to ABBA\./, `got:\n${text}`);
  assert.ok(!buttons.some((b) => /last paid by/.test(b)), 'no chip');
  assert.ok(buttons.includes('✏️ Type a custom rate'));
  assert.ok(buttons.some((b) => /Change customer \(ABBA\)/.test(b)));
  const noteAt = text.indexOf('No earlier sale');
  const typedAt = text.indexOf('A typed reply');
  assert.ok(noteAt < typedAt, 'the note sits above the typed-reply footer');
});

test('RATE-1: several designs — no chip and no note, exactly as before', async () => {
  approvalQueueRepository.getResolved = async () => [approved({})];
  const bot = createFakeBot();
  pendingEnrichment.delete(wizKey('777', 'R6555'));
  await approvalEvents.startApprovalEnrichment(bot, '777', 1, 'R6555', ITEM, '555');
  const state = pendingEnrichment.get(wizKey('777', 'R6555'));
  state.designs = ['77019', '44201'];
  await approvalEvents._internals.sendRateStep(bot, 1, state);
  const { text, buttons } = lastCard(bot);
  assert.doesNotMatch(text, /No earlier sale/);
  assert.ok(!buttons.some((b) => /last paid by/.test(b)));
});
