'use strict';

/**
 * sheetBackup — BKP-1 daily automated snapshot of the master Google Sheet.
 *
 * Once a day the bot copies the ENTIRE master spreadsheet (all tabs, all
 * formatting) into the backup Drive folder as `daily-backup__YYYY-MM-DD`,
 * then trashes copies older than the retention window. If anything breaks
 * during a day, yesterday's snapshot is one click away in Drive.
 *
 * Design notes:
 *   - Same mechanism as the manual `npm run snapshot` script
 *     (drive.files.copy with FULL drive scope — drive.file would only let
 *     the service account copy files it created itself, not the
 *     human-owned master sheet). The bot's other Drive use (photo archive)
 *     keeps its narrow drive.file scope; this client is separate.
 *   - Restart-safe + idempotent: before copying we check Drive for a file
 *     named `daily-backup__<today>`; a redeploy mid-day never duplicates.
 *   - Catch-up semantics: the scheduler fires on the first tick AFTER the
 *     configured hour, so a bot that was down at 01:00 UTC still backs up
 *     as soon as it's back.
 *   - Pruning only ever touches files matching our exact name pattern and
 *     uses trash (not hard delete) — recoverable for 30 more days.
 *   - Failures DM the admins (max once per day) and never crash the bot.
 *
 * Settings (Settings sheet rows override; defaults in settingsRepository):
 *   SHEET_BACKUP_ENABLED         1|0 (default 1)
 *   SHEET_BACKUP_HOUR_UTC        hour after which the daily run fires (default 1 = 02:00 Lagos)
 *   SHEET_BACKUP_RETENTION_DAYS  how many daily copies to keep (default 14)
 */

const config = require('../config');
const logger = require('../utils/logger');
const settingsRepository = require('../repositories/settingsRepository');

const NAME_PREFIX = 'daily-backup__';
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // cheap local check; real work runs once/day
// BKP-1b — transient failures retry after 4h, not on every 15-min tick.
const TRANSIENT_RETRY_MS = 4 * 60 * 60 * 1000;

let _drive = null;
let _timer = null;
let _lastSuccessDay = '';
let _lastFailNotifyDay = '';
let _quotaFailDay = '';
let _nextRetryAtMs = 0;

/**
 * BKP-1b — Google gives service accounts NO My-Drive storage, so a quota
 * error is STRUCTURAL: retrying the same day can never succeed. Detect it
 * so the scheduler attempts at most once per day instead of every tick
 * (the log/DM spam this caused ran 96×/day in production).
 */
function isQuotaError(message) {
  return /storage quota|quota (has been )?exceeded/i.test(String(message || ''));
}

/** Test hook — inject a stub Drive client. */
function _setDriveClient(stubOrReal) { _drive = stubOrReal; }

/** Test hook — reset module memory between test cases. */
function _resetForTests() {
  _lastSuccessDay = ''; _lastFailNotifyDay = ''; _drive = null;
  _quotaFailDay = ''; _nextRetryAtMs = 0;
}

async function getDriveClient() {
  if (_drive) return _drive;
  const { google } = require('googleapis');
  const creds = config.sheets.credentials;
  if (!creds) throw new Error('sheetBackup: no service-account credentials configured');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  _drive = google.drive({ version: 'v3', auth: await auth.getClient() });
  return _drive;
}

/** Same fallback chain as scripts/snapshot.js so both land in one folder. */
function resolveBackupFolderId() {
  return (
    process.env.BACKUP_GDRIVE_FOLDER_ID
    || config.drive.sourceFolderId
    || config.drive.folderId
    || ''
  );
}

/** UTC day label, e.g. '2026-07-07'. */
function dayLabel(d = new Date()) { return d.toISOString().slice(0, 10); }

/** Does `daily-backup__<label>` already exist (non-trashed) in the folder? */
async function backupExists(drive, folderId, label) {
  const name = `${NAME_PREFIX}${label}`;
  const scope = folderId ? `'${folderId}' in parents and ` : '';
  const res = await drive.files.list({
    q: `${scope}name='${name}' and trashed=false`,
    fields: 'files(id,name)',
  });
  return Boolean(res && res.data && res.data.files && res.data.files.length);
}

/**
 * Trash daily backups older than `retentionDays`. Only files whose name
 * matches `daily-backup__YYYY-MM-DD` exactly are considered — nothing else
 * in the folder (manual snapshots, photos) can ever be touched.
 * @returns {Promise<number>} how many copies were trashed
 */
