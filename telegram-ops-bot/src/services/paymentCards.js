'use strict';

/**
 * PAY-1 — the payment cards, in the owner's own layout.
 *
 * He drew this one by hand: name and category, account number, bank,
 * amount, who approved it, then Mark Done and Decline. Everything below
 * is that card, rendered in the house CARD-3 grammar — each fact once, a
 * line only when it has something to say, and warnings as full sentences.
 */

const { mdEscape } = require('../utils/flowKit');
const fmtDate = require('../utils/formatDate');
const paymentService = require('./paymentService');
const paymentRequestsRepo = require('../repositories/paymentRequestsRepository');
const paymentEventsRepository = require('../repositories/paymentEventsRepository');
const logger = require('../utils/logger');

/** "0123456789 · GTBank", or just whichever half exists. */
function accountLine(pay) {
  return [pay.account_number, pay.bank].filter(Boolean).map(mdEscape).join(' · ');
}

/**
 * The card the FINANCE seat acts on. Sent once the second admin approves.
 *
 * PAY-2 (owner, 09-Sep-2026): the reason under the amount, the approving
 * PAIR (`approved_by` now stores "Ajeet ‖ John"), and the requester by
 * NAME — never a raw Telegram id.
 *
 * @param {object} pay a PaymentRequests row (+ optional approved_by_name,
 *   raised_by_name resolved by the caller)
 * @param {object} [head] paymentRecipients().head, to render its warning
 * @param {{reason?:string}} [extra] the reason as resolved by the caller
 *   (`paymentService.reasonFor`: the row's own `reason` cell → Postgres
 *   `payment_reasons` → the queue payload); falls back to `pay.reason`
 */
function buildFinanceCard(pay, head, extra = {}) {
  const reason = extra.reason !== undefined ? extra.reason : pay.reason;
  const lines = [
    `💳 *Payment* — ${mdEscape(pay.payee_name)} · ${mdEscape(pay.payee_type)}`,
    // PAY-6 — a payment that carries its paying account shows source and
    // recipient together; one without (approved before PAY-6, or no company
    // account configured) keeps the single payee line exactly as it was.
    ...(pay.paid_from
      ? [`📤 From: ${mdEscape(pay.paid_from)}`, `📥 To: ${accountLine(pay)}`]
      : [`🏦 ${accountLine(pay)}`]),
  ];
  // The amount and its badge share a line: one is the qualifier of the
  // other, and a badge on its own line reads as a separate fact.
  const amount = `💰 *${paymentService.fmtNaira(pay.amount_ngn)}*`;
  lines.push(pay.above_threshold ? `${amount}    ⚠️ large payment` : amount);
  if (reason) lines.push(`📝 ${mdEscape(reason)}`);
  if (pay.bill_file_id) lines.push('📎 Bill attached');
  // APR-1 — a name, never a raw Telegram id (LBL-1). `approved_by` holds
  // the pair label since PAY-2; `approved_by_name` is the caller's
  // resolution of an older single-id cell, so an unresolvable approver
  // still shows something rather than vanishing.
  if (pay.approved_by) lines.push(`✅ Approved: ${mdEscape(pay.approved_by_name || pay.approved_by)}`);
  lines.push(`_Raised by ${mdEscape(pay.raised_by_name || pay.raised_by)} · ${mdEscape(fmtDate.withTime(pay.raised_at))}_`);
  lines.push(`\`${mdEscape(pay.payment_id)}\``);
  const warn = head ? paymentService.financeWarning(head) : '';
  if (warn) lines.push(`\n${mdEscape(warn)}`);
  // PAY-4 — said once, on the copy it applies to, in the reader's own terms.
  if (extra.approvedIt) {
    lines.push('\n🔒 _You approved this one, so you cannot pay it — a different hand must release the money._');
  }
  return lines.join('\n');
}

