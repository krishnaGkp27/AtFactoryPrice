'use strict';

/**
 * IDR-4 — the 👋 Pending Users queue, RENDERED.
 *
 * Drives the real flow module with a fake bot and fixture register rows:
 * the queue chips + pager, the triage card with its seven doors, Ignore
 * landing back on the queue without the person, and the two ➕ shortcuts
 * entering the existing flows with the name pre-filled and the account
 * carried for link-on-approval.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../src');
const pendingUsersFlow = require(path.join(SRC, 'flows/pendingUsersFlow'));
const pendingUsersRepo = require(path.join(SRC, 'repositories/pendingUsersRepository'));
const pendingUserService = require(path.join(SRC, 'services/pendingUserService'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const auth = require(path.join(SRC, 'middlewares/auth'));

const ADMIN = '100';
auth.isAdmin = (id) => String(id) === ADMIN;

let ROWS = [];
pendingUsersRepo.getAll = async () => ROWS.map((r) => ({ ...r }));
pendingUsersRepo.findByTelegramId = async (id) =>
  (ROWS.find((r) => r.telegram_id === String(id)) || null) && { ...ROWS.find((r) => r.telegram_id === String(id)) };
pendingUsersRepo.updateStatus = async (id, status, by) => {
  const r = ROWS.find((x) => x.telegram_id === String(id));
  if (r) { r.status = status; r.handled_by = by; r.handled_at = new Date().toISOString(); }
  return !!r;
};

const DAY = 86400000;
function seed(n = 3) {
  const at = (d) => new Date(Date.now() - d * DAY).toISOString();
  ROWS = [
    { telegram_id: '7034987385', first_name: 'Goku', last_name: 'Son', username: '', arrived_at: at(0), status: 'pending' },
    { telegram_id: '7000000002', first_name: 'Vegeta', username: 'vegeta', arrived_at: at(2), status: 'pending' },
    { telegram_id: '7000000003', first_name: 'Bulma', username: '', arrived_at: at(9), status: 'pending' },
    { telegram_id: '7000000004', first_name: 'ChiChi', username: '', arrived_at: at(20), status: 'linked', link_type: 'customer', link_name: 'Chi-Chi Stores', linked_at: at(1) },
    { telegram_id: '7000000005', first_name: 'Krillin', username: '', arrived_at: at(30), status: 'ignored', handled_at: at(3) },
  ].slice(0, n === 3 ? 5 : n);
  pendingUserService._internals._liveCards.clear();
  sessionStore.clear(ADMIN);
}

function fakeBot() {
  const sent = [];
  return {
    sent,
    answerCallbackQuery: async () => true,
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return { message_id: sent.length }; },
    editMessageText: async (text, opts) => { sent.push({ chatId: opts.chat_id, text, opts }); return { message_id: opts.message_id }; },
    deleteMessage: async () => true,
    last() { return sent[sent.length - 1]; },
  };
}
const cbq = (data) => ({ id: 'q1', data, from: { id: ADMIN }, message: { chat: { id: ADMIN }, message_id: 77 } });
const btns = (m) => (m.opts.reply_markup.inline_keyboard || []).flat();

test('the queue: one chip per waiting stranger, aged, with the Handled door', async () => {
  seed();
  // A live card gives Goku a snippet; the others have none (post-restart shape).
  pendingUserService._internals._liveCards.set('7034987385', {
    deliveries: [], at: Date.now(),
    messages: [{ at: new Date().toISOString(), text: 'I want to buy fabrics' }],
  });
  const bot = fakeBot();
  await pendingUsersFlow.start(bot, ADMIN, ADMIN, 77);
  const msg = bot.last();
  assert.match(msg.text, /Pending Users\* — 3 waiting/);
  const chips = btns(msg).filter((b) => b.callback_data.startsWith('puq:u:'));
  assert.equal(chips.length, 3, 'only the still-pending get chips');
  assert.match(chips[0].text, /🆕 today · Goku Son · “I want to buy fabri…”/, 'fresh + snippet (truncated at 20)');
  assert.match(chips[2].text, /⚠️ 9d · Bulma/, 'past a week goes ⚠️');
  assert.ok(btns(msg).some((b) => /🗂 Handled \(2\)/.test(b.text)), 'handled count on the door');
  assert.ok(!/undefined|NaN/i.test(msg.text + JSON.stringify(btns(msg))));
});

test('a non-admin gets the lock, not the queue', async () => {
  seed();
  const bot = fakeBot();
  await pendingUsersFlow.start(bot, '555', '555', 77);
  assert.match(bot.last().text, /admin-only/i);
});

test('the triage card: five doors, two ➕ shortcuts, Back to the page it came from', async () => {
  seed();
  const bot = fakeBot();
  await pendingUsersFlow.handleCallback(bot, cbq('puq:u:0:7034987385'));
  const card = bot.last();
  assert.match(card.text, /Goku Son/);
  assert.match(card.text, /7034987385/);
  const data = btns(card).map((b) => b.callback_data);
  assert.ok(data.includes('pu:onboard:7034987385'), 'employee door reuses pu:');
  assert.ok(data.includes('pu:cust:7034987385'), 'customer link door');
  assert.ok(data.includes('pu:mkt:7034987385'), 'marketer link door');
  assert.ok(data.includes('pu:net:7034987385'), 'network door');
  assert.ok(data.includes('puq:nc:0:7034987385'), '➕ new customer carries page');
  assert.ok(data.includes('puq:nm:0:7034987385'), '➕ new marketer carries page');
  assert.ok(data.includes('puq:ign:0:7034987385'), 'ignore returns to the queue');
  assert.ok(data.includes('puq:q:0'), 'Back to the list');
});

test('Ignore: back on the queue, one fewer, without touching the others', async () => {
  seed();
  const bot = fakeBot();
  await pendingUsersFlow.handleCallback(bot, cbq('puq:ign:0:7000000002'));
  const msg = bot.last();
  assert.match(msg.text, /2 waiting/);
  assert.ok(!JSON.stringify(btns(msg)).includes('7000000002'), 'the ignored person is gone');
  assert.equal(ROWS.find((r) => r.telegram_id === '7000000002').status, 'ignored');
});

test('🗂 Handled: what each arrival became, newest placement first', async () => {
  seed();
  const bot = fakeBot();
  await pendingUsersFlow.handleCallback(bot, cbq('puq:h:0'));
  const msg = bot.last();
  assert.match(msg.text, /Handled\* — 2/);
  assert.match(msg.text, /ChiChi → 🤝 customer \*Chi-Chi Stores\*/);
  assert.match(msg.text, /Krillin → 🚫 ignored/);
  assert.ok(btns(msg).some((b) => b.callback_data === 'puq:q:0'), 'Back to the queue');
});

