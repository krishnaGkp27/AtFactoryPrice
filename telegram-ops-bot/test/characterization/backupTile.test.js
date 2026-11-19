'use strict';

/**
 * BKP-2 — 📊 Reporting → 💾 Backup, through the REAL controller: the tile is
 * registered in the Reporting hub, admins only; the card shows the schedule;
 * 📤 Send me a backup now delivers the files to the admin who tapped, in
 * that chat, and nobody else.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

const fake = createFakeSheets({
  Inventory: [['PackageNo', 'Yards'], ['1201', '30']],
  Users: [['user_id', 'name', 'role', 'branch', 'access_level', 'status'], ['777', 'Krishna', 'admin', '', '', 'active'], ['888', 'Musa', 'admin', '', '', 'active']],
});
installFakeSheets(fake);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const activityRegistry = require(path.join(SRC, 'services/activityRegistry'));
const offsiteBackup = require(path.join(SRC, 'services/offsiteBackup'));

// the backup's planned reads are not part of the harness's fake client
sheets.getSheetGrid = async () => [...fake._store.keys()].map((name) => ({ name, rows: 1000, cols: 26 }));
sheets.readRangesRaw = async (ranges) => ranges.map((r) => fake._store.get(r.replace(/^'|'$/g, '')) || []);
settingsRepository.getAll = async () => ({ ...settingsRepository.DEFAULTS });
auditLogRepository.append = async () => {};

const cq = (uid, data) => ({ id: `cq-${data}`, data, from: { id: Number(uid) }, message: { chat: { id: Number(uid) }, message_id: 77 } });
const cards = (bot) => bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
const lastText = (bot) => String(cards(bot).at(-1).args.text || '');
const lastKb = (bot) => cards(bot).at(-1).args.opts.reply_markup.inline_keyboard.flat().map((b) => `${b.text}|${b.callback_data}`);

test.beforeEach(() => offsiteBackup._internals._resetForTests());

test('the tile is 💾 Backup in the Reporting hub', () => {
  const a = activityRegistry.getActivity('backup');
  assert.ok(a);
  assert.deepEqual([a.label, a.icon, a.hub, a.callback], ['Backup', '💾', 'reporting', 'act:backup']);
});

test('an admin opens the card: schedule, recipients by name, no backup on record yet', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('777', 'act:backup'));
  assert.match(lastText(bot), /^💾 \*Backup\*\n\nRuns every day at 02:00 and goes to: Krishna, Musa\.\nTwo files: the workbook, and the database records\.\nThe database is not connected here, so only the workbook is sent\.\n\nLast backup: none on record yet\.$/);
  assert.deepEqual(lastKb(bot), ['📤 Send me a backup now|bkp:now', '🏠 Back to menu|act:__back__']);
});

test('📤 Send me a backup now: the workbook lands in the asking admin\'s chat only, then the card says so', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('888', 'act:backup'));
  await controller.handleCallbackQuery(bot, cq('888', 'bkp:now'));
  const sent = bot.callsTo('sendDocument').map((c) => c.args);
  assert.equal(sent.length, 1, 'no database here: the workbook alone');
  assert.equal(String(sent[0].chatId), '888');
  assert.match(sent[0].fileOptions.filename, /^afp-backup-\d{4}-\d{2}-\d{2}-workbook\.xlsx$/);
  assert.match(sent[0].opts.caption, /^💾 Backup · .* · workbook\n2 tabs · 5 rows · /);
  assert.match(lastText(bot), /Last backup: .* · sent by hand\nWorkbook: 2 tabs · 5 rows · .*\n\n✅ Backup sent above\. Keep both files together\.$/);
  assert.equal(bot.callsTo('answerCallbackQuery').at(-1).args.opts.text, 'Building the backup. The files arrive below in a moment.');
});

test('a failed build is said on the card; nothing is sent', async () => {
  const bot = createFakeBot();
  const realRead = sheets.readRangesRaw;
  sheets.readRangesRaw = async () => { throw new Error('Sheets is down'); };
  try {
    await controller.handleCallbackQuery(bot, cq('777', 'bkp:now'));
    assert.equal(bot.callsTo('sendDocument').length, 0);
    assert.match(lastText(bot), /⚠️ The backup could not be made: Sheets is down$/);
  } finally { sheets.readRangesRaw = realRead; }
});

test('an employee cannot open the card or ask for a backup', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('4242', 'bkp:now'));
  assert.equal(bot.callsTo('sendDocument').length, 0);
  assert.ok(bot.callsTo('answerCallbackQuery').some((c) => c.args.opts && c.args.opts.text === 'Admin only.'));
});
