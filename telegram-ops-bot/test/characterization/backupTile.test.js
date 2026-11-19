'use strict';

/**
 * BKP-2 / BKP-3 / BKP-4 — 📊 Reporting → 💾 Backup, through the REAL
 * controller and the REAL approval pipeline on fake sheets.
 *
 * Owner, 19-Nov-2026 (BKP-4), on the first nightly files in every admin's
 * chat: "I did not ask you to send the backup of the sheet like this so
 * easily … Can you delete it all? … disable this function entirely for any
 * other admin and give it a switch inside the sheet itself."
 *
 *   · OFF unless the Settings sheet says otherwise: the tile offers nothing;
 *   · only the admins NAMED in the sheet have any part in a backup — an
 *     admin who is not named sees no schedule, cannot ask, cannot approve
 *     and is told nothing;
 *   · 🗑 the files already sent are taken back out of the chats.
 *
 * and, when it IS on (BKP-3): one named admin asks, a DIFFERENT named admin
 * approves, the files go to those two.
 */

process.env.ADMIN_IDS = '777,888,999';
process.env.EMPLOYEE_IDS = '4242,4343';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

const SEED = {
  Inventory: [['PackageNo', 'Yards'], ['1201', '30']],
  Users: [['user_id', 'name', 'role', 'branch', 'access_level', 'status'],
    ['777', 'Krishna', 'admin', '', '', 'active'], ['888', 'Musa', 'admin', '', '', 'active'],
    ['999', 'Office', 'admin', '', '', 'active'],
    ['4242', 'Abdul', 'employee', '', '', 'active'],
    // a role typed into the sheet: an "admin" nobody put in the bot's own configuration
    ['4343', 'Sly', 'admin', '', '', 'active']],
};
const fake = createFakeSheets(JSON.parse(JSON.stringify(SEED)));
installFakeSheets(fake);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const config = require(path.join(SRC, 'config'));
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const activityRegistry = require(path.join(SRC, 'services/activityRegistry'));
const offsiteBackup = require(path.join(SRC, 'services/offsiteBackup'));
const backupPurge = require(path.join(SRC, 'services/backupPurge'));
const backupFlow = require(path.join(SRC, 'flows/backupFlow'));
const approvalGate = require(path.join(SRC, 'services/approvalGate'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const auth = require(path.join(SRC, 'middlewares/auth'));
const risk = require(path.join(SRC, 'risk/evaluate'));

// the backup's planned reads are not part of the harness's fake client
const realGrid = async () => [...fake._store.keys()].map((name) => ({ name, rows: 1000, cols: 26 }));
const realRead = async (ranges) => ranges.map((r) => fake._store.get(r.replace(/^'|'$/g, '')) || []);
sheets.getSheetGrid = realGrid;
sheets.readRangesRaw = realRead;
/** The Settings sheet's two rows. ON with Krishna and Musa named, unless a test says otherwise. */
let settings = {};
const ON = { OFFSITE_BACKUP_ENABLED: 1, OFFSITE_BACKUP_IDS: '777, 888' };
settingsRepository.getAll = async () => ({ ...settingsRepository.DEFAULTS, ...settings });
const audits = [];
auditLogRepository.append = async (event, payload, by) => { audits.push({ event, payload, by }); };
backupPurge._internals.PACE.miss = 0;
backupPurge._internals.PACE.hit = 0;

const K = '777'; // Krishna — named
const M = '888'; // Musa — named
const O = '999'; // Office — an admin, NOT named
const cq = (uid, data, mid = 77) => ({ id: `cq-${data}`, data, from: { id: Number(uid) }, message: { chat: { id: Number(uid) }, message_id: mid } });
const texts = (bot, uid) => bot.calls
  .filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && String(c.args.chatId ?? (c.args.opts && c.args.opts.chat_id)) === String(uid))
  .map((c) => String(c.args.text || ''));
const lastCard = (bot, uid) => bot.calls
  .filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && String(c.args.chatId ?? (c.args.opts && c.args.opts.chat_id)) === String(uid)).at(-1);
