'use strict';

/**
 * RET-4 — ↩️ Return goods, driven through the REAL controller.
 *
 * Pins the four surgical controller insertions and the whole journey:
 *
 *   act:return_than → rn:cust: → rn:bale: → tick rn:t: → rn:tnext →
 *   the date leg (quick chips ⇄ rn:dm: calendar ⇄ rn:dq) → rn:dd: →
 *   rn:c:damaged → a PHOTO message (handleFileMessage) → rn:submit →
 *   one queued `return_thans` request → admin #1 signs (no execution) →
 *   admin #2 signs → the credit posts.
 *
 * Also pins the typed-text door (customer search) and the stale-card
 * refusal the legacy rt* picker used to carry.
 *
 * ANCH-1 — chip taps edit the tapped tile in place, but the user's own
 * PHOTO buries it: the flow deletes that card and sends the confirm card
 * BELOW the photo, so from then on the live card is the fresh message id
 * (`session.flowMessageId`), not CARD. `walkToConfirm` returns it.
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

/** One sold Inventory row (23 columns, A..W). */
function soldRow(pkg, than, wh, soldTo, design, shade, batch) {
  return [pkg, '', '', design, shade, String(than), '30', 'sold', wh, '2500', '2026-07-01',
    soldTo, '2026-08-20', '', '', '', 'fabric',
    `UID-${pkg}-${than}-${wh.replace(/\s+/g, '')}`, '2026-07-01', '', '', batch, ''];
}

