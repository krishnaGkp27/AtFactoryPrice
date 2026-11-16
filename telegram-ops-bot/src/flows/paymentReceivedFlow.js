'use strict';

/**
 * PRC-1 — 💰 Finance → 💵 Payment Received.
 *
 * A customer pays against what they owe. Until 01-Nov-2026 the only way to
 * record that was a typed sentence the AI read ("Record payment 50000 from
 * Ibrahim via bank"); TXT-1 switched the AI off for anything that changes
 * the sheet, and the owner ruled that the typed line waits for a tap door.
 * This is that door (APG-1 phase 3, owner's go 11-Nov-2026).
 *
 *   1. who paid     tap a customer (A–Z, eight a page) or type part of a name
 *   2. how much     type the amount
 *   3. paid how     💵 Cash · 🏦 one chip per bank in Settings BANK_LIST
 *   4. confirm      ✅ Submit for approval
 *
 * It raises the SAME `record_payment` request the typed line raised — same
 * action code, same executor (crmService.recordPayment), same approval
 * (ALWAYS_APPROVAL_ACTIONS) — through approvalGate.raise. A bank chip stores
 * `Bank — <name>`, so the money lands in the Bank ledger: the typed line
 * sent any wording without the word "bank" to Cash.
 *
 * No balance is shown to the person entering the payment (FIN-V2: customer
 * outstanding is admins-only). The admin's approval card carries it.
 *
 * PRC-2 (owner, 16-Nov-2026) — "the employee will select the admin from the
 * admin list to send for approval"; "if the amount is known … I will attach
 * the amount also". Two more things, rulings R1–R3:
 *
 *   4. who approves  🛂 one chip per admin (the requester never listed) ·
 *                    👥 Any admin; skipped when only one admin can approve.
 *                    The named admin gets the card first (askedApprover);
 *                    the count of approvals does not change.
 *   2. how much      an EMPLOYEE may tap ⏭ Amount not known — the admin
 *                    giving the FIRST approval types it (the admin amount
 *                    step below); the second admin's approval checks it.
 *
 * Callback namespace `prc:` — pg:<n> · c:<i> · m:<i> · noamt · ad:<i>|any ·
 * submit · back · cancel · noop; and the admin's amount step, SESSION-FREE
 * (re-checked on every tap): ay:<requestId>:<amount> ✅ Approve with ·
 * ae:<requestId> ✏️ Change amount · ax:<requestId> ✖ Not now.
 */

const sessionStore = require('../utils/sessionStore');
const { mdEscape, rowsFor, beginSubmit, endSubmit } = require('../utils/flowKit');
const customersRepository = require('../repositories/customersRepository');
const settingsRepository = require('../repositories/settingsRepository');
const approvalCards = require('../services/approvalCards');
const riskEvaluate = require('../risk/evaluate');
const idGenerator = require('../utils/idGenerator');
const money = require('../utils/money');
const fmtDate = require('../utils/formatDate');
const { todayInLagos } = require('../utils/dates');
const auth = require('../middlewares/auth');
const config = require('../config');
const askedApprover = require('../services/askedApprover');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const logger = require('../utils/logger');

const SESSION_TYPE = 'payment_received_flow';
const NS = 'prc';
const PAGE_SIZE = 8;
const HIDDEN = new Set(['merged', 'rejected', 'inactive', 'pending']);
const MAX_AMOUNT = 1e10;
const { cancelRow } = rowsFor(NS);
const TITLE = '💵 *Payment received*';

async function render(bot, chatId, userId, text, rows) {
  const session = sessionStore.get(userId);
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  if (session && session.flowMessageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: session.flowMessageId, ...opts });
      return;
    } catch (e) {
      if (/message is not modified/i.test(String(e && e.message))) return;
    }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  const s = sessionStore.get(userId);
  if (s && sent && sent.message_id) { s.flowMessageId = sent.message_id; sessionStore.set(userId, s); }
}

async function customers(query = '') {
  const all = await customersRepository.getAll();
  const q = String(query || '').trim().toLowerCase();
  return all
    .filter((c) => c.customer_id && c.name)
    .filter((c) => !HIDDEN.has(String(c.status || 'Active').trim().toLowerCase()))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || String(c.phone || '').includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/**
 * "50,000" · "50000" · "50k" · "1.5m" → a number, or null. Pure.
 * A typed naira sign (U+20A6) is tolerated on the way IN; nothing on this
 * side of the business ever prints one (CUR-1: sale figures are bare).
 */
function parseAmount(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[\u20a6,\s]/g, '');
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1);
  return Number.isFinite(n) && n > 0 && n <= MAX_AMOUNT ? Math.round(n * 100) / 100 : null;
}

