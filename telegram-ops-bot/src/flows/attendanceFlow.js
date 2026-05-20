/**
 * ATT-C1 — Employee-facing "Mark Attendance" flow.
 *
 * Single-screen anchored flow:
 *   1. Tap "📍 Mark Attendance"
 *   2. Pick a location from buttons (admin-managed list)
 *   3. ✅ Confirmation
 *
 * If the user already logged today, step 1 short-circuits to a "today's
 * mark" view (read-only — editing requires admin override).
 *
 * Callback namespace: `atd:*`
 *   atd:pick:<encodedLocation>   choose a location
 *   atd:cancel                    cancel back to menu
 *   atd:home                      back to main menu
 *
 * UX-C1: anchored card, single Cancel/Back option, never strands.
 * No text input — purely buttons.
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const usersRepo = require('../repositories/usersRepository');
const attendanceService = require('../services/attendanceService');
const logger = require('../utils/logger');

function fmtTime(iso, timezone) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'Africa/Lagos',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch (_) { return iso.slice(11, 16); }
}

async function render(bot, chatId, userId, text, keyboardRows) {
  const session = sessionStore.get(userId);
  const reply_markup = { inline_keyboard: keyboardRows };
  if (session && session.flowMessageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: session.flowMessageId,
        parse_mode: 'Markdown', reply_markup, disable_web_page_preview: true,
      });
      return session.flowMessageId;
    } catch (_) { /* fall through to send fresh */ }
  }
  const sent = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown', reply_markup, disable_web_page_preview: true,
  });
  if (session) {
    session.flowMessageId = sent.message_id;
    sessionStore.set(userId, session);
  }
  return sent.message_id;
}

function homeRow() { return [{ text: '🏠 Back to menu', callback_data: 'atd:home' }]; }

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * @param {object} bot
 * @param {number|string} chatId
 * @param {string} userId
 * @param {number|null} messageId  anchor for editing
 */
async function start(bot, chatId, userId, messageId = null) {
  // Always set the session so render() can anchor to messageId.
  sessionStore.set(userId, {
    type: 'attendance_flow',
    step: 'pick_location',
    flowMessageId: messageId || null,
    startedAt: new Date().toISOString(),
  });

  let cfg;
  try { cfg = await attendanceService.getConfig(); }
  catch (e) {
    logger.warn(`attendanceFlow.start: getConfig failed: ${e.message}`);
    cfg = { requiredUsers: [], locations: [], timezone: 'Africa/Lagos' };
  }

  // Gate: only required users may use this. Non-required taps still get
  // a polite message so admins testing the UI don't get a silent menu.
  if (!cfg.requiredUsers.includes(String(userId))) {
    await render(bot, chatId, userId,
      '📍 *Mark Attendance*\n\n_Attendance logging is not enabled for your account._\n\n'
      + 'Ask an admin to add you to the required-users list from the Attendance settings.',
      [homeRow()],
    );
    sessionStore.clear(userId);
    return;
  }

  // Already logged today? Short-circuit to a read-only "today's status" card.
  const existing = await attendanceService.getTodayEntry(userId, cfg.timezone);
  if (existing) {
    const t = fmtTime(existing.logged_at, cfg.timezone);
    const via = existing.logged_via === 'admin'
      ? `\n_Marked by admin._` : '';
    await render(bot, chatId, userId,
      `📍 *Today's Attendance*\n\n`
      + `✅ Already marked *Present*\n`
      + `Location: *${existing.location}*\n`
      + `At: ${t}\n${via}\n\n`
      + `_If this is wrong, ask an admin to override (audited)._`,
      [homeRow()],
    );
    sessionStore.clear(userId);
    return;
  }

  // No locations configured yet (admin hasn't seeded ATTENDANCE_LOCATIONS).
  if (!cfg.locations.length) {
    await render(bot, chatId, userId,
      '📍 *Mark Attendance*\n\n_No locations are configured yet._\n\n'
      + 'Ask an admin to set the location list from the Attendance settings.',
      [homeRow()],
    );
    sessionStore.clear(userId);
    return;
  }

  // Render the location picker. Pairs of buttons per row.
  const rows = [];
  for (let i = 0; i < cfg.locations.length; i += 2) {
    const a = cfg.locations[i];
    const b = cfg.locations[i + 1];
    const row = [{ text: `📍 ${a}`, callback_data: `atd:pick:${encodeURIComponent(a)}` }];
    if (b) row.push({ text: `📍 ${b}`, callback_data: `atd:pick:${encodeURIComponent(b)}` });
    rows.push(row);
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'atd:cancel' }]);

  await render(bot, chatId, userId,
    '📍 *Mark Attendance*\n\nWhere are you marking from today?\n\n_Tap one of the locations below._',
    rows,
  );
}

async function applyPick(bot, chatId, userId, location) {
  let name = '';
  try {
    const u = await usersRepo.findByUserId(userId);
    if (u && u.name) name = u.name;
  } catch (_) {}
  const result = await attendanceService.markPresent({ telegramId: userId, name, location });
  if (!result.ok) {
    let msg = '⚠️ Could not mark — ';
    if (result.reason === 'location_not_in_admin_list') {
      msg += 'that location was just removed from the list. Please try again.';
    } else if (result.reason === 'missing_location') {
      msg += 'no location selected.';
    } else if (result.reason === 'missing_telegram_id') {
      msg += 'could not identify your Telegram account.';
    } else {
      msg += `${result.reason || 'unknown'}.`;
    }
    await render(bot, chatId, userId, `📍 *Mark Attendance*\n\n${msg}`, [
      [{ text: '🔁 Try again', callback_data: 'atd:retry' }],
      homeRow(),
    ]);
    return;
  }
  const cfg = await attendanceService.getConfig();
  const t = fmtTime(result.entry.logged_at, cfg.timezone);
  const verb = result.alreadyLogged ? 'You had already marked' : '✅ Marked';
  await render(bot, chatId, userId,
    `📍 *Attendance Recorded*\n\n${verb} *Present*\n`
    + `Location: *${result.entry.location}*\n`
    + `At: ${t}\n\n`
    + `_Have a good day._`,
    [homeRow()],
  );
  sessionStore.clear(userId);
}

// ---------------------------------------------------------------------------
// Callback dispatcher — atd:*
// ---------------------------------------------------------------------------

async function handleCallback(bot, query) {
  const userId = String(query.from.id);
  const data = query.data || '';
  if (!data.startsWith('atd:')) return false;
  const chatId = query.message.chat.id;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === 'atd:home' || data === 'atd:cancel') {
    sessionStore.clear(userId);
    // Let the controller's menu logic take over from here — we just edit
    // the anchored card to a polite "go home" prompt so the user isn't
    // stuck on a stale screen.
    try {
      await bot.editMessageText('_Returning to menu — send /menu if it doesn\'t open automatically._',
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🏠 /menu', callback_data: 'menu:home' }]] } });
    } catch (_) {}
    return true;
  }

  if (data === 'atd:retry') {
    await start(bot, chatId, userId, query.message.message_id);
    return true;
  }

  if (data.startsWith('atd:pick:')) {
    const location = decodeURIComponent(data.slice('atd:pick:'.length));
    await applyPick(bot, chatId, userId, location);
    return true;
  }

  return false;
}

module.exports = {
  start,
  handleCallback,
};
