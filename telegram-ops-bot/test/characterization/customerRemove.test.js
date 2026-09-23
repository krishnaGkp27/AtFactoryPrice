'use strict';
/**
 * RMV-1 Phase B — ➖ Remove Customer, driven through the REAL controller:
 * the tile's callback, the typed reason, the confirm card, the queue row,
 * the admins' card — and the executor that the second admin's approval
 * runs. Owner (23-Sep-2026): "deactivate the customer with two admin
 * approvals".
 */
process.env.ADMIN_IDS = '777,778';
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
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const contactsRepository = require(path.join(SRC, 'repositories/contactsRepository'));
const contactLinksRepository = require(path.join(SRC, 'repositories/contactLinksRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const activityRegistry = require(path.join(SRC, 'services/activityRegistry'));

const CUSTOMERS = [
  { customer_id: 'C-001', name: 'testcustomer', phone: '', category: 'Retail', outstanding_balance: 0, status: 'Active', aliases: [], notes: '' },
  { customer_id: 'C-002', name: 'Alhaji_Karim *VIP*', phone: '0803', category: 'Wholesale', outstanding_balance: 125000, status: 'Active', aliases: ['A. Karim'], notes: '' },
  { customer_id: 'C-003', name: 'Gone Already', phone: '', category: 'Retail', outstanding_balance: 0, status: 'inactive', aliases: [], notes: '' },
  { customer_id: 'C-004', name: 'Merged Husk', phone: '', category: 'Retail', outstanding_balance: 0, status: 'Merged', aliases: [], notes: '' },
];
let customers;
let queue;
let updates;
function arm() {
  customers = CUSTOMERS.map((c) => ({ ...c, aliases: [...c.aliases] }));
  queue = new Map(); updates = [];
  customersRepository.getAll = async () => customers.map((c) => ({ ...c }));
  customersRepository.findById = async (id) => { const c = customers.find((x) => x.customer_id === id); return c ? { ...c } : null; };
  customersRepository.updateRow = async (id, fields) => { updates.push({ id, fields }); const c = customers.find((x) => x.customer_id === id); if (c) Object.assign(c, fields); return true; };
  contactsRepository.findByCustomerId = async (id) => (id === 'C-002' ? { contact_id: 'CON-karim', customer_id: 'C-002', status: 'active' } : null);
  contactsRepository.update = async () => true;
  contactLinksRepository.getActive = async () => [{ from_contact_id: 'CON-boy1', to_contact_id: 'CON-karim', status: 'active' }, { from_contact_id: 'CON-boy2', to_contact_id: 'CON-karim', status: 'active' }];
  inventoryRepository.getSoldRows = async () => [
    { soldTo: 'A. Karim', soldDate: '2026-08-01' }, { soldTo: 'Alhaji_Karim *VIP*', soldDate: '2026-09-10' }, { soldTo: 'someone else', soldDate: '2026-09-11' },
  ];
  approvalQueueRepository.append = async (rec) => { queue.set(rec.requestId, { ...rec, status: 'pending', createdAt: new Date().toISOString() }); return rec; };
  approvalQueueRepository.appendOnce = async (rec) => { if (queue.has(rec.requestId)) return { created: false, existing: queue.get(rec.requestId) }; await approvalQueueRepository.append(rec); return { created: true, existing: null }; };
  approvalQueueRepository.getByRequestId = async (id) => (queue.has(id) ? JSON.parse(JSON.stringify(queue.get(id))) : null);
  approvalQueueRepository.getAllPending = async () => [...queue.values()].filter((r) => r.status === 'pending');
  approvalQueueRepository.updateActionJSON = async (id, patch) => { const r = queue.get(id); if (r) r.actionJSON = { ...r.actionJSON, ...patch }; return !!r; };
  approvalQueueRepository.updateStatus = async (id, status) => { const r = queue.get(id); if (r) r.status = status; return !!r; };
  auditLogRepository.append = async () => {};
}
const lastCard = (bot) => bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').pop();
const kb = (bot) => lastCard(bot).args.opts.reply_markup.inline_keyboard.flat();
const typed = (uid, text) => ({ chat: { id: uid }, from: { id: uid }, text });

test('the tile sits in the CRM hub and opens the door for an admin only', async () => {
  arm();
  const tile = activityRegistry.getActivity('remove_customer');
  assert.equal(tile.hub, 'crm'); assert.equal(tile.callback, 'rmc:start');
  const emp = createFakeBot(); sessionStore.clear('4242');
  await controller.handleCallbackQuery(emp, cb('rmc:start', 4242));
  assert.match(emp.allText(), /Admin only/); assert.equal(sessionStore.get('4242'), null);
});

test('remove: pick → reason → card discloses what they owe, their supplies and their network → submit queues ONE dual-admin request', async () => {
  arm(); sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('rmc:start', 777));
  let labels = kb(bot).map((b) => b.text);
  assert.ok(labels.some((t) => t.includes('testcustomer')) && labels.some((t) => t.includes('Alhaji_Karim')), `active customers listed, got ${labels}`);
  assert.ok(!labels.some((t) => t.includes('Gone Already') || t.includes('Merged Husk')), 'inactive and merged husks are not offered for removal');
  // Typed search narrows the list.
  await controller.handleMessage(bot, typed('777', 'karim'));
  labels = kb(bot).map((b) => b.text);
  assert.equal(labels.filter((t) => t.startsWith('👤')).length, 1, `search narrows to one, got ${labels}`);
  const idx = kb(bot).find((b) => b.text.includes('Alhaji_Karim')).callback_data;
  await controller.handleCallbackQuery(bot, cb(idx, 777));
  assert.match(bot.allText(), /Step 2 of 3/);
  // A too-short reason is refused; a real one reaches the card.
  await controller.handleMessage(bot, typed('777', 'no'));
  assert.match(bot.allText(), /must be 3–120 characters/);
  await controller.handleMessage(bot, typed('777', 'dummy row created during testing'));
  const card = lastCard(bot).args.text;
  assert.match(card, /Remove customer/);
  assert.match(card, /Owes 125,000/, 'outstanding disclosed');
  assert.match(card, /2 supply records · last 2026-09-10/, 'supplies counted across the alias too');
  assert.match(card, /2 person\(s\) sit under them/, 'network children counted');
  assert.match(card, /dummy row created during testing/);
  assert.match(card, /Two admins must approve/);
  const reqId = sessionStore.get('777').requestId;
  assert.ok(reqId, 'identity minted when the card was drawn');
  // Submit twice — one row.
  await controller.handleCallbackQuery(bot, cb('rmc:submit', 777));
  assert.equal(queue.size, 1);
  const row = queue.get(reqId);
  assert.equal(row.actionJSON.action, 'remove_customer');
  assert.equal(row.actionJSON.customer_id, 'C-002');
  assert.equal(row.actionJSON.reason, 'dummy row created during testing');
  assert.equal(row.user, '777');
  assert.equal(sessionStore.get('777'), null, 'session cleared');
  // The admins' card went to the OTHER admin only.
  const to778 = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '778');
  assert.ok(to778.length >= 1, 'second admin got the card');
  assert.ok(to778.some((c) => /Remove customer/.test(c.args.text)));
  assert.ok(!bot.calls.some((c) => c.method === 'sendMessage' && String(c.args.chatId) === '777' && /Approve/.test(String(c.args.text)) && c.args.opts && c.args.opts.reply_markup && JSON.stringify(c.args.opts.reply_markup).includes('approve:')), 'the requester cannot approve their own');
  assert.match(bot.allText(), /Submitted for a second admin/);
  assert.equal(updates.length, 0, 'nothing flipped at submit — the approval does that');
});

