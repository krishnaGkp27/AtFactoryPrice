'use strict';

/**
 * DSP-1 — the customer is assigned by the ADMIN at approval, not by the
 * dispatcher when raising the request (owner-locked 26-Jul-2026).
 *
 * The dispatcher raises what physically leaves the warehouse. The admin
 * attaches the buyer, rate and payment on approving. This file pins the
 * admin half; the flow half (no customer pickers) is pinned in the
 * snapSaleFlow / sellBaleFlow / sellTypedEntry suites.
 *
 * The property that matters most is the fail-closed one: a sale must never
 * execute without a customer, because the customer name is the ledger key.
 */

process.env.ADMIN_IDS = '777,888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
loadController();

const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
const inventoryService = require(path.join(SRC, 'services/inventoryService'));

const ADMIN = '777';

// CUS-1 — suggestions and search resolve through the customer ENTITY, which
// reads the Customers list. Give it a canonical world.
customersRepository.getAll = async () => ([
  { rowIndex: 2, customer_id: 'CUST-1', name: 'CJE', phone: '0801', status: 'Active', aliases: ['C.J.E'] },
  { rowIndex: 3, customer_id: 'CUST-2', name: 'Ketu madam', phone: '0802', status: 'Active', aliases: [] },
]);

function saleItem(customer) {
  return {
    requestId: 'R-1', user: '4242', status: 'pending',
    actionJSON: {
      action: 'sell_package', packageNo: '896', design: '77016',
      warehouse: 'IDUMOTA', yards: 60, customer,
    },
  };
}

function texts(bot) {
  return bot.calls
    .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method))
    .map((c) => c.args.text).join('\n');
}
function kbOf(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)
    && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}

test('DSP-1: a customer-less sale opens the CUSTOMER step first, not the rate step', async () => {
  const bot = createFakeBot();
  transactionsRepository.getLast = async () => ([
    { action: 'sell_package', customerName: 'CJE', design: '77016', pricePerYard: 1500 },
  ]);
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-1', saleItem(''), '4242');
  const t = texts(bot);
  assert.match(t, /Step 1 — Who is buying/, `customer is asked first, got: ${t}`);
  assert.ok(!/Step 2 — Rate/.test(t), 'the rate step must wait for a buyer');
  assert.ok(kbOf(bot).some((b) => b.callback_data === 'enr:cust:all:0'), 'full list reachable');
  // CUS-1 — creation left the approval chain entirely: single door (CRM).
  assert.ok(!kbOf(bot).some((b) => b.callback_data === 'enr:cust:new'),
    'no creation door here — a typed string can never become a customer');
});

test('DSP-1: picking the customer advances to the rate step and persists it on the queue row', async () => {
  const bot = createFakeBot();
  transactionsRepository.getLast = async () => ([
    { action: 'sell_package', customerName: 'CJE', design: '77016', pricePerYard: 1500 },
  ]);
  const patches = [];
  approvalQueueRepository.updateActionJSON = async (id, patch) => { patches.push({ id, patch }); return true; };

  const item = saleItem('');
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-1', item, '4242');
  const chip = kbOf(bot).find((b) => b.callback_data === 'enr:cust:r:0');
  assert.ok(chip, 'a recent buyer is offered as a chip');
  await approvalEvents.handleEnrichmentCallback(bot, {
    id: 'q1', data: chip.callback_data, from: { id: ADMIN }, message: { chat: { id: ADMIN } },
  });

  assert.deepEqual(patches, [{ id: 'R-1', patch: { customer: 'CJE', customerId: 'CUST-1' } }],
    'CUS-1 — the entity id rides with the name on the queue row');
  assert.equal(item.actionJSON.customer, 'CJE', 'and to the in-memory copy that executes');
  assert.match(texts(bot), /Step 2 — Rate/, 'advances to rate');
  // The suggestion chip is customer-specific — this is precisely why the
  // customer step has to run BEFORE the rate step.
  const rateChip = kbOf(bot).find((b) => b.callback_data === 'enr:rate:v');
  assert.ok(rateChip, 'a last-paid rate chip is offered');
  assert.match(rateChip.text, /last paid by CJE/, `got: ${rateChip.text}`);
});

test('DSP-1 fail-closed: a sale with no customer is NOT executed', async () => {
  const bot = createFakeBot();
  let executed = false;
  const orig = inventoryService.executeApprovedAction;
  inventoryService.executeApprovedAction = async () => { executed = true; return { ok: true }; };
  try {
    await approvalEvents._internals.runApprovedSaleWithEnrichment(
      bot, ADMIN, ADMIN, 'R-1', saleItem(''), '4242', {}, (n) => `N${n}`,
    );
    assert.equal(executed, false, 'the customer name is the ledger key — never write a blank one');
    assert.match(texts(bot), /was NOT applied/, 'and the admin is told why');
  } finally {
    inventoryService.executeApprovedAction = orig;
  }
});

