'use strict';

/**
 * src/flows/officeExpenseFlow.js — BR-OPS C1.
 *
 * Batch entry of office expenses (water, fuel, sundries) by a branch
 * manager. Single anchored card (UX-C1), one TWO-FIELD form per item:
 *
 *   1. Title  — adaptive quick-pick: a seed set of routine titles blended
 *                with the manager's own most-used titles (time-decayed
 *                frequency, see branchOpsService.rankExpenseTitles), or
 *                [✏️ Other] for free text. As the manager logs expenses,
 *                their real titles get promoted into the grid.
 *   2. Amount — number only (NGN). For a previously-used title the manager
 *                gets a one-tap "✓ ₦X (last time)" suggestion.
 *
 * After each item, manager sees the running batch + a single tap:
 *   [➕ Add another] [✅ Submit batch] [❌ Cancel]
 *
 * `✅ Submit batch` queues ONE approval row (action=record_office_expense)
 * carrying all items. Single-admin sign-off (WRITE_ACTIONS); the admin
 * card lists every item so a typo is visible and can be corrected on the
 * BranchOpsLog sheet before approving (approval only flips status, never
 * rewrites subject/amount). After approval, branchOpsService.applyExpenseBatch
 * flips the eager pending rows on BranchOpsLog to status=approved.
 *
 * Session shape (type: 'office_expense_flow'):
 *   {
 *     step:           'pick_title' | 'free_title' | 'amount' | 'review',
 *     flowMessageId,  startedAt,
 *     items:          [{ title, amount }],
 *     pendingTitle:   string,        // mid-form state
 *     pendingAmount:  number|null,   // last-used amount for pendingTitle (suggestion)
 *     quickPicks:     [{ title, lastAmount }], // loaded once at start
 *   }
 *
 * Callback namespace `ofex:*`:
 *   ofex:cancel
 *   ofex:back
 *   ofex:pick:<index>      pick a quick-pick title by index
 *   ofex:other             free-text title
 *   ofex:useamt            accept the suggested (last-used) amount
 *   ofex:add_more
 *   ofex:submit
 *   ofex:undo              remove last item from the batch
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer } = require('../utils/flowKit');
const branchOpsService = require('../services/branchOpsService');
const approvalEvents = require('../events/approvalEvents');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');

const MAX_ITEMS = 20;
const MAX_CARD_ITEMS = 15;  // cap item lines shown on the admin approval card

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

// Anchored edit-else-send renderer — shared flowKit implementation.
const render = makeRenderer({ requireSession: true });

function backRow()   { return [{ text: '⬅ Back',   callback_data: 'ofex:back'   }]; }
function cancelRow() { return [{ text: '❌ Cancel', callback_data: 'ofex:cancel' }]; }
function menuRow()   { return [{ text: '🏠 Menu',   callback_data: 'act:__back__' }]; }

async function renderError(bot, chatId, userId, msg) {
  const session = sessionStore.get(userId);
  if (!session) { await bot.sendMessage(chatId, `⚠️ ${msg}`); return; }
  await render(bot, chatId, userId, `⚠️ ${msg}`, [
    backRow(),
    cancelRow(),
  ]);
}

function fmtNgn(n) {
  const x = Number(n) || 0;
  return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function escapeMd(s) {
  return String(s || '').replace(/([*_`\[\]])/g, '\\$1');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function start(bot, chatId, userId, messageId) {
  const quickPicks = await branchOpsService
    .getExpenseQuickPicks(String(userId))
    .catch(() => []);
  sessionStore.set(userId, {
    type: 'office_expense_flow',
    step: 'pick_title',
    flowMessageId: messageId || null,
    items: [],
    pendingTitle: '',
    pendingAmount: null,
    quickPicks: quickPicks || [],
    startedAt: new Date().toISOString(),
  });
  await renderTitlePicker(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Step 1 — Title
// ---------------------------------------------------------------------------

async function renderTitlePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;

  const rows = [];
  const picks = session.quickPicks || [];
  if (picks.length) {
    // Two-per-row chips for the adaptive quick-pick titles.
    for (let i = 0; i < picks.length; i += 2) {
      const r = [{ text: picks[i].title.slice(0, 30), callback_data: `ofex:pick:${i}` }];
      if (picks[i + 1]) {
        r.push({ text: picks[i + 1].title.slice(0, 30), callback_data: `ofex:pick:${i + 1}` });
      }
      rows.push(r);
    }
  }
  rows.push([{ text: '✏️ Other (type title)', callback_data: 'ofex:other' }]);
  if (session.items.length) rows.push([{ text: '✅ Submit batch', callback_data: 'ofex:submit' }]);
  rows.push(cancelRow());

  const lines = [];
  lines.push('💸 *Office Expenses*');
  lines.push('');
  if (session.items.length) {
    lines.push(`*Batch so far (${session.items.length} item${session.items.length === 1 ? '' : 's'}):*`);
    for (const it of session.items) {
      lines.push(`  • ${escapeMd(it.title)} — ₦${fmtNgn(it.amount)}`);
    }
    const total = session.items.reduce((s, it) => s + it.amount, 0);
    lines.push(`  *Total: ₦${fmtNgn(total)}*`);
    lines.push('');
    lines.push('Add another expense — pick a routine title or type a new one:');
  } else if (picks.length) {
    lines.push('Pick a routine expense, or tap *✏️ Other* to type a new one:');
  } else {
    lines.push('Tap *✏️ Other* to type the first expense title.');
  }
  await render(bot, chatId, userId, lines.join('\n'), rows);
}

async function pickTitle(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const pick = (session.quickPicks || [])[idx];
  if (!pick) { await renderError(bot, chatId, userId, 'That option is no longer available — pick another.'); return; }
  session.pendingTitle = pick.title;
  session.pendingAmount = pick.lastAmount != null && pick.lastAmount > 0 ? pick.lastAmount : null;
  session.step = 'amount';
  sessionStore.set(userId, session);
  await renderAmountStep(bot, chatId, userId);
}

async function startFreeTitle(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'free_title';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    '💸 *Office Expenses*\n\n'
    + 'Reply with a *short title* for the expense.\n'
    + 'Example: `Water for Mr Adamu`, `Bike fuel`, `Print toner`',
    [
      backRow(),
      cancelRow(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Amount
// ---------------------------------------------------------------------------

async function renderAmountStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const rows = [];
  const suggest = session.pendingAmount;
  if (suggest != null && suggest > 0) {
    rows.push([{ text: `✓ ₦${fmtNgn(suggest)} (last time)`, callback_data: 'ofex:useamt' }]);
  }
  rows.push(backRow());
  rows.push(cancelRow());
  const hint = suggest != null && suggest > 0
    ? 'Reply with the *amount in NGN*, or tap your usual below.'
    : 'Reply with the *amount in NGN*.';
  await render(bot, chatId, userId,
    `💸 *${escapeMd(session.pendingTitle)}*\n\n`
    + `${hint}\nExample: \`800\`  (no commas, no ₦ symbol)`,
    rows,
  );
}

// ---------------------------------------------------------------------------
// Text input — applies in steps `free_title` and `amount`
// ---------------------------------------------------------------------------

async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'office_expense_flow') return false;
  const chatId = msg.chat.id;
  const raw = (msg.text || '').trim();
  if (raw.startsWith('/')) return false;

  if (session.step === 'free_title') {
    const title = raw.slice(0, branchOpsService.MAX_EXPENSE_TITLE_LEN);
    if (!title) { await renderError(bot, chatId, userId, 'Title cannot be empty.'); return true; }
    session.pendingTitle = title;
    session.pendingAmount = null;  // free-text title — no learned suggestion
    session.step = 'amount';
    sessionStore.set(userId, session);
    await renderAmountStep(bot, chatId, userId);
    return true;
  }

  if (session.step === 'amount') {
    const v = parseFloat(raw.replace(/,/g, ''));
    if (!isFinite(v) || v <= 0 || v > branchOpsService.MAX_EXPENSE_AMOUNT) {
      await renderError(bot, chatId, userId, `Amount must be > 0 and ≤ ₦${branchOpsService.MAX_EXPENSE_AMOUNT.toLocaleString()}.`);
      return true;
    }
    await commitItem(bot, chatId, userId, +v.toFixed(2));
    return true;
  }

  return false;
}

/**
 * Append the pending {title, amount} to the batch and route to the next
 * screen (review once MAX_ITEMS is hit, else back to the title picker).
 * Shared by the typed-amount path and the one-tap "use last amount" button.
 *
 * @param {object} bot Telegram bot
 * @param {number|string} chatId
 * @param {string} userId
 * @param {number} amount validated NGN amount
 */
