'use strict';

/**
 * SHR-1 — tracked share links, end to end through the real controller:
 *
 *   Browse Catalog design card carries 📤 Share (shr:d:<design>) →
 *   customer picker chips → pick/skip → link card whose token verifies
 *   back to the design + customer, with a wa.me send button.
 */

process.env.ADMIN_IDS = '777,888';
process.env.BASE_URL = 'https://bot.test';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, kbTexts } = require('../helpers/charFixture');

const DA_HEADERS = ['Design', 'ProductType', 'ShadeCount', 'ShadeNamesJSON',
  'RawDriveFileId', 'RawDriveUrl', 'LabeledDriveFileId', 'LabeledDriveUrl',
  'TelegramFileId', 'Status', 'UploadedBy', 'UploadedAt', 'ApprovalRequestId',
  'ApprovedBy', 'Notes', 'ArrivalBatch'];

const CUS_HEADERS = ['customer_id', 'name', 'phone', 'address', 'category',
  'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status',
  'created_at', 'updated_at', 'aliases'];

const fakeSheets = createFakeSheets({
  DesignAssets: [
    DA_HEADERS,
    ['9006', 'fabric', 2, '[{"n":1,"t":"White"},{"n":2,"t":"Beige"}]',
      'raw1', 'https://drive/raw1', 'lab1', 'https://drive/lab1',
      'FILE-9006', 'active', '777', '2026-07-01', '', '777', '', ''],
  ],
  Customers: [
    CUS_HEADERS,
    ['CUS-1', 'Alhaji Musa', '080', '', 'premium', 0, 0, '', '', 'Active', '', '', '[]'],
    ['CUS-2', 'Bello Traders', '081', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
  ],
});
installFakeSheets(fakeSheets);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const shareLinkService = require(path.join(SRC, 'services/shareLinkService'));

usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}`, role: 'admin' });

test('catalog design card carries the 📤 Share button', async () => {
  const bot = createFakeBot();
  sessionStore.clear('777');
  await controller.handleCallbackQuery(bot, cb('dab:view:9006', '777'));
  const photo = bot.calls.find((c) => c.method === 'sendPhoto');
  assert.ok(photo, 'design card is a photo');
  const buttons = photo.args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === 'shr:d:9006'), 'card offers shr:d:9006');
});

test('share → pick customer → link card with a verifying token', async () => {
  const bot = createFakeBot();
  sessionStore.clear('777');
  await controller.handleCallbackQuery(bot, cb('shr:d:9006', '777'));

  // Customer picker: both customers, skip, cancel, and menu nav (S52.2).
  const kb = kbTexts(bot);
  assert.ok(kb.some((t) => t.startsWith('Alhaji Musa|shr:c:')), 'customer chip present');
  assert.ok(kb.some((t) => t.includes('shr:skip')), 'skip present');
  assert.ok(kb.some((t) => t.includes('shr:x')), 'cancel present');
  assert.ok(kb.some((t) => t.includes('act:__back__')), 'menu nav present');

  const pick = kbTexts(bot).find((t) => t.startsWith('Alhaji Musa|')).split('|')[1];
  await controller.handleCallbackQuery(bot, cb(pick, '777'));

  const text = bot.allText();
  const m = text.match(/https:\/\/bot\.test\/d\/([A-Za-z0-9_\-.]+)/);
  assert.ok(m, 'link card contains a /d/<token> URL on BASE_URL');
  const claims = shareLinkService.verifyToken(m[1]);
  assert.ok(claims, 'token from the card verifies');
  assert.equal(claims.design, '9006');
  assert.equal(claims.customerId, 'CUS-1');
  assert.equal(claims.mintedBy, '777');

  const kb2 = kbTexts(bot);
  assert.ok(kb2.some((t) => t.startsWith('📲 Send on WhatsApp|')), 'wa.me button present');
});

test('skip mints a customer-less token', async () => {
  const bot = createFakeBot();
  sessionStore.clear('777');
  await controller.handleCallbackQuery(bot, cb('shr:d:9006', '777'));
  await controller.handleCallbackQuery(bot, cb('shr:skip', '777'));
  const m = bot.allText().match(/\/d\/([A-Za-z0-9_\-.]+)/);
  assert.ok(m, 'link minted');
  const claims = shareLinkService.verifyToken(m[1]);
  assert.equal(claims.customerId, '');
  assert.equal(claims.design, '9006');
});

test('stale shr: tap after expiry explains instead of dead-ending', async () => {
  const bot = createFakeBot();
  sessionStore.clear('777');
  await controller.handleCallbackQuery(bot, cb('shr:c:0', '777'));
  assert.ok(/expired/i.test(bot.allText()), 'expired-card message shown');
});
