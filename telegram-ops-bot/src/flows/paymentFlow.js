'use strict';

/**
 * PAY-1 — payment requests: register a payee once, then only ever pick it.
 *
 * Two wizards and one execution surface, from the owner's hand-drawn
 * system design (14-Aug-2026):
 *
 *   🏦 Register account   name (self, or a contractor when an admin) →
 *                         account number, typed TWICE → bank → confirm.
 *                         Dual-admin. Nothing may be paid to an account
 *                         that has not been through this.
 *   💸 Request payment    pick a REGISTERED account → amount → optional
 *                         bill → confirm. Dual-admin, whatever the size.
 *   📋 My requests        what happened to what I asked for.
 *
 * After the second admin approves, the request goes to the ONE finance
 * Telegram id, who transfers the money at the bank and taps ✔ Mark Done
 * (or ✖ Decline with a reason — finance can still refuse to execute
 * something already approved: wrong account, no funds, a duplicate).
 *
 * Why the account number is typed twice: it is the only field in this
 * whole feature that cannot be checked against anything. A wrong design
 * number shows the wrong cloth; a wrong account number sends real money
 * to a stranger and no part of this system can get it back.
 *
 * Session (type 'payment_flow'):
 *   { step, flowMessageId, mode: 'register'|'request',
 *     reg: { owner_type, owner_name, owner_telegram_id, number, confirm, bank },
 *     req: { accounts[], account, amount, bill_file_id },
 *     dec: { payment_id } }            // decline-reason capture
 *
 * Callback namespace `pay:` —
 *   pay:start:reg|req|mine   pay:type:emp|con    pay:bank:<i>
 *   pay:acct:<i>             pay:bill:skip       pay:submit
 *   pay:done:<id>            pay:dec:<id>        pay:proof:skip
 *   pay:back                 pay:cancel
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, mdEscape, rowsFor } = require('../utils/flowKit');
const paymentService = require('../services/paymentService');
const paymentCards = require('../services/paymentCards');
const paymentAccountsRepo = require('../repositories/paymentAccountsRepository');
const paymentRequestsRepo = require('../repositories/paymentRequestsRepository');
const settingsRepository = require('../repositories/settingsRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const approvalEvents = require('../events/approvalEvents');
const riskEvaluate = require('../risk/evaluate');
const idGenerator = require('../utils/idGenerator');
const fmtDate = require('../utils/formatDate');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');

const SESSION_TYPE = 'payment_flow';
const NS = 'pay';
const render = makeRenderer();
const { backAndCancelRow, cancelRow, menuRow } = rowsFor(NS);

const FLOW_TTL_MS = 20 * 60 * 1000;

function newSession(extra = {}) {
  return {
    type: SESSION_TYPE, step: 'hub', flowMessageId: null,
    startedAt: Date.now(), ttlMs: FLOW_TTL_MS,
    reg: {}, req: {}, ...extra,
  };
}

/* ── hub ─────────────────────────────────────────────────────────────── */

async function start(bot, chatId, userId, messageId) {
  const session = newSession();
  if (messageId) session.flowMessageId = messageId;
  sessionStore.set(userId, session);
  await showHub(bot, chatId, userId);
}

async function showHub(bot, chatId, userId) {
  const isAdmin = auth.isAdmin(userId);
  const head = await paymentService.financeHead();
  const mine = await paymentAccountsRepo.activeForTelegramId(userId);

  const lines = ['💳 *Payments*', ''];
  lines.push(mine.length
    ? `You have *${mine.length}* registered account${mine.length === 1 ? '' : 's'}.`
    : '_You have no registered account yet — register one before requesting a payment._');
  if (isAdmin) {
    lines.push(head.ok
      ? `Finance: *${mdEscape(head.name)}* pays and marks done.`
      : mdEscape(paymentService.financeWarning(head)));
  }

  const rows = [
    [{ text: '🏦 Register account', callback_data: 'pay:start:reg' }],
    [{ text: '💸 Request payment', callback_data: 'pay:start:req' }],
    [{ text: '📋 My requests', callback_data: 'pay:start:mine' }],
    menuRow(),
  ];
  await render(bot, chatId, userId, lines.join('\n'), rows);
}

/* ── register an account ─────────────────────────────────────────────── */

