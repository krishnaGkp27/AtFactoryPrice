/**
 * ATT-C2 — Attendance Admin hub.
 *
 * Sub-screens reachable from `/menu` → 🔧 Admin → 🗓 Attendance:
 *   • 👥 Required Users — toggleable multi-select from active users.
 *   • 📍 Locations      — add/remove items in ATTENDANCE_LOCATIONS.
 *   • ⏰ Reminder Time  — HH:MM
 *   • 🌙 Report Time    — HH:MM
 *   • 🕒 Cutoff Time    — HH:MM
 *   • 📅 Working Days   — toggleable Mon..Sun
 *   • 🌐 Timezone       — IANA string
 *   • 📊 Today's View   — live present-list + missing-list
 *   • ✍️ Mark on Behalf — pick user → pick location → markPresent(adminUserId)
 *
 * All settings persist to the `Settings` sheet through attendanceService.
 * Admin overrides (mark on behalf) hit the same `markPresent` path with
 * `adminUserId` set so audit trail and `logged_via=admin` flow naturally.
 *
 * Callback namespace: `atd_adm:*`. Free-text input is required only for
 * the three time/timezone screens; everything else is buttons.
 *
 * Session shape (when waiting for text):
 *   {
 *     type: 'attendance_admin_flow',
 *     step: 'await_time:reminder' | 'await_time:report' | 'await_time:cutoff'
 *         | 'await_tz' | 'await_location_new' | 'await_required_id'
 *         | 'await_behalf_picker' (no text expected — kept for symmetry)
 *         | null,
 *     flowMessageId,
 *     behalfTarget: { telegram_id, name } | null,
 *   }
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const auth = require('../middlewares/auth');
const usersRepo = require('../repositories/usersRepository');
const attendanceService = require('../services/attendanceService');
const logger = require('../utils/logger');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TZ_RE = /^[A-Za-z_/+\-0-9]{2,64}$/;
const WORK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------------------------------------------------------------------------
// Anchored render helper
// ---------------------------------------------------------------------------

async function render(bot, chatId, userId, text, keyboardRows) {
  const session = sessionStore.get(userId) || {};
  const reply_markup = { inline_keyboard: keyboardRows };
  if (session.flowMessageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: session.flowMessageId,
        parse_mode: 'Markdown', reply_markup, disable_web_page_preview: true,
      });
      return session.flowMessageId;
    } catch (_) {}
  }
  const sent = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown', reply_markup, disable_web_page_preview: true,
  });
  // Ensure we have a session row to remember the anchor.
  if (!sessionStore.get(userId)) {
    sessionStore.set(userId, {
      type: 'attendance_admin_flow', step: null, flowMessageId: sent.message_id,
      behalfTarget: null,
    });
  } else {
    const s = sessionStore.get(userId);
    s.flowMessageId = sent.message_id;
    sessionStore.set(userId, s);
  }
  return sent.message_id;
}

function homeRow() { return [{ text: '🏠 Back to menu', callback_data: 'menu:home' }]; }
function backRow() { return [{ text: '⬅ Back to Attendance', callback_data: 'atd_adm:home' }]; }
function rowOf(cells) { return cells; }

// ---------------------------------------------------------------------------
// Entry — top-level hub card
// ---------------------------------------------------------------------------

async function start(bot, chatId, userId, messageId = null) {
  if (!auth.isAdmin(userId)) {
    try { await bot.sendMessage(chatId, 'Admin only.'); } catch (_) {}
    return;
  }
  sessionStore.set(userId, {
    type: 'attendance_admin_flow', step: null,
    flowMessageId: messageId || null,
    behalfTarget: null,
  });
  await renderHub(bot, chatId, userId);
}

function fmtHHmm(iso, timezone) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'Africa/Lagos',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch (_) { return iso.slice(11, 16); }
}

async function buildTodayPanel(cfg) {
  // Returns markdown text for the embedded "Today's Status" panel at the
  // top of the admin hub card. Always concise; never throws.
  let usersAll = [];
  try { usersAll = await usersRepo.getAll(); } catch (_) {}
  const activeMap = new Map(
    usersAll
      .filter((u) => (u.status || 'active') === 'active' && u.user_id)
      .map((u) => [String(u.user_id), u]),
  );
  const reqValid = cfg.requiredUsers.filter((id) => activeMap.has(id));
  let todayDate = '';
  let todayRows = [];
  try {
    const got = await attendanceService.getTodayAll(cfg.timezone);
    todayDate = got.date;
    todayRows = got.rows;
  } catch (_) {}
  const loggedIds = new Set(todayRows.map((r) => r.telegram_id));
  const marked = reqValid.filter((id) => loggedIds.has(id));
  const missing = reqValid.filter((id) => !loggedIds.has(id));
  const presentLines = marked.length
    ? marked.map((id) => {
        const u = activeMap.get(id);
        const e = todayRows.find((r) => r.telegram_id === id);
        const loc = e ? e.location : '?';
        const t = e ? fmtHHmm(e.logged_at, cfg.timezone) : '';
        const via = e && e.logged_via === 'admin' ? ' _(via admin)_' : '';
        return `  ✅ ${(u && u.name) || id} — ${loc} · ${t}${via}`;
      }).join('\n')
    : '  _(no one yet)_';
  const missingLines = missing.length
    ? missing.map((id) => {
        const u = activeMap.get(id);
        return `  ⏳ ${(u && u.name) || id}`;
      }).join('\n')
    : '  _(everyone has logged)_';
  return {
    text:
      `📊 *Today — ${todayDate || '—'}*  ·  *${marked.length}/${reqValid.length}* marked\n\n`
      + `${presentLines}\n\n`
      + `*Not yet logged (${missing.length}):*\n${missingLines}`,
    counts: { marked: marked.length, required: reqValid.length, missing: missing.length },
  };
}

async function renderHub(bot, chatId, userId) {
  const cfg = await attendanceService.getConfig();
  const { active: reqActive, ghost } = await attendanceService.getRequiredUsersDetailed();
  const reqValidCount = reqActive.length;
  const locCount = cfg.locations.length;
  const wd = cfg.workingDays.join(', ');
  const todayPanel = await buildTodayPanel(cfg);

  const ghostHint = ghost.length
    ? `\n\n_⚠️ ${ghost.length} ghost ID(s) found in your required-users list; they auto-clean the next time you toggle._`
    : '';

  const text =
    `${todayPanel.text}\n\n`
    + '━━━━━━━━━━━━━━\n'
    + '🗓 *Attendance — Admin Hub*\n\n'
    + `*Required:* ${reqValidCount} active employees  ·  *Locations:* ${locCount}\n`
    + `*Times:* reminder ${cfg.reminderTime} · report ${cfg.reportTime} · cutoff ${cfg.cutoffTime}\n`
    + `*Timezone:* ${cfg.timezone}  ·  *Working days:* ${wd}${ghostHint}\n\n`
    + '_Tap a tile to manage._';

  await render(bot, chatId, userId, text, [
    [{ text: `👥 Required Users (${reqValidCount})`, callback_data: 'atd_adm:req' },
     { text: `📍 Locations (${locCount})`,            callback_data: 'atd_adm:loc' }],
    [{ text: `⏰ Reminder ${cfg.reminderTime}`,       callback_data: 'atd_adm:time:reminder' },
     { text: `🌙 Report ${cfg.reportTime}`,           callback_data: 'atd_adm:time:report' }],
    [{ text: `🕒 Cutoff ${cfg.cutoffTime}`,           callback_data: 'atd_adm:time:cutoff' },
     { text: `🌐 ${cfg.timezone}`,                    callback_data: 'atd_adm:tz' }],
    [{ text: '📅 Working Days',                       callback_data: 'atd_adm:days' }],
    [{ text: '📊 Today\'s Full View',                 callback_data: 'atd_adm:today' },
     { text: '✍️ Mark on Behalf',                    callback_data: 'atd_adm:behalf' }],
    [{ text: '🔁 Refresh',                            callback_data: 'atd_adm:home' }],
    homeRow(),
  ]);
}

// ---------------------------------------------------------------------------
// Required users picker (multi-select toggle)
// ---------------------------------------------------------------------------

async function renderRequiredPicker(bot, chatId, userId) {
  // Pull the active-user list AND the structured required-detail so we
  // can show clean counts that match reality (no more "7 / 3").
  let users = [];
  try { users = (await usersRepo.getAll()).filter((u) => (u.status || 'active') === 'active'); }
  catch (e) { logger.warn(`renderRequiredPicker: users read failed: ${e.message}`); }
  users.sort((a, b) => (a.name || a.user_id).localeCompare(b.name || b.user_id));

  const { active: reqActive, ghost } = await attendanceService.getRequiredUsersDetailed();
  const requiredSet = new Set(reqActive.map((r) => r.id));

  const rows = [];
  if (!users.length) {
    rows.push([{ text: '_No active users — add some via Add Employee_', callback_data: 'atd_adm:noop' }]);
  } else {
    for (const u of users) {
      const isOn = requiredSet.has(String(u.user_id));
      const label = `${isOn ? '✅' : '⬜'} ${u.name || u.user_id}`;
      rows.push([{ text: label, callback_data: `atd_adm:req_toggle:${u.user_id}` }]);
    }
  }
  rows.push([{ text: '🔘 Clear all', callback_data: 'atd_adm:req_clear' }]);
  rows.push(backRow());

  const ghostNote = ghost.length
    ? `\n\n_⚠️ ${ghost.length} ghost ID(s) detected in your settings (left over from old tests or deactivated users). They'll auto-clean when you next toggle anyone or tap Clear all._`
    : '';

  await render(bot, chatId, userId,
    `🗓 *Attendance — Required Users*\n\n`
    + `_Currently required:_ *${requiredSet.size}* of *${users.length}* active employees.${ghostNote}\n\n`
    + `Tap a name to toggle. Required employees see the 📍 Mark Attendance tile in their menu (reminders will land here once the scheduler is enabled).`,
    rows,
  );
}

async function toggleRequired(bot, chatId, userId, targetId) {
  // DEPLOY-C1 diagnostic: log every step of the toggle so future
  // "tap does nothing" reports can be triaged from Railway logs alone.
  // Use service-level setRequiredUsers so ghosts get dropped silently on
  // every save. The picker reflects the cleaned list on its next render.
  const tag = `[atd_adm.toggle uid=${userId} target=${targetId}]`;
  const t0 = Date.now();
  try {
    logger.info(`${tag} start`);
    const { active: reqActive } = await attendanceService.getRequiredUsersDetailed();
    const tBefore = Date.now() - t0;
    const set = new Set(reqActive.map((r) => r.id));
    const id = String(targetId);
    const wasOn = set.has(id);
    if (wasOn) set.delete(id); else set.add(id);
    logger.info(`${tag} loaded=${reqActive.length} wasOn=${wasOn} → newSize=${set.size} (read ${tBefore}ms)`);

    const saveResult = await attendanceService.setRequiredUsers(Array.from(set));
    const tSave = Date.now() - t0;
    logger.info(`${tag} saved=${saveResult.saved.length} droppedGhosts=${saveResult.dropped.length} (cum ${tSave}ms)`);

    await renderRequiredPicker(bot, chatId, userId);
    const tDone = Date.now() - t0;
    logger.info(`${tag} ok total=${tDone}ms`);
  } catch (e) {
    const tErr = Date.now() - t0;
    logger.error(`${tag} FAILED after ${tErr}ms: ${e && e.message ? e.message : e}\n${e && e.stack ? e.stack : ''}`);
    // Make the failure visible to the user instead of dying silently:
    try {
      await bot.answerCallbackQuery(undefined, { text: `Toggle failed: ${e.message || 'unknown error'}`, show_alert: true });
    } catch (_) {}
    try {
      await bot.sendMessage(chatId,
        `⚠️ *Couldn't toggle attendance requirement*\n\nReason: \`${e.message || 'unknown'}\`\n\nThe error has been logged. You can retry, or contact support.`,
        { parse_mode: 'Markdown' });
    } catch (_) {}
  }
}

async function clearRequired(bot, chatId, userId) {
  await attendanceService.setRequiredUsers([]);
  await renderRequiredPicker(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Locations editor
// ---------------------------------------------------------------------------

async function renderLocationsEditor(bot, chatId, userId) {
  const cfg = await attendanceService.getConfig();
  const rows = [];
  for (const loc of cfg.locations) {
    rows.push([
      { text: `📍 ${loc}`,            callback_data: 'atd_adm:noop' },
      { text: '🗑',                   callback_data: `atd_adm:loc_del:${encodeURIComponent(loc)}` },
    ]);
  }
  rows.push([{ text: '➕ Add location', callback_data: 'atd_adm:loc_add' }]);
  rows.push(backRow());
  await render(bot, chatId, userId,
    `🗓 *Attendance — Locations*\n\n`
    + `_Employees choose one of these when marking attendance._\n\n`
    + (cfg.locations.length ? '' : '_No locations yet. Tap ➕ to add the first one._'),
    rows,
  );
}

async function promptNewLocation(bot, chatId, userId) {
  const s = sessionStore.get(userId);
  s.step = 'await_location_new';
  sessionStore.set(userId, s);
  await render(bot, chatId, userId,
    `🗓 *Attendance — New Location*\n\n`
    + `Type the new location name (e.g. \`Kano Office\`, \`Idumota Store\`).\n\n`
    + `_Names should be 1–40 characters. Duplicates are silently ignored._`,
    [backRow()],
  );
}

async function applyNewLocation(bot, chatId, userId, raw) {
  const name = String(raw || '').trim().slice(0, 40);
  if (!name) {
    await render(bot, chatId, userId, '⚠️ Empty name — try again.', [backRow()]);
    return;
  }
  const cfg = await attendanceService.getConfig();
  if (cfg.locations.some((l) => l.toLowerCase() === name.toLowerCase())) {
    // Idempotent: show editor again with no change.
    const s = sessionStore.get(userId); s.step = null; sessionStore.set(userId, s);
    await renderLocationsEditor(bot, chatId, userId);
    return;
  }
  cfg.locations.push(name);
  await attendanceService.setConfigKey(attendanceService.KEYS.LOCATIONS, cfg.locations.join(','));
  const s = sessionStore.get(userId); s.step = null; sessionStore.set(userId, s);
  await renderLocationsEditor(bot, chatId, userId);
}

async function deleteLocation(bot, chatId, userId, name) {
  const cfg = await attendanceService.getConfig();
  const next = cfg.locations.filter((l) => l !== name);
  await attendanceService.setConfigKey(attendanceService.KEYS.LOCATIONS, next.join(','));
  await renderLocationsEditor(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Time / timezone setters (free text input)
// ---------------------------------------------------------------------------

const TIME_LABELS = {
  reminder: { key: 'ATTENDANCE_REMINDER_TIME', title: 'Reminder Time',
    hint: 'When required employees who haven\'t logged yet get their first DM nudge.' },
  report:   { key: 'ATTENDANCE_REPORT_TIME', title: 'Report Time',
    hint: 'When the daily summary card is sent to admins.' },
  cutoff:   { key: 'ATTENDANCE_CUTOFF_TIME', title: 'Cutoff Time',
    hint: 'After this, missing entries are auto-marked `not_logged` so the next morning\'s report is clean.' },
};

async function promptTime(bot, chatId, userId, which) {
  const meta = TIME_LABELS[which];
  if (!meta) return;
  const cfg = await attendanceService.getConfig();
  const current = which === 'reminder' ? cfg.reminderTime
    : which === 'report' ? cfg.reportTime
      : cfg.cutoffTime;
  const s = sessionStore.get(userId);
  s.step = `await_time:${which}`;
  sessionStore.set(userId, s);
  await render(bot, chatId, userId,
    `🗓 *${meta.title}*\n\n`
    + `Type the new time in 24-hour \`HH:MM\` format (e.g. \`09:00\`, \`22:30\`).\n\n`
    + `_Current:_ *${current}*\n_Hint:_ ${meta.hint}`,
    [backRow()],
  );
}

async function applyTime(bot, chatId, userId, which, raw) {
  const meta = TIME_LABELS[which];
  if (!meta) return;
  const cleaned = String(raw || '').trim();
  if (!TIME_RE.test(cleaned)) {
    await render(bot, chatId, userId,
      `⚠️ "${cleaned}" isn't a valid time. Use \`HH:MM\` 24-hour (e.g. \`09:00\`, \`22:30\`).`,
      [backRow()],
    );
    return;
  }
  await attendanceService.setConfigKey(meta.key, cleaned);
  const s = sessionStore.get(userId); s.step = null; sessionStore.set(userId, s);
  await renderHub(bot, chatId, userId);
}

async function promptTimezone(bot, chatId, userId) {
  const cfg = await attendanceService.getConfig();
  const s = sessionStore.get(userId);
  s.step = 'await_tz';
  sessionStore.set(userId, s);
  await render(bot, chatId, userId,
    `🗓 *Timezone*\n\n`
    + `Type the IANA timezone (e.g. \`Africa/Lagos\`, \`Asia/Karachi\`, \`Europe/London\`).\n\n`
    + `_Current:_ *${cfg.timezone}*\n\n`
    + `_If you pick an invalid one, attendance "today" math will silently fall back to UTC — pick carefully._`,
    [backRow()],
  );
}

async function applyTimezone(bot, chatId, userId, raw) {
  const tz = String(raw || '').trim();
  if (!TZ_RE.test(tz)) {
    await render(bot, chatId, userId,
      `⚠️ "${tz}" doesn't look like a valid timezone. Try \`Africa/Lagos\` shape.`,
      [backRow()],
    );
    return;
  }
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); }
  catch (_) {
    await render(bot, chatId, userId,
      `⚠️ "${tz}" was rejected by the timezone library. Pick another.`,
      [backRow()],
    );
    return;
  }
  await attendanceService.setConfigKey(attendanceService.KEYS.TIMEZONE, tz);
  const s = sessionStore.get(userId); s.step = null; sessionStore.set(userId, s);
  await renderHub(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Working days toggle
// ---------------------------------------------------------------------------

async function renderWorkingDays(bot, chatId, userId) {
  const cfg = await attendanceService.getConfig();
  const sel = new Set(cfg.workingDays.map((d) => d.toLowerCase()));
  const rows = [];
  const halves = [WORK_DAYS.slice(0, 4), WORK_DAYS.slice(4)];
  for (const row of halves) {
    rows.push(row.map((d) => ({
      text: `${sel.has(d.toLowerCase()) ? '✅' : '⬜'} ${d}`,
      callback_data: `atd_adm:day:${d}`,
    })));
  }
  rows.push(backRow());
  await render(bot, chatId, userId,
    `🗓 *Attendance — Working Days*\n\n`
    + `Tap each day to toggle. Days that are NOT in this list are treated as off — no reminders, no auto-not-logged rows.`,
    rows,
  );
}

async function toggleDay(bot, chatId, userId, day) {
  if (!WORK_DAYS.includes(day)) return;
  const cfg = await attendanceService.getConfig();
  const sel = new Set(cfg.workingDays);
  if (sel.has(day)) sel.delete(day); else sel.add(day);
  // Persist in canonical Mon..Sun order for readability.
  const ordered = WORK_DAYS.filter((d) => sel.has(d));
  await attendanceService.setConfigKey(attendanceService.KEYS.WORKING_DAYS, ordered.join(','));
  await renderWorkingDays(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Today's view (live)
// ---------------------------------------------------------------------------

async function renderToday(bot, chatId, userId) {
  // ATT-C2-LITE: use the ghost-aware detail so we only ever render rows
  // for real active users, and Present (X/Y) reflects intersected count.
  // Ghost IDs (smoke-test leftovers, deactivated users) are surfaced via
  // a banner + one-tap [🧹 Clean N ghost IDs now] button so the admin
  // can fix the settings without leaving the screen.
  const cfg = await attendanceService.getConfig();
  const { date, rows } = await attendanceService.getTodayAll(cfg.timezone);
  const loggedIds = new Set(rows.map((r) => r.telegram_id));
  const { active: reqActive, ghost } = await attendanceService.getRequiredUsersDetailed();

  const required = reqActive.map(({ id, user }) => ({ id, name: user.name || `User ${id.slice(-4)}` }));
  const present = required.filter((r) => loggedIds.has(r.id));
  const missing = required.filter((r) => !loggedIds.has(r.id));

  const fmtTime = (iso) => {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: cfg.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
    } catch (_) { return iso.slice(11, 16); }
  };

  const presentLines = present.length
    ? present.map((p) => {
        const e = rows.find((r) => r.telegram_id === p.id);
        const loc = e ? e.location : '?';
        const t = e ? fmtTime(e.logged_at) : '';
        const via = e && e.logged_via === 'admin' ? ' _(via admin)_' : '';
        return `  ✅ ${p.name} — ${loc} @ ${t}${via}`;
      }).join('\n')
    : '  _(no one yet)_';
  const missingLines = missing.length
    ? missing.map((m) => `  ⏳ ${m.name}`).join('\n')
    : '  _(everyone has logged)_';

  // Surface any ad-hoc logs from people who weren't on the required list
  // (e.g. admin marked someone on behalf who isn't required). Show them
  // under a separate section so they're not lost, but don't count them
  // toward Present (X/Y).
  let usersAll = [];
  try { usersAll = await usersRepo.getAll(); } catch (_) {}
  const usersById = new Map(usersAll.map((u) => [String(u.user_id), u]));
  const requiredSet = new Set(required.map((r) => r.id));
  const extras = rows.filter((r) => !requiredSet.has(r.telegram_id));
  const extrasLines = extras.length
    ? extras.map((e) => {
        const u = usersById.get(e.telegram_id);
        const name = (u && u.name) || `(unknown ${e.telegram_id.slice(-4)})`;
        return `  ✨ ${name} — ${e.location} @ ${fmtTime(e.logged_at)}`;
      }).join('\n')
    : '';

  const ghostBanner = ghost.length
    ? `\n\n⚠️ *${ghost.length} ghost ID(s)* in your Required-Users list don't match any active user. Tap below to clean them.`
    : '';

  const extrasSection = extras.length
    ? `\n\n*Also logged today (not on required list):*\n${extrasLines}`
    : '';

  const kb = [];
  if (ghost.length) {
    kb.push([{ text: `🧹 Clean ${ghost.length} ghost ID${ghost.length > 1 ? 's' : ''} now`, callback_data: 'atd_adm:clean_ghosts' }]);
  }
  kb.push([{ text: '🔁 Refresh', callback_data: 'atd_adm:today' }]);
  kb.push(backRow());

  await render(bot, chatId, userId,
    `📊 *Attendance — ${date}*\n\n`
    + `*Present (${present.length}/${required.length}):*\n${presentLines}\n\n`
    + `*Not yet logged (${missing.length}):*\n${missingLines}`
    + `${extrasSection}`
    + `${ghostBanner}\n\n`
    + `_Live view — refresh by re-opening._`,
    kb,
  );
}

async function cleanGhostsNow(bot, chatId, userId) {
  // One-tap purge: keep the active-only IDs, drop all ghosts in a single
  // setRequiredUsers() call (which emits an audit row). Then re-render
  // Today so the admin sees clean counts immediately.
  const { active } = await attendanceService.getRequiredUsersDetailed();
  await attendanceService.setRequiredUsers(active.map((r) => r.id));
  await renderToday(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Mark on Behalf
// ---------------------------------------------------------------------------

async function renderBehalfPickUser(bot, chatId, userId) {
  const cfg = await attendanceService.getConfig();
  const { rows: logged } = await attendanceService.getTodayAll(cfg.timezone);
  const loggedIds = new Set(logged.map((r) => r.telegram_id));
  let users = [];
  try { users = (await usersRepo.getAll()).filter((u) => (u.status || 'active') === 'active'); }
  catch (_) {}
  const candidates = users.filter((u) => cfg.requiredUsers.includes(String(u.user_id)) && !loggedIds.has(String(u.user_id)));
  candidates.sort((a, b) => (a.name || a.user_id).localeCompare(b.name || b.user_id));
  const rows = [];
  if (!candidates.length) {
    rows.push([{ text: '_Everyone required has already logged today_', callback_data: 'atd_adm:noop' }]);
  } else {
    for (const u of candidates) {
      rows.push([{ text: `👤 ${u.name || u.user_id}`, callback_data: `atd_adm:behalf_pick:${u.user_id}` }]);
    }
  }
  rows.push(backRow());
  await render(bot, chatId, userId,
    `✍️ *Mark on Behalf — Pick User*\n\n`
    + `Choose the user you want to mark present. Their entry will be logged as *via admin* (audited).`,
    rows,
  );
}

async function renderBehalfPickLocation(bot, chatId, userId) {
  const cfg = await attendanceService.getConfig();
  const s = sessionStore.get(userId);
  const target = s && s.behalfTarget;
  if (!target) { await renderBehalfPickUser(bot, chatId, userId); return; }
  const rows = [];
  for (let i = 0; i < cfg.locations.length; i += 2) {
    const a = cfg.locations[i], b = cfg.locations[i + 1];
    const row = [{ text: `📍 ${a}`, callback_data: `atd_adm:behalf_loc:${encodeURIComponent(a)}` }];
    if (b) row.push({ text: `📍 ${b}`, callback_data: `atd_adm:behalf_loc:${encodeURIComponent(b)}` });
    rows.push(row);
  }
  rows.push([{ text: '⬅ Pick another user', callback_data: 'atd_adm:behalf' }]);
  rows.push(backRow());
  await render(bot, chatId, userId,
    `✍️ *Mark on Behalf — Pick Location*\n\n`
    + `For: *${target.name}* (\`${target.telegram_id}\`)\n\n`
    + `_Logged as via_admin, audited._`,
    rows,
  );
}

async function applyBehalf(bot, chatId, userId, location) {
  const s = sessionStore.get(userId);
  const target = s && s.behalfTarget;
  if (!target) { await renderBehalfPickUser(bot, chatId, userId); return; }
  const result = await attendanceService.markPresent({
    telegramId: target.telegram_id,
    name: target.name,
    location,
    adminUserId: userId,
  });
  if (!result.ok) {
    await render(bot, chatId, userId,
      `⚠️ Could not mark ${target.name}: ${result.reason || 'unknown'}.`,
      [backRow()],
    );
    return;
  }
  s.behalfTarget = null;
  sessionStore.set(userId, s);
  await render(bot, chatId, userId,
    `✅ *Marked Present on Behalf*\n\n`
    + `*${target.name}* (\`${target.telegram_id}\`) — *${location}*\n`
    + `${result.alreadyLogged ? '_(They had already logged; no change.)_' : '_Logged + audit trail stamped._'}`,
    [
      [{ text: '✍️ Mark another', callback_data: 'atd_adm:behalf' }],
      backRow(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Text input dispatcher (free-text steps only)
// ---------------------------------------------------------------------------

async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const s = sessionStore.get(userId);
  if (!s || s.type !== 'attendance_admin_flow' || !s.step) return false;
  const chatId = msg.chat.id;
  const raw = (msg.text || '').trim();
  if (!raw) return false;
  if (s.step.startsWith('await_time:')) {
    const which = s.step.slice('await_time:'.length);
    await applyTime(bot, chatId, userId, which, raw);
    return true;
  }
  if (s.step === 'await_tz') {
    await applyTimezone(bot, chatId, userId, raw);
    return true;
  }
  if (s.step === 'await_location_new') {
    await applyNewLocation(bot, chatId, userId, raw);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Callback dispatcher — atd_adm:*
// ---------------------------------------------------------------------------

async function handleCallback(bot, query) {
  const userId = String(query.from.id);
  const data = query.data || '';
  if (!data.startsWith('atd_adm:')) return false;
  // DEPLOY-C1 diagnostic — log every atd_adm tap so we can correlate
  // user-reported "tap does nothing" with what the server actually saw.
  logger.info(`[atd_adm.dispatch uid=${userId}] data="${data}"`);
  if (!auth.isAdmin(userId)) {
    logger.warn(`[atd_adm.dispatch uid=${userId}] rejected: not admin`);
    await bot.answerCallbackQuery(query.id, { text: 'Admin only.', show_alert: true }).catch(() => {});
    return true;
  }
  const chatId = query.message.chat.id;
  await bot.answerCallbackQuery(query.id).catch(() => {});
  // Make sure we always have a session — if the user came in via menu
  // selection without a fresh start() call, seed one from the anchor.
  if (!sessionStore.get(userId)) {
    sessionStore.set(userId, {
      type: 'attendance_admin_flow', step: null,
      flowMessageId: query.message.message_id,
      behalfTarget: null,
    });
  }

  if (data === 'atd_adm:home')   { const s = sessionStore.get(userId); s.step = null; s.behalfTarget = null; sessionStore.set(userId, s); await renderHub(bot, chatId, userId); return true; }
  if (data === 'atd_adm:noop')   { return true; }
  if (data === 'atd_adm:req')    { await renderRequiredPicker(bot, chatId, userId); return true; }
  if (data === 'atd_adm:loc')    { await renderLocationsEditor(bot, chatId, userId); return true; }
  if (data === 'atd_adm:days')   { await renderWorkingDays(bot, chatId, userId); return true; }
  if (data === 'atd_adm:today')  { await renderToday(bot, chatId, userId); return true; }
  if (data === 'atd_adm:clean_ghosts') { await cleanGhostsNow(bot, chatId, userId); return true; }
  if (data === 'atd_adm:behalf') { const s = sessionStore.get(userId); s.behalfTarget = null; sessionStore.set(userId, s); await renderBehalfPickUser(bot, chatId, userId); return true; }
  if (data === 'atd_adm:tz')     { await promptTimezone(bot, chatId, userId); return true; }
  if (data === 'atd_adm:loc_add'){ await promptNewLocation(bot, chatId, userId); return true; }
  if (data === 'atd_adm:req_clear') { await clearRequired(bot, chatId, userId); return true; }

  if (data.startsWith('atd_adm:time:')) {
    const which = data.slice('atd_adm:time:'.length);
    await promptTime(bot, chatId, userId, which);
    return true;
  }
  if (data.startsWith('atd_adm:req_toggle:')) {
    const id = data.slice('atd_adm:req_toggle:'.length);
    await toggleRequired(bot, chatId, userId, id);
    return true;
  }
  if (data.startsWith('atd_adm:loc_del:')) {
    const name = decodeURIComponent(data.slice('atd_adm:loc_del:'.length));
    await deleteLocation(bot, chatId, userId, name);
    return true;
  }
  if (data.startsWith('atd_adm:day:')) {
    const d = data.slice('atd_adm:day:'.length);
    await toggleDay(bot, chatId, userId, d);
    return true;
  }
  if (data.startsWith('atd_adm:behalf_pick:')) {
    const id = data.slice('atd_adm:behalf_pick:'.length);
    let target = null;
    try {
      const u = await usersRepo.findByUserId(id);
      if (u) target = { telegram_id: String(u.user_id), name: u.name || String(u.user_id) };
    } catch (_) {}
    if (!target) target = { telegram_id: String(id), name: String(id) };
    const s = sessionStore.get(userId);
    s.behalfTarget = target;
    sessionStore.set(userId, s);
    await renderBehalfPickLocation(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('atd_adm:behalf_loc:')) {
    const loc = decodeURIComponent(data.slice('atd_adm:behalf_loc:'.length));
    await applyBehalf(bot, chatId, userId, loc);
    return true;
  }

  return false;
}

module.exports = {
  start,
  handleText,
  handleCallback,
  _internals: { TIME_RE, WORK_DAYS },
};
