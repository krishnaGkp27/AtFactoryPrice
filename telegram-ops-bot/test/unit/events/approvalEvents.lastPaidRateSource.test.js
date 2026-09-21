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
 * own row is the first source — the executor's `enrichment` (every sale
 * since INV-1a) before the wizard's `enrichDraft` (APC-1), exact per
 * design, newest approval first, every spelling of the buyer, reverted
 * sales excluded, no row cap — with the Transactions match kept for legacy
 * single-item sales; and when nothing is found the card says so, safely.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '555';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const approvalEvents = require('../../../src/events/approvalEvents');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const customerEntity = require('../../../src/services/customerEntity');
const accountingService = require('../../../src/services/accountingService');
const settingsRepository = require('../../../src/repositories/settingsRepository');

const { getLastPaidRate, bookedRateFor, pendingEnrichment, wizKey, _resetRateMemo } = approvalEvents._internals;

settingsRepository.getAll = async () => ({});
approvalQueueRepository.updateActionJSON = async () => true;
accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 7353610 });
customerEntity.resolve = async ({ name }) => (String(name).toUpperCase() === 'ABBA'
  ? { customer_id: 'C1', name: 'ABBA', aliases: ['Abba Textiles'] } : null);
// The wizard derives the design list from Inventory by package number.
inventoryRepository.findByPackage = async (pkg) => (pkg === 'P77019' ? [{ design: '77019', packageNo: pkg }] : []);

// The sheet the OLD lookup read: the bundle door leaves the design blank and
// keeps only the first design's rate. Nothing here can identify a 77019 sale.
const BLANK_DESIGN_ROWS = [
  { action: 'sale_bundle', customerName: 'ABBA', design: '', pricePerYard: '1300' },
  { action: 'sale_bundle', customerName: 'ABBA', design: '', pricePerYard: '1450' },
];
transactionsRepository.getLast = async () => BLANK_DESIGN_ROWS;

/** Stub the resolved rows AND drop the memo, so every test sees its own sheet. */
function resolvedIs(rows) {
  approvalQueueRepository.getResolved = async () => rows;
  _resetRateMemo();
}
const approved = (over) => ({
  requestId: 'R', status: 'approved', createdAt: '2026-09-01T10:00:00Z', resolvedAt: '2026-09-01T11:00:00Z',
  actionJSON: { action: 'sale_bundle', customer: 'ABBA', enrichDraft: { ratePerUnitByDesign: { '77019': 1450 }, paymentMode: 'Cash' } },
  ...over,
});

test('RATE-1: a bundle sale approved with a typed rate is found on its own queue row', async () => {
  resolvedIs([approved({})]);
  assert.equal(await getLastPaidRate('ABBA', '77019'), 1450);
});

test('RATE-1b: the executor\'s record (enrichment) is found on a row that has NO draft — a sale from before the draft existed', async () => {
  resolvedIs([approved({ actionJSON: { action: 'sale_bundle', customer: 'ABBA', enrichment: { ratePerUnitByDesign: { '77019': 1450 } } } })]);
  assert.equal(await getLastPaidRate('ABBA', '77019'), 1450);
});

test('RATE-1b: when both maps exist the EXECUTED rate wins over the draft', async () => {
  resolvedIs([approved({ actionJSON: {
    action: 'sale_bundle', customer: 'ABBA',
    enrichDraft: { ratePerUnitByDesign: { '77019': 1450 } },
    enrichment: { ratePerUnitByDesign: { '77019': 1500 } },
  } })]);
  assert.equal(await getLastPaidRate('ABBA', '77019'), 1500, 'what the ledger and invoice carry, not the mid-wizard copy');
});

test('RATE-1: the NEWEST approval wins by resolved time — sheet order and createdAt must not decide', async () => {
  resolvedIs([
    // OLD comes FIRST in sheet order and was even CREATED later; only resolvedAt says it is older.
    approved({ requestId: 'OLD', createdAt: '2026-09-20T09:00:00Z', resolvedAt: '2026-08-01T09:00:00Z', actionJSON: { action: 'sale_bundle', customer: 'ABBA', enrichDraft: { ratePerUnitByDesign: { '77019': 1200 } } } }),
    approved({ requestId: 'NEW', createdAt: '2026-08-15T09:00:00Z', resolvedAt: '2026-09-15T09:00:00Z', actionJSON: { action: 'sale_bundle', customer: 'ABBA', enrichDraft: { ratePerUnitByDesign: { '77019': 1600 } } } }),
  ]);
  assert.equal(await getLastPaidRate('ABBA', '77019'), 1600);
});

test('RATE-1: a row with no resolvedAt falls back to createdAt for its place in the order', async () => {
  resolvedIs([
    approved({ requestId: 'A', createdAt: '2026-09-18T09:00:00Z', resolvedAt: '', actionJSON: { action: 'sale_bundle', customer: 'ABBA', enrichDraft: { ratePerUnitByDesign: { '77019': 1700 } } } }),
    approved({ requestId: 'B', createdAt: '2026-09-01T09:00:00Z', resolvedAt: '2026-09-02T09:00:00Z', actionJSON: { action: 'sale_bundle', customer: 'ABBA', enrichDraft: { ratePerUnitByDesign: { '77019': 1300 } } } }),
  ]);
  assert.equal(await getLastPaidRate('ABBA', '77019'), 1700);
});

