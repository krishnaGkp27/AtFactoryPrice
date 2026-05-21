'use strict';

/**
 * src/flows/dailyBranchOpsFlow.js — BR-OPS C1.
 *
 * Branch managers' morning routine. Single anchored card (UX-C1),
 * Back + Cancel at every step, errors re-render the card with a
 * step-appropriate retry button.
 *
 * Steps:
 *   1. camera_check    — [✅ Working] / [⚠️ Issue] (issue → optional 1-line note)
 *   2. opening_cash    — type cash count (number only) OR [Skip] if cash
 *                          already counted today
 *   3. summary_preview — read-only "Yesterday's outstanding" + deep links
 *                          to existing hubs (samples, expenses)
 *   4. confirm         — single tap writes daily_open + camera_check +
 *                          opening_cash rows via branchOpsService.openDay
 *
 * After confirm, the card collapses to a status panel:
 *
 *   🟢 Lagos open — opening ₦185,400 · camera OK
 *   [💸 Add Office Expense] [🧪 Give Sample] [🧾 Upload Receipt]
 *   [👤 Add Customer] [🧑‍💼 Register Marketer] [🏠 Menu]
 *
 * Re-tapping "Open Branch (Daily)" later in the day brings the manager
 * straight to this status panel (openDay is idempotent — it returns
 * { alreadyOpen: true } if a daily_open row exists for today).
 *
 * Session shape (type: 'daily_branch_ops'):
 *   {
 *     step:            'camera' | 'cash' | 'summary' | 'confirm' | 'open',
 *     flowMessageId,   startedAt,
 *     cameraOk:        bool,
 *     cameraNote:      string,
 *     openingCash:     number|null,
 *     branch:          string,  // resolved from user.warehouses[0]
 *   }
 *
 * Callback namespace `bops:*`:
 *   bops:cancel
 *   bops:back
 *   bops:cam:ok | bops:cam:issue
 *   bops:cam:skipNote
 *   bops:cash:skip
 *   bops:confirm
 *   bops:noop
 *   bops:hub:<code>      shortcut to act:<code>
 */

const sessionStore = require('../utils/sessionStore');
const branchOpsService = require('../services/branchOpsService');
const branchOpsLogRepository = require('../repositories/branchOpsLogRepository');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

async function render(bot, chatId, userId, text, rows) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  const mid = session.flowMessageId;
  if (mid) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...opts });
      return;
    } catch (_) { /* message gone / identical — fall through */ }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  session.flowMessageId = sent.message_id;
  sessionStore.set(userId, session);
}

function backRow()   { return [{ text: '⬅ Back',   callback_data: 'bops:back'   }]; }
function cancelRow() { return [{ text: '❌ Cancel', callback_data: 'bops:cancel' }]; }
function menuRow()   { return [{ text: '🏠 Menu',   callback_data: 'act:__back__' }]; }

async function renderError(bot, chatId, userId, msg) {
  const session = sessionStore.get(userId);
  if (!session) {
    await bot.sendMessage(chatId, `⚠️ ${msg}`);
    return;
  }
  await render(bot, chatId, userId, `⚠️ ${msg}`, [
    backRow(),
    cancelRow(),
  ]);
}

