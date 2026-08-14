'use strict';

/**
 * IDR-2 (owner, 14-Aug-2026) — "how am I going to register him as an
 * existing customer, or an existing member in the network, or a new
 * network member."
 *
 * Until now the pending-user card had exactly one door and it led to Add
 * EMPLOYEE. An arriving customer could only be Ignored and re-entered by
 * hand, and their Telegram identity was thrown away in the process —
 * nothing downstream could ever reach that person's chat again.
 *
 * The card is now a triage, and whichever destination is chosen the
 * account is bound in the identity register (IDR-1).
 *
 * Pinned end-to-end through the REAL controller:
 *  - a stranger whose first message is a real request is captured, gets
 *    the polite reply, and their words reach the admin card;
 *  - the card offers all four destinations;
 *  - "Link to existing customer" lists SOLID customer records only, with
 *    likely name matches first, and never a free-text box;
 *  - choosing one writes the link and confirms it in place;
 *  - an expired picker refuses rather than linking the wrong person.
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
const pendingUsersRepo = require(path.join(SRC, 'repositories/pendingUsersRepository'));
const pendingUserService = require(path.join(SRC, 'services/pendingUserService'));
const crmService = require(path.join(SRC, 'services/crmService'));
const identityService = require(path.join(SRC, 'services/identityService'));
const adminFeed = require(path.join(SRC, 'services/adminFeed'));

const ADMIN = '777';
const STRANGER = '8968542393';

const PU = {
  telegram_id: STRANGER, username: '', first_name: 'Mr', last_name: 'femi',
  arrived_at: '2026-08-13T12:00:00.000Z', status: 'pending', rowIndex: 2,
  link_type: '', link_id: '', link_name: '',
};

const CUSTOMERS = [
  { customer_id: 'CUST-20260813-DF49AA89', name: 'Mr femi', status: 'active' },
  { customer_id: 'CUST-20260730-001', name: 'Collins benduco', status: 'active' },
  { customer_id: 'CUST-OLD', name: 'Retired Trader', status: 'inactive' },
];

pendingUsersRepo.findByTelegramId = async (id) => (String(id) === STRANGER ? { ...PU } : null);
pendingUsersRepo.append = async () => {};
pendingUsersRepo.updateStatus = async () => true;
crmService.listCustomers = async () => CUSTOMERS.map((c) => ({ ...c }));

/** Admin-feed cards go to the fake bot so the test can read them. */
adminFeed.notify = async (bot, kind, text, opts) => {
  await bot.sendMessage(ADMIN, text, opts);
  return { sent: 1 };
};

function strangerMsg(text) {
  return { chat: { id: STRANGER }, from: { id: STRANGER, first_name: 'Mr', last_name: 'femi' }, text };
}
function adminCard(bot) {
  const c = bot.callsTo('sendMessage').filter((x) => String(x.args.chatId) === ADMIN);
  return c.length ? c[c.length - 1] : null;
}

test('IDR-2: a stranger opening with a real request is captured and quoted', async () => {
  pendingUserService._internals._resetRateLimitForTests();
  const bot = createFakeBot();
  await controller.handleMessage(bot, strangerMsg('I want 5 bales of 9037, black'));

  const polite = bot.callsTo('sendMessage').find((c) => String(c.args.chatId) === STRANGER);
  assert.match(polite.args.text, /not yet registered/i, 'they are answered, never ignored');

  const card = adminCard(bot);
  assert.match(card.args.text, /🆕 \*Unknown user messaged the bot\*/);
  assert.match(card.args.text, /I want 5 bales of 9037, black/,
    'their words are the whole triage signal — customer, marketer, or noise');
});

test('IDR-2: a bare greeting is captured too, without a pointless quote line', async () => {
  pendingUserService._internals._resetRateLimitForTests();
  const bot = createFakeBot();
  await controller.handleMessage(bot, strangerMsg('hi'));
  const card = adminCard(bot);
  assert.ok(!card.args.text.includes('💬'),
    '"hi" carries nothing the card does not already show — quoting it would be noise');
});

