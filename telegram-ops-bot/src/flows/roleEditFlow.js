/**
 * MKT-1 — Change Role flow (existing users).
 *
 * Lets an admin change an EXISTING user's role between the non-admin roles
 * (employee | manager | marketer | salesman) straight from the bot, instead
 * of editing the Users sheet. Mirrors the sibling Manage-Users editors
 * (Assign Department / Assign Warehouses): admin-only, writes DIRECTLY to the
 * sheet (no dual-admin approval — that is reserved for add/promote/deactivate).
 *
 * Admins are intentionally NOT listed here: promoting/demoting admin power is
 * handled by the dedicated Promote Admin / Deactivate flows (super-admin gated).
 *
 * Callback namespace: `rol:*`
 *   rol:start                 entry (from Manage Users)
 *   rol:page:<n>              paginate the user picker
 *   rol:pick:<tgId>           select target → show role buttons
 *   rol:set:<tgId>|<role>     apply the new role (writes + confirms)
 *   rol:cancel | rol:noop
 *
 * Session shape:
 *   { type: 'role_edit_flow', step: 'pick'|'role', flowMessageId, page,
 *     target: { user_id, name, role } | null }
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const auth = require('../middlewares/auth');
const usersRepo = require('../repositories/usersRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const fieldRoles = require('../services/fieldRoles');
const logger = require('../utils/logger');

const PAGE_SIZE = 8;

/** Roles assignable via this flow (admin excluded by design). */
const ROLE_OPTIONS = [
  { role: 'employee', label: '👤 Employee' },
  { role: 'manager', label: '🧭 Manager' },
  { role: 'marketer', label: '📣 Marketer' },
  { role: 'salesman', label: '💼 Salesman' },
];
const ASSIGNABLE = new Set(ROLE_OPTIONS.map((o) => o.role));

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
    } catch (_) { /* fall through to a fresh send */ }
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

const { cancelRow } = require('../utils/flowKit').rowsFor('rol');

async function renderError(bot, chatId, userId, msg) {
  await render(bot, chatId, userId,
    `⚠️ ${msg}`,
    [[{ text: '⬅ Back', callback_data: 'rol:start' }], cancelRow()]);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * @param {object} bot
 * @param {number|string} chatId
 * @param {string} userId       admin starting the flow
 * @param {number|null} messageId
 */
async function start(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId)) {
    try { await bot.sendMessage(chatId, 'Admin only.'); } catch (_) {}
    return;
  }
  sessionStore.set(userId, {
    type: 'role_edit_flow',
    step: 'pick',
    flowMessageId: messageId || null,
    page: 0,
    target: null,
    startedAt: new Date().toISOString(),
  });
  await renderPickStep(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Step 1 — pick target (active, non-admin users)
// ---------------------------------------------------------------------------

/** Active users whose role can be changed here (admins excluded). */
async function _eligibleUsers() {
  const all = await usersRepo.getAll();
  return all.filter((u) => u.user_id
    && (u.status || 'active') === 'active'
    && String(u.role || '').toLowerCase() !== 'admin');
}

async function renderPickStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  let users = [];
  try { users = await _eligibleUsers(); } catch (e) { logger.warn(`roleEditFlow: getAll failed: ${e.message}`); }

  if (!users.length) {
    await render(bot, chatId, userId,
      '🎚 *Change Role*\n\n_No eligible users._\n\nOnly active, non-admin users appear here. Use Add Employee to onboard new people, or Promote Admin for admin power.',
      [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]],
    );
    return;
  }
  users.sort((a, b) => (a.name || a.user_id).localeCompare(b.name || b.user_id));
  const total = users.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(0, session.page || 0), pages - 1);
  const slice = users.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const rows = slice.map((u) => [{
    text: `👤 ${u.name || u.user_id} · ${u.role || 'employee'}`,
    callback_data: `rol:pick:${u.user_id}`,
  }]);
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `rol:page:${page - 1}` });
    nav.push({ text: `Page ${page + 1}/${pages}`, callback_data: 'rol:noop' });
    if (page < pages - 1) nav.push({ text: 'Next ➡️', callback_data: `rol:page:${page + 1}` });
    rows.push(nav);
  }
  rows.push(cancelRow());
  await render(bot, chatId, userId,
    '🎚 *Change Role*\n\n_Step 1 of 2 — pick the user whose role you want to change._',
    rows,
  );
}

// ---------------------------------------------------------------------------
// Step 2 — pick the new role (writes immediately on tap)
// ---------------------------------------------------------------------------

