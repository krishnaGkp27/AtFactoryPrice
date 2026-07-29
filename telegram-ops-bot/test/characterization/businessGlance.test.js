'use strict';

/**
 * GLA-1 — 📈 Business Glance: one card, five live numbers, degrades
 * per-section. A glance that dies on the slowest sheet is a glance nobody
 * opens twice — so a broken section renders "unavailable", never a blank.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

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
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const attendanceService = require(path.join(SRC, 'services/attendanceService'));
const samplesRepository = require(path.join(SRC, 'repositories/samplesRepository'));
const { todayInLagos } = require(path.join(SRC, 'utils/dates'));

function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }

approvalQueueRepository.getAllPending = async () => ([
  { requestId: 'R-1', createdAt: daysAgo(3), actionJSON: { action: 'sell_package' } },
  { requestId: 'R-2', createdAt: daysAgo(0), actionJSON: { action: 'add_contact' } },
]);
transactionsRepository.getBySalesDateRange = async () => ([
  { action: 'sell_package', status: 'approved', qty: 60, customerName: 'CJE', salesDate: todayInLagos() },
  { action: 'sale_bundle', status: 'approved', qty: 90, customerName: 'Ketu madam', salesDate: todayInLagos() },
]);
inventoryRepository.getAll = async () => ([
  { packageNo: '896', warehouse: 'IDUMOTA', status: 'available' },
  { packageNo: '896', warehouse: 'IDUMOTA', status: 'available' }, // 2nd than, same bale
  { packageNo: '897', warehouse: 'Kano office', status: 'available' },
  { packageNo: '898', warehouse: 'Kano office', status: 'sold' },
]);
attendanceService.getAudience = async () => ([{ user_id: '1' }, { user_id: '2' }, { user_id: '3' }]);
attendanceService.getTodayAll = async () => ({ rows: [{ telegram_id: '1' }] });
samplesRepository.getActive = async () => ([{ sample_id: 'S-1' }]);

function lastText(bot) {
  const c = bot.calls.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)).pop();
  return c ? c.args.text : '';
}

test('GLA-1: one card carries approvals, sales, stock, attendance and samples', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:business_glance', '777'));
  const t = lastText(bot);
  assert.match(t, /Business Glance/);
  assert.match(t, /Approvals: \*2 waiting\* · oldest 3d/);
  assert.match(t, /Sales today: \*2\* \(150 yds · 2 customers\)/);
  assert.match(t, /Stock: \*2 bales available\*/, 'two thans of one bale count ONCE; sold bales excluded');
  assert.match(t, /IDUMOTA 1/);
  assert.match(t, /Kano office 1/);
  assert.match(t, /Attendance: \*1\/3\* marked · \*2 missing\*/);
  assert.match(t, /Samples out: \*1\*/);
  sessionStore.clear('777');
});

test('GLA-1: a broken sheet degrades ONE section, never the card', async () => {
  const orig = inventoryRepository.getAll;
  inventoryRepository.getAll = async () => { throw new Error('Sheets 503'); };
  try {
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('act:business_glance', '777'));
    const t = lastText(bot);
    assert.match(t, /stock: unavailable right now/i, 'the failed section says so');
    assert.match(t, /Approvals: \*2 waiting\*/, 'every other section still renders');
  } finally {
    inventoryRepository.getAll = orig;
  }
  sessionStore.clear('777');
});

test('GLA-1: admin-only', async () => {
  const bot = createFakeBot();
  const flow = require(path.join(SRC, 'flows/businessGlanceFlow'));
  await flow.start(bot, '4242', '4242', null);
  assert.match(lastText(bot), /admin-only/i);
});
