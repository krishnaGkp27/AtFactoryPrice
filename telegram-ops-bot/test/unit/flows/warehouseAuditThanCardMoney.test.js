'use strict';

/**
 * CUR-1 side B — the warehouse-audit than card's `Price:` line.
 *
 * The bale's selling rate is an Inventory figure (BUSINESS_RULES §17): it
 * prints bare through money.saleRate — `Price: 1,450/yd` — never `₦`, never
 * a currency code, whatever CURRENCY is set to. No rate → no Price line.
 */

process.env.ADMIN_IDS = '777';
process.env.WAREHOUSE_AUDIT_ENABLED = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');
const sessionStore = require('../../../src/utils/sessionStore');
const inventoryService = require('../../../src/services/inventoryService');
const flow = require('../../../src/flows/warehouseAuditFlow');

const { renderThanCard, SESSION_TYPE } = flow._internals;

function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}

function summaryWith(pricePerYard) {
  return {
    packageNo: '6534', design: '9032', shade: '2', indent: 'IND-1', warehouse: 'Kano office',
    pricePerYard,
    thans: [
      { thanNo: 1, yards: 30, status: 'available' },
      { thanNo: 2, yards: 45, status: 'available' },
      { thanNo: 3, yards: 30, status: 'sold' },
    ],
    availableThans: 2, availableYards: 75,
  };
}

async function openCard(pricePerYard) {
  const userId = '777';
  sessionStore.clear(userId);
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'than_card', packageNo: '6534', warehouse: 'Kano office',
    marks: {}, flowMessageId: null, startedAt: Date.now(),
  });
  const orig = inventoryService.getPackageSummary;
  inventoryService.getPackageSummary = async () => summaryWith(pricePerYard);
  try {
    const bot = createFakeBot();
    await renderThanCard(bot, userId, userId);
    return lastText(bot);
  } finally {
    inventoryService.getPackageSummary = orig;
    sessionStore.clear(userId);
  }
}

test('CUR-1: than card prints the bale rate bare — `Price: 1,450/yd`, no ₦, no code', async () => {
  const text = await openCard(1450);
  assert.match(text, /^Price: 1,450\/yd$/m, `bare grouped rate, got: ${text}`);
  assert.ok(!/₦|NGN|Naira/i.test(text), 'no symbol or currency code on an Inventory figure');
  assert.match(text, /Available: 2 thans · 75 yds/, 'quantities untouched');
});

test('CUR-1: the rate is not re-labelled by the env — CURRENCY never reaches side B', async () => {
  const config = require('../../../src/config');
  const prev = config.currency;
  config.currency = 'USD';
  try {
    const text = await openCard(1450);
    assert.match(text, /^Price: 1,450\/yd$/m);
    assert.ok(!/USD/.test(text), 'the accounting code is not a display unit on side B');
  } finally { config.currency = prev; }
});

test('no rate on the bale → no Price line at all (no zero, no unit)', async () => {
  const text = await openCard(0);
  assert.ok(!/Price:/.test(text), `no Price line without a rate, got: ${text}`);
  assert.ok(!/₦/.test(text));
});
