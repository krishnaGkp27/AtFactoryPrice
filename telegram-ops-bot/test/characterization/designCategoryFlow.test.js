'use strict';

/**
 * DCAT-1 — Set Design Category: dual-admin mapping of design → category.
 *
 *   admin taps 🏷️ Set Design Category → design chip → category chip →
 *   confirm → approval queue (set_design_category, ALWAYS_APPROVAL) →
 *   requester CANNOT self-approve → 2nd admin approves → Inventory's
 *   design_category column (W) stamped on every row of the design →
 *   labels appear everywhere (getMaterialInfo, transfer blocks, pickers).
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = 'emp1';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, kbTexts: lastKb } = require('../helpers/charFixture');

/** 23-column Inventory row (A..W); design at [3], status [7], category at [22]. */
function invRow(pkg, design, category = '') {
  return [pkg, '', '', design, '1', '1', '100', 'available', 'Lagos', '0', '2026-07-01',
    '', '', '', '', '', 'fabric', `UID-${pkg}`, '2026-07-01', '', '', '', category];
}

// Seed sheets WITH their header row (row 0) — readRange('A2:…') slices it off.
const fakeSheets = createFakeSheets({
  Inventory: [
    ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
      'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
      'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'],
    invRow('P1', '80045'),
    invRow('P2', '80045'),
    invRow('P3', '9006', 'Chinos'),
  ],
});
installFakeSheets(fakeSheets);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const designCategoriesRepository = require(path.join(SRC, 'repositories/designCategoriesRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const transferFlow = require(path.join(SRC, 'flows/transferFlow'));

auditLogRepository.append = async () => {};
usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}` });

/** In-memory ApprovalQueue (mirrors the armQueue helper in the TRF tests). */
function armQueue() {
  const calls = { appended: null };
  let row = null;
  approvalQueueRepository.append = async (rec) => { calls.appended = rec; row = { ...rec, status: 'pending' }; return rec; };
  approvalQueueRepository.getByRequestId = async () => (row ? JSON.parse(JSON.stringify(row)) : null);
  approvalQueueRepository.getAllPending = async () => (row && row.status === 'pending' ? [JSON.parse(JSON.stringify(row))] : []);
  approvalQueueRepository.updateStatus = async (id, status) => { row.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { row.actionJSON = { ...row.actionJSON, ...patch }; return true; };
  return calls;
}


/** Drive the wizard to a queued request: 80045 → Senator. */
async function submitRequest() {
  const calls = armQueue();
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:set_design_category', 777));
  await controller.handleCallbackQuery(bot, cb('dcat:dg:0', 777));   // 80045
  await controller.handleCallbackQuery(bot, cb('dcat:ct:3', 777));   // Senator
  await controller.handleCallbackQuery(bot, cb('dcat:submit', 777));
  return { bot, calls, requestId: calls.appended && calls.appended.requestId };
}

test('wizard chips: designs show current category; picker offers the 5 defaults', async () => {
  armQueue();
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:set_design_category', 777));
  let kb = lastKb(bot);
  assert.ok(kb.some((b) => b.startsWith('80045|')), '80045 chip bare (unmapped)');
  assert.ok(kb.some((b) => b.startsWith('9006 · Chinos|')), '9006 chip carries its category');

  await controller.handleCallbackQuery(bot, cb('dcat:dg:0', 777));
  kb = lastKb(bot);
  for (const cat of ['Cashmere', 'Chinos', 'Gaberdine', 'Senator', 'TR']) {
    assert.ok(kb.some((b) => b.startsWith(`${cat}|`) || b.startsWith(`✓ ${cat}|`)), `category chip ${cat}`);
  }
  sessionStore.clear('777');
});

test('submit queues set_design_category and notifies the OTHER admin only', async () => {
  const { bot, calls, requestId } = await submitRequest();
  assert.ok(requestId, 'request queued');
  assert.deepEqual(calls.appended.actionJSON, {
    action: 'set_design_category', design: '80045', category: 'Senator', prevCategory: '',
  });
  assert.match(bot.allText(), /Submitted for approval/);
  const notified = bot.callsTo('sendMessage').map((c) => String(c.args.chatId));
  assert.ok(notified.includes('888'), '2nd admin notified');
  assert.ok(!notified.includes('777') || !bot.callsTo('sendMessage')
    .some((c) => String(c.args.chatId) === '777' && /Approval required/.test(c.args.text || '')),
  'requester not asked to approve their own request');
});

test('requester cannot self-approve; 2nd admin approval writes the sheet + label goes live', async () => {
  const { requestId } = await submitRequest();

  // Requester taps Approve on their own request → blocked with an alert.
  const botSelf = createFakeBot();
  await controller.handleCallbackQuery(botSelf, cb(`approve:${requestId}`, 777));
  const alerts = botSelf.callsTo('answerCallbackQuery').map((c) => (c.args.opts && c.args.opts.text) || '');
  assert.ok(alerts.some((t) => /cannot approve your own/i.test(t)), 'self-approval blocked');
  const pendingStill = await approvalQueueRepository.getAllPending();
  assert.equal(pendingStill.length, 1, 'request still pending after blocked self-approve');

  // 2nd admin approves → Inventory column W stamped on every 80045 row,
  // cache refreshed, labels live.
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`approve:${requestId}`, 888));
  assert.match(bot2.allText(), /approved/i);
  const invRows = fakeSheets._store.get('Inventory').slice(1);
  const rows80045 = invRows.filter((r) => r[3] === '80045');
  assert.ok(rows80045.length === 2 && rows80045.every((r) => r[22] === 'Senator'),
    'design_category (col W) stamped on every 80045 row');
  assert.equal(await designCategoriesRepository.categoryOf('80045'), 'Senator');
  assert.equal(designCategoriesRepository.categoryOfSync('80045'), 'Senator');

  // getMaterialInfo now serves the real mapping (no fake defaults).
  assert.deepEqual(productTypesRepo.getMaterialInfo('80045'), { icon: '🧵', name: 'Senator' });
  assert.equal(productTypesRepo.getMaterialInfo('UNMAPPED').name, '', 'unmapped design renders bare');

  // Transfer grouped blocks pick the label up too.
  const block = transferFlow._internals.linesBlock([{ design: '80045', shade: '1', qty: 2 }]);
  assert.match(block, /\*80045\* · Senator/);
});

test('employee entry is refused at the act gate', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:set_design_category', 'emp1'));
  assert.match(bot.allText(), /Admin only/);
});

test('duplicate pending change for the same design is rejected', async () => {
  const { requestId } = await submitRequest();
  assert.ok(requestId);
  // Second attempt for the same design while the first is still pending.
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:set_design_category', 777));
  await controller.handleCallbackQuery(bot, cb('dcat:dg:0', 777));
  await controller.handleCallbackQuery(bot, cb('dcat:ct:0', 777));
  await controller.handleCallbackQuery(bot, cb('dcat:submit', 777));
  assert.match(bot.allText(), /already awaiting approval/);
  sessionStore.clear('777');
});

test('stale dcat callback (no session) answers with an expiry alert', async () => {
  sessionStore.clear('888');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('dcat:dg:0', 888));
  const alerts = bot.callsTo('answerCallbackQuery').map((c) => (c.args.opts && c.args.opts.text) || '');
  assert.ok(alerts.some((t) => /expired/i.test(t)), 'expiry alert shown');
});
