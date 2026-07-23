/**
 * Attendance Report flow (ATT-RPT-1).
 *
 * Admin-only, read-only view living under the Reports hub. Three
 * pre-built windows: 7d / Week / Month. Each renders:
 *   - Today's snapshot (always)
 *   - Daily breakdown for the window
 *   - Per-employee summary sorted by % desc
 *
 * UX adheres to UX-C1: every screen edits the same anchored message,
 * every screen has a back-row.
 */

'use strict';

const reportService = require('../services/attendanceReportService');
const sessionStore = require('../utils/sessionStore');
const auth = require('../middlewares/auth');
const { isNotModified } = require('../utils/telegramUI');

const CALLBACK_PREFIX = 'atd_rpt:';

async function start(bot, chatId, userId, messageId = null) {
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId, 'Admin only.');
    return;
  }
  const session = sessionStore.get(userId) || {};
  session.type = 'attendance_report_flow';
  session.kind = session.kind || '7d';
  if (messageId) session.flowMessageId = messageId;
  sessionStore.set(userId, session);
  await renderReport(bot, chatId, userId, session.kind);
}

async function renderReport(bot, chatId, userId, kind) {
  const report = await reportService.buildReport({ kind });
  const text = formatReport(report);
  const kb = buildKeyboard(kind);
  await editOrSend(bot, chatId, userId, text, kb);
}

function formatReport(r) {
  // ---- Today snapshot ----
  const today = r.today;
  const lines = [];
  lines.push(`📊 *Attendance Report — ${labelFor(r.kind)}*`);
  lines.push(`_Timezone: ${r.timezone}_`);
  lines.push('');
  lines.push(`📅 *Today (${today.date})*`);
  lines.push(`Present: *${today.present.length}/${r.requiredCount}*  ·  Pending: *${today.missing.length}*`);
  if (today.present.length) {
    for (const p of today.present) {
      const t = fmtTime(p.loggedAt, r.timezone);
      lines.push(`  ✅ ${p.name} — ${p.location} · ${t}${p.viaAdmin ? ' _(via admin)_' : ''}`);
    }
  } else {
    lines.push(`  _(no one has logged yet)_`);
  }
  if (today.missing.length) {
    for (const m of today.missing) {
      lines.push(`  ⏳ ${m.name}`);
    }
  }
  lines.push('');

  // ---- Window header ----
  lines.push('━━━━━━━━━━━━━━');
  lines.push(`📅 *${r.label}* (${r.workingDateCount} working day${r.workingDateCount === 1 ? '' : 's'})`);
  lines.push('');

  // ---- Daily breakdown ----
  if (r.daily.length) {
    lines.push('*Daily coverage:*');
    for (const d of r.daily) {
      const bar = renderBar(d.pct);
      lines.push(`  ${d.label}:  ${d.present}/${d.required}  ${bar} ${d.pct}%`);
    }
    lines.push('');
  } else {
    lines.push('_No working days in this window yet._');
    lines.push('');
  }

  // ---- Per-employee ----
  if (r.perEmployee.length) {
    lines.push('*Per employee:*');
    for (const e of r.perEmployee) {
      lines.push(`  ${rankIcon(e.pct)} ${e.name}  —  ${e.daysPresent}/${e.totalDays} days (*${e.pct}%*)`);
    }
  } else {
    lines.push('_No required employees configured. Use_ `Admin Settings → 🗓 Attendance → 👥 Required Users` _to enable._');
  }
  return lines.join('\n');
}

function rankIcon(pct) {
  if (pct >= 95) return '🟢';
  if (pct >= 75) return '🟡';
  if (pct >= 50) return '🟠';
  return '🔴';
}

function renderBar(pct) {
  // 10-segment unicode bar, e.g. ████████░░ for 80%.
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function fmtTime(iso, tz) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch (_) { return iso.slice(11, 16); }
}

function labelFor(kind) {
  return kind === 'week' ? 'This Week'
       : kind === 'month' ? 'This Month'
       : 'Last 7 Days';
}

function buildKeyboard(kind) {
  // Tab row: highlight the active tab with a leading ✅
  const tab = (k, label) => ({
    text: (k === kind ? '✅ ' : '') + label,
    callback_data: `${CALLBACK_PREFIX}tab:${k}`,
  });
  return [
    [tab('7d', '📅 7d'), tab('week', '📅 Week'), tab('month', '📅 Month')],
    [{ text: '🔁 Refresh', callback_data: `${CALLBACK_PREFIX}tab:${kind}` }],
    [{ text: '⬅ Back to menu', callback_data: 'act:__back__' }],
  ];
}

async function editOrSend(bot, chatId, userId, text, keyboardRows) {
  const session = sessionStore.get(userId) || {};
  const reply_markup = { inline_keyboard: keyboardRows };
  if (session.flowMessageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: session.flowMessageId,
        parse_mode: 'Markdown', reply_markup, disable_web_page_preview: true,
      });
      return session.flowMessageId;
    } catch (e) {
      // screen already correct — success, not a reason to send a new card
      if (isNotModified(e)) return session.flowMessageId;
    }
  }
  const sent = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown', reply_markup, disable_web_page_preview: true,
  });
  session.flowMessageId = sent.message_id;
  sessionStore.set(userId, session);
  return sent.message_id;
}

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith(CALLBACK_PREFIX)) return false;
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  if (!auth.isAdmin(userId)) {
    try { await bot.answerCallbackQuery(query.id, { text: 'Admin only.' }); } catch (_) {}
    return true;
  }
  try { await bot.answerCallbackQuery(query.id); } catch (_) {}

  if (data.startsWith(`${CALLBACK_PREFIX}tab:`)) {
    const kind = data.slice(`${CALLBACK_PREFIX}tab:`.length);
    if (!['7d', 'week', 'month'].includes(kind)) return true;
    const session = sessionStore.get(userId) || {};
    session.type = 'attendance_report_flow';
    session.kind = kind;
    session.flowMessageId = query.message.message_id;
    sessionStore.set(userId, session);
    await renderReport(bot, chatId, userId, kind);
    return true;
  }
  return true;
}

module.exports = {
  start,
  handleCallback,
  CALLBACK_PREFIX,
};
