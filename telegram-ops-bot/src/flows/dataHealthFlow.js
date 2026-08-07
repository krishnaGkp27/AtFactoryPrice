'use strict';

/**
 * src/flows/dataHealthFlow.js — SEN-1 🩺 Data Health (admin-only).
 *
 * The on-tap face of consistencySentinel: run the seven read-only
 * cross-sheet checks now and browse every finding, instead of waiting for
 * the nightly DM (which caps lines per check). The flow only READS — the
 * fix for anything it surfaces goes through the normal repair paths.
 *
 * Callback namespace `snt:*`:
 *   snt:run       run (or re-run) the checks
 *   snt:c:<i>     open one check's full findings
 *   snt:pg:<n>    page within a check's findings
 *   snt:back      back to the summary
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, rowsFor, mdEscape } = require('../utils/flowKit');
const consistencySentinel = require('../services/consistencySentinel');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');

const SESSION_TYPE = 'data_health_flow';
const { backRow, menuRow } = rowsFor('snt');
const render = makeRenderer();

const LINES_PER_PAGE = 20;

async function start(bot, chatId, userId, messageId = null) {
  if (!auth.isAdmin(userId)) {
    try { await bot.sendMessage(chatId, '🩺 Data Health is admin-only.'); } catch (_) { /* ignore */ }
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'summary',
    flowMessageId: messageId || null, page: 0, _checks: [],
  });
  await runAndRender(bot, chatId, userId);
}

async function runAndRender(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  await render(bot, chatId, userId, '🩺 *Data Health*\n\n_Running 7 cross-sheet checks…_', []);
  let result;
  try {
    result = await consistencySentinel.runAll();
  } catch (e) {
    logger.warn(`dataHealth: run failed: ${e.message}`);
    await render(bot, chatId, userId,
      '🩺 *Data Health*\n\n⚠️ The checks could not run just now — try again in a moment.',
      [[{ text: '🔁 Try again', callback_data: 'snt:run' }], menuRow()]);
    return;
  }
  session._checks = result.checks;
  session.step = 'summary';
  sessionStore.set(userId, session);

  let body = `🩺 *Data Health* — ${result.totalFindings ? `*${result.totalFindings} issue(s)*` : '✅ all clean'}\n`
    + '_Read-only checks; fixes go through the normal repair paths._\n';
  const rows = [];
  result.checks.forEach((c, i) => {
    body += `\n${c.findings.length ? '⚠️' : '✅'} ${c.id} ${c.title}${c.findings.length ? ` — ${c.findings.length}` : ''}`;
    if (c.findings.length) {
      rows.push([{ text: `⚠️ ${c.id} — ${c.findings.length} finding(s)`, callback_data: `snt:c:${i}` }]);
    }
  });
  rows.push([{ text: '🔁 Re-run checks', callback_data: 'snt:run' }]);
  rows.push(menuRow());
  await render(bot, chatId, userId, body, rows);
}

async function renderFindings(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const c = (session._checks || [])[session.checkIdx];
  if (!c) { await runAndRender(bot, chatId, userId); return; }
  // Findings embed raw sheet text (customer names, designs) — mdEscape so
  // an unbalanced _ or * can never 400 the render, and budget pages by
  // CHARACTERS so a page of long C3/C6 lines never busts the 4096 cap.
  // (SEN-1b review findings.)
  const lines = c.findings.map((f) => `• ${mdEscape(f)}`);
  const pageStarts = [0];
  let budget = 0;
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (count >= LINES_PER_PAGE || (budget + lines[i].length > 3200 && count > 0)) {
      pageStarts.push(i);
      budget = 0;
      count = 0;
    }
    budget += lines[i].length + 1;
    count += 1;
  }
  const pages = pageStarts.length;
  const page = Math.min(Math.max(0, session.page || 0), pages - 1);
  const from = pageStarts[page];
  const to = page + 1 < pages ? pageStarts[page + 1] : lines.length;
  const slice = lines.slice(from, to);
  session.step = 'findings';
  sessionStore.set(userId, session);
  const body = `⚠️ *${c.id} — ${mdEscape(c.title)}*\n${c.findings.length} finding(s)`
    + `${pages > 1 ? ` · page ${page + 1}/${pages}` : ''}\n\n`
    + slice.join('\n');
  const rows = [];
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '◀ Prev', callback_data: `snt:pg:${page - 1}` });
    if (page < pages - 1) nav.push({ text: 'Next ▶', callback_data: `snt:pg:${page + 1}` });
    rows.push(nav);
  }
  rows.push(backRow('⬅ All checks'));
  rows.push(menuRow());
  await render(bot, chatId, userId, body, rows);
}

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('snt:')) return false;
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;
  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
  if (!auth.isAdmin(userId)) return true;

  let session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    await start(bot, chatId, userId, query.message.message_id);
    return true;
  }
  session.flowMessageId = query.message.message_id;
  sessionStore.set(userId, session);

  if (data === 'snt:run') { session.page = 0; sessionStore.set(userId, session); await runAndRender(bot, chatId, userId); return true; }
  if (data === 'snt:back') { session.page = 0; sessionStore.set(userId, session); await runAndRender(bot, chatId, userId); return true; }
  if (data.startsWith('snt:c:')) {
    session.checkIdx = parseInt(data.slice(6), 10);
    session.page = 0;
    sessionStore.set(userId, session);
    await renderFindings(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('snt:pg:')) {
    session.page = parseInt(data.slice(7), 10) || 0;
    sessionStore.set(userId, session);
    await renderFindings(bot, chatId, userId);
    return true;
  }
  logger.warn(`dataHealthFlow: unhandled callback ${data}`);
  return true;
}

module.exports = {
  start, handleCallback, SESSION_TYPE,
  _internals: { runAndRender, renderFindings },
};