test('IDR-2: the card offers all four destinations', async () => {
  pendingUserService._internals._resetRateLimitForTests();
  const bot = createFakeBot();
  await controller.handleMessage(bot, strangerMsg('/start'));
  const kb = adminCard(bot).args.opts.reply_markup.inline_keyboard.flat();
  assert.deepEqual(kb.map((b) => b.callback_data), [
    `pu:onboard:${STRANGER}`, `pu:cust:${STRANGER}`, `pu:net:${STRANGER}`, `pu:ignore:${STRANGER}`,
  ]);
  assert.match(kb[1].text, /customer/i);
  assert.match(kb[2].text, /network/i);
});

test('IDR-2: "link to customer" lists solid records, likeliest first, no free text', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`pu:cust:${STRANGER}`, ADMIN));

  const sent = bot.callsTo('sendMessage').pop();
  const kb = sent.args.opts.reply_markup.inline_keyboard.flat();
  const labels = kb.filter((b) => b.callback_data.startsWith('pu:link:')).map((b) => b.text);
  assert.match(labels[0], /Mr femi/, 'the name match sorts to the top');
  assert.equal(labels.length, 2, 'both ACTIVE customers offered — the inactive one is not');
  assert.ok(!labels.some((l) => /Retired Trader/.test(l)));
  assert.ok(kb.some((b) => b.callback_data === 'pu:linkcancel'), 'and a way out');
  assert.match(sent.args.text, /Which customer is this\?/);
});

test('IDR-2: choosing a customer binds the account and says so in place', async () => {
  const bot = createFakeBot();
  const linked = [];
  const realLink = identityService.link;
  identityService.link = async (tg, spec, by) => { linked.push({ tg, spec, by }); return { ok: true }; };

  await controller.handleCallbackQuery(bot, cb(`pu:cust:${STRANGER}`, ADMIN));
  await controller.handleCallbackQuery(bot, cb('pu:link:0', ADMIN));

  assert.equal(linked.length, 1);
  assert.equal(linked[0].tg, STRANGER);
  assert.deepEqual(linked[0].spec, {
    type: 'customer', id: 'CUST-20260813-DF49AA89', name: 'Mr femi',
  });
  assert.equal(linked[0].by, ADMIN, 'who decided is recorded');

  const edit = bot.callsTo('editMessageText').pop();
  assert.match(edit.args.text, /is customer \*Mr femi\*/);
  assert.match(edit.args.text, /now on record for them/);
  identityService.link = realLink;
  sessionStore.clear(ADMIN);
});

test('IDR-2: an expired picker refuses rather than linking the wrong person', async () => {
  sessionStore.clear(ADMIN);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('pu:link:0', ADMIN));
  const ack = bot.callsTo('answerCallbackQuery').pop();
  assert.match(ack.args.opts.text, /expired/i);
  assert.equal(bot.callsTo('editMessageText').length, 0, 'nothing was linked');
});

test('IDR-2: the network door offers contacts, and cancel leaves no session behind', async () => {
  const contactsRepo = require(path.join(SRC, 'repositories/contactsRepository'));
  contactsRepo.getAll = async () => [
    { contact_id: 'CON-1', name: 'Solomon', status: 'active' },
    { contact_id: 'CON-2', name: 'Obinna', status: 'active' },
    { contact_id: 'CON-3', name: 'Gone', status: 'inactive' },
  ];
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`pu:net:${STRANGER}`, ADMIN));
  const kb = bot.callsTo('sendMessage').pop().args.opts.reply_markup.inline_keyboard.flat();
  assert.equal(kb.filter((b) => b.callback_data.startsWith('pu:link:')).length, 2,
    'active contacts only');

  await controller.handleCallbackQuery(bot, cb('pu:linkcancel', ADMIN));
  assert.equal(sessionStore.get(ADMIN), null, 'cancel clears the picker session');
});