test('DSP-1: an already-assigned customer skips the customer step entirely', async () => {
  const bot = createFakeBot();
  transactionsRepository.getLast = async () => [];
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-1', saleItem('CJE'), '4242');
  const t = texts(bot);
  assert.match(t, /Step 2 — Rate/, 'straight to rate');
  assert.ok(!/Step 1 — Who is buying/.test(t),
    'requests queued before this change already name a buyer — do not re-ask');
});

test('CUS-1: an unmatched typed name is REFUSED — search-only, no creation', async () => {
  const bot = createFakeBot();
  transactionsRepository.getLast = async () => [];
  const patches = [];
  approvalQueueRepository.updateActionJSON = async (id, patch) => { patches.push(patch); return true; };

  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-1', saleItem(''), '4242');
  await approvalEvents.handleEnrichmentMessage(bot, ADMIN, ADMIN, 'NOBODY LTD');
  assert.deepEqual(patches, [], 'nothing assigned from an unmatched typo');
  assert.match(texts(bot), /No customer matches/, 'told plainly');
  assert.match(texts(bot), /CRM/, 'pointed at the single door');
  assert.ok(!kbOf(bot).some((b) => b.callback_data === 'enr:cust:new'),
    'no add-as-new escape — that was door #1 in the 28-Jul audit');
});

test('CUS-1: an ALIAS typed at Step 1 assigns the CANONICAL customer', async () => {
  const bot = createFakeBot();
  transactionsRepository.getLast = async () => [];
  const patches = [];
  approvalQueueRepository.updateActionJSON = async (id, patch) => { patches.push(patch); return true; };

  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-1', saleItem(''), '4242');
  await approvalEvents.handleEnrichmentMessage(bot, ADMIN, ADMIN, 'C.J.E');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].customer, 'CJE',
    'the old spelling finds the customer but the CANONICAL name is written');
  assert.equal(patches[0].customerId, 'CUST-1');
});

/* ── the loop back to the dispatcher ──────────────────────────────────── */

test('DSP-1: approval edits the dispatcher\'s own card, with name AND phone', async () => {
  const bot = createFakeBot();
  const crmService = require(path.join(SRC, 'services/crmService'));
  const origGet = crmService.getCustomer;
  crmService.getCustomer = async () => ({ name: 'CJE', phone: '08012345678' });
  try {
    const item = saleItem('CJE');
    item.actionJSON.requesterChatId = '4242';
    item.actionJSON.requesterMessageId = 55;
    await approvalEvents._internals.updateRequesterCard(bot, item, 'R-1', '4242', '✅ *Approved*');
    const edit = bot.calls.find((c) => c.method === 'editMessageText');
    assert.ok(edit, 'the original card is edited, not replaced by a new message');
    assert.equal(edit.args.opts.message_id, 55, 'the SAME card');
    assert.match(edit.args.text, /CJE/, 'customer name');
    assert.match(edit.args.text, /08012345678/, 'and the number, which is what he dispatches against');
  } finally {
    crmService.getCustomer = origGet;
  }
});

test('DSP-1: a card that can no longer be edited falls back to a fresh message', async () => {
  const bot = createFakeBot();
  bot.editMessageText = async () => { throw new Error('message to edit not found'); };
  const item = saleItem('CJE');
  item.actionJSON.requesterChatId = '4242';
  item.actionJSON.requesterMessageId = 55;
  await approvalEvents._internals.updateRequesterCard(bot, item, 'R-1', '4242', '✅ Approved');
  const sent = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '4242');
  assert.equal(sent.length, 1, 'the dispatcher still learns the customer');
  assert.match(sent[0].args.text, /CJE/);
});

test('DSP-1: with no card recorded the dispatcher still gets a message', async () => {
  const bot = createFakeBot();
  await approvalEvents._internals.updateRequesterCard(bot, saleItem('CJE'), 'R-1', '4242', '✅ Approved');
  const sent = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '4242');
  assert.equal(sent.length, 1);
  assert.match(sent[0].args.text, /CJE/);
});

