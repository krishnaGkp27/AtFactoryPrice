'use strict';

/**
 * SELL-T3 (owner-confirmed 09-Aug-2026) — Abdul sells single thans out of
 * many DIFFERENT bales and designs to one customer, in one message.
 *
 * Before this, "sell than 1 from package 1100, than 1 from package 1091 …"
 * parsed correctly as `sell_mixed` and was then thrown away by the generic
 * "use Sell Bale" redirect. Pinned here:
 *
 *  - the shorthand is parsed LOCALLY (no AI call) and preloads the cart
 *    from HIS OWN numbers, across designs and shades;
 *  - a than he named that is gone is REPORTED, never substituted (§2);
 *  - "x3" opens that bale's chips instead of the bot choosing which
 *    thans; a bare bale number loads the WHOLE bale (SELL-T3c, owner
 *    25-Sep-2026) with an Open chip to drop a than;
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
  // SELL-T3b — each reason names the REAL state, and the than case lists
  // what the bale actually has so he can fix the number himself.
  assert.match(t, /1122 — than 1 is not available — this bale has than 2/);
  assert.match(t, /1105 — already sold/);
  assert.match(t, /1108 — available in \*IDUMOTA\*, not Kano office/);

  const session = sessionStore.get('4242');
  assert.equal(session.cart.lines.length, 1, 'only the than he named AND that exists');
  assert.equal(session.cart.lines[0].packageNo, '1100');
  assert.ok(!session.cart.lines.some((l) => String(l.packageNo) === '1122'),
    'BUSINESS_RULES §2 — than 2 was NOT substituted for the missing than 1');
  // Each problem bale gets a chip that opens its real than list.
  const kb = lastKb(bot).map((b) => b.callback_data);
  assert.ok(kb.includes('bs:pl:open:1122'), 'open-bale chip offered so he picks by hand');
});

test('"x3" asks HIM which thans; a bare bale loads whole (SELL-T3c)', async () => {
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('sell 1100 x3, 1091 kano'));
  const t = lastText(bot).replace(/\\/g, '');
  // x3 is a CHOICE of three among the bale's thans — still his to make.
  assert.match(t, /Pick the thans yourself \(1\)/);
  assert.match(t, /1100 — you asked for 3 of 3 available/);
  // The bare bale is the whole bale: both of 1091's thans are in.
  assert.match(t, /1091 · 9043-B · Shade 4 — than 1, 2 · 60 yd/);
  assert.match(t, /Loaded whole: 1091 — tap 🔎 Open to drop a than/);
  assert.match(t, /2 of 3 typed than\(s\) loaded/);
  const lines = sessionStore.get('4242').cart.lines;
  assert.deepEqual(lines.map((l) => `${l.packageNo}/${l.thanNo}`).sort(), ['1091/1', '1091/2']);
  assert.ok(!lines.some((l) => String(l.packageNo) === '1100'), 'x3 selected nothing');
  const kb = lastKb(bot).map((b) => b.callback_data);
  assert.ok(kb.includes('bs:pl:open:1100'), 'the x3 bale opens for his pick');
  assert.ok(kb.includes('bs:pl:open:1091'), 'the whole-loaded bale opens to drop a than');
  assert.ok(kb.includes('bs:proceed'), 'he can continue straight away');
});

test('SELL-T3c: opening a whole-loaded bale shows its chips TICKED; one tap drops a than', async () => {
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('sell 1100, 1082/1 kano'));
  let t = lastText(bot).replace(/\\/g, '');
  assert.match(t, /4 of 4 typed than\(s\) loaded/, `got: ${t}`);
  assert.match(t, /1100 · 77014 · Shade 11 — than 1, 2, 3 · 90 yd/);
  assert.match(t, /Loaded whole: 1100 —/);
  assert.ok(!/Pick the thans yourself/.test(t), 'no manual pick asked');

  const flow = require(path.join(SRC, 'flows/bundleSaleFlow'));
  const q = (data) => ({ id: 'q', data, from: { id: '4242' }, message: { chat: { id: '4242' }, message_id: 7 } });
  await flow.handleCallback(bot, q('bs:pl:open:1100'));
  t = lastText(bot).replace(/\\/g, '');
  assert.match(t, /Selected: \*3\/3\* than/, 'every than of the bale is ticked');
  const chips = lastKb(bot).filter((b) => (b.callback_data || '').startsWith('bs:than:'));
  assert.equal(chips.length, 3);
  assert.ok(chips.every((c) => c.text.startsWith('☑️')), 'chips open ticked');
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'bs:rm_bale:U-1100-1' || (b.text || '').startsWith('🧹')),
    'Clear bale offered');

  // Drop than 2 — one tap — and go back to the list.
  const drop = chips.find((c) => /#2/.test(c.text));
  await flow.handleCallback(bot, q(drop.callback_data));
  t = lastText(bot).replace(/\\/g, '');
  assert.match(t, /Selected: \*2\/3\* than/);
  await flow.handleCallback(bot, q('bs:back'));
  t = lastText(bot).replace(/\\/g, '');
  assert.equal(sessionStore.get('4242').step, 'preload_review');
  assert.match(t, /1100 · 77014 · Shade 11 — than 1, 3 · 60 yd/, 'the list shows what is left');
  // The header follows the cart: a than HE dropped is not a failure to load.
  assert.match(t, /3 of 3 typed than\(s\) loaded/);
  const lines = sessionStore.get('4242').cart.lines.map((l) => `${l.packageNo}/${l.thanNo}`).sort();
  assert.deepEqual(lines, ['1082/1', '1100/1', '1100/3']);

  // Clearing the bale on its card takes it off the "Loaded whole" line.
  await flow.handleCallback(bot, q('bs:pl:open:1100'));
  const clear = lastKb(bot).find((b) => (b.text || '').startsWith('🧹'));
  assert.ok(clear, 'Clear bale chip present');
  await flow.handleCallback(bot, q(clear.callback_data));
  await flow.handleCallback(bot, q('bs:back'));
  t = lastText(bot).replace(/\\/g, '');
  assert.ok(!/Loaded whole/.test(t), 'a cleared bale is no longer named as loaded whole');
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'bs:pl:open:1100'),
    'but it stays openable so he can take it again');
});

test('SELL-T3c: a bare bale with nothing available is still reported, never loaded', async () => {
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('sell 1105, 1100/1 kano'));
  const t = lastText(bot).replace(/\\/g, '');
  assert.match(t, /Not loaded \(1\)/);
  assert.match(t, /1105 — already sold/);
  assert.equal(sessionStore.get('4242').cart.lines.length, 1);
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

/* ── SELL-T3b: say WHY, and read the whole line he actually writes ── */

