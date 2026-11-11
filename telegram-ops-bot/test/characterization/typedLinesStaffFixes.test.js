'use strict';

/**
 * FIX-TYPED (11-Nov-2026) — faults found while the staff test script for the
 * typed lines was checked against the code, driven through the REAL
 * controller with the AI switched off (Settings AI_TEXT_PARSER = 0):
 *
 *  1. `Customer <name>` printed the credit limit and the outstanding to any
 *     registered user, although FIN-V2 (owner, 07-Oct-2026) made customer
 *     money admins-only and `Balance` / `Ledger` already refuse.
 *  2. `Report sales` gave any employee the all-time sold report with its
 *     `Value:` line; the 📊 Sales Report tile answers `Admin only.`.
 *  3. `/start`, `/menu` (the Telegram Menu button) and `/home` did not open
 *     the menu: `/menu` answered a one-button card, `/start` the chips card.
 *  5. The Orders list ended on `Mark order <id> delivered` — a sentence that
 *     gets the chips card. The line the bot reads is `Delivered <id>`.
 *
 * Money negatives are pinned on the DIGITS a role must not see.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,5151';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { lastKb } = require('../helpers/charFixture');

const INV_HEADER = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];
// Two thans of bale 6061 sold at 3,500/yd: 2 × 60 yd × 3,500 = 420,000.
// Bales 771 and 779 (one than each, no rate) are there for the return line.
const sold = (pkg, than, rate) => [pkg, '', '', '9043-A', '6', String(than), '60', 'sold', 'Kano office',
  String(rate), '2026-02-10', 'Qaribullah', '2026-03-05', '', '', '', 'fabric', `U-${pkg}-${than}`, '2026-02-10', '', '', 'Feb26', ''];
installFakeSheets(createFakeSheets({
  Inventory: [INV_HEADER, sold('6061', 1, 3500), sold('6061', 2, 3500), sold('771', 1, 0), sold('779', 1, 0)],
}));

let aiIntent = { action: 'unknown', confidence: 0 };
let intentCalls = 0;
installFakeIntent(() => { intentCalls += 1; return aiIntent; });

const controller = loadController();
const typedRouter = require(path.join(SRC, 'utils/typedRouter'));
const money = require(path.join(SRC, 'utils/money'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const menuAnchor = require(path.join(SRC, 'services/menuAnchor'));
const crmService = require(path.join(SRC, 'services/crmService'));
const pendingUserService = require(path.join(SRC, 'services/pendingUserService'));
const linkedAccessService = require(path.join(SRC, 'services/linkedAccessService'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const departmentsRepo = require(path.join(SRC, 'repositories/departmentsRepository'));
const ordersRepo = require(path.join(SRC, 'repositories/ordersRepository'));
const settingsRepo = require(path.join(SRC, 'repositories/settingsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

const USERS = [
  { user_id: '4242', name: 'Abdul', role: 'employee', departments: ['Sales'], department: 'Sales', status: 'active' },
  { user_id: '5151', name: 'Sani', role: 'marketer', departments: ['Sales'], department: 'Sales', status: 'active' },
];
usersRepository.getAll = async () => USERS;
usersRepository.findByUserId = async (id) => USERS.find((u) => u.user_id === String(id)) || null;
departmentsRepo.findByName = async (name) => ({
  Sales: { dept_id: 'DEPT-001', dept_name: 'Sales', status: 'active', allowed_activities: ['supply_request', 'my_orders'] },
}[name] || null);
auditLogRepository.append = async () => {};
linkedAccessService.infoFor = async () => null;

let anchorEnabled = 0;
const realGetAll = settingsRepo.getAll;
settingsRepo.getAll = async () => ({ ...settingsRepo.DEFAULTS, MENU_ANCHOR_ENABLED: anchorEnabled });

crmService.getCustomer = async () => ({
  name: 'Alhaji Musa', customer_id: 'C1', category: 'Standard', status: 'active', phone: '0803',
  outstanding_balance: 140000, credit_limit: 500000, payment_terms: 'COD',
});

const ORDER = {
  order_id: 'ORD-20260221-001', design: '9006', customer: 'Abba', quantity: 3, scheduled_date: '2026-02-25',
  payment_status: 'unpaid', status: 'accepted', salesperson_id: '4242', salesperson_name: 'Abdul',
};
ordersRepo.getByAssignee = async () => [ORDER];
ordersRepo.getById = async () => ({ ...ORDER, status: 'delivered' });
let orderWrites = 0;
ordersRepo.updateStatus = async () => { orderWrites += 1; };

const msg = (text, uid) => ({ chat: { id: uid }, from: { id: uid, first_name: 'T' }, text });
async function send(text, uid = '4242') {
  sessionStore.clear(uid);
  intentCalls = 0;
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg(text, uid));
  return bot;
}
/** What the bot painted, without the message ids a fresh fake bot hands out. */
const painted = (bot) => bot.calls
  .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method))
  .map((c) => [c.method, c.args.text, JSON.stringify((c.args.opts || {}).reply_markup || null)]);

