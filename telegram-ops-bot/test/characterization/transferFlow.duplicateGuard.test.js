'use strict';
/**
 * TRF-20 (2/8) — one identity that cannot repeat, and the guard at Send.
 *
 * Drives the REAL wizard through the controller. The queue stub here is keyed
 * by requestId (unlike transferFlow.test.js's single-row stub) so that
 * appendOnce, the idempotent retry and "Send anyway" are exercised honestly.
 */
process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,abdul,musa';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const designAssetsRepo = require(path.join(SRC, 'repositories/designAssetsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
designAssetsRepo.findActive = async () => null;
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
];
let seq = 0;
const invRow = (pkg, wh = 'Lagos') => ({ rowIndex: ++seq, baleUid: `U-${pkg}`, packageNo: pkg, design: '9006', shade: '3', warehouse: wh, status: 'available', productType: 'fabric', yards: 100, pricePerYard: 0 });
inventoryRepository.getAll = async () => [invRow('P1'), invRow('P2'), invRow('P3'), invRow('P9', 'Kano office')];

/** Queue stub keyed by requestId. */
let queue;
let auditFails = false;
function armQueue() {
  queue = new Map();
  const clone = (r) => JSON.parse(JSON.stringify(r));
  approvalQueueRepository.append = async (rec) => { queue.set(rec.requestId, { ...clone(rec), status: 'pending', createdAt: new Date().toISOString() }); return rec; };
  approvalQueueRepository.getByRequestId = async (id) => (queue.has(id) ? clone(queue.get(id)) : null);
  approvalQueueRepository.appendOnce = async (rec) => {
    if (queue.has(rec.requestId)) return { created: false, existing: clone(queue.get(rec.requestId)) };
    await approvalQueueRepository.append(rec);
    return { created: true, existing: null };
  };
  approvalQueueRepository.getAllPending = async () => [...queue.values()].filter((r) => r.status === 'pending').map(clone);
  approvalQueueRepository.getAllWithRowIndex = async () => [...queue.values()].map((r, i) => ({ rowIndex: i + 2, ...clone(r) }));
  approvalQueueRepository.updateStatus = async (id, status) => { if (queue.has(id)) queue.get(id).status = status; return queue.has(id); };
  approvalQueueRepository.updateActionJSON = async (id, patch) => { const r = queue.get(id); if (r) r.actionJSON = { ...r.actionJSON, ...patch }; return !!r; };
  auditLogRepository.append = async () => { if (auditFails) throw new Error('sheet quota'); };
}

async function toConfirm(bot, uid) {
  await controller.handleCallbackQuery(bot, cb('act:transfer_stock', uid));
  await controller.handleCallbackQuery(bot, cb('trf:wh:1', uid));    // Lagos
  await controller.handleCallbackQuery(bot, cb('trf:dg:0', uid));    // 9006
  await controller.handleCallbackQuery(bot, cb('trf:sh:0', uid));    // shade 3
  await controller.handleCallbackQuery(bot, cb('trf:qty:2', uid));   // 2 bales
  await controller.handleCallbackQuery(bot, cb('trf:dest:0', uid));  // Kano office → people auto-picked
}
const openRows = () => [...queue.values()].filter((r) => r.status === 'pending');
const lastText = (bot) => bot.allText();

test('the identity is minted when the confirm card is drawn and travels on the row', async () => {
  armQueue(); sessionStore.clear('777');
  const bot = createFakeBot();
  await toConfirm(bot, 777);
  const key = sessionStore.get('777').idemKey;
  assert.match(key, /^[0-9a-f-]{36}$/, 'a UUID on the session at confirm time');
  await controller.handleCallbackQuery(bot, cb('trf:send', 777));
  assert.equal(openRows().length, 1);
  assert.equal(openRows()[0].actionJSON.idemKey, key);
  assert.match(openRows()[0].requestId, /^TR-\d{8}-\d{3}$/);
});

test('a retry after a failed audit line finds its own row — the sheet still holds ONE transfer', async () => {
  armQueue(); sessionStore.clear('777');
  const bot = createFakeBot();
  await toConfirm(bot, 777);
  auditFails = true;
  try {
    await controller.handleCallbackQuery(bot, cb('trf:send', 777));
  } finally { auditFails = false; }
  assert.equal(openRows().length, 1, 'the row was written before the audit line failed');
  assert.match(lastText(bot), /Transfer .* sent/, 'and the user was told it was SENT, not that it failed');
});

test('an identical open load blocks the send and shows the existing transfer instead', async () => {
  armQueue(); sessionStore.clear('777'); sessionStore.clear('4242');
  const first = createFakeBot();
  await toConfirm(first, 777);
  await controller.handleCallbackQuery(first, cb('trf:send', 777));
  const ref = openRows()[0].requestId;

  const second = createFakeBot();
  await toConfirm(second, 4242);
  await controller.handleCallbackQuery(second, cb('trf:send', 4242));
  assert.equal(openRows().length, 1, 'no second row');
  const text = lastText(second);
  assert.match(text, /already open/, `got: ${text}`);
  assert.match(text, /to dispatch|Waiting on/i, 'says who holds it');
  const btns = second.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').pop()
    .args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(btns.some((b) => b.callback_data === `trf:lcard:${ref}`), 'Open it points at the existing transfer');
  assert.ok(!btns.some((b) => b.callback_data === 'trf:send:force'), 'an employee gets no Send anyway');
  assert.ok(btns.some((b) => b.callback_data === 'trf:back:confirm'), 'Back returns to the typed confirm card');

  // Back really returns to the confirm card, with the same identity.
  const keyBefore = sessionStore.get('4242').idemKey;
  await controller.handleCallbackQuery(second, cb('trf:back:confirm', 4242));
  assert.match(lastText(second), /Confirm transfer/);
  assert.equal(sessionStore.get('4242').idemKey, keyBefore);
});