function financeKeyboard(paymentId, opts = {}) {
  // PAY-4 (BUSINESS_RULES §13) — an id that approved this payment never
  // sees ✔ Mark Done. Offering a button whose tap is refused teaches people
  // to tap and hope; withholding it states the rule without a sentence.
  // ✖ Decline stays: it moves no money and is the way to unstick the row.
  if (opts.approvedIt) {
    return { inline_keyboard: [[{ text: '✖ Decline', callback_data: `pay:dec:${paymentId}` }]] };
  }
  return {
    inline_keyboard: [[
      { text: '✔ Mark Done', callback_data: `pay:done:${paymentId}` },
      { text: '✖ Decline', callback_data: `pay:dec:${paymentId}` },
    ]],
  };
}

/**
 * The card an APPROVING admin sees in the queue. Same facts, no action
 * chips — approve/reject come from the standard pipeline keyboard.
 */
function buildApprovalSummary(pay) {
  const out = [
    `Payment request: ${paymentService.fmtNaira(pay.amount_ngn)}`,
    `Payee: ${pay.payee_name} (${pay.payee_type})`,
    `Account: ${[pay.account_number, pay.bank].filter(Boolean).join(' · ')}`,
  ];
  // PAY-6 — the paying account, parked on the queue payload by the approval
  // executor (`payFrom`), so it exists only on a DECIDED request's record.
  if (pay.payFrom && pay.payFrom.label) out.push(`Paid from: ${pay.payFrom.label}`);
  // PAY-2 — the reason rides the queue payload, so the inbox and the
  // reminder rebuild print it exactly as the notify-time card did.
  if (pay.reason) out.push(`Reason: ${pay.reason}`);
  if (pay.above_threshold) out.push('⚠️ LARGE PAYMENT — above the threshold');
  if (pay.bill_file_id) out.push('Bill: attached');
  // PAY-5 — raised by one person into another's account: said in words
  // (owner: "which will be shown on the card explicitly").
  if (pay.on_behalf_by) out.push(`👥 Raised by ${pay.on_behalf_by} on behalf of ${pay.payee_name}`);
  // PAY-5 — the same account, name and amount is already open and the bot
  // did not refuse it (another person raised that one): the admin decides.
  if (pay.twinFlag) {
    const k = paymentService.reasonKind(pay.reason || '');
    out.push(require('./approvalGate').twinFlagLine(pay.twinFlag, {
      what: pay.twinFlag.kind === 'salary_period' && k.period
        ? `Salary for ${paymentService.periodLabel(k.period)} is already on record`
        : 'Same account, name and amount',
    }));
  }
  // PAY-5 — an admin sent this although its twin is open: every card says so.
  if (pay.twinOf) {
    out.push(`⧉ Repeat of ${require('./approvalProgress').ref(pay.twinOf)} — sent anyway${pay.sentAnywayName ? ` by ${pay.sentAnywayName}` : ''}`);
  }
  return out.join('\n');
}

/**
 * The card for registering a payee account (the other dual-admin door).
 *
 * PAY-ID (owner hard rule, 23-Aug-2026) — the two approving admins must see
 * WHO, not a typed name. An employee account states the VERIFIED Telegram
 * identity behind it; a contractor account states plainly that there is no
 * Telegram identity and an admin is vouching.
 *
 * @param {object} acct owner_name, owner_type, account_number, bank,
 *   owner_telegram_id, and optionally `verifiedUser` (a Users-sheet row).
 */
function buildAccountSummary(acct) {
  const out = [
    `Register payment account: ${acct.owner_name} (${acct.owner_type})`,
    `Account: ${[acct.account_number, acct.bank].filter(Boolean).join(' · ')}`,
  ];
  if (acct.owner_type === 'contractor') {
    out.push('Identity: contractor — no Telegram account; an admin is vouching for this payee.');
  } else {
    const employeeIdentity = require('./employeeIdentity');
    const line = acct.verifiedUser
      ? employeeIdentity.cardLine(acct.verifiedUser)
      : (acct.owner_telegram_id
        ? `Linked Telegram: ${acct.owner_name} · ${acct.owner_telegram_id} ✓ registered employee`
        : '⚠️ NO Telegram identity linked — do not approve; the payee must be onboarded first.');
    out.push(line);
  }
  out.push('Once approved, payments can be raised against this account.');
  return out.join('\n');
}

