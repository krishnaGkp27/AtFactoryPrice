'use strict';
/**
 * NAV-3 (owner, 23-Nov-2026: "I want to change the navigation if the user taps
 * on sales and marketing, goes to the second image [the Supply Request store
 * screen]. Whatever features which you see in between, you need to understand
 * and distribute among other tiles in any other second most relevant place";
 * on the chart: "Go with all your recommendations").
 *
 * Drives the REAL controller for every kind of staff and pins, screen by
 * screen, the menus after the move:
 *   🛒 Sales & Marketing is a DOOR onto 🏭 Supply Request (no screen);
 *   🧵 Sell Bundles / Than · 💰 Sell Bale lead 📦 Inventory's own tiles;
 *   🎨 Designs sits under 📦 Inventory, 🧑‍💼 Marketers under 👥 CRM,
 *   📝 Orders (three tiles) under 📋 Tasks & Planning.
 */
process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = 's1,s2,d1,o1,sb1,p1,c1,m1,sm1';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

const INV_H = ['PackageNo','Indent','CSNo','Design','Shade','ThanNo','Yards','Status','Warehouse','PricePerYard','DateReceived','SoldTo','SoldDate','NetMtrs','NetWeight','UpdatedAt','ProductType','bale_uid','addedAt','grn_id','bin_location','arrival_batch','design_category'];
const inv = (pkg, than, wh) => [pkg, 'IND1', '', '9006', '3', than, 30, 'available', wh, 1500, '2026-03-01', '', '', '', '', '', 'fabric', `BAL-${pkg}-${than}`, '2026-03-01', '', '', 'Mar26', 'TR'];
installFakeSheets(createFakeSheets({
  Inventory: [INV_H, inv('5801', 1, 'Lagos'), inv('5801', 2, 'Lagos'), inv('5901', 1, 'Kano office')],
  Settings: [['key', 'value', 'notes']],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();
const logger = require(path.join(SRC, 'utils/logger')); for (const k of ['error', 'warn', 'info', 'debug']) logger[k] = () => {};
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const navGuard = require(path.join(SRC, 'utils/navGuard'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const departmentsRepo = require(path.join(SRC, 'repositories/departmentsRepository'));
const activityRegistry = require(path.join(SRC, 'services/activityRegistry'));

const person = (user_id, name, role, dept, warehouses = []) => ({ user_id, name, role, departments: dept ? [dept] : [], department: dept, status: 'active', warehouses });
const USERS = [
  person('777', 'Krishna', 'admin', '', ['Lagos', 'Kano office']),
  person('s1', 'Sani', 'employee', 'Sales', ['Lagos', 'Kano office']),
  person('s2', 'Sule', 'employee', 'Sales', ['Lagos']),
  person('d1', 'Dan', 'employee', 'Dispatch', ['Lagos']),
  person('o1', 'Ola', 'employee', 'Operations', ['Lagos', 'Kano office']),
  person('sb1', 'Seller', 'employee', 'Seller', ['Lagos']),
  person('p1', 'Photo', 'employee', 'Photo'),
  person('c1', 'Cat', 'employee', 'Catalog'),
  person('m1', 'Mark', 'marketer', 'Sales', ['Lagos']),
  person('sm1', 'Sam', 'salesman', 'Sales', ['Lagos']),
];
usersRepository.getAll = async () => USERS;
usersRepository.findByUserId = async (id) => USERS.find((u) => u.user_id === String(id)) || null;
const DEPTS = {
  Sales: ['supply_request', 'my_orders', 'give_sample', 'customer_details', 'upload_receipt', 'create_order'],
  Dispatch: ['mark_order_delivered', 'my_orders'],
  Operations: ['supply_request', 'sell_bale', 'check_stock', 'list_packages', 'transfer_stock', 'transfers_view'],
  Seller: ['sell_bale'],
  Photo: ['shade_photos', 'upload_design_photo'],
  Catalog: ['loan_catalog', 'return_catalog'],
};
departmentsRepo.findByName = async (n) => (DEPTS[n] ? { dept_name: n, status: 'active', allowed_activities: DEPTS[n] } : null);

const kbOf = (c) => ((c.args.opts && c.args.opts.reply_markup) || c.args.replyMarkup || {}).inline_keyboard;
const rowsOf = (kb) => (kb || []).map((r) => r.map((b) => `${b.text} <${b.callback_data}>`).join(' | '));
const screens = (bot) => bot.calls.filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && kbOf(c));
const lastScreen = (bot) => { const s = screens(bot); return s[s.length - 1]; };

async function menu(uid, more = false) {
  if (more) return tap(uid, 'act:__more__');
  const bot = createFakeBot();
  await controller.handleMessage(bot, { chat: { id: uid }, from: { id: uid, first_name: 'X' }, text: '/menu' });
  return bot;
}
async function tap(uid, data, mid = 5) {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, { id: 'q', data, from: { id: uid }, message: { chat: { id: uid }, message_id: mid } });
  return bot;
}
const menuRows = async (uid, more) => rowsOf(kbOf(lastScreen(await menu(uid, more))));
const hubRows = async (uid, hub) => rowsOf(kbOf(lastScreen(await tap(uid, `act:__hub__:${hub}`))));

test.afterEach(() => { for (const u of USERS) { sessionStore.clear(u.user_id); navGuard.rememberHub(u.user_id, null); } });

test('admin: the main menu keeps its 15 entries in the same order; the first is 🛒 Sales & Marketing, opening the Supply Request', async () => {
  assert.deepEqual(await menuRows('777'), [
    '🛒 Sales & Marketing <act:supply_request> | 📦 Inventory <act:__hub__:inventory>',
    '👥 CRM <act:__hub__:crm> | 💰 Finance <act:__hub__:finance>',
    '🗓 Human Resources <act:__hub__:hr> | 📊 Reporting <act:__hub__:reporting>',
    '📋 More Options (9) <act:__more__>',
  ]);
  assert.deepEqual(await menuRows('777', true), [
    '🛒 Sales & Marketing <act:supply_request> | 📦 Inventory <act:__hub__:inventory>',
    '👥 CRM <act:__hub__:crm> | 💰 Finance <act:__hub__:finance>',
    '🗓 Human Resources <act:__hub__:hr> | 📊 Reporting <act:__hub__:reporting>',
    '📋 Tasks & Planning <act:__hub__:planning> | 🌅 Daily <act:__hub__:daily>',
    '📸 Snap Sale <act:snap_sale> | 🧵 My Collection <act:my_products>',
    '🔍 Warehouse Audit <act:warehouse_audit> | ⏰ Morning Digest <act:morning_digest>',
    '🛂 Approvals <act:approvals_inbox> | 📈 Business Glance <act:business_glance>',
    '📊 Dashboard (web) <act:web_dashboard>',
  ]);
});

test('admin: one tap on 🛒 Sales & Marketing turns the menu message itself into the store screen', async () => {
  const bot = await tap('777', 'act:supply_request', 5);
  const s = lastScreen(bot);
  assert.equal(s.method, 'editMessageText', 'edited in place, not sent under the menu');
  assert.equal(s.args.opts.message_id, 5);
  assert.equal(s.args.text, '📦 *Supply Request*\nTotal: 2B · 90 yds\n\nSelect warehouse:');
  assert.deepEqual(rowsOf(kbOf(s)), [
    '🏭 Kano office · 1B <srf_wh:Kano office>',
    '🏭 Lagos · 1B <srf_wh:Lagos>',
    '🏠 Back to menu <act:__back__>',
  ]);
  assert.equal(bot.calls.filter((c) => c.method === 'sendMessage').length, 0, 'nothing sent under it');
  assert.equal(sessionStore.get('777').flowMessageId, 5, 'the flow is anchored on the old menu message');
  assert.deepEqual(navGuard.footerFor('777'), [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]],
    'the NAV-1 footer never offers "Back to Sales & Marketing" after a door');

  // The store screen's own 🏠 Back to menu ends the flow and draws the menu in its place.
  const back = await tap('777', 'act:__back__', 5);
  assert.equal(sessionStore.get('777'), null, 'the flow is over');
  const m = lastScreen(back);
  assert.equal(m.args.opts.message_id, 5);
  assert.match(m.args.text, /What would you like to do\?/);
  assert.equal(rowsOf(kbOf(m))[0], '🛒 Sales & Marketing <act:supply_request> | 📦 Inventory <act:__hub__:inventory>');
});

test('NAV-3 review: a door tap over a live request takes the old request\'s card down, as the hub tap did; its Cancel cannot touch the new request', async () => {
  // An open supply request at the cart (its card is message 1002), then /menu (1003), then the door.
  sessionStore.set('777', { type: 'supply_req_flow', step: 'cart', flowMessageId: 1002, previewMessageId: 1001, cart: [{ design: '9006', shade: '3', bales: 1 }] });
  const bot = await tap('777', 'act:supply_request', 1003);
  const deleted = bot.calls.filter((c) => c.method === 'deleteMessage').map((c) => Number(c.args.messageId ?? c.args.message_id ?? c.args[1]));
  assert.ok(deleted.includes(1002), `the old cart card is deleted (deleted: ${JSON.stringify(deleted)})`);
  assert.ok(deleted.includes(1001), 'and its photo bubble');
  assert.ok(!deleted.includes(1003), 'the tapped menu message is kept: it becomes the store screen');
  const s = sessionStore.get('777');
  assert.equal(s.flowMessageId, 1003);
  assert.deepEqual(s.cart, [], 'a fresh request');
  // Same door on a fresh menu with no live flow deletes nothing.
  sessionStore.clear('777');
  const quiet = await tap('777', 'act:supply_request', 1004);
  assert.equal(quiet.calls.filter((c) => c.method === 'deleteMessage').length, 0);
});

test('admin: Inventory, Designs, CRM, Marketers, Tasks & Planning and Orders as they read now', async () => {
  assert.deepEqual(await hubRows('777', 'inventory'), [
    '📥 Add Stock <act:__hub__:stock_add> | 🔁 Move Stock <act:__hub__:stock_move>',
    '🏭 Warehouses <act:__hub__:warehouses> | 🎨 Designs <act:__hub__:designs>',
    '🧵 Sell Bundles / Than <act:bundle_sale> | 💰 Sell Bale <act:sell_bale>',
    '📦 Check Stock <act:check_stock> | ✏️ Edit Bale <act:edit_bale>',
    '📋 List Packages <act:list_packages> | 🏭 Inventory Details <act:inventory_details>',
    '💰 Stock Value <act:stock_value>',
    '⬅ Back <act:__back__>',
  ]);
  assert.deepEqual(await hubRows('777', 'designs'), [
    '📷 Upload Product Photo <act:upload_design_photo> | 🖼️ Manage Product Photos <act:manage_design_photos>',
    '🎨 Shade Photos <act:shade_photos> | 📖 Browse Catalog <act:browse_catalog>',
    '🔎 Search Design Photo <act:search_design_photo> | 📊 Catalog Stats <act:catalog_stats>',
    '🏷️ Set Design Category <act:set_design_category>',
    '⬅ Inventory <act:__hub__:inventory> | 🏠 Menu <act:__back__>',
  ]);
  assert.deepEqual(await hubRows('777', 'crm'), [
    '🧑‍💼 Marketers <act:__hub__:marketers> | 👤 Customer Details <act:customer_details>',
    '📄 Supply Statement <act:supply_statement> | 📒 Supply Ledger <act:supply_ledger>',
    '📇 Contact Network <act:contact_network> | ✏️ Add Note <act:add_note>',
    '➕ Add Contact <act:add_customer> | 🆕 Add Prospect <act:add_prospect>',
    '🔀 Merge Customers <act:merge_customers> | ➖ Remove Customer <rmc:start>',
    '🧪 Give Sample <act:give_sample> | 📊 Sample Status <act:sample_status>',
    '⬅ Back <act:__back__>',
  ]);
  assert.deepEqual(await hubRows('777', 'marketers'), [
    '🧑‍💼 Register Marketer <act:register_marketer> | 📦 Supply Catalog <act:supply_catalog>',
    '📋 Loan to Marketer <act:loan_catalog> | ↩️ Return Catalog <act:return_catalog>',
    '📊 Catalog Tracker <act:catalog_tracker> | 🗂️ Manage Catalog Stock <act:manage_catalog_stock>',
    '🧑‍💼 Allocate to Marketer <act:allocate_marketer>',
    '⬅ CRM <act:__hub__:crm> | 🏠 Menu <act:__back__>',
  ]);
  assert.deepEqual(await hubRows('777', 'planning'), [
    '📝 Orders <act:__hub__:orders> | 📨 My Requests <act:my_requests>',
    '📋 Procurement Plan <act:procurement_plan> | 📋 My Tasks <act:my_tasks>',
    '➕ Assign Task <act:assign_task> | 📸 Snap Task <act:snap_task>',
    '👥 Team Tasks <act:team_tasks> | ⏳ Pending Sign-off <act:pending_signoff>',
    '⬅ Back <act:__back__>',
  ]);
  assert.deepEqual(await hubRows('777', 'orders'), [
    '📝 Quick Order Entry <act:create_order> | 📋 My Orders <act:my_orders>',
    '✅ Mark Order Delivered <act:mark_delivered>',
    '⬅ Tasks & Planning <act:__hub__:planning> | 🏠 Menu <act:__back__>',
  ]);
});

test('old buttons in people\'s chats: act:__hub__:sales opens the Supply Request in place; orders / marketers / designs open their group under the new parent', async () => {
  const bot = await tap('777', 'act:__hub__:sales', 9);
  const s = lastScreen(bot);
  assert.equal(s.method, 'editMessageText');
  assert.equal(s.args.opts.message_id, 9);
  assert.equal(s.args.text.split('\n')[0], '📦 *Supply Request*', 'the store screen, never a one-tile screen or "Unknown menu section"');
  assert.equal(sessionStore.get('777').type, 'supply_req_flow');
  assert.ok(!bot.calls.some((c) => /Unknown menu section|No actions available/.test(String(c.args.text || ''))));
  assert.deepEqual((await hubRows('777', 'orders')).pop(), '⬅ Tasks & Planning <act:__hub__:planning> | 🏠 Menu <act:__back__>');
  assert.deepEqual((await hubRows('777', 'marketers')).pop(), '⬅ CRM <act:__hub__:crm> | 🏠 Menu <act:__back__>');
  assert.deepEqual((await hubRows('777', 'designs')).pop(), '⬅ Inventory <act:__hub__:inventory> | 🏠 Menu <act:__back__>');
});

test('old act:__hub__:sales by someone without the Supply Request gets No actions available (their Orders tiles now sit under Tasks & Planning)', async () => {
  const bot = await tap('d1', 'act:__hub__:sales');
  const s = lastScreen(bot);
  assert.equal(s.args.text, '🛒 *Sales & Marketing*\n\n_No actions available in this section._');
  assert.deepEqual(rowsOf(kbOf(s)), ['⬅ Back <act:__back__>']);
  assert.equal(sessionStore.get('d1'), null, 'no supply request was opened');
});

test('a SALES employee: the door; one tap reaches the store screen (two stores) or the design screen (one store); My Orders under Tasks & Planning › Orders', async () => {
  assert.deepEqual(await menuRows('s1'), [
    '🛒 Sales & Marketing <act:supply_request> | 👥 CRM <act:__hub__:crm>',
    '💳 Payments <act:payments> | 📍 Mark Attendance <act:mark_attendance>',
    '📋 Tasks & Planning <act:__hub__:planning> | 🧾 Upload Receipt <act:upload_receipt>',
  ]);
  const two = lastScreen(await tap('s1', 'act:supply_request', 5));
  assert.equal(two.args.opts.message_id, 5);
  assert.equal(two.args.text.split('\n')[0], '📦 *Supply Request*');

  const one = lastScreen(await tap('s2', 'act:supply_request', 6));
  assert.equal(one.method, 'editMessageText');
  assert.equal(one.args.opts.message_id, 6, 'one store: the design screen replaces the menu message');
  assert.match(one.args.text, /^🏭 \*Lagos\* · 🚢 All containers/);
  assert.ok(!rowsOf(kbOf(one)).join('\n').includes('Sales & Marketing'));

  assert.deepEqual(await hubRows('s1', 'planning'), [
    '📝 Orders <act:__hub__:orders> | 📋 My Tasks <act:my_tasks>',
    '📨 My Requests <act:my_requests>',
    '⬅ Back <act:__back__>',
  ]);
  assert.deepEqual(await hubRows('s1', 'orders'), [
    '📋 My Orders <act:my_orders> | 📝 Quick Order Entry <act:create_order>',
    '⬅ Tasks & Planning <act:__hub__:planning> | 🏠 Menu <act:__back__>',
  ]);
});

test('a DISPATCH employee: no 🛒 Sales & Marketing; both tiles under Tasks & Planning › Orders', async () => {
  assert.deepEqual(await menuRows('d1'), [
    '💳 Payments <act:payments> | 📍 Mark Attendance <act:mark_attendance>',
    '📋 Tasks & Planning <act:__hub__:planning>',
  ]);
  assert.deepEqual(await hubRows('d1', 'planning'), [
    '📝 Orders <act:__hub__:orders> | 📋 My Tasks <act:my_tasks>',
    '📨 My Requests <act:my_requests>',
    '⬅ Back <act:__back__>',
  ]);
  assert.deepEqual(await hubRows('d1', 'orders'), [
    '✅ Mark Order Delivered <act:mark_delivered> | 📋 My Orders <act:my_orders>',
    '⬅ Tasks & Planning <act:__hub__:planning> | 🏠 Menu <act:__back__>',
  ]);
});

test('an OPERATIONS employee: the door, and Sell Bale inside Inventory', async () => {
  assert.deepEqual(await menuRows('o1'), [
    '🛒 Sales & Marketing <act:supply_request> | 📦 Inventory <act:__hub__:inventory>',
    '💳 Payments <act:payments> | 📍 Mark Attendance <act:mark_attendance>',
    '📋 Tasks & Planning <act:__hub__:planning>',
  ]);
  assert.deepEqual(await hubRows('o1', 'inventory'), [
    '🔁 Move Stock <act:__hub__:stock_move> | 💰 Sell Bale <act:sell_bale>',
    '📦 Check Stock <act:check_stock> | 📋 List Packages <act:list_packages>',
    '⬅ Back <act:__back__>',
  ]);
});

test('a seller whose only Inventory tile is Sell Bale: promoted onto the main menu under its own name', async () => {
  assert.deepEqual(await menuRows('sb1'), [
    '💰 Sell Bale <act:sell_bale> | 💳 Payments <act:payments>',
    '📍 Mark Attendance <act:mark_attendance> | 📋 Tasks & Planning <act:__hub__:planning>',
  ]);
});

test('a photo person reaches 🎨 Designs under Inventory; a catalogue-book person reaches 🧑‍💼 Marketers under CRM', async () => {
  assert.deepEqual(await menuRows('p1'), [
    '📦 Inventory <act:__hub__:inventory> | 💳 Payments <act:payments>',
    '📍 Mark Attendance <act:mark_attendance> | 📋 Tasks & Planning <act:__hub__:planning>',
  ]);
  assert.deepEqual(await hubRows('p1', 'inventory'), ['🎨 Designs <act:__hub__:designs>', '⬅ Back <act:__back__>']);
  assert.deepEqual(await hubRows('p1', 'designs'), [
    '🎨 Shade Photos <act:shade_photos> | 📷 Upload Product Photo <act:upload_design_photo>',
    '⬅ Inventory <act:__hub__:inventory> | 🏠 Menu <act:__back__>',
  ]);
  assert.deepEqual(await menuRows('c1'), [
    '👥 CRM <act:__hub__:crm> | 💳 Payments <act:payments>',
    '📍 Mark Attendance <act:mark_attendance> | 📋 Tasks & Planning <act:__hub__:planning>',
  ]);
  assert.deepEqual(await hubRows('c1', 'crm'), ['🧑‍💼 Marketers <act:__hub__:marketers>', '⬅ Back <act:__back__>']);
  assert.deepEqual(await hubRows('c1', 'marketers'), [
    '📋 Loan to Marketer <act:loan_catalog> | ↩️ Return Catalog <act:return_catalog>',
    '⬅ CRM <act:__hub__:crm> | 🏠 Menu <act:__back__>',
  ]);
});

test('a marketer and a salesman: the menu is exactly what it was before NAV-3', async () => {
  const before = [
    '🆕 Add Prospect <act:add_prospect> | 💳 Payments <act:payments>',
    '📨 My Requests <act:my_requests> | 🧵 My Collection <act:my_products>',
  ];
  for (const uid of ['m1', 'sm1']) {
    assert.deepEqual(await menuRows(uid), before, uid);
    assert.deepEqual(await menuRows(uid, true), before, `${uid} · More Options`);
  }
});

test('every one of the 20 former Sales & Marketing activities is reachable for an admin in exactly ONE place', async () => {
  const FORMER = ['supply_request', 'create_order', 'my_orders', 'mark_order_delivered', 'bundle_sale', 'sell_bale',
    'register_marketer', 'supply_catalog', 'loan_catalog', 'return_catalog', 'catalog_tracker', 'manage_catalog_stock', 'allocate_marketer',
    'upload_design_photo', 'manage_design_photos', 'shade_photos', 'browse_catalog', 'search_design_photo', 'catalog_stats', 'set_design_category'];
  const found = new Map(); // code → [where]
  const seenHubs = new Set();
  const note = (where, kb) => {
    for (const b of (kb || []).flat()) {
      const a = activityRegistry.getByCallback(b.callback_data);
      if (a) found.set(a.code, [...(found.get(a.code) || []), where]);
    }
  };
  async function walk(where, kb) {
    note(where, kb);
    for (const b of (kb || []).flat()) {
      const m = /^act:__hub__:(.+)$/.exec(b.callback_data || '');
      if (!m || seenHubs.has(m[1])) continue;
      seenHubs.add(m[1]);
      await walk(`${where} › ${m[1]}`, kbOf(lastScreen(await tap('777', b.callback_data))));
    }
  }
  seenHubs.add('sales'); // the door: its one place is the main-menu tile itself
  await walk('menu', kbOf(lastScreen(await menu('777', true))));
  const bad = FORMER.filter((c) => (found.get(c) || []).length !== 1).map((c) => `${c}: ${JSON.stringify(found.get(c) || [])}`);
  assert.deepEqual(bad, [], 'each former Sales & Marketing tile must sit in exactly one place');
  assert.deepEqual(found.get('supply_request'), ['menu']);
  assert.deepEqual(found.get('bundle_sale'), ['menu › inventory']);
  assert.deepEqual(found.get('my_orders'), ['menu › planning › orders']);
  assert.deepEqual(found.get('loan_catalog'), ['menu › crm › marketers']);
  assert.deepEqual(found.get('shade_photos'), ['menu › inventory › designs']);
});
