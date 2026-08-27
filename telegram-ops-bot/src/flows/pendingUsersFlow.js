'use strict';

/**
 * IDR-4 — 👋 Pending Users: the queue behind the stranger cards
 * (owner-approved layout, 27-Aug-2026).
 *
 * Before this, a stranger's ping produced a one-time DM card to admins and
 * a register row — but no surface ever listed the backlog. If the card
 * scrolled away, triage meant chat archaeology. This module is the missing
 * queue: one chip per still-unplaced stranger, the same triage doors on an
 * anchored card, a Handled audit view, and the two ➕ shortcuts that turn
 * "register them first, then find the old card, then link" into one
 * tap-through (the link itself is stitched on approval by the executors).
 *
 * Everything here is DERIVED from the PendingUsers register at read time —
 * no new sheet, no new columns (§10). The message snippets ride the
 * in-memory living card (IDR-3) and degrade to nothing after a restart.
 *
 * Callback namespace: `puq:` (queue) — the triage doors reuse the existing
 * `pu:` handlers unchanged. Context (page) rides the callback_data.
 */

const pendingUsersRepo = require('../repositories/pendingUsersRepository');
const pendingUserService = require('../services/pendingUserService');
const sessionStore = require('../utils/sessionStore');
const auth = require('../middlewares/auth');
const fmtDate = require('../utils/formatDate');
const logger = require('../utils/logger');
const { editOrSend } = require('../utils/telegramUI');
const { mdEscape } = require('../utils/flowKit');

const PAGE = 8;
// Same visual language as Team Tasks: 🆕 fresh, 📨 waiting, ⚠️ past a week.
const FRESH_HOURS = 48;
const STALL_DAYS = 7;

function truncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

function displayName(u) {
  return [u.first_name, u.last_name].filter(Boolean).join(' ')
    || (u.username ? `@${u.username}` : u.telegram_id);
}

/** Whole days since arrival; null when the timestamp is unparseable. */
function ageDays(iso, nowMs) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor(((nowMs ?? Date.now()) - t) / 86400000));
}

function chipFact(u, nowMs) {
  const d = ageDays(u.arrived_at, nowMs);
  if (d == null) return '🆕';
  const label = d === 0 ? 'today' : `${d}d`;
  const ms = (nowMs ?? Date.now()) - new Date(u.arrived_at).getTime();
  if (ms <= FRESH_HOURS * 3600000) return `🆕 ${label}`;
  return d > STALL_DAYS ? `⚠️ ${label}` : `📨 ${label}`;
}

/** Last thing they said, from the in-memory living card (best-effort). */
function lastSnippet(telegramId) {
  const msgs = pendingUserService.liveMessages(telegramId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = String(msgs[i].text || '').replace(/\s+/g, ' ').trim();
    if (t && !/^\/start\b/i.test(t)) return t;
  }
  return '';
}

function menuRow() {
  return [{ text: '🏠 Menu', callback_data: 'act:__back__' }];
}

function pagerRow(prefix, page, pageCount) {
  return [
    { text: '⬅ Prev', callback_data: page > 0 ? `${prefix}:${page - 1}` : 'puq:noop' },
    { text: `Page ${page + 1}/${pageCount}`, callback_data: 'puq:noop' },
    { text: 'Next ➡', callback_data: page < pageCount - 1 ? `${prefix}:${page + 1}` : 'puq:noop' },
  ];
}

