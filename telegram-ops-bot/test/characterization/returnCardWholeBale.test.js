'use strict';
/**
 * CARD-8 (owner, 20-Nov-2026) — the owner's own line
 * "Return 631/1+2+3+4+5, 614/1": bale 631 has five thans and all five come
 * back, so the header counts it 1B and the goods list prints it as ONE line
 * (`631 · 5 thans · 150 yd`), not five; the buyer line says when the goods
 * were sold. Driven through the real controller up to the admin card.
 */
process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '555';
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, lastKb } = require('../helpers/charFixture');

const INV_HEADERS = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];
function invRow(pkg, than, soldOn) {
  return [pkg, '', '', '44200', 'BLACK', String(than), '30', 'sold', 'IDUMOTA', '1000', '2026-07-01',
    'solder madam', soldOn, '', '', '', 'fabric', `UID-${pkg}-${than}`, '2026-07-01', '', '', 'Jul26', ''];
}
const CUS_HEADERS = ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases'];
const fakeSheets = createFakeSheets({
  Inventory: [
    INV_HEADERS,
    ...[1, 2, 3, 4, 5].map((t) => invRow('631', t, '2026-11-02')),
    ...[1, 2, 3].map((t) => invRow('614', t, '2026-11-02')),
  ],
  Customers: [
    CUS_HEADERS,
    ['CUS-S', 'solder madam', '080', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
  ],
});
installFakeSheets(fakeSheets);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const auditService = require(path.join(SRC, 'services/auditService'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}`, role: id === '555' ? 'employee' : 'admin' });
auditLogRepository.append = async () => {};
auditService.log = async () => true;
accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 400000 });

const EMP = '555';
const message = (text) => ({ chat: { id: EMP }, from: { id: EMP, first_name: 'Test' }, text });
const lastText = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).pop().args.text;

test('CARD-8: "Return 631/1+2+3+4+5, 614/1" → the full bale is one line, the buyer line says when it was sold', async () => {
  let appended = null;
  approvalQueueRepository.append = async (rec) => { appended = rec; return rec; };
  approvalQueueRepository.getAllPending = async () => [];
  const bot = createFakeBot();
  sessionStore.clear(EMP);
  await controller.handleMessage(bot, message('Return 631/1+2+3+4+5, 614/1'));
  const review = lastText(bot).replace(/\\/g, '');
  assert.match(review, /\n📦 1B \+ 1t · 180 yd\n\n👤 solder madam · 1B \+ 1t · 180 yd · sold 02-Nov-2026\n44200\n Shade BLACK\n {2}1\. 631 · 5 thans · 150 yd\n {2}2\. 614\/1 · 30 yd\n/);

  const cardId = sessionStore.get(EMP).flowMessageId;
  await controller.handleCallbackQuery(bot, cb('rb:go', EMP, cardId));
  const today = lastKb(bot).map((b) => b.callback_data).find((d) => d.startsWith('rb:dd:'));
  await controller.handleCallbackQuery(bot, cb(today, EMP, cardId));
  await controller.handleCallbackQuery(bot, cb('rb:c:good', EMP, cardId));
  await controller.handleCallbackQuery(bot, cb('rb:pskip', EMP, cardId));
  await controller.handleCallbackQuery(bot, cb('rb:submit', EMP, cardId));

  const aj = appended.actionJSON;
  assert.deepEqual(aj.wholeBales, ['631'], 'typed than by than, still the whole bale');
  assert.equal(aj.storedFacts, 1);
  assert.deepEqual(aj.items.map((it) => `${it.packageNo}/${it.thanNo}:${it.soldOn}`),
    ['631/1:2026-11-02', '631/2:2026-11-02', '631/3:2026-11-02', '631/4:2026-11-02', '631/5:2026-11-02', '614/1:2026-11-02']);

  const dm = bot.callsTo('sendMessage').filter((c) => /Approval required/i.test(c.args.text || ''));
  assert.equal(dm.length, 2, 'both admins got the card');
  const text = dm[0].args.text.replace(/\\/g, '');
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('↩️ Return · '));
  assert.ok(at >= 0, text);
  assert.equal(lines[at], '↩️ Return · IDUMOTA · 1B + 1t · 180 yd');
  assert.match(lines[at + 1], /^📅 \d{2}-[A-Z][a-z]{2}-\d{4} · ✅ Good$/);
  assert.deepEqual(lines.slice(at + 2, at + 9), [
    '',
    '👤 solder madam · 1B + 1t · 180 yd · sold 02-Nov-2026',
    '44200',
    ' Shade BLACK',
    '  1. 631 · 5 thans · 150 yd',
    '  2. 614/1 · 30 yd',
    '',
  ]);
  assert.equal(lines[at + 9], '💰 solder madam 180,000 · outstanding 400,000 → 220,000');
});