test.beforeEach(() => { typedRouter.forceMode('0'); anchorEnabled = 0; menuAnchor._resetForTests(); });
test.after(() => { typedRouter.forceMode(null); settingsRepo.getAll = realGetAll; });

/* ── 1. Customer <name> ─────────────────────────────────────────────── */

test('Customer <name>: an employee gets the card WITHOUT the credit limit and the outstanding', async () => {
  const bot = await send('Customer Alhaji Musa', '4242');
  const text = bot.allText();
  assert.equal(intentCalls, 0, 'read locally');
  assert.match(text, /👤 \*Alhaji Musa\* \(C1\)\nCategory: Standard \| Status: active\nPhone: 0803\nTerms: COD$/, `got: ${text}`);
  assert.doesNotMatch(text, /Credit limit/);
  assert.doesNotMatch(text, /Outstanding/);
  assert.ok(!text.includes('140'), 'the outstanding figure must not leak');
  assert.ok(!text.includes('500'), 'the credit limit must not leak');
});

test('Customer <name>: an admin sees the card exactly as before, money lines included', async () => {
  const bot = await send('Customer Alhaji Musa', '777');
  assert.equal(bot.allText(),
    '👤 *Alhaji Musa* (C1)\nCategory: Standard | Status: active\nPhone: 0803\nCredit limit: 500,000\nOutstanding: 140,000\nTerms: COD');
});

test('Customer <name>: the money legend follows the money lines — admin only', async () => {
  const real = money.saleLegend;
  money.saleLegend = () => 'figures in thousands';
  try {
    assert.doesNotMatch((await send('Customer Alhaji Musa', '4242')).allText(), /figures in thousands/);
    assert.match((await send('Customer Alhaji Musa', '777')).allText(), /Terms: COD\n_figures in thousands_$/);
  } finally { money.saleLegend = real; }
});

/* ── 2. Report sales ────────────────────────────────────────────────── */

test('Report sales: an employee gets the tile\'s refusal — no report, no Value line', async () => {
  for (const line of ['Report sales', 'report sold', 'Reports sales']) {
    const bot = await send(line, '4242');
    const text = bot.allText();
    assert.equal(text, 'Admin only.', line);
    assert.ok(!text.includes('420'), 'the sold value must not leak');
  }
});

test('Report sales: an admin sees the sold report as before', async () => {
  const bot = await send('Report sales', '777');
  const text = bot.allText();
  assert.match(text, /📤 \*Sold Report — All Time\*\n\nSold: 3 packages \(4 thans\), 240 yards\nValue: 420,000/, `got: ${text}`);
});

test('Report sales: the gate sits on the branch, so the AI-named action is refused the same way', async () => {
  typedRouter.forceMode('1');
  aiIntent = { action: 'report_sold', warehouse: 'Kano office', confidence: 0.95, clarification: null };
  const emp = await send('How many sold from Kano office?', '4242');
  assert.equal(emp.allText(), 'Admin only.');
  const adm = await send('How many sold from Kano office?', '777');
  assert.match(adm.allText(), /Sold Report[\s\S]*Value: 420,000/);
  aiIntent = { action: 'unknown', confidence: 0 };
});

/* ── 3. /start · /menu · /home ──────────────────────────────────────── */

test('/start, /menu and /home open the menu itself — exactly what the typed word menu does', async () => {
  for (const uid of ['777', '4242']) {
    const word = painted(await send('menu', uid));
    assert.equal(word.length, 1, 'the menu is one message');
    assert.match(word[0][1], /Hi/);
    assert.ok(word[0][2].includes('act:'), 'it carries the menu keyboard');
    for (const line of ['/start', '/menu', '/home', '/Menu', '/START', '/menu@AtFactoryPriceBot', '/start@AtFactoryPriceBot', ' /menu ']) {
      const bot = await send(line, uid);
      assert.equal(intentCalls, 0, line);
      assert.deepEqual(painted(bot), word, `${line} (user ${uid}) must paint the same menu as "menu"`);
      assert.doesNotMatch(bot.allText(), /one tap away|I work with the chips/, line);
    }
  }
});