test('an admin may Send anyway — the second row is stamped duplicateOf; a third plain send is still blocked by the oldest open twin', async () => {
  armQueue(); sessionStore.clear('777'); sessionStore.clear('4242');
  const emp = createFakeBot();
  await toConfirm(emp, 4242);
  await controller.handleCallbackQuery(emp, cb('trf:send', 4242));
  const original = openRows()[0].requestId;

  const adm = createFakeBot();
  await toConfirm(adm, 777);
  await controller.handleCallbackQuery(adm, cb('trf:send', 777));
  assert.equal(openRows().length, 1, 'blocked first');
  const btns = adm.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').pop()
    .args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(btns.some((b) => b.callback_data === 'trf:send:force'), 'the admin sees Send anyway');
  await controller.handleCallbackQuery(adm, cb('trf:send:force', 777));
  assert.equal(openRows().length, 2, 'sent anyway');
  const dup = openRows().find((r) => r.requestId !== original);
  assert.equal(dup.actionJSON.duplicateOf, original);
  assert.notEqual(dup.requestId, original, 'a fresh reference');
  assert.match(lastText(adm), /Transfer .* sent/);

  // A third plain send of the same load is blocked and names the ORIGINAL.
  sessionStore.clear('4242');
  const third = createFakeBot();
  await toConfirm(third, 4242);
  await controller.handleCallbackQuery(third, cb('trf:send', 4242));
  assert.equal(openRows().length, 2, 'no third row');
  assert.match(lastText(third), new RegExp(require(path.join(SRC, 'services/approvalCards')).shortTransferRef(original).replace('·', '\\·')));

  // Even after the original closes, the forced copy alone still blocks.
  queue.get(original).status = 'rejected';
  const fourth = createFakeBot();
  await toConfirm(fourth, 4242);
  await controller.handleCallbackQuery(fourth, cb('trf:send', 4242));
  assert.equal(openRows().length, 1, 'the forced copy is the only open order — still no new row');
});

test('leaving the confirm card to EDIT ends the identity; a key never binds a different load', async () => {
  armQueue(); sessionStore.clear('777');
  const bot = createFakeBot();
  await toConfirm(bot, 777);
  const key = sessionStore.get('777').idemKey;
  await controller.handleCallbackQuery(bot, cb('trf:back', 777));      // back from confirm → edit
  assert.equal(sessionStore.get('777').idemKey, undefined, 'the key died with the card');
  await controller.handleCallbackQuery(bot, cb('trf:dest:0', 777));    // re-reach confirm
  const key2 = sessionStore.get('777').idemKey;
  assert.ok(key2 && key2 !== key, 'a fresh key for the fresh card');

  // Service-level: the same key with a DIFFERENT load is a new transfer, not "existing".
  const transferService = require(path.join(SRC, 'services/transferService'));
  const base = { from: 'Lagos', to: 'Kano office', requestedBy: '777', dispatcher: 'abdul', receiver: 'musa', idemKey: 'K-1' };
  const first = await transferService.createTransferRequest({ ...base, lines: [{ design: '9006', shade: '3', qty: 1 }] });
  const retry = await transferService.createTransferRequest({ ...base, lines: [{ design: '9006', shade: '3', qty: 1 }] });
  assert.equal(retry.existing, true); assert.equal(retry.requestId, first.requestId);
  const edited = await transferService.createTransferRequest({ ...base, lines: [{ design: '9006', shade: '3', qty: 3 }] });
  assert.ok(!edited.existing && !edited.duplicate && edited.requestId !== first.requestId, `an edited load under the old key is a NEW row, got ${JSON.stringify(edited)}`);
});

test('a taken reference is refused, never reported as sent', async () => {
  armQueue(); sessionStore.clear('777');
  const transferService = require(path.join(SRC, 'services/transferService'));
  const realOnce = approvalQueueRepository.appendOnce;
  approvalQueueRepository.appendOnce = async () => ({ created: false, existing: { requestId: 'TR-x' } });
  try {
    await assert.rejects(() => transferService.createTransferRequest({ from: 'Lagos', to: 'Kano office', requestedBy: '777', dispatcher: 'abdul', receiver: 'musa', lines: [{ design: '9006', shade: '3', qty: 1 }] }), /already taken/);
  } finally { approvalQueueRepository.appendOnce = realOnce; }
});

test('an employee cannot force: trf:send:force from a non-admin is still the guard', async () => {
  armQueue(); sessionStore.clear('777'); sessionStore.clear('4242');
  const a = createFakeBot();
  await toConfirm(a, 777);
  await controller.handleCallbackQuery(a, cb('trf:send', 777));
  const b = createFakeBot();
  await toConfirm(b, 4242);
  await controller.handleCallbackQuery(b, cb('trf:send:force', 4242));
  assert.equal(openRows().length, 1, 'the forged force did not write');
  assert.match(lastText(b), /already open/);
});
