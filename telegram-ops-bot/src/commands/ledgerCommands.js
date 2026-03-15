/**
 * Ledger admin commands: /ledger, /balance, /payment.
 * Uses the industry-standard ledger services (Transaction, Ledger, Balance).
 * Pagination: ledger entries split into messages of up to 20 rows each.
 */

const ledgerService = require('../services/ledgerService');
const balanceService = require('../services/balanceService');
const transactionService = require('../services/transactionService');
const ledgerCustomersRepository = require('../repositories/ledgerCustomersRepository');
const idGen = require('../utils/idGenerator');
const auth = require('../middlewares/auth');
const config = require('../config');

const CURRENCY = config.currency || 'NGN';
const LEDGER_PAGE_SIZE = 20;

function fmtMoney(n) {
  return `${CURRENCY} ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`;
}

/**
 * /ledger <customer_id>
 * Output format: Date | Description | Debit | Credit | Balance
 * If more than 20 rows, send multiple messages.
 */
async function handleLedger(bot, chatId, userId, args) {
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId, 'This command is for admins only.');
    return;
  }
  const customerId = (args || '').trim();
  if (!customerId) {
    await bot.sendMessage(chatId, 'Usage: /ledger <customer_id>\nExample: /ledger CUST-20260221-001');
    return;
  }

  const result = await ledgerService.getCustomerLedger(customerId);
  if (!result.ok) {
    await bot.sendMessage(chatId, result.message || 'Failed to load ledger.');
    return;
  }

  const { customer, rows } = result;
  const header = `📒 Ledger: ${customer.customer_name} (${customer.customer_id})\n\nDate       | Description        | Debit    | Credit   | Balance`;
  const line = (r) => `${r.date} | ${(r.description || '').slice(0, 18).padEnd(18)} | ${r.debit ? fmtMoney(r.debit) : '—'.padEnd(8)} | ${r.credit ? fmtMoney(r.credit) : '—'.padEnd(8)} | ${fmtMoney(r.balance)}`;

  if (!rows.length) {
    await bot.sendMessage(chatId, `${header}\n\nNo transactions yet.`);
    return;
  }

  for (let i = 0; i < rows.length; i += LEDGER_PAGE_SIZE) {
    const page = rows.slice(i, i + LEDGER_PAGE_SIZE);
    const body = page.map(line).join('\n');
    const text = i === 0 ? `${header}\n${body}` : body;
    const footer = i + page.length < rows.length ? `\n_(page ${Math.floor(i / LEDGER_PAGE_SIZE) + 1}, next ${Math.min(LEDGER_PAGE_SIZE, rows.length - i - page.length)} entries)_` : '';
    await bot.sendMessage(chatId, text + footer, { parse_mode: 'Markdown' });
  }
}

/**
 * /balance <customer_id>
 */
async function handleBalance(bot, chatId, userId, args) {
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId, 'This command is for admins only.');
    return;
  }
  const customerId = (args || '').trim();
  if (!customerId) {
    await bot.sendMessage(chatId, 'Usage: /balance <customer_id>\nExample: /balance CUST-20260221-001');
    return;
  }

  const result = await balanceService.getCustomerBalance(customerId);
  if (!result.ok) {
    await bot.sendMessage(chatId, result.message || 'Failed to get balance.');
    return;
  }

  await bot.sendMessage(chatId, `💰 *${result.customer_name}* (${customerId})\nBalance: ${fmtMoney(result.balance)}`, { parse_mode: 'Markdown' });
}

/**
 * /payment <customer_id> <amount>
 * Creates a PAYMENT transaction (credit) to reduce receivable.
 */
async function handlePayment(bot, chatId, userId, args) {
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId, 'This command is for admins only.');
    return;
  }
  const parts = (args || '').trim().split(/\s+/);
  const customerId = parts[0];
  const amountStr = parts[1];
  if (!customerId || !amountStr) {
    await bot.sendMessage(chatId, 'Usage: /payment <customer_id> <amount>\nExample: /payment CUST-20260221-001 50000');
    return;
  }

  const amount = parseFloat(amountStr.replace(/,/g, ''));
  if (isNaN(amount) || amount <= 0) {
    await bot.sendMessage(chatId, 'Please enter a valid positive amount.');
    return;
  }

  const result = await transactionService.createTransaction(
    customerId,
    'PAYMENT',
    'credit',
    amount,
    `Payment received`,
    '',
    String(userId)
  );

  if (!result.ok) {
    await bot.sendMessage(chatId, result.message || 'Payment failed.');
    return;
  }

  await bot.sendMessage(chatId, `✅ Payment recorded. New balance: ${fmtMoney(result.balance)}`);
}

/**
 * /addledgercustomer <customer_name> [phone] [credit_limit]
 * Creates a customer in Ledger_Customers so /ledger, /balance, /payment can be used.
 */
async function handleAddLedgerCustomer(bot, chatId, userId, args) {
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId, 'This command is for admins only.');
    return;
  }
  const parts = (args || '').trim().split(/\s+/);
  const customerName = parts[0];
  if (!customerName) {
    await bot.sendMessage(chatId, 'Usage: /addledgercustomer <customer_name> [phone] [credit_limit]\nExample: /addledgercustomer Acme Ltd +2348000000 500000');
    return;
  }
  const phone = parts[1] || '';
  const creditLimit = parseFloat(parts[2]) || 0;
  const customerId = idGen.customer();
  await ledgerCustomersRepository.append({
    customer_id: customerId,
    customer_name: customerName,
    phone,
    credit_limit: creditLimit,
    status: 'Active',
  });
  await bot.sendMessage(chatId, `✅ Ledger customer added.\nID: ${customerId}\nName: ${customerName}\nUse /ledger ${customerId} or /payment ${customerId} <amount>`);
}

module.exports = {
  handleLedger,
  handleBalance,
  handlePayment,
  handleAddLedgerCustomer,
};