async function bankList() {
  try {
    const all = (await settingsRepository.getAll()) || {};
    return String(all.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean).slice(0, 12);
  } catch (_) { return []; }
}

async function start(bot, chatId, userId, messageId = null) {
  sessionStore.set(String(userId), {
    type: SESSION_TYPE, step: 'pick', flowMessageId: messageId || null,
    page: 0, query: '', customer: null, amount: null, method: '',
    noAmount: false, asked: null,
  });
  await renderPick(bot, chatId, String(userId));
}

async function renderPick(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  let list = [];
  let unreadable = false;
  try { list = await customers(session.query); } catch (e) {
    unreadable = true;
    logger.warn(`paymentReceivedFlow: customers read failed: ${e.message}`);
  }
  const rows = [];
  if (!list.length) {
    session.step = 'pick'; session._pick = []; sessionStore.set(userId, session);
    rows.push(cancelRow());
    const why = unreadable ? 'The customer list could not be read just now. Try again in a moment.'
      : session.query ? `No customer matches "${mdEscape(session.query)}". Type another name.`
        : 'There is no customer on the list yet.';
    await render(bot, chatId, userId, `${TITLE}\n\n_${why}_`, rows);
    return;
  }
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, session.page || 0), pages - 1);
  const slice = list.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  session.step = 'pick';
  session.page = page;
  session._pick = slice.map((c) => ({ id: c.customer_id, name: c.name }));
  sessionStore.set(userId, session);
  slice.forEach((c, i) => rows.push([{ text: `👤 ${c.name}`.slice(0, 60), callback_data: `${NS}:c:${i}` }]));
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '◀ Back', callback_data: `${NS}:pg:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: `${NS}:noop` });
    if (page < pages - 1) nav.push({ text: 'Next ▶', callback_data: `${NS}:pg:${page + 1}` });
    rows.push(nav);
  }
  rows.push(cancelRow());
  const filter = session.query ? `\n🔎 _${mdEscape(session.query)}_ · ${list.length} match${list.length === 1 ? '' : 'es'}` : '';
  await render(bot, chatId, userId,
    `${TITLE}\n\nWho paid?\nTap the customer, or type part of the name.${filter}`, rows);
}

async function renderAmount(bot, chatId, userId, note = '') {
  const session = sessionStore.get(userId);
  if (!session || !session.customer) return;
  session.step = 'amount'; sessionStore.set(userId, session);
  // PRC-2 (D2) — only an EMPLOYEE may leave the amount blank: an admin's own
  // entry has one approver, who would then check a figure they typed.
  const blankOk = !auth.isAdmin(userId);
  const rows = [];
  if (blankOk) rows.push([{ text: '⏭ Amount not known', callback_data: `${NS}:noamt` }]);
  rows.push([{ text: '⬅ Back', callback_data: `${NS}:back` }, ...cancelRow()]);
  await render(bot, chatId, userId,
    `${TITLE}\n\nCustomer: *${mdEscape(session.customer.name)}*\n\nHow much did they pay?\nType the amount, for example \`50000\`.`
    + `${blankOk ? '\nIf you do not know it, tap ⏭ Amount not known — the admin enters it.' : ''}${note ? `\n\n${note}` : ''}`,
    rows);
}

/** The amount line of the employee's own screens (bold figure, or the blank). */
function amountLine(session) {
  return session.noAmount ? 'Amount: to be entered by the admin' : `Amount: *${money.sale(session.amount)}*`;
}

async function renderMethod(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.customer || !(session.amount || session.noAmount)) return;
  const banks = await bankList();
  session.step = 'method';
  session._methods = ['Cash', ...banks.map((b) => `Bank — ${b}`)];
  sessionStore.set(userId, session);
  const rows = [[{ text: '💵 Cash', callback_data: `${NS}:m:0` }]];
  banks.forEach((b, i) => rows.push([{ text: `🏦 ${b}`.slice(0, 60), callback_data: `${NS}:m:${i + 1}` }]));
  rows.push([{ text: '⬅ Back', callback_data: `${NS}:back` }, ...cancelRow()]);
  await render(bot, chatId, userId,
    `${TITLE}\n\nCustomer: *${mdEscape(session.customer.name)}*\n${amountLine(session)}\n\nHow was it paid?`, rows);
}