const kbOf = (c) => (((c && c.args.opts && c.args.opts.reply_markup) || {}).inline_keyboard || []).flat().map((b) => `${b.text}|${b.callback_data}`);
const docs = (bot) => bot.callsTo('sendDocument').map((c) => c.args);
const toChat = (bot, uid) => bot.calls.filter((c) => String(c.args.chatId ?? (c.args.opts && c.args.opts.chat_id)) === String(uid));
const releases = async (status = 'pending') => {
  const all = await approvalQueueRepository.getAllWithRowIndex();
  return all.filter((r) => r.actionJSON && r.actionJSON.action === 'release_backup' && String(r.status) === status);
};

test.beforeEach(() => {
  for (const name of [...fake._store.keys()]) {
    fake._store.set(name, SEED[name] ? JSON.parse(JSON.stringify(SEED[name])) : fake._store.get(name).slice(0, 1));
  }
  offsiteBackup._internals._resetForTests();
  backupPurge._internals._resetForTests();
  approvalGate._internals.recent.clear();
  [K, M, O, '4242', '4343'].forEach((u) => sessionStore.clear(u));
  config.access.adminIds = ['777', '888', '999'];
  sheets.getSheetGrid = realGrid;
  sheets.readRangesRaw = realRead;
  settings = { ...ON };
  audits.length = 0;
});

/** Krishna asks; returns the bot and the pending request. */
async function asked() {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(K, 'bkp:ask'));
  return { bot, row: (await releases())[0] };
}

/* ── BKP-4: off, and a switch in the sheet ───────────────────────────── */

test('the defaults — no Settings row at all: the backup is OFF, the tile says where the switch is and offers nothing', async () => {
  settings = {};
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(K, 'act:backup'));
  const card = lastCard(bot, K);
  assert.equal(String(card.args.text), [
    '💾 *Backup*', '',
    '🔴 Switched OFF. No backup is sent to anyone, daily or on demand.',
    'The switch is in the Settings sheet: `OFFSITE_BACKUP_ENABLED` (1 = on, 0 = off).',
    'Who may receive one is named there too: `OFFSITE_BACKUP_IDS` (two or more admin ids). Blank = nobody.',
  ].join('\n'));
  assert.deepEqual(kbOf(card), ['🏠 Back to menu|act:__back__']);
});

test('switched off: a crafted ask raises nothing, the old one-tap button sends nothing, the daily run does not go out', async () => {
  for (const cfg of [{}, { OFFSITE_BACKUP_ENABLED: 0, OFFSITE_BACKUP_IDS: '777, 888' }, { OFFSITE_BACKUP_ENABLED: '', OFFSITE_BACKUP_IDS: '777, 888' }]) {
    settings = cfg;
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cq(K, 'bkp:ask'));
    await controller.handleCallbackQuery(bot, cq(K, 'bkp:now'));
    assert.equal(await offsiteBackup.tick(bot, new Date('2026-11-19T02:30:00+01:00')), 'disabled');
    assert.equal(docs(bot).length, 0, JSON.stringify(cfg));
    assert.equal((await releases()).length, 0, JSON.stringify(cfg));
    assert.ok(texts(bot, K).some((t) => /🔴 The backup is switched off in the Settings sheet\. Nothing was asked and nothing was sent\.$/.test(t)));
    assert.equal(toChat(bot, M).length + toChat(bot, O).length, 0, 'no other admin hears anything');
  }
});

test('switched off AFTER a request was raised: approving it sends nothing', async () => {
  const { bot, row } = await asked();
  settings = { OFFSITE_BACKUP_ENABLED: 0, OFFSITE_BACKUP_IDS: '777, 888' };
  await controller.handleCallbackQuery(bot, cq(M, `approve:${row.requestId}`));
  assert.equal(docs(bot).length, 0);
  assert.equal((await releases('approved')).length, 0, 'not approved either');
  assert.ok(texts(bot, M).some((t) => /Backups are switched off in the Settings sheet\. Nothing was sent\./.test(t)));
});

