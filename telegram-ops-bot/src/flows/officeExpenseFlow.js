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
 * EXP-1 (owner-confirmed layout, 08-Aug-2026) — the flow is now the
 * office's ONE daily record, replacing the Google Form. The entry screen
 * is a category picker; every item stays a two-field form (who/what →
 * amount) and lands as ONE concise BranchOpsLog row:
 *
 *   👤 Person allowance — person chips from the Users sheet (active
 *      staff; joiners/leavers never need a redesign), last-time amount
 *      offered as a one-tap chip. kind=person_allowance, ref_id=user_id.
 *   🧾 Office item      — the original adaptive title picker. kind=expense.
 *   🤝 Commission       — short who/what remark + amount. kind=commission.
 *   ➕ Cash received    — recorded IMMEDIATELY (no approval batch): money
 *      handed to the office moves the computed balance the moment it is
 *      typed. kind=cash_in.
 *   📒 Today's record   — the read-time day card (same shape the finance
 *      team gets at 20:00), with the running balance.
 *   ✅ Nothing spent    — explicit zero-day marker so a missing day and a
 *      zero day are never confused; refused once outflows exist.
 *
 * Outflow items still ride ONE approval batch (record_office_expense,
 * single-admin sign-off — unchanged policy).
 *
 * Callback namespace `ofex:*`:
 *   ofex:cancel
 *   ofex:back
 *   ofex:cat:<off|per|com|cash>   category picker taps
 *   ofex:per:<index>       pick a person by index (session persons list)
 *   ofex:pick:<index>      pick a quick-pick title by index
 *   ofex:other             free-text title
 *   ofex:useamt            accept the suggested (last-used) amount
 *   ofex:today             the day-record card
 *   ofex:zd                zero-day marker (SESSION-FREE — also the chip
 *                          on the 20:00 reminder DM)
 *   ofex:submit
 *   ofex:undo              remove last item from the batch
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, mdEscape: escapeMd, rowsFor } = require('../utils/flowKit');
const branchOpsService = require('../services/branchOpsService');
const approvalEvents = require('../events/approvalEvents');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');
const { fmtQty } = require('../utils/format');

const MAX_ITEMS = 20;
const MAX_CARD_ITEMS = 15;  // cap item lines shown on the admin approval card

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

// Anchored edit-else-send renderer — shared flowKit implementation.
const render = makeRenderer({ requireSession: true });

const { backRow, cancelRow } = rowsFor('ofex');
function menuRow()   { return [{ text: '🏠 Menu',   callback_data: 'act:__back__' }]; }

async function renderError(bot, chatId, userId, msg) {
  const session = sessionStore.get(userId);
  if (!session) { await bot.sendMessage(chatId, `⚠️ ${msg}`); return; }
  await render(bot, chatId, userId, `⚠️ ${msg}`, [
    backRow(),
    cancelRow(),
  ]);
}

