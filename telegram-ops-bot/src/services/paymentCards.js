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
const logger = require('../utils/logger');

/** "0123456789 · GTBank", or just whichever half exists. */
function accountLine(pay) {
  return [pay.account_number, pay.bank].filter(Boolean).map(mdEscape).join(' · ');
}

/**
 * The card the FINANCE head acts on. Sent once the second admin approves.
 *
 * @param {object} pay a PaymentRequests row
 * @param {object} [head] financeHead() result, to render its warning
 */
function buildFinanceCard(pay, head) {
  const lines = [
    `💳 *Payment* — ${mdEscape(pay.payee_name)} · ${mdEscape(pay.payee_type)}`,
    `🏦 ${accountLine(pay)}`,
  ];
  // The amount and its badge share a line: one is the qualifier of the
  // other, and a badge on its own line reads as a separate fact.
  const amount = `💰 *${paymentService.fmtNaira(pay.amount_ngn)}*`;
  lines.push(pay.above_threshold ? `${amount}    ⚠️ large payment` : amount);
  if (pay.bill_file_id) lines.push('📎 Bill attached');
  if (pay.approved_by) lines.push(`✅ Approved: ${mdEscape(pay.approved_by)}`);
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
  if (pay.above_threshold) out.push('⚠️ LARGE PAYMENT — above the threshold');
  if (pay.bill_file_id) out.push('Bill: attached');
  return out.join('\n');
}

/** The card for registering a payee account (the other dual-admin door). */
function buildAccountSummary(acct) {
  return [
    `Register payment account: ${acct.owner_name} (${acct.owner_type})`,
    `Account: ${[acct.account_number, acct.bank].filter(Boolean).join(' · ')}`,
    'Once approved, payments can be raised against this account.',
  ].join('\n');
}

/**
 * Deliver an approved payment to whoever may execute it.
 *
 * Recipients come from paymentService: the one finance id when the Users
 * sheet names exactly one, otherwise EVERY admin plus a warning naming
 * the misconfiguration — an unfinished sheet must never leave approved
 * money sitting in a queue that nobody can see.
 *
 * @returns {Promise<{sent:number, failed:number}>} never throws
 */
async function sendFinanceCard(bot, paymentId) {
  const pay = await paymentRequestsRepo.findById(paymentId);
  if (!pay) {
    logger.warn(`PAY-1 sendFinanceCard: no payment row ${paymentId}`);
    return { sent: 0, failed: 0 };
  }
  const { ids, head } = await paymentService.paymentRecipients();
  const text = buildFinanceCard(pay, head);
  const opts = { parse_mode: 'Markdown', reply_markup: financeKeyboard(pay.payment_id) };
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      // The bill rides along when there is one — the person about to move
      // real money should not have to go hunting for the paperwork.
      if (pay.bill_file_id) {
        await bot.sendPhoto(id, pay.bill_file_id, { caption: text, ...opts }).catch(async () => {
          await bot.sendDocument(id, pay.bill_file_id, { caption: text, ...opts });
        });
      } else {
        await bot.sendMessage(id, text, opts);
      }
      sent += 1;
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