test('RATE-1: exact per design — a mixed bundle offers THIS design\'s rate, not the first one', async () => {
  resolvedIs([approved({ actionJSON: { action: 'sale_bundle', customer: 'ABBA', enrichDraft: { ratePerUnitByDesign: { '44200': 1500, '77019': 1350 } } } })]);
  assert.equal(await getLastPaidRate('ABBA', '77019'), 1350);
  assert.equal(await getLastPaidRate('ABBA', '44200'), 1500);
  assert.equal(await getLastPaidRate('ABBA', '9037'), null, 'a design she never bought');
});

test('RATE-1b: a design the map does not key was charged the FIRST rate (executor rule) — mirrored only when the row sold it', () => {
  const map = { ratePerUnitByDesign: { '44200': 1500 } };
  assert.equal(bookedRateFor({ enrichment: map, yardsByDesign: { '44200': 100, '77019': 50 } }, '77019'), 1500, 'row sold 77019, un-keyed → first rate, as the ledger has it');
  assert.equal(bookedRateFor({ enrichment: map, yardsByDesign: { '44200': 100 } }, '77019'), null, 'row never sold 77019 → nothing invented');
  assert.equal(bookedRateFor({ enrichment: map }, '77019'), null, 'no yardsByDesign → nothing invented');
});

test('RATE-1: keys and values in whatever shape the admin typed — case, spaces, strings', async () => {
  resolvedIs([approved({ actionJSON: { action: 'sale_bundle', customer: 'abba textiles ', enrichDraft: { ratePerUnitByDesign: { ' ab12 ': '1450' } } } })]);
  assert.equal(await getLastPaidRate('ABBA', 'AB12'), 1450, 'alias spelling on the row, key case + spaces, string value');
  assert.equal(await getLastPaidRate('ABBA', ' ab12 '), 1450, 'asked with spaces too');
});

test('RATE-1: pending and rejected rows are never a "last paid" rate', async () => {
  resolvedIs([approved({ status: 'rejected' }), approved({ status: 'pending' })]);
  assert.equal(await getLastPaidRate('ABBA', '77019'), null);
});

test('RATE-1b: a sale undone by an approved revert is not "paid" — the one before it is', async () => {
  resolvedIs([
    approved({ requestId: 'S1', resolvedAt: '2026-09-01T09:00:00Z', actionJSON: { action: 'sale_bundle', customer: 'ABBA', enrichDraft: { ratePerUnitByDesign: { '77019': 1200 } } } }),
    approved({ requestId: 'S2', resolvedAt: '2026-09-10T09:00:00Z', actionJSON: { action: 'sale_bundle', customer: 'ABBA', enrichDraft: { ratePerUnitByDesign: { '77019': 1450 } } } }),
    approved({ requestId: 'RV', resolvedAt: '2026-09-11T09:00:00Z', actionJSON: { action: 'revert_sale_bundle', customer: 'ABBA', saleRefId: 'S2' } }),
  ]);
  assert.equal(await getLastPaidRate('ABBA', '77019'), 1200, 'S2 was reverted; S1 stands');
});

test('RATE-1: the queue row wins over a matching Transactions row', async () => {
  resolvedIs([approved({})]);
  transactionsRepository.getLast = async () => [{ action: 'sell_package', customerName: 'ABBA', design: '77019', pricePerYard: '1400' }];
  try {
    assert.equal(await getLastPaidRate('ABBA', '77019'), 1450);
  } finally { transactionsRepository.getLast = async () => BLANK_DESIGN_ROWS; }
});

test('RATE-1: legacy single-item sales still come from Transactions when no approved row carries a rate', async () => {
  resolvedIs([]);
  transactionsRepository.getLast = async () => [{ action: 'sell_package', customerName: 'ABBA', design: '77019', pricePerYard: '1400' }];
  try { assert.equal(await getLastPaidRate('ABBA', '77019'), 1400); } finally { transactionsRepository.getLast = async () => BLANK_DESIGN_ROWS; }
});

test('RATE-1: a failing queue read falls through to Transactions and never throws', async () => {
  approvalQueueRepository.getResolved = async () => { throw new Error('sheets down'); };
  _resetRateMemo();
  transactionsRepository.getLast = async () => [{ action: 'sell_package', customerName: 'ABBA', design: '77019', pricePerYard: '1250' }];
  try { assert.equal(await getLastPaidRate('ABBA', '77019'), 1250); } finally { transactionsRepository.getLast = async () => BLANK_DESIGN_ROWS; }
});

/* ── Step 2 as rendered, through the wizard's own entry ─────────────── */

