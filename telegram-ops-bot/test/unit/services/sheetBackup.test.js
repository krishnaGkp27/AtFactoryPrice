'use strict';

/**
 * BKP-1 — daily sheet backup: copies the master spreadsheet once per day,
 * skips when today's copy already exists, prunes only its own old copies,
 * respects the enable/hour settings, and DMs admins on failure (throttled).
 * Drive + settings are stubbed; nothing real is touched.
 */

process.env.ADMIN_IDS = '777';
process.env.GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || 'SHEET-MASTER';

const test = require('node:test');
const assert = require('node:assert/strict');

const sheetBackup = require('../../../src/services/sheetBackup');
const settingsRepository = require('../../../src/repositories/settingsRepository');
const config = require('../../../src/config');

const { _setDriveClient, _resetForTests } = sheetBackup._internals;

// The service reads config.sheets.sheetId at call time — pin it for tests.
config.sheets.sheetId = 'SHEET-MASTER';

let settings;
settingsRepository.getAll = async () => settings;

/** Fresh in-memory Drive stub. `files` = pre-existing files in the folder. */
function stubDrive(files = []) {
  const state = {
    files: files.map((f, i) => ({ id: f.id || `f${i}`, name: f.name, trashed: false })),
    copies: [],
    updates: [],
  };
  const drive = {
    files: {
      list: async ({ q }) => {
        const nameEq = /name='([^']+)'/.exec(q);
        let out = state.files.filter((f) => !f.trashed);
        if (nameEq) out = out.filter((f) => f.name === nameEq[1]);
        return { data: { files: out.map((f) => ({ id: f.id, name: f.name })) } };
      },
      copy: async ({ fileId, requestBody }) => {
        state.copies.push({ fileId, name: requestBody.name });
        const created = { id: `copy-${state.copies.length}`, name: requestBody.name, trashed: false };
        state.files.push(created);
        return { data: { id: created.id, name: created.name, webViewLink: `https://docs/${created.id}` } };
      },
      update: async ({ fileId, requestBody }) => {
        state.updates.push({ fileId, ...requestBody });
        const f = state.files.find((x) => x.id === fileId);
        if (f && requestBody.trashed) f.trashed = true;
        return { data: {} };
      },
    },
  };
  return { drive, state };
}

function fakeBot() {
  const sent = [];
  return { sent, sendMessage: async (chatId, text) => { sent.push({ chatId, text }); } };
}

function fresh(files) {
  _resetForTests();
  settings = { SHEET_BACKUP_ENABLED: 1, SHEET_BACKUP_HOUR_UTC: 1, SHEET_BACKUP_RETENTION_DAYS: 14 };
  const { drive, state } = stubDrive(files);
  _setDriveClient(drive);
  return state;
}

const NOON = new Date('2026-07-07T12:00:00Z');

test('creates today\'s copy and reports the link', async () => {
  const state = fresh();
  const res = await sheetBackup.runDailyBackup({ now: NOON });
  assert.equal(res.ok, true);
  assert.equal(state.copies.length, 1);
  assert.equal(state.copies[0].fileId, 'SHEET-MASTER');
  assert.equal(state.copies[0].name, 'daily-backup__2026-07-07');
  assert.match(res.link, /^https:\/\/docs\//);
});

test('skips when today\'s backup already exists (restart-safe)', async () => {
  const state = fresh([{ name: 'daily-backup__2026-07-07' }]);
  const res = await sheetBackup.runDailyBackup({ now: NOON });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, 'exists');
  assert.equal(state.copies.length, 0, 'no duplicate copy');
});

test('prunes only its own copies older than retention; manual snapshots untouched', async () => {
  const state = fresh([
    { id: 'old', name: 'daily-backup__2026-06-01' },      // 36 days old → trash
    { id: 'keep', name: 'daily-backup__2026-07-01' },     // 6 days old → keep
    { id: 'manual', name: 'snapshot__2026-05-01_10-00__pre-test' }, // never touched
  ]);
  const res = await sheetBackup.runDailyBackup({ now: NOON });
  assert.equal(res.ok, true);
  assert.equal(res.trashed, 1);
  assert.ok(state.files.find((f) => f.id === 'old').trashed, 'old daily copy trashed');
  assert.ok(!state.files.find((f) => f.id === 'keep').trashed, 'recent copy kept');
  assert.ok(!state.files.find((f) => f.id === 'manual').trashed, 'manual snapshot untouched');
});

test('disabled via Settings → no Drive calls at all', async () => {
  const state = fresh();
  settings.SHEET_BACKUP_ENABLED = 0;
  const res = await sheetBackup.runDailyBackup({ now: NOON });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, 'disabled');
  assert.equal(state.copies.length, 0);
});

test('tick: waits for the configured hour, runs once, then stays quiet', async () => {
  const state = fresh();
  const bot = fakeBot();
  await sheetBackup.tick(bot, new Date('2026-07-07T00:30:00Z')); // before 01:00 UTC
  assert.equal(state.copies.length, 0, 'too early — nothing runs');
  await sheetBackup.tick(bot, new Date('2026-07-07T01:20:00Z')); // after the hour
  assert.equal(state.copies.length, 1, 'daily run fired');
  await sheetBackup.tick(bot, new Date('2026-07-07T05:00:00Z')); // later same day
  assert.equal(state.copies.length, 1, 'same day — no second copy');
  await sheetBackup.tick(bot, new Date('2026-07-08T01:20:00Z')); // next day
  assert.equal(state.copies.length, 2, 'next day backs up again');
  assert.equal(bot.sent.length, 0, 'no failure DMs on the happy path');
});

test('failure DMs admins once per day, then recovers next day', async () => {
  fresh();
  const bot = fakeBot();
  const boom = {
    files: {
      list: async () => { throw new Error('drive down'); },
      copy: async () => { throw new Error('drive down'); },
      update: async () => { throw new Error('drive down'); },
    },
  };
  _setDriveClient(boom);
  await sheetBackup.tick(bot, new Date('2026-07-07T02:00:00Z'));
  assert.equal(bot.sent.length, 1, 'admin DM sent');
  assert.match(bot.sent[0].text, /backup failed/i);
  await sheetBackup.tick(bot, new Date('2026-07-07T03:00:00Z'));
  assert.equal(bot.sent.length, 1, 'same-day failures throttled to one DM');
});
