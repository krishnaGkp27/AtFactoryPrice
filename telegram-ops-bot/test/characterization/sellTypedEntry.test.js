'use strict';

/**
 * SELL-T1 — "Sell package 507,503,684,512" typed by the office manager:
 * numbers preload the tappable Sell Bale flow (validated, per-number
 * reasons, warehouse tap on ambiguity); names/banks/dates stay taps.
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
// The intent parser recognises the typed command and extracts the numbers.
installFakeIntent(() => ({
  action: 'sell_batch',
  packageNos: ['507', '503', '684', '999', '512', '507'],
  confidence: 0.95,
}));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

inventoryRepository.getAll = async () => [
  { packageNo: '507', design: '77016', shade: '5', warehouse: 'IDUMOTA', status: 'available', yards: 30 },
  { packageNo: '507', design: '77016', shade: '5', warehouse: 'IDUMOTA', status: 'available', yards: 30 },
  { packageNo: '503', design: '9032', shade: '1', warehouse: 'IDUMOTA', status: 'available', yards: 55 },
  { packageNo: '684', design: '9032', shade: '2', warehouse: 'IDUMOTA', status: 'sold', yards: 55, soldTo: 'CJE' },
  { packageNo: '512', design: '44200', shade: '1', warehouse: 'IDUMOTA', status: 'available', yards: 50 },
  { packageNo: '512', design: '44200', shade: '1', warehouse: 'Kano office', status: 'available', yards: 48 },
];
customersRepository.getAll = async () => [
  { customer_id: 'C1', name: 'MAMA KAFAYA', status: 'Active' },
  { customer_id: 'C2', name: 'OKESON', status: 'Active' },
];
auditLogRepository.append = async () => {};


test('typed numbers preload the flow: dedupe, reasons, warehouse tap, then customer chips', async () => {
  const bot = createFakeBot();
  await controller.handleMessage(bot, {
    from: { id: '4242' }, chat: { id: '4242' },
    text: 'Sell package 507,503,684,999,512,507 to mama kafaya, ZENITH BANK, 11 July 2026',
  });
  // 512 is in two warehouses → the ambiguity tap comes first.
  let text = bot.allText().replace(/\\/g, '');
  assert.match(text, /Bale \*512\* exists in 2 places/);
  const kano = lastKb(bot).find((b) => b.text.includes('Kano office'));
  assert.ok(kano, 'warehouse options shown');
  await controller.handleCallbackQuery(bot, cb(kano.callback_data));

  // Preload summary: 507 counted once (typed twice), 684/999 skipped with reasons.
  text = bot.allText().replace(/\\/g, '');
  assert.match(text, /3 bale\(s\) loaded from your message/);
  assert.match(text, /Bale 507: 77016, 2 thans/);
  assert.match(text, /684 — already sold to CJE \(skipped\)/);
  assert.match(text, /999 — not found in the sheet \(skipped\)/);
  const session = sessionStore.get('4242');
  assert.equal(session.cart.length, 3);
  assert.deepEqual(session.cart.map((c) => c.packageNo).sort(), ['503', '507', '512']);

  // Continue → the flow's normal tappable customer step (typed name ignored).
  const cont = lastKb(bot).find((b) => b.callback_data === 'sb:rev');
  assert.ok(cont, 'Pick customer button present');
  await controller.handleCallbackQuery(bot, cb(cont.callback_data));
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => /MAMA KAFAYA/.test(b.text)), 'customer chips shown — no typed-name trust');
  sessionStore.clear('4242');
});

test('a command with no valid numbers falls back to the guidance card, nothing loaded', async () => {
  const bot = createFakeBot();
  installFakeIntent(() => ({ action: 'sell_batch', packageNos: ['111', '222'], confidence: 0.9 }));
  await controller.handleMessage(bot, { from: { id: '4242' }, chat: { id: '4242' }, text: 'Sell package 111,222 to someone' });
  const text = bot.allText().replace(/\\/g, '');
  assert.match(text, /None of the typed bale numbers matched available stock/);
  assert.match(text, /111 — not found in the sheet/);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'act:sell_bale'), 'tap-flow fallback offered');
  assert.ok(!sessionStore.get('4242'), 'no half-loaded session left behind');
});
