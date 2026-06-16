/**
 * USR-C3 — Standalone "Add Employee" flow.
 *
 * 6-step anchored flow that submits an `add_user` action to the dual-admin
 * approval queue. On approval, the new user is appended to the `Users`
 * sheet, attached to their department, and (if they were already sitting
 * in `PendingUsers`) marked onboarded. The auth cache is invalidated
 * so the new person can use the bot the moment approval lands.
 *
 * Steps:
 *   1. telegram_id   — numeric input, validated (6–12 digits, not already a user)
 *   2. name          — 1–80 char text input
 *   3. department    — picker from existing OR ➕ create new
 *   4. warehouses    — multi-select checkboxes (Inventory ∪ WAREHOUSE_LIST)
 *   5. role          — employee | manager   (admin reserved for USR-C3b)
 *   6. confirm       — full summary + submit
 *
 * Session shape:
 *   {
 *     type: 'user_add_flow',
 *     step: 'telegram_id' | 'name' | 'department' | 'new_department' |
 *           'warehouses' | 'role' | 'confirm',
 *     flowMessageId: number | null,
 *     data: {
 *       telegram_id, name, department, warehouses[], role,
 *       prefillSource: 'pending_user' | 'admin' | null,
 *     },
 *   }
 *
 * Callback namespace: `usr:*` — start | text | next | back | cancel |
 *                               dept:* | wh:* | role:* | submit | confirm
 *
 * UX-C1 standards: anchored card, back/cancel everywhere, renderError().
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const auth = require('../middlewares/auth');
const departmentsRepo = require('../repositories/departmentsRepository');
const usersRepo = require('../repositories/usersRepository');
const pendingUsersRepo = require('../repositories/pendingUsersRepository');
const warehouseFlow = require('./warehouseFlow');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const approvalEvents = require('../events/approvalEvents');
const riskEvaluate = require('../risk/evaluate');
const idGenerator = require('../utils/idGenerator');
const logger = require('../utils/logger');

const MIN_TG_DIGITS = 6;
const MAX_TG_DIGITS = 12;
const MAX_NAME_LEN = 80;
const TG_RE = /^[0-9]{6,12}$/;
const PENDING_PAGE_SIZE = 8;            // pending-user tiles per page (2-col × 4 rows)
const PENDING_NAME_MAX = 18;            // truncate long names to keep tiles tidy
const FLOW_TTL_MS = 30 * 60 * 1000;     // 30 min — onboarding may pause for dept/role lookup

/**
 * Escape Telegram Markdown-v1 reserved characters in user-supplied values so a
 * stray "_", "*", "`" or "[" in a name/dept/warehouse cannot break entity
 * parsing on the Confirm card and silently bury the flow at Step 5/6.
 */
