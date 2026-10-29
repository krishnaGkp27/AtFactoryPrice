'use strict';

/**
 * CRM-R1 — customers by region, driven through the REAL controller.
 *
 *  - admin: the region screen (largest first, Prospects, Not placed, All);
 *    a region's list paged eight a page with ◀ Back / Next ▶ and the A–Al
 *    range; 🏙 Change region;
 *  - employee: straight into their own region, no other region, no 🌐 All;
 *    a tap on another region is refused;
 *  - the card's 🏙 line; 🏙 Change store for a prospect (admins and the
 *    region's staff), rewriting col N alone; Back returns to the page;
 *  - ➕ Add Contact: an employee with one store gets it stamped without a
 *    question; an admin picks or places later; the request carries it;
 *  - 📦 Supply Request 🌐 All customers: the region for employees, everyone
 *    for admins.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,4343';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

const CUST_HEADER = ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases', 'stores', 'first_sale_at'];
const cust = (id, name, stores, first) => [id, name, '', '', 'Retail', 0, 0, 'COD', '', 'Active', '2026-10-12', '', '[]', stores, first];
const USERS_HEADER = ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'department', 'warehouses', 'manages', 'notification_prefs'];
const LOC_HEADER = ['name', 'location', 'kind', 'status', 'notes', 'updated_by', 'updated_at'];

const kanoBuyers = Array.from({ length: 9 }, (_, i) => cust(`k${i}`, `Kano Buyer 0${i + 1}`, 'Kano office', '2026-07-0' + ((i % 9) + 1)));
installFakeSheets(createFakeSheets({
  Customers: [CUST_HEADER,
    cust('c1', 'Kafaya Ltd', 'Lagos, IDUMOTA', '2026-08-01'),
    cust('c2', 'ABBA', 'Kano office', '2026-07-03'),
    cust('c3', 'Abdul Gayinu', 'Kano office', ''),
    cust('c4', 'Unplaced Ltd', '', '2026-05-01'),
    cust('c5', 'Zara', '', ''),
    ...kanoBuyers,
  ],
  Users: [USERS_HEADER,
    ['777', 'Krishna', 'admin', '', 'full', 'active', '', 'Admin', '', '', ''],
    ['4242', 'Muhammad', 'employee', '', 'basic', 'active', '', 'Sales', 'Kano office', '', ''],
    ['4343', 'Kafaya', 'employee', '', 'basic', 'active', '', 'Sales', 'IDUMOTA', '', ''],
  ],
  Locations: [LOC_HEADER,
    ['Lagos', 'Lagos', 'warehouse', 'active', '', '', ''],
    ['IDUMOTA', 'Lagos', 'store', 'active', '', '', ''],
    ['Kano office', 'Kano', 'store', 'active', '', '', ''],
  ],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const region = require(path.join(SRC, 'services/customerRegion'));

inventoryRepository.getAll = async () => [];
inventoryRepository.getWarehouses = async () => [];
inventoryRepository.getSoldRows = async () => [];
auditLogRepository.append = async () => {};
approvalEvents.notifyAdminsApprovalRequest = async () => {};
approvalQueueRepository.getAll = async () => [];

const ADMIN = '777';
function last(bot) {
  const c = bot.calls.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)).pop();
  return { text: String((c && c.args.text) || ''), kb: (c && c.args.opts && c.args.opts.reply_markup) ? c.args.opts.reply_markup.inline_keyboard : [] };
}
const chips = (bot) => last(bot).kb.flat().map((b) => b.text);
const chipData = (bot, text) => (last(bot).kb.flat().find((b) => b.text === text) || {}).callback_data;

test('admin: the region screen — largest first, Prospects, Not placed, All, no See all', async () => {
  region._resetForTests();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('cd:pk', ADMIN, 5));
  const { text } = last(bot);
  assert.match(text, /Customer Details\*?\n\nPick a region, then a customer\./);
  const t = chips(bot);
  assert.deepEqual(t, ['🏆 Customer Ranking (global)', '🏙 Kano · 11', '🏙 Lagos · 1', '🆕 Prospects · 2', '❔ Not placed yet · 2', '🌐 All customers · 14', '⬅ Back to menu'], t.join(' | '));
  assert.ok(!t.some((x) => /See All/.test(x)));
});

test('admin: a region paged — ◀ Back / Next ▶, the range, prospects last as 🆕, Change region', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('cd:rg:Kano', ADMIN, 5));
  let { text } = last(bot);
  assert.match(text, /Customer Details · 🏙 Kano/);
  assert.match(text, /Kano office — 11 customers · page 1 of 2 · Ab–Ka/, text);
  let t = chips(bot);
  assert.equal(t.filter((x) => x.startsWith('👤 ')).length, 8);
  assert.ok(t.includes('Next ▶') && !t.includes('◀ Back'));
  assert.ok(t.includes('🏙 Change region') && t.includes('🏠 Menu'));
  assert.equal(chipData(bot, 'Next ▶'), 'cd:pg:Kano:1');
  await controller.handleCallbackQuery(bot, cb('cd:pg:Kano:1', ADMIN, 5));
  ({ text } = last(bot));
  assert.match(text, /page 2 of 2 · Ka–Ab/);
  t = chips(bot);
  assert.ok(t.includes('◀ Back') && !t.includes('Next ▶'));
  assert.ok(t.includes('🆕 Abdul Gayinu'), 'the prospect sits last, marked 🆕');
  assert.ok(!t.some((x) => /Kafaya/.test(x)), 'no Lagos name in Kano');
  await controller.handleCallbackQuery(bot, cb('cd:rg:__p__', ADMIN, 5));
  ({ text } = last(bot));
  assert.match(text, /🆕 Prospects — 2 customers/);
  await controller.handleCallbackQuery(bot, cb('cd:rg:__u__', ADMIN, 5));
  assert.match(last(bot).text, /❔ Not placed yet — 2 customers/);
  assert.ok(chips(bot).includes('👤 Unplaced Ltd') && chips(bot).includes('🆕 Zara'));
});

test('employee: straight into their own region; another region refused; no 🌐 All', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('cd:pk', '4242', 5));
  const { text } = last(bot);
  assert.match(text, /Customer Details · 🏙 Kano/);
  const t = chips(bot);
  assert.ok(t.includes('🆕 Prospects · 1'), t.join(' | '));
  assert.ok(!t.some((x) => /Change region|All customers|Not placed/.test(x)));
  assert.ok(t.includes('🏠 Menu'));
  await controller.handleCallbackQuery(bot, cb('cd:rg:Lagos', '4242', 5));
  assert.ok(!/Kafaya/.test(last(bot).text) && !chips(bot).some((x) => /Kafaya/.test(x)), 'Lagos stays out of reach');
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('cd:pk', '4343', 5));
  assert.match(last(bot2).text, /· 🏙 Lagos/);
  assert.deepEqual(chips(bot2).filter((x) => x.startsWith('👤 ')), ['👤 Kafaya Ltd']);
});

test('the card: the 🏙 line; Change store only for a prospect; rewrites col N; Back returns to the page', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('cd:pg:Kano:1', ADMIN, 5));
  await controller.handleCallbackQuery(bot, cb('cd:c:Abdul Gayinu', ADMIN, 5));
  let { text } = last(bot);
  assert.match(text, /🏙 Kano office · provisional/);
  assert.ok(chips(bot).includes('🏙 Change store'));
  await controller.handleCallbackQuery(bot, cb('cd:c:ABBA', ADMIN, 5));
  ({ text } = last(bot));
  assert.match(text, /🏙 Kano office\n/);
  assert.ok(!chips(bot).includes('🏙 Change store'), 'a buyer\'s store comes from sales');
  // Change store on the prospect
  const written = [];
  customersRepository.setStores = async (id, stores) => { written.push({ id, stores }); return true; };
  await controller.handleCallbackQuery(bot, cb('cd:cs:Abdul Gayinu', ADMIN, 5));
  const storeChip = last(bot).kb.flat().find((b) => b.text === '🏙 IDUMOTA');
  assert.ok(storeChip, chips(bot).join(' | '));
  await controller.handleCallbackQuery(bot, cb(storeChip.callback_data, ADMIN, 5));
  assert.deepEqual(written, [{ id: 'c3', stores: ['IDUMOTA'] }]);
  // Back from the card returns to page 2 of Kano, where the viewer was.
  await controller.handleCallbackQuery(bot, cb('cd:pk', ADMIN, 5));
  assert.match(last(bot).text, /🏙 Kano\n.*page 2 of 2/);
  // Kano staff may re-place a Kano prospect; a Lagos buyer is not theirs.
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('cd:c:Abdul Gayinu', '4242', 5));
  assert.ok(chips(bot2).includes('🏙 Change store'));
  await controller.handleCallbackQuery(bot2, cb('cd:cs:Kafaya Ltd', '4242', 5));
  assert.equal(written.length, 1);
});

test('Add Contact: one-store employee stamped silently; admin picks or places later; the request carries it', async () => {
  const queued = [];
  approvalQueueRepository.append = async (row) => { queued.push(row); return row; };
  const base = { type: 'add_customer_flow', step: 'notes', personType: 'customer', name: 'New Kano Shop', phone: '0801', address: '', category: 'Retail', credit_limit: 0, payment_terms: 'COD', flowMessageId: 5 };
  sessionStore.set('4242', { ...base });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('acskip:notes', '4242', 5));
  assert.match(last(bot).text, /✓ Store: \*Kano office\* _\(provisional\)_/, last(bot).text);
  assert.match(last(bot).text, /Confirm and submit/);
  await controller.handleCallbackQuery(bot, cb('acconf:1', '4242', 5));
  assert.deepEqual(queued.pop().actionJSON.stores, ['Kano office']);
  // An admin has no store of their own: pick, or place later.
  sessionStore.set(ADMIN, { ...base, name: 'Admin Added Ltd' });
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('acskip:notes', ADMIN, 5));
  assert.match(last(bot2).text, /Which store does this customer belong to/);
  const t = chips(bot2);
  assert.ok(t.includes('🏙 Kano office') && t.includes('🏙 IDUMOTA') && t.includes('❔ Place later'), t.join(' | '));
  await controller.handleCallbackQuery(bot2, cb(chipData(bot2, '🏙 IDUMOTA'), ADMIN, 5));
  assert.match(last(bot2).text, /✓ Store: \*IDUMOTA\* _\(provisional\)_/);
  await controller.handleCallbackQuery(bot2, cb('acconf:1', ADMIN, 5));
  assert.deepEqual(queued.pop().actionJSON.stores, ['IDUMOTA']);
  sessionStore.set(ADMIN, { ...base, name: 'Later Ltd' });
  const bot3 = createFakeBot();
  await controller.handleCallbackQuery(bot3, cb('acskip:notes', ADMIN, 5));
  await controller.handleCallbackQuery(bot3, cb('acst:__later__', ADMIN, 5));
  assert.ok(!/✓ Store/.test(last(bot3).text));
  await controller.handleCallbackQuery(bot3, cb('acconf:1', ADMIN, 5));
  assert.equal(queued.pop().actionJSON.stores, undefined);
});

test('Supply Request 🌐 All customers: the region for an employee, everyone for an admin', async () => {
  const mk = (uid) => sessionStore.set(uid, { type: 'supply_req_flow', step: 'cart', warehouse: 'Kano office', arrivalBatch: '', cart: [{ design: '9006', shade: '2', quantity: 1 }], _scopeWarehouses: [], flowMessageId: 50 });
  mk('4242');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cu:__all__', '4242', 50));
  assert.match(last(bot).text, /^👤 All customers of Kano:/, last(bot).text);
  const t = chips(bot);
  assert.ok(t.includes('👤 ABBA') && t.includes('🆕 Zara'), 'the region and the unplaced');
  assert.ok(!t.some((x) => /Kafaya/.test(x)), 'Lagos stays out');
  mk(ADMIN);
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('srf_cu:__all__', ADMIN, 50));
  assert.match(last(bot2).text, /^👤 All customers, every store:/);
  assert.ok(chips(bot2).some((x) => /Kafaya/.test(x)));
});
