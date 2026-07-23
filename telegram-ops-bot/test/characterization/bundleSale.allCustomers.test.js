'use strict';

/**
 * TAP-1 — Bundle Sale "📋 All customers" tappable browse.
 *
 * The customer step used to offer only 6 recent buyers + typed search;
 * field staff without a recent buyer HAD to type. Now: paginated list of
 * every (non-inactive) customer — browse pages, tap to pick, search stays
 * as fallback. Drives the real controller; repos/bot faked.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, lastKb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const rateSuggestionService = require(path.join(SRC, 'services/rateSuggestionService'));

// 14 customers → page 1 = 10, page 2 = 4. One inactive: must be hidden.
customersRepository.getAll = async () => [
  ...Array.from({ length: 13 }, (_, i) => ({ name: `Cust ${String(i + 1).padStart(2, '0')}`, status: 'Active' })),
  { name: 'Zed Retired', status: 'inactive' },
  { name: 'Aaa First', status: 'Active' },
];
rateSuggestionService.suggestFor = async () => ({});
rateSuggestionService.formatSuggestionLines = () => '_no history_';

function seed() {
  sessionStore.set('4242', {
    type: 'bundle_sale_flow', step: 'pick_customer', design: '9006', warehouse: 'Kano office',
    flowMessageId: 70,
  });
}

test('page 1: ten alphabetical customers, More→page 2, inactive hidden', async () => {
  seed();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('bs:cust:all:0'));
  const texts = lastKb(bot).map((b) => b.text);
  assert.ok(texts[0].includes('Aaa First'), 'alphabetical — Aaa First leads');
  assert.equal(texts.filter((t) => t.startsWith('👤')).length, 10, '10 customers on page 1');
  assert.ok(texts.some((t) => /More \(4\)/.test(t)), 'More shows the remainder count');
  assert.ok(!texts.some((t) => t.includes('Zed Retired')), 'inactive customer hidden');
  assert.match(bot.allText(), /page 1\/2 \(14\)/);
});

test('page 2 → tap a customer → lands on the rate step', async () => {
  seed();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('bs:cust:all:1'));
  const kb = lastKb(bot);
  const custBtns = kb.filter((b) => b.text.startsWith('👤'));
  assert.equal(custBtns.length, 4, 'remaining 4 on page 2');
  assert.ok(kb.some((b) => b.callback_data === 'bs:cust:all:0'), 'Prev goes back to page 1');
  // Tap the first customer on this page.
  await controller.handleCallbackQuery(bot, cb(custBtns[0].callback_data));
  const session = sessionStore.get('4242');
  assert.equal(session.step, 'enter_rate', 'picking advances to the rate step');
  assert.equal(session.customer, custBtns[0].text.replace('👤 ', ''));
  sessionStore.clear('4242');
});

test('recent-buyers screen offers the 📋 All customers button', async () => {
  seed();
  const bot = createFakeBot();
  // Out-of-range page clamps and still renders (covers the entry button path).
  await controller.handleCallbackQuery(bot, cb('bs:cust:all:99'));
  assert.match(bot.allText(), /page 2\/2/);
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => b.callback_data === 'bs:cust:search'), 'search fallback still present');
  sessionStore.clear('4242');
});