async function pruneOldBackups(drive, folderId, retentionDays, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffLabel = dayLabel(cutoff);
  const scope = folderId ? `'${folderId}' in parents and ` : '';
  const res = await drive.files.list({
    q: `${scope}name contains '${NAME_PREFIX}' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: 200,
  });
  const files = (res && res.data && res.data.files) || [];
  let trashed = 0;
  for (const f of files) {
    const m = /^daily-backup__(\d{4}-\d{2}-\d{2})$/.exec(f.name || '');
    if (!m || m[1] >= cutoffLabel) continue;
    try {
      await drive.files.update({ fileId: f.id, requestBody: { trashed: true } });
      trashed += 1;
    } catch (e) {
      logger.warn(`sheetBackup: prune of ${f.name} failed: ${e.message}`);
    }
  }
  return trashed;
}

/**
 * Create today's snapshot (if it doesn't exist yet) and prune old ones.
 * Never throws — returns `{ok, skipped?, id?, link?, trashed?, message?}`.
 */
async function runDailyBackup({ now = new Date() } = {}) {
  try {
    const settings = await settingsRepository.getAll();
    if (!Number(settings.SHEET_BACKUP_ENABLED)) return { ok: true, skipped: 'disabled' };
    const sheetId = config.sheets.sheetId;
    if (!sheetId) return { ok: false, message: 'sheetBackup: GOOGLE_SHEET_ID not configured' };

    const drive = await getDriveClient();
    const folderId = resolveBackupFolderId();
    const label = dayLabel(now);

    if (await backupExists(drive, folderId, label)) {
      return { ok: true, skipped: 'exists', label };
    }

    const res = await drive.files.copy({
      fileId: sheetId,
      requestBody: {
        name: `${NAME_PREFIX}${label}`,
        parents: folderId ? [folderId] : undefined,
        description: `Automated daily backup of master sheet · ${now.toISOString()}`,
      },
      fields: 'id, name, webViewLink',
    });

    const retention = Number(settings.SHEET_BACKUP_RETENTION_DAYS) > 0
      ? Number(settings.SHEET_BACKUP_RETENTION_DAYS) : 14;
    const trashed = await pruneOldBackups(drive, folderId, retention, now);

    const link = (res.data && res.data.webViewLink)
      || (res.data && `https://docs.google.com/spreadsheets/d/${res.data.id}`) || '';
    logger.info(`sheetBackup: created ${NAME_PREFIX}${label} (${link}) · pruned ${trashed} old cop${trashed === 1 ? 'y' : 'ies'}`);
    return { ok: true, id: res.data && res.data.id, link, label, trashed };
  } catch (e) {
    logger.error(`sheetBackup: daily backup failed: ${e.message}`);
    return { ok: false, message: e.message };
  }
}

/** DM every admin about a failed backup — throttled to once per day. */
async function notifyFailure(bot, message, label) {
  if (_lastFailNotifyDay === label) return;
  _lastFailNotifyDay = label;
  const hint = isQuotaError(message)
    ? '_The service account has NO Drive storage — this cannot succeed by retrying. '
      + 'Fix: install the Apps Script backup (specs/BKP-1\\_EMIN\\_CHECKLIST.md, Task 1), '
      + 'then set `SHEET_BACKUP_ENABLED=0` in the Settings sheet (Task 2)._'
    : '_You can run it manually: `npm run snapshot`_';
  for (const adminId of config.access.adminIds) {
    try {
      await bot.sendMessage(adminId,
        `⚠️ *Daily sheet backup failed*\n${message}\n\n${hint}`,
        { parse_mode: 'Markdown' });
    } catch (_) { /* best-effort */ }
  }
}

/**
 * One scheduler tick. Fires the daily run on the first tick at/after the
 * configured UTC hour; in-memory day guard keeps subsequent ticks free
 * (the Drive existence check covers restarts).
 *
 * Failure pacing (BKP-1b):
 *   quota error     → at most ONE attempt per day (structural — see
 *                     isQuotaError); previously this retried every tick.
 *   any other error → next retry no sooner than TRANSIENT_RETRY_MS.
 */
async function tick(bot, now = new Date()) {
  const label = dayLabel(now);
  if (_lastSuccessDay === label) return;
  if (_quotaFailDay === label) return;
  if (now.getTime() < _nextRetryAtMs) return;
  let hour = 1;
  try {
    const settings = await settingsRepository.getAll();
    if (!Number(settings.SHEET_BACKUP_ENABLED)) return;
    hour = Number.isFinite(Number(settings.SHEET_BACKUP_HOUR_UTC))
      ? Number(settings.SHEET_BACKUP_HOUR_UTC) : 1;
  } catch (_) { /* settings unreadable — use defaults */ }
  if (now.getUTCHours() < hour) return;
  const res = await runDailyBackup({ now });
  if (res.ok) {
    _lastSuccessDay = label;
    _nextRetryAtMs = 0;
  } else {
    if (isQuotaError(res.message)) {
      _quotaFailDay = label;
    } else {
      _nextRetryAtMs = now.getTime() + TRANSIENT_RETRY_MS;
    }
    await notifyFailure(bot, res.message || 'unknown error', label);
  }
}

/**
 * Start the daily backup scheduler (call once from server.js).
 * The first tick runs immediately so a fresh deploy backs up today
 * without waiting for the next interval.
 */
function start(bot) {
  if (_timer) return;
  tick(bot).catch((e) => logger.warn(`sheetBackup: tick failed: ${e.message}`));
  _timer = setInterval(() => {
    tick(bot).catch((e) => logger.warn(`sheetBackup: tick failed: ${e.message}`));
  }, CHECK_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  logger.info('sheetBackup: daily snapshot scheduler started');
}

module.exports = {
  start,
  runDailyBackup,
  tick,
  NAME_PREFIX,
  _internals: {
    _setDriveClient,
    _resetForTests,
    resolveBackupFolderId,
    backupExists,
    pruneOldBackups,
    dayLabel,
    isQuotaError,
    TRANSIENT_RETRY_MS,
  },
};
