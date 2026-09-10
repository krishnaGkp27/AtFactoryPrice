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
    `🏦 ${accountLine(pay)}`,
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
  return lines.join('\n');
}

function financeKeyboard(paymentId) {
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
  // PAY-2 — the reason rides the queue payload, so the inbox and the
  // reminder rebuild print it exactly as the notify-time card did.
  if (pay.reason) out.push(`Reason: ${pay.reason}`);
  if (pay.above_threshold) out.push('⚠️ LARGE PAYMENT — above the threshold');
  if (pay.bill_file_id) out.push('Bill: attached');
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
  const text = buildFinanceCard(pay, head, { reason });
  const sendOpts = { parse_mode: 'Markdown', reply_markup: financeKeyboard(pay.payment_id) };
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
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
  return { sent, failed };
}

module.exports = {
  buildFinanceCard,
  buildApprovalSummary,
  buildAccountSummary,
  financeKeyboard,
  sendFinanceCard,
  accountLine,
};