test('Abdul’s full line loads every bale and reports what it ignored', async () => {
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot,
    msg('Sell 1100/1, 1091/1, 1082/1 from kano office to karibullah, 06 august 2026'));
  const t = lastText(bot).replace(/\\/g, '');
  assert.match(t, /3 of 3 typed than\(s\) loaded/, `the tail no longer eats a bale: ${t}`);
  assert.match(t, /From \*Kano office\*/, 'the store is read even with a customer after it');
  assert.match(t, /ignored the customer "karibullah" and date "06 august 2026"/);
  assert.equal(sessionStore.get('4242').cart.lines.length, 3);
});

test('a bale still on the road says so — not "sold, or wrong number"', async () => {
  sessionStore.clear('4242');
  const orig = inventoryRepository.getAll;
  inventoryRepository.getAll = async () => ([
    ...ROWS.map((r) => ({ ...r })),
    { packageNo: '1300', thanNo: 1, design: '9006', shade: '3', warehouse: 'Kano office',
      status: 'in_transit', yards: 30, baleUid: 'U-1300-1', arrivalBatch: 'Jul26', rowIndex: 900 },
  ]);
  try {
    const bot = createFakeBot();
    await controller.handleMessage(bot, msg('sell 1300/1 kano'));
    const t = lastText(bot).replace(/\\/g, '');
    assert.match(t, /still on the road to \*Kano office\* — receive it into the store first/,
      `the real reason is shown, got: ${t}`);
    assert.ok(!/sold, or wrong number/.test(t), 'the vague catch-all is gone');
  } finally { inventoryRepository.getAll = orig; }
});