test('DSP-1b: a mistapped customer is recoverable — ✎ Change customer re-opens Step 1', async () => {
  const bot = createFakeBot();
  transactionsRepository.getLast = async () => ([
    { action: 'sell_package', customerName: 'CJE', design: '77016', pricePerYard: 1500 },
  ]);
  const patches = [];
  approvalQueueRepository.updateActionJSON = async (id, patch) => { patches.push(patch); return true; };

  const item = saleItem('');
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-1', item, '4242');
  await approvalEvents.handleEnrichmentCallback(bot, {
    id: 'q1', data: 'enr:cust:r:0', from: { id: ADMIN }, message: { chat: { id: ADMIN } },
  });
  // Wrong tap. The rate card must offer the way back…
  const change = kbOf(bot).find((b) => b.callback_data === 'enr:cust:back');
  assert.ok(change, 'the rate step must carry ✎ Change customer — without it a wrong tap is locked in');
  assert.match(change.text, /CJE/, 'showing what is currently assigned');

  await approvalEvents.handleEnrichmentCallback(bot, {
    id: 'q2', data: change.callback_data, from: { id: ADMIN }, message: { chat: { id: ADMIN } },
  });
  assert.match(texts(bot), /Step 1 — Who is buying/, 'back on the customer step');

  // …and re-picking must OVERWRITE the queue row, not append to it.
  await approvalEvents.handleEnrichmentMessage(bot, ADMIN, ADMIN, 'Ketu madam');
  assert.equal(patches.length, 2, 'two assignments — the second replaces the first');
  assert.deepEqual(patches[1], { customer: 'Ketu madam', customerId: 'CUST-2' });
  assert.equal(item.actionJSON.customer, 'Ketu madam', 'the copy that executes carries the correction');
});

test('DSP-1b: a pre-assigned request ALSO gets the change chip — the re-approval trap is closed', async () => {
  const bot = createFakeBot();
  transactionsRepository.getLast = async () => [];
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-1', saleItem('CJE'), '4242');
  // Straight to Step 2 (skip is correct) — but the wrong buyer must still be fixable.
  assert.match(texts(bot), /Step 2 — Rate/);
  assert.ok(kbOf(bot).some((b) => b.callback_data === 'enr:cust:back'),
    'without this, abandoning and re-approving skipped Step 1 and locked the wrong buyer in');
});

/* ── CUS-1 Phase D: decision support at the moment of choice ──────────── */

test('CUS-1 D: design buyers rank first, each chip carrying their LAST rate for this design', async () => {
  const rateSuggestionService = require(path.join(SRC, 'services/rateSuggestionService'));
  const origRecent = rateSuggestionService.recentSalesForDesign;
  rateSuggestionService.recentSalesForDesign = async () => ([
    { ts: '2026-07-28', customer: 'CJE', pricePerYard: 1500, qty: 60 },
    { ts: '2026-07-20', customer: 'C.J.E', pricePerYard: 1400, qty: 30 },   // alias → same entity, deduped
    { ts: '2026-07-15', customer: 'Ketu madam', pricePerYard: 1450, qty: 20 },
    { ts: '2026-07-10', customer: 'GHOST TYPO', pricePerYard: 900, qty: 10 }, // not canonical → never suggested
  ]);
  transactionsRepository.getLast = async () => [];
  try {
    const bot = createFakeBot();
    await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-1', saleItem(''), '4242');
    const chips = kbOf(bot).filter((b) => b.callback_data.startsWith('enr:cust:r:'));
    assert.match(chips[0].text, /CJE — ₦1,500\/yd/, `newest buyer of the design first, with the rate: ${chips[0].text}`);
    assert.match(chips[1].text, /Ketu madam — ₦1,450\/yd/);
    assert.equal(chips.filter((c) => /CJE/.test(c.text)).length, 1, 'the alias sale deduped onto the canonical entity');
    assert.ok(!chips.some((c) => /GHOST TYPO/.test(c.text)), 'history typos are never suggested (decision 8)');
    assert.match(texts(bot), /Who is buying 77016/, 'the header names the design');
  } finally {
    rateSuggestionService.recentSalesForDesign = origRecent;
  }
});

test('CUS-1 D: Step 2 shows the outstanding balance for the assigned customer', async () => {
  const accountingService = require(path.join(SRC, 'services/accountingService'));
  const origLedger = accountingService.getCustomerLedger;
  accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 240000 });
  transactionsRepository.getLast = async () => [];
  try {
    const bot = createFakeBot();
    await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-1', saleItem('CJE'), '4242');
    assert.match(texts(bot), /📒 Outstanding: ₦240,000/, 'credit exposure at the moment more stock is assigned');
  } finally {
    accountingService.getCustomerLedger = origLedger;
  }
});

test('CUS-1 D: a ledger hiccup never blocks the chain — the line is simply absent', async () => {
  const accountingService = require(path.join(SRC, 'services/accountingService'));
  const origLedger = accountingService.getCustomerLedger;
  accountingService.getCustomerLedger = async () => { throw new Error('Sheets 503'); };
  transactionsRepository.getLast = async () => [];
  try {
    const bot = createFakeBot();
    await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-1', saleItem('CJE'), '4242');
    const t = texts(bot);
    assert.match(t, /Step 2 — Rate/, 'the chain proceeds');
    assert.ok(!/Outstanding/.test(t), 'no invented number');
  } finally {
    accountingService.getCustomerLedger = origLedger;
  }
});