async function renderQueue(bot, chatId, userId, messageId, page) {
  const all = await pendingUsersRepo.getAll();
  const pending = all.filter((u) => u.status === 'pending')
    .sort((a, b) => String(b.arrived_at).localeCompare(String(a.arrived_at)));
  const handledCount = all.length - pending.length;
  const nowMs = Date.now();

  const pageCount = Math.max(1, Math.ceil(pending.length / PAGE));
  const p = Math.min(Math.max(0, page || 0), pageCount - 1);
  const slice = pending.slice(p * PAGE, (p + 1) * PAGE);

  const lines = [`👋 *Pending Users* — ${pending.length} waiting`];
  if (!pending.length) lines.push('', '_Nobody is waiting — every arrival has been placed._');
  else lines.push('_Newest first. Tap one to place them._');

  const rows = [];
  for (const u of slice) {
    const snip = lastSnippet(u.telegram_id);
    const label = `${chipFact(u, nowMs)} · ${truncate(displayName(u), 14)}`
      + (snip ? ` · “${truncate(snip, 20)}”` : '');
    rows.push([{ text: label, callback_data: `puq:u:${p}:${u.telegram_id}` }]);
  }
  if (pageCount > 1) rows.push(pagerRow('puq:q', p, pageCount));
  rows.push([
    { text: `🗂 Handled (${handledCount})`, callback_data: 'puq:h:0' },
    ...menuRow(),
  ]);

  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows },
  });
}

async function renderHandled(bot, chatId, userId, messageId, page) {
  const all = await pendingUsersRepo.getAll();
  const handled = all.filter((u) => u.status !== 'pending')
    .sort((a, b) => String(b.linked_at || b.handled_at || b.arrived_at)
      .localeCompare(String(a.linked_at || a.handled_at || a.arrived_at)));

  const pageCount = Math.max(1, Math.ceil(handled.length / PAGE));
  const p = Math.min(Math.max(0, page || 0), pageCount - 1);
  const slice = handled.slice(p * PAGE, (p + 1) * PAGE);

  const ICON = { marketer: '📣', customer: '🤝', contact: '🕸', employee: '👔' };
  const lines = [`🗂 *Handled* — ${handled.length}`];
  if (!handled.length) lines.push('', '_Nothing handled yet._');
  else {
    lines.push('');
    for (const u of slice) {
      let became;
      if (u.link_type) {
        became = `${ICON[u.link_type] || ''} ${u.link_type} *${mdEscape(u.link_name || '')}*`;
      } else if (u.status === 'ignored') {
        became = '🚫 ignored';
      } else {
        became = `👔 ${mdEscape(u.status)}`;
      }
      const when = u.linked_at || u.handled_at;
      const d = when ? fmtDate(when) : '';
      lines.push(`• ${mdEscape(displayName(u))} → ${became}${d ? ` · ${mdEscape(d)}` : ''}`);
    }
  }

  const rows = [];
  if (pageCount > 1) rows.push(pagerRow('puq:h', p, pageCount));
  rows.push([{ text: '⬅ Back', callback_data: 'puq:q:0' }, ...menuRow()]);

  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows },
  });
}

/**
 * The triage card, anchored in the queue message. The five doors reuse the
 * existing `pu:` handlers verbatim; the two ➕ shortcuts and Ignore carry
 * the queue page so their outcome lands back where the admin was.
 */
async function renderDetail(bot, chatId, userId, messageId, page, telegramId) {
  const u = await pendingUsersRepo.findByTelegramId(telegramId);
  const backRow = [
    { text: '⬅ Back', callback_data: `puq:q:${page}` },
    ...menuRow(),
  ];
  if (!u) {
    await editOrSend(bot, chatId, messageId, '❌ That register row is gone.', {
      reply_markup: { inline_keyboard: [backRow] },
    });
    return;
  }
  if (u.status !== 'pending') {
    // Placed by another admin between the list render and this tap.
    await renderQueue(bot, chatId, userId, messageId, page);
    return;
  }

  const handle = u.username ? `@${mdEscape(u.username)}` : 'no username';
  const lines = [
    `👋 *${mdEscape(displayName(u))}* · ${handle}`,
    `🆔 \`${u.telegram_id}\` · 🕓 ${mdEscape(fmtDate.withTime(u.arrived_at))}`,
  ];
  const msgs = pendingUserService.liveMessages(u.telegram_id).slice(-5);
  if (msgs.length) {
    lines.push('', `💬 *Messages (${msgs.length})*`);
    for (const m of msgs) {
      const said = truncate(String(m.text || '').replace(/\s+/g, ' ').trim(), 90);
      lines.push(`${mdEscape(fmtDate.withTime(m.at).slice(-5))} — _${mdEscape(said || '(no text)')}_`);
    }
  }
  lines.push('', 'Who are they?');

  const id = u.telegram_id;
  const rows = [
    [{ text: '👔 Onboard as employee', callback_data: `pu:onboard:${id}` }],
    [{ text: '🤝 Link to customer', callback_data: `pu:cust:${id}` },
      { text: '➕ New customer', callback_data: `puq:nc:${page}:${id}` }],
    [{ text: '📣 Link to marketer', callback_data: `pu:mkt:${id}` },
      { text: '➕ New marketer', callback_data: `puq:nm:${page}:${id}` }],
    [{ text: '🕸 Add to network', callback_data: `pu:net:${id}` }],
    [{ text: '🚫 Ignore', callback_data: `puq:ign:${page}:${id}` }],
    backRow,
  ];

  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows },
  });
}