test('a sold bale names the buyer; a wrong number says it is not on record', async () => {
  sessionStore.clear('4242');
  const orig = inventoryRepository.getAll;
  inventoryRepository.getAll = async () => ([
    ...ROWS.map((r) => ({ ...r })),
    { packageNo: '1400', thanNo: 1, design: '9006', shade: '3', warehouse: 'Kano office',
      status: 'sold', soldTo: 'OKSON', soldDate: '2026-08-02', yards: 30, baleUid: 'U-1400-1', rowIndex: 901 },
  ]);
  try {
    const bot = createFakeBot();
    await controller.handleMessage(bot, msg('sell 1400/1, 999999/1 kano'));
    const t = lastText(bot).replace(/\\/g, '');
    assert.match(t, /1400 — already sold to OKSON on 2026-08-02/);
    assert.match(t, /999999 — no bale with this number on record/);
  } finally { inventoryRepository.getAll = orig; }
});

test('a than that is gone lists the thans the bale DOES have', async () => {
  sessionStore.clear('4242');
  const bot = createFakeBot();
  // 1100 has thans 1,2,3 available — ask for than 9.
  await controller.handleMessage(bot, msg('sell 1100/9 kano'));
  const t = lastText(bot).replace(/\\/g, '');
  assert.match(t, /than 9 is not available — this bale has than 1, 2, 3/);
});

test('an unknown store is named, with the real store list — not "any store"', async () => {
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('sell 1100/1 from lagoss'));
  const t = lastText(bot);
  assert.match(t, /don't know a store called/i);
  assert.match(t, /Kano office/, 'the stores that DO have stock are listed');
  assert.ok(!sessionStore.get('4242'), 'no half-open session on a bad store');
});

test('the card carries no stray backslashes (Markdown v1)', async () => {
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('sell 999999/1 kano'));
  const raw = lastText(bot);
  assert.ok(!/\\\(|\\\)|\\-/.test(raw),
    `escaped parens/dashes must not reach the card: ${raw}`);
});

test('bales split across stores: the bot asks instead of choosing one', async () => {
  sessionStore.clear('4242');
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('sell 1100/1, 1108/1'));
  assert.match(lastText(bot), /different stores/i);
  assert.ok(!sessionStore.get('4242'), 'no session started on an ambiguous store');
});

// ── SELL-T3d (owner's Go, 04-Nov-2026): "Sell 1111,1112 to Abba" got the
// chips card — a bare-only list is read locally now, every bale whole.
test('SELL-T3d: a bare-only sell line opens the review card locally — whole bales, buyer noted, no AI', async () => {
  sessionStore.clear('4242');
  intentCalls = 0;
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Sell 1100,1091 to Abba'));
  const text = lastText(bot);
  assert.equal(intentCalls, 0, 'the AI must not be consulted');
  assert.doesNotMatch(text, /I work with the chips/);
  assert.match(text, /1100/);
  assert.match(text, /1091/);
  assert.match(text, /Loaded whole/);
  assert.match(text, /Abba/);
});

// ── SELL-T3e (owner's go, 04-Nov-2026) — a whole bale is ONE line on the card ──

const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
usersRepository.getAll = async () => ([{ user_id: '4242', name: 'Abdul', status: 'active' }]);
usersRepository.findByUserId = async (id) => (String(id) === '4242' ? { user_id: '4242', name: 'Abdul', status: 'active' } : null);
let queued = [];
approvalQueueRepository.append = async (row) => { queued.push(row); return row; };
approvalQueueRepository.appendOnce = async (row) => {
  const existing = queued.find((q) => String(q.requestId) === String(row.requestId));
  if (existing) return { created: false, existing };
  queued.push(row);
  return { created: true, existing: null };
};
const cbq = (data, uid = '4242') => ({ id: `cb-${data}`, data, from: { id: uid }, message: { chat: { id: uid }, message_id: 1 } });
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
async function walkToQueue(bot, uid = '4242') {
  await controller.handleCallbackQuery(bot, cbq('bs:proceed', uid));
  await controller.handleCallbackQuery(bot, cbq('bs:sp:0', uid));
  await controller.handleCallbackQuery(bot, cbq(`bs:dd:${todayIso()}`, uid));
  await controller.handleCallbackQuery(bot, cbq('bs:fin', uid));
  await controller.handleFileMessage(bot, { from: { id: uid }, chat: { id: uid }, photo: [{ file_id: 'bill-file-9' }] });
  await controller.handleCallbackQuery(bot, cbq('bs:submit', uid));
}
const adminCopy = (bot) => bot.calls
  .filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '777')
  .map((c) => c.args.text).join('\n').replace(/\\/g, '');