function fmtNgn(n) { return fmtQty(n, { maxFraction: 2 }); }

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function start(bot, chatId, userId, messageId) {
  const quickPicks = await branchOpsService
    .getExpenseQuickPicks(String(userId))
    .catch(() => []);
  sessionStore.set(userId, {
    type: 'office_expense_flow',
    step: 'pick_cat',
    flowMessageId: messageId || null,
    items: [],
    pendingTitle: '',
    pendingAmount: null,
    pendingKind: 'expense',
    pendingRef: '',
    persons: null,
    quickPicks: quickPicks || [],
    startedAt: new Date().toISOString(),
  });
  await renderCategoryPicker(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// EXP-1 — Step 0: the category picker (the daily-record home screen)
// ---------------------------------------------------------------------------

const KIND_ICON = { expense: '🧾', person_allowance: '👤', commission: '🤝' };

function batchLines(session) {
  const lines = [];
  if (session.items.length) {
    lines.push(`*Batch so far (${session.items.length} item${session.items.length === 1 ? '' : 's'}):*`);
    for (const it of session.items) {
      lines.push(`  ${KIND_ICON[it.kind] || '🧾'} ${escapeMd(it.title)} — ₦${fmtNgn(it.amount)}`);
    }
    const total = session.items.reduce((s, it) => s + it.amount, 0);
    lines.push(`  *Total: ₦${fmtNgn(total)}*`);
  }
  return lines;
}

async function renderCategoryPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'pick_cat';
  sessionStore.set(userId, session);

  // Best-effort one-line "today" status — a sheet hiccup never blocks
  // entry. EXP-1b: cached ~60s on the session so tapping around the
  // picker doesn't cost a full sheet read per render.
  let todayLine = session._todayLine || '';
  if (!session._todayLineAt || Date.now() - session._todayLineAt > 60 * 1000) {
    try {
      const branch = await branchOpsService.resolveBranch(userId);
      const rep = await branchOpsService.getExpenseDayReport({ branch });
      todayLine = rep.filed
        ? `Recorded today: spent ₦${fmtNgn(rep.spent)} · balance ₦${fmtNgn(rep.balance)}`
        : `Recorded today: nothing yet · balance ₦${fmtNgn(rep.balance)}`;
      session._todayLine = todayLine;
      session._todayLineAt = Date.now();
      sessionStore.set(userId, session);
    } catch (_) { /* line simply absent */ }
  }

  const rows = [
    [{ text: '👤 Person allowance', callback_data: 'ofex:cat:per' },
      { text: '🧾 Office item', callback_data: 'ofex:cat:off' }],
    [{ text: '🤝 Commission', callback_data: 'ofex:cat:com' },
      { text: '➕ Cash received', callback_data: 'ofex:cat:cash' }],
    // EXP-1b — no zero-day chip while unsubmitted items sit in the batch:
    // offering it there was a one-tap contradiction.
    session.items.length
      ? [{ text: '📒 Today’s record', callback_data: 'ofex:today' }]
      : [{ text: '📒 Today’s record', callback_data: 'ofex:today' },
        { text: '✅ Nothing spent today', callback_data: 'ofex:zd' }],
  ];
  if (session.items.length) rows.push([{ text: `✅ Submit batch (${session.items.length})`, callback_data: 'ofex:submit' }]);
  rows.push(cancelRow());
  rows.push(menuRow());

  const lines = ['💸 *Office Expenses*'];
  if (todayLine) lines.push(`_${todayLine}_`);
  lines.push('');
  const batch = batchLines(session);
  if (batch.length) { lines.push(...batch); lines.push(''); }
  lines.push('Pick what you’re adding:');
  await render(bot, chatId, userId, lines.join('\n'), rows);
}

/** EXP-1 — person chips from the Users sheet (active staff only).
 *  EXP-1b — PAGED, never capped: with a big roster the 17th person must
 *  still be reachable, and a new hire must never silently evict anyone. */
const PERSONS_PER_PAGE = 12;

async function renderPersonPicker(bot, chatId, userId, page = null) {
  const session = sessionStore.get(userId);
  if (!session) return;
  let persons = session.persons;
  if (!persons) {
    try {
      const usersRepository = require('../repositories/usersRepository');
      persons = (await usersRepository.getAll())
        .filter((u) => String(u.status || 'active').toLowerCase() === 'active')
        .map((u) => ({ id: String(u.user_id), name: String(u.name || u.user_id).trim() }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      logger.warn(`officeExpenseFlow: users read failed: ${e.message}`);
      persons = [];
    }
    session.persons = persons;
  }
  session.step = 'person_pick';
  if (page != null) session.personPage = page;
  const pages = Math.max(1, Math.ceil(persons.length / PERSONS_PER_PAGE));
  const p = Math.min(Math.max(0, session.personPage || 0), pages - 1);
  session.personPage = p;
  sessionStore.set(userId, session);
  if (!persons.length) {
    await renderError(bot, chatId, userId, 'No active staff found on the Users sheet.');
    return;
  }
  const rows = [];
  const start = p * PERSONS_PER_PAGE;
  const slice = persons.slice(start, start + PERSONS_PER_PAGE);
  for (let i = 0; i < slice.length; i += 2) {
    const gi = start + i;
    const r = [{ text: `👤 ${slice[i].name.slice(0, 26)}`, callback_data: `ofex:per:${gi}` }];
    if (slice[i + 1]) r.push({ text: `👤 ${slice[i + 1].name.slice(0, 26)}`, callback_data: `ofex:per:${gi + 1}` });
    rows.push(r);
  }
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push({ text: '◀ Prev', callback_data: `ofex:pp:${p - 1}` });
    nav.push({ text: `${p + 1}/${pages}`, callback_data: 'ofex:noop' });
    if (p < pages - 1) nav.push({ text: 'Next ▶', callback_data: `ofex:pp:${p + 1}` });
    rows.push(nav);
  }
  rows.push(backRow());
  rows.push(cancelRow());
  await render(bot, chatId, userId,
    '👤 *Person allowance*\n\nWho is this allowance for?', rows);
}

async function pickPerson(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const p = (session.persons || [])[idx];
  if (!p) { await renderError(bot, chatId, userId, 'That option is no longer available — pick again.'); return; }
  session.pendingKind = 'person_allowance';
  session.pendingTitle = p.name;
  session.pendingRef = p.id;
  session.pendingAmount = await branchOpsService.lastAllowanceAmount(p.id).catch(() => null);
  session.step = 'amount';
  sessionStore.set(userId, session);
  await renderAmountStep(bot, chatId, userId);
}

/** EXP-1 — 📒 the day-record card (same shape the finance team gets at 20:00). */
async function renderTodayCard(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  try {
    const branch = await branchOpsService.resolveBranch(userId);
    const rep = await branchOpsService.getExpenseDayReport({ branch });
    const { formatBranchReport } = require('../services/eveningExpenseReport');
    await render(bot, chatId, userId, formatBranchReport(rep), [backRow(), menuRow()]);
  } catch (e) {
    await renderError(bot, chatId, userId, `Could not read today's record: ${e.message}`);
  }
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
  rows.push(backRow('⬅ Categories'));
  rows.push(cancelRow());
  rows.push(menuRow());

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
  session.pendingKind = 'expense';
  session.pendingRef = '';
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

/** EXP-1 — 🤝 commission: short who/what remark, then the amount. */
async function startCommissionNote(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'comm_note';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    '🤝 *Commission*\n\n'
    + 'Reply with *who / what* this commission is for.\n'
    + 'Example: `Sir Pee — 52 bales`, `Silk Abdul 24pcs`',
    [backRow(), cancelRow()]);
}

/** EXP-1 — ➕ cash received: amount only, recorded immediately. */
async function startCashIn(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'cashin_amount';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    '➕ *Cash received*\n\n'
    + 'Reply with the *amount handed to the office* (NGN).\n'
    + '_Recorded immediately — it moves the balance the moment you send it._\n'
    + 'Example: `50000`',
    [backRow(), cancelRow()]);
}

/** EXP-1 — ✅ zero-day marker. SESSION-FREE on purpose: the 20:00 reminder
 *  DM carries this chip, and that tap must work with no flow open.
 *  EXP-1b — a dated chip (ofex:zd:<ISO>) refuses once its day has passed
 *  (a reminder tapped tomorrow must not mark the wrong day), and a live
 *  batch of unsubmitted outflow items refuses too — the sheet guard
 *  cannot see the session. */
async function recordZeroDayTap(bot, query, chipDate) {
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;
  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
  const today = branchOpsService.todayInTz();
  if (chipDate && chipDate !== today) {
    try {
      await bot.editMessageText(
        `ℹ️ That reminder was for ${chipDate} — the day has passed. Today's record is filed separately.`,
        { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [menuRow()] } });
    } catch (_) { /* stale card */ }
    return true;
  }
  const liveSession = sessionStore.get(userId);
  if (liveSession && liveSession.type === 'office_expense_flow'
      && Array.isArray(liveSession.items) && liveSession.items.length) {
    await renderError(bot, chatId, userId,
      'Your batch has unsubmitted items — submit or cancel it; a zero-day would contradict it.');
    return true;
  }
  try {
    const res = await branchOpsService.recordZeroDay({ userId });
    const text = res.already
      ? `✅ Already confirmed: nothing spent today (${res.branch}).`
      : `✅ Recorded: nothing spent today (${res.branch}).`;
    const session = sessionStore.get(userId);
    if (session && session.type === 'office_expense_flow') {
      await render(bot, chatId, userId, `${text}`, [backRow(), menuRow()]);
    } else {
      try {
        await bot.editMessageText(text, {
          chat_id: chatId, message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [menuRow()] },
        });
      } catch (_) { await bot.sendMessage(chatId, text).catch(() => {}); }
    }
  } catch (e) {
    const msg = `⚠️ ${e.message || 'Could not record the zero day.'}`;
    const session = sessionStore.get(userId);
    if (session && session.type === 'office_expense_flow') await renderError(bot, chatId, userId, e.message);
    else await bot.sendMessage(chatId, msg).catch(() => {});
  }
  return true;
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
    session.pendingKind = 'expense';
    session.pendingRef = ''; // EXP-1b — never inherit an abandoned person's id
    session.pendingAmount = null;  // free-text title — no learned suggestion
    session.step = 'amount';
    sessionStore.set(userId, session);
    await renderAmountStep(bot, chatId, userId);
    return true;
  }

  // EXP-1 — commission remark → amount step, same two-field shape.
  if (session.step === 'comm_note') {
    const note = raw.slice(0, branchOpsService.MAX_EXPENSE_TITLE_LEN);
    if (!note) { await renderError(bot, chatId, userId, 'The who/what note cannot be empty.'); return true; }
    session.pendingTitle = note;
    session.pendingKind = 'commission';
    session.pendingRef = '';
    session.pendingAmount = null;
    session.step = 'amount';
    sessionStore.set(userId, session);
    await renderAmountStep(bot, chatId, userId);
    return true;
  }

  // EXP-1 — cash received: recorded immediately, shows the new balance.
  if (session.step === 'cashin_amount') {
    const v = parseFloat(raw.replace(/,/g, ''));
    if (!isFinite(v) || v <= 0) {
      await renderError(bot, chatId, userId, 'Amount must be a number > 0.');
      return true;
    }
    try {
      const res = await branchOpsService.recordCashIn({ userId, amount: v });
      session.step = 'pick_cat';
      sessionStore.set(userId, session);
      await render(bot, chatId, userId,
        `➕ *Cash received — recorded*\n\n₦${fmtNgn(res.amount)} added (${escapeMd(res.branch)}).\nBalance in hand: *₦${fmtNgn(res.balance)}*`,
        [backRow(), menuRow()]);
    } catch (e) {
      await renderError(bot, chatId, userId, e.message);
    }
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
  // EXP-1 — the item keeps its kind + ref so the sheet row stays concise
  // and typed (person_allowance carries the person's user_id in ref_id).
  session.items.push({
    kind: session.pendingKind || 'expense',
    title: session.pendingTitle,
    amount,
    ref_id: session.pendingRef || '',
  });
  session.pendingTitle = '';
  session.pendingAmount = null;
  session.pendingKind = 'expense';
  session.pendingRef = '';
  if (session.items.length >= MAX_ITEMS) {
    session.step = 'review';
    sessionStore.set(userId, session);
    await renderReview(bot, chatId, userId);
    return;
  }
  session.step = 'pick_cat';
  sessionStore.set(userId, session);
  await renderCategoryPicker(bot, chatId, userId);
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
  for (const it of session.items) lines.push(`  ${KIND_ICON[it.kind] || '🧾'} ${escapeMd(it.title)} — ₦${fmtNgn(it.amount)}`);
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
    const itemLines = (items || session.items).map((it) => `${KIND_ICON[it.kind] || '🧾'} ${it.title} — ₦${fmtNgn(it.amount)}`);
    const shown = itemLines.length > MAX_CARD_ITEMS
      ? itemLines.slice(0, MAX_CARD_ITEMS).concat([`…and ${itemLines.length - MAX_CARD_ITEMS} more`])
      : itemLines;
    const cardSummary = `💸 Office expenses (${branch}) — ${itemLines.length} item(s), ₦${fmtNgn(total)}\n`
      + `${shown.join('\n')}`;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId,
      await require('../services/approvalCards').resolveUserLabel(userId, bot),
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

  // EXP-1 — the zero-day chip is SESSION-FREE: it lives on the 20:00
  // reminder DM and must work with no flow open. Dated form: ofex:zd:<ISO>.
  if (data === 'ofex:zd' || data.startsWith('ofex:zd:')) {
    return recordZeroDayTap(bot, query, data.startsWith('ofex:zd:') ? data.slice('ofex:zd:'.length) : null);
  }

  const session = sessionStore.get(userId);
  if (!session || session.type !== 'office_expense_flow') {
    // EXP-1b — a chip from an expired flow must explain itself, not fall
    // through to the controller's terminal "Unknown action.".
    try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
    try {
      await bot.sendMessage(chatId, '💸 That Office Expenses card expired — open 💸 Office Expense from the menu to continue. Unsubmitted items were not saved.');
    } catch (_) { /* best-effort */ }
    return true;
  }

  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }

  // EXP-1 — category picker taps.
  if (data === 'ofex:cat:per') { await renderPersonPicker(bot, chatId, userId); return true; }
  if (data === 'ofex:cat:off') {
    session.step = 'pick_title';
    sessionStore.set(userId, session);
    await renderTitlePicker(bot, chatId, userId);
    return true;
  }
  if (data === 'ofex:cat:com') { await startCommissionNote(bot, chatId, userId); return true; }
  if (data === 'ofex:cat:cash') { await startCashIn(bot, chatId, userId); return true; }
  if (data === 'ofex:today') { await renderTodayCard(bot, chatId, userId); return true; }
  if (data === 'ofex:noop') { return true; }
  if (data.startsWith('ofex:pp:')) {
    await renderPersonPicker(bot, chatId, userId, parseInt(data.slice('ofex:pp:'.length), 10) || 0);
    return true;
  }
  if (data.startsWith('ofex:per:')) {
    await pickPerson(bot, chatId, userId, parseInt(data.slice('ofex:per:'.length), 10));
    return true;
  }

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
      session.pendingTitle = '';
      session.pendingAmount = null;
      session.step = 'pick_title';
      sessionStore.set(userId, session);
      await renderTitlePicker(bot, chatId, userId);
      break;
    case 'amount':
      // EXP-1 — back returns to where the item came from.
      session.pendingTitle = '';
      session.pendingAmount = null;
      if (session.pendingKind === 'person_allowance') { await renderPersonPicker(bot, chatId, userId); break; }
      if (session.pendingKind === 'commission') { await startCommissionNote(bot, chatId, userId); break; }
      session.step = 'pick_title';
      sessionStore.set(userId, session);
      await renderTitlePicker(bot, chatId, userId);
      break;
    case 'pick_title':
    case 'person_pick':
    case 'comm_note':
    case 'cashin_amount':
    case 'pick_cat':
      // EXP-1 — every sub-screen backs out to the category picker; the
      // error card's ⬅ Back must never destroy the batch.
      await renderCategoryPicker(bot, chatId, userId);
      break;
    case 'review':
      await renderReview(bot, chatId, userId);
      break;
    default:
      await render(bot, chatId, userId, '❌ Cancelled.', [menuRow()]);
      sessionStore.clear(userId);
  }
}

module.exports = {
  start,
  handleCallback,
  handleText,
  _internals: { renderTitlePicker, renderAmountStep, renderReview, submit, undoLast },
};
