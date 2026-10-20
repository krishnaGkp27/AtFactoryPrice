'use strict';
/**
 * RET-5 — "Return 771, 779, 6189/5" typed in chat → the review card grouped
 * by buyer → 🔎 Open a bale and untick one than → date → condition → photo
 * skipped → confirm → ONE `return_bundle` request → two different admins
 * sign → the thans flip back where they were sold from and EACH buyer is
 * credited at the rate they were charged. The old "Return than 2 from Bale
 * 5801" intent opens the same card (R4).
 */
process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '555';
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, lastKb } = require('../helpers/charFixture');

const INV_HEADERS = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];
function invRow(pkg, than, status, soldTo, wh, design, shade, rate) {
  return [pkg, '', '', design, shade, String(than), '30', status, wh, String(rate), '2026-07-01',
    soldTo, soldTo ? '2026-08-20' : '', '', '', '', 'fabric', `UID-${pkg}-${than}-${wh.replace(/\s+/g, '')}`, '2026-07-01', '', '', 'Jul26', ''];
}
const CUS_HEADERS = ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases'];
const fakeSheets = createFakeSheets({
  Inventory: [
    INV_HEADERS,
    ...[1, 2, 3].map((t) => invRow('771', t, 'sold', 'kafaya', 'Lagos', '9060-A', '01', 1250)),
    ...[1, 2].map((t) => invRow('779', t, 'sold', 'Kafaya', 'Lagos', '9060-A', '01', 1250)),
    invRow('779', 3, 'available', '', 'Lagos', '9060-A', '01', 1250),
    invRow('6189', 5, 'sold', 'ABBA', 'Kano office', '77014', '11', 1000),
    invRow('6189', 6, 'available', '', 'Kano office', '77014', '11', 1000),
    invRow('6210', 1, 'available', '', 'Lagos', '9060-A', '01', 1250),
    // untouched by the approval test above — for ➕ Add more
    ...[1, 2].map((t) => invRow('7001', t, 'sold', 'Kafaya', 'Lagos', '9060-A', '01', 1250)),
    invRow('7002', 1, 'sold', 'ABBA', 'Kano office', '77014', '11', 1000),
  ],
  Customers: [
    CUS_HEADERS,
    ['CUS-K', 'Kafaya', '080', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
    ['CUS-A', 'ABBA', '081', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
  ],
});
installFakeSheets(fakeSheets);
let intentResult = { action: 'unknown', confidence: 0 };
installFakeIntent(() => intentResult);
const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const auditService = require(path.join(SRC, 'services/auditService'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
const stockEngine = require(path.join(SRC, 'services/stockEngine'));
usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}`, role: id === '555' ? 'employee' : 'admin' });
auditLogRepository.append = async () => {};
auditService.log = async () => true;
if (stockEngine._internals && stockEngine._internals.shadow) stockEngine._internals.shadow = async () => {};

const EMP = '555';
const A1 = '777';
const A2 = '888';
const message = (text, uid = EMP) => ({ chat: { id: uid }, from: { id: uid, first_name: 'Test' }, text });
function armQueue() {
  const calls = { appended: null };
  let row = null;
  approvalQueueRepository.append = async (rec) => { calls.appended = rec; row = { ...rec, status: 'pending' }; return rec; };
  approvalQueueRepository.getByRequestId = async () => (row ? JSON.parse(JSON.stringify(row)) : null);
  approvalQueueRepository.getAllPending = async () => (row && row.status === 'pending' ? [JSON.parse(JSON.stringify(row))] : []);
  approvalQueueRepository.updateStatus = async (id, status) => { row.status = status; return true; };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { row.actionJSON = { ...row.actionJSON, ...patch }; return true; };
  return calls;
}
const kbData = (bot) => lastKb(bot).map((b) => b.callback_data);
const kbText = (bot) => lastKb(bot).map((b) => b.text);
const lastText = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).pop().args.text;

test('the typed line opens the review card: every buyer from the sale record, whole bales, the rest named', async () => {
  const bot = createFakeBot();
  armQueue();
  sessionStore.clear(EMP);
  await controller.handleMessage(bot, message('Return 771, 779, 6189/5, 6210, 9999'));
  const text = lastText(bot).replace(/\\/g, '');
  assert.match(text, /^↩️ \*Return\* · 🏭 Lagos \+ Kano office\n📦 1B \+ 3t · 180 yd · 2 customers\n/);
  assert.match(text, /👤 ABBA · 1t · 30 yd\n77014\n Shade 11\n {2}1\. 6189\/5 · 30 yd\n👤 Kafaya · 1B \+ 2t · 150 yd\n9060-A\n Shade 01\n {2}2\. 771 · 90 yd\n {2}3\. 779\/1 · 30 yd\n {2}4\. 779\/2 · 30 yd/);
  assert.match(text, /📦 Loaded with every sold than: 771, 779 — tap 🔎 Open to drop one\./);
  assert.match(text, /⚠️ \*Not loaded \(2\)\*\n• 6210 — nothing sold — all 1 than in stock\n• 9999 — not found in Inventory — check the number/);
  assert.match(text, /💰 Credits: ABBA 30,000 · Kafaya 187,500 _\(at the rates charged\)_/);
  assert.deepEqual(kbData(bot), ['rb:o:0', 'rb:o:1', 'rb:o:2', 'rb:go', 'rb:more', 'rb:cancel']);
  assert.deepEqual(kbText(bot).slice(0, 4), ['🔎 Open 771', '🔎 Open 779', '🔎 Open 6189', '✅ Continue — date, condition, photo']);
  const s = sessionStore.get(EMP);
  assert.equal(s.type, 'return_bundle_flow');
  assert.equal(s.step, 'review');
});

async function walkToConfirm(bot) {
  const calls = armQueue();
  sessionStore.clear(EMP);
  await controller.handleMessage(bot, message('Return 771, 779, 6189/5'));
  const cardId = sessionStore.get(EMP).flowMessageId;
  // 🔎 Open 779 → chips ticked, each naming its buyer → untick than 2
  await controller.handleCallbackQuery(bot, cb('rb:o:1', EMP, cardId));
  assert.match(lastText(bot), /Bale \*779\* · 9060-A · Shade 01\n#3 is in stock — not part of this return\.\n\nUntick the thans that did NOT come back:/);
  assert.deepEqual(kbText(bot).slice(0, 3), ['☑ #1 · 30y · Kafaya', '☑ #2 · 30y · Kafaya', '⬜ Untick all']);
  await controller.handleCallbackQuery(bot, cb('rb:t:1:1', EMP, cardId));
  assert.deepEqual(kbText(bot).slice(0, 3), ['☑ #1 · 30y · Kafaya', '☐ #2 · 30y · Kafaya', '✅ Tick all 2']);
  await controller.handleCallbackQuery(bot, cb('rb:list', EMP, cardId));
  assert.match(lastText(bot), /📦 1B \+ 2t · 150 yd · 2 customers/);
  await controller.handleCallbackQuery(bot, cb('rb:go', EMP, cardId));
  assert.match(lastText(bot), /When did the goods come back\?/);
  const today = kbData(bot).find((d) => d.startsWith('rb:dd:'));
  await controller.handleCallbackQuery(bot, cb(today, EMP, cardId));
  assert.match(lastText(bot), /How do the goods look\?/);
  await controller.handleCallbackQuery(bot, cb('rb:c:good', EMP, cardId));
  assert.match(lastText(bot), /Send ONE photo of the goods/);
  await controller.handleCallbackQuery(bot, cb('rb:pskip', EMP, cardId));
  return { calls, cardId };
}

test('open → untick → date → condition → skip photo → ONE confirm card → submit queues one return_bundle request', async () => {
  const bot = createFakeBot();
  const { calls, cardId } = await walkToConfirm(bot);
  const confirm = lastText(bot).replace(/\\/g, '');
  assert.match(confirm, /^↩️ \*Confirm return\* · 🏭 Lagos \+ Kano office\n📅 Returned \*[0-9]{2}-[A-Z][a-z]{2}-[0-9]{4}\* · ✅ Good — back to stock\n\n👤 ABBA · 1t · 30 yd\n/);
  assert.match(confirm, /\nΣ 1B \+ 2t · 150 yd\n💰 Credits: ABBA 30,000 · Kafaya 150,000 _\(at the rates charged\)_\n\nApproving puts the stock back and credits each customer's account\.\nQueues dual-admin approval\.$/);
  assert.equal(kbText(bot)[0], '✅ Submit for approval');
  await controller.handleCallbackQuery(bot, cb('rb:submit', EMP, cardId));
  const aj = calls.appended.actionJSON;
  assert.equal(aj.action, 'return_bundle');
  assert.deepEqual(aj.items.map((it) => `${it.packageNo}/${it.thanNo}:${it.customer}:${it.customerId}`),
    ['771/1:Kafaya:CUS-K', '771/2:Kafaya:CUS-K', '771/3:Kafaya:CUS-K', '779/1:Kafaya:CUS-K', '6189/5:ABBA:CUS-A']);
  assert.deepEqual(aj.wholeBales, ['771']);
  assert.deepEqual(aj.groups.map((g) => [g.customer, g.amount]), [['ABBA', 30000], ['Kafaya', 150000]]);
  assert.equal(aj.condition, 'good');
  assert.ok(aj.returnedOn);
  assert.match(lastText(bot), /↩️ \*Return — submitted\*\n\n📦 1B \+ 2t · 150 yd · ABBA, Kafaya\n\n⏳ Waiting for two admins to sign\./);
  const dm = bot.callsTo('sendMessage').filter((c) => /Approval required/i.test(c.args.text || ''));
  assert.deepEqual(dm.map((c) => String(c.args.chatId)).sort(), [A1, A2], 'both admins got the card');
  assert.match(dm[0].args.text.replace(/\\/g, ''), /↩️ Return · Lagos \+ Kano office · 1B \+ 2t · 150 yd · 2 customers\n📅 .* · ✅ Good\n\n👤 ABBA · 1t · 30 yd\n77014\n Shade 11\n {2}1\. 6189\/5 · 30 yd\n👤 Kafaya · 1B \+ 1t · 120 yd\n9060-A\n Shade 01\n {2}2\. 771 · 90 yd\n {2}3\. 779\/1 · 30 yd\n\n💰 ABBA 30,000/);
  assert.ok(!sessionStore.get(EMP), 'the session is over');
});

test('dual-admin: the second signature flips the thans where they were sold from and credits EACH buyer', async () => {
  const bot = createFakeBot();
  const { calls, cardId } = await walkToConfirm(bot);
  await controller.handleCallbackQuery(bot, cb('rb:submit', EMP, cardId));
  const requestId = calls.appended.requestId;
  const credits = [];
  accountingService.recordReturn = async (data) => { credits.push(data); };
  const bot1 = createFakeBot();
  await controller.handleCallbackQuery(bot1, cb(`approve:${requestId}`, A1, 51));
  assert.equal((await approvalQueueRepository.getAllPending()).length, 1, 'still pending after one signature');
  assert.equal(credits.length, 0);
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`approve:${requestId}`, A2, 52));
  const inv = fakeSheets._store.get('Inventory').slice(1);
  const avail = (pkg) => inv.filter((r) => r[0] === pkg && r[7] === 'available').map((r) => r[5]).sort();
  assert.deepEqual(avail('771'), ['1', '2', '3']);
  assert.deepEqual(avail('779'), ['1', '3'], 'the unticked than 2 stays sold');
  assert.deepEqual(avail('6189'), ['5', '6']);
  assert.equal(inv.find((r) => r[0] === '6189' && r[5] === '5')[8], 'Kano office', 'back where it was sold from');
  assert.equal(credits.length, 2, 'one credit per buyer');
  const byName = Object.fromEntries(credits.map((c) => [c.customer, c]));
  assert.equal(byName.Kafaya.yards, 120);
  assert.equal(byName.Kafaya.pricePerYard, 1250);
  assert.equal(byName.Kafaya.customerId, 'CUS-K');
  assert.equal(byName.ABBA.yards, 30);
  assert.equal(byName.ABBA.pricePerYard, 1000);
  assert.ok(byName.ABBA.txnId.startsWith(`RB-${requestId}-`));
  assert.match(bot2.allText(), /↩️ Credited ABBA 30,000 \(1 than, 30 yd\) · Kafaya 150,000 \(4 thans, 120 yd\)\./);
});

test('R4: the old "Return than 2 from Bale 779" intent opens the same review card', async () => {
  const bot = createFakeBot();
  armQueue();
  sessionStore.clear(EMP);
  intentResult = { action: 'return_than', packageNo: '779', thanNo: 2, customer: 'Benduku', confidence: 0.9 };
  try {
    await controller.handleMessage(bot, message('please take back than 2 of bale 779 from Benduku'));
  } finally { intentResult = { action: 'unknown', confidence: 0 }; }
  const text = lastText(bot).replace(/\\/g, '');
  assert.match(text, /↩️ \*Return\* · 🏭 Lagos\n📦 1t · 30 yd\n\n👤 Kafaya · 1t · 30 yd\n9060-A\n Shade 01\n {2}1\. 779\/2 · 30 yd/);
  assert.match(text, /ℹ️ I ignored "Benduku" — the buyer comes from the sale record\./);
  assert.equal(sessionStore.get(EMP).type, 'return_bundle_flow');
});

test('➕ Add more merges a second line; a line with nothing sold still answers', async () => {
  const bot = createFakeBot();
  armQueue();
  sessionStore.clear(EMP);
  await controller.handleMessage(bot, message('Return 7001'));
  const cardId = sessionStore.get(EMP).flowMessageId;
  await controller.handleCallbackQuery(bot, cb('rb:more', EMP, cardId));
  assert.match(lastText(bot), /Type the next bale numbers/);
  await controller.handleMessage(bot, message('7002/1, 6210'));
  const text = lastText(bot).replace(/\\/g, '');
  assert.match(text, /➕ Added 1 bale\./);
  assert.match(text, /👤 ABBA · 1t · 30 yd[\s\S]*👤 Kafaya · 1B · 60 yd/);
  assert.match(text, /• 6210 — nothing sold — all 1 than in stock/);
  const bot2 = createFakeBot();
  sessionStore.clear(EMP);
  await controller.handleMessage(bot2, message('Return 6210'));
  assert.match(lastText(bot2), /_Nothing loaded yet\._[\s\S]*• 6210 — nothing sold/);
  assert.deepEqual(kbData(bot2), ['rb:more', 'rb:cancel'], 'no Continue chip with nothing loaded');
});