test('SELL-T3e: bales typed bare reach the admin as ONE line each, counted in bales', async () => {
  sessionStore.clear('4242');
  queued = [];
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Sell 1100, 1091 to Abba'));
  await walkToQueue(bot);
  assert.equal(queued.length, 1, 'one request queued');
  const aj = queued[0].actionJSON;
  assert.equal(aj.items.length, 5, 'the request still carries every than for the executor');
  assert.deepEqual(aj.wholeBales, ['1100', '1091']);
  const text = adminCopy(bot);
  assert.match(text, /🧾 Sale · Kano office · 2B · 150 yd\n/, `tally in bales:\n${text}`);
  // Designs sort by number (9043-B before 77014); each is one bale, one line.
  assert.match(text, /\n9043-B · 1B · 60 yd\n Shade 4\n {2}1\. 1091 · 60 yd\n/, `one line for 1091:\n${text}`);
  assert.match(text, /\n77014 · 1B · 90 yd\n Shade 11\n {2}2\. 1100 · 90 yd\n/, `one line for 1100:\n${text}`);
  assert.ok(!/1100\/|1091\//.test(text), 'no than lines for a whole bale');
  // The seller's own receipt speaks the same grammar.
  const mine = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)
    && String(c.args.chatId || (c.args.opts && c.args.opts.chat_id)) === '4242')
    .map((c) => String(c.args.text || '')).join('\n');
  assert.match(mine, /Items: \*2B · 150 yd\*/, `seller receipt:\n${mine}`);
});

test('SELL-T3e: a than dropped on the bale card un-wholes it — than by than and counted in thans; taking it whole again re-wholes it', async () => {
  sessionStore.clear('4242');
  queued = [];
  const bot = createFakeBot();
  const flow = require(path.join(SRC, 'flows/bundleSaleFlow'));
  await controller.handleMessage(bot, msg('sell 1100, 1082/1 kano'));
  await flow.handleCallback(bot, cbq('bs:pl:open:1100'));
  const drop = lastKb(bot).filter((b) => (b.callback_data || '').startsWith('bs:than:')).find((c) => /#2/.test(c.text));
  await flow.handleCallback(bot, cbq(drop.callback_data));
  await flow.handleCallback(bot, cbq('bs:back'));
  await walkToQueue(bot);
  assert.equal(queued.length, 1);
  assert.ok(!('wholeBales' in queued[0].actionJSON), 'nothing whole: 1100 lost a than, 1082/1 was typed as a than');
  const text = adminCopy(bot);
  assert.match(text, /🧾 Sale · Kano office · 3t · 90 yd\n/, `tally in thans:\n${text}`);
  assert.match(text, /1100\/1 · 30 yd/);
  assert.match(text, /1100\/3 · 30 yd/);
  assert.match(text, /1082\/1 · 30 yd/);
  assert.ok(!/ 1100 · /.test(text), 'the un-wholed bale is not folded');

  // Round two: open the bale, take it whole again, submit — whole once more.
  sessionStore.clear('4242');
  queued = [];
  const bot2 = createFakeBot();
  await controller.handleMessage(bot2, msg('sell 1100, 1082/1 kano'));
  await flow.handleCallback(bot2, cbq('bs:pl:open:1100'));
  const drop2 = lastKb(bot2).filter((b) => (b.callback_data || '').startsWith('bs:than:')).find((c) => /#2/.test(c.text));
  await flow.handleCallback(bot2, cbq(drop2.callback_data));
  const takeAll = lastKb(bot2).find((b) => (b.callback_data || '').startsWith('bs:take_all:'));
  assert.ok(takeAll, '📦 Take whole bale offered once a than is dropped');
  await flow.handleCallback(bot2, cbq(takeAll.callback_data));
  await flow.handleCallback(bot2, cbq('bs:back'));
  await walkToQueue(bot2);
  assert.deepEqual(queued[0].actionJSON.wholeBales, ['1100']);
  const text2 = adminCopy(bot2);
  assert.match(text2, /🧾 Sale · Kano office · 1B \+ 1t · 120 yd\n/, `mixed tally:\n${text2}`);
  assert.match(text2, / 1100 · 90 yd/);
  assert.match(text2, /1082\/1 · 30 yd/);
});

// ── FIX-SUPPLY — the receipt names the real approver; a dropped than leaves "Loaded whole" ──

/** Everything the bot showed `uid` in his own chat, sent or edited. */
const shownTo = (bot, uid) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)
  && String(c.args.chatId || (c.args.opts && c.args.opts.chat_id)) === String(uid))
  .map((c) => String(c.args.text || '')).join('\n');