function lastCard(bot) {
  const c = bot.calls.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)).pop();
  return { text: c.args.text, buttons: c.args.opts.reply_markup.inline_keyboard.flat().map((b) => b.text) };
}
// A real bundle request: the design list is DERIVED from the packed bale.
const item = (customer = 'ABBA') => ({
  requestId: 'R6555', user: '555',
  actionJSON: { action: 'sale_bundle', customer, items: [{ packageNo: 'P77019', warehouse: 'IDUMOTA' }] },
});
async function openStep2(customer = 'ABBA') {
  const bot = createFakeBot();
  pendingEnrichment.delete(wizKey('777', 'R6555'));
  await approvalEvents.startApprovalEnrichment(bot, '777', 1, 'R6555', item(customer), '555');
  return { bot, state: pendingEnrichment.get(wizKey('777', 'R6555')) };
}

test('RATE-1: Step 2 offers the chip when the buyer has bought this design before — derived design, real entry', async () => {
  resolvedIs([approved({})]);
  const { bot, state } = await openStep2();
  const { text, buttons } = lastCard(bot);
  assert.match(text, /Step 2 — Rate/);
  assert.match(text, /Design\(s\): 77019/, 'the design came from the bale, not from the test');
  assert.ok(buttons.some((b) => /1,450\/yd — last paid by ABBA/.test(b)), `the chip, got: ${buttons}`);
  assert.doesNotMatch(text, /No earlier sale/);
  assert.equal(state.lastPaidRate, 1450);
});

test('RATE-1: Step 2 says when nothing was found instead of silently dropping the chip', async () => {
  resolvedIs([]);
  const { bot, state } = await openStep2();
  const { text, buttons } = lastCard(bot);
  assert.match(text, /No earlier sale of 77019 to ABBA found\./, `got:\n${text}`);
  assert.ok(!buttons.some((b) => /last paid by/.test(b)), 'no chip');
  assert.ok(buttons.includes('✏️ Type a custom rate'));
  assert.ok(buttons.some((b) => /Change customer \(ABBA\)/.test(b)));
  assert.ok(text.indexOf('No earlier sale') < text.indexOf('A typed reply'), 'the note sits above the typed-reply footer');
  assert.equal(state.lastPaidRate, null);
});

test('RATE-1b: a buyer name with an underscore cannot blank the card — the line is escaped', async () => {
  resolvedIs([]);
  customerEntity.resolve = async () => null;
  try {
    const { bot } = await openStep2('ABBA_TEXTILES');
    const { text } = lastCard(bot);
    assert.match(text, /No earlier sale of 77019 to ABBA\\_TEXTILES found\./, `escaped, got:\n${text}`);
  } finally {
    customerEntity.resolve = async ({ name }) => (String(name).toUpperCase() === 'ABBA' ? { customer_id: 'C1', name: 'ABBA', aliases: ['Abba Textiles'] } : null);
  }
});

test('RATE-1b: a chipless re-render FORGETS the previous buyer\'s rate — an old chip cannot book it for the new buyer', async () => {
  resolvedIs([approved({})]);
  const { bot, state } = await openStep2();
  assert.equal(state.lastPaidRate, 1450, 'ABBA has history');
  // ✎ Change customer → a buyer with no history re-renders Step 2 on the SAME state.
  state.customer = 'ZED';
  await approvalEvents._internals.sendRateStep(bot, 1, state);
  const { text, buttons } = lastCard(bot);
  assert.match(text, /No earlier sale of 77019 to ZED found\./);
  assert.ok(!buttons.some((b) => /last paid by/.test(b)));
  assert.equal(state.lastPaidRate, null, 'the stale 1,450 is gone');
  // The guard on the chip tap now refuses: nothing to apply.
  const before = JSON.stringify(state.ratePerUnitByDesign || null);
  await approvalEvents.handleEnrichmentCallback(bot, { id: 'q', data: 'enr:rate:v', from: { id: 777 }, message: { chat: { id: 1 }, message_id: 2 } });
  assert.equal(JSON.stringify(state.ratePerUnitByDesign || null), before, 'no rate booked from a stale chip');
  assert.equal(state.step, 'rate');
});

test('RATE-1: several designs — no chip and no note, exactly as before', async () => {
  resolvedIs([approved({})]);
  inventoryRepository.findByPackage = async (pkg) => (pkg === 'P77019' ? [{ design: '77019' }] : [{ design: '44201' }]);
  try {
    const bot = createFakeBot();
    pendingEnrichment.delete(wizKey('777', 'R6555'));
    const it = item(); it.actionJSON.items.push({ packageNo: 'P44201', warehouse: 'IDUMOTA' });
    await approvalEvents.startApprovalEnrichment(bot, '777', 1, 'R6555', it, '555');
    const { text, buttons } = lastCard(bot);
    assert.match(text, /Design\(s\): 77019, 44201/);
    assert.doesNotMatch(text, /No earlier sale/);
    assert.ok(!buttons.some((b) => /last paid by/.test(b)));
  } finally {
    inventoryRepository.findByPackage = async (pkg) => (pkg === 'P77019' ? [{ design: '77019', packageNo: pkg }] : []);
  }
});
