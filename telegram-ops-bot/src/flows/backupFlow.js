'use strict';

/**
 * BKP-2 — 📊 Reporting → 💾 Backup (admin-only, session-free).
 *
 * The nightly backup needs no hand: this card only shows that it runs,
 * where it goes and when the last one went out, and lets an admin ask for
 * one now. "Send me a backup now" goes to the admin who tapped, in this
 * chat — it does not replace or count as the day's scheduled run.
 *
 * Callback namespace `bkp:` — `home` · `now`. Every tap re-checks admin.
 */

const auth = require('../middlewares/auth');
const offsiteBackup = require('../services/offsiteBackup');
const auditLogRepository = require('../repositories/auditLogRepository');
const { editOrSend } = require('../utils/telegramUI');
const fmtDate = require('../utils/formatDate');
const logger = require('../utils/logger');

const NS = 'bkp';
const TZ = 'Africa/Lagos';

const hh = (h) => `${String(h).padStart(2, '0')}:00`;
const n = (v) => Number(v || 0).toLocaleString('en-US');

/** "19-Nov-2026 02:00" in Lagos time, from an ISO instant. */
function when(iso) {
  const t = new Date(iso || '');
  if (Number.isNaN(t.getTime())) return '';
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(t);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
  return `${fmtDate(day)} ${time}`;
}

async function namesOf(ids) {
  const usersRepository = require('../repositories/usersRepository');
  const out = [];
  for (const id of ids) {
    let name = '';
    try { const u = await usersRepository.findByUserId(String(id)); name = (u && u.name) || ''; } catch (_) { /* the id below */ }
    out.push(name || (String(id).startsWith('-') ? `group ${id}` : `id ${id}`));
  }
  return out;
}

/** The card's text. Pure given a status. */
function cardText(st, names, note = '') {
  const lines = ['💾 *Backup*', ''];
  if (st.enabled) lines.push(`Runs every day at ${hh(st.hour)} and goes to: ${names.join(', ') || 'nobody'}.`);
  else lines.push('⚠️ The daily backup is switched OFF (Settings `OFFSITE_BACKUP_ENABLED`).');
  lines.push('Two files: the workbook, and the database records.');
  if (!st.database) lines.push('The database is not connected here, so only the workbook is sent.');
  lines.push('');
  const l = st.last;
  if (l && l.at) {
    const wb = l.workbook || {};
    lines.push(`Last backup: ${when(l.at)}${l.kind === 'manual' ? ' · sent by hand' : ''}`);
    lines.push(`Workbook: ${n(wb.tabs)} tabs · ${n(wb.rows)} rows · ${offsiteBackup.size(Number(wb.bytes) || 0)}`);
    if (l.data && !l.data.error) lines.push(`Database: ${n(l.data.tables)} tables · ${n(l.data.rows)} rows · ${offsiteBackup.size(Number(l.data.bytes) || 0)}`);
    if (l.data && l.data.error) lines.push('⚠️ The database part could not be read that time.');
    for (const w of (l.warnings || []).slice(0, 2)) lines.push(`⚠️ ${w}`);
  } else {
    lines.push('Last backup: none on record yet.');
  }
  if (note) { lines.push(''); lines.push(note); }
  return lines.join('\n');
}

async function home(bot, chatId, messageId, note = '') {
  const st = await offsiteBackup.status();
  const names = await namesOf(st.recipients);
  await editOrSend(bot, chatId, messageId, cardText(st, names, note), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '📤 Send me a backup now', callback_data: `${NS}:now` }],
      [{ text: '🏠 Back to menu', callback_data: 'act:__back__' }],
    ] },
  });
}

async function start(bot, chatId, userId, messageId = null) {
  if (!auth.isAdmin(userId)) {
    try { await bot.sendMessage(chatId, '💾 Backup is admin-only.'); } catch (_) { /* ignore */ }
    return;
  }
  await home(bot, chatId, messageId);
}

async function handleCallback(bot, callbackQuery) {
  const data = String(callbackQuery.data || '');
  if (!data.startsWith(`${NS}:`)) return false;
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id;
  const messageId = callbackQuery.message && callbackQuery.message.message_id;
  const answer = (text) => bot.answerCallbackQuery(callbackQuery.id, text ? { text } : undefined).catch(() => {});
  if (!auth.isAdmin(userId)) { await answer('Admin only.'); return true; }
  const rest = data.slice(NS.length + 1);

  if (rest === 'now') {
    await answer('Building the backup. The files arrive below in a moment.');
    const res = await offsiteBackup.run(bot, { toIds: [String(chatId)], kind: 'manual' });
    if (res.ok) {
      auditLogRepository.append('backup_sent_by_hand', { tabs: res.workbook && res.workbook.tabs }, userId).catch(() => {});
      await home(bot, chatId, null, '✅ Backup sent above. Keep both files together.');
    } else {
      logger.warn(`backupFlow: manual backup failed: ${res.message}`);
      await home(bot, chatId, null, res.busy
        ? '⏳ A backup is already being built. Try again in a minute.'
        : `⚠️ The backup could not be made: ${res.message}`);
    }
    return true;
  }
  await answer();
  await home(bot, chatId, messageId);
  return true;
}

module.exports = { NS, start, handleCallback, _internals: { cardText, when } };