async function startRegister(bot, chatId, userId) {
  const session = sessionStore.get(userId) || newSession();
  session.mode = 'register';
  session.reg = {};
  if (!auth.isAdmin(userId)) {
    // Owner rule: an employee registers only their OWN account.
    session.reg.owner_type = 'employee';
    session.reg.owner_telegram_id = String(userId);
    session.reg.owner_name = await resolveName(userId);
    session.step = 'reg_number';
    sessionStore.set(userId, session);
    return askAccountNumber(bot, chatId, userId);
  }
  session.step = 'reg_type';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    '🏦 *Register an account*\n\nWhose account is this?',
    [
      [{ text: '👤 Mine', callback_data: 'pay:type:emp' }],
      [{ text: '🧰 A contractor’s', callback_data: 'pay:type:con' }],
      cancelRow(),
    ]);
}

async function applyOwnerType(bot, chatId, userId, kind) {
  const session = sessionStore.get(userId);
  if (!session) return;
  if (kind === 'emp') {
    session.reg.owner_type = 'employee';
    session.reg.owner_telegram_id = String(userId);
    session.reg.owner_name = await resolveName(userId);
    session.step = 'reg_number';
    sessionStore.set(userId, session);
    return askAccountNumber(bot, chatId, userId);
  }
  session.reg.owner_type = 'contractor';
  session.reg.owner_telegram_id = '';
  session.step = 'reg_name';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    '🧰 *Contractor account*\n\nType the contractor’s full name — exactly as it appears on the bank account.',
    [backAndCancelRow()]);
}

async function askAccountNumber(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const who = session && session.reg.owner_name;
  await render(bot, chatId, userId,
    `🏦 *Account for ${mdEscape(who || 'you')}*\n\nType the *10-digit account number*.`,
    [backAndCancelRow()]);
}

async function askAccountNumberAgain(bot, chatId, userId) {
  await render(bot, chatId, userId,
    '🔁 *Type it once more*\n\nAn account number is the one thing here nothing else can check — '
    + 'so type it again and the bot will compare.',
    [backAndCancelRow()]);
}

async function askBank(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  let banks = [];
  try {
    const s = await settingsRepository.getAll();
    banks = String(s.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean);
  } catch (_) { banks = []; }
  if (!banks.length) banks = ['GTBank', 'Zenith', 'FirstBank', 'Access', 'UBA'];
  session.reg.banks = banks;
  session.step = 'reg_bank';
  sessionStore.set(userId, session);

  const rows = [];
  for (let i = 0; i < banks.length; i += 2) {
    rows.push(banks.slice(i, i + 2).map((b, j) => ({
      text: `🏛 ${b}`, callback_data: `pay:bank:${i + j}`,
    })));
  }
  rows.push(backAndCancelRow());
  await render(bot, chatId, userId,
    `🏦 *${mdEscape(session.reg.number)}*\n\nWhich bank?`, rows);
}

async function showRegisterConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const r = session.reg;
  session.step = 'reg_confirm';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `🏦 *Register this account?*\n\n`
    + `👤 ${mdEscape(r.owner_name)} · ${mdEscape(r.owner_type)}\n`
    + `🔢 ${mdEscape(r.number)}\n`
    + `🏛 ${mdEscape(r.bank)}\n\n`
    + '_Two admins must approve before any payment can be raised against it._',
    [[{ text: '✅ Submit for approval', callback_data: 'pay:submit' }], backAndCancelRow()]);
}