test('the submitted receipt: an employee is told ONE admin approves — no self-approve line', async () => {
  sessionStore.clear('4242');
  queued = [];
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('sell 1100/1, 1091/1 kano'));
  await walkToQueue(bot);
  assert.equal(queued.length, 1, 'one request queued');
  const mine = shownTo(bot, '4242');
  assert.match(mine, /⏳ \*Submitted for approval\*/);
  assert.match(mine, /\n• Approver: an admin\n/, `employee receipt:\n${mine}`);
  assert.ok(!/self-approve|2nd admin/.test(mine), 'an employee cannot approve at all — the self-approve wording is not his');
});

test('the submitted receipt: an admin seller keeps "2nd admin (you cannot self-approve)"', async () => {
  sessionStore.clear('777');
  queued = [];
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('sell 1100/1, 1091/1 kano', '777'));
  await walkToQueue(bot, '777');
  assert.equal(queued.length, 1, 'one request queued');
  const mine = shownTo(bot, '777');
  assert.match(mine, /\n• Approver: 2nd admin \(you cannot self-approve\)\n/, `admin receipt:\n${mine}`);
});

test('a bale loaded whole leaves "Loaded whole" once one of its thans is dropped; the others stay named', async () => {
  sessionStore.clear('4242');
  const bot = createFakeBot();
  const flow = require(path.join(SRC, 'flows/bundleSaleFlow'));
  await controller.handleMessage(bot, msg('sell 1100, 1091 kano'));
  let t = lastText(bot).replace(/\\/g, '');
  assert.match(t, /Loaded whole: 1100, 1091 — tap 🔎 Open to drop a than/);

  // Drop than 2 of 1100 on its card and go back to the review.
  await flow.handleCallback(bot, cbq('bs:pl:open:1100'));
  const drop = lastKb(bot).filter((b) => (b.callback_data || '').startsWith('bs:than:')).find((c) => /#2/.test(c.text));
  await flow.handleCallback(bot, cbq(drop.callback_data));
  await flow.handleCallback(bot, cbq('bs:back'));
  t = lastText(bot).replace(/\\/g, '');
  assert.match(t, /1100 · 77014 · Shade 11 — than 1, 3 · 60 yd/, 'the list shows what is left of 1100');
  assert.match(t, /Loaded whole: 1091 — tap 🔎 Open to drop a than/, `1100 is no longer whole:\n${t}`);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'bs:pl:open:1100'), '1100 stays openable');

  // Taking the bale whole again puts it back on the line.
  await flow.handleCallback(bot, cbq('bs:pl:open:1100'));
  const takeAll = lastKb(bot).find((b) => (b.callback_data || '').startsWith('bs:take_all:'));
  await flow.handleCallback(bot, cbq(takeAll.callback_data));
  await flow.handleCallback(bot, cbq('bs:back'));
  t = lastText(bot).replace(/\\/g, '');
  assert.match(t, /Loaded whole: 1100, 1091 — tap 🔎 Open to drop a than/);

  // With every whole bale un-wholed the line goes altogether.
  for (const pkg of ['1100', '1091']) {
    await flow.handleCallback(bot, cbq(`bs:pl:open:${pkg}`));
    const d = lastKb(bot).filter((b) => (b.callback_data || '').startsWith('bs:than:')).find((c) => /#1/.test(c.text));
    await flow.handleCallback(bot, cbq(d.callback_data));
    await flow.handleCallback(bot, cbq('bs:back'));
  }
  t = lastText(bot).replace(/\\/g, '');
  assert.ok(!/Loaded whole/.test(t), `no bale is whole any more:\n${t}`);
  sessionStore.clear('4242');
});
