'use strict';

/**
 * SFS-1 — 🏬 Store Sales (owner-approved refined layout, 22-Sep-2026).
 *
 *   places (plain chips) → sale days (Customer Supplies grammar) → one
 *   day's card (customer → design → "Shade X ×N (bales)"), read-only,
 *   admin-only, nothing else on any screen.
 *
 * Hardened the same day after an adversarial review (spec §7): design /
 * shade buckets case-folded, no fabricated day keys, legacy-Markdown bold
 * without backslashes, Close edits the card in place, screen 1's menu exit
 * ends the session, a foreign live session is handed off, screens 1 and 2
 * pinned whole.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const flow = require(path.join(SRC, 'flows/storeSalesFlow'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const unitDisplayService = require(path.join(SRC, 'services/unitDisplayService'));

const I = flow._internals;

// TV-8 — Kano office counts in thans; every other place in bales.
unitDisplayService.getThanVisibilityWarehouses = async () => new Set(['kano office']);

function soldRow(pkg, design, shade, thanNo, opts = {}) {
  return {
    packageNo: String(pkg), design, shade: String(shade), thanNo,
    yards: opts.yards ?? 30, pricePerYard: 1250,
    status: opts.status || 'sold', soldTo: opts.customer ?? 'ABBA',
    soldDate: opts.date ?? '2026-08-19', warehouse: opts.wh ?? 'IDUMOTA',
    baleUid: `U-${pkg}`,
  };
}

/**
 * IDUMOTA: 19 Aug — ABBA 3 of 4 thans of 5804 (202/201 sh 1) + Qaribullah
 * 2 of 3 thans of 5611 (77019 sh 3); 18 Aug — ABBA whole bale 5805 (2
 * thans, two date spellings). Kano office: 30 Jul — Musa 1 than of 9001.
 * Plus noise that must never leak: available thans, a Ketu sale.
 */
function world(extra = []) {
  return [
    soldRow('5804', '202/201', '1', 1), soldRow('5804', '202/201', '1', 2), soldRow('5804', '202/201', '1', 3),
    soldRow('5804', '202/201', '1', 4, { status: 'available', customer: '' }),
    soldRow('5611', '77019', '3', 1, { customer: 'Qaribullah', yards: 37 }),
    soldRow('5611', '77019', '3', 2, { customer: 'Qaribullah', yards: 37 }),
    soldRow('5611', '77019', '3', 3, { status: 'available', customer: '', yards: 37 }),
    soldRow('5805', '202/201', '2', 1, { date: '18-08-2026' }), soldRow('5805', '202/201', '2', 2, { date: '2026-08-18' }),
    soldRow('9001', '9037', '', 1, { wh: 'Kano office', customer: 'Musa', date: '2026-07-30', yards: 25 }),
    soldRow('7001', '9037', '2', 1, { wh: 'Ketu', customer: 'Bello', date: '2026-08-19' }),
    ...extra,
  ];
}

/** What inventoryRepository.getSoldRows() hands the flow. */
function soldOnly(rows) { return rows.filter((r) => r.status === 'sold' && r.soldTo && r.soldDate); }

function seed(rows) {
  inventoryRepository.getAll = async () => JSON.parse(JSON.stringify(rows));
  inventoryRepository.getSoldRows = async () => JSON.parse(JSON.stringify(soldOnly(rows)));
}