test('/help stays the chips card; a slash in front of any other word is not a greeting', async () => {
  const help = await send('/help', '4242');
  assert.match(help.allText(), /I work with the chips[\s\S]*Help — this card/);
  assert.deepEqual(lastKb(help).map((b) => b.callback_data), ['act:__back__']);
  // `/start` with a payload and a slash-word outside the three stay where they were.
  assert.match((await send('/start abc', '4242')).allText(), /I work with the chips/);
  assert.match((await send('/menus', '4242')).allText(), /I work with the chips/);
  // The script word "Menu …" with a body keeps its one-button card.
  assert.match((await send('Menu please', '4242')).allText(), /The menu is one tap away/);
});

test('MNU-1 on or off: /menu takes the same path as the word menu', async () => {
  for (const flag of [0, 1]) {
    // No anchor yet → a fresh menu, and (flag on) it becomes the anchor.
    anchorEnabled = flag; menuAnchor._resetForTests();
    const word = await send('menu', '777');
    const wordAnchor = menuAnchor.get('777');
    anchorEnabled = flag; menuAnchor._resetForTests();
    const slash = await send('/menu', '777');
    assert.deepEqual(painted(slash), painted(word), `flag ${flag}: same menu`);
    assert.equal(slash.callsTo('sendMessage').length, 1, `flag ${flag}: one fresh menu`);
    assert.equal(!!menuAnchor.get('777'), !!wordAnchor, `flag ${flag}: the anchor is set exactly when the word sets it`);
    assert.equal(!!menuAnchor.get('777'), flag === 1);
  }
  // Flag on, the anchor is the last message in the chat → both EDIT it in place.
  anchorEnabled = 1;
  for (const line of ['menu', '/menu', '/start']) {
    menuAnchor._resetForTests();
    menuAnchor.compareAndSet('777', null, { anchorMessageId: 900, view: 'main_menu' });
    menuAnchor.noteMessage('777', 900);
    const bot = await send(line, '777');
    const edits = bot.callsTo('editMessageText');
    assert.equal(edits.length, 1, `${line}: the live menu is edited`);
    assert.equal(edits[0].args.opts.message_id, 900, line);
    assert.equal(bot.callsTo('sendMessage').length, 0, `${line}: no second menu`);
  }
});

test('a stranger\'s /start still goes to the pending-user door, never to the menu', async () => {
  const real = pendingUserService.captureStranger;
  const captured = [];
  pendingUserService.captureStranger = async (_bot, m) => { captured.push(m.text); };
  try {
    for (const line of ['/start', '/menu']) {
      const bot = createFakeBot();
      await controller.handleMessage(bot, msg(line, '99001'));
      assert.equal(painted(bot).length, 0, `${line}: nothing is painted for an unregistered id`);
    }
    assert.deepEqual(captured, ['/start', '/menu']);
  } finally { pendingUserService.captureStranger = real; }
});

test('a marketer\'s /menu is the greeting too: the menu, as for the word menu', async () => {
  const word = painted(await send('menu', '5151'));
  assert.deepEqual(painted(await send('/menu', '5151')), word);
});

/* ── 5. the Orders hint ─────────────────────────────────────────────── */

test('Orders: the hint names the line the bot reads today — and that line reaches the delivered door', async () => {
  const bot = await send('Orders', '4242');
  const text = bot.allText();
  assert.match(text, /📋 \*Your Supply Orders\*/);
  assert.match(text, /To mark delivered: "Delivered ORD-20260221-001"$/, `got: ${text}`);
  assert.doesNotMatch(text, /Mark order/);
  // Typing exactly what the hint says is read locally and lands on the order.
  const typed = await send('Delivered ORD-20260221-001', '4242');
  assert.equal(intentCalls, 0);
  assert.equal(typed.allText(), 'Order ORD-20260221-001 is already marked as delivered.');
  // The old sentence is what the chips card answers now.
  assert.match((await send('Mark order ORD-20260221-001 delivered', '4242')).allText(), /I work with the chips/);
  assert.equal(orderWrites, 0, 'the test wrote nothing');
});

/* ── 6. a list joined by spaces (the return line shares the sell tokeniser) ── */

test('Return 771 779: both bales reach the review card — the second is no longer dropped', async () => {
  const bot = await send('Return 771 779', '4242');
  const text = bot.allText().replace(/\\/g, '');
  assert.equal(intentCalls, 0);
  assert.match(text, /↩️ \*Return\*/, `got: ${text}`);
  assert.match(text, /771 · 60 yd/);
  assert.match(text, /779 · 60 yd/);
  assert.equal(sessionStore.get('4242').bales.length, 2);
  sessionStore.clear('4242');
});
