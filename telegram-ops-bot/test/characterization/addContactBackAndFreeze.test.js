'use strict';

/**
 * CON-1 ➕ Add Contact — two faults found while the staff test script was
 * checked against the code, pinned here through the real controller.
 *
 *  1. ⬅️ Back on the NOTES step. Only a customer reaches the notes from the
 *     payment-terms step; a Worker / Agent / Supplier / Other walks straight
 *     from the address to the notes (showAddPersonAfterAddress). The notes
 *     card's Back was `acb:terms` for everyone, so a Worker tapping Back was
 *     shown `Pick payment terms:` — a step that kind never has. Back now
 *     returns to the step the kind really came from; the customer path is
 *     unchanged.
 *
 *  2. The Settings freeze. `CUSTOMER_CREATION_ENABLED` defaults to on; a
 *     Settings row of that key with an EMPTY value cell was read as 0 and
 *     froze the door. The fake Settings sheet below carries exactly that
 *     row, read by the real settingsRepository: the door must open.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

const fake = createFakeSheets({
  Settings: [
    ['Key', 'Value', 'UpdatedAt'],
    ['CUSTOMER_CREATION_ENABLED', '', ''],
  ],
});
installFakeSheets(fake);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));

const STAFF = '888';

const cb = (data, uid = STAFF) => ({
  data, id: `q-${data}`, from: { id: uid },
  message: { message_id: 9, chat: { id: uid } },
});
const msg = (text, uid = STAFF) => ({ from: { id: uid }, chat: { id: uid }, text });

function lastScreen(bot) {
  return bot.calls.filter((x) => x.method === 'editMessageText' || x.method === 'sendMessage').pop();
}
function screenText(bot) {
  const c = lastScreen(bot);
  return c ? String(c.args.text || '') : '';
}
/** The flow's own buttons on the most recent screen (the NAV-1 footer aside). */
function screenKb(bot) {
  const c = lastScreen(bot);
  const kb = c && c.args.opts && c.args.opts.reply_markup;
  return kb ? kb.inline_keyboard.flat().filter((b) => !String(b.callback_data).startsWith('act:')) : [];
}
const backOf = (bot) => screenKb(bot).find((b) => /Back/.test(b.text));

/** Tile → kind → name → phone → address. A customer lands on the category, anyone else on the notes. */
async function walkToAddress(bot, typeKey) {
  await controller.handleCallbackQuery(bot, cb('act:add_customer'));
  await controller.handleCallbackQuery(bot, cb(`actype:${typeKey}`));
  await controller.handleMessage(bot, msg('Mr femi'));
  await controller.handleMessage(bot, msg('+2348012345678'));
  await controller.handleMessage(bot, msg('Kano'));
}

test.beforeEach(() => { sessionStore.clear(STAFF); settingsRepository.invalidateCache(); });

test('an EMPTY CUSTOMER_CREATION_ENABLED cell does not freeze the door (the default is on)', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:add_customer'));
  assert.doesNotMatch(screenText(bot), /frozen/i, 'an empty value cell is not a 0');
  assert.match(screenText(bot), /Who are you adding\?/);
});

test('an explicit 0 in that cell still freezes the door', async () => {
  const settings = fake._store.get('Settings');
  settings[1][1] = '0';
  settingsRepository.invalidateCache();
  try {
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('act:add_customer'));
    assert.match(screenText(bot), /Customer creation is temporarily frozen/);
  } finally {
    settings[1][1] = '';
    settingsRepository.invalidateCache();
  }
});

test('a Worker: Back on the notes step returns to the ADDRESS, never to payment terms', async () => {
  const bot = createFakeBot();
  await walkToAddress(bot, 'worker');
  assert.match(screenText(bot), /Add any \*notes\* \(or tap Skip\):/, 'a worker goes from the address straight to the notes');
  assert.equal(backOf(bot).callback_data, 'acb:address', 'Back names the step this kind came from');

  await controller.handleCallbackQuery(bot, cb(backOf(bot).callback_data));
  const text = screenText(bot);
  assert.doesNotMatch(text, /payment terms/i, 'a worker has no payment terms');
  assert.match(text, /Enter \*address\* \(or tap Skip\):/);
  assert.doesNotMatch(text, /✓ Address:/, 'the address is asked again, so the old answer is dropped');
  assert.match(text, /✓ Type: \*👷 Worker\*/, 'the kind and the earlier answers stay');
  assert.match(text, /✓ Phone: \*\+2348012345678\*/);
  assert.equal(sessionStore.get(STAFF).step, 'address');

  // Re-answer the address: forward again to the notes, still no customer step.
  await controller.handleMessage(bot, msg('Sabon Gari'));
  assert.match(screenText(bot), /Add any \*notes\* \(or tap Skip\):/);
  assert.match(screenText(bot), /✓ Address: \*Sabon Gari\*/);
  assert.equal(backOf(bot).callback_data, 'acb:address');
});

test('every other non-customer kind takes the same way back', async () => {
  for (const kind of ['agent', 'supplier', 'other']) {
    sessionStore.clear(STAFF);
    const bot = createFakeBot();
    await walkToAddress(bot, kind);
    assert.equal(backOf(bot).callback_data, 'acb:address', kind);
    await controller.handleCallbackQuery(bot, cb('acb:address'));
    assert.match(screenText(bot), /Enter \*address\*/, kind);
    assert.doesNotMatch(screenText(bot), /payment terms/i, kind);
  }
});

test('a Worker who comes back to the notes from the confirm card still has the address behind them', async () => {
  const bot = createFakeBot();
  await walkToAddress(bot, 'worker');
  await controller.handleCallbackQuery(bot, cb('acskip:notes'));
  assert.match(screenText(bot), /Confirm and submit for admin approval\?/);
  await controller.handleCallbackQuery(bot, cb('acb:notes'));
  assert.match(screenText(bot), /Add any \*notes\*/);
  assert.equal(backOf(bot).callback_data, 'acb:address');
});

test('a Customer is unchanged: Back on the notes step returns to payment terms', async () => {
  const bot = createFakeBot();
  await walkToAddress(bot, 'customer');
  assert.match(screenText(bot), /Pick \*category\*:/);
  await controller.handleCallbackQuery(bot, cb('accat:Wholesale'));
  await controller.handleCallbackQuery(bot, cb('accred:500000'));
  await controller.handleCallbackQuery(bot, cb('acpt:COD'));
  assert.match(screenText(bot), /Add any \*notes\* \(or tap Skip\):/);
  assert.match(screenText(bot), /✓ Payment terms: \*COD\*/);
  assert.equal(backOf(bot).callback_data, 'acb:terms');

  await controller.handleCallbackQuery(bot, cb('acb:terms'));
  const text = screenText(bot);
  assert.match(text, /Pick \*payment terms\*:/);
  assert.doesNotMatch(text, /✓ Payment terms:/, 'the answer being re-asked is dropped');
  assert.match(text, /✓ Category: \*Wholesale\*/, 'the earlier customer answers stay');
  assert.match(text, /✓ Address: \*Kano\*/);
  assert.deepEqual(screenKb(bot).map((b) => b.callback_data), [
    'acpt:COD', 'acpt:Net 7', 'acpt:Net 14', 'acpt:Net 30', 'acpt:Credit', 'acpt:__custom__',
    'acb:credit', 'accanc:0',
  ]);
});
