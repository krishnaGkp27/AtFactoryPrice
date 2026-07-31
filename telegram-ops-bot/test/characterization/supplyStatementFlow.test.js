'use strict';

/**
 * SLED-1 — Supply Statement: admin-only tile → customer chips → period →
 * a PDF document whose lines are quantities only (Rate/Amount blank).
 * Alias-aware: a merged spelling's supplies consolidate onto the
 * canonical customer's statement.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, kbTexts } = require('../helpers/charFixture');

const INV_HEADERS = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];

function soldRow(pkg, than, design, shade, yards, soldTo, soldDate) {
  return [pkg, '', '', design, shade, than, yards, 'sold', 'Kano office', '1500', '2026-07-01',
    soldTo, soldDate, '', '', '', 'fabric', `UID-${pkg}-${than}`, '2026-07-01', '', '', 'Jul26', ''];
}

const CUS_HEADERS = ['customer_id', 'name', 'phone', 'address', 'category',
  'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status',
  'created_at', 'updated_at', 'aliases'];

installFakeSheets(createFakeSheets({
  Inventory: [
    INV_HEADERS,
    soldRow('P1', '1', '9006', '1', '60', 'Benduku', '2026-07-30'),
    soldRow('P1', '2', '9006', '3', '60', 'Benduku', '2026-07-30'),
    soldRow('P2', '1', '77019', '2', '55', 'Benduku Textiles', '2026-07-22'),
    soldRow('P3', '1', '9006', '1', '60', 'Alhaji Musa', '2026-07-29'),
  ],
  Customers: [
    CUS_HEADERS,
    ['CUS-B', 'Benduku', '080', '', '', 0, 0, '', '', 'Active', '', '', '["Benduku Textiles"]'],
    ['CUS-A', 'Alhaji Musa', '081', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
  ],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const flow = require(path.join(SRC, 'flows/supplyStatementFlow'));
const svc = require(path.join(SRC, 'services/supplyStatementService'));

usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}` });

const ADMIN = '777';

test('the flow is admin-only', async () => {
  const bot = createFakeBot();
  await flow.start(bot, '4242', '4242', null);
  assert.match(bot.allText(), /admin-only/i);
  assert.equal(sessionStore.get('4242'), null);
});

test('tile → customer chips → period → PDF document with quantity caption', async () => {
  const bot = createFakeBot();
  sessionStore.clear(ADMIN);
  await controller.handleCallbackQuery(bot, cb('act:supply_statement', ADMIN));
  const chip = kbTexts(bot).find((t) => t.startsWith('Benduku|sst:c:'));
  assert.ok(chip, `customer chip present, got: ${kbTexts(bot)}`);

  await controller.handleCallbackQuery(bot, cb(chip.split('|')[1], ADMIN));
  assert.ok(kbTexts(bot).some((t) => t.includes('sst:p:all')), 'period chips shown');

  await controller.handleCallbackQuery(bot, cb('sst:p:all', ADMIN));
  const docCall = bot.calls.find((c) => c.method === 'sendDocument');
  assert.ok(docCall, 'a PDF document is sent');
  assert.ok(Buffer.isBuffer(docCall.args.doc), 'document is a rendered buffer');
  assert.match(docCall.args.opts.caption, /Benduku/, 'caption names the customer');
  assert.match(docCall.args.opts.caption, /blank/i, 'caption states money columns are blank');
  assert.equal(sessionStore.get(ADMIN), null, 'session closed after delivery');
});

test('builder: alias supplies consolidate, others excluded, totals quantities only', () => {
  const rows = [
    { status: 'sold', soldTo: 'Benduku', soldDate: '2026-07-30', design: '9006', shade: '1', packageNo: 'P1', yards: 60 },
    { status: 'sold', soldTo: 'Benduku', soldDate: '2026-07-30', design: '9006', shade: '3', packageNo: 'P1', yards: 60 },
    { status: 'sold', soldTo: 'Benduku Textiles', soldDate: '2026-07-22', design: '77019', shade: '2', packageNo: 'P2', yards: 55 },
    { status: 'sold', soldTo: 'Alhaji Musa', soldDate: '2026-07-29', design: '9006', shade: '1', packageNo: 'P3', yards: 60 },
    { status: 'available', soldTo: '', soldDate: '', design: '9006', shade: '1', packageNo: 'P4', yards: 60 },
  ];
  const { lines, totals } = svc.buildStatement(rows, ['Benduku', 'Benduku Textiles']);
  assert.equal(lines.length, 2, 'two chronological lines (per date+design)');
  assert.equal(lines[0].date, '2026-07-30', 'newest first');
  assert.equal(lines[0].bales, 1);
  assert.equal(lines[0].thans, 2);
  assert.equal(lines[0].shades, '1, 3');
  assert.deepEqual(totals, { bales: 2, thans: 3, yards: 175 });
});

test('builder: period lower bound filters old lines', () => {
  const rows = [
    { status: 'sold', soldTo: 'Benduku', soldDate: '2026-07-30', design: '9006', shade: '1', packageNo: 'P1', yards: 60 },
    { status: 'sold', soldTo: 'Benduku', soldDate: '2026-05-01', design: '9006', shade: '1', packageNo: 'P9', yards: 60 },
  ];
  const { lines } = svc.buildStatement(rows, ['Benduku'], { fromDate: '2026-07-01' });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].date, '2026-07-30');
});