function textCalls(bot) { return bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText'); }
function lastText(bot) {
  const c = textCalls(bot);
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}
function lastKb(bot) {
  const c = bot.calls.filter((x) => x.args && x.args.opts && x.args.opts.reply_markup);
  return c.length ? c[c.length - 1].args.opts.reply_markup.inline_keyboard : [];
}
function kbTexts(bot) { return lastKb(bot).flat().map((b) => `${b.text}|${b.callback_data}`); }
async function tap(bot, uid, data) {
  return flow.handleCallback(bot, { id: 'q', data, from: { id: uid }, message: { chat: { id: 1 }, message_id: 55 } });
}

test.beforeEach(() => { sessionStore.clear('777'); sessionStore.clear('4242'); });

/* ───────── pure helpers ───────── */

test('groupPlaces: alphabetical, case-folded, blank warehouse forms no chip', () => {
  const rows = [
    soldRow('1', 'A', '', 1, { wh: 'Ketu' }), soldRow('2', 'A', '', 1, { wh: 'idumota' }),
    soldRow('3', 'A', '', 1, { wh: 'IDUMOTA' }), soldRow('4', 'A', '', 1, { wh: 'Balogun' }),
    soldRow('5', 'A', '', 1, { wh: '' }), soldRow('6', 'A', '', 1, { wh: '  Kano office ' }),
  ];
  const places = I.groupPlaces(rows);
  assert.deepEqual(places.map((p) => p.label), ['Balogun', 'idumota', 'Kano office', 'Ketu']);
  assert.equal(places[1].rows, 2, 'idumota + IDUMOTA are one place');
});

test('dayKey keeps a rejected cell as it is; prettyDate never rolls a date', () => {
  assert.equal(I.dayKey('2026-08-19'), '2026-08-19');
  assert.equal(I.dayKey('18-08-2026'), '2026-08-18');
  assert.equal(I.dayKey('7 April 2026'), '2026-04-07');
  assert.equal(I.dayKey('08/19/2026'), '08/19/2026', 'US order is not a DMY date — not re-converted into 2026-19-08');
  assert.equal(I.dayKey('31-02-2026'), '31-02-2026', 'an impossible day keeps its cell text');
  assert.equal(I.dayKey(''), '');
  assert.equal(I.prettyDate('2026-08-19'), '19 Aug 2026');
  assert.equal(I.prettyDate('2026-02-01'), '01 Feb 2026');
  assert.equal(I.prettyDate('31-02-2026'), '31-02-2026');
  assert.equal(I.prettyDate(''), '—');
});

test('bold / mdEsc follow legacy Markdown: no escapes inside an entity, `]` never escaped outside', () => {
  assert.equal(I.bold('AB_C'), '*AB_C*');
  assert.equal(I.bold('9060_A'), '*9060_A*');
  assert.equal(I.bold('2*2'), '*2*\\**2*', 'a star closes and reopens the entity, as the Bot API prescribes');
  assert.equal(I.bold(''), '*—*');
  assert.equal(I.mdEsc('3 [dark]'), '3 \\[dark]');
  assert.equal(I.mdEsc('x*y_z`w'), 'x\\*y\\_z\\`w');
});

test('groupDays: newest first, mixed date spellings merge, totals are the whole history', () => {
  const label = (rows) => `${rows.length}t`;
  const days = I.groupDays(soldOnly(world()), 'IDUMOTA', label);
  assert.deepEqual(days.map((d) => d.date), ['2026-08-19', '2026-08-18']);
  assert.equal(days[0].thans, 5);
  assert.equal(days[0].yards, 3 * 30 + 2 * 37);
  assert.equal(days[0].bales, 2);
  assert.equal(days[1].thans, 2, '18-08-2026 and 2026-08-18 are one day');
  assert.equal(days.totalQty, '7t');
  assert.equal(days.totalYards, 3 * 30 + 2 * 37 + 2 * 30);
});

test('groupDay: customer → design → shade → unique bale numbers; only that place and day', () => {
  const label = (rows) => `${rows.length}t`;
  const day = I.groupDay(soldOnly(world()), 'IDUMOTA', '2026-08-19', label);
  assert.deepEqual(day.customers.map((c) => c.name), ['ABBA', 'Qaribullah']);
  assert.equal(day.rows.length, 5);
  assert.equal(day.dayQty, '5t');
  const abba = day.customers[0];
  assert.deepEqual(abba.designs.map((d) => d.design), ['202/201']);
  assert.deepEqual(abba.designs[0].shades[0].bales, ['5804'], 'three thans of one bale print the bale once');
  assert.equal(abba.designs[0].shades[0].rows.length, 3);
  const qar = day.customers[1];
  assert.deepEqual(qar.designs[0].shades[0].bales, ['5611']);
  assert.equal(qar.yards, 74);
});

test('groupDay: a bale whose rows spell the shade or design two ways lands in ONE bucket (ISC-1 C11)', async () => {
  const rows = [
    soldRow('4410', '75142', 'Navy Blue', 1), soldRow('4410', '75142', 'Navy Blue', 2), soldRow('4410', '75142', 'navy blue', 3),
    soldRow('4411', '9060A', '5', 1), soldRow('4411', '9060a', '5', 2),
  ];
  const day = I.groupDay(rows, 'IDUMOTA', '2026-08-19', (r) => `${r.length}t`);
  const designs = day.customers[0].designs;
  assert.deepEqual(designs.map((d) => d.design), ['9060A', '75142'], 'one header per design, first spelling kept');
  assert.deepEqual(designs[1].shades.map((s) => [s.shade, s.rows.length, s.bales]), [['Navy Blue', 3, ['4410']]]);
  assert.deepEqual(designs[0].shades.map((s) => [s.shade, s.rows.length, s.bales]), [['5', 2, ['4411']]]);
  // Through the real labeller the whole-bale count and the lines agree.
  seed(rows);
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'sfs:w:0');
  await tap(bot, '777', 'sfs:d:0');
  assert.equal(lastText(bot),
    '🧾 *IDUMOTA* · 19 Aug 2026\n_2B sold · 150 yds_\n\n'
    + '👤 *ABBA*\n 🧵 *9060A*\n  • Shade 5 ×1B (4411)\n 🧵 *75142*\n  • Shade Navy Blue ×1B (4410)');
});