/**
 * PRC-2 — the admins who can approve this person's request: the env admin
 * pool minus the requester, each with the name the approval cards use. Two
 * identical names are told apart by the last four digits of the id.
 */
async function approverChoices(bot, userId) {
  const ids = config.access.adminIds.map(String).filter((id) => id !== String(userId));
  const out = [];
  for (const id of ids) {
    let name = '';
    try { name = await approvalCards.resolveUserLabel(id, bot); } catch (_) { /* the fallback below */ }
    if (!name || name === 'Unknown' || name === id) name = `Admin ${id.slice(-4)}`;
    out.push({ id, name });
  }
  const count = new Map();
  out.forEach((a) => count.set(a.name, (count.get(a.name) || 0) + 1));
  return out.map((a) => (count.get(a.name) > 1 ? { ...a, name: `${a.name} ${a.id.slice(-4)}` } : a));
}

/**
 * Step 4 (PRC-2) — who should approve it. With two or more admins able to
 * approve: the step. One or none: skipped, nothing recorded as asked (D3).
 */
async function renderApprover(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.customer || !session.method) return;
  const choices = await approverChoices(bot, userId);
  if (choices.length < 2) {
    session._admins = []; session.asked = null; sessionStore.set(userId, session);
    await renderConfirm(bot, chatId, userId);
    return;
  }
  session.step = 'approver';
  session._admins = choices;
  sessionStore.set(userId, session);
  const rows = choices.map((a, i) => [{ text: `🛂 ${a.name}`.slice(0, 60), callback_data: `${NS}:ad:${i}` }]);
  rows.push([{ text: '👥 Any admin', callback_data: `${NS}:ad:any` }]);
  rows.push([{ text: '⬅ Back', callback_data: `${NS}:back` }, ...cancelRow()]);
  await render(bot, chatId, userId,
    `${TITLE}\n\nCustomer: *${mdEscape(session.customer.name)}*\n${amountLine(session)}\nPaid by: ${mdEscape(session.method)}\n\nWho should approve it?\nThe admin you pick is asked first.`,
    rows);
}

function summaryLines(session) {
  return [
    `Customer: *${mdEscape(session.customer.name)}*`,
    amountLine(session),
    `Paid by: ${mdEscape(session.method)}`,
    ...(session.asked ? [`Ask: ${mdEscape(session.asked.name)}`] : []),
    `Date: ${fmtDate(todayInLagos())}`,
  ].join('\n');
}

/** The confirm card's closing sentence (PRC-2 §4 table). */
function closingSentence(session, userId) {
  const admin = auth.isAdmin(userId);
  const who = session.asked ? mdEscape(session.asked.name) : '';
  let line;
  // Owner ruling 15-Nov-2026: a customer's payment needs TWO admins (an
  // admin's own entry: one OTHER admin) — the card says what really happens.
  if (admin) {
    line = who ? `${who} is asked to approve it before the customer's balance moves.`
      : 'Another admin approves it before the customer\'s balance moves.';
  } else {
    line = who ? `${who} is asked first. Two admins approve it before the customer's balance moves.`
      : 'Two admins approve it before the customer\'s balance moves.';
  }
  return session.noAmount ? `The admin enters the amount. ${line}` : line;
}