async function commitItem(bot, chatId, userId, amount) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.items.push({ title: session.pendingTitle, amount });
  session.pendingTitle = '';
  session.pendingAmount = null;
  if (session.items.length >= MAX_ITEMS) {
    session.step = 'review';
    sessionStore.set(userId, session);
    await renderReview(bot, chatId, userId);
    return;
  }
  session.step = 'pick_title';
  sessionStore.set(userId, session);
  await renderTitlePicker(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Review (after MAX_ITEMS) — only submit OR cancel from here
// ---------------------------------------------------------------------------

async function renderReview(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const total = session.items.reduce((s, it) => s + it.amount, 0);
  const lines = [
    '💸 *Office Expenses — review*',
    '',
    `Batch (${session.items.length} items, max reached):`,
  ];
  for (const it of session.items) lines.push(`  • ${escapeMd(it.title)} — ₦${fmtNgn(it.amount)}`);
  lines.push(`  *Total: ₦${fmtNgn(total)}*`);
  await render(bot, chatId, userId, lines.join('\n'), [
    [{ text: '✅ Submit batch', callback_data: 'ofex:submit' }],
    [{ text: '↩ Undo last',   callback_data: 'ofex:undo' }],
    cancelRow(),
  ]);
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  if (!session.items.length) {
    await renderError(bot, chatId, userId, 'Batch is empty — add at least one item.');
    return;
  }
  try {
    const { requestId, branch, total, items } = await branchOpsService.submitExpenseBatch({
      userId, items: session.items,
    });
    const isAdm = auth.isAdmin(userId);
    const excludeId = isAdm ? userId : undefined;
    // Itemise the admin card so a spelling mistake is visible: the admin
    // can correct the title/amount on the BranchOpsLog sheet before
    // approving (approval only flips status, never rewrites the cells).
    const itemLines = (items || session.items).map((it) => `• ${it.title} — ₦${fmtNgn(it.amount)}`);
    const shown = itemLines.length > MAX_CARD_ITEMS
      ? itemLines.slice(0, MAX_CARD_ITEMS).concat([`…and ${itemLines.length - MAX_CARD_ITEMS} more`])
      : itemLines;
    const cardSummary = `💸 Office expenses (${branch}) — ${itemLines.length} item(s), ₦${fmtNgn(total)}\n`
      + `${shown.join('\n')}`;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, String(userId),
      cardSummary,
      'record_office_expense single-admin sign-off', excludeId);

    await render(bot, chatId, userId,
      '⏳ *Submitted for sign-off*\n\n'
      + `• Branch: *${branch}*\n`
      + `• Items: *${session.items.length}*\n`
      + `• Total: *₦${fmtNgn(total)}*\n`
      + `• Request: \`${requestId}\`\n\n`
      + '_Pending rows are visible in your branch panel under "Today\'s expenses → Pending". They flip to Approved once the admin signs off._',
      [
        [{ text: '🌅 Branch panel', callback_data: 'act:daily_branch_ops' }],
        menuRow(),
      ],
    );
    sessionStore.clear(userId);
    logger.info(`officeExpenseFlow.submit: branch=${branch} count=${session.items.length} total=${total} request=${requestId} by=${userId}`);
  } catch (e) {
    await renderError(bot, chatId, userId, e.message || 'Could not submit batch.');
  }
}

