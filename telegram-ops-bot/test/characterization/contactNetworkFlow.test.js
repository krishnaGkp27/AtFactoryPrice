'use strict';

/**
 * CNET-1b — contact network flow through the REAL controller:
 * tile → categories → buyers → buyer card (shadow node) → add-person
 * wizard (typed name/phone/note) → approval queued → executor links.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const designCategoriesRepo = require(path.join(SRC, 'repositories/designCategoriesRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const contactsRepository = require(path.join(SRC, 'repositories/contactsRepository'));
const contactLinksRepository = require(path.join(SRC, 'repositories/contactLinksRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const inventoryService = require(path.join(SRC, 'services/inventoryService'));

// ── stubs: sold Cashmere history + CRM row + in-memory contacts store ──
inventoryRepository.getAll = async () => [
  { design: '44200', designCategory: 'Cashmere', status: 'sold', soldTo: 'CJE', soldDate: '2026-07-10', warehouse: 'Kano office' },
  { design: '44201', designCategory: 'Cashmere', status: 'sold', soldTo: 'OKSON', soldDate: '2026-06-01', warehouse: 'Lagos' },
];
designCategoriesRepo.listCategories = async () => ['Cashmere', 'Chinos'];
customersRepository.findByName = async (n) => (n === 'CJE' ? { customer_id: 'CUST-9', name: 'CJE', phone: '08031234567', address: 'Kano' } : null);
customersRepository.findById = async (id) => (id === 'CUST-9' ? { customer_id: 'CUST-9', name: 'CJE', phone: '08031234567' } : null);

let contacts = [];
let links = [];
contactsRepository.getAll = async () => [...contacts];
contactsRepository.findByCustomerId = async (id) => contacts.find((c) => c.customer_id === id) || null;
contactsRepository.findById = async (id) => contacts.find((c) => c.contact_id === id) || null;
contactsRepository.findByPhone = async () => null;
contactsRepository.searchByName = async (q) => contacts.filter((c) => c.name.toLowerCase().includes(String(q).toLowerCase()));
contactsRepository.append = async (c) => {
  const row = { status: 'active', phone: '', whatsapp: '', customer_id: '', ...c, contact_id: c.contact_id || `CON-${contacts.length + 1}` };
  contacts.push(row);
  return row;
};
contactsRepository.invalidateCache = () => {};
contactLinksRepository.getActive = async () => links.filter((l) => l.status === 'active');
contactLinksRepository.append = async (l) => {
  const row = { ...l, link_id: `CL-${links.length + 1}`, status: 'active' };
  links.push(row);
  return row;
};

const queued = [];
approvalQueueRepository.append = async (r) => { queued.push(r); };
auditLogRepository.append = async () => {};

function cb(data, uid = '4242') {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 91 } };
}
function txt(text, uid = '4242') {
  return { text, from: { id: uid }, chat: { id: uid } };
}
function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}

test('tile → Cashmere buyers → CJE card with live phone and WhatsApp button', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:contact_network', '777'));
  let kb = lastKb(bot);
  const cash = kb.find((b) => /Cashmere/.test(b.text));
  assert.ok(cash, 'category chip rendered');

  await controller.handleCallbackQuery(bot, cb(cash.callback_data, '777'));
  kb = lastKb(bot);
  const cje = kb.find((b) => b.text === '👤 CJE');
  assert.ok(cje, 'recency-first buyer list shows CJE');

  await controller.handleCallbackQuery(bot, cb(cje.callback_data, '777'));
  assert.match(bot.allText(), /\+2348031234567|08031234567/, 'live CRM phone on the card');
  kb = lastKb(bot);
  assert.ok(kb.some((b) => b.url && b.url.startsWith('https://wa.me/234')), 'wa.me button present');
  assert.equal(contacts.length, 1, 'shadow node created for the buyer');
  assert.equal(contacts[0].customer_id, 'CUST-9');
});

test('add-person wizard: typed name + phone + note → approval queued; executor links', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('cn:add', '777'));
  await controller.handleMessage(bot, txt('Musa', '777'));
  await controller.handleMessage(bot, txt('0803 555 1212', '777'));
  await controller.handleMessage(bot, txt('receives goods', '777'));
  assert.match(bot.allText(), /Add person under CJE/);
  await controller.handleCallbackQuery(bot, cb('cn:ok', '777'));
  assert.equal(queued.length, 1, 'approval row queued');
  const aj = queued[0].actionJSON;
  assert.equal(aj.action, 'add_contact_link');
  assert.equal(aj.phone, '+2348035551212', 'phone normalized in the draft');

  // Approve through the real executor (queue stubbed to return this row).
  approvalQueueRepository.getAllPending = async () => [{ requestId: queued[0].requestId, user: '777', actionJSON: aj, status: 'pending' }];
  approvalQueueRepository.updateStatus = async () => true;
  approvalQueueRepository.updateActionJSON = async () => true;
  const res = await inventoryService.executeApprovedAction(queued[0].requestId, '888');
  assert.equal(res.ok, true);
  assert.equal(links.length, 1, 'edge created');
  assert.equal(links[0].to_contact_id, contacts[0].contact_id, 'linked under CJE');
  assert.equal(contacts.length, 2, 'Musa node created');
  sessionStore.clear('777');
});