async function renderConfirm(bot, chatId, userId, note = '') {
  const session = sessionStore.get(userId);
  if (!session || !session.customer || !(session.amount || session.noAmount) || !session.method) return;
  session.step = 'confirm';
  // One id per confirm cycle: a retry of this Submit is the same request.
  if (!session.requestId) session.requestId = idGenerator.requestId();
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `${TITLE}\n\n${summaryLines(session)}\n\n${closingSentence(session, userId)}${note ? `\n\n${note}` : ''}`,
    [[{ text: '✅ Submit for approval', callback_data: `${NS}:submit` }],
      [{ text: '⬅ Back', callback_data: `${NS}:back` }, ...cancelRow()]]);
}

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.step !== 'confirm' || !session.requestId) return;
  if (!beginSubmit(session, userId)) return;
  const asked = session.asked ? { id: String(session.asked.id), name: String(session.asked.name) } : null;
  const payload = {
    customer: session.customer.name, customerId: session.customer.id,
    // PRC-2 — a blank amount rides as `amountPending`, never as 0.
    ...(session.noAmount ? { amountPending: true } : { amount: session.amount }),
    method: session.method, source: 'payment_received_door',
    ...(asked ? { askedAdmin: asked } : {}),
  };
  try {
    const risk = await riskEvaluate.evaluate({ action: 'record_payment', userId });
    const gate = require('../services/approvalGate');
    const raised = await gate.raise({
      requestId: session.requestId, userId, action: 'record_payment', payload,
      riskReason: risk.reason || 'Admin approval required',
      auditMeta: { reason: 'record_payment', via: 'payment_received_door', amount: session.noAmount ? null : session.amount,
        asked: asked ? asked.id : '', amountPending: !!session.noAmount },
    });
    const requestId = raised.requestId;
    let sent = 1;
    let unreachable = false;
    if (raised.created) {
      const card = await approvalCards.buildPaymentCard(payload);
      const label = await approvalCards.resolveUserLabel(userId, bot);
      const approvalEvents = require('../events/approvalEvents');
      const excludeAdmin = auth.isAdmin(userId) ? userId : undefined;
      const reason = risk.reason || 'Admin approval required';
      if (asked) {
        // PRC-2 (owner, 16-Nov-2026) — the named admin is asked FIRST: the
        // card goes to them alone. The others see it in 🛂 Approvals and get
        // it at the first signature, or after ASKED_ADMIN_WIDEN_HOURS.
        const others = config.access.adminIds.map(String).filter((id) => id !== asked.id);
        const res = await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, label, card, reason, excludeAdmin,
          { excludeIds: others, prependNote: askedApprover.askYouNote(label) });
        sent = (res && res.sent) || 0;
        if (!sent) {
          // Never stuck on one person (R2): an asked admin who cannot be
          // reached hands the card to every other admin at once.
          unreachable = true;
          const res2 = await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, label, card, reason, excludeAdmin,
            { excludeIds: [asked.id], prependNote: `🙋 Asked: ${asked.name} (could not be reached)` });
          sent = (res2 && res2.sent) || 0;
          try {
            await approvalQueueRepository.updateActionJSON(requestId, { askWidenedAt: new Date().toISOString() });
          } catch (e) { logger.warn(`PRC-2: askWidenedAt for ${requestId} not saved: ${e.message}`); }
        }
      } else {
        const res = await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, label, card, reason, excludeAdmin);
        sent = (res && res.sent) || 0;
      }
    }
    const warn = sent === 0 ? '\n\n⚠️ The admins could not be notified just now. Ask an admin to open 🛂 Approvals.'
      : unreachable ? `\n\n⚠️ ${mdEscape(asked.name)} could not be reached — sent to the other admins.` : '';
    const head = asked ? `⏳ *Sent to ${mdEscape(asked.name)} for approval*` : '⏳ *Sent for approval*';
    await render(bot, chatId, userId,
      `${head}\n\n${summaryLines(session)}\nRef ${approvalCards.shortRequestRef(requestId)}${warn}`,
      [gate.receiptRow(requestId), [{ text: '💵 Record another', callback_data: 'act:payment_received' }, { text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    sessionStore.clear(userId);
  } catch (e) {
    logger.error(`paymentReceivedFlow.submit failed: ${e.message}`);
    endSubmit(session, userId);
    await renderConfirm(bot, chatId, userId, `⚠️ Could not send: ${mdEscape(e.message)}. Tap Submit again.`);
  }
}

/* ── PRC-2: the admin's amount step ──────────────────────────────────── */

const ADMIN_TITLE_ASK = '💵 *Payment received · amount needed*';
const ADMIN_TITLE_CHECK = '💵 *Payment received · check the amount*';
const NOT_NOW = 'Nothing was approved. The request still waits.';

/** A positive amount on the row, or 0. */
function rowAmount(aj) {
  const n = Number(aj && aj.amount);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** `Outstanding today: 120,000` (+ after / exceeds when an amount is given), admins only. */
async function balanceLines(customer, amount) {
  try {
    const { outstandingAsOfToday } = await require('../services/accountingService').getCustomerLedger(customer);
    const lines = [`Outstanding today: ${money.sale(outstandingAsOfToday)}`];
    if (amount > 0) {
      const after = Number(outstandingAsOfToday) - amount;
      lines.push(`After this payment: ${money.sale(after)}`);
      if (after < 0) lines.push('⚠️ Payment EXCEEDS the outstanding balance.');
    }
    return lines;
  } catch (_) { return ['(Outstanding balance unavailable right now.)']; }
}

async function nameOf(id, bot) {
  try { return await approvalCards.resolveUserLabel(String(id), bot); } catch (_) { return String(id); }
}

/**
 * The approvals this request needs and has — the gate's own rule
 * (approvalGate.requiredFor → risk/evaluate.requiredAdminApprovals).
 */
function approvalCount(row) {
  const required = require('../services/approvalGate').requiredFor(row);
  const signed = Array.isArray(row && row.actionJSON && row.actionJSON.approvals) ? row.actionJSON.approvals.length : 0;
  return { required, signed };
}

async function adminPromptText(bot, row) {
  const aj = row.actionJSON || {};
  const raisedBy = await nameOf(row.user, bot);
  return [
    ADMIN_TITLE_ASK, '',
    `Customer: *${mdEscape(aj.customer)}*`,
    `Paid by: ${mdEscape(aj.method || '—')}`,
    `Raised by: ${mdEscape(raisedBy)}`,
    ...(await balanceLines(aj.customer, 0)),
    '',
    `${mdEscape(raisedBy)} did not know the amount. Type what ${mdEscape(aj.customer)} paid, for example \`50000\`.`,
    'Nothing is approved until you confirm.',
  ].join('\n');
}

async function adminCheckText(row, amount) {
  const aj = row.actionJSON || {};
  const { required, signed } = approvalCount(row);
  const completes = signed + 1 >= required;
  return [
    ADMIN_TITLE_CHECK, '',
    `Customer: *${mdEscape(aj.customer)}*`,
    `Amount: *${money.sale(amount)}* · entered by you`,
    `Paid by: ${mdEscape(aj.method || '—')}`,
    ...(await balanceLines(aj.customer, amount)),
    '',
    completes ? 'Your approval records the payment.'
      : `Your approval is the first of ${required === 2 ? 'two' : required}. A second admin checks the amount.`,
  ].join('\n');
}

const notNowRow = (requestId) => [{ text: '✖ Not now', callback_data: `${NS}:ax:${requestId}` }];

function checkKeyboard(requestId, amount) {
  return [
    [{ text: `✅ Approve with ${money.sale(amount)}`, callback_data: `${NS}:ay:${requestId}:${amount}` }],
    [{ text: '✏️ Change amount', callback_data: `${NS}:ae:${requestId}` }, ...notNowRow(requestId)],
  ];
}

/**
 * Open the typed amount step for one admin over a live session (NAV-1:
 * the other flow's messages come down; the approval card stays).
 */
async function openAdminAmount(bot, chatId, adminId, row, { cardMessageId = null, editMessageId = null } = {}) {
  const live = sessionStore.get(adminId);
  if (live && !(live.type === SESSION_TYPE && live.step === 'admin_amount')) {
    try { await require('../services/sessionJanitor').leaveFlow(bot, adminId, cardMessageId || editMessageId); } catch (_) { /* best-effort */ }
  }
  const text = await adminPromptText(bot, row);
  const kb = { inline_keyboard: [notNowRow(row.requestId)] };
  let messageId = editMessageId;
  if (editMessageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: editMessageId, parse_mode: 'Markdown', reply_markup: kb });
    } catch (e) {
      if (!/message is not modified/i.test(String(e && e.message))) messageId = null;
    }
  }
  if (!messageId) {
    const sent = await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown', reply_markup: kb,
      ...(cardMessageId ? { reply_to_message_id: cardMessageId, allow_sending_without_reply: true } : {}),
    });
    messageId = sent && sent.message_id;
  }
  sessionStore.set(adminId, {
    type: SESSION_TYPE, step: 'admin_amount', requestId: row.requestId,
    flowMessageId: messageId || null, cardMessageId: cardMessageId || null,
  });
}