const fakeSheets = createFakeSheets({
  Inventory: [
    INV_HEADERS,
    soldRow('9037', 1, 'Kano office', 'ABBA', 'Cashmere', 'Blue', 'C1'),
    soldRow('9037', 2, 'Kano office', 'ABBA', 'Cashmere', 'Blue', 'C1'),
    soldRow('9037', 3, 'Kano office', 'ABBA', 'Cashmere', 'Blue', 'C1'),
    soldRow('9037', 4, 'Kano office', 'ABBA', 'Cashmere', 'Blue', 'C1'),
    // A second physical bale for the same buyer, in another store — the
    // TRF-INT4 pin: the warehouse sits right after the printed number.
    soldRow('9040', 1, 'IDUMOTA', 'ABBA', 'TR', 'Red', 'C2'),
    // A different buyer, so the customer picker has something to filter.
    soldRow('9050', 1, 'Kano office', 'CHIMA', 'Chinos', 'Grey', 'C1'),
  ],
});
installFakeSheets(fakeSheets);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const auditService = require(path.join(SRC, 'services/auditService'));
const customerEntity = require(path.join(SRC, 'services/customerEntity'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
const stockEngine = require(path.join(SRC, 'services/stockEngine'));

usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}`, role: id === '555' ? 'employee' : 'admin' });
auditLogRepository.append = async () => {};
auditService.log = async () => true;
customerEntity.resolve = async ({ name }) => (String(name).toUpperCase() === 'ABBA'
  ? { name: 'ABBA', customer_id: 'CUS-ABBA' } : null);
// The stock_events shadow is fail-open in production; keep it inert offline.
if (stockEngine._internals && stockEngine._internals.shadow) stockEngine._internals.shadow = async () => {};

const EMP = '555';
const A1 = '777';
const A2 = '888';
const CARD = 42;

/** In-memory ApprovalQueue (the armQueue shape the other approval pins use). */
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

/** Walk the flow to the confirm card and return the recorder + queue. */
async function walkToConfirm(bot) {
  const calls = armQueue();
  sessionStore.clear(EMP);

  // (1) the tile now opens the new card — controller insertion 2.
  await controller.handleCallbackQuery(bot, cb('act:return_than', EMP, CARD));
  const custChips = lastKb(bot).filter((b) => b.callback_data.startsWith('rn:cust:'));
  assert.ok(custChips.length >= 2, `customer chips, got ${JSON.stringify(kbData(bot))}`);
  const abba = custChips.find((b) => /ABBA/.test(b.text));
  assert.ok(abba, 'ABBA has goods out');

  await controller.handleCallbackQuery(bot, cb(abba.callback_data, EMP, CARD));
  const baleChips = lastKb(bot).filter((b) => b.callback_data.startsWith('rn:bale:'));
  assert.equal(baleChips.length, 2, 'one chip per PHYSICAL bale');
  const b9037 = baleChips.find((b) => b.text.includes('9037'));
  assert.match(b9037.text, /📦 9037 · 🏭 Kano office/, 'warehouse right after the number (TRF-INT4)');
  assert.ok(baleChips.some((b) => /9040 · 🏭 IDUMOTA/.test(b.text)), 'the other store is its own chip');

  await controller.handleCallbackQuery(bot, cb(b9037.callback_data, EMP, CARD));
  const thanChips = lastKb(bot).filter((b) => b.callback_data.startsWith('rn:t:'));
  assert.equal(thanChips.length, 4, 'four sold thans of 9037');

  // (2) tick #1 and #4, then Next.
  await controller.handleCallbackQuery(bot, cb('rn:t:0', EMP, CARD));
  await controller.handleCallbackQuery(bot, cb('rn:t:3', EMP, CARD));
  assert.deepEqual(sessionStore.get(EMP)._picked, [0, 3]);
  await controller.handleCallbackQuery(bot, cb('rn:tnext', EMP, CARD));
  assert.equal(sessionStore.get(EMP).step, 'date');

  // (3) the date leg, through the real controller: quick chips → calendar
  //     grid (dm:) → back (dq:) → a day (dd:).
  const quick = kbData(bot);
  assert.ok(quick.some((d) => d.startsWith('rn:dd:')), 'quick day chips');
  const door = quick.find((d) => d.startsWith('rn:dm:'));
  assert.ok(door, '📆 Older date — calendar door');
  await controller.handleCallbackQuery(bot, cb(door, EMP, CARD));
  assert.equal(sessionStore.get(EMP).step, 'date_cal');
  const grid = kbData(bot);
  assert.ok(grid.some((d) => d.startsWith('rn:dd:')), 'grid cells commit a day');
  assert.ok(grid.includes('rn:noop'), 'weekday headers are inert but answered');
  const before = JSON.stringify(sessionStore.get(EMP));
  await controller.handleCallbackQuery(bot, cb('rn:noop', EMP, CARD));
  assert.equal(JSON.stringify(sessionStore.get(EMP)), before, 'rn:noop mutates nothing');
  await controller.handleCallbackQuery(bot, cb('rn:dq', EMP, CARD));
  assert.equal(sessionStore.get(EMP).step, 'date', '⬅ Quick dates goes back to the chips');
  const day = kbData(bot).find((d) => d.startsWith('rn:dd:'));
  await controller.handleCallbackQuery(bot, cb(day, EMP, CARD));
  const iso = day.slice('rn:dd:'.length);
  assert.equal(sessionStore.get(EMP).returnedOn, iso);
  assert.equal(sessionStore.get(EMP).step, 'condition');

  // (4) condition → the photo card.
  await controller.handleCallbackQuery(bot, cb('rn:c:damaged', EMP, CARD));
  assert.equal(sessionStore.get(EMP).step, 'photo');

  // (5) the photo arrives as a real file message — controller insertion 3.
  await controller.handleFileMessage(bot, {
    from: { id: EMP }, chat: { id: EMP }, message_id: 900,
    photo: [{ file_id: 'ret-small' }, { file_id: 'ret-photo-1' }],
  });
  const s = sessionStore.get(EMP);
  assert.equal(s.step, 'confirm', 'the photo lands the confirm card');
  assert.equal(s.photoFileId, 'ret-photo-1', 'the LARGEST size is stored');

  // ANCH-1 — the confirm card may not be edited into place ABOVE the user's
  // photo: the old card is deleted and a fresh one is sent below it, so the
  // anchor moves off the tapped tile. Every later tap rides the NEW id.
  const dropped = bot.callsTo('deleteMessage').filter((c) => c.args.messageId === CARD);
  assert.equal(dropped.length, 1, 'the buried card was removed');
  const fresh = bot.callsTo('sendMessage').filter((c) => /Confirm return/.test(c.args.text || ''));
  assert.equal(fresh.length, 1, 'the confirm card rides at the bottom');
  assert.ok(s.flowMessageId && s.flowMessageId !== CARD, 'the anchor followed the fresh card');
  return { calls, iso, cardId: s.flowMessageId };
}

test('tile → chips → photo → confirm: chips edit in place, the photo re-anchors', async () => {
  const bot = createFakeBot();
  const { iso } = await walkToConfirm(bot);
  const text = bot.allText().replace(/\\/g, '');
  assert.match(text, /Confirm return/);
  assert.match(text, /👤 Customer: \*ABBA\*/);
  assert.match(text, /📦 Bale \*9037\*/);
  assert.match(text, /Thans \*#1, #4\*/);
  assert.match(text, /📅 Returned:/);
  assert.match(text, /⚠️ Damaged/);
  assert.match(text, /📎 Photo attached/);
  assert.match(text, /💰 Credits ABBA/, 'the booked rate is SHOWN, not asked');
  // Every CHIP tap edited the tapped tile — navigation edits, never appends.
  const edits = bot.callsTo('editMessageText').filter((c) => c.args.opts && c.args.opts.message_id === CARD);
  assert.ok(edits.length >= 8, `anchored renders, got ${edits.length}`);
  // …and the photo is the only thing that appended (ANCH-1, asserted in the
  // walk): one fresh card in the user's own chat, none before it.
  const appended = bot.callsTo('sendMessage').filter((c) => String(c.args.chatId) === EMP);
  assert.equal(appended.length, 1, `only the post-photo card appends, got ${appended.length}`);
  assert.ok(iso);
  sessionStore.clear(EMP);
});

test('a typed name on the search step reaches the flow (controller text insertion)', async () => {
  const bot = createFakeBot();
  armQueue();
  sessionStore.clear(EMP);
  await controller.handleCallbackQuery(bot, cb('act:return_than', EMP, CARD));
  await controller.handleCallbackQuery(bot, cb('rn:csearch', EMP, CARD));
  assert.equal(sessionStore.get(EMP).step, 'customer_search');

  await controller.handleMessage(bot, { from: { id: EMP }, chat: { id: EMP }, message_id: 901, text: 'chi' });
  const s = sessionStore.get(EMP);
  assert.equal(s.step, 'customer', 'the typed term re-renders the customer list');
  assert.equal(s._custFilter, 'chi');
  const chips = lastKb(bot).filter((b) => b.callback_data.startsWith('rn:cust:'));
  assert.equal(chips.length, 1, 'filtered to the one match');
  assert.match(chips[0].text, /CHIMA/);
  sessionStore.clear(EMP);
});

test('submit queues ONE return_thans request with the ticked thans and the photo', async () => {
  const bot = createFakeBot();
  const { calls, iso, cardId } = await walkToConfirm(bot);
  await controller.handleCallbackQuery(bot, cb('rn:submit', EMP, cardId));

  assert.ok(calls.appended, 'exactly one queue row');
  const aj = calls.appended.actionJSON;
  assert.equal(aj.action, 'return_thans');
  assert.equal(aj.packageNo, '9037');
  assert.equal(aj.warehouse, 'Kano office');
  assert.deepEqual(aj.thanNos, [1, 4]);
  assert.equal(aj.customer, 'ABBA');
  assert.equal(aj.customerId, 'CUS-ABBA');
  assert.equal(aj.returnedOn, iso);
  assert.equal(aj.condition, 'damaged');
  assert.equal(aj.return_photo_file_id, 'ret-photo-1');
  assert.equal(aj.pricePerYard, 2500);
  assert.equal(aj.yards, 60);
  assert.equal(aj.design, 'Cashmere');
  assert.equal(aj.shade, 'Blue');

  // The employee's receipt names the REAL gate, and the session is gone.
  assert.match(bot.allText(), /Waiting for two admins to sign/);
  assert.equal(sessionStore.get(EMP), null);

  // Both admins hold the card AND the photo before either taps.
  const dm = bot.callsTo('sendMessage').filter((c) => /Approval required/i.test(c.args.text || ''));
  const to = dm.map((c) => String(c.args.chatId));
  assert.ok(to.includes(A1) && to.includes(A2), 'both admins got the card');
  const photos = bot.callsTo('sendPhoto').map((c) => String(c.args.photo));
  assert.ok(photos.filter((p) => p === 'ret-photo-1').length >= 2, 'the photo reached both admins');
});

test('dual-admin: the first signature does not execute, the second posts the credit', async () => {
  const bot = createFakeBot();
  const { calls, cardId } = await walkToConfirm(bot);
  await controller.handleCallbackQuery(bot, cb('rn:submit', EMP, cardId));
  const requestId = calls.appended.requestId;

  const credits = [];
  accountingService.recordReturn = async (data) => { credits.push(data); };

  // Admin #1 — one signature recorded, nothing flipped yet.
  const bot1 = createFakeBot();
  await controller.handleCallbackQuery(bot1, cb(`approve:${requestId}`, A1, 51));
  const pending = await approvalQueueRepository.getAllPending();
  assert.equal(pending.length, 1, 'still pending after one signature');
  assert.deepEqual(pending[0].actionJSON.approvals, [A1]);
  assert.equal(credits.length, 0, 'no credit on the first signature');
  const invAfter1 = fakeSheets._store.get('Inventory').slice(1);
  assert.ok(invAfter1.filter((r) => r[0] === '9037' && r[7] === 'sold').length === 4, 'nothing flipped yet');

  // Admin #2 — the set executes: stock back, ONE credit at the booked rate.
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`approve:${requestId}`, A2, 52));
  const inv = fakeSheets._store.get('Inventory').slice(1).filter((r) => r[0] === '9037');
  const available = inv.filter((r) => r[7] === 'available').map((r) => r[5]).sort();
  assert.deepEqual(available, ['1', '4'], 'only the ticked thans came back');
  assert.equal(credits.length, 1, 'ONE credit for the whole set');
  assert.equal(credits[0].yards, 60);
  assert.equal(credits[0].pricePerYard, 2500);
  assert.equal(credits[0].customer, 'ABBA');
  assert.equal(credits[0].customerId, 'CUS-ABBA');
  assert.equal(credits[0].txnId, `RN-9037-${requestId}`);
  assert.match(bot2.allText(), /↩️ Credited/, 'the approve reply states the credit');
});

test('a stale card cannot steer the newer session', async () => {
  const bot = createFakeBot();
  armQueue();
  sessionStore.clear(EMP);
  await controller.handleCallbackQuery(bot, cb('act:return_than', EMP, CARD)); // card A
  await controller.handleCallbackQuery(bot, cb('act:return_than', EMP, 99));   // card B supersedes
  const before = JSON.stringify(sessionStore.get(EMP));

  await controller.handleCallbackQuery(bot, cb('rn:cust:0', EMP, CARD));       // tap on stale card A
  assert.equal(JSON.stringify(sessionStore.get(EMP)), before, 'stale tap selected nothing');
  const answered = bot.callsTo('answerCallbackQuery').at(-1);
  assert.match(JSON.stringify(answered.args), /Card expired/, 'the stale tap is told why');
  sessionStore.clear(EMP);
});
