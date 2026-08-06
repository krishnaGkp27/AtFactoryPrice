'use strict';

/**
 * RET-2 (owner, 07-Aug-2026) — `/revert_packages` is a CORRECTION.
 *
 * Two defects this pins, both found reading the return path after SLG-1:
 *
 *   1. The command wrote `kind:'return'` movement rows with no approval
 *      behind them, so an admin fixing a mis-typed sale showed up on the
 *      customer's Supply Ledger as goods THEY returned. The ledger's credit
 *      side is approved returns only (owner: "credits can come from the
 *      movement log but only when it was approved").
 *
 *   2. `markPackageAvailable` stamped every flipped bale with the FIRST
 *      row's buyer, while an unscoped revert matches the printed number in
 *      every store (BUSINESS_RULES §5 — numbers recycle). One customer's
 *      return was filed under another customer's name.
 *
 * Drives the real controller; only sheetsClient / intentParser / bot faked.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '888';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const movementsRepository = require(path.join(SRC, 'repositories/baleMovementsRepository'));

const ADMIN_ID = 777;
const EMPLOYEE_ID = 888;

/** Inventory columns A..W. */
function invRow(pkg, thanNo, wh, soldTo, batch) {
  return [pkg, '', '', '9060-A', '01', String(thanNo), '30', 'sold', wh, '100',
    '2026-01-01', soldTo, '2026-07-01', '', '', '', 'fabric',
    `BAL-${pkg}-${batch}-${thanNo}`, '2026-01-01', '', '', batch, ''];
}

function seed() {
  return createFakeSheets({
    Inventory: [
      inventoryRepository.HEADERS,
      // ONE printed number, two physical bales, two stores, two buyers.
      invRow('870', 1, 'Kano office', 'ALPHA', 'Mar26'),
      invRow('870', 2, 'Kano office', 'ALPHA', 'Mar26'),
      invRow('870', 1, 'IDUMOTA', 'BETA', 'Jul26'),
    ],
    BaleMovements: [movementsRepository.HEADERS],
    AuditLog: [['timestamp', 'type', 'data', 'user_id']],
    Users: [['user_id', 'name', 'role', 'status']],
  });
}

installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

async function run(fromId, text) {
  const fake = seed();
  const restore = installFakeSheets(fake);
  inventoryRepository.invalidateCache();
  const bot = createFakeBot();
  try {
    await controller.handleMessage(bot, {
      chat: { id: fromId }, from: { id: fromId, first_name: 'Test' }, text,
    });
  } finally {
    restore();
    inventoryRepository.invalidateCache();
  }
  const rows = (fake._store.get('BaleMovements') || []).slice(1);
  return {
    bot,
    moves: rows.map((r, i) => movementsRepository._internals.parseRow(r, i + 2)),
    inventory: (fake._store.get('Inventory') || []).slice(1),
    audit: (fake._store.get('AuditLog') || []).filter((r) => r[1] === 'revert_packages'),
  };
}

test('a revert is logged as a CORRECTION, never as a customer return', async () => {
  const { moves } = await run(ADMIN_ID, '/revert_packages 870');
  assert.equal(moves.length, 2, 'one row per physical bale');
  assert.deepEqual(moves.map((m) => m.kind), ['correction', 'correction'],
    'kind:return is what the Supply Ledger credits — a correction must not claim it');
});

test('each flipped bale carries ITS OWN buyer in Ref', async () => {
  const { moves } = await run(ADMIN_ID, '/revert_packages 870');
  const byStore = Object.fromEntries(moves.map((m) => [m.container, m.ref]));
  assert.equal(byStore.Mar26, 'ALPHA');
  assert.equal(byStore.Jul26, 'BETA', "BETA's bale was filed under ALPHA before RET-2");
});

test('the reply names the store and the buyer each bale was taken from', async () => {
  const { bot } = await run(ADMIN_ID, '/revert_packages 870');
  const txt = bot.allText();
  assert.match(txt, /correction, not a customer return/i);
  assert.match(txt, /3 thans restored/);
  assert.match(txt, /ALPHA/);
  assert.match(txt, /BETA/, 'an over-broad revert is visible, not silent');
});

test('an @store scope pins the revert to one warehouse', async () => {
  const { moves, bot, inventory } = await run(ADMIN_ID, '/revert_packages 870 @Kano office');
  assert.equal(moves.length, 1, 'only the Kano bale moved');
  assert.equal(moves[0].ref, 'ALPHA');
  assert.match(bot.allText(), /2 thans restored/);
  const idumota = inventory.find((r) => r[8] === 'IDUMOTA');
  assert.equal(idumota[7], 'sold', "BETA's bale is untouched");
  assert.equal(idumota[11], 'BETA', 'and keeps its buyer');
});

test('the correction leaves an AuditLog trail', async () => {
  const { audit } = await run(ADMIN_ID, '/revert_packages 870');
  assert.equal(audit.length, 1);
  const data = JSON.parse(audit[0][2]);
  assert.deepEqual(data.packages, ['870']);
  assert.equal(data.as, 'correction');
  assert.equal(data.thans, 3);
});

test('non-admins are still refused', async () => {
  const { bot, moves } = await run(EMPLOYEE_ID, '/revert_packages 870');
  assert.match(bot.allText(), /Only admin can revert Bales/);
  assert.equal(moves.length, 0);
});