/**
 * PRC-2 seam 1 — called by approvalEvents.handleApprovalCallback for an
 * Approve on a `record_payment`, after the already-decided, self-approval
 * and super-admin guards and before the two-admin gate, outside any catch
 * that falls back to single approval.
 *
 *   row has an amount, no typed amount   → `{ stop:false }` (nothing changes)
 *   row has none, no typed amount        → the amount step opens; nothing is
 *                                          recorded; `{ stop:true }`
 *   row has none, a typed amount         → saved on the row with `amountBy`;
 *                                          a refused save stops; else
 *                                          `{ stop:false }` and the caller's
 *                                          gate records this admin's approval
 *   row has one, a typed amount          → a stale chip: approves nothing,
 *                                          `{ stop:true }` (unless it is this
 *                                          admin's own same figure — a retry)
 *
 * @returns {Promise<{stop:boolean}>}
 */
async function amountSeam(bot, callbackQuery, requestId, item, typed) {
  const adminId = String(callbackQuery.from.id);
  const aj = (item && item.actionJSON) || {};
  const toast = async (text, alert) => {
    try { await bot.answerCallbackQuery(callbackQuery.id, { text, show_alert: !!alert }); } catch (_) { /* stale query */ }
  };
  const want = typed === undefined || typed === null ? 0 : (parseAmount(String(typed)) || 0);
  const have = rowAmount(aj);
  if (have) {
    if (!want) return { stop: false };
    const by = aj.amountBy || {};
    if (String(by.id || '') === adminId && Math.abs(have - want) < 0.005) return { stop: false }; // a retry of one's own entry
    const who = by.name || (by.id ? await nameOf(by.id, bot) : 'The requester');
    await toast(`${who} already entered ${money.sale(have)} for this payment. Open the card to approve or reject it.`, true);
    return { stop: true };
  }
  if (!want) {
    await toast('Type the amount first.');
    try {
      await openAdminAmount(bot, callbackQuery.message.chat.id, adminId, { ...item, requestId },
        { cardMessageId: callbackQuery.message.message_id });
    } catch (e) { logger.warn(`PRC-2: amount step for ${requestId} not drawn: ${e.message}`); }
    return { stop: true };
  }
  const amountBy = { id: adminId, name: await nameOf(adminId, bot), at: new Date().toISOString() };
  let saved = false;
  try {
    saved = await approvalQueueRepository.updateActionJSON(requestId, { amount: want, amountPending: false, amountBy });
  } catch (e) {
    logger.error(`PRC-2 amount save failed for ${requestId} — nothing approved: ${e.message}`);
  }
  if (!saved) {
    await toast('⚠️ Could not save the amount — nothing was approved. Tap again in a minute.', true);
    return { stop: true };
  }
  Object.assign(aj, { amount: want, amountPending: false, amountBy });
  if (item) item.actionJSON = aj;
  try {
    await require('../repositories/auditLogRepository').append('payment_received_amount_entered',
      { requestId, amount: want, customer: aj.customer }, adminId);
  } catch (e) { logger.warn(`PRC-2 amount audit for ${requestId} failed: ${e.message}`); }
  return { stop: false };
}

