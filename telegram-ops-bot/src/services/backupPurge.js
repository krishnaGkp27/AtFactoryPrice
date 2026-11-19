'use strict';

/**
 * BKP-4 — take backup files back OUT of the chats.
 *
 * Owner, 19-Nov-2026, on the first nightly files sitting in every admin's
 * chat: "I can see the backup has already been sent to admins. Can you
 * delete it all?"
 *
 * Telegram lets a bot delete a message it sent for 48 HOURS, no longer, so
 * this covers that window and nothing older. Two ways to find a file:
 *
 *   1. RECORDED — since BKP-4 every file the backup job sends is written
 *      down with its chat and message id (`job_runs.detail.messages`).
 *      Those are deleted directly.
 *   2. LOOKED FOR — the files sent BEFORE that record existed (the first
 *      nightly run) have no id on record, and the Bot API has no "list my
 *      messages". The only way to read what a message id holds is to
 *      forward it: so the bot walks each chat's ids downward from the
 *      newest, forwards each one INTO THE SAME CHAT, reads the copy (is it
 *      an `afp-backup-…` file? when was the original sent?), deletes the
 *      copy at once, and deletes the original when it is a backup file. It
 *      stops once it is past the time of the oldest unrecorded backup.
 *      Nothing crosses from one chat to another.
 *
 * What it cannot do, and says: a file somebody already saved to their phone
 * or forwarded elsewhere is theirs; only the message is removed.
 *
 * Deleting is always the safe direction, so any ADMIN_IDS admin may start
 * it and no second admin is asked. Never throws.
 */

const logger = require('../utils/logger');
const offsiteBackup = require('./offsiteBackup');
const jobRuns = require('../repositories/jobRunsRepository');
const settingsRepository = require('../repositories/settingsRepository');

const JOB = offsiteBackup.JOB;
/** Telegram deletes a bot's message for 48 hours after it was sent. */
const WINDOW_MS = 48 * 3600 * 1000;
/** A run's files left the bot before its record was written. */
const MARGIN_MS = 30 * 60 * 1000;
/** Message ids looked at in one chat, at most. */
const MAX_SPAN = 6000;
const MAX_MS_PER_CHAT = 6 * 60 * 1000;
/**
 * Pauses between calls (ms): after an id that is not there, and after one
 * that was read. Kept under Telegram's pace (about 30 calls a second in
 * all, about one message a second into one chat); a 429 is waited out.
 */
const PACE = { miss: 50, hit: 700 };
const MAX_FLOOD_WAITS = 6;
/** Messages older than the target, in a row, before the walk stops (one old forward is not the end). */
const OLD_IN_A_ROW = 3;
/** The names offsiteBackup gives its files. */
const BACKUP_FILE = /^afp-backup-\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.(xlsx|ndjson\.gz)$/i;

let _running = false;
let _lastPurgeAt = 0;

/** Wait. A purge in flight keeps its timers: a clean-up is finished, not dropped. */
const pause = (ms) => (ms > 0 ? new Promise((resolve) => { setTimeout(resolve, ms); }) : Promise.resolve());

/** What Telegram said about a failed call. */
function errInfo(e) {
  const body = (e && e.response && e.response.body) || {};
  return {
    code: Number(body.error_code || (e && e.response && e.response.statusCode) || 0),
    retryAfter: Number((body.parameters && body.parameters.retry_after) || 0),
    text: String(body.description || (e && e.message) || ''),
  };
}

/** Run a call; when Telegram says "slow down" (429), wait as told and try again. */
async function withFlood(fn, sleep) {
  for (let i = 0; ; i += 1) {
    try { return await fn(); } catch (e) {
      const info = errInfo(e);
      if (info.code !== 429 || i >= MAX_FLOOD_WAITS) throw e;
      await sleep((Math.min(info.retryAfter || 1, 60) + 1) * 1000);
    }
  }
}

/** Delete one message. true = gone. */
async function del(bot, chatId, messageId, sleep) {
  try { await withFlood(() => bot.deleteMessage(chatId, messageId), sleep); return true; } catch (e) {
    logger.warn(`backupPurge: message ${messageId} in ${chatId} was not deleted: ${errInfo(e).text}`);
    return false;
  }
}

/** Is this message one of the backup's files? */
function isBackupMessage(msg) {
  return Boolean(msg && msg.document && BACKUP_FILE.test(String(msg.document.file_name || '')));
}

