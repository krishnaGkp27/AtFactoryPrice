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
  ],
  Customers: [
    CUS_HEADERS,
    ['CUS-S', 'Soldier Madam', '080', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
    ['CUS-A', 'ABBA', '081', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
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

test('RET-6: a bare word is the store or the buyer when it names one on the list, else it is said to be unused', async () => {
  assert.doesNotMatch((await type('Return 631/1 idumota')).text, /You wrote|I did not use/);
  assert.doesNotMatch((await type('Return 631/1 soldier madam')).text, /You wrote|I did not use/);
  assert.match((await type('Return 631/1 urgent')).text, /ℹ️ I did not use "urgent"\. The buyer and the store come from the sale record\./);
});

test('RET-6: the worded line opens the same card with the AI switched off', async () => {
  const { bot, text } = await type('Return than 1 from bale 614');
  assert.doesNotMatch(bot.allText(), /I work with the chips/);
  assert.match(text, /^↩️ \*Return\* · 🏭 IDUMOTA\n📦 1t · 30 yd\n/);
  assert.ok(text.includes('614/1 · 30 yd'));
});

test('RET-6: nameMatches — a short name for a store, word order, and no loose match on one or two letters', () => {
  const { nameMatches } = returnBundleFlow._internals;
  assert.equal(nameMatches('kano', 'Kano office'), true);
  assert.equal(nameMatches('Idumota store', 'IDUMOTA'), true);
  assert.equal(nameMatches('madam soldier', 'Soldier Madam'), true);
  assert.equal(nameMatches('Lagos', 'IDUMOTA'), false);
  assert.equal(nameMatches('a', 'ABBA'), false);
  assert.equal(nameMatches('', 'ABBA'), false);
});
