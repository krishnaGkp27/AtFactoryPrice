'use strict';

/**
 * Characterization (golden) suite for the ledger slash-commands routed by
 * telegramController.handleMessage (/ledger, /balance, /payment).
 *
 * Pins two business-critical, deterministic behaviors:
 *   - admin-only gating on every money command, and
 *   - /payment input validation (missing / non-positive amount),
 * both of which short-circuit BEFORE any ledger service runs — so they are
 * stable anchors for the TG-8 split.
 *
 * Drives the real controller; only sheetsClient / intentParser / bot are faked.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '888';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController } = require('../helpers/controllerHarness');

const ADMIN_ID = 777;
const EMPLOYEE_ID = 888;

installFakeSheets(createFakeSheets({
  Users: [['user_id', 'name', 'role', 'status']],
  AuditLog: [['timestamp', 'type', 'data', 'user_id']],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();

function message(fromId, text) {
  return { chat: { id: fromId }, from: { id: fromId, first_name: 'Test' }, text };
}

async function run(fromId, text) {
  const bot = createFakeBot();
  await controller.handleMessage(bot, message(fromId, text));
  return bot;
}

test('admin-only gating on ledger money commands', async (t) => {
  const ADMINS_ONLY = 'This command is for admins only.';

  for (const cmd of ['/balance CUST-1', '/ledger CUST-1', '/payment CUST-1 5000']) {
    await t.test(`employee is refused: ${cmd}`, async () => {
      const bot = await run(EMPLOYEE_ID, cmd);
      assert.ok(bot.allText().includes(ADMINS_ONLY), `expected admins-only refusal for ${cmd}`);
    });
  }
});

test('/payment input validation (admin)', async (t) => {
  await t.test('missing amount → usage message', async () => {
    const bot = await run(ADMIN_ID, '/payment CUST-1');
    assert.ok(bot.allText().includes('Usage: /payment'));
  });

  await t.test('non-numeric amount → positive-amount error', async () => {
    const bot = await run(ADMIN_ID, '/payment CUST-1 abc');
    assert.ok(bot.allText().includes('valid positive amount'));
  });

  await t.test('non-positive amount → positive-amount error', async () => {
    const bot = await run(ADMIN_ID, '/payment CUST-1 -5');
    assert.ok(bot.allText().includes('valid positive amount'));
  });
});