/**
 * When the ORIGINAL of a forwarded copy was sent (ms), but only when it can
 * be trusted: the original was sent by a bot (this one). A message a person
 * forwarded in carries the date of ITS source, which can be years old.
 * 0 = unknown.
 */
function botSentAt(fw) {
  const o = (fw && fw.forward_origin) || null;
  if (o && o.type === 'user' && o.sender_user && o.sender_user.is_bot) return Number(o.date || 0) * 1000;
  if (fw && fw.forward_from && fw.forward_from.is_bot) return Number(fw.forward_date || 0) * 1000;
  return 0;
}

/**
 * Walk one chat's message ids downward from `topId`, removing backup files.
 * @returns {Promise<{scanned: number, hits: number, deleted: number, failed: number, leftovers: number, stoppedBy: string}>}
 *   stoppedBy: 'date' (past the target time — complete) · 'start' (reached id 1 — complete)
 *              · 'cap' · 'time' · 'flood' (not complete)
 */
async function sweepChat(bot, chatId, { topId, sinceMs, sleep = pause, clock = Date.now } = {}) {
  const out = { scanned: 0, hits: 0, deleted: 0, failed: 0, leftovers: 0, stoppedBy: 'start' };
  const t0 = clock();
  let old = 0;
  for (let id = Number(topId) - 1; id > 0; id -= 1) {
    if (out.scanned >= MAX_SPAN) { out.stoppedBy = 'cap'; break; }
    if (clock() - t0 > MAX_MS_PER_CHAT) { out.stoppedBy = 'time'; break; }
    out.scanned += 1;
    let fw;
    try {
      fw = await withFlood(() => bot.forwardMessage(chatId, chatId, id, { disable_notification: true }), sleep);
    } catch (e) {
      if (errInfo(e).code === 429) { out.stoppedBy = 'flood'; break; }
      await sleep(PACE.miss); // no such message in this chat
      continue;
    }
    if (!fw || !fw.message_id) { await sleep(PACE.miss); continue; }
    out.hits += 1;
    // The copy goes first, whatever it is: it must never outlive the look.
    if (!(await del(bot, chatId, fw.message_id, sleep))) out.leftovers += 1;
    if (isBackupMessage(fw)) {
      if (await del(bot, chatId, id, sleep)) out.deleted += 1; else out.failed += 1;
    }
    const at = botSentAt(fw);
    if (at) old = at < sinceMs ? old + 1 : 0;
    if (old >= OLD_IN_A_ROW) { out.stoppedBy = 'date'; break; }
    await sleep(PACE.hit);
  }
  return out;
}

/**
 * What there is to remove: the recorded messages, and — when a run inside
 * the window has no record of its messages — the time to look back to.
 * @returns {Promise<{recorded: Array<{c: string, m: number}>, sinceMs: number|null, source: string}>}
 */
async function plan(nowMs = Date.now()) {
  const from = nowMs - WINDOW_MS;
  let rows;
  try { rows = await jobRuns.since(JOB, new Date(from)); } catch (e) {
    logger.warn(`backupPurge: the run records could not be read: ${e.message}`);
    rows = null;
  }
  if (rows === null) {
    // No database: what this process itself sent, and a look through
    // whatever of the window has not been looked through yet.
    const floor = Math.max(from, _lastPurgeAt);
    const mem = offsiteBackup.sentInMemory().filter((x) => x.at >= floor);
    return { recorded: mem.flatMap((x) => x.messages), sinceMs: floor, source: 'memory' };
  }
  const ms = (r) => new Date(r.created_at).getTime();
  const purgedAt = Math.max(0, ...rows.filter((r) => r.status === 'purged').map(ms));
  const runs = rows.filter((r) => ['ok', 'manual', 'failed'].includes(r.status) && ms(r) > purgedAt);
  const has = (r) => Boolean(r.detail && Array.isArray(r.detail.messages));
  const recorded = runs.filter(has).flatMap((r) => r.detail.messages);
  const blind = runs.filter((r) => !has(r));
  const sinceMs = blind.length ? Math.max(from, Math.min(...blind.map(ms)) - MARGIN_MS) : null;
  return { recorded, sinceMs, source: 'job_runs' };
}

/** Is there anything a purge could remove right now? Never throws. */
async function pending(nowMs = Date.now()) {
  try {
    const p = await plan(nowMs);
    if (p.source === 'memory') return p.recorded.length > 0;
    return p.recorded.length > 0 || p.sinceMs !== null;
  } catch (_) { return false; }
}

