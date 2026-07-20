'use strict';

/**
 * ANA-1a — Telegram magic-link login: token mint/redeem lifecycle, the
 * bot tile's role gate, and manager scoping on the ops API.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,5555';
process.env.BOT_API_KEY = 'test-ops-key';
process.env.BASE_URL = 'https://ops.example.test';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const stockTakesRepository = require(path.join(SRC, 'repositories/stockTakesRepository'));
const attendanceService = require(path.join(SRC, 'services/attendanceService'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const webSessionService = require(path.join(SRC, 'services/webSessionService'));
const apiController = require(path.join(SRC, 'controllers/apiController'));

auditLogRepository.append = async () => {};
usersRepository.findByUserId = async (id) => ({
  4242: { user_id: '4242', name: 'Abdul', role: 'manager', departments: ['Sales'], warehouses: ['Kano office'] },
  5555: { user_id: '5555', name: 'Yarima', role: 'employee', departments: ['Sales'], warehouses: [] },
  777: { user_id: '777', name: 'Boss', role: 'admin', departments: [], warehouses: [] },
}[String(id)] || null);
usersRepository.getAll = async () => [
  { user_id: '4242', name: 'Abdul', role: 'manager', status: 'active', departments: ['Sales'], warehouses: ['Kano office'] },
  { user_id: '5555', name: 'Yarima', role: 'employee', status: 'active', departments: ['Sales'], warehouses: [] },
  { user_id: '6666', name: 'Dispatcher', role: 'employee', status: 'active', departments: ['Dispatch'], warehouses: [] },
];
attendanceService.getAudience = async () => [
  { user_id: '5555', name: 'Yarima' }, { user_id: '6666', name: 'Dispatcher' },
];
attendanceService.getTodayAll = async () => ({ date: '2026-07-20', rows: [] });
attendanceService.getConfig = async () => ({ deadlineTime: '09:30', timezone: 'Africa/Lagos' });
stockTakesRepository.getAll = async () => [
  { stocktake_id: 'K1', warehouse: 'Kano office', design: '9032', result: 'reconciled', sheet_bales: 1, sheet_bundles: 0, counted_bales: 1, counted_bundles: 0, auditor: 'x', audited_at: '2026-07-20T09:00:00Z' },
  { stocktake_id: 'L1', warehouse: 'IDUMOTA', design: '77016', result: 'flagged', sheet_bales: 2, sheet_bundles: 0, counted_bales: 5, counted_bundles: 0, auditor: 'y', audited_at: '2026-07-20T09:05:00Z' },
];

function cb(data, uid) {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 2 } };
}
function call(handler, headers = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler({ headers, query: {} }, res);
  });
}

test('tokens are single-use and sessions carry the identity', () => {
  webSessionService._resetForTests();
  const t = webSessionService.mintLoginToken({ userId: '4242', name: 'Abdul', role: 'manager', departments: ['Sales'], warehouses: ['Kano office'] });
  const out = webSessionService.redeemLoginToken(t);
  assert.ok(out && out.sessionId, 'redeems once');
  assert.equal(out.identity.role, 'manager');
  assert.equal(webSessionService.redeemLoginToken(t), null, 'second redeem fails (single use)');
  assert.equal(webSessionService.getSession(out.sessionId).userId, '4242');
  assert.equal(webSessionService.getSession('bogus'), null);
  assert.equal(webSessionService.redeemLoginToken('made-up'), null);
});

test('bot tile: manager gets a one-time /auth link; employee is refused', async () => {
  webSessionService._resetForTests();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:web_dashboard', '4242'));
  const msg = bot.calls.find((c) => c.method === 'sendMessage' && /dashboard login/i.test(c.args.text));
  assert.ok(msg, 'link message sent');
  const btn = msg.args.opts.reply_markup.inline_keyboard.flat()[0];
  assert.match(btn.url, /^https:\/\/ops\.example\.test\/auth\?t=.+/, 'URL button carries the token');
  assert.match(msg.args.text, /works ONCE and expires in 5 minutes/);

  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('act:web_dashboard', '5555'));
  assert.match(bot2.allText(), /for admins and managers/, 'employee refused');
});

test('manager session is dept/region scoped on the ops API; approvals stay admin-only', async () => {
  webSessionService._resetForTests();
  const t = webSessionService.mintLoginToken({ userId: '4242', name: 'Abdul', role: 'manager', departments: ['Sales'], warehouses: ['Kano office'] });
  const { sessionId } = webSessionService.redeemLoginToken(t);
  const cookie = { cookie: `afp_session=${sessionId}` };

  const att = await call(apiController.getOpsAttendance, cookie);
  assert.equal(att.status, 200);
  const names = [...att.body.marked, ...att.body.missing].map((p) => p.name);
  assert.deepEqual(names, ['Yarima'], 'Sales manager sees only Sales people (Dispatcher hidden)');

  const aud = await call(apiController.getOpsStockTakes, cookie);
  assert.deepEqual(aud.body.rows.map((r) => r.warehouse), ['Kano office'], 'Kano manager sees Kano audits only');

  const appr = await call(apiController.getOpsApprovals, cookie);
  assert.equal(appr.status, 403, 'approvals oversight is admin-only');

  // Admin session sees everything.
  const ta = webSessionService.mintLoginToken({ userId: '777', name: 'Boss', role: 'admin', departments: [], warehouses: [] });
  const admin = webSessionService.redeemLoginToken(ta);
  const audAll = await call(apiController.getOpsStockTakes, { cookie: `afp_session=${admin.sessionId}` });
  assert.equal(audAll.body.rows.length, 2);
});