test('restore mode lists the inactive customers instead, and queues restore_customer', async () => {
  arm(); sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('rmc:start', 777));
  await controller.handleCallbackQuery(bot, cb('rmc:mode:restore', 777));
  const labels = kb(bot).map((b) => b.text);
  assert.ok(labels.some((t) => t.includes('Gone Already')) && !labels.some((t) => t.includes('testcustomer')), `only inactive rows, got ${labels}`);
  await controller.handleCallbackQuery(bot, cb(kb(bot).find((b) => b.text.includes('Gone Already')).callback_data, 777));
  await controller.handleMessage(bot, typed('777', 'they are back in business'));
  assert.match(lastCard(bot).args.text, /Restore customer/);
  await controller.handleCallbackQuery(bot, cb('rmc:submit', 777));
  assert.equal([...queue.values()][0].actionJSON.action, 'restore_customer');
});

test('a stale chip from an earlier list is refused, and Cancel leaves everything untouched', async () => {
  arm(); sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('rmc:start', 777));
  await controller.handleCallbackQuery(bot, cb('rmc:pick:9', 777));
  assert.equal(sessionStore.get('777').target, null, 'nothing picked');
  await controller.handleCallbackQuery(bot, cb('rmc:cancel', 777));
  assert.equal(sessionStore.get('777'), null);
  assert.equal(queue.size, 0); assert.equal(updates.length, 0);
  assert.match(bot.allText(), /nothing was changed/);
});