test('dayCardLines: names inside bold carry no backslash, a star is closed-and-reopened, shade text is escaped', () => {
  const label = (rows) => `${rows.length}t`;
  const rows = [soldRow('1', '9060_A', 'x*y [z]', 1, { customer: 'AB_C' }), soldRow('2', '77019', '1', 1, { customer: 'A*B' })];
  const day = I.groupDay(rows, 'IDUMOTA', '2026-08-19', label);
  const lines = I.dayCardLines(day, label);
  assert.deepEqual(lines, [
    '👤 *A*\\**B*', ' 🧵 *77019*', '  • Shade 1 ×1t (2)', '',
    '👤 *AB_C*', ' 🧵 *9060_A*', '  • Shade x\\*y \\[z] ×1t (1)',
  ]);
});

test('fitLines never cuts silently and never strands a header', () => {
  const fitted = I.fitLines(['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50)], 130);
  assert.deepEqual(fitted, ['a'.repeat(50), 'b'.repeat(50), '_…and 1 more line_']);
  assert.ok(fitted.join('\n').length <= 130, 'the pointer line is inside the budget');
  assert.deepEqual(I.fitLines(['short'], 100), ['short']);
  const card = ['👤 *A*', ' 🧵 *D*', '  • Shade 1 ×1B (5)', '', '👤 *B*', ' 🧵 *D2*', '  • Shade 2 ×1B (6)'];
  // 65 chars fits everything up to and including "👤 *B*" plus the pointer;
  // the stranded header and the blank above it are given back to the cut.
  const cut = I.fitLines(card, 65);
  assert.deepEqual(cut, ['👤 *A*', ' 🧵 *D*', '  • Shade 1 ×1B (5)', '_…and 4 more lines_']);
});

/* ───────── screens ───────── */

test('screen 1: a person with no grant is refused; an admin gets one plain chip per selling place, two per row, then Back to menu — nothing else', async () => {
  seed(world());
  const bot = createFakeBot();
  await flow.start(bot, 1, '4242', 55);
  assert.equal(lastText(bot), '🏬 No store is assigned to you — ask an admin.');
  assert.equal(sessionStore.get('4242'), null);

  const bot2 = createFakeBot();
  await flow.start(bot2, 1, '777', 55);
  assert.equal(lastText(bot2), '🏬 *Store Sales*\n\nTap a place to see its sales.');
  const kb = lastKb(bot2);
  assert.deepEqual(kb.map((r) => r.map((b) => b.text)), [['IDUMOTA', 'Kano office'], ['Ketu'], ['🏠 Back to menu']]);
  assert.deepEqual(kb.flat().map((b) => b.callback_data), ['sfs:w:0', 'sfs:w:1', 'sfs:w:2', 'sfs:menu']);
  assert.equal(sessionStore.get('777').step, 'pick_place');
});

test('screen 1: a blank-warehouse sale forms no chip (locked layout)', async () => {
  seed(world([soldRow('8001', '9037', '', 1, { wh: '', customer: 'Nobody' })]));
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  assert.deepEqual(lastKb(bot).flat().map((b) => b.text), ['IDUMOTA', 'Kano office', 'Ketu', '🏠 Back to menu']);
});

test('screen 1: no sales at all → the card says so in place, then the session ends', async () => {
  seed([soldRow('1', 'A', '', 1, { status: 'available', customer: '' })]);
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  const last = textCalls(bot).pop();
  assert.equal(last.method, 'editMessageText', 'edited into the tapped message, not a fresh bubble');
  assert.equal(last.args.text, '🏬 *Store Sales*\n\n_No sales recorded yet._');
  assert.deepEqual(kbTexts(bot), ['🏠 Back to menu|act:__back__']);
  assert.equal(sessionStore.get('777'), null);
});

test('start over another flow\'s live session hands it off: aux messages deleted, session replaced', async () => {
  seed(world());
  sessionStore.set('777', { type: 'bundle_sale_flow', step: 'confirm', flowMessageId: 900, _auxMsgIds: [901, 902] });
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  const deleted = bot.calls.filter((c) => c.method === 'deleteMessage').map((c) => c.args.messageId);
  assert.deepEqual(deleted, [901, 902]);
  assert.equal(sessionStore.get('777').type, 'store_sales_flow');
  assert.equal(sessionStore.get('777').flowMessageId, 55);
});

test('screen 2: the Customer Supplies grammar with the place in the title, pinned whole; units follow the place', async () => {
  seed(world());
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'sfs:w:0');
  assert.equal(lastText(bot),
    '🏬 *Sales — IDUMOTA*\n\n'
    + 'Total: *1B + 5t* · *224* yds\n'
    + 'across *2* sale days · first: 18 Aug 2026\n\n'
    + '_Tap a date for the day\'s detail._');
  assert.deepEqual(kbTexts(bot), [
    '19 Aug 2026 — 5t (164 yds)|sfs:d:0',
    '18 Aug 2026 — 1B (60 yds)|sfs:d:1',
    '🏬 Change place|sfs:back',
    '❌ Close|sfs:close',
  ]);
  assert.equal(sessionStore.get('777').step, 'pick_date');

  // Kano office is a thans place.
  await tap(bot, '777', 'sfs:back');
  await tap(bot, '777', 'sfs:w:1');
  assert.equal(lastText(bot),
    '🏬 *Sales — Kano office*\n\n'
    + 'Total: *1t* · *25* yds\n'
    + 'across *1* sale day · first: 30 Jul 2026\n\n'
    + '_Tap a date for the day\'s detail._');
  assert.equal(kbTexts(bot)[0], '30 Jul 2026 — 1t (25 yds)|sfs:d:0');
});

test('screen 2: a rejected date cell is shown as it is, below the real days', async () => {
  seed(world([soldRow('8002', '9037', '', 1, { date: '08/19/2026' })]));
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'sfs:w:0');
  const texts = kbTexts(bot);
  assert.equal(texts[0], '19 Aug 2026 — 5t (164 yds)|sfs:d:0');
  assert.equal(texts[2], '08/19/2026 — 1B (30 yds)|sfs:d:2');
  assert.match(lastText(bot), /across \*3\* sale days · first: 08\/19\/2026/);
});

