'use strict';

/**
 * FIN-V1 — a customer's outstanding balance is money data (owner,
 * 06-Aug-2026): admins + Finance only. Before this, typed "what is X's
 * balance" was the ONE ungated money read in the bot — any registered user
 * could ask any customer's outstanding and credit limit.
 */

process.env.ADMIN_IDS = '777';
process.env.FINANCE_IDS = '888';
process.env.EMPLOYEE_IDS = '4242,888'; // 888 = Finance: registered user, not admin

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
let nextIntent = { action: 'unknown', confidence: 0 };
installFakeIntent(() => nextIntent);

const controller = loadController();
const crmService = require(path.join(SRC, 'services/crmService'));

crmService.getCustomer = async () => ({
  name: 'Alhaji Musa', outstanding_balance: 140000, credit_limit: 500000,
});

async function ask(userId) {
  nextIntent = { action: 'check_balance', customer: 'Alhaji Musa', confidence: 0.95 };
  const bot = createFakeBot();
  await controller.handleMessage(bot, {
    chat: { id: userId }, from: { id: userId, first_name: 'U' },
    text: "what is Alhaji Musa's balance",
  });
  return bot.allText();
}

test('a regular employee is refused — no balance, no limit', async () => {
  const text = await ask('4242');
  assert.match(text, /admins and Finance only/);
  assert.ok(!text.includes('140'), 'the outstanding figure must not leak');
  assert.ok(!text.includes('500'), 'the credit limit must not leak');
});

test('an admin still gets the balance', async () => {
  const text = await ask('777');
  assert.match(text, /Alhaji Musa: Outstanding balance/);
});

test('a Finance user (non-admin) gets the balance', async () => {
  const text = await ask('888');
  assert.match(text, /Alhaji Musa: Outstanding balance/);
});
