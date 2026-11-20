'use strict';
/**
 * RET-6 (owner, 20-Nov-2026) — Abdul typed a return three ways and got the
 * chips card three times:
 *
 *   Return 631/1+2+3+4+5,614/1 to Idumota
 *   Return package 631/1+2+3+4+5,614/1 to Idumota
 *   Return package from soldier madam 631/1+2+3+4+5,614/1 to Idumota
 *
 * The return line only took a bare list of numbers. It now reads the words
 * around them: `package`, the buyer (`from …`) and the store (`to …`). The
 * sale record still decides both — the words are checked against it and a
 * difference is said on the card, on the confirm card and to the admin.
 */
process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '555';
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

const INV_HEADERS = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];
function invRow(pkg, than, status, soldTo, wh, design, shade, rate) {
  return [pkg, '', '', design, shade, String(than), '30', status, wh, String(rate), '2026-07-01',
    soldTo, soldTo ? '2026-08-20' : '', '', '', '', 'fabric', `UID-${pkg}-${than}`, '2026-07-01', '', '', 'Jul26', ''];
}
const CUS_HEADERS = ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases'];
installFakeSheets(createFakeSheets({
  Inventory: [
    INV_HEADERS,
    ...[1, 2, 3, 4, 5].map((t) => invRow('631', t, 'sold', 'Soldier Madam', 'IDUMOTA', '9043-B', '4', 1500)),
    invRow('631', 6, 'available', '', 'IDUMOTA', '9043-B', '4', 1500),
    invRow('614', 1, 'sold', 'soldier madam', 'IDUMOTA', '9043-A', '7', 1500),
    invRow('614', 2, 'available', '', 'IDUMOTA', '9043-A', '7', 1500),
    invRow('700', 1, 'sold', 'ABBA', 'Lagos', '9006', '1', 1000),
    invRow('800', 1, 'sold', 'ABBA', 'Lagos Island', '9006', '1', 1000),
    invRow('810', 1, 'sold', 'Musa Ibrahim', 'Kano office', '9006', '1', 1000),
    invRow('820', 1, 'sold', 'Alhaji Musa', 'Lagos office', '9006', '1', 1000),
  ],
  Customers: [
    CUS_HEADERS,
    ['CUS-S', 'Soldier Madam', '080', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
    ['CUS-A', 'ABBA', '081', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
    ['CUS-M', 'Musa Ibrahim', '082', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
    ['CUS-N', 'Alhaji Musa', '083', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
  ],
}));
// The AI never answers here: every line below must be read locally.
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const returnBundleFlow = require(path.join(SRC, 'flows/returnBundleFlow'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}`, role: id === '555' ? 'employee' : 'admin' });
auditLogRepository.append = async () => {};

const EMP = '555';
const message = (text) => ({ chat: { id: EMP }, from: { id: EMP, first_name: 'Abdul' }, text });
const lastText = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).pop().args.text.replace(/\\/g, '');

async function type(line) {
  const bot = createFakeBot();
  sessionStore.clear(EMP);
  await controller.handleMessage(bot, message(line));
  return { bot, text: lastText(bot), session: sessionStore.get(EMP) };
}

test('RET-6: Abdul\'s three lines open the return card — the same goods each time, no chips card', async () => {
  const lines = [
    'Return 631/1+2+3+4+5,614/1 to Idumota',
    'Return package 631/1+2+3+4+5,614/1 to Idumota',
    'Return package from soldier madam 631/1+2+3+4+5,614/1 to Idumota',
  ];
  for (const line of lines) {
    const { bot, text, session } = await type(line);
    assert.doesNotMatch(bot.allText(), /I work with the chips/, line);
    assert.match(text, /^↩️ \*Return\* · 🏭 IDUMOTA\n📦 6t · 180 yd\n/, line);
    assert.match(text, /👤 Soldier Madam · 6t · 180 yd/, line);
    for (const t of ['631/1', '631/2', '631/3', '631/4', '631/5', '614/1']) assert.ok(text.includes(`${t} · 30 yd`), `${line} — ${t}`);
    assert.match(text, /💰 Credits: Soldier Madam 270,000/, line);
    // The typed store and buyer agree with the sale record: nothing to say.
    assert.doesNotMatch(text, /You wrote|I did not use|I ignored/, line);
    assert.equal(session.type, 'return_bundle_flow', line);
    assert.equal(session.step, 'review', line);
  }
});

test('RET-6: a store or a buyer that the sale record does not bear out is said, never dropped', async () => {
  const { text, session } = await type('Return package from Abba 631/1 to Lagos');
  assert.match(text, /^↩️ \*Return\* · 🏭 IDUMOTA\n/, 'the goods still go back to the store they were sold from (R3)');
  assert.match(text, /👤 Soldier Madam · 1t · 30 yd/, 'the credit still goes to the buyer on the sale record');
  assert.match(text, /⚠️ You wrote "to Lagos"\. Returned goods go back to the store they were sold from: 631 → IDUMOTA\./);
  assert.match(text, /⚠️ You wrote "from Abba"\. The sale record names another buyer: 631 → Soldier Madam\. The credit goes to the buyer on the sale record\./);
  // The same two lines ride the request, so the approving admin reads them.
  const aj = returnBundleFlow._internals.buildActionJSON(session, null);
  assert.equal(aj.typedNotes.length, 2);
  const card = await approvalCards.buildReturnBundleCard(aj);
  assert.match(card, /⚠️ The requester wrote "to Lagos"\. Returned goods go back to the store they were sold from: 631 → IDUMOTA\./);
  assert.match(card, /⚠️ The requester wrote "from Abba"\. The sale record names another buyer: 631 → Soldier Madam\./);
});

test('RET-6: only the bales that differ are named; a request with no difference carries no note', async () => {
  const mixed = await type('Return 631/1, 700 to Idumota');
  assert.match(mixed.text, /⚠️ You wrote "to Idumota"\. Returned goods go back to the store they were sold from: 700 → Lagos\./);
  assert.doesNotMatch(mixed.text, /631 → /);
  const clean = await type('Return 631/1 from Soldier Madam to idumota');
  assert.doesNotMatch(clean.text, /You wrote/);
  assert.equal(returnBundleFlow._internals.buildActionJSON(clean.session, null).typedNotes, undefined);
});

test('RET-6: a bare word is silent only when it IS the store or the buyer; otherwise both are shown', async () => {
  assert.doesNotMatch((await type('Return 631/1 idumota')).text, /You wrote/);
  assert.doesNotMatch((await type('Return 631/1 soldier madam')).text, /You wrote/);
  assert.match((await type('Return 631/1 urgent')).text,
    /⚠️ You wrote "urgent"\. The store and the buyer come from the sale record: 631 → IDUMOTA · Soldier Madam\./);
  // a buyer word beside a store word is not swallowed as "the store": both facts are shown
  assert.match((await type('Return 631/1 abba idumota')).text,
    /ℹ️ You wrote "abba idumota"\. The store and the buyer come from the sale record: 631 → IDUMOTA · Soldier Madam\./);
  // the name in front of the numbers, without "from"
  const front = await type('Return soldier madam 631/1+2 to idumota');
  assert.ok(front.text.includes('631/1 · 30 yd') && front.text.includes('631/2 · 30 yd'));
  assert.doesNotMatch(front.text, /You wrote/);
});

test('RET-6: the worded line opens the same card with the AI switched off', async () => {
  const { bot, text } = await type('Return than 1 from bale 614');
  assert.doesNotMatch(bot.allText(), /I work with the chips/);
  assert.match(text, /^↩️ \*Return\* · 🏭 IDUMOTA\n📦 1t · 30 yd\n/);
  assert.ok(text.includes('614/1 · 30 yd'));
});

test('RET-6 review: a bale typed after the words is on the card; what cannot be read is named', async () => {
  for (const line of ['Return 631/1 to Idumota 614/1', 'Return 631/1 from soldier madam 614/1', 'Return 631/1 package 614/1']) {
    const { text } = await type(line);
    assert.ok(text.includes('631/1 · 30 yd') && text.includes('614/1 · 30 yd'), line);
    assert.doesNotMatch(text, /I did not use/, line);
  }
  const bad = (await type('Return 631/1 to Idumota 614/9-2')).text;
  assert.ok(bad.includes('631/1 · 30 yd'));
  assert.match(bad, /❓ Could not read: `614\/9-2`/);
  const count = (await type('Return 631/1, 2 thans 614 to Idumota')).text;
  assert.match(count, /❓ Could not read: `2 thans`/);
  assert.ok(count.includes('631/1 · 30 yd') && /614(?:\/1)? · 30 yd/.test(count), 'the bale after the count is still loaded');
});

test('RET-6 review: a count in front of a bale, a phone number and "12 days ago" are not return lists', async () => {
  for (const line of ['Return 2 thans 631', 'Return from Abba 08012345678', 'Return 12 days ago']) {
    const bot = createFakeBot();
    sessionStore.clear(EMP);
    await controller.handleMessage(bot, message(line));
    const s = sessionStore.get(EMP);
    assert.ok(!s || s.type !== 'return_bundle_flow', `${line} must not open the return card`);
  }
});

test('RET-6 review: silent only on the record\'s own name — a short or near-miss name is shown beside the record', async () => {
  // "Lagos" is not "Lagos Island": shown, whichever store the person meant
  assert.match((await type('Return 800 to Lagos')).text,
    /ℹ️ You wrote "to Lagos"\. The store on the sale record: 800 → Lagos Island\./);
  // a short name: the card says what it stands for
  assert.match((await type('Return 810 to kano')).text,
    /ℹ️ You wrote "to kano"\. The store on the sale record: 810 → Kano office\./);
  assert.match((await type('Return 810, 820 to office')).text,
    /ℹ️ You wrote "to office"\. The store on the sale record: 810 → Kano office, 820 → Lagos office\./);
  assert.match((await type('Return 810, 820 from Musa')).text,
    /ℹ️ You wrote "from Musa"\. The buyer on the sale record: 810 → Musa Ibrahim, 820 → Alhaji Musa\./);
  // the verdict for one line never depends on another line's bales
  assert.match((await type('Return 810 from Musa')).text,
    /ℹ️ You wrote "from Musa"\. The buyer on the sale record: 810 → Musa Ibrahim\./);
  // a typed name with MORE words than the record's is not taken as the same customer
  assert.match((await type('Return 810 from Musa Ibrahim Kano')).text, /ℹ️ You wrote "from Musa Ibrahim Kano"/);
  // the exact name, any case or order: nothing
  assert.doesNotMatch((await type('Return 810 from ibrahim musa to KANO OFFICE')).text, /You wrote/);
  // a piece of a word is no match at all
  assert.match((await type('Return 810 from Mus')).text, /⚠️ You wrote "from Mus"\. The sale record names another buyer: 810 → Musa Ibrahim\./);
  // a bare word that is another store's name
  assert.match((await type('Return 810 Lagos')).text,
    /⚠️ You wrote "Lagos"\. The store and the buyer come from the sale record: 810 → Kano office · Musa Ibrahim\./);
});

test('RET-6 review: a later line that names a bale already on the card is still checked', async () => {
  const { bot } = await type('Return 631/1');
  await controller.handleMessage(bot, message('631/1 from Abba to Lagos'));
  const t = lastText(bot);
  assert.match(t, /already on the list/);
  assert.match(t, /⚠️ You wrote "to Lagos"\. Returned goods go back to the store they were sold from: 631 → IDUMOTA\./);
  assert.match(t, /⚠️ You wrote "from Abba"\. The sale record names another buyer: 631 → Soldier Madam\./);
});

test('RET-6 review: the admin card prints every kept line, a long typed name is clipped, the count is bounded', async () => {
  const { bot, session } = await type('Return 631/1 from Abba to Lagos');
  await controller.handleMessage(bot, message('700 from Musa to Kano'));
  await controller.handleMessage(bot, message(`800 to ${'Verylongstorename'.repeat(5)}`));
  const aj = returnBundleFlow._internals.buildActionJSON(sessionStore.get(EMP) || session, null);
  assert.equal(aj.typedNotes.length, 5);
  const card = await approvalCards.buildReturnBundleCard(aj);
  for (const n of aj.typedNotes) assert.ok(card.includes(n.replace(/^(⚠️|ℹ️) You wrote/, '$1 The requester wrote')), n);
  assert.match(card, /The requester wrote "from Musa"\. The sale record names another buyer: 700 → ABBA/);
  assert.ok(aj.typedNotes.every((n) => n.length < 260), 'a typed name is clipped to 40 characters');
  // more than six distinct typed names: six lines and a count, never an unbounded list
  const many = { bales: [], typed: null };
  const items = [];
  for (let i = 0; i < 9; i += 1) {
    many.bales.push({ packageNo: String(900 + i), typed: { from: `Buyer${i}`, to: '', other: '' } });
    items.push({ packageNo: String(900 + i), warehouse: 'Lagos', customer: 'ABBA', soldTo: 'ABBA' });
  }
  const notes = returnBundleFlow._internals.typedNotes(many, items);
  assert.equal(notes.length, 7);
  assert.match(notes[6], /^…and 3 more typed names/);
});

test('RET-6 review: each typed line is checked against the bales IT loaded; a line on the card is always a return line', async () => {
  const { bot } = await type('Return 631/1 to Idumota');
  // a second line, typed on the review card, with a store that is wrong for ITS bale
  await controller.handleMessage(bot, message('700 to Idumota'));
  const t2 = lastText(bot);
  assert.ok(t2.includes('631/1 · 30 yd') && t2.includes('700 · 30 yd'));
  assert.match(t2, /⚠️ You wrote "to Idumota"\. Returned goods go back to the store they were sold from: 700 → Lagos\./);
  assert.doesNotMatch(t2, /631 → /, 'the first line\'s bale agreed and stays unmentioned');
  // "Sell …" typed on the return card is read as a return line: "to" is the store, never a buyer
  await controller.handleMessage(bot, message('Sell 614/1 to Idumota'));
  const t3 = lastText(bot);
  assert.ok(t3.includes('614/1 · 30 yd'));
  assert.doesNotMatch(t3, /You wrote "from Idumota"/);
});

test('RET-6: nameMatches — a short name for a store, word order, and no loose match on one or two letters', () => {
  const { nameMatches, nameLevel } = returnBundleFlow._internals;
  assert.equal(nameLevel('Lagos', 'Lagos Island'), 'partial');
  assert.equal(nameLevel('lagos', 'LAGOS'), 'exact');
  assert.equal(nameMatches('ali', 'Alimat Bello'), false, 'whole words, never a piece of a word');
  assert.equal(nameMatches('abba', 'Kabba Trading'), false);
  // accents are folded and other scripts are compared, never dropped to an empty key
  assert.equal(nameLevel('Abike Stores', 'Àbíkẹ́ Stores'), 'exact');
  assert.equal(nameLevel('محمد', 'محمد'), 'exact');
  assert.equal(nameLevel('محمد', 'ABBA'), 'none');
  assert.equal(nameLevel('Musa Ibrahim', 'Musa'), 'partial', 'more words than the record is not the same name');
  assert.equal(nameMatches('kano', 'Kano office'), true);
  assert.equal(nameMatches('Idumota store', 'IDUMOTA'), true);
  assert.equal(nameMatches('madam soldier', 'Soldier Madam'), true);
  assert.equal(nameMatches('Lagos', 'IDUMOTA'), false);
  assert.equal(nameMatches('a', 'ABBA'), false);
  assert.equal(nameMatches('', 'ABBA'), false);
});