/**
 * Every tap on the admin's amount step re-checks the request (the chips are
 * session-free). Returns the live row, or null after saying what is true.
 */
async function liveForAmount(bot, query, requestId) {
  const uid = String(query.from.id);
  const answer = async (text, alert) => {
    try { await bot.answerCallbackQuery(query.id, text ? { text, show_alert: !!alert } : undefined); } catch (_) { /* stale */ }
  };
  const close = async (text) => {
    try {
      await bot.editMessageText(text, { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
    } catch (_) { /* too old to edit */ }
  };
  if (!config.access.adminIds.map(String).includes(uid)) { await answer('Only admins can approve.', true); return null; }
  let row = null;
  try { row = await approvalQueueRepository.getByRequestId(requestId); } catch (_) { /* unreadable: said below */ }
  if (!row) { await answer('That request could not be read just now. Try again in a minute.', true); return null; }
  const aj = row.actionJSON || {};
  if (aj.action !== 'record_payment') { await answer('Not a payment received.', true); return null; }
  const st = String(row.status || '').toLowerCase();
  if (st !== 'pending') {
    await answer(`Already ${st} — nothing to do.`);
    await close(`Already ${st} — nothing to do.`);
    if (sessionStore.get(uid) && sessionStore.get(uid).type === SESSION_TYPE) sessionStore.clear(uid);
    return null;
  }
  if (String(row.user) === uid) {
    await answer('🔒 You cannot enter the amount on your own request.', true);
    return null;
  }
  return row;
}

async function adminCallback(bot, query, rest) {
  const uid = String(query.from.id);
  const chatId = query.message.chat.id;
  const answer = async (text, alert) => {
    try { await bot.answerCallbackQuery(query.id, text ? { text, show_alert: !!alert } : undefined); } catch (_) { /* stale */ }
  };
  const verb = rest.slice(0, 2);
  const body = rest.slice(3);
  if (verb === 'ax') {
    if (!config.access.adminIds.map(String).includes(uid)) { await answer('Only admins can approve.', true); return; }
    await answer();
    let st = 'pending';
    try {
      const row = await approvalQueueRepository.getByRequestId(body);
      if (row) st = String(row.status || 'pending').toLowerCase();
    } catch (_) { /* unreadable: the usual sentence */ }
    const live = sessionStore.get(uid);
    if (live && live.type === SESSION_TYPE && live.step === 'admin_amount') sessionStore.clear(uid);
    try {
      await bot.editMessageText(st === 'approved' || st === 'rejected' ? `Already ${st} — nothing to do.` : NOT_NOW,
        { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
    } catch (_) { /* too old to edit */ }
    return;
  }
  // Request ids carry hyphens, never a colon: the amount is after the LAST one.
  const cut = verb === 'ay' ? body.lastIndexOf(':') : -1;
  const requestId = cut > 0 ? body.slice(0, cut) : body;
  const row = await liveForAmount(bot, query, requestId);
  if (!row) return;
  const aj = row.actionJSON || {};
  const have = rowAmount(aj);
  const amount = verb === 'ay' ? parseAmount(body.slice(cut + 1)) : null;
  const byMe = aj.amountBy && String(aj.amountBy.id) === uid && amount && Math.abs(have - amount) < 0.005;
  if (have && !byMe) {
    const by = aj.amountBy || {};
    const who = by.name || (by.id ? await nameOf(by.id, bot) : 'The requester');
    const said = `${who} already entered ${money.sale(have)} for this payment. Open the card to approve or reject it.`;
    await answer(said, true);
    try { await bot.editMessageText(said, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch (_) { /* too old */ }
    return;
  }
  const cardMsg = query.message.reply_to_message || null;
  if (verb === 'ae') {
    await answer();
    await openAdminAmount(bot, chatId, uid, row,
      { cardMessageId: cardMsg ? cardMsg.message_id : null, editMessageId: query.message.message_id });
    return;
  }
  if (verb !== 'ay' || !amount) { await answer('That is not an amount.', true); return; }
  // Hand the tap to the standard approval handler as THIS admin's Approve,
  // carrying the amount: every guard runs again before the amount is saved
  // (PAY-6 pay:from is the model). Pointed at the approval card when it still
  // carries this request's decision buttons, so that card is sealed as usual.
  const cardKb = (cardMsg && cardMsg.reply_markup && cardMsg.reply_markup.inline_keyboard) || [];
  const cardLive = cardKb.flat().some((b) => b && (b.callback_data === `approve:${requestId}` || b.callback_data === `abx:ok:${requestId}`));
  const message = cardLive ? { ...cardMsg, chat: cardMsg.chat || query.message.chat } : query.message;
  const delegated = Object.assign(Object.create(Object.getPrototypeOf(query)), query, { data: `approve:${requestId}`, message });
  await require('../events/approvalEvents').handleApprovalCallback(bot, delegated, 'approve', { amount });
  // What is recorded now decides the closing line; nothing recorded keeps the buttons.
  let after = null;
  try { after = await approvalQueueRepository.getByRequestId(requestId); } catch (_) { /* unreadable: no closing line */ }
  const aaj = (after && after.actionJSON) || {};
  const st = String((after && after.status) || '').toLowerCase();
  const signedNow = Array.isArray(aaj.approvals) && aaj.approvals.map(String).includes(uid);
  let closing = '';
  if (st === 'approved') closing = `✅ ${money.sale(amount)} from ${aaj.customer} is recorded.`;
  else if (st === 'pending' && signedNow) {
    const { required, signed } = approvalCount(after);
    closing = `✅ You entered ${money.sale(amount)} and gave approval ${signed} of ${required}. A second admin checks it.`;
  } else if (st === 'rejected') closing = 'Already rejected — nothing to do.';
  if (!closing) return;
  const live = sessionStore.get(uid);
  if (live && live.type === SESSION_TYPE && live.step === 'admin_amount') sessionStore.clear(uid);
  try {
    await bot.editMessageText(closing, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
  } catch (_) { /* too old to edit */ }
}

async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return false;
  const text = String(msg.text || '').trim();
  if (!text || text.startsWith('/')) return false;
  if (session.step === 'admin_amount') {
    // PRC-2 — the admin types the amount the employee left blank.
    let row = null;
    try { row = await approvalQueueRepository.getByRequestId(session.requestId); } catch (_) { /* unreadable: said below */ }
    const st = row ? String(row.status || '').toLowerCase() : '';
    if (!row || st !== 'pending' || rowAmount(row.actionJSON) || String(row.user) === userId
      || !config.access.adminIds.map(String).includes(userId)) {
      sessionStore.clear(userId);
      await bot.sendMessage(chatId, row && st && st !== 'pending'
        ? `Already ${st} — nothing to do.` : 'This payment no longer needs an amount from you. Open 🛂 Approvals to see it.');
      return true;
    }
    const amount = parseAmount(text);
    const prompt = await adminPromptText(bot, row);
    if (!amount) {
      await render(bot, chatId, userId,
        `${prompt}\n\n⚠️ That is not an amount. Type digits only, for example 50000.`,
        [notNowRow(row.requestId)]);
      return true;
    }
    session.step = 'admin_amount'; sessionStore.set(userId, session);
    await render(bot, chatId, userId, await adminCheckText(row, amount), checkKeyboard(row.requestId, amount));
    return true;
  }
  if (session.step === 'pick') {
    session.query = text.slice(0, 40); session.page = 0; sessionStore.set(userId, session);
    await renderPick(bot, chatId, userId);
    return true;
  }
  if (session.step === 'amount') {
    const amount = parseAmount(text);
    if (!amount) {
      await renderAmount(bot, chatId, userId, '⚠️ That is not an amount. Type digits only, for example `50000`.');
      return true;
    }
    session.amount = amount; session.noAmount = false; session.requestId = null; sessionStore.set(userId, session);
    await renderMethod(bot, chatId, userId);
    return true;
  }
  return false;
}

async function handleCallback(bot, query) {
  const data = String(query.data || '');
  if (!data.startsWith(`${NS}:`)) return false;
  const userId = String(query.from.id);
  const chatId = query.message && query.message.chat && query.message.chat.id;
  const rest = data.slice(NS.length + 1);
  const answer = (text) => bot.answerCallbackQuery(query.id, text ? { text } : undefined).catch(() => {});
  if (rest === 'noop') { await answer(); return true; }
  // PRC-2 — the admin's amount step: session-free, re-checked on every tap.
  if (/^(ay|ae|ax):/.test(rest)) { await adminCallback(bot, query, rest); return true; }
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE || session.step === 'admin_amount') {
    await answer('This card has expired. Open 💵 Payment Received again.');
    return true;
  }
  await answer();
  if (rest === 'cancel') {
    sessionStore.clear(userId);
    await require('../utils/telegramUI').editOrSend(bot, chatId, session.flowMessageId,
      '❌ Payment entry cancelled. Nothing was recorded.',
      { reply_markup: { inline_keyboard: [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]] } });
    return true;
  }
  if (rest.startsWith('pg:')) {
    session.page = parseInt(rest.slice(3), 10) || 0; sessionStore.set(userId, session);
    await renderPick(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('c:') && session.step === 'pick') {
    const pick = (session._pick || [])[parseInt(rest.slice(2), 10)];
    if (!pick) { await renderPick(bot, chatId, userId); return true; }
    session.customer = pick; session.requestId = null; sessionStore.set(userId, session);
    await renderAmount(bot, chatId, userId);
    return true;
  }
  if (rest === 'noamt') {
    // PRC-2 (D2) — employees only; a crafted or stale tap from an admin
    // (or on another step) only redraws the amount step.
    if (session.step !== 'amount' || auth.isAdmin(userId)) {
      if (session.step === 'amount') await renderAmount(bot, chatId, userId);
      return true;
    }
    session.amount = null; session.noAmount = true; session.requestId = null; sessionStore.set(userId, session);
    await renderMethod(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('m:') && session.step === 'method') {
    const method = (session._methods || [])[parseInt(rest.slice(2), 10)];
    if (!method) { await renderMethod(bot, chatId, userId); return true; }
    session.method = method; session.requestId = null; sessionStore.set(userId, session);
    await renderApprover(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('ad:') && session.step === 'approver') {
    const key = rest.slice(3);
    if (key === 'any') session.asked = null;
    else {
      const pick = (session._admins || [])[parseInt(key, 10)];
      if (!pick) { await renderApprover(bot, chatId, userId); return true; }
      session.asked = { id: pick.id, name: pick.name };
    }
    session.requestId = null; sessionStore.set(userId, session);
    await renderConfirm(bot, chatId, userId);
    return true;
  }
  if (rest === 'back') {
    if (session.step === 'confirm') {
      if ((session._admins || []).length >= 2) await renderApprover(bot, chatId, userId);
      else await renderMethod(bot, chatId, userId);
      return true;
    }
    if (session.step === 'approver') { await renderMethod(bot, chatId, userId); return true; }
    if (session.step === 'method') { await renderAmount(bot, chatId, userId); return true; }
    session.customer = null; sessionStore.set(userId, session);
    await renderPick(bot, chatId, userId);
    return true;
  }
  if (rest === 'submit') { await submit(bot, chatId, userId); return true; }
  return true;
}

module.exports = { SESSION_TYPE, NS, start, handleCallback, handleText, amountSeam, _internals: { parseAmount, approverChoices } };