/** Entry from the 👋 tile. Admin-only (RPT-2 precedent: gate in start()). */
async function start(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId)) {
    await editOrSend(bot, chatId, messageId,
      '🔒 *Pending Users* is admin-only.',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [menuRow()] } });
    return;
  }
  await renderQueue(bot, chatId, userId, messageId, 0);
}

/**
 * `puq:` callbacks. `deps` is injected by the controller so the two ➕
 * shortcuts can enter the EXISTING registration flows (CON-1 one door,
 * Register Marketer) with the name pre-filled — this module never grows a
 * registration path of its own.
 *   { startAddCustomerFlow, showAddCustomerPhoneStep,
 *     startRegisterMarketer, feedMarketerName }
 */
async function handleCallback(bot, callbackQuery, deps = {}) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('puq:')) return false;
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) { /* noop */ }
  if (!auth.isAdmin(userId)) return true;
  if (data === 'puq:noop') return true;

  const parts = data.slice(4).split(':'); // action, page, telegramId?
  const action = parts[0];
  const page = Math.max(0, parseInt(parts[1], 10) || 0);
  const tgId = parts[2] || '';

  if (action === 'q') { await renderQueue(bot, chatId, userId, messageId, page); return true; }
  if (action === 'h') { await renderHandled(bot, chatId, userId, messageId, page); return true; }
  if (action === 'u') { await renderDetail(bot, chatId, userId, messageId, page, tgId); return true; }

  if (action === 'ign') {
    try { await pendingUserService.ignore(tgId, userId); } catch (e) {
      logger.warn(`pendingUsersFlow.ignore(${tgId}): ${e.message}`);
    }
    await renderQueue(bot, chatId, userId, messageId, page);
    return true;
  }

  if (action === 'nc' || action === 'nm') {
    const u = await pendingUsersRepo.findByTelegramId(tgId);
    if (!u) { await renderQueue(bot, chatId, userId, messageId, page); return true; }
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
      || u.username || u.telegram_id;

    if (action === 'nc') {
      // CON-1's one door, entered as if the admin had tapped 🛒 Customer
      // and typed the name — the flow continues at the phone step, and the
      // queued add_contact carries the account for link-on-approval.
      await deps.startAddCustomerFlow(bot, chatId, userId, messageId);
      const s = sessionStore.get(userId);
      if (s && s.type === 'add_customer_flow') {
        s.personType = 'customer';
        s.name = name;
        s.pendingTelegramId = tgId;
        s.step = 'phone';
        sessionStore.set(userId, s);
        await deps.showAddCustomerPhoneStep(bot, chatId, userId);
      }
      return true;
    }

    // nm — Register Marketer with the name fed as if typed; dual-admin
    // approval unchanged, ✏️ Edit Name still available at review.
    await deps.startRegisterMarketer(bot, chatId, userId, messageId);
    const s = sessionStore.get(userId);
    if (s && s.type === 'marketer_reg_flow') {
      s.pendingTelegramId = tgId;
      sessionStore.set(userId, s);
      await deps.feedMarketerName(bot, chatId, userId, name);
    }
    return true;
  }

  return true;
}

module.exports = {
  start,
  handleCallback,
  _internals: { chipFact, ageDays, lastSnippet, displayName, PAGE, FRESH_HOURS, STALL_DAYS },
};