/* ── PAY-6 (owner, 11-Nov-2026) — "Pay from which account?" ─────────── */

const PAY_FROM_CHANGED = 'That list has changed — pick again.';
const PAY_FROM_ASK_TOAST = 'Choose the account to pay from.';
const PAY_FROM_FAILED = '⚠️ Could not show the paying accounts — nothing was approved. Tap ✅ Approve again in a minute.';
const PAY_FROM_NOT_NOW = 'Nothing was approved. The request still waits for its last approval.';
const PAY_FROM_EMPTY = 'That list has changed — no paying account is listed any more.\n'
  + 'Nothing was approved. Tap ✅ Approve on the request again.';

/**
 * The picker the admin giving the LAST approval sees when the company has
 * two or more paying accounts. Text and keyboard only — nothing is read or
 * written here.
 *
 * @param {string} requestId the ApprovalQueue request
 * @param {object} aj its payload (amount_ngn, payee_name, account_number, bank, reason)
 * @param {Array<{label:string}>} accounts paymentService.sourceAccounts()
 * @param {{changed?:boolean}} [opts] changed = the list moved under an open picker
 * @returns {{text:string, reply_markup:{inline_keyboard:Array}}}
 */
function buildPayFromPicker(requestId, aj, accounts, opts = {}) {
  const p = aj || {};
  const to = [p.payee_name, p.account_number, p.bank].filter(Boolean).map(mdEscape).join(' · ');
  const lines = [];
  if (opts.changed) lines.push(`⚠️ ${PAY_FROM_CHANGED}`, '');
  lines.push('💳 *Pay from which account?*');
  lines.push(`${mdEscape(paymentService.fmtNaira(p.amount_ngn))} → ${to}`);
  if (p.reason) lines.push(`📝 ${mdEscape(p.reason)}`);
  lines.push('', '_You are giving the last approval. Finance will be told to pay from the account you tap._');
  const rows = (accounts || []).map((a, i) => [{
    text: `🏦 ${a.label}`,
    callback_data: `pay:from:${requestId}:${paymentService.sourceAccountKey(accounts, i)}`,
  }]);
  rows.push([{ text: '✖ Not now', callback_data: `pay:fromx:${requestId}` }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

/**
 * The step the COMPLETING approval of a payment passes through
 * (approvalEvents.handleApprovalCallback, after every guard, before
 * anything is answered, written or wiped).
 *
 *   no company account configured → `{ ask:false, payFrom:null }` — the
 *     approval runs exactly as before PAY-6;
 *   one → that account, without asking (one-option navigation);
 *   two or more → the picker is drawn and `{ ask:true }` comes back: the
 *     caller returns and NOTHING is approved. The chip re-enters the same
 *     handler with `chosenKey`, so every guard has run again by the time
 *     the key is read here.
 *
 * A key that no longer names the account at its position (the list was
 * edited under an open picker) never stamps anything: the picker is
 * redrawn. Any failure to draw stops the approval — it is said, and the
 * request stays as it was.
 *
 * @param {object} bot
 * @param {object} callbackQuery the approve tap, or the picker chip's tap
 * @param {string} requestId
 * @param {object} item the queue row (`actionJSON` = the payment payload)
 * @param {string} [chosenKey] present (even '') only on a picker chip's tap
 * @returns {Promise<{ask:boolean, payFrom?:{label:string, by:string, at:string}|null}>}
 */
async function payFromStep(bot, callbackQuery, requestId, item, chosenKey) {
  const accounts = await paymentService.sourceAccounts();
  const fromPicker = chosenKey !== undefined && chosenKey !== null;
  if (!accounts.length && !fromPicker) return { ask: false, payFrom: null };
  const adminId = String(callbackQuery.from.id);
  const stamp = (a) => ({ label: a.label, by: adminId, at: new Date().toISOString() });
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const toast = async (text, alert) => {
    try { await bot.answerCallbackQuery(callbackQuery.id, { text, show_alert: !!alert }); } catch (_) { /* stale query */ }
  };
  try {
    if (fromPicker) {
      const picked = paymentService.resolveSourceAccount(accounts, chosenKey);
      if (picked) return { ask: false, payFrom: stamp(picked) };
      // The list moved under the open picker: the chip's account is not
      // the one at that position any more. Never stamp another in its place.
      if (!accounts.length) {
        await toast('Nothing was approved.');
        await bot.editMessageText(PAY_FROM_EMPTY,
          { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
        return { ask: true };
      }
      await toast(PAY_FROM_CHANGED);
      const again = buildPayFromPicker(requestId, item && item.actionJSON, accounts, { changed: true });
      try {
        await bot.editMessageText(again.text,
          { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: again.reply_markup });
      } catch (_) {
        await bot.sendMessage(chatId, again.text, { parse_mode: 'Markdown', reply_markup: again.reply_markup });
      }
      return { ask: true };
    }
    if (accounts.length === 1) return { ask: false, payFrom: stamp(accounts[0]) };
    const picker = buildPayFromPicker(requestId, item && item.actionJSON, accounts);
    await bot.sendMessage(chatId, picker.text, { parse_mode: 'Markdown', reply_markup: picker.reply_markup });
    await toast(PAY_FROM_ASK_TOAST);
    return { ask: true };
  } catch (e) {
    // Fail closed: with a paying account to choose, a payment is never
    // approved without the choice. Nothing has been written.
    logger.error(`PAY-6 paying-account step failed for ${requestId} — nothing approved: ${e.message}`);
    await toast(PAY_FROM_FAILED, true);
    return { ask: true };
  }
}

/** An `approved_by` cell that is still a bare Telegram id (pre-PAY-2 rows). */
function looksLikeRawId(v) {
  return /^\d+$/.test(String(v || '').trim());
}

/**
 * Deliver an approved payment to whoever may execute it.
 *
 * Recipients come from paymentService.paymentRecipients() — the Railway
 * finance seat, else the one Users finance row, else EVERY admin plus a
 * warning naming the misconfiguration — an unfinished sheet must never
 * leave approved money sitting in a queue that nobody can see.
 *
 * PAY-2 §2 C — every delivered copy is logged to `payment_events` with
 * its chat and message id (kind 'finance_card_sent', or 'reminder_sent'
 * when the reminder sweep re-sends it) so Mark Done / Decline can wipe
 * the buttons on each one.
 *
 * @param {object} bot
 * @param {string} paymentId
 * @param {{kind?:string, to?:string[]}} [opts] kind = the event kind
 *   ('finance_card_sent' | 'reminder_sent'); `to` = an explicit recipient
 *   list (the finance seat re-opening a card from its own queue)
 * @returns {Promise<{sent:number, failed:number}>} never throws
 */
async function sendFinanceCard(bot, paymentId, opts = {}) {
  const kind = opts.kind || 'finance_card_sent';
  const pay = await paymentRequestsRepo.findById(paymentId);
  if (!pay) {
    logger.warn(`PAY-1 sendFinanceCard: no payment row ${paymentId}`);
    return { sent: 0, failed: 0 };
  }
  const recipients = await paymentService.paymentRecipients();
  const ids = Array.isArray(opts.to) && opts.to.length ? opts.to.map(String) : recipients.ids;
  const head = recipients.head;
  const approverStamp = require('./approverStamp');
  if (pay.approved_by && !pay.approved_by_name && looksLikeRawId(pay.approved_by)) {
    try {
      pay.approved_by_name = await approverStamp.labelFor({ actorId: pay.approved_by, bot });
    } catch (_) { /* the card matters more than the name on it */ }
  }
  if (pay.raised_by && !pay.raised_by_name) {
    try {
      pay.raised_by_name = await approverStamp.labelFor({ actorId: pay.raised_by, bot });
    } catch (_) { /* same */ }
  }
  const reason = await paymentService.reasonFor(pay);
  // PAY-4 (BUSINESS_RULES §13) — the card is now built PER RECIPIENT: the
  // ids that approved this payment get a copy with no ✔ Mark Done. One
  // lookup for the whole send, not one per recipient.
  let approvers = [];
  try {
    approvers = await paymentService.approverIdsFor(pay);
  } catch (e) {
    logger.warn(`PAY-4 sendFinanceCard: approver lookup failed for ${paymentId}: ${e.message}`);
  }
  const plainText = buildFinanceCard(pay, head, { reason });
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    const approvedIt = approvers.includes(String(id));
    const text = approvedIt ? buildFinanceCard(pay, head, { reason, approvedIt }) : plainText;
    const sendOpts = {
      parse_mode: 'Markdown',
      reply_markup: financeKeyboard(pay.payment_id, { approvedIt }),
    };
    try {
      let msg;
      // The bill rides along when there is one — the person about to move
      // real money should not have to go hunting for the paperwork.
      if (pay.bill_file_id) {
        msg = await bot.sendPhoto(id, pay.bill_file_id, { caption: text, ...sendOpts }).catch(async () => {
          return bot.sendDocument(id, pay.bill_file_id, { caption: text, ...sendOpts });
        });
      } else {
        msg = await bot.sendMessage(id, text, sendOpts);
      }
      sent += 1;
      try {
        await paymentEventsRepository.record({
          paymentId: pay.payment_id, approvalRequestId: pay.approval_request_id || '',
          kind, actorId: '', actorName: '', chatId: String(id),
          messageId: String((msg && msg.message_id) || ''),
          detail: { source: recipients.source },
        });
      } catch (_) { /* fail-open: a missing trail row never costs the card */ }
    } catch (e) {
      failed += 1;
      logger.warn(`PAY-1 finance card to ${id} failed: ${e.message}`);
    }
  }
  // PAY-4 (BUSINESS_RULES §13) — said early, not discovered late. When
  // EVERY finance seat this payment would go to has signed it, nobody can
  // release the money. The admins who signed hear it now, with the way
  // out, instead of finding out when the payment is due. The verdict reads
  // the real seat list, never `opts.to` (which may be one reopened card).
  try {
    const seats = (recipients.ids || []).map(String);
    const stuck = seats.length > 0 && seats.every((sid) => approvers.includes(sid));
    if (stuck && approvers.length) {
      const note = `🔒 *Nobody can pay ${mdEscape(pay.payment_id)} yet*\n`
        + `${paymentService.fmtNaira(pay.amount_ngn)} to ${mdEscape(pay.payee_name)} is approved, but every finance seat it goes to also approved it.\n\n`
        + '_Four eyes on the money: the hands that approve are never the hands that pay._\n'
        + 'Add a finance id that did not sign, or ✖ Decline it and have it raised again for different hands.';
      for (const approverId of approvers) {
        try {
          await bot.sendMessage(approverId, note, { parse_mode: 'Markdown' });
        } catch (e) { logger.warn(`PAY-4 stuck-payment notice to ${approverId} failed: ${e.message}`); }
      }
    }
  } catch (e) {
    logger.warn(`PAY-4 stuck-payment check failed for ${paymentId}: ${e.message}`);
  }
  return { sent, failed };
}

module.exports = {
  buildFinanceCard,
  buildApprovalSummary,
  buildAccountSummary,
  financeKeyboard,
  sendFinanceCard,
  accountLine,
  buildPayFromPicker,
  payFromStep,
  PAY_FROM_NOT_NOW,
};
