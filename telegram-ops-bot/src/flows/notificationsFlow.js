/**
 * Notifications settings flow (T2).
 *
 * Renders the per-user opt-in/out screen for the Admin Activity Feed
 * and handles toggle taps. Persists to Users.notification_prefs via
 * usersRepository.setNotificationPref.
 *
 * Callback namespace: `nf:*`
 *   nf:open               — re-render the toggle screen
 *   nf:t:<eventType>      — flip the toggle for eventType (preserves others)
 *   nf:reset              — clear prefs (resume DEFAULT_POLICY)
 *
 * Visibility: admin-only. The controller routes `act:notifications`
 * here only if isAdmin(userId).
 */

'use strict';

const adminFeed = require('../services/adminFeed');
const usersRepo = require('../repositories/usersRepository');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');
const { editOrSend } = require('../utils/telegramUI');

function backRow() {
  return [
    { text: '⬅ Back to Admin', callback_data: 'act:__hub__:admin' },
    { text: '🏠 Menu',          callback_data: 'act:__back__' },
  ];
}

/**
 * Render the toggle screen, grouped by event group. Each event shows a
 * row with the label + an [ON]/[OFF] pill that flips it on tap.
 */
async function renderToggleScreen(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId)) {
    await editOrSend(bot, chatId, messageId,
      '🔒 Notifications settings are admin-only.',
      { reply_markup: { inline_keyboard: [backRow()] } });
    return;
  }

  let prefs = null;
  try {
    const u = await usersRepo.findByUserId(userId);
    prefs = u ? u.notification_prefs : null;
  } catch (e) {
    logger.warn(`notificationsFlow.render: prefs lookup failed: ${e.message}`);
  }

  const lines = ['⚙️ *Your Notifications*', ''];
  lines.push('_Tap any row to flip its state. Defaults preserve today\'s behavior — change them at your own pace._', '');

  const rows = [];
  const groups = adminFeed.listGroups();
  const eventTypes = adminFeed.listEventTypes();

  for (const g of groups) {
    const groupEvents = eventTypes
      .map((et) => adminFeed.getCatalogEntry(et))
      .filter((e) => e && e.group === g.id);
    if (!groupEvents.length) continue;

    lines.push(`${g.icon} *${g.label}*`);
    for (const ev of groupEvents) {
      const on = adminFeed.isEnabled(prefs, ev.eventType);
      const pill = on ? '🟢 ON ' : '⚪ OFF';
      lines.push(`   ${pill}  ${ev.label}`);
      rows.push([{
        text: `${pill}  ${truncate(ev.label, 38)}`,
        callback_data: `nf:t:${ev.eventType}`,
      }]);
    }
    lines.push('');
  }

  rows.push([{ text: '↺ Reset to defaults', callback_data: 'nf:reset' }]);
  rows.push(backRow());

  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function toggleEvent(bot, callbackQuery, eventType) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  if (!auth.isAdmin(userId)) return;
  const catalog = adminFeed.getCatalogEntry(eventType);
  if (!catalog) {
    await editOrSend(bot, chatId, messageId,
      `❌ Unknown event type: \`${eventType}\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [backRow()] } });
    return;
  }
  // Resolve current effective state (honors DEFAULT_POLICY when prefs absent).
  let current = null;
  try {
    const u = await usersRepo.findByUserId(userId);
    current = u ? u.notification_prefs : null;
  } catch (_) { /* default to null */ }
  const wasOn = adminFeed.isEnabled(current, eventType);
  const next = !wasOn;
  try {
    await usersRepo.setNotificationPref(userId, eventType, next);
  } catch (e) {
    logger.error(`notificationsFlow.toggle: ${e.message}`);
    await editOrSend(bot, chatId, messageId,
      `❌ Couldn't save the toggle: ${e.message}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [backRow()] } });
    return;
  }
  // Re-render the screen so the user sees the new state.
  await renderToggleScreen(bot, chatId, userId, messageId);
}

async function resetToDefaults(bot, callbackQuery) {
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  if (!auth.isAdmin(userId)) return;
  try {
    await usersRepo.updateNotificationPrefs(userId, null);
  } catch (e) {
    logger.error(`notificationsFlow.reset: ${e.message}`);
  }
  await renderToggleScreen(bot, chatId, userId, messageId);
}

/** Single callback entry point used by telegramController.  */
async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('nf:')) return false;
  try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) { /* noop */ }
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  if (data === 'nf:open') {
    await renderToggleScreen(bot, chatId, userId, messageId);
    return true;
  }
  if (data === 'nf:reset') {
    await resetToDefaults(bot, callbackQuery);
    return true;
  }
  if (data.startsWith('nf:t:')) {
    await toggleEvent(bot, callbackQuery, data.slice('nf:t:'.length));
    return true;
  }
  return false;
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

module.exports = {
  renderToggleScreen,
  handleCallback,
};