test('screen 2: pages of 8 with ⬇ Older (N more) / ⬆ Newer, newest first', async () => {
  const many = [];
  for (let d = 1; d <= 11; d += 1) many.push(soldRow(String(100 + d), '77019', '1', 1, { date: `2026-06-${String(d).padStart(2, '0')}` }));
  seed(many);
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'sfs:w:0');
  let texts = kbTexts(bot);
  assert.equal(texts[0], '11 Jun 2026 — 1B (30 yds)|sfs:d:0');
  assert.equal(texts[7], '04 Jun 2026 — 1B (30 yds)|sfs:d:7');
  assert.equal(texts[8], '⬇ Older (3 more)|sfs:pg:1');
  assert.ok(!texts.some((t) => t.startsWith('⬆ Newer')));
  await tap(bot, '777', 'sfs:pg:1');
  texts = kbTexts(bot);
  assert.equal(texts[0], '03 Jun 2026 — 1B (30 yds)|sfs:d:8');
  assert.equal(texts[2], '01 Jun 2026 — 1B (30 yds)|sfs:d:10');
  assert.equal(texts[3], '⬆ Newer|sfs:pg:0');
  // A tap on a tile from the other page still resolves by absolute index.
  await tap(bot, '777', 'sfs:d:10');
  assert.match(lastText(bot), /IDUMOTA\* · 01 Jun 2026/);
});

