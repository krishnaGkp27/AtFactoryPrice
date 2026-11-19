'use strict';

/**
 * BKP-2 / BKP-3 / BKP-4 — 📊 Reporting → 💾 Backup (session-free).
 *
 * BKP-4 (owner, 19-Nov-2026: "I did not ask you to send the backup of the
 * sheet like this so easily … Can you delete it all? … disable this
 * function entirely for any other admin and give it a switch inside the
 * sheet itself.")
 *
 *   · The backup is OFF unless Settings `OFFSITE_BACKUP_ENABLED` says 1.
 *     Off = this card says so and offers nothing but the clean-up.
 *   · Nobody holds a backup unless NAMED in Settings `OFFSITE_BACKUP_IDS`
 *     (two or more admins). An admin who is not named sees no schedule, no
 *     request and no button to ask: the function does not exist for them.
 *   · 🗑 Delete the backup files already sent — takes the files of the last
 *     48 hours back out of every admin's chat (services/backupPurge). Any
 *     admin may do it: removing data is always the safe direction.
 *
 * BKP-3 — when it IS on, a backup on demand takes two of the named admins:
 * one asks (`bkp:ask`, a `release_backup` request through the approval
 * gate), a different one approves; the files go to those two.
 *
 * "Admin" on this tile means an id in the Railway ADMIN_IDS list. A role
 * typed into the Users sheet does not open it.
 *
 * Callback namespace `bkp:` — `home` · `ask` · `del` (asks first) ·
 * `delyes` (and the retired `now`, which sends nothing). Every tap
 * re-checks who is tapping.
 */

const offsiteBackup = require('../services/offsiteBackup');
const backupPurge = require('../services/backupPurge');
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

/** May this viewer use the function right now: the switch is on and they are a named holder. */
function isHolder(st, viewerId) {
  return Boolean(st.enabled) && (st.named || []).includes(String(viewerId));
}

/**
 * The card's text. Pure given a status.
 * @param {object} st offsiteBackup.status()
 * @param {string[]} names the people a backup goes to, by name
 * @param {{note?: string, holder?: boolean, purgeable?: boolean,
 *   open?: {who: string, age: string, ref: string, mine: boolean}, releasedBy?: string}} [o]
 */
function cardText(st, names, o = {}) {
  const lines = ['💾 *Backup*', ''];
  const tail = () => {
    if (o.purgeable) { lines.push(''); lines.push('🗑 Backup files sent in the last 48 hours can still be removed from the chats.'); }
    if (o.note) { lines.push(''); lines.push(o.note); }
    return lines.join('\n');
  };
  if (!st.enabled) {
    lines.push('🔴 Switched OFF. No backup is sent to anyone, daily or on demand.');
    lines.push('The switch is in the Settings sheet: `OFFSITE_BACKUP_ENABLED` (1 = on, 0 = off).');
    lines.push('Who may receive one is named there too: `OFFSITE_BACKUP_IDS` (two or more admin ids). Blank = nobody.');
    return tail();
  }
  if (!o.holder) {
    lines.push('The backup is not open to you.');
    return tail();
  }
  if (st.blocked) lines.push(`🟡 Switched on, but nothing is sent: ${st.blocked}.`);
  else lines.push(`Runs every day at ${hh(st.hour)} and goes to: ${names.join(', ') || 'nobody'}.`);
  lines.push('Two files: the workbook, and the database records.');
  lines.push('🔐 A backup never goes to one admin alone. One on demand is asked by one named admin and approved by another, and both receive it.');
  if ((st.ignored || []).length) {
    lines.push(`⚠️ Settings \`OFFSITE_BACKUP_IDS\` names ${st.ignored.length} chat${st.ignored.length === 1 ? '' : 's'} that ${st.ignored.length === 1 ? 'is' : 'are'} not an admin. Only admins receive a backup.`);
  }
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
      ? `⏳ You asked for a backup${o.open.age ? ` ${o.open.age} ago` : ''} · ${o.open.ref} · waiting on another named admin.`
      : `⏳ ${o.open.who} asks for a backup${o.open.age ? ` · ${o.open.age} ago` : ''} · ${o.open.ref}. Approving sends the files to you and to ${o.open.who}.`);
  }
  return tail();
}