test('an admin who is NOT named in the sheet has no part in it: no schedule, no ask, no card, no approval, no notice', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(O, 'act:backup'));
  assert.equal(String(lastCard(bot, O).args.text), '💾 *Backup*\n\nThe backup is not open to you.');
  assert.deepEqual(kbOf(lastCard(bot, O)), ['🏠 Back to menu|act:__back__']);
  await controller.handleCallbackQuery(bot, cq(O, 'bkp:ask'));
  assert.equal((await releases()).length, 0);
  assert.match(String(lastCard(bot, O).args.text), /The backup is not open to you\. Nothing was asked\.$/);

  // a request between the two named admins: Office gets no card, cannot approve, hears nothing of the release
  const { bot: b2, row } = await asked();
  assert.equal(toChat(b2, O).length, 0, 'no approval card for the admin who is not named');
  await controller.handleCallbackQuery(b2, cq(O, `approve:${row.requestId}`));
  assert.equal(docs(b2).length, 0);
  assert.equal((await releases('approved')).length, 0);
  assert.ok(texts(b2, O).some((t) => /only between two admins named in Settings OFFSITE_BACKUP_IDS/.test(t)));
  const n = toChat(b2, O).length;
  await controller.handleCallbackQuery(b2, cq(M, `approve:${row.requestId}`));
  assert.deepEqual(docs(b2).map((d) => String(d.chatId)), [K, M]);
  assert.equal(toChat(b2, O).length, n, 'and the release is not announced to them');
});

test('switched on with one admin named: nothing can be asked — a backup never goes to one admin alone', async () => {
  settings = { OFFSITE_BACKUP_ENABLED: 1, OFFSITE_BACKUP_IDS: '777' };
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(K, 'act:backup'));
  const card = lastCard(bot, K);
  assert.match(String(card.args.text), /🟡 Switched on, but nothing is sent: only one admin is named to receive it, and a backup never goes to one admin alone\./);
  assert.deepEqual(kbOf(card), ['🏠 Back to menu|act:__back__']);
  await controller.handleCallbackQuery(bot, cq(K, 'bkp:ask'));
  assert.equal((await releases()).length, 0);
  assert.equal(docs(bot).length, 0);
});

/* ── BKP-4: the files already sent are taken back out ────────────────── */

test('🗑 Delete the backup files already sent: asks first, then removes every file from both chats and says so', async () => {
  // a backup was released to Krishna and Musa
  const { bot, row } = await asked();
  await controller.handleCallbackQuery(bot, cq(M, `approve:${row.requestId}`));
  const sent = bot.calls.filter((c) => c.method === 'sendDocument');
  assert.equal(sent.length, 2);
  const sentIds = offsiteBackup.sentInMemory().flatMap((x) => x.messages);
  assert.deepEqual(sentIds.map((x) => x.c), [K, M]);

  // the tile now offers the clean-up — to any admin, named or not, and with the switch off too
  settings = {};
  const b2 = createFakeBot();
  b2.forwardMessage = async () => { const e = new Error('not found'); e.response = { body: { error_code: 400, description: 'Bad Request: message to forward not found' } }; throw e; };
  await controller.handleCallbackQuery(b2, cq(O, 'act:backup'));
  let card = lastCard(b2, O);
  assert.match(String(card.args.text), /🔴 Switched OFF\.[\s\S]*\n\n🗑 Backup files sent in the last 48 hours can still be removed from the chats\.$/);
  assert.deepEqual(kbOf(card), ['🗑 Delete the backup files already sent|bkp:del', '🏠 Back to menu|act:__back__']);

  // it asks first, and says what it cannot do
  await controller.handleCallbackQuery(b2, cq(O, 'bkp:del'));
  card = lastCard(b2, O);
  assert.match(String(card.args.text), /^🗑 \*Delete the backup files already sent\?\*\n\nEvery backup file the bot sent in the last 48 hours is removed from every admin's chat with the bot, yours included\.\n/);
  assert.match(String(card.args.text), /A file somebody already saved to their phone or forwarded elsewhere is not removed by this\.$/);
  assert.deepEqual(kbOf(card), ['🗑 Yes, delete them|bkp:delyes', '⬅ Back|bkp:home']);
  assert.equal(b2.callsTo('deleteMessage').length, 0, 'nothing is deleted before the yes');

  await controller.handleCallbackQuery(b2, cq(O, 'bkp:delyes'));
  const res = await backupFlow._internals.purging();
  assert.deepEqual([res.ok, res.deleted, res.failed], [true, 2, 0]);
  const deleted = b2.callsTo('deleteMessage').map((c) => `${c.args.chatId}:${c.args.messageId}`);
  for (const x of sentIds) assert.ok(deleted.includes(`${x.c}:${x.m}`), `message ${x.m} in chat ${x.c} was deleted`);
  card = lastCard(b2, O);
  assert.match(String(card.args.text), /🗑 2 backup files removed from 2 chats: Krishna 1 · Musa 1\.\nA file somebody already saved to their phone or forwarded elsewhere is not removed by this\.$/);
  assert.ok(audits.some((a) => a.event === 'backup_files_deleted' && a.by === O && a.payload.deleted === 2));
});

test('an employee cannot start the clean-up', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('4242', 'bkp:delyes'));
  assert.equal(bot.callsTo('deleteMessage').length, 0);
  assert.ok(bot.callsTo('answerCallbackQuery').every((c) => c.args.opts && c.args.opts.text === 'Admin only.'));
});