async function submitRegister(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.reg || !session.reg.number) return;
  const r = session.reg;

  // A second live registration of the same number+bank would put two
  // rows meaning one destination into the picker.
  const clash = await paymentAccountsRepo.findLive(r.number, r.bank);
  if (clash) {
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      `⚠️ *Already registered*\n\n${mdEscape(r.bank)} ${mdEscape(r.number)} is already `
      + `${clash.status === 'active' ? 'registered and active' : 'awaiting approval'} for `
      + `*${mdEscape(clash.owner_name)}*.\n\nNothing was submitted.`,
      [menuRow()]);
    return;
  }

  const requestId = idGenerator.requestId();
  try {
    const saved = await paymentAccountsRepo.append({
      owner_name: r.owner_name, owner_type: r.owner_type,
      owner_telegram_id: r.owner_telegram_id,
      account_number: r.number, bank: r.bank,
      status: 'pending', registered_by: String(userId),
      approval_request_id: requestId,
    });
    const risk = await riskEvaluate.evaluate({ action: 'register_payment_account', userId });
    await approvalQueueRepository.append({
      requestId,
      user: String(userId),
      actionJSON: {
        action: 'register_payment_account',
        account_id: saved.account_id,
        owner_name: r.owner_name, owner_type: r.owner_type,
        account_number: r.number, bank: r.bank,
      },
      riskReason: risk.reason || 'dual_admin_required',
      status: 'pending',
    });
    await auditLogRepository.append('approval_queued',
      { requestId, action: 'register_payment_account', account_id: saved.account_id }, userId);

    const label = await resolveName(userId);
    await approvalEvents.notifyAdminsApprovalRequest(
      bot, requestId, label,
      paymentCards.buildAccountSummary({ ...r, account_number: r.number }),
      risk.reason, auth.isAdmin(userId) ? String(userId) : undefined,
    );
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      `⏳ *Sent for approval*\n\n🏦 ${mdEscape(r.bank)} ${mdEscape(r.number)}\n`
      + `👤 ${mdEscape(r.owner_name)}\n\n_You’ll be told when two admins have signed it._`,
      [menuRow()]);
  } catch (e) {
    logger.error(`paymentFlow.submitRegister: ${e.message}`);
    await render(bot, chatId, userId, `⚠️ Could not submit: ${mdEscape(e.message)}`, [menuRow()]);
  }
}

/* ── request a payment ───────────────────────────────────────────────── */

async function startRequest(bot, chatId, userId) {
  const session = sessionStore.get(userId) || newSession();
  session.mode = 'request';
  session.req = {};
  const accounts = await paymentService.payableAccountsFor(userId, auth.isAdmin(userId));
  if (!accounts.length) {
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      '💸 *Request payment*\n\n_No approved account to pay into yet._\n\n'
      + 'Register an account first — it needs two admins before a payment can use it.',
      [[{ text: '🏦 Register account', callback_data: 'pay:start:reg' }], menuRow()]);
    return;
  }
  session.req.accounts = accounts;
  session.step = 'req_account';
  sessionStore.set(userId, session);

  const rows = accounts.slice(0, 20).map((a, i) => ([{
    text: `${a.owner_type === 'contractor' ? '🧰' : '👤'} ${a.owner_name} · ${a.bank} ${a.account_number}`.slice(0, 60),
    callback_data: `pay:acct:${i}`,
  }]));
  rows.push(cancelRow());
  await render(bot, chatId, userId, '💸 *Request payment*\n\nPay into which account?', rows);
}

async function askAmount(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const a = session.req.account;
  session.step = 'req_amount';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `💸 *${mdEscape(a.owner_name)}*\n🏦 ${mdEscape(a.bank)} ${mdEscape(a.account_number)}\n\n`
    + 'How much, in naira? Type the figure, e.g. `45000`.',
    [backAndCancelRow()]);
}

async function askBill(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  session.step = 'req_bill';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `📎 *Any paperwork?*\n\nSend a photo or PDF of the bill or invoice, or skip — `
    + 'it is not required.',
    [[{ text: '⏭ Skip — no bill', callback_data: 'pay:bill:skip' }], backAndCancelRow()]);
}

async function showRequestConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const r = session.req;
  const above = await paymentService.isAboveThreshold(r.amount);
  r.above = above;
  session.step = 'req_confirm';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    '💸 *Send this for approval?*\n\n'
    + `👤 ${mdEscape(r.account.owner_name)} · ${mdEscape(r.account.owner_type)}\n`
    + `🏦 ${mdEscape(r.account.bank)} ${mdEscape(r.account.account_number)}\n`
    + `💰 *${mdEscape(paymentService.fmtNaira(r.amount))}*${above ? '    ⚠️ large payment' : ''}\n`
    + `${r.bill_file_id ? '📎 Bill attached\n' : ''}`
    + '\n_Two admins approve, then finance pays._',
    [[{ text: '✅ Submit for approval', callback_data: 'pay:submit' }], backAndCancelRow()]);
}

