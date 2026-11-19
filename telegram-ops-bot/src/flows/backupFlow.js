'use strict';

/**
 * BKP-2 / BKP-3 — 📊 Reporting → 💾 Backup (session-free).
 *
 * The nightly backup needs no hand: this card shows that it runs, who
 * receives it and when the last one went out.
 *
 * BKP-3 (owner, 19-Nov-2026: "This backup job should never be happening
 * alone to a single admin. It may cause risk to the company data, so make
 * it available only through two admins.") — a backup ON DEMAND is no longer
 * one tap. One admin ASKS (`bkp:ask`); that raises an ordinary
 * `release_backup` request through the approval gate; a DIFFERENT admin
 * approves it (their DM card, 🛂 Approvals, or this tile); the files then
 * go to those two admins and to nobody else, and every admin is told.
 *
 * "Admin" on this tile means an id in the Railway ADMIN_IDS list. A role
 * typed into the Users sheet does not open it.
 *
 * Callback namespace `bkp:` — `home` · `ask` (and the retired `now`, which
 * sends nothing). Every tap re-checks who is tapping.
 */

const offsiteBackup = require('../services/offsiteBackup');
const auditLogRepository = require('../repositories/auditLogRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const { editOrSend } = require('../utils/telegramUI');
const fmtDate = require('../utils/formatDate');
const logger = require('../utils/logger');

const NS = 'bkp';
const TZ = 'Africa/Lagos';
const ACTION = 'release_backup';

const hh = (h) => `${String(h).padStart(2, '0')}:00`;
const n = (v) => Number(v || 0).toLocaleString('en-US');

/** Only an id in Railway ADMIN_IDS — the list nobody can edit from a sheet. */
const isEnvAdmin = (id) => offsiteBackup.envAdmins().includes(String(id));

/** "19-Nov-2026 02:00" in Lagos time, from an ISO instant. */
function when(iso) {
  const t = new Date(iso || '');
  if (Number.isNaN(t.getTime())) return '';
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(t);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
  return `${fmtDate(day)} ${time}`;
}

/** "under 1h" · "5h" · "2d" since an instant. */
function ago(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const h = Math.floor((now - t) / 3600000);
  if (h < 1) return 'under 1h';
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

async function nameOf(id) {
  const usersRepository = require('../repositories/usersRepository');
  let name = '';
  try { const u = await usersRepository.findByUserId(String(id)); name = (u && u.name) || ''; } catch (_) { /* the id below */ }
  return name || `id ${id}`;
}

async function namesOf(ids) {
  const out = [];
  for (const id of ids) out.push(await nameOf(id));
  return out;
}

/** The backup request that is waiting for its second admin, or null. Never throws. */
async function openRelease() {
  try {
    const pending = await approvalQueueRepository.getAllPending();
    return (pending || []).find((r) => r && r.actionJSON && r.actionJSON.action === ACTION) || null;
  } catch (e) {
    logger.warn(`backupFlow: the open request could not be read: ${e.message}`);
    return null;
  }
}

/**
 * The card's text. Pure given a status.
 * @param {object} st offsiteBackup.status()
 * @param {string[]} names the daily recipients, by name
 * @param {{note?: string, open?: {who: string, age: string, ref: string, mine: boolean}, releasedBy?: string}} [o]
 */
function cardText(st, names, o = {}) {
  const lines = ['💾 *Backup*', ''];
  if (!st.enabled) lines.push('⚠️ The daily backup is switched OFF (Settings `OFFSITE_BACKUP_ENABLED`).');
  else if (st.blocked) lines.push(`🔐 The daily backup is NOT being sent: ${st.blocked}.`);
  else lines.push(`Runs every day at ${hh(st.hour)} and goes to: ${names.join(', ') || 'nobody'}.`);
  lines.push('Two files: the workbook, and the database records.');
  lines.push('🔐 A backup never goes to one admin alone. One on demand is asked by one admin and approved by another, and both receive it.');
  if ((st.ignored || []).length) {
    lines.push(`⚠️ Settings \`OFFSITE_BACKUP_IDS\` names ${st.ignored.length} chat${st.ignored.length === 1 ? '' : 's'} that ${st.ignored.length === 1 ? 'is' : 'are'} not an admin. Only admins receive a backup.`);
  }
  if (st.widened && !st.blocked) lines.push('⚠️ Settings `OFFSITE_BACKUP_IDS` names fewer than two admins, so every admin receives the backup.');
  if (!st.database) lines.push('The database is not connected here, so only the workbook is sent.');
  lines.push('');
  const l = st.last;
  if (l && l.at) {
    const wb = l.workbook || {};
    lines.push(`Last backup: ${when(l.at)}${l.kind === 'manual' ? ` · on demand${o.releasedBy ? ` · ${o.releasedBy}` : ''}` : ''}`);
    lines.push(`Workbook: ${n(wb.tabs)} tabs · ${n(wb.rows)} rows · ${offsiteBackup.size(Number(wb.bytes) || 0)}`);
    if (l.data && !l.data.error) lines.push(`Database: ${n(l.data.tables)} tables · ${n(l.data.rows)} rows · ${offsiteBackup.size(Number(l.data.bytes) || 0)}`);
    if (l.data && l.data.error) lines.push('⚠️ The database part could not be read that time.');
    for (const w of (l.warnings || []).slice(0, 2)) lines.push(`⚠️ ${w}`);
  } else {
    lines.push('Last backup: none on record yet.');
  }
  if (o.open) {
    lines.push('');
    lines.push(o.open.mine
      ? `⏳ You asked for a backup${o.open.age ? ` ${o.open.age} ago` : ''} · ${o.open.ref} · waiting on another admin.`
      : `⏳ ${o.open.who} asks for a backup${o.open.age ? ` · ${o.open.age} ago` : ''} · ${o.open.ref}. Approving sends the files to you and to ${o.open.who}.`);
  }
  if (o.note) { lines.push(''); lines.push(o.note); }
  return lines.join('\n');
}

/** The card's buttons: ask, or — while a request is open — what this viewer can do with it. */
function keyboard(st, open, viewerId) {
  const rows = [];
  if (open) {
    const id = String(open.requestId);
    if (String(open.user) === String(viewerId)) {
      rows.push(require('../services/approvalGate').receiptRow(id));
    } else {
      rows.push([
        { text: '✅ Approve and send', callback_data: `approve:${id}` },
        { text: '❌ Reject', callback_data: `reject:${id}` },
      ]);
    }
  } else if ((st.admins || 0) >= offsiteBackup.MIN_ADMINS) {
    rows.push([{ text: '📤 Ask for a backup now', callback_data: `${NS}:ask` }]);
  }
  rows.push([{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]);
  return rows;
}

async function home(bot, chatId, messageId, viewerId, note = '') {
  const st = await offsiteBackup.status();
  const names = await namesOf(st.recipients);
  const open = await openRelease();
  const approvalCards = require('../services/approvalCards');
  const rel = st.last && st.last.kind === 'manual' && st.last.release;
  const o = {
    note,
    open: open ? {
      who: await nameOf(open.user), age: ago(open.createdAt), ref: approvalCards.shortRequestRef(open.requestId),
      mine: String(open.user) === String(viewerId),
    } : null,
    releasedBy: rel && rel.requestedBy ? `asked by ${await nameOf(rel.requestedBy)}, approved by ${await nameOf(rel.approvedBy)}` : '',
  };
  await editOrSend(bot, chatId, messageId, cardText(st, names, o), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard(st, open, viewerId) },
  });
}

async function start(bot, chatId, userId, messageId = null) {
  if (!isEnvAdmin(userId)) {
    try { await bot.sendMessage(chatId, '💾 Backup is admin-only.'); } catch (_) { /* ignore */ }
    return;
  }
  await home(bot, chatId, messageId, userId);
}

/**
 * 📤 Ask for a backup now — raise the request a second admin signs.
 * Sends no file. Returns the note the card then shows.
 */
async function ask(bot, userId) {
  const others = offsiteBackup.envAdmins().filter((id) => id !== String(userId));
  if (!others.length) {
    return '🔐 A backup needs two admins and you are the only one set up. Nothing was sent.';
  }
  const approvalCards = require('../services/approvalCards');
  const requesterName = await nameOf(userId);
  const risk = await require('../risk/evaluate').evaluate({ action: ACTION, userId });
  // APG-1 — raised through the gate; one open backup request at a time
  // (the registry refuses a second while the first waits, whoever asks).
  const raised = await require('../services/approvalGate').raise({
    userId, action: ACTION,
    payload: { requester_name: requesterName },
    riskReason: risk.reason || 'two_admins_required',
    auditMeta: { what: 'backup on demand' },
  });
  if (!raised.ok) {
    return raised.refused === 'twin'
      ? '⏳ A backup request is already waiting for its second admin. It is shown below.'
      : '⚠️ The request could not be raised. Nothing was sent. Try again in a minute.';
  }
  if (!raised.created) return '⏳ Already asked. Waiting on another admin.';
  const ref = approvalCards.shortRequestRef(raised.requestId);
  let reached = 0;
  try {
    const res = await require('../events/approvalEvents').notifyAdminsApprovalRequest(
      bot, raised.requestId, requesterName, approvalCards.buildBackupReleaseCard(raised.actionJSON), risk.reason, String(userId),
    );
    reached = (res && res.sent) || 0;
  } catch (e) { logger.warn(`backupFlow: admin card for ${raised.requestId} failed: ${e.message}`); }
  if (!reached) {
    return `⚠️ Asked (${ref}), but the card reached no other admin. They can approve it from 📊 Reporting → 💾 Backup or 🛂 Approvals.`;
  }
  return `✅ Asked · ${ref}. Sent to ${reached} admin${reached === 1 ? '' : 's'} for approval. Nothing is sent until one of them approves; the files then arrive here and in their chat.`;
}

/**
 * BKP-3 — a second admin has approved: build and send, to the two who
 * signed. Called by approvalEvents after the request is marked approved.
 * Never throws; both admins are told when it cannot be made.
 * @param {object} bot
 * @param {{requestId: string, requestedBy: string, approvedBy: string}} release
 */
async function releaseApproved(bot, release) {
  const approvalCards = require('../services/approvalCards');
  const ref = approvalCards.shortRequestRef(release.requestId);
  const pair = [String(release.requestedBy), String(release.approvedBy)];
  const tell = async (ids, text) => {
    for (const id of [...new Set(ids)]) { try { await bot.sendMessage(id, text); } catch (_) { /* best-effort */ } }
  };
  const res = await offsiteBackup.run(bot, { kind: 'manual', release });
  if (!res.ok) {
    logger.warn(`backupFlow: release ${release.requestId} failed: ${res.message}`);
    await tell(pair, res.busy
      ? `⏳ Backup ${ref}: another backup is being built right now, so this one was not sent. Ask again in a few minutes from 📊 Reporting → 💾 Backup.`
      : `⚠️ Backup ${ref} was approved but could not be sent: ${res.message}.\nNothing was sent to anyone. Ask again from 📊 Reporting → 💾 Backup.`);
    return res;
  }
  const [asked, approved] = [await nameOf(pair[0]), await nameOf(pair[1])];
  auditLogRepository.append('backup_released', {
    requestId: release.requestId, requestedBy: pair[0], approvedBy: pair[1], tabs: res.workbook && res.workbook.tabs, holders: res.holders,
  }, pair[1]).catch(() => {});
  // Every admin learns that the company's data was handed out, and to whom.
  await tell(offsiteBackup.envAdmins(),
    `💾 Backup released on demand · ${ref}\nAsked by ${asked} · approved by ${approved}\n${when(new Date().toISOString())} · the files went to these two admins and to nobody else. Keep both files together.`);
  return res;
}

async function handleCallback(bot, callbackQuery) {
  const data = String(callbackQuery.data || '');
  if (!data.startsWith(`${NS}:`)) return false;
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id;
  const messageId = callbackQuery.message && callbackQuery.message.message_id;
  const answer = (text) => bot.answerCallbackQuery(callbackQuery.id, text ? { text } : undefined).catch(() => {});
  if (!isEnvAdmin(userId)) { await answer('Admin only.'); return true; }
  const rest = data.slice(NS.length + 1);

  if (rest === 'ask') {
    await answer();
    let note;
    try { note = await ask(bot, userId); } catch (e) {
      logger.error(`backupFlow: ask failed: ${e.message}`);
      note = '⚠️ The request could not be raised. Nothing was sent. Try again in a minute.';
    }
    await home(bot, chatId, messageId, userId, note);
    return true;
  }
  if (rest === 'now') {
    // The one-tap button of BKP-2, still sitting in old chats: it sends nothing.
    await answer('A backup now needs a second admin.');
    await home(bot, chatId, messageId, userId, '🔐 A backup is no longer sent on one tap. Tap 📤 Ask for a backup now, and another admin approves it.');
    return true;
  }
  await answer();
  await home(bot, chatId, messageId, userId);
  return true;
}

module.exports = { NS, ACTION, start, handleCallback, releaseApproved, _internals: { cardText, keyboard, when, ago, ask, openRelease } };