/* ── the policy and the tile, when it is on ──────────────────────────── */

test('the policy: a backup release always needs approval, and it is a two-admin action', () => {
  assert.ok(risk.ALWAYS_APPROVAL_ACTIONS.includes('release_backup'));
  assert.ok(risk.DUAL_ADMIN_ACTIONS.includes('release_backup'));
  assert.equal(risk.requiredAdminApprovals({ action: 'release_backup', requesterIsAdmin: false, adminCount: 3 }), 2);
  // an admin who asks is the first of the two; one OTHER admin approves
  assert.equal(risk.requiredAdminApprovals({ action: 'release_backup', requesterIsAdmin: true, adminCount: 1 }), 1);
});

test('the tile is 💾 Backup in the Reporting hub', () => {
  const a = activityRegistry.getActivity('backup');
  assert.ok(a);
  assert.deepEqual([a.label, a.icon, a.hub, a.callback], ['Backup', '💾', 'reporting', 'act:backup']);
});

test('switched on, a named admin opens the card: the schedule, the named admins, the two-admin rule, and ASK — not send', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(K, 'act:backup'));
  const card = lastCard(bot, K);
  assert.match(String(card.args.text), /^💾 \*Backup\*\n\nRuns every day at 02:00 and goes to: Krishna, Musa\.\nTwo files: the workbook, and the database records\.\n🔐 A backup never goes to one admin alone\. One on demand is asked by one named admin and approved by another, and both receive it\.\n/);
  assert.deepEqual(kbOf(card), ['📤 Ask for a backup now|bkp:ask', '🏠 Back to menu|act:__back__']);
});

/* ── asking ──────────────────────────────────────────────────────────── */

test('📤 Ask for a backup now sends NO file: it raises one request, and only the other NAMED admin gets the card', async () => {
  const { bot, row } = await asked();
  assert.equal(docs(bot).length, 0, 'nothing leaves on one admin\'s tap');
  assert.ok(row, 'one request is waiting');
  assert.deepEqual([String(row.user), row.actionJSON.action, row.actionJSON.requester_name], [K, 'release_backup', 'Krishna']);
  const ref = approvalCards.shortRequestRef(row.requestId);

  // Musa: the approval card with the decision buttons
  const musa = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === M);
  assert.equal(musa.length, 1);
  const mText = String(musa[0].args.text).replace(/\\/g, '');
  assert.match(mText, /💾 Backup on demand\nKrishna asks for the full backup: the workbook and the database records\.\nApproving sends both files to you and to Krishna, and to nobody else\.\n🔐 A backup never goes to one admin alone\. Every admin is told when it is released\./);
  assert.deepEqual(kbOf(musa[0]), [`✅ Approve|approve:${row.requestId}`, `❌ Reject|reject:${row.requestId}`]);
  assert.equal(toChat(bot, O).length, 0, 'the admin who is not named gets nothing');

  // Krishna: no approval card of his own request; his tile says where it stands
  assert.ok(!texts(bot, K).some((t) => /Approval required/.test(t)));
  const mine = lastCard(bot, K);
  assert.match(String(mine.args.text), new RegExp(`⏳ You asked for a backup under 1h ago · ${ref} · waiting on another named admin\\.\\n\\n✅ Asked · ${ref}\\. Sent to 1 named admin for approval\\. Nothing is sent until one of them approves; the files then arrive here and in their chat\\.$`));
  assert.deepEqual(kbOf(mine), [`🔔 Remind approvers|apg:nudge:${row.requestId}`, `📋 Status|apg:st:${row.requestId}`, '🏠 Back to menu|act:__back__']);
});