async function submitRequest(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.req || !session.req.account) return;
  const r = session.req;
  const requestId = idGenerator.requestId();
  try {
    const saved = await paymentRequestsRepo.append({
      payee_name: r.account.owner_name,
      payee_type: r.account.owner_type,
      account_id: r.account.account_id,
      account_number: r.account.account_number,
      bank: r.account.bank,
      amount_ngn: r.amount,
      above_threshold: r.above,
      raised_by: String(userId),
      approval_request_id: requestId,
      status: 'pending_approval',
      bill_file_id: r.bill_file_id || '',
    });
    const risk = await riskEvaluate.evaluate({ action: 'request_payment', userId, quantity: r.amount });
    await approvalQueueRepository.append({
      requestId,
      user: String(userId),
      actionJSON: {
        action: 'request_payment',
        payment_id: saved.payment_id,
        payee_name: r.account.owner_name,
        amount_ngn: r.amount,
        account_number: r.account.account_number,
        bank: r.account.bank,
        above_threshold: !!r.above,
        sale_doc_file_id: undefined,
      },
      riskReason: risk.reason || 'dual_admin_required',
      status: 'pending',
    });
    await auditLogRepository.append('approval_queued',
      { requestId, action: 'request_payment', payment_id: saved.payment_id, amount: r.amount }, userId);

    const label = await resolveName(userId);
    await approvalEvents.notifyAdminsApprovalRequest(
      bot, requestId, label,
      paymentCards.buildApprovalSummary({
        ...saved, payee_name: r.account.owner_name, payee_type: r.account.owner_type,
        account_number: r.account.account_number, bank: r.account.bank,
        amount_ngn: r.amount, above_threshold: r.above,
      }),
      risk.reason, auth.isAdmin(userId) ? String(userId) : undefined,
    );
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      `⏳ *Sent for approval*\n\n💰 ${mdEscape(paymentService.fmtNaira(r.amount))} → `
      + `${mdEscape(r.account.owner_name)}\n\`${mdEscape(saved.payment_id)}\`\n\n`
      + '_Two admins sign, then finance pays and marks it done._',
      [menuRow()]);
  } catch (e) {
    logger.error(`paymentFlow.submitRequest: ${e.message}`);
    await render(bot, chatId, userId, `⚠️ Could not submit: ${mdEscape(e.message)}`, [menuRow()]);
  }
}

/* ── my requests ─────────────────────────────────────────────────────── */

const STATUS_ICON = {
  pending_approval: '⏳', approved: '🏦', done: '✅', declined: '✖', rejected: '❌',
};
const STATUS_WORD = {
  pending_approval: 'waiting for approval', approved: 'with finance to pay',
  done: 'paid', declined: 'declined by finance', rejected: 'rejected',
};

async function showMine(bot, chatId, userId) {
  const rows = await paymentRequestsRepo.forRaiser(userId);
  sessionStore.clear(userId);
  if (!rows.length) {
    await render(bot, chatId, userId, '📋 *My requests*\n\n_You have not asked for a payment yet._', [menuRow()]);
    return;
  }
  const lines = ['📋 *My requests*', ''];
  for (const p of rows.slice(0, 12)) {
    lines.push(`${STATUS_ICON[p.status] || '•'} ${mdEscape(paymentService.fmtNaira(p.amount_ngn))} — ${mdEscape(STATUS_WORD[p.status] || p.status)}`);
    lines.push(`   _${mdEscape(fmtDate.short ? fmtDate.short(p.raised_at) : p.raised_at)}_${p.decline_reason ? ` · ${mdEscape(p.decline_reason)}` : ''}`);
  }
  if (rows.length > 12) lines.push(`\n_…and ${rows.length - 12} older._`);
  await render(bot, chatId, userId, lines.join('\n'), [menuRow()]);
}

/* ── execution: Mark Done / Decline ──────────────────────────────────── */

async function markDone(bot, chatId, userId, paymentId, cbId) {
  const gate = await paymentService.canExecute(userId);
  if (!gate.ok) {
    await answer(bot, cbId, 'Only the finance person marks a payment done.', true);
    return;
  }
  const pay = await paymentRequestsRepo.findById(paymentId);
  if (!pay) { await answer(bot, cbId, 'That payment was not found.', true); return; }
  if (pay.status === 'done') { await answer(bot, cbId, 'Already marked done.', true); return; }
  if (pay.status !== 'approved') {
    await answer(bot, cbId, `That payment is ${pay.status.replace('_', ' ')} — it cannot be paid.`, true);
    return;
  }
  await answer(bot, cbId, 'Marked done.');
  await paymentRequestsRepo.update(paymentId, {
    status: 'done', done_by: String(userId), done_at: fmtDate.withTime(new Date().toISOString()),
  });
  await auditLogRepository.append('payment_done',
    { payment_id: paymentId, amount: pay.amount_ngn, payee: pay.payee_name }, userId).catch(() => {});
  await notifyRaiser(bot, pay,
    `✅ *Paid*\n\n${paymentService.fmtNaira(pay.amount_ngn)} was sent to ${pay.bank} ${pay.account_number}.`);
  await render(bot, chatId, userId,
    `✅ *Paid* — ${mdEscape(paymentService.fmtNaira(pay.amount_ngn))} to ${mdEscape(pay.payee_name)}\n`
    + `\`${mdEscape(paymentId)}\`\n\n_Recorded ${mdEscape(fmtDate.withTime(new Date().toISOString()))}._`,
    []);
}