/**
 * The card's buttons: ask or decide (named holders, switch on), and the
 * clean-up whenever there is something to remove.
 */
function keyboard(st, open, viewerId, o = {}) {
  const rows = [];
  if (isHolder(st, viewerId) && !st.blocked) {
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
    } else {
      rows.push([{ text: '📤 Ask for a backup now', callback_data: `${NS}:ask` }]);
    }
  }
  if (o.purgeable) rows.push([{ text: '🗑 Delete the backup files already sent', callback_data: `${NS}:del` }]);
  rows.push([{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]);
  return rows;
}

async function home(bot, chatId, messageId, viewerId, note = '') {
  const st = await offsiteBackup.status();
  const holder = isHolder(st, viewerId);
  const purgeable = await backupPurge.pending();
  const approvalCards = require('../services/approvalCards');
  let open = null;
  let o = { note, holder, purgeable };
  let names = [];
  if (holder) {
    names = await namesOf(st.recipients);
    open = st.blocked ? null : await openRelease();
    const rel = st.last && st.last.kind === 'manual' && st.last.release;
    o = {
      ...o,
      open: open ? {
        who: await nameOf(open.user), age: ago(open.createdAt), ref: approvalCards.shortRequestRef(open.requestId),
        mine: String(open.user) === String(viewerId),
      } : null,
      releasedBy: rel && rel.requestedBy ? `asked by ${await nameOf(rel.requestedBy)}, approved by ${await nameOf(rel.approvedBy)}` : '',
    };
  }
  await editOrSend(bot, chatId, messageId, cardText(st, names, o), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard(st, open, viewerId, { purgeable }) },
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
 * 📤 Ask for a backup now — raise the request a second named admin signs.
 * Sends no file. Returns the note the card then shows.
 */
async function ask(bot, userId) {
  const st = await offsiteBackup.status();
  if (!st.enabled) return '🔴 The backup is switched off in the Settings sheet. Nothing was asked and nothing was sent.';
  if (!isHolder(st, userId)) return 'The backup is not open to you. Nothing was asked.';
  if (st.blocked) return `🟡 Nothing can be sent: ${st.blocked}.`;
  const others = st.recipients.filter((id) => id !== String(userId));
  if (!others.length) return '🔐 A backup needs two named admins and you are the only one. Nothing was sent.';
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
  if (!raised.created) return '⏳ Already asked. Waiting on another named admin.';
  const ref = approvalCards.shortRequestRef(raised.requestId);
  let reached = 0;
  try {
    // BKP-4 — the card goes to the other NAMED admins only; an admin who is
    // not named has no part in a backup.
    const res = await require('../events/approvalEvents').notifyAdminsApprovalRequest(
      bot, raised.requestId, requesterName, approvalCards.buildBackupReleaseCard(raised.actionJSON), risk.reason, String(userId),
      { excludeIds: offsiteBackup.envAdmins().filter((id) => !others.includes(id)) },
    );
    reached = (res && res.sent) || 0;
  } catch (e) { logger.warn(`backupFlow: admin card for ${raised.requestId} failed: ${e.message}`); }
  if (!reached) {
    return `⚠️ Asked (${ref}), but the card reached no other named admin. They can approve it from 📊 Reporting → 💾 Backup or 🛂 Approvals.`;
  }
  return `✅ Asked · ${ref}. Sent to ${reached} named admin${reached === 1 ? '' : 's'} for approval. Nothing is sent until one of them approves; the files then arrive here and in their chat.`;
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
  // BKP-4 — the admins NAMED to hold a backup learn that one was handed out,
  // and to whom. Nobody else is part of it.
  const st = await offsiteBackup.status();
  await tell([...pair, ...(st.named || [])],
    `💾 Backup released on demand · ${ref}\nAsked by ${asked} · approved by ${approved}\n${when(new Date().toISOString())} · the files went to these two admins and to nobody else. Keep both files together.`);
  return res;
}

/** What a finished clean-up says on the card. Pure. */
function purgeNote(res, names = {}) {
  if (!res) return '⚠️ The clean-up could not be run. Try again in a minute.';
  if (res.busy) return '⏳ A clean-up is already running. Its result appears on that card.';
  if (!res.ok) return `⚠️ The clean-up stopped: ${res.message || 'unknown error'}. Tap again to continue.`;
  if (res.nothing) return '✅ Nothing to remove: no backup file was sent in the last 48 hours.';
  const per = Object.entries(res.perChat || {}).map(([id, k]) => `${names[id] || `id ${id}`} ${k}`).join(' · ');
  const lines = [res.deleted
    ? `🗑 ${res.deleted} backup file${res.deleted === 1 ? '' : 's'} removed from ${Object.keys(res.perChat).length} chat${Object.keys(res.perChat).length === 1 ? '' : 's'}${per ? `: ${per}` : ''}.`
    : '🗑 No backup file was found in the chats.'];
  if ((res.unreachable || []).length) lines.push(`⚠️ ${res.unreachable.length} chat${res.unreachable.length === 1 ? '' : 's'} could not be reached, so ${res.unreachable.length === 1 ? 'it was' : 'they were'} not checked.`);
  if (res.failed) lines.push(`⚠️ ${res.failed} file${res.failed === 1 ? '' : 's'} could not be deleted (Telegram refuses after 48 hours).`);
  if (res.leftovers) lines.push(`⚠️ ${res.leftovers} forwarded cop${res.leftovers === 1 ? 'y' : 'ies'} made while looking could not be removed. Delete ${res.leftovers === 1 ? 'it' : 'them'} by hand.`);
  if (!res.complete && !res.failed && !res.leftovers && !(res.unreachable || []).length) lines.push('⚠️ The look through the chats did not finish. Tap 🗑 again to continue.');
  lines.push('A file somebody already saved to their phone or forwarded elsewhere is not removed by this.');
  return lines.join('\n');
}

/** The clean-up in flight, for the tests to wait on. */
let _purging = null;

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
    await answer('A backup is no longer sent on one tap.');
    await home(bot, chatId, messageId, userId, '🔐 A backup is no longer sent on one tap.');
    return true;
  }
  if (rest === 'del') {
    await answer();
    await editOrSend(bot, chatId, messageId, [
      '🗑 *Delete the backup files already sent?*', '',
      'Every backup file the bot sent in the last 48 hours is removed from every admin\'s chat with the bot, yours included.',
      'While the bot looks for them, messages may flicker in each admin\'s chat for a minute or two.',
      'A file somebody already saved to their phone or forwarded elsewhere is not removed by this.',
    ].join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '🗑 Yes, delete them', callback_data: `${NS}:delyes` }],
        [{ text: '⬅ Back', callback_data: `${NS}:home` }],
      ] },
    });
    return true;
  }
  if (rest === 'delyes') {
    await answer('Removing the files…');
    await editOrSend(bot, chatId, messageId,
      '🧹 Removing the backup files from the chats. This card shows the result when it is done.', {
        reply_markup: { inline_keyboard: [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]] },
      });
    // Not awaited: looking through the chats takes minutes, and a tap that
    // waits that long is delivered again by Telegram.
    _purging = (async () => {
      let res = null;
      try { res = await backupPurge.run(bot, { byUserId: userId }); } catch (e) {
        logger.error(`backupFlow: clean-up failed: ${e.message}`);
      }
      const names = {};
      for (const id of Object.keys((res && res.perChat) || {})) names[id] = await nameOf(id);
      if (res && res.ok && !res.busy) {
        auditLogRepository.append('backup_files_deleted', { deleted: res.deleted, perChat: res.perChat, complete: res.complete }, userId).catch(() => {});
      }
      try { await home(bot, chatId, messageId, userId, purgeNote(res, names)); } catch (e) {
        logger.warn(`backupFlow: the clean-up result could not be shown: ${e.message}`);
      }
      return res;
    })();
    return true;
  }
  await answer();
  await home(bot, chatId, messageId, userId);
  return true;
}

module.exports = {
  NS, ACTION, start, handleCallback, releaseApproved,
  _internals: { cardText, keyboard, when, ago, ask, openRelease, purgeNote, isHolder, purging: () => _purging },
};