async function renderRoleStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.target) return;
  const t = session.target;
  const rows = [];
  for (let i = 0; i < ROLE_OPTIONS.length; i += 2) {
    const a = ROLE_OPTIONS[i];
    const b = ROLE_OPTIONS[i + 1];
    const cur = String(t.role || '').toLowerCase();
    const btn = (o) => ({
      text: `${o.role === cur ? '• ' : ''}${o.label}`,
      callback_data: `rol:set:${t.user_id}|${o.role}`,
    });
    const row = [btn(a)];
    if (b) row.push(btn(b));
    rows.push(row);
  }
  rows.push([{ text: '⬅ Back', callback_data: 'rol:back:pick' }, ...cancelRow()]);
  await render(bot, chatId, userId,
    '🎚 *Change Role*\n\n_Step 2 of 2_\n\n'
    + `*User:* ${t.name || t.user_id} (\`${t.user_id}\`)\n`
    + `*Current role:* ${t.role || 'employee'}\n\n`
    + 'Tap the new role. (📣 Marketer / 💼 Salesman are view-only field roles scoped to the user\'s warehouse(s).)',
    rows,
  );
}

async function applyRole(bot, chatId, userId, tgId, role) {
  if (!ASSIGNABLE.has(role)) {
    await renderError(bot, chatId, userId, `Role "${role}" cannot be set here.`);
    return;
  }
  let target = null;
  try { target = await usersRepo.findByUserId(tgId); } catch (_) {}
  if (!target || (target.status || 'active') !== 'active') {
    await renderError(bot, chatId, userId, 'That user is no longer active.');
    return;
  }
  if (String(target.role || '').toLowerCase() === 'admin') {
    await renderError(bot, chatId, userId, 'Admins are managed via Promote/Deactivate, not here.');
    return;
  }
  const from = target.role || 'employee';
  const ok = await usersRepo.updateRole(tgId, role);
  if (!ok) {
    await renderError(bot, chatId, userId, 'Could not update the role (user not found).');
    return;
  }
  // Role drives the menu & permissions — refresh the auth cache so it takes
  // effect on the user's next message without waiting for the TTL.
  try { auth.invalidate(); } catch (_) {}
  try { await auditLogRepository.append('role_changed', { target: tgId, from, to: role }, userId); } catch (_) {}

  // A field role with no warehouse sees nothing — nudge the admin to assign.
  const needsWarehouse = fieldRoles.isFieldRole(role)
    && !(Array.isArray(target.warehouses) && target.warehouses.length);
  const warn = needsWarehouse
    ? '\n\n⚠️ This user has *no warehouse assigned* — as a marketer/salesman they will see no products until you assign one.'
    : '';
  const rows = needsWarehouse
    ? [[{ text: '🏭 Assign Warehouses', callback_data: 'adm:assign_wh' }], [{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]]
    : [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]];

  sessionStore.clear(userId);
  await render(bot, chatId, userId,
    `✅ *Role updated*\n\n*${target.name || tgId}* (\`${tgId}\`)\n${from} → *${role}*${warn}`,
    rows,
  );
}

// ---------------------------------------------------------------------------
// Callback dispatcher — rol:*
// ---------------------------------------------------------------------------

async function handleCallback(bot, query) {
  const userId = String(query.from.id);
  const data = query.data || '';
  if (!data.startsWith('rol:')) return false;
  const chatId = query.message.chat.id;

  // `rol:start` is the one callback accepted WITHOUT an existing session.
  if (data === 'rol:start') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await start(bot, chatId, userId, query.message.message_id);
    return true;
  }

  const session = sessionStore.get(userId);
  if (!session || session.type !== 'role_edit_flow') return false;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === 'rol:cancel') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '_Change Role cancelled._',
      [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]]);
    return true;
  }
  if (data === 'rol:noop') return true;
  if (data.startsWith('rol:page:')) {
    session.page = parseInt(data.slice('rol:page:'.length), 10) || 0;
    sessionStore.set(userId, session);
    await renderPickStep(bot, chatId, userId);
    return true;
  }
  if (data === 'rol:back:pick') {
    session.step = 'pick';
    session.target = null;
    sessionStore.set(userId, session);
    await renderPickStep(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('rol:pick:')) {
    const tgId = data.slice('rol:pick:'.length);
    let target = null;
    try { target = await usersRepo.findByUserId(tgId); } catch (_) {}
    if (!target) { await renderError(bot, chatId, userId, 'User not found.'); return true; }
    if (String(target.role || '').toLowerCase() === 'admin') {
      await renderError(bot, chatId, userId, 'Admins are managed via Promote/Deactivate, not here.');
      return true;
    }
    session.target = { user_id: String(target.user_id), name: target.name, role: target.role, warehouses: target.warehouses };
    session.step = 'role';
    sessionStore.set(userId, session);
    await renderRoleStep(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('rol:set:')) {
    const [tgId, role] = data.slice('rol:set:'.length).split('|');
    await applyRole(bot, chatId, userId, tgId, role);
    return true;
  }
  return false;
}

module.exports = {
  start,
  handleCallback,
  // exported for tests:
  _internals: { PAGE_SIZE, ROLE_OPTIONS, ASSIGNABLE },
};