async function startDecline(bot, chatId, userId, paymentId, cbId) {
  const gate = await paymentService.canExecute(userId);
  if (!gate.ok) {
    await answer(bot, cbId, 'Only the finance person can decline a payment.', true);
    return;
  }
  const pay = await paymentRequestsRepo.findById(paymentId);
  if (!pay) { await answer(bot, cbId, 'That payment was not found.', true); return; }
  if (pay.status !== 'approved') {
    await answer(bot, cbId, `That payment is ${pay.status.replace('_', ' ')} — nothing to decline.`, true);
    return;
  }
  await answer(bot, cbId);
  const session = newSession({ step: 'dec_reason', dec: { payment_id: paymentId } });
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `✖ *Decline ${mdEscape(paymentService.fmtNaira(pay.amount_ngn))} to ${mdEscape(pay.payee_name)}*\n\n`
    + 'Why? The person who asked will see this, so say what would make it payable.',
    [cancelRow()]);
}

async function applyDecline(bot, chatId, userId, reason) {
  const session = sessionStore.get(userId);
  if (!session || !session.dec) return;
  const pay = await paymentRequestsRepo.findById(session.dec.payment_id);
  if (!pay) { sessionStore.clear(userId); return; }
  await paymentRequestsRepo.update(pay.payment_id, {
    status: 'declined', done_by: String(userId),
    done_at: fmtDate.withTime(new Date().toISOString()), decline_reason: reason,
  });
  await auditLogRepository.append('payment_declined',
    { payment_id: pay.payment_id, reason }, userId).catch(() => {});
  await notifyRaiser(bot, pay,
    `✖ *Payment declined*\n\n${paymentService.fmtNaira(pay.amount_ngn)} to ${pay.payee_name} was not paid.\n\n_${reason}_`);
  sessionStore.clear(userId, 'completed');
  await render(bot, chatId, userId,
    `✖ *Declined* — ${mdEscape(paymentService.fmtNaira(pay.amount_ngn))} to ${mdEscape(pay.payee_name)}\n\n`
    + `_${mdEscape(reason)}_\n\nThe requester has been told.`, [menuRow()]);
}

/* ── plumbing ────────────────────────────────────────────────────────── */

async function resolveName(userId) {
  try {
    return await require('../services/approvalCards').resolveUserLabel(String(userId));
  } catch (_) { return String(userId); }
}

async function answer(bot, cbId, text, alert) {
  if (!cbId) return;
  try { await bot.answerCallbackQuery(cbId, text ? { text, show_alert: !!alert } : undefined); } catch (_) { /* stale */ }
}

async function notifyRaiser(bot, pay, text) {
  if (!pay.raised_by) return;
  try { await bot.sendMessage(pay.raised_by, text, { parse_mode: 'Markdown' }); } catch (e) {
    logger.info(`PAY-1: could not DM raiser ${pay.raised_by}: ${e.message}`);
  }
}

