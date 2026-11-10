'use strict';

/**
 * AGT-1 — 📊 Reporting → 🤖 Agent Data Access (admin-only, session-free).
 *
 * Owner, 10-Nov-2026: "I want you to make an arrangement in such a way that
 * you can read the Railway logs as well as the database, if not directly,
 * then indirectly, such that these data can be utilised to make bot changes
 * and make it adaptive to the usage of the users going ahead."
 *
 * Two ways for the coding agent to read the usage records and the log:
 *
 *   🔑 a read-only key — minted here, shown ONCE, pasted into the secure
 *      form the agent shows. It opens GET /api/insights/* and nothing else.
 *      No Railway variable, no laptop.
 *   📤 the report file — the same reports as one JSON file, sent into this
 *      chat; the admin attaches it to the conversation with the agent. Needs
 *      no key at all.
 *
 * Callback namespace `agk:` — `home` · `new` · `off` · `offyes` · `file` ·
 * `del` (delete the key message). Every tap re-checks the admin gate.
 */

const auth = require('../middlewares/auth');
const config = require('../config');
const agentKeyService = require('../services/agentKeyService');
const insightsService = require('../services/insightsService');
const auditLogRepository = require('../repositories/auditLogRepository');
const { editOrSend, safeDelete } = require('../utils/telegramUI');
const fmtDate = require('../utils/formatDate');
const logger = require('../utils/logger');

const NS = 'agk';
const HEADER = 'X-Agent-Key';

function host() {
  try { return new URL(config.baseUrl).host; } catch (_) { return ''; }
}