function mdEscape(s) {
  return String(s == null ? '' : s).replace(/([_*`\[\]])/g, '\\$1');
}

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

/** Compact "Nm/Nh/Nd" age from an ISO timestamp; '' when unparseable. */
function timeAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(1, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

/** Display name for a PendingUsers row: full name → @username → bare id. */
function pendingDisplayName(pu) {
  const nm = [pu.first_name, pu.last_name].filter(Boolean).join(' ').trim();
  if (nm) return nm;
  if (pu.username) return `@${pu.username}`;
  return String(pu.telegram_id || '');
}

/**
 * Pending people still awaiting onboarding, newest first, with anyone who is
 * already an active user removed (covers races where they got onboarded
 * through another path). Pure data — safe to unit-test offline.
 */
async function loadPendingCandidates() {
  let pendings = [];
  try { pendings = await pendingUsersRepo.getAll(); } catch (_) { pendings = []; }
  pendings = pendings.filter((p) => p && p.telegram_id && (p.status || 'pending') === 'pending');
  let activeIds = new Set();
  try {
    const users = await usersRepo.getAll();
    activeIds = new Set(
      users.filter((u) => (u.status || 'active') === 'active').map((u) => String(u.user_id)),
    );
  } catch (_) { /* no users sheet yet → treat none as active */ }
  return pendings
    .filter((p) => !activeIds.has(String(p.telegram_id)))
    .sort((a, b) => (b.arrived_at || '').localeCompare(a.arrived_at || ''));
}

// ---------------------------------------------------------------------------
// Anchored rendering — single card edited in place to avoid stranding.
// ---------------------------------------------------------------------------

async function render(bot, chatId, userId, text, keyboardRows) {
  const session = sessionStore.get(userId);
  const reply_markup = { inline_keyboard: keyboardRows };
  // Try edit-with-Markdown → edit-plain → send-with-Markdown → send-plain.
  // Plain-text fallbacks guarantee the user always sees the next step even if
  // a stray Markdown character in user-supplied data trips the parser.
  if (session && session.flowMessageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: session.flowMessageId,
        parse_mode: 'Markdown', reply_markup, disable_web_page_preview: true,
      });
      return session.flowMessageId;
    } catch (e1) {
      logger.warn(`userAddFlow.render: edit-md failed: ${e1.message}`);
      try {
        await bot.editMessageText(text, {
          chat_id: chatId, message_id: session.flowMessageId,
          reply_markup, disable_web_page_preview: true,
        });
        return session.flowMessageId;
      } catch (_) { /* fall through to send fresh */ }
    }
  }
  let sent;
  try {
    sent = await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown', reply_markup, disable_web_page_preview: true,
    });
  } catch (e2) {
    logger.warn(`userAddFlow.render: send-md failed: ${e2.message}`);
    sent = await bot.sendMessage(chatId, text, {
      reply_markup, disable_web_page_preview: true,
    });
  }
  if (session) {
    session.flowMessageId = sent.message_id;
    sessionStore.set(userId, session);
  }
  return sent.message_id;
}

function cancelRow() {
  return [{ text: '❌ Cancel', callback_data: 'usr:cancel' }];
}

function backCancelRow(backCb) {
  return [
    { text: '⬅ Back', callback_data: backCb },
    { text: '❌ Cancel', callback_data: 'usr:cancel' },
  ];
}

async function renderError(bot, chatId, userId, msg, backCb) {
  await render(bot, chatId, userId,
    `⚠️ ${msg}\n\n_Try again or step back._`,
    [backCancelRow(backCb)],
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * @param {object} bot
 * @param {number|string} chatId
 * @param {string} userId      admin user starting the flow
 * @param {number|null} messageId  anchor for editing (optional)
 * @param {object} [prefill]   { telegram_id, first_name, last_name, username, source }
 */
async function start(bot, chatId, userId, messageId = null, prefill = null) {
  if (!auth.isAdmin(userId)) {
    try { await bot.sendMessage(chatId, 'Admin only.'); } catch (_) {}
    return;
  }
  const data = {
    telegram_id: prefill && prefill.telegram_id ? String(prefill.telegram_id) : '',
    name: '',
    department: '',
    warehouses: [],
    role: '',
    prefillSource: prefill ? (prefill.source || 'pending_user') : null,
  };
  if (prefill) {
    const first = (prefill.first_name || '').trim();
    const last = (prefill.last_name || '').trim();
    const composed = [first, last].filter(Boolean).join(' ');
    if (composed) data.name = composed.slice(0, MAX_NAME_LEN);
  }
  sessionStore.set(userId, {
    type: 'user_add_flow',
    // Prefilled (onboard-from-card) jumps straight to name. A cold start
    // opens the pending-user picker (which itself falls back to manual
    // Telegram-ID entry when nobody is waiting).
    step: data.telegram_id ? 'name' : 'pick_pending',
    flowMessageId: messageId || null,
    data,
    startedAt: new Date().toISOString(),
    // Per-flow TTL override (sessionStore reads top-level `ttlMs`).
    // Onboarding may pause for dept/role lookup, so 5 min default is too tight.
    ttlMs: FLOW_TTL_MS,
  });
  if (data.telegram_id) {
    await renderNameStep(bot, chatId, userId);
  } else {
    await renderPendingPickStep(bot, chatId, userId);
  }
}

// ---------------------------------------------------------------------------
// Step 1 (cold start) — Pick a pending user OR enter an ID manually
// ---------------------------------------------------------------------------

/**
 * Render the "Who?" picker: every still-pending /start stranger as a tappable
 * name tile, plus a manual-entry escape. When nobody is pending, transparently
 * falls through to the manual Telegram-ID step so the cold path is unchanged.
 */
async function renderPendingPickStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const candidates = await loadPendingCandidates();

  if (!candidates.length) {
    session.data.pickAvailable = false;
    session.step = 'telegram_id';
    sessionStore.set(userId, session);
    await renderTelegramIdStep(bot, chatId, userId);
    return;
  }

  session.data.pickAvailable = true;
  session.step = 'pick_pending';
  const page = Math.max(0, session.data.pendingPage || 0);
  const startIdx = page * PENDING_PAGE_SIZE;
  const visible = candidates.slice(startIdx, startIdx + PENDING_PAGE_SIZE);

  const tile = (p) => ({
    text: `👤 ${truncate(pendingDisplayName(p), PENDING_NAME_MAX)}${p.arrived_at ? ` · ${timeAgo(p.arrived_at)}` : ''}`,
    callback_data: `usr:pu:${p.telegram_id}`,
  });
  const rows = [];
  for (let i = 0; i < visible.length; i += 2) {
    const row = [tile(visible[i])];
    if (visible[i + 1]) row.push(tile(visible[i + 1]));
    rows.push(row);
  }
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: 'usr:pu_pg:prev' });
  if (startIdx + PENDING_PAGE_SIZE < candidates.length) nav.push({ text: 'More ▸', callback_data: 'usr:pu_pg:next' });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '⌨️ Enter Telegram ID manually', callback_data: 'usr:manual' }]);
  rows.push(cancelRow());
  sessionStore.set(userId, session);

  const total = candidates.length;
  const pageNote = total > PENDING_PAGE_SIZE
    ? ` (${startIdx + 1}–${Math.min(startIdx + PENDING_PAGE_SIZE, total)} of ${total})`
    : '';
  await render(bot, chatId, userId,
    '➕ *Add Employee*\n\n_Step 1 of 6 — Who?_\n\n'
    + 'Tap a person who messaged the bot, or enter a Telegram ID manually.' + pageNote,
    rows,
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Telegram ID
// ---------------------------------------------------------------------------

async function renderTelegramIdStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  // When we got here from the pending-user picker, offer a way back to it;
  // otherwise this is the genuine first step and Cancel is the only escape.
  const footer = (session && session.data && session.data.pickAvailable)
    ? [backCancelRow('usr:back:pick')]
    : [cancelRow()];
  await render(bot, chatId, userId,
    '➕ *Add Employee*\n\n_Step 1 of 6 — Telegram ID_\n\n'
    + 'Type the new user\'s *numeric Telegram ID* (reply in chat).\n\n'
    + '_Rules:_\n'
    + `• ${MIN_TG_DIGITS}–${MAX_TG_DIGITS} digits, numbers only\n`
    + '• Must not already be an active user\n\n'
    + '_Hint: ask them to message_ `@userinfobot` _and forward you the `Id` number._',
    footer,
  );
}

async function applyTelegramId(bot, chatId, userId, raw) {
  const cleaned = String(raw || '').replace(/\D/g, '');
  if (!TG_RE.test(cleaned)) {
    await renderError(bot, chatId, userId,
      `That doesn't look like a Telegram ID. Need ${MIN_TG_DIGITS}–${MAX_TG_DIGITS} digits.`,
      'usr:back:telegram_id');
    return;
  }
  // Reject duplicates against the live Users sheet (active only).
  try {
    const existing = await usersRepo.findByUserId(cleaned);
    if (existing && (existing.status || 'active') === 'active') {
      await renderError(bot, chatId, userId,
        `Telegram ID \`${cleaned}\` is already an active user (*${existing.name || existing.user_id}*).`,
        'usr:back:telegram_id');
      return;
    }
  } catch (e) {
    logger.warn(`userAddFlow: dup check failed: ${e.message}`);
  }
  const session = sessionStore.get(userId);
  session.data.telegram_id = cleaned;
  session.step = 'name';
  sessionStore.set(userId, session);
  await renderNameStep(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Step 2 — Name
// ---------------------------------------------------------------------------

async function renderNameStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const prefilled = session?.data?.name ? `\n\n_Pre-filled from /start:_ *${mdEscape(session.data.name)}* — accept or replace by typing.` : '';
  const buttons = [];
  if (session?.data?.name) {
    buttons.push([{ text: `✅ Use "${session.data.name}"`, callback_data: 'usr:name:accept' }]);
  }
  // Back goes to the pending picker when the identity came from a tapped
  // pending user; otherwise to the manual Telegram-ID step.
  const nameBack = (session?.data?.pickAvailable && session?.data?.prefillSource === 'pending_user')
    ? 'usr:back:pick'
    : 'usr:back:name';
  buttons.push(backCancelRow(nameBack));
  await render(bot, chatId, userId,
    '➕ *Add Employee*\n\n_Step 2 of 6 — Display Name_\n\n'
    + 'Type the user\'s display name (1–80 chars).' + prefilled,
    buttons,
  );
}

async function applyName(bot, chatId, userId, raw) {
  const name = String(raw || '').trim();
  if (!name || name.length > MAX_NAME_LEN) {
    await renderError(bot, chatId, userId,
      `Name must be 1–${MAX_NAME_LEN} chars.`,
      'usr:back:name');
    return;
  }
  const session = sessionStore.get(userId);
  session.data.name = name;
  session.step = 'department';
  sessionStore.set(userId, session);
  await renderDepartmentStep(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Step 3 — Department picker
// ---------------------------------------------------------------------------

async function renderDepartmentStep(bot, chatId, userId) {
  let depts = [];
  try { depts = await departmentsRepo.getAll(); } catch (_) {}
  const names = depts
    .map((d) => (d.dept_name || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const rows = [];
  for (let i = 0; i < names.length; i += 2) {
    const row = [{ text: `🏢 ${names[i]}`, callback_data: `usr:dept:${encodeURIComponent(names[i])}` }];
    if (names[i + 1]) row.push({ text: `🏢 ${names[i + 1]}`, callback_data: `usr:dept:${encodeURIComponent(names[i + 1])}` });
    rows.push(row);
  }
  rows.push([{ text: '➕ New department', callback_data: 'usr:dept_new' }]);
  rows.push(backCancelRow('usr:back:department'));
  const prompt = names.length
    ? '➕ *Add Employee*\n\n_Step 3 of 6 — Department_\n\nWhich department does this person belong to?'
    : '➕ *Add Employee*\n\n_Step 3 of 6 — Department_\n\n_No departments exist yet._ Tap ➕ to create one.';
  await render(bot, chatId, userId, prompt, rows);
}

async function renderNewDeptStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  session.step = 'new_department';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    '➕ *Add Employee*\n\n_Step 3 of 6 — Department (new)_\n\n'
    + 'Type the new department name (e.g. `Sales`, `Inventory`, `Finance`).\n\n'
    + '_It will be created with no special activities; the admin can later grant them via Manage Departments._',
    [backCancelRow('usr:back:department')],
  );
}

async function applyDepartment(bot, chatId, userId, deptName) {
  const session = sessionStore.get(userId);
  const name = String(deptName || '').trim();
  if (!name) {
    await renderError(bot, chatId, userId, 'Department name is empty.', 'usr:back:department');
    return;
  }
  session.data.department = name;
  session.step = 'warehouses';
  sessionStore.set(userId, session);
  await renderWarehousesStep(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Step 4 — Warehouses (multi-select)
// ---------------------------------------------------------------------------

async function renderWarehousesStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  let merged = { raw: [] };
  try { merged = await warehouseFlow.listMergedWarehouses(); } catch (_) {}
  const all = merged.raw;
  const selected = new Set(session.data.warehouses || []);
  const rows = [];
  for (let i = 0; i < all.length; i += 2) {
    const a = all[i];
    const b = all[i + 1];
    const mark = (n) => (selected.has(n) ? '✅' : '⬜');
    const row = [{ text: `${mark(a)} ${a}`, callback_data: `usr:wh:${encodeURIComponent(a)}` }];
    if (b) row.push({ text: `${mark(b)} ${b}`, callback_data: `usr:wh:${encodeURIComponent(b)}` });
    rows.push(row);
  }
  rows.push([
    { text: `✅ Done (${selected.size})`, callback_data: 'usr:wh_done' },
    { text: '🔘 Clear', callback_data: 'usr:wh_clear' },
  ]);
  rows.push(backCancelRow('usr:back:warehouses'));
  await render(bot, chatId, userId,
    '➕ *Add Employee*\n\n_Step 4 of 6 — Warehouses_\n\n'
    + 'Tap each warehouse this user should be able to operate from. '
    + 'You can pick *zero or more* — admins and finance roles often work across all.',
    rows,
  );
}

function toggleWarehouse(session, name) {
  const set = new Set(session.data.warehouses || []);
  if (set.has(name)) set.delete(name); else set.add(name);
  session.data.warehouses = Array.from(set);
}

// ---------------------------------------------------------------------------
// Step 5 — Role
// ---------------------------------------------------------------------------

async function renderRoleStep(bot, chatId, userId) {
  await render(bot, chatId, userId,
    '➕ *Add Employee*\n\n_Step 5 of 6 — Role_\n\n'
    + 'Pick the user\'s role:\n\n'
    + '• *Employee* — uses the bot for daily ops in their department.\n'
    + '• *Manager* — same as employee, plus can submit approvals for activities flagged manager-only.\n\n'
    + '_To promote someone to admin, use the Promote Admin flow (USR-C3b) — requires a super-admin approver._',
    [
      [
        { text: '👤 Employee', callback_data: 'usr:role:employee' },
        { text: '🧭 Manager',  callback_data: 'usr:role:manager' },
      ],
      backCancelRow('usr:back:role'),
    ],
  );
}

async function applyRole(bot, chatId, userId, role) {
  if (!['employee', 'manager'].includes(role)) {
    await renderError(bot, chatId, userId, 'Invalid role.', 'usr:back:role');
    return;
  }
  const session = sessionStore.get(userId);
  session.data.role = role;
  session.step = 'confirm';
  sessionStore.set(userId, session);
  await renderConfirmStep(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Step 6 — Confirm + Submit
// ---------------------------------------------------------------------------

async function renderConfirmStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const d = session.data;
  const whLine = d.warehouses && d.warehouses.length
    ? d.warehouses.map((w) => mdEscape(w)).join(', ')
    : '_none_';
  const prefillNote = d.prefillSource === 'pending_user'
    ? '\n\n_Pre-filled from a /start by this user; they will be DMed a welcome message after approval._'
    : '\n\n_The user must send `/start` to the bot once before they can receive notifications._';
  await render(bot, chatId, userId,
    '➕ *Add Employee — Confirm*\n\n_Step 6 of 6_\n\n'
    + `*Telegram ID:* \`${mdEscape(d.telegram_id)}\`\n`
    + `*Name:* ${mdEscape(d.name)}\n`
    + `*Department:* ${mdEscape(d.department)}\n`
    + `*Warehouses:* ${whLine}\n`
    + `*Role:* ${mdEscape(d.role)}\n`
    + `${prefillNote}\n\n`
    + '_Submitting queues this for 2nd-admin approval — you cannot self-approve._',
    [
      [{ text: '✅ Submit for approval', callback_data: 'usr:submit' }],
      backCancelRow('usr:back:confirm'),
    ],
  );
}

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'user_add_flow') return;
  const d = session.data;
  const aj = {
    action: 'add_user',
    telegram_id: d.telegram_id,
    name: d.name,
    department: d.department,
    warehouses: d.warehouses || [],
    role: d.role,
    prefillSource: d.prefillSource || null,
  };
  const risk = await riskEvaluate.evaluate({ action: 'add_user', userId });
  const requestId = idGenerator.requestId();
  try {
    await approvalQueueRepository.append({
      requestId, user: userId, actionJSON: aj,
      riskReason: risk.reason || 'dual_admin_required', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, action: 'add_user' }, userId);
    const isAdm = auth.isAdmin(userId);
    const excludeId = isAdm ? userId : undefined;
    const summary = `➕👤 Add user: *${d.name}* (\`${d.telegram_id}\`) · ${d.department} · ${d.role}`;
    await approvalEvents.notifyAdminsApprovalRequest(
      bot, requestId, String(userId), summary, risk.reason, excludeId,
    );
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      `⏳ *Submitted for 2nd-admin approval*\n\n*${mdEscape(d.name)}* (\`${mdEscape(d.telegram_id)}\`)\nRequest: \`${mdEscape(requestId)}\`\n\n_You'll be notified when another admin approves or rejects._`,
      [[{ text: '🏠 Back to menu', callback_data: 'menu:home' }]],
    );
  } catch (e) {
    logger.error(`userAddFlow.submit failed: ${e.message}`);
    await renderError(bot, chatId, userId,
      `Could not queue the request: ${e.message}`, 'usr:back:confirm');
  }
}

// ---------------------------------------------------------------------------
// Text input dispatcher
// ---------------------------------------------------------------------------

async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'user_add_flow') return false;
  const chatId = msg.chat.id;
  const raw = (msg.text || '').trim();
  if (!raw) return false;
  if (session.step === 'telegram_id')   { await applyTelegramId(bot, chatId, userId, raw); return true; }
  if (session.step === 'name')          { await applyName(bot, chatId, userId, raw); return true; }
  if (session.step === 'new_department') { await applyDepartment(bot, chatId, userId, raw); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Callback dispatcher — usr:*
// ---------------------------------------------------------------------------

async function handleCallback(bot, query) {
  const userId = String(query.from.id);
  const data = query.data || '';
  if (!data.startsWith('usr:')) return false;
  const chatId = query.message.chat.id;
  const session = sessionStore.get(userId);

  // Graceful expired-session card: if a usr:* tap arrives but the session is
  // gone (TTL expired or overwritten by another concurrent flow), surface a
  // visible "session expired" message with a Restart button instead of
  // silently swallowing the click.
  if (!session || session.type !== 'user_add_flow') {
    if (data === 'usr:cancel') return true;        // already cancelled
    const hint = sessionStore.getLastSessionHint(userId);
    const wasOurs = hint && hint.type === 'user_add_flow';
    await bot.answerCallbackQuery(query.id, {
      text: wasOurs ? 'Session expired — please restart.' : 'No active session.',
      show_alert: false,
    }).catch(() => {});
    if (wasOurs) {
      try {
        await bot.sendMessage(chatId,
          '⏱ *Add Employee — session expired*\n\nYour onboarding session timed out or was interrupted. Please restart from the menu.',
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[
              { text: '🔁 Restart Add Employee', callback_data: 'act:add_user' },
              { text: '🏠 Back to menu', callback_data: 'menu:home' },
            ]] },
          },
        );
      } catch (_) { /* best effort */ }
    }
    return true;                                   // claimed → no fall-through
  }

  await bot.answerCallbackQuery(query.id).catch(() => {});

  try {
    return await _dispatchCallback(bot, query, session, chatId, userId, data);
  } catch (err) {
    logger.error(`userAddFlow.handleCallback: ${err && err.message}\n${err && err.stack}`);
    try {
      await bot.sendMessage(chatId,
        `⚠️ Something failed in Add Employee: ${err && err.message ? err.message : 'unknown error'}.\n\nPlease tap Restart and try again.`,
        { reply_markup: { inline_keyboard: [[
          { text: '🔁 Restart Add Employee', callback_data: 'act:add_user' },
          { text: '🏠 Back to menu', callback_data: 'menu:home' },
        ]] } },
      );
    } catch (_) { /* best effort */ }
    return true;
  }
}