test('➕ New customer: CON-1 door entered pre-filled, account carried', async () => {
  seed();
  const bot = fakeBot();
  const calls = [];
  const deps = {
    startAddCustomerFlow: async (b, chatId, uid, messageId) => {
      calls.push('start');
      sessionStore.set(uid, { type: 'add_customer_flow', step: 'type', flowMessageId: messageId });
    },
    showAddCustomerPhoneStep: async () => calls.push('phone'),
  };
  await pendingUsersFlow.handleCallback(bot, cbq('puq:nc:0:7034987385'), deps);
  assert.deepEqual(calls, ['start', 'phone'], 'flow entered, then rendered at the phone step');
  const s = sessionStore.get(ADMIN);
  assert.equal(s.personType, 'customer', 'kind pre-answered as Customer');
  assert.equal(s.name, 'Goku Son', 'name pre-filled from the Telegram profile');
  assert.equal(s.pendingTelegramId, '7034987385', 'the account rides to link-on-approval');
  assert.equal(s.step, 'phone');
});

test('➕ New marketer: Register Marketer entered, name fed as if typed', async () => {
  seed();
  const bot = fakeBot();
  const fed = [];
  const deps = {
    startRegisterMarketer: async (b, chatId, uid) => {
      sessionStore.set(uid, { type: 'marketer_reg_flow', step: 'name', flowMessageId: null });
    },
    feedMarketerName: async (b, chatId, uid, text) => fed.push(text),
  };
  await pendingUsersFlow.handleCallback(bot, cbq('puq:nm:0:7034987385'), deps);
  assert.deepEqual(fed, ['Goku Son'], 'the profile name enters the flow like typed text');
  assert.equal(sessionStore.get(ADMIN).pendingTelegramId, '7034987385');
});

test('a big queue pages at 8 with the standard pager', async () => {
  const at = (d) => new Date(Date.now() - d * DAY).toISOString();
  ROWS = Array.from({ length: 11 }, (_, i) => ({
    telegram_id: `71000000${String(i).padStart(2, '0')}`,
    first_name: `Person${i}`, username: '', arrived_at: at(i), status: 'pending',
  }));
  pendingUserService._internals._liveCards.clear();
  const bot = fakeBot();
  await pendingUsersFlow.start(bot, ADMIN, ADMIN, 77);
  const msg = bot.last();
  const chips = btns(msg).filter((b) => b.callback_data.startsWith('puq:u:'));
  assert.equal(chips.length, 8, 'hard cap');
  assert.ok(btns(msg).some((b) => /Page 1\/2/.test(b.text)), 'pager present');
  await pendingUsersFlow.handleCallback(bot, cbq('puq:q:1'));
  const p2 = btns(bot.last()).filter((b) => b.callback_data.startsWith('puq:u:'));
  assert.equal(p2.length, 3, 'remainder on page 2');
});