test('screen 3: who bought what from that place that day — quantities and bale numbers only', async () => {
  seed(world());
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'sfs:w:0');
  await tap(bot, '777', 'sfs:d:0');
  const text = lastText(bot);
  assert.equal(text,
    '🧾 *IDUMOTA* · 19 Aug 2026\n'
    + '_5t sold · 164 yds_\n\n'
    + '👤 *ABBA*\n'
    + ' 🧵 *202/201*\n'
    + '  • Shade 1 ×3t (5804)\n'
    + '\n'
    + '👤 *Qaribullah*\n'
    + ' 🧵 *77019*\n'
    + '  • Shade 3 ×2t (5611)');
  assert.ok(!/1,250|₦|value|Full details|doc/i.test(text), 'no money, no doc, no full-details');
  assert.deepEqual(kbTexts(bot), ['⬅ Dates|sfs:back', '❌ Close|sfs:close']);
  assert.equal(sessionStore.get('777').step, 'view_day');

  // The whole-bale day prints "1B" and the bale once.
  await tap(bot, '777', 'sfs:back');
  assert.equal(sessionStore.get('777').step, 'pick_date');
  await tap(bot, '777', 'sfs:d:1');
  assert.equal(lastText(bot),
    '🧾 *IDUMOTA* · 18 Aug 2026\n_1B sold · 60 yds_\n\n👤 *ABBA*\n 🧵 *202/201*\n  • Shade 2 ×1B (5805)');
});

test('screen 3: a day whose thans were all returned says so instead of an empty card', async () => {
  seed(world());
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'sfs:w:0');
  // The return lands between the tile render and the tap.
  seed(world().map((r) => (r.packageNo === '5805' ? { ...r, status: 'available', soldTo: '', soldDate: '' } : r)));
  await tap(bot, '777', 'sfs:d:1');
  assert.equal(lastText(bot), '🧾 *IDUMOTA* · 18 Aug 2026\n\n_Nothing found — it may have been returned._');
  assert.deepEqual(kbTexts(bot), ['⬅ Dates|sfs:back', '❌ Close|sfs:close']);
});

test('screen 3: an oversize day is cut with a counted "…and N more lines", never silently', async () => {
  const rows = [];
  for (let i = 0; i < 260; i += 1) rows.push(soldRow(String(1000 + i), `D${i}`, '1', 1, { customer: `CUSTOMER-${String(i).padStart(3, '0')}` }));
  seed(rows);
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'sfs:w:0');
  await tap(bot, '777', 'sfs:d:0');
  const text = lastText(bot);
  assert.ok(text.length <= I.DAY_CARD_MAX_CHARS, `card is ${text.length} chars`);
  assert.match(text, /\n_…and \d+ more lines_$/);
});

test('navigation: back from days → places; ❌ Close edits the card in place; a stale tap strips the old buttons and says so once', async () => {
  seed(world());
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'sfs:w:2');
  assert.match(lastText(bot), /Sales — Ketu/);
  await tap(bot, '777', 'sfs:back');
  assert.equal(lastText(bot), '🏬 *Store Sales*\n\nTap a place to see its sales.');
  assert.equal(sessionStore.get('777').placeKey, null);

  await tap(bot, '777', 'sfs:close');
  const closed = textCalls(bot).pop();
  assert.equal(closed.method, 'editMessageText', 'the card itself becomes Closed.');
  assert.equal(closed.args.opts.message_id, 55);
  assert.equal(closed.args.text, '🏬 Closed.');
  assert.deepEqual(kbTexts(bot), ['🏠 Back to menu|act:__back__']);
  assert.equal(sessionStore.get('777'), null);

  const before = bot.calls.length;
  const handled = await tap(bot, '777', 'sfs:d:0');
  assert.equal(handled, true);
  const after = bot.calls.slice(before).map((c) => c.method);
  assert.deepEqual(after, ['answerCallbackQuery', 'editMessageReplyMarkup', 'sendMessage']);
  assert.deepEqual(bot.calls[before + 1].args.replyMarkup, { inline_keyboard: [] });
  assert.equal(lastText(bot), '🏬 That Store Sales screen has expired — open 🏬 Store Sales again.');
});