test('one request at a time: a second ask — by anyone — raises nothing, and the other admin\'s tile offers the decision', async () => {
  const { bot, row } = await asked();
  await controller.handleCallbackQuery(bot, cq(K, 'bkp:ask'));
  await controller.handleCallbackQuery(bot, cq(M, 'bkp:ask'));
  assert.equal((await releases()).length, 1);
  assert.equal(docs(bot).length, 0);
  const musa = lastCard(bot, M);
  assert.match(String(musa.args.text), /⏳ Krishna asks for a backup · under 1h ago · R-[A-Z0-9]{4}\. Approving sends the files to you and to Krishna\.\n\n⏳ A backup request is already waiting for its second admin\. It is shown below\.$/);
  assert.deepEqual(kbOf(musa), [`✅ Approve and send|approve:${row.requestId}`, `❌ Reject|reject:${row.requestId}`, '🏠 Back to menu|act:__back__']);
});

/* ── the second admin ────────────────────────────────────────────────── */

test('the admin who asked cannot approve it: nothing is sent, the request still waits', async () => {
  const { bot, row } = await asked();
  await controller.handleCallbackQuery(bot, cq(K, `approve:${row.requestId}`));
  assert.equal(docs(bot).length, 0);
  assert.equal((await releases()).length, 1, 'still pending');
  const alert = bot.callsTo('answerCallbackQuery').at(-1).args.opts;
  assert.match(alert.text, /You cannot approve your own request/);
});

test('a different named admin approves: the files go to BOTH and nobody else, the named admins are told, every message is on record', async () => {
  const { bot, row } = await asked();
  const ref = approvalCards.shortRequestRef(row.requestId);
  await controller.handleCallbackQuery(bot, cq(M, `approve:${row.requestId}`));

  const sent = docs(bot);
  assert.deepEqual(sent.map((d) => String(d.chatId)), [K, M], 'no database here: the workbook alone, once to each of the two');
  assert.match(sent[0].fileOptions.filename, /^afp-backup-\d{4}-\d{2}-\d{2}-workbook\.xlsx$/);
  assert.equal(typeof sent[1].doc, 'string', 'the second admin gets the same file, by its id');
  assert.equal(sent[0].opts.disable_notification, false);

  assert.equal((await releases()).length, 0);
  const done = await releases('approved');
  assert.equal(done.length, 1);
  assert.match(String(done[0].approver), /Musa/);

  for (const admin of [K, M]) {
    const notice = texts(bot, admin).find((t) => t.startsWith('💾 Backup released on demand'));
    assert.ok(notice, `admin ${admin} is told`);
    assert.match(notice, new RegExp(`^💾 Backup released on demand · ${ref}\\nAsked by Krishna · approved by Musa\\n\\d{2}-[A-Z][a-z]{2}-\\d{4} \\d{2}:\\d{2} · the files went to these two admins and to nobody else\\. Keep both files together\\.$`));
  }
  assert.equal(toChat(bot, O).length, 0, 'the admin who is not named hears nothing');
  assert.ok(texts(bot, M).some((t) => /approved by Musa.*\n💾 The backup is being built now\. The files go to the two admins who signed, and to nobody else\./s.test(t)));
  const audit = audits.find((a) => a.event === 'backup_released');
  assert.deepEqual([audit.payload.requestedBy, audit.payload.approvedBy, audit.payload.holders], [K, M, [K, M]]);
  assert.equal(offsiteBackup.sentInMemory()[0].messages.length, 2, 'both messages are on record for the clean-up');

  // the tile's record names the pair
  const after = createFakeBot();
  await controller.handleCallbackQuery(after, cq(K, 'act:backup'));
  assert.match(String(lastCard(after, K).args.text), /Last backup: .* · on demand · asked by Krishna, approved by Musa\nWorkbook: /);
  assert.deepEqual(kbOf(lastCard(after, K)), ['📤 Ask for a backup now|bkp:ask', '🗑 Delete the backup files already sent|bkp:del', '🏠 Back to menu|act:__back__']);
});

