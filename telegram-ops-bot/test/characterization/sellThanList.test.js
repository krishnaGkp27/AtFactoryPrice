'use strict';

/**
 * SELL-T2 (owner-confirmed 09-Aug-2026) — Abdul sells single thans out of
 * many DIFFERENT bales and designs to one customer, in one message.
 *
 * Before this, "sell than 1 from package 1100, than 1 from package 1091 …"
 * parsed correctly as `sell_mixed` and was then thrown away by the generic
 * "use Sell Bale" redirect. Pinned here:
 *
 *  - the shorthand is parsed LOCALLY (no AI call) and preloads the cart
 *    from HIS OWN numbers, across designs and shades;
 *  - a than he named that is gone is REPORTED, never substituted (§2);
 *  - "x3" and a bare bale number open that bale's chips instead of the
 *    bot choosing which thans;
 *  - the long AI-parsed sentence lands on the same review card;
 *  - the typed customer stays dropped — the admin assigns it at approval.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { lastKb } = require('../helpers/charFixture');

/** One than row. Five different bales, five different designs, in Kano. */
function than(pkg, thanNo, design, shade, extra = {}) {
  return {
    packageNo: pkg, thanNo, design, shade,
    warehouse: extra.warehouse || 'Kano office',
    status: extra.status || 'available',
    yards: 30, baleUid: `U-${pkg}-${thanNo}`, arrivalBatch: 'Jul26',
    rowIndex: Number(`${pkg}${thanNo}`),
  };
}

const ROWS = [
  ...[1, 2, 3].map((t) => than('1100', t, '77014', '11')),
  ...[1, 2].map((t) => than('1091', t, '9043-B', '4')),
  ...[1, 2].map((t) => than('1082', t, '80045', '7')),
  than('1122', 2, '9006', '3'),                       // than 1 NOT available
  than('1113', 1, '77008', '2'),
  than('1105', 1, '9032', '9', { status: 'sold' }),   // gone entirely
  than('1108', 1, '9032', '9', { warehouse: 'IDUMOTA' }), // other store
];

// Seed the SHEET, not just the repo export: groupByBaleAndShade (used when
// a bale is opened from the review) reads through the repository's own
// internal getAll, which a stubbed export never reaches.
const INV_HEADER = [
  'PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status',
  'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs',
  'NetWeight', 'UpdatedAt', 'ProductType', 'bale_uid', 'addedAt', 'grn_id',
  'bin_location', 'arrival_batch', 'design_category',
];
const invSheetRows = ROWS.map((r) => ([
  r.packageNo, '', '', r.design, r.shade, r.thanNo, r.yards, r.status,
  r.warehouse, 0, '2026-07-01', '', '', 0, 0, '', 'fabric', r.baleUid,
  '2026-07-01', '', '', r.arrivalBatch, '',
]));

installFakeSheets(createFakeSheets({ Inventory: [INV_HEADER, ...invSheetRows] }));
let intent = { action: 'unknown', confidence: 0 };
let intentCalls = 0;
installFakeIntent(() => { intentCalls += 1; return intent; });

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const shadesRepository = require(path.join(SRC, 'repositories/shadesRepository'));
const designAssetsRepository = require(path.join(SRC, 'repositories/designAssetsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

shadesRepository.getAll = async () => [];
designAssetsRepository.findActive = async () => null;
auditLogRepository.append = async () => {};

inventoryRepository.getAll = async () => ROWS.map((r) => ({ ...r }));

function msg(text, uid = '4242') {
  return { from: { id: uid }, chat: { id: uid }, text };
}
function lastText(bot) {
  const c = bot.calls.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)).pop();
  return String((c && c.args.text) || '');
}

test('shorthand: five thans from five bales preload the cart — no AI call', async () => {
  sessionStore.clear('4242');
  intentCalls = 0;
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('sell 1100/1, 1091/1, 1082/1, 1113/1 kano'));

  assert.equal(intentCalls, 0, 'parsed locally — works with the AI provider down');
  const t = lastText(bot).replace(/\\/g, '');
  assert.match(t, /4 of 4 typed than\(s\) loaded/);
  assert.match(t, /From \*Kano office\*/);
  // Every bale keeps its own design and shade — the cart spans designs.
  assert.match(t, /1100 · 77014 · Shade 11 — than 1/);
  assert.match(t, /1091 · 9043-B · Shade 4 — than 1/);
  assert.match(t, /1082 · 80045 · Shade 7 — than 1/);
  assert.match(t, /1113 · 77008 · Shade 2 — than 1/);
  assert.match(t, /4 than · 120 yd · 4 bale\(s\)/);
  // DSP-1 — the buyer is still the admin's call at approval.
  assert.match(t, /admin assigns the customer, rate and payment/);

  const session = sessionStore.get('4242');
  assert.equal(session.type, 'bundle_sale_flow');
  assert.equal(session.step, 'preload_review');
  assert.equal(session.cart.lines.length, 4);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'bs:proceed'), 'Confirm & submit offered');
});

