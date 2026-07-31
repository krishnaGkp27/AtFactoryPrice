'use strict';

/**
 * WH-VIS1 — no stock may be unreachable from the Sell Bale pickers:
 *
 *  - case-variant batch labels ('Jul26' / 'JUL26') are ONE container chip,
 *    and picking it shows the warehouses of BOTH spellings (the Abdul
 *    case: Kano stock filed under a differently-cased batch label);
 *  - more containers than one screen holds get a More page instead of
 *    silently vanishing (old behavior: hard cut at 12);
 *  - case-variant warehouse spellings dedupe to one chip.
 */

process.env.ADMIN_IDS = '777';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, kbTexts } = require('../helpers/charFixture');

const INV_HEADERS = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];

let pkgSeq = 0;
function invRow(batch, warehouse) {
  pkgSeq += 1;
  return [`P${pkgSeq}`, '', '', '9006', '1', '1', '60', 'available', warehouse, '0', '2026-07-01',
    '', '', '', '', '', 'fabric', `UID-${pkgSeq}`, '2026-07-01', '', '', batch, ''];
}

// 13 single-bale batches (forces paging past MAX_CHIPS=12) + the Abdul
// case: Jul26 stock in IDUMOTA, JUL26 (same container, different case)
// in Kano office — plus a warehouse case-variant row.
const rows = [INV_HEADERS];
for (let i = 1; i <= 13; i++) rows.push(invRow(`B${String(i).padStart(2, '0')}`, 'Lagos'));
rows.push(invRow('Jul26', 'IDUMOTA'));
rows.push(invRow('Jul26', 'IDUMOTA'));
rows.push(invRow('Jul26', 'IDUMOTA'));
rows.push(invRow('JUL26', 'Kano office'));
rows.push(invRow('JUL26', 'Kano Office'));

installFakeSheets(createFakeSheets({ Inventory: rows }));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const flow = require(path.join(SRC, 'flows/sellBaleFlow'));

const ADMIN = '777';

test('case-variant batch labels merge into ONE container chip', async () => {
  const bot = createFakeBot();
  sessionStore.clear(ADMIN);
  await flow.start(bot, ADMIN, ADMIN);
  // Jul26 (5 rows) sorts first — one chip, not two.
  const allChips = kbTexts(bot).filter((t) => t.includes('sb:ct:'));
  const julChips = allChips.filter((t) => t.toUpperCase().includes('JUL26'));
  assert.equal(julChips.length, 1, `one merged Jul26 chip, got: ${julChips}`);
});

test('container overflow pages instead of silently truncating', async () => {
  const bot = createFakeBot();
  sessionStore.clear(ADMIN);
  await flow.start(bot, ADMIN, ADMIN);
  const kb1 = kbTexts(bot);
  assert.ok(kb1.some((t) => t.includes('sb:ctpg:1')), 'a More-containers chip exists');
  await flow.handleCallback(bot, cb('sb:ctpg:1', ADMIN));
  const kb2 = kbTexts(bot);
  const page2Chips = kb2.filter((t) => t.includes('sb:ct:'));
  assert.ok(page2Chips.length >= 1, 'page 2 shows the overflow containers');
  assert.ok(kb2.some((t) => t.includes('sb:ctpg:0')), 'Prev goes back');
});

test('picking the merged container shows warehouses from BOTH spellings (the Abdul case)', async () => {
  const bot = createFakeBot();
  sessionStore.clear(ADMIN);
  await flow.start(bot, ADMIN, ADMIN);
  const julChip = kbTexts(bot).find((t) => t.toUpperCase().includes('JUL26') && t.includes('sb:ct:'));
  const idx = julChip.split('sb:ct:')[1];
  await flow.handleCallback(bot, cb(`sb:ct:${idx}`, ADMIN));
  const whChips = kbTexts(bot).filter((t) => t.includes('sb:wh:'));
  assert.ok(whChips.some((t) => t.includes('IDUMOTA')), `IDUMOTA visible, got: ${whChips}`);
  assert.ok(whChips.some((t) => /Kano office/i.test(t)), `Kano office visible, got: ${whChips}`);
  // Case-variant warehouse spellings are ONE chip.
  const kanoChips = whChips.filter((t) => /kano office/i.test(t));
  assert.equal(kanoChips.length, 1, `one Kano chip, got: ${kanoChips}`);
  sessionStore.clear(ADMIN);
});