/**
 * Inner dispatcher — extracted so the outer handleCallback can wrap every
 * branch in a single try/catch and surface visible errors.
 */
async function _dispatchCallback(bot, query, session, chatId, userId, data) {

  if (data === 'usr:cancel') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      '_Add Employee cancelled._',
      [[{ text: '🏠 Back to menu', callback_data: 'menu:home' }]]);
    return true;
  }

  if (data === 'usr:back:telegram_id' || data === 'usr:back:name') {
    session.step = 'telegram_id';
    sessionStore.set(userId, session);
    await renderTelegramIdStep(bot, chatId, userId);
    return true;
  }
  if (data === 'usr:back:department') {
    session.step = 'name';
    sessionStore.set(userId, session);
    await renderNameStep(bot, chatId, userId);
    return true;
  }
  if (data === 'usr:back:warehouses') {
    session.step = 'department';
    sessionStore.set(userId, session);
    await renderDepartmentStep(bot, chatId, userId);
    return true;
  }
  if (data === 'usr:back:role') {
    session.step = 'warehouses';
    sessionStore.set(userId, session);
    await renderWarehousesStep(bot, chatId, userId);
    return true;
  }
  if (data === 'usr:back:confirm') {
    session.step = 'role';
    sessionStore.set(userId, session);
    await renderRoleStep(bot, chatId, userId);
    return true;
  }
  if (data === 'usr:back:pick') {
    session.step = 'pick_pending';
    sessionStore.set(userId, session);
    await renderPendingPickStep(bot, chatId, userId);
    return true;
  }

  // Cold-start Step 1 — pending-user picker.
  if (data === 'usr:manual') {
    // Came from the picker; keep pickAvailable so the manual screen still
    // offers "Back" to the list.
    session.data.pickAvailable = true;
    session.step = 'telegram_id';
    sessionStore.set(userId, session);
    await renderTelegramIdStep(bot, chatId, userId);
    return true;
  }
  if (data === 'usr:pu_pg:prev' || data === 'usr:pu_pg:next') {
    const delta = data.endsWith('next') ? 1 : -1;
    session.data.pendingPage = Math.max(0, (session.data.pendingPage || 0) + delta);
    sessionStore.set(userId, session);
    await renderPendingPickStep(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('usr:pu:')) {
    const tgId = data.slice('usr:pu:'.length);
    let pu = null;
    try { pu = await pendingUsersRepo.findByTelegramId(tgId); } catch (_) {}
    if (!pu) {
      await renderError(bot, chatId, userId, 'That pending user is no longer available.', 'usr:back:pick');
      return true;
    }
    try {
      const existing = await usersRepo.findByUserId(tgId);
      if (existing && (existing.status || 'active') === 'active') {
        await renderError(bot, chatId, userId,
          `\`${tgId}\` is already an active user (*${existing.name || existing.user_id}*).`,
          'usr:back:pick');
        return true;
      }
    } catch (_) { /* dup check best-effort */ }
    const composed = [pu.first_name, pu.last_name].filter(Boolean).join(' ').trim();
    session.data.telegram_id = String(pu.telegram_id);
    session.data.name = composed ? composed.slice(0, MAX_NAME_LEN) : '';
    session.data.prefillSource = 'pending_user';
    session.step = 'name';
    sessionStore.set(userId, session);
    await renderNameStep(bot, chatId, userId);
    return true;
  }

  if (data === 'usr:name:accept') {
    if (session.data.name) {
      session.step = 'department';
      sessionStore.set(userId, session);
      await renderDepartmentStep(bot, chatId, userId);
    }
    return true;
  }

  if (data.startsWith('usr:dept:')) {
    const name = decodeURIComponent(data.slice('usr:dept:'.length));
    await applyDepartment(bot, chatId, userId, name);
    return true;
  }
  if (data === 'usr:dept_new') {
    await renderNewDeptStep(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('usr:wh:')) {
    const name = decodeURIComponent(data.slice('usr:wh:'.length));
    toggleWarehouse(session, name);
    sessionStore.set(userId, session);
    await renderWarehousesStep(bot, chatId, userId);
    return true;
  }
  if (data === 'usr:wh_clear') {
    session.data.warehouses = [];
    sessionStore.set(userId, session);
    await renderWarehousesStep(bot, chatId, userId);
    return true;
  }
  if (data === 'usr:wh_done') {
    session.step = 'role';
    sessionStore.set(userId, session);
    await renderRoleStep(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('usr:role:')) {
    const role = data.slice('usr:role:'.length);
    await applyRole(bot, chatId, userId, role);
    return true;
  }

  if (data === 'usr:submit') {
    await submit(bot, chatId, userId);
    return true;
  }

  return false;
}

module.exports = {
  start,
  handleText,
  handleCallback,
  // exported for tests:
  _internals: {
    TG_RE, MAX_NAME_LEN, PENDING_PAGE_SIZE, FLOW_TTL_MS,
    truncate, timeAgo, pendingDisplayName, loadPendingCandidates, mdEscape,
  },
};