test('guards: a place tap on the wrong step and an out-of-range index are ignored; another flow\'s session is left alone', async () => {
  seed(world());
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  await tap(bot, '777', 'sfs:w:9');
  assert.equal(sessionStore.get('777').step, 'pick_place');
  await tap(bot, '777', 'sfs:d:0');
  assert.equal(sessionStore.get('777').step, 'pick_place');
  await tap(bot, '777', 'sfs:w:0');
  const before = bot.calls.length;
  await tap(bot, '777', 'sfs:w:1');
  assert.equal(sessionStore.get('777').placeLabel, 'IDUMOTA', 'a second place tap on the days screen is ignored');
  assert.equal(bot.calls.length, before + 1, 'only the callback answer');

  sessionStore.set('777', { type: 'bundle_sale_flow', step: 'x' });
  await tap(bot, '777', 'sfs:close');
  assert.equal(sessionStore.get('777').type, 'bundle_sale_flow');
});

test('a foreign prefix is not handled', async () => {
  const bot = createFakeBot();
  assert.equal(await tap(bot, '777', 'sbl:close'), false);
  assert.equal(bot.calls.length, 0);
});

/* ───────── SSA-1 — a granted employee ───────── */

const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const GRANTS = {};
usersRepository.findByUserId = async (id) => (GRANTS[id] ? { user_id: String(id), name: 'X', status: 'active', store_sales_places: GRANTS[id] } : null);

test('one granted place: screen 1 is skipped, the title is that place, no Change place, Back closes', async () => {
  seed(world());
  GRANTS['4242'] = ['kano office'];
  const bot = createFakeBot();
  await flow.start(bot, 1, '4242', 55);
  assert.equal(lastText(bot),
    '🏬 *Sales — kano office*\n\n'
    + 'Total: *1t* · *25* yds\n'
    + 'across *1* sale day · first: 30 Jul 2026\n\n'
    + '_Tap a date for the day\'s detail._');
  assert.deepEqual(kbTexts(bot), ['30 Jul 2026 — 1t (25 yds)|sfs:d:0', '❌ Close|sfs:close']);
  const s = sessionStore.get('4242');
  assert.equal(s.step, 'pick_date');
  assert.deepEqual(s.scope, ['KANO OFFICE']);
  assert.equal(s.single, true);
  // A wrong-place tap cannot open another store.
  await tap(bot, '4242', 'sfs:w:0');
  assert.equal(sessionStore.get('4242').placeKey, 'KANO OFFICE');
  // The day card and Back.
  await tap(bot, '4242', 'sfs:d:0');
  assert.equal(lastText(bot), '🧾 *kano office* · 30 Jul 2026\n_1t sold · 25 yds_\n\n👤 *Musa*\n 🧵 *9037*\n  • Shade — ×1t (9001)');
  await tap(bot, '4242', 'sfs:back');
  assert.deepEqual(kbTexts(bot), ['30 Jul 2026 — 1t (25 yds)|sfs:d:0', '❌ Close|sfs:close']);
  await tap(bot, '4242', 'sfs:back');
  assert.equal(lastText(bot), '🏬 Closed.');
  assert.equal(sessionStore.get('4242'), null);
});

test('two granted places: screen 1 shows only those chips; a granted place with no sales is simply absent', async () => {
  seed(world());
  GRANTS['4242'] = ['Ketu', 'Kano office', 'Balogun'];
  const bot = createFakeBot();
  await flow.start(bot, 1, '4242', 55);
  assert.deepEqual(kbTexts(bot), ['Kano office|sfs:w:0', 'Ketu|sfs:w:1', '🏠 Back to menu|sfs:menu']);
  await tap(bot, '4242', 'sfs:w:1');
  assert.match(lastText(bot), /^🏬 \*Sales — Ketu\*/);
  assert.deepEqual(kbTexts(bot).slice(-2), ['🏬 Change place|sfs:back', '❌ Close|sfs:close']);
});

test('granted places with no sales at all: one line, session closed', async () => {
  seed(world());
  GRANTS['4242'] = ['Balogun', 'Lekki'];
  const bot = createFakeBot();
  await flow.start(bot, 1, '4242', 55);
  assert.equal(lastText(bot), '🏬 *Store Sales*\n\n_No sales recorded yet for your places._');
  assert.equal(sessionStore.get('4242'), null);
});

test('no grant: refused in one line, no session', async () => {
  seed(world());
  GRANTS['4242'] = [];
  const bot = createFakeBot();
  await flow.start(bot, 1, '4242', 55);
  assert.equal(lastText(bot), '🏬 No store is assigned to you — ask an admin.');
  assert.equal(sessionStore.get('4242'), null);
});