test('a than that is gone is reported — never swapped for its neighbour', async () => {
  sessionStore.clear('4242');
  const bot = createFakeBot();
  // 1122 than 1 is sold (only than 2 is available); 1105 fully sold;
  // 1108 sits in another store.
  await controller.handleMessage(bot, msg('sell 1100/1, 1122/1, 1105/1, 1108/1 kano'));
  const t = lastText(bot).replace(/\\/g, '');

  assert.match(t, /Not loaded \(3\)/);
  assert.match(t, /1122 — than 1 is not available/);
  assert.match(t, /1105 — no available than on this bale/);
  assert.match(t, /1108 — not in Kano office — it is in IDUMOTA/);

  const session = sessionStore.get('4242');
  assert.equal(session.cart.lines.length, 1, 'only the than he named AND that exists');
  assert.equal(session.cart.lines[0].packageNo, '1100');
  assert.ok(!session.cart.lines.some((l) => String(l.packageNo) === '1122'),
    'BUSINESS_RULES §2 — than 2 was NOT substituted for the missing than 1');
  // Each problem bale gets a chip that opens its real than list.
  const kb = lastKb(bot).map((b) => b.callback_data);
  assert.ok(kb.includes('bs:pl:open:1122'), 'open-bale chip offered so he picks by hand');
});

test('"x3" and a bare bale ask HIM which thans — the bot picks none', async () => {
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('sell 1100 x3, 1091 kano'));
  const t = lastText(bot).replace(/\\/g, '');
  assert.match(t, /Pick the thans yourself \(2\)/);
  assert.match(t, /1100 — you asked for 3 of 3 available/);
  assert.match(t, /1091 — 2 than available/);
  assert.equal(sessionStore.get('4242').cart.lines.length, 0, 'nothing auto-selected');
});

test('opening a bale from the review shows its real than chips, and Back returns', async () => {
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('sell 1122/1 kano'));
  const flow = require(path.join(SRC, 'flows/bundleSaleFlow'));
  const q = (data) => ({ id: 'q', data, from: { id: '4242' }, message: { chat: { id: '4242' }, message_id: 7 } });

  await flow.handleCallback(bot, q('bs:pl:open:1122'));
  const t = lastText(bot).replace(/\\/g, '');
  assert.match(t, /Bale 1122/);
  assert.match(t, /Selected: \*0\/1\* than/, 'only the available than is on the card');
  // The than numbers ride the chips, not the text.
  const chips = lastKb(bot).filter((b) => (b.callback_data || '').startsWith('bs:than:'));
  assert.equal(chips.length, 1, 'exactly one than chip');
  assert.match(chips[0].text, /#2/, 'the than that actually exists is offered');
  assert.ok(!chips.some((c) => /#1\b/.test(c.text)), 'the sold than 1 is never offered');

  await flow.handleCallback(bot, q('bs:back'));
  assert.equal(sessionStore.get('4242').step, 'preload_review', 'Back returns to the typed list');
});

test('the long sentence (AI-parsed sell_mixed) lands on the same review card', async () => {
  sessionStore.clear('4242');
  intent = {
    action: 'sell_mixed',
    thanItems: [{ packageNo: '1100', thanNo: 1 }, { packageNo: '1091', thanNo: 1 }],
    customer: 'ABBA', warehouse: 'kano office', confidence: 0.95,
  };
  const bot = createFakeBot();
  await controller.handleMessage(bot,
    msg('Sell than 1 from package 1100, than 1 from package 1091 from kano office to ABBA'));
  const t = lastText(bot).replace(/\\/g, '');
  assert.match(t, /2 of 2 typed than\(s\) loaded/, `got: ${t}`);
  assert.ok(!/Sales now run through/.test(bot.allText()), 'no more dead-end redirect');
  // CUS-1 / DSP-1 — a typed customer never rides into the request.
  assert.ok(!/ABBA/.test(t), 'the typed buyer is dropped; the admin assigns it');
  intent = { action: 'unknown', confidence: 0 };
  sessionStore.clear('4242');
});

test('bales split across stores: the bot asks instead of choosing one', async () => {
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('sell 1100/1, 1108/1'));
  assert.match(lastText(bot), /different stores/i);
  assert.ok(!sessionStore.get('4242'), 'no session started on an ambiguous store');
});
