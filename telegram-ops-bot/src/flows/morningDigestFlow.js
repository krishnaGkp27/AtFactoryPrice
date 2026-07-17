'use strict';

/**
 * MORN-1 — ⏰ Morning Digest settings screen (namespace rmd:).
 *
 * Admin-only, direct writes (owner's ask: a simple toggle screen; changes
 * are audit-logged). One row per category from morningDigest.CATEGORIES,
 * time chips, and a "send me a test now" button so the owner can see the
 * exact 09:15 message on demand.
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, chunk } = require('../utils/flowKit');
const auth = require('../middlewares/auth');
const settingsRepository = require('../repositories/settingsRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const morningDigest = require('../services/morningDigest');
const logger = require('../utils/logger');

const SESSION_TYPE = 'morning_digest_flow';
const NS = 'rmd:';
const TIME_CHIPS = ['08:30', '09:15', '10:00', '10:30'];

const render = makeRenderer({ parseMode: 'Markdown', requireSession: SESSION_TYPE });

async function showScreen(bot, chatId, userId) {
  const settings = await settingsRepository.getAll();
  const enabled = Number(settings.DIGEST_ENABLED ?? 1) === 1;
  const rows = [];
  rows.push([{ text: `${enabled ? '🟢 Digest ON' : '🔴 Digest OFF'} — tap to switch`, callback_data: `${NS}t:DIGEST_ENABLED` }]);
  rows.push(...chunk(morningDigest.CATEGORIES.map((c) => ({
    text: `${Number(settings[c.key]) === 1 ? '✅' : '⬜'} ${c.label}`,
    callback_data: `${NS}t:${c.key}`,
  })), 1));
  rows.push(TIME_CHIPS.map((t) => ({
    text: `${String(settings.DIGEST_TIME || '09:15') === t ? '🕘 ' : ''}${t}`,
    callback_data: `${NS}tm:${t.replace(':', '')}`,
  })));
  rows.push([{ text: '▶ Send me a test digest now', callback_data: `${NS}test` }]);
  rows.push([{ text: '🏠 Menu', callback_data: 'act:__back__' }]);
  await render(bot, chatId, userId,
    `⏰ *Morning Digest* — sent to all admins daily at *${settings.DIGEST_TIME || '09:15'}* (Nigeria time).\n\nTap a category to toggle it. Only ticked sections appear.`,
    rows);
}

async function start(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId, '🔒 Admin only.');
    return;
  }
  sessionStore.set(userId, { type: SESSION_TYPE, step: 'config', flowMessageId: messageId, startedAt: Date.now() });
  await showScreen(bot, chatId, userId);
}

const VALID_KEYS = new Set(['DIGEST_ENABLED', ...morningDigest.CATEGORIES.map((c) => c.key)]);

async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith(NS)) return false;
  const chatId = callbackQuery.message.chat.id;
  const userId = String(callbackQuery.from.id);
  await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
  if (!auth.isAdmin(userId)) return true;
  const rest = data.slice(NS.length);

  // MORN-1b — SESSION-FREE drill-down on the daily digest message itself:
  // rmd:d:<CATEGORY_KEY> swaps the message to that category's live detail;
  // rmd:d:__sum__ swaps back to the summary. Recomputed on every tap.
  if (rest.startsWith('d:')) {
    const key = rest.slice(2);
    const settings = await settingsRepository.getAll();
    const messageId = callbackQuery.message.message_id;
    try {
      if (key === '__sum__') {
        const { text, keyboard } = await morningDigest.buildSummary(settings);
        await bot.editMessageText(text || '_(empty digest)_', {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
          reply_markup: keyboard || undefined,
        });
      } else {
        const detail = await morningDigest.buildDetail(key, settings);
        if (!detail) return true;
        await bot.editMessageText(detail, {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '◀ Summary', callback_data: `${NS}d:__sum__` }]] },
        });
      }
    } catch (e) { logger.warn(`digest drill-down failed: ${e.message}`); }
    return true;
  }

  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'This card expired. Open ⏰ Morning Digest again.', show_alert: true }).catch(() => {});
    return true;
  }

  if (rest.startsWith('t:')) {
    const key = rest.slice(2);
    if (!VALID_KEYS.has(key)) return true;
    const settings = await settingsRepository.getAll();
    const next = Number(settings[key]) === 1 ? 0 : 1;
    await settingsRepository.set(key, next);
    await auditLogRepository.append('digest_config_changed', { key, value: next }, userId);
    await showScreen(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('tm:')) {
    const hhmm = rest.slice(3);
    if (!/^\d{4}$/.test(hhmm)) return true;
    const value = `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
    if (!TIME_CHIPS.includes(value)) return true;
    await settingsRepository.set('DIGEST_TIME', value);
    await auditLogRepository.append('digest_config_changed', { key: 'DIGEST_TIME', value }, userId);
    await showScreen(bot, chatId, userId);
    return true;
  }
  if (rest === 'test') {
    const settings = await settingsRepository.getAll();
    const { text, keyboard } = await morningDigest.buildSummary(settings);
    try {
      await bot.sendMessage(chatId, text || '_(Digest is empty — every category is off or has nothing to report.)_',
        { parse_mode: 'Markdown', ...(keyboard ? { reply_markup: keyboard } : {}) });
    } catch (e) { logger.warn(`digest test send failed: ${e.message}`); }
    return true;
  }
  return true;
}

module.exports = { SESSION_TYPE, start, handleCallback };