/** Text typed during the flow. Returns true when this flow consumed it. */
async function handleText(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return false;
  const value = String(text || '').trim();

  if (session.step === 'reg_name') {
    if (value.length < 2 || value.length > 80) {
      await render(bot, chatId, userId, '⚠️ Type the contractor’s full name (2–80 characters).', [backAndCancelRow()]);
      return true;
    }
    session.reg.owner_name = value;
    session.step = 'reg_number';
    sessionStore.set(userId, session);
    await askAccountNumber(bot, chatId, userId);
    return true;
  }

  if (session.step === 'reg_number' || session.step === 'reg_number2') {
    const v = paymentService.validateAccountNumber(value);
    if (!v.ok) {
      await render(bot, chatId, userId, `⚠️ ${mdEscape(v.reason)}`, [backAndCancelRow()]);
      return true;
    }
    if (session.step === 'reg_number') {
      session.reg.number = v.value;
      session.step = 'reg_number2';
      sessionStore.set(userId, session);
      await askAccountNumberAgain(bot, chatId, userId);
      return true;
    }
    if (v.value !== session.reg.number) {
      // Do not show which one was "right" — neither is known to be.
      session.reg.number = '';
      session.step = 'reg_number';
      sessionStore.set(userId, session);
      await render(bot, chatId, userId,
        '⚠️ *The two did not match.*\n\nThat is exactly what this step is for. Type the 10-digit account number again.',
        [backAndCancelRow()]);
      return true;
    }
    await askBank(bot, chatId, userId);
    return true;
  }

  if (session.step === 'req_amount') {
    const v = paymentService.validateAmount(value);
    if (!v.ok) {
      await render(bot, chatId, userId, `⚠️ ${mdEscape(v.reason)}`, [backAndCancelRow()]);
      return true;
    }
    session.req.amount = v.value;
    sessionStore.set(userId, session);
    await askBill(bot, chatId, userId);
    return true;
  }

  if (session.step === 'dec_reason') {
    if (value.length < 3) {
      await render(bot, chatId, userId, '⚠️ Give a reason — the requester needs to know what to fix.', [cancelRow()]);
      return true;
    }
    await applyDecline(bot, chatId, userId, value.slice(0, 200));
    return true;
  }
  return false;
}

/** A photo/PDF sent during the flow (bill at raise, proof at done). */
async function handleFile(bot, chatId, userId, msg) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return false;
  if (session.step !== 'req_bill') return false;
  const fileId = msg.photo && msg.photo.length
    ? msg.photo[msg.photo.length - 1].file_id
    : (msg.document && msg.document.file_id);
  if (!fileId) return false;
  session.req.bill_file_id = fileId;
  sessionStore.set(userId, session);
  await showRequestConfirm(bot, chatId, userId);
  return true;
}

async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith(`${NS}:`)) return false;
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const cbId = callbackQuery.id;
  const rest = data.slice(NS.length + 1);

  // Execution chips are SESSION-FREE: the finance head taps them on a
  // card that arrived hours ago, long after any flow session expired.
  if (rest.startsWith('done:')) { await markDone(bot, chatId, userId, rest.slice(5), cbId); return true; }
  if (rest.startsWith('dec:')) { await startDecline(bot, chatId, userId, rest.slice(4), cbId); return true; }

  if (rest === 'cancel') {
    sessionStore.clear(userId, 'cancelled');
    await answer(bot, cbId, 'Cancelled');
    await render(bot, chatId, userId, '❌ Cancelled.', [menuRow()]);
    return true;
  }
  await answer(bot, cbId);

  if (rest.startsWith('start:')) {
    const which = rest.slice(6);
    if (which === 'reg') { await startRegister(bot, chatId, userId); return true; }
    if (which === 'req') { await startRequest(bot, chatId, userId); return true; }
    if (which === 'mine') { await showMine(bot, chatId, userId); return true; }
  }

  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    await render(bot, chatId, userId, '_That screen expired._', [menuRow()]);
    return true;
  }

  if (rest === 'back') { await showHub(bot, chatId, userId); return true; }
  if (rest.startsWith('type:')) { await applyOwnerType(bot, chatId, userId, rest.slice(5)); return true; }

  if (rest.startsWith('bank:')) {
    const bank = (session.reg.banks || [])[parseInt(rest.slice(5), 10)];
    if (!bank) { await render(bot, chatId, userId, '_That list expired._', [menuRow()]); return true; }
    session.reg.bank = bank;
    sessionStore.set(userId, session);
    await showRegisterConfirm(bot, chatId, userId);
    return true;
  }

  if (rest.startsWith('acct:')) {
    const acct = (session.req.accounts || [])[parseInt(rest.slice(5), 10)];
    if (!acct) { await render(bot, chatId, userId, '_That list expired._', [menuRow()]); return true; }
    session.req.account = acct;
    sessionStore.set(userId, session);
    await askAmount(bot, chatId, userId);
    return true;
  }

  if (rest === 'bill:skip') { await showRequestConfirm(bot, chatId, userId); return true; }

  if (rest === 'submit') {
    if (session.mode === 'register') await submitRegister(bot, chatId, userId);
    else await submitRequest(bot, chatId, userId);
    return true;
  }
  return true;
}

module.exports = {
  SESSION_TYPE,
  start,
  handleCallback,
  handleText,
  handleFile,
  showHub,
  // exported for tests
  _internals: { STATUS_WORD, newSession },
};