function ago(ts) {
  const t = Date.parse(ts || '');
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

async function nameOf(userId) {
  try {
    const u = await require('../repositories/usersRepository').findByUserId(String(userId));
    return (u && u.name) || String(userId);
  } catch (_) { return String(userId); }
}

async function home(bot, chatId, messageId, note = '') {
  let st;
  try { st = await agentKeyService.status(); } catch (e) {
    logger.warn(`agentAccessFlow: status read failed: ${e.message}`);
    st = { enabled: true, live: null, unreadable: true };
  }
  const lines = ['🤖 *Agent Data Access*', ''];
  lines.push('Lets Claude read how the bot is used and what its log says.');
  lines.push('Read-only: it can change nothing.');
  lines.push('');
  const rows = [];
  if (!st.enabled) {
    lines.push('⚠️ The database is not connected on this deployment, so there is nothing to read.');
  } else if (st.unreadable) {
    lines.push('⚠️ The key record could not be read just now. Try again in a moment.');
    rows.push([{ text: '🔁 Try again', callback_data: `${NS}:home` }]);
  } else {
    if (st.live) {
      const made = st.live.created_at instanceof Date ? st.live.created_at.toISOString() : String(st.live.created_at || '');
      const day = fmtDate(made);
      lines.push(`🔑 Key: live since ${day}`);
      lines.push(`Created by ${st.live.created_name || st.live.created_by || 'an admin'}`);
      lines.push(st.live.last_used_at ? `Last read ${ago(st.live.last_used_at)}` : 'Not used yet');
      rows.push([{ text: '♻️ Replace key', callback_data: `${NS}:new` }, { text: '🚫 Switch off', callback_data: `${NS}:off` }]);
    } else {
      lines.push('🔑 Key: none yet');
      rows.push([{ text: '🔑 Create key', callback_data: `${NS}:new` }]);
    }
    rows.push([{ text: '📤 Send me the report file', callback_data: `${NS}:file` }]);
  }
  if (note) { lines.push(''); lines.push(note); }
  rows.push([{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]);
  await editOrSend(bot, chatId, messageId, lines.join('\n'),
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function start(bot, chatId, userId, messageId = null) {
  if (!auth.isAdmin(userId)) {
    try { await bot.sendMessage(chatId, '🤖 Agent Data Access is admin-only.'); } catch (_) { /* ignore */ }
    return;
  }
  await home(bot, chatId, messageId);
}

async function createKey(bot, chatId, userId, messageId) {
  let made;
  try {
    made = await agentKeyService.create({ byUserId: userId, byName: await nameOf(userId) });
  } catch (e) {
    logger.warn(`agentAccessFlow: key create failed: ${e.message}`);
    await home(bot, chatId, messageId, '⚠️ The key could not be created just now. Nothing changed.');
    return;
  }
  if (!made) { await home(bot, chatId, messageId); return; }
  auditLogRepository.append('agent_key_created', { host: host() }, String(userId)).catch(() => {});
  const h = host();
  const text = [
    '🔑 *Agent data key* · shown once',
    '',
    `\`${made.key}\``,
    '',
    'Tap the key to copy it.',
    'Paste it into the secure form Claude shows you. Never into the chat.',
    '',
    h ? `Host: \`${h}\`` : '',
    `Header: \`${HEADER}\``,
    '',
    'Any earlier key has stopped working.',
  ].filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');
  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🗑 Delete this message', callback_data: `${NS}:del` }]] },
  });
  await home(bot, chatId, messageId, '✅ New key created. It is in the message below.');
}

async function sendFile(bot, chatId, userId, messageId) {
  let digest;
  try { digest = await insightsService.digest({ days: 30 }); } catch (e) {
    logger.warn(`agentAccessFlow: digest failed: ${e.message}`);
    await home(bot, chatId, messageId, '⚠️ The report could not be built just now.');
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  const buffer = Buffer.from(JSON.stringify(digest, null, 1), 'utf8');
  await bot.sendDocument(chatId, buffer, {
    caption: '📤 Bot usage and log report · last 30 days\nAttach this file to your chat with Claude.',
  }, { filename: `bot-insights-${day}.json`, contentType: 'application/json' });
  auditLogRepository.append('agent_report_sent', { bytes: buffer.length }, String(userId)).catch(() => {});
  await home(bot, chatId, messageId, '✅ Report file sent below.');
}

async function handleCallback(bot, callbackQuery) {
  const data = String(callbackQuery.data || '');
  const userId = String(callbackQuery.from.id);
  const msg = callbackQuery.message || {};
  const chatId = msg.chat && msg.chat.id;
  const messageId = msg.message_id;
  const answer = (text) => bot.answerCallbackQuery(callbackQuery.id, text ? { text } : undefined).catch(() => {});
  if (!auth.isAdmin(userId)) { await answer('Admin only.'); return true; }
  const act = data.slice(NS.length + 1);

  if (act === 'del') {
    await answer('Deleted');
    await safeDelete(bot, chatId, messageId);
    return true;
  }
  if (act === 'home') { await answer(); await home(bot, chatId, messageId); return true; }
  if (act === 'new') { await answer(); await createKey(bot, chatId, userId, messageId); return true; }
  if (act === 'off') {
    await answer();
    await editOrSend(bot, chatId, messageId,
      '🚫 *Switch off agent access?*\n\nThe key stops working at once.\nYou can create a new one any time.',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '🚫 Yes, switch off', callback_data: `${NS}:offyes` }],
        [{ text: '⬅ Back', callback_data: `${NS}:home` }],
      ] } });
    return true;
  }
  if (act === 'offyes') {
    await answer();
    let n;
    try { n = await agentKeyService.revoke({ byUserId: userId }); } catch (e) {
      logger.warn(`agentAccessFlow: revoke failed: ${e.message}`);
      await home(bot, chatId, messageId, '⚠️ The key could not be switched off just now. It is still live.');
      return true;
    }
    if (n) auditLogRepository.append('agent_key_revoked', {}, userId).catch(() => {});
    await home(bot, chatId, messageId, '✅ Switched off. No key is live.');
    return true;
  }
  if (act === 'file') { await answer('Building the report…'); await sendFile(bot, chatId, userId, messageId); return true; }
  await answer();
  return true;
}

module.exports = { start, handleCallback, NS, HEADER };