function fmtNgn(n) {
  const x = Number(n) || 0;
  return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Entry — resolves branch, checks if already open, then either renders
// the status panel or kicks off the morning routine.
// ---------------------------------------------------------------------------

async function start(bot, chatId, userId, messageId) {
  const branch = await branchOpsService.resolveBranch(userId);
  const today = branchOpsService.todayInTz();
  const alreadyOpen = await branchOpsLogRepository.isDayOpen(branch, today);

  sessionStore.set(userId, {
    type: 'daily_branch_ops',
    step: alreadyOpen ? 'open' : 'camera',
    flowMessageId: messageId || null,
    branch,
    cameraOk: null,
    cameraNote: '',
    openingCash: null,
    startedAt: new Date().toISOString(),
  });

  if (alreadyOpen) {
    await renderStatusPanel(bot, chatId, userId);
    return;
  }
  await renderCameraStep(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Step 1 — Camera check
// ---------------------------------------------------------------------------

async function renderCameraStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  await render(bot, chatId, userId,
    `🌅 *Open Branch — ${session.branch}*\n\n`
    + 'Step 1 of 3 — *Camera check*\n\n'
    + 'Is the office camera working?',
    [
      [
        { text: '✅ Working', callback_data: 'bops:cam:ok' },
        { text: '⚠️ Issue',   callback_data: 'bops:cam:issue' },
      ],
      cancelRow(),
    ],
  );
}

async function pickCamera(bot, chatId, userId, ok) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.cameraOk = !!ok;
  session.cameraNote = '';
  if (ok) {
    session.step = 'cash';
    sessionStore.set(userId, session);
    await renderCashStep(bot, chatId, userId);
    return;
  }
  // Issue → optional 1-line note
  session.step = 'camera_note';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `🌅 *Open Branch — ${session.branch}*\n\n`
    + '⚠️ *Camera issue*\n\n'
    + 'Reply with a short note (one line, e.g. _"Camera 2 offline"_), or tap *Skip note* to continue.',
    [
      [{ text: '⏭ Skip note', callback_data: 'bops:cam:skipNote' }],
      backRow(),
      cancelRow(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Opening cash
// ---------------------------------------------------------------------------

async function renderCashStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  await render(bot, chatId, userId,
    `🌅 *Open Branch — ${session.branch}*\n`
    + `• Camera: ${session.cameraOk ? '✅ Working' : '⚠️ Issue' + (session.cameraNote ? ` (${session.cameraNote})` : '')}\n\n`
    + 'Step 2 of 3 — *Opening cash balance (NGN)*\n\n'
    + 'Reply with the cash count in your float now.\nExample: `185400` (no commas, no ₦ symbol)',
    [
      [{ text: '⏭ Skip (cash already counted today)', callback_data: 'bops:cash:skip' }],
      backRow(),
      cancelRow(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Summary preview + Confirm
// ---------------------------------------------------------------------------

async function renderSummaryStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;

  // Pull yesterday's pointer counts so the manager sees "what's still
  // open from yesterday" — read-only, deep-link to existing hubs.
  const today = branchOpsService.todayInTz();
  const [yy, mm, dd] = today.split('-').map(Number);
  const yesterday = new Date(Date.UTC(yy, mm - 1, dd - 1)).toISOString().slice(0, 10);
  let ySum = null;
  try { ySum = await branchOpsService.getDailySummary({ branch: session.branch, date: yesterday }); } catch (_) { /* tolerated */ }

  const lines = [
    `🌅 *Open Branch — ${session.branch}*`,
    '',
    `• Camera: ${session.cameraOk ? '✅ Working' : '⚠️ Issue' + (session.cameraNote ? ` (${session.cameraNote})` : '')}`,
    `• Opening cash: ${session.openingCash == null ? '_skipped_' : `₦${fmtNgn(session.openingCash)}`}`,
    '',
    'Step 3 of 3 — *Yesterday\'s carry-over*',
  ];
  if (ySum) {
    lines.push(`• Samples issued: ${ySum.pointers.samples_issued}`);
    lines.push(`• Receipts logged: ${ySum.pointers.receipts_logged}`);
    if (ySum.expenses.pending.count > 0) {
      lines.push(`• Expenses still pending sign-off: *${ySum.expenses.pending.count}* (₦${fmtNgn(ySum.expenses.pending.total)})`);
    }
  } else {
    lines.push('_No data from yesterday._');
  }
  lines.push('');
  lines.push('_Tap Confirm to log the open. Shortcuts to today\'s activities will appear after._');

  await render(bot, chatId, userId, lines.join('\n'), [
    [{ text: '✅ Confirm — open branch', callback_data: 'bops:confirm' }],
    backRow(),
    cancelRow(),
  ]);
}

// ---------------------------------------------------------------------------
// Confirm → openDay → status panel
// ---------------------------------------------------------------------------

async function confirmOpen(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  try {
    await branchOpsService.openDay({
      userId,
      cash: session.openingCash,
      cameraOk: session.cameraOk,
      cameraNote: session.cameraNote,
    });
    session.step = 'open';
    sessionStore.set(userId, session);
    await renderStatusPanel(bot, chatId, userId);
    logger.info(`dailyBranchOpsFlow.confirmOpen: branch=${session.branch} user=${userId} cash=${session.openingCash} cameraOk=${session.cameraOk}`);
  } catch (e) {
    await renderError(bot, chatId, userId, e.message || 'Failed to open branch.');
  }
}

async function renderStatusPanel(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const today = branchOpsService.todayInTz();
  let summary;
  try { summary = await branchOpsService.getDailySummary({ branch: session.branch, date: today }); }
  catch (e) {
    await renderError(bot, chatId, userId, e.message || 'Could not load today\'s summary.');
    return;
  }

  const lines = [];
  lines.push(`🟢 *${session.branch} — open*`);
  lines.push('');
  lines.push(`• Date: ${today}`);
  lines.push(`• Opening cash: ${summary.openingCash > 0 ? `₦${fmtNgn(summary.openingCash)}` : '_not logged_'}`);
  if (summary.camera) {
    lines.push(`• Camera: ${summary.camera.ok ? '✅ OK' : '⚠️ Issue' + (summary.camera.notes ? ` — ${summary.camera.notes}` : '')}`);
  }
  lines.push('');
  if (summary.expenses.approved.count + summary.expenses.pending.count > 0) {
    lines.push('*Today\'s expenses*');
    if (summary.expenses.approved.count) lines.push(`  • Approved: ${summary.expenses.approved.count} (₦${fmtNgn(summary.expenses.approved.total)})`);
    if (summary.expenses.pending.count)  lines.push(`  • Pending:  ${summary.expenses.pending.count} (₦${fmtNgn(summary.expenses.pending.total)})`);
    if (summary.expenses.rejected.count) lines.push(`  • Rejected: ${summary.expenses.rejected.count} (₦${fmtNgn(summary.expenses.rejected.total)})`);
    lines.push('');
  }
  if (summary.pointers.samples_issued + summary.pointers.receipts_logged
      + summary.pointers.customers_added + summary.pointers.marketers_added > 0) {
    lines.push('*Today\'s activity*');
    if (summary.pointers.samples_issued)   lines.push(`  • Samples issued: ${summary.pointers.samples_issued}`);
    if (summary.pointers.receipts_logged)  lines.push(`  • Receipts logged: ${summary.pointers.receipts_logged}`);
    if (summary.pointers.customers_added)  lines.push(`  • Customers added: ${summary.pointers.customers_added}`);
    if (summary.pointers.marketers_added)  lines.push(`  • Marketers added: ${summary.pointers.marketers_added}`);
    lines.push('');
  }
  lines.push('_Tap a shortcut to log activity in today\'s routine._');

  // Shortcuts to existing flows — they write to their own sheets AND
  // call branchOpsService.logPointer afterwards so this panel updates.
  const rows = [
    [
      { text: '💸 Office Expense', callback_data: 'act:office_expense' },
      { text: '🧪 Give Sample',    callback_data: 'act:give_sample' },
    ],
    [
      { text: '🧾 Upload Receipt', callback_data: 'act:upload_receipt' },
      { text: '👤 Add Customer',   callback_data: 'act:add_customer' },
    ],
    [
      { text: '🧑‍💼 Register Marketer', callback_data: 'act:register_marketer' },
    ],
    menuRow(),
  ];
  await render(bot, chatId, userId, lines.join('\n'), rows);
}

// ---------------------------------------------------------------------------
// Text input — applies in steps `camera_note` and `cash`
// ---------------------------------------------------------------------------

async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'daily_branch_ops') return false;
  const chatId = msg.chat.id;
  const raw = (msg.text || '').trim();
  if (raw.startsWith('/')) return false;

  if (session.step === 'camera_note') {
    session.cameraNote = raw.slice(0, 120);
    session.step = 'cash';
    sessionStore.set(userId, session);
    await renderCashStep(bot, chatId, userId);
    return true;
  }

  if (session.step === 'cash') {
    const v = parseFloat(raw.replace(/,/g, ''));
    if (!isFinite(v) || v < 0 || v > branchOpsService.MAX_OPENING_CASH) {
      await renderError(bot, chatId, userId, `Cash must be a non-negative number ≤ ${branchOpsService.MAX_OPENING_CASH.toLocaleString()}.`);
      return true;
    }
    session.openingCash = +v.toFixed(2);
    session.step = 'summary';
    sessionStore.set(userId, session);
    await renderSummaryStep(bot, chatId, userId);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Callback dispatcher
// ---------------------------------------------------------------------------

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('bops:')) return false;
  const chatId = query.message?.chat?.id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'daily_branch_ops') return false;

  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }

  if (data === 'bops:cancel') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '❌ Cancelled.', [menuRow()]);
    return true;
  }
  if (data === 'bops:noop') return true;

  if (data === 'bops:back') {
    await stepBack(bot, chatId, userId);
    return true;
  }

  if (data === 'bops:cam:ok') {
    await pickCamera(bot, chatId, userId, true);
    return true;
  }
  if (data === 'bops:cam:issue') {
    await pickCamera(bot, chatId, userId, false);
    return true;
  }
  if (data === 'bops:cam:skipNote') {
    session.cameraNote = '';
    session.step = 'cash';
    sessionStore.set(userId, session);
    await renderCashStep(bot, chatId, userId);
    return true;
  }
  if (data === 'bops:cash:skip') {
    session.openingCash = null;
    session.step = 'summary';
    sessionStore.set(userId, session);
    await renderSummaryStep(bot, chatId, userId);
    return true;
  }
  if (data === 'bops:confirm') {
    await confirmOpen(bot, chatId, userId);
    return true;
  }
  return false;
}

async function stepBack(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  switch (session.step) {
    case 'camera_note':
    case 'cash':
      session.step = 'camera';
      session.cameraOk = null;
      session.cameraNote = '';
      session.openingCash = null;
      sessionStore.set(userId, session);
      await renderCameraStep(bot, chatId, userId);
      break;
    case 'summary':
      session.step = 'cash';
      session.openingCash = null;
      sessionStore.set(userId, session);
      await renderCashStep(bot, chatId, userId);
      break;
    default:
      sessionStore.clear(userId);
      await render(bot, chatId, userId, '❌ Cancelled.', [menuRow()]);
  }
}

module.exports = {
  start,
  handleCallback,
  handleText,
  _internals: { renderStatusPanel },
};
