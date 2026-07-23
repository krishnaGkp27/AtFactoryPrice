/**
 * ATT-C1/C4 — Employee-facing "Mark Attendance" flow.
 *
 * Anchored flow:
 *   1. Tap "📍 Mark Attendance"
 *   2. Pick a location from buttons (admin-managed list)
 *   3. (ATT-C4, when ATTENDANCE_VERIFY_MODE includes 'location') share the
 *      device position via Telegram's request_location button — checked
 *      against the location's GPS anchor (haversine ≤ radius)
 *   4. (when mode includes 'photo') send a fresh photo — same-day duplicate
 *      photos (sha256) are rejected
 *   5. ✅ Confirmation
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
 * Admins may always run the flow (testing / leading by example) even when
 * not in the reminder audience.
 */

'use strict';

const crypto = require('crypto');
const sessionStore = require('../utils/sessionStore');
const usersRepo = require('../repositories/usersRepository');
const attendanceService = require('../services/attendanceService');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');
const { isNotModified } = require('../utils/telegramUI');

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
    } catch (e) {
      // screen already correct — success, not a reason to send a new card
      if (isNotModified(e)) return session.flowMessageId;
      /* fall through to send fresh */
    }
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
    // ATT-C4b: GPS + selfie legitimately take longer than the default 5-min
    // session TTL (finding light, walking to the shop front). 15 minutes.
    ttlMs: 15 * 60 * 1000,
  });

  let cfg;
  try { cfg = await attendanceService.getConfig(); }
  catch (e) {
    logger.warn(`attendanceFlow.start: getConfig failed: ${e.message}`);
    cfg = { requiredUsers: [], locations: [], timezone: 'Africa/Lagos' };
  }

  // Gate: audience members (department members by default, ATT-C3) may
  // mark; admins may ALWAYS mark (testing / leading by example) even
  // though they are excluded from the reminder audience.
  let allowed = auth.isAdmin(userId);
  if (!allowed) {
    try { allowed = await attendanceService.isRequired(userId); } catch (_) { allowed = false; }
  }
  if (!allowed) {
    await render(bot, chatId, userId,
      '📍 *Mark Attendance*\n\n_Attendance logging is not enabled for your account._\n\n'
      + 'Attendance covers everyone with an assigned department — ask an admin '
      + 'to set your department (or add you from the Attendance settings).',
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
  const cfg = await attendanceService.getConfig();
  const session = sessionStore.get(userId) || { type: 'attendance_flow' };
  session.location = location;
  session.verification = {};

  // ATT-C4 — verification pipeline before the row is written.
  if (cfg.verifyMode === 'location' || cfg.verifyMode === 'location+photo') {
    session.step = 'await_gps';
    sessionStore.set(userId, session);
    const anchor = attendanceService.coordsFor(cfg, location);
    await render(bot, chatId, userId,
      `📍 *Mark Attendance — ${location}*\n\n`
      + `📡 *Step: share your position.*\n`
      + (anchor
        ? `You must be within *${anchor.radiusM} m* of ${location}.\n\n`
        : `_(No GPS anchor is set for ${location} yet — your position will be recorded as-is.)_\n\n`)
      + `Tap the *📡 Share my position* button that just appeared near your keyboard.`,
      [[{ text: '❌ Cancel', callback_data: 'atd:cancel' }]]);
    // request_location only works on a REPLY keyboard, not inline.
    await bot.sendMessage(chatId, '👇 Use this button (it reads your device GPS):', {
      reply_markup: {
        keyboard: [[{ text: '📡 Share my position', request_location: true }]],
        resize_keyboard: true, one_time_keyboard: true,
      },
    });
    return;
  }
  if (cfg.verifyMode === 'photo') {
    session.step = 'await_photo';
    sessionStore.set(userId, session);
    await promptPhoto(bot, chatId, userId, location);
    return;
  }
  await finalizeMark(bot, chatId, userId);
}

async function promptPhoto(bot, chatId, userId, location) {
  await render(bot, chatId, userId,
    `📍 *Mark Attendance — ${location}*\n\n`
    + `📷 *Step: send a photo taken right now* — yourself at the premises or the shop front.\n\n`
    + `_A photo already used today will be rejected — take a fresh one._`,
    [[{ text: '❌ Cancel', callback_data: 'atd:cancel' }]]);
}

/** Location share received (routed from the controller on msg.location). */
async function handleLocation(bot, msg) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'attendance_flow' || session.step !== 'await_gps') return false;
  const { latitude: lat, longitude: lng } = msg.location || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true;

  const cfg = await attendanceService.getConfig();
  const anchor = attendanceService.coordsFor(cfg, session.location);
  session.verification = session.verification || {};
  session.verification.geo = { lat, lng };
  if (anchor) {
    const dist = attendanceService.haversineM(lat, lng, anchor.lat, anchor.lng);
    session.verification.distanceM = dist;
    if (dist > anchor.radiusM) {
      sessionStore.set(userId, session);
      await bot.sendMessage(chatId, '📡 Position received.', { reply_markup: { remove_keyboard: true } });
      const km = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${dist} m`;
      await render(bot, chatId, userId,
        `📍 *Mark Attendance — ${session.location}*\n\n`
        + `🚫 You appear to be *${km}* away from ${session.location} (allowed: ${anchor.radiusM} m).\n\n`
        + `Move to the premises and share your position again, or pick the correct location.`,
        [[{ text: '🔁 Pick location again', callback_data: 'atd:retry' }], [{ text: '❌ Cancel', callback_data: 'atd:cancel' }]]);
      return true;
    }
  }
  sessionStore.set(userId, session);
  await bot.sendMessage(chatId, '📡 Position received ✅', { reply_markup: { remove_keyboard: true } });

  if (cfg.verifyMode === 'location+photo') {
    session.step = 'await_photo';
    sessionStore.set(userId, session);
    await promptPhoto(bot, chatId, userId, session.location);
    return true;
  }
  await finalizeMark(bot, chatId, userId);
  return true;
}

/** Check-in photo received (routed from the controller's file router). */
async function handleFile(bot, msg) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'attendance_flow' || session.step !== 'await_photo') return false;
  if (!msg.photo || !msg.photo.length) return false;
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  let hash = '';
  try {
    const { downloadTelegramFile } = require('../utils/telegramFiles');
    const { buffer } = await downloadTelegramFile(bot, fileId);
    hash = crypto.createHash('sha256').update(buffer).digest('hex');
  } catch (e) {
    logger.warn(`attendance photo hash failed: ${e.message}`);
  }

  // Same-day duplicate check — the cheap gallery-reuse deterrent: the same
  // image file cannot check in two people (or one person twice) in a day.
  try {
    if (hash) {
      const { rows } = await attendanceService.getTodayAll();
      if (rows.some((r) => r.photo_sha256 && r.photo_sha256 === hash)) {
        sessionStore.set(userId, session); // refresh the TTL clock for the retake
        await render(bot, chatId, userId,
          `📍 *Mark Attendance — ${session.location}*\n\n`
          + `🚫 That exact photo was already used for attendance today. Take a *fresh* photo now and send it.`,
          [[{ text: '❌ Cancel', callback_data: 'atd:cancel' }]]);
        return true;
      }
    }
    session.verification = session.verification || {};
    session.verification.photoFileId = fileId;
    session.verification.photoHash = hash;
    sessionStore.set(userId, session);
    await finalizeMark(bot, chatId, userId);
  } catch (e) {
    // A sheet hiccup here previously died silently in the webhook catch —
    // the user's selfie got no reply at all. Tell them and offer a retry.
    logger.error(`attendance photo mark failed: ${e.message}`);
    try {
      await render(bot, chatId, userId,
        `📍 *Mark Attendance — ${session.location}*\n\n`
        + '⚠️ Could not save your attendance just now — please try again.',
        [[{ text: '🔁 Try again', callback_data: 'atd:retry' },
          { text: '❌ Cancel', callback_data: 'atd:cancel' }]]);
    } catch (_) {}
  }
  return true;
}

async function finalizeMark(bot, chatId, userId) {
  const session = sessionStore.get(userId) || {};
  const location = session.location;
  let name = '';
  try {
    const u = await usersRepo.findByUserId(userId);
    if (u && u.name) name = u.name;
  } catch (_) {}
  const result = await attendanceService.markPresent({
    telegramId: userId, name, location,
    verification: session.verification || null,
  });
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
  const v = session.verification || {};
  let verifyLines = '';
  if (v.distanceM !== undefined && v.distanceM !== null) verifyLines += `📡 Position verified: ${v.distanceM} m from site\n`;
  else if (v.geo) verifyLines += `📡 Position recorded\n`;
  if (v.photoFileId) verifyLines += `📷 Photo attached\n`;
  await render(bot, chatId, userId,
    `📍 *Attendance Recorded*\n\n${verb} *Present*\n`
    + `Location: *${result.entry.location}*\n`
    + `At: ${t}\n${verifyLines}\n`
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
    const s = sessionStore.get(userId);
    if (s && s.step === 'await_gps') {
      // Clean up the reply keyboard the GPS step put up.
      try { await bot.sendMessage(chatId, 'Cancelled.', { reply_markup: { remove_keyboard: true } }); } catch (_) {}
    }
    sessionStore.clear(userId);
    // Let the controller's menu logic take over from here — we just edit
    // the anchored card to a polite "go home" prompt so the user isn't
    // stuck on a stale screen.
    try {
      await bot.editMessageText('_Cancelled — tap 🏠 Menu below (or send *menu*)._',
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]] } });
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
  handleLocation,
  handleFile,
};