async function undoLast(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  if (!session.items.length) return;
  const removed = session.items.pop();
  session.step = 'pick_title';
  sessionStore.set(userId, session);
  logger.info(`officeExpenseFlow.undo: removed "${removed.title}" / ₦${removed.amount} from batch by=${userId}`);
  await renderTitlePicker(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Callback dispatcher
// ---------------------------------------------------------------------------

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('ofex:')) return false;
  const chatId = query.message?.chat?.id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'office_expense_flow') return false;

  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }

  if (data === 'ofex:cancel') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '❌ Cancelled.', [menuRow()]);
    return true;
  }
  if (data === 'ofex:back') {
    await stepBack(bot, chatId, userId);
    return true;
  }
  if (data === 'ofex:other') {
    await startFreeTitle(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('ofex:pick:')) {
    const idx = parseInt(data.slice('ofex:pick:'.length), 10);
    await pickTitle(bot, chatId, userId, idx);
    return true;
  }
  if (data === 'ofex:useamt') {
    const amt = session.pendingAmount;
    if (session.step !== 'amount' || amt == null || !(amt > 0)) {
      await renderError(bot, chatId, userId, 'No suggested amount — please type the amount.');
      return true;
    }
    await commitItem(bot, chatId, userId, +Number(amt).toFixed(2));
    return true;
  }
  if (data === 'ofex:submit') {
    await submit(bot, chatId, userId);
    return true;
  }
  if (data === 'ofex:undo') {
    await undoLast(bot, chatId, userId);
    return true;
  }
  return false;
}

async function stepBack(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  switch (session.step) {
    case 'free_title':
    case 'amount':
      session.step = 'pick_title';
      session.pendingTitle = '';
      session.pendingAmount = null;
      sessionStore.set(userId, session);
      await renderTitlePicker(bot, chatId, userId);
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
  _internals: { renderTitlePicker, renderAmountStep, renderReview, submit, undoLast },
};