test('approved from the tile itself: the other admin\'s ✅ Approve and send is the same decision', async () => {
  const { bot, row } = await asked();
  await controller.handleCallbackQuery(bot, cq(M, 'act:backup'));
  assert.ok(kbOf(lastCard(bot, M)).includes(`✅ Approve and send|approve:${row.requestId}`));
  await controller.handleCallbackQuery(bot, cq(M, `approve:${row.requestId}`));
  assert.deepEqual(docs(bot).map((d) => String(d.chatId)), [K, M]);
  // a second tap on the old button finds it decided: nothing more is sent
  await controller.handleCallbackQuery(bot, cq(M, `approve:${row.requestId}`));
  assert.equal(docs(bot).length, 2);
});

test('rejected: nothing is sent to anyone', async () => {
  const { bot, row } = await asked();
  await controller.handleCallbackQuery(bot, cq(M, `reject:${row.requestId}`));
  // the reject path may ask for a typed reason first
  await controller.handleMessage(bot, { message_id: 9, text: 'not needed today', from: { id: Number(M) }, chat: { id: Number(M), type: 'private' } });
  assert.equal(docs(bot).length, 0);
  assert.equal((await releases()).length, 0, 'no longer waiting');
  assert.equal((await releases('rejected')).length, 1);
});

/* ── what cannot be done ─────────────────────────────────────────────── */

test('the retired one-tap button sends nothing', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(M, 'bkp:now'));
  assert.equal(docs(bot).length, 0);
  assert.equal((await releases()).length, 0);
  assert.equal(bot.callsTo('answerCallbackQuery').at(-1).args.opts.text, 'A backup is no longer sent on one tap.');
  assert.match(String(lastCard(bot, M).args.text), /🔐 A backup is no longer sent on one tap\.$/);
});

test('an employee cannot open the card or ask', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('4242', 'bkp:ask'));
  await controller.handleCallbackQuery(bot, cq('4242', 'bkp:now'));
  assert.equal(docs(bot).length, 0);
  assert.equal((await releases()).length, 0);
  assert.ok(bot.callsTo('answerCallbackQuery').every((c) => c.args.opts && c.args.opts.text === 'Admin only.'));
});

test('a role typed into the Users sheet is not an admin here — even when its id is typed into the holders cell', async () => {
  const realIsAdmin = auth.isAdmin;
  auth.isAdmin = (id) => String(id) === '4343' || realIsAdmin(id); // as a sheet-promoted admin reads
  settings = { OFFSITE_BACKUP_ENABLED: 1, OFFSITE_BACKUP_IDS: '777, 888, 4343' };
  try {
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cq('4343', 'act:backup'));
    assert.equal(String(lastCard(bot, '4343').args.text), '💾 Backup is admin-only.');
    await controller.handleCallbackQuery(bot, cq('4343', 'bkp:ask'));
    assert.equal((await releases()).length, 0);

    // …and they cannot be the second admin of someone else's request, nor a recipient
    const { bot: b2, row } = await asked();
    await controller.handleCallbackQuery(b2, cq('4343', `approve:${row.requestId}`));
    assert.equal(docs(b2).length, 0);
    assert.equal((await releases()).length, 1);
    assert.deepEqual(offsiteBackup.holders(await settingsRepository.getAll()).ignored, ['4343']);
  } finally { auth.isAdmin = realIsAdmin; }
});