/** Every chat a backup may have gone to: the admins, and whatever the Settings cell named. */
async function chatsToSweep() {
  const settings = (await settingsRepository.getAll().catch(() => null)) || {};
  return [...new Set([...offsiteBackup.envAdmins(), ...offsiteBackup.typedIds(settings)])];
}

/**
 * Remove every backup file sent in the last 48 hours. Never throws.
 * @param {object} bot
 * @param {{byUserId?: string, now?: number, sleep?: Function, clock?: Function}} [o]
 * @returns {Promise<{ok: boolean, busy?: boolean, nothing?: boolean, deleted: number, failed: number,
 *   leftovers: number, complete: boolean, perChat: Object<string, number>, unreachable: string[], message?: string}>}
 */
async function run(bot, { byUserId = '', now = Date.now(), sleep = pause, clock = Date.now } = {}) {
  if (_running) return { ok: false, busy: true, deleted: 0, failed: 0, leftovers: 0, complete: false, perChat: {}, unreachable: [] };
  _running = true;
  const res = { ok: true, deleted: 0, failed: 0, leftovers: 0, complete: true, perChat: {}, unreachable: [] };
  const add = (chatId, k) => { if (k) res.perChat[String(chatId)] = (res.perChat[String(chatId)] || 0) + k; res.deleted += k; };
  try {
    const p = await plan(now);
    if (p.source === 'job_runs' && !p.recorded.length && p.sinceMs === null) return { ...res, nothing: true };
    // 1. the files whose message ids are on record
    for (const x of p.recorded) {
      if (await del(bot, x.c, x.m, sleep)) add(x.c, 1); else res.failed += 1;
    }
    // 2. the files sent before ids were recorded: looked for, chat by chat
    if (p.sinceMs !== null) {
      for (const chatId of await chatsToSweep()) {
        let note;
        try {
          note = await withFlood(() => bot.sendMessage(chatId,
            '🧹 Backup files are being removed from this chat. Messages may flicker here for a minute.',
            { disable_notification: true }), sleep);
        } catch (e) {
          res.unreachable.push(String(chatId));
          logger.warn(`backupPurge: chat ${chatId} could not be reached: ${errInfo(e).text}`);
          continue;
        }
        const r = await sweepChat(bot, chatId, { topId: note.message_id, sinceMs: p.sinceMs, sleep, clock });
        add(chatId, r.deleted);
        res.failed += r.failed;
        res.leftovers += r.leftovers;
        if (!['date', 'start'].includes(r.stoppedBy)) res.complete = false;
        logger.info(`backupPurge: chat ${chatId} — ${r.scanned} ids looked at, ${r.hits} messages read, ${r.deleted} backup file(s) removed, stopped by ${r.stoppedBy}`);
        if (r.deleted) {
          try {
            await bot.editMessageText(`🧹 ${r.deleted} backup file${r.deleted === 1 ? ' was' : 's were'} removed from this chat.`,
              { chat_id: chatId, message_id: note.message_id });
          } catch (_) { /* the note stays as it was */ }
        } else {
          await del(bot, chatId, note.message_id, sleep);
        }
      }
    }
    if (res.failed || res.leftovers || res.unreachable.length) res.complete = false;
    _lastPurgeAt = now;
    try {
      await jobRuns.record(JOB, new Date(now).toISOString().slice(0, 10), res.complete ? 'purged' : 'purge_partial',
        { by: String(byUserId), deleted: res.deleted, failed: res.failed, leftovers: res.leftovers, perChat: res.perChat, unreachable: res.unreachable });
    } catch (e) { logger.warn(`backupPurge: the purge could not be recorded: ${e.message}`); }
    logger.info(`backupPurge: ${res.deleted} backup file(s) removed from ${Object.keys(res.perChat).length} chat(s)${res.complete ? '' : ' — NOT complete'}`);
    return res;
  } catch (e) {
    logger.error(`backupPurge: failed: ${e.message}`);
    return { ...res, ok: false, complete: false, message: e.message };
  } finally {
    _running = false;
  }
}

function _resetForTests() { _running = false; _lastPurgeAt = 0; }

module.exports = {
  run, plan, pending, WINDOW_MS,
  _internals: {
    sweepChat, isBackupMessage, botSentAt, errInfo, withFlood, chatsToSweep,
    BACKUP_FILE, MAX_SPAN, MARGIN_MS, OLD_IN_A_ROW, PACE, _resetForTests,
  },
};