test('the asker can never be the approver — at the card, and again inside the executor', async () => {
  const inventoryService = require(path.join(SRC, 'services/inventoryService'));
  const { bot, row } = await asked();
  // Musa leaves the bot's configuration; Krishna taps Approve on his own request
  config.access.adminIds = ['777'];
  await controller.handleCallbackQuery(bot, cq(K, `approve:${row.requestId}`));
  assert.equal(docs(bot).length, 0, 'a backup never goes to one admin alone');
  assert.equal((await releases()).length, 1, 'still waiting');

  // The queue's self-approval guard has one opening: a sole admin may approve
  // their own request. The executor closes it for a backup, whoever calls.
  config.access.adminIds = ['777', '888', '999'];
  const res = await inventoryService.executeApprovedAction(row.requestId, K);
  assert.deepEqual([res.ok, res.message], [false, 'A backup needs two different admins: the one who asked cannot be the one who approves.']);
  assert.equal((await releases()).length, 1, 'not marked approved');
  assert.equal((await releases('approved')).length, 0);
});

test('a queue row whose requester is not an admin is never released, however many admins sign it', async () => {
  const { bot, row } = await asked();
  // the sheet cell edited by hand to an employee's id
  const line = fake._store.get('ApprovalQueue').find((r) => r[0] === row.requestId);
  line[1] = '4242';
  await controller.handleCallbackQuery(bot, cq(M, `approve:${row.requestId}`));
  await controller.handleCallbackQuery(bot, cq(K, `approve:${row.requestId}`));
  assert.equal(docs(bot).length, 0);
  assert.equal((await releases('approved')).length, 0);
  assert.ok([...texts(bot, K), ...texts(bot, M)].some((t) => /only between two admins set in the bot's own configuration/.test(t)));
  assert.ok(!audits.some((a) => a.event === 'backup_released'));
});

test('a row forged so the asker can sign it still ends with TWO named admins holding the files, and both told', async () => {
  const { bot, row } = await asked();
  // Krishna, who can edit the sheet, rewrites the asker to Musa and approves "Musa's" request himself
  const line = fake._store.get('ApprovalQueue').find((r) => r[0] === row.requestId);
  line[1] = M;
  await controller.handleCallbackQuery(bot, cq(K, `approve:${row.requestId}`));
  assert.deepEqual(docs(bot).map((d) => String(d.chatId)).sort(), [K, M], 'Musa receives the files he never asked for');
  assert.ok(texts(bot, M).some((t) => /^💾 Backup released on demand · R-[A-Z0-9]{4}\nAsked by Musa · approved by Krishna/.test(t)), 'and is told, by name');
});

test('approved, but one of the two cannot be reached: nothing is sent to the other, and both are told', async () => {
  const { bot, row } = await asked();
  const act = bot.sendChatAction.bind(bot);
  bot.sendChatAction = async (chatId, ...rest) => { if (String(chatId) === K) throw new Error('bot was blocked by the user'); return act(chatId, ...rest); };
  await controller.handleCallbackQuery(bot, cq(M, `approve:${row.requestId}`));
  assert.equal(docs(bot).length, 0);
  assert.ok(texts(bot, M).some((t) => /was approved but could not be sent: the bot cannot reach 1 of the 2 admins .*\nNothing was sent to anyone\. Ask again from 📊 Reporting → 💾 Backup\./.test(t)));
  assert.ok(!audits.some((a) => a.event === 'backup_released'));
});

test('approved, but the build fails: nothing is sent, both are told, and a new ask is possible', async () => {
  const { bot, row } = await asked();
  sheets.readRangesRaw = async () => { throw new Error('Sheets is down'); };
  await controller.handleCallbackQuery(bot, cq(M, `approve:${row.requestId}`));
  assert.equal(docs(bot).length, 0);
  for (const admin of [K, M]) {
    assert.ok(texts(bot, admin).some((t) => /was approved but could not be sent: Sheets is down\.\nNothing was sent to anyone\./.test(t)), `admin ${admin}`);
  }
  sheets.readRangesRaw = realRead;
  approvalGate._internals.recent.clear();
  await controller.handleCallbackQuery(bot, cq(K, 'bkp:ask'));
  assert.equal((await releases()).length, 1, 'the earlier request was used up; a new one waits');
});
