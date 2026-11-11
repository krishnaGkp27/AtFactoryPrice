/**
 * Accounting service. Sales and returns: single entry (Customer Receivable only).
 * Payments: double entry (Cash/Bank DR, Receivable CR). Sales Revenue in trial balance derived from receivable sale debits (Option B).
 */

const ledgerRepo = require('../repositories/ledgerRepository');
const { todayInLagos } = require('../utils/dates');
const chartRepo = require('../repositories/chartOfAccountsRepository');
const idGen = require('../utils/idGenerator');
// CUR-1 R7 — narrations keep the accounting CODE (`NGN 5000`), forward-only;
// money.code() is the one source of it. Never a display symbol here.
const money = require('../utils/money');
const bankEntry = require('../utils/bankEntry');

const CURRENCY = money.code();
const RECEIVABLE_CODE = '1100';
const REVENUE_CODE = '3001';

async function getAccountCode(name) {
  const acc = await chartRepo.findByName(name);
  return acc ? acc.account_code : null;
}

/** Single entry: one row to Customer Receivable (debit). Narration includes payment status at time of sale. */
async function recordSale({ customer, customerId, yards, pricePerYard, packageNo, design, shade, userId, txnId, paymentMode, amountPaid }) {
  const amount = (yards || 0) * (pricePerYard || 0);
  if (amount <= 0) return;
  // TIME-1 — this row's business date decides which daybook and which line
  // of the customer's statement it lands on. The UTC day put every entry
  // made after Lagos midnight onto the previous day, permanently.
  const date = todayInLagos();
  const debitCode = await getAccountCode('Customer Receivable') || RECEIVABLE_CODE;
  const payMode = (paymentMode || '').trim() || 'Not yet paid';
  const paid = Number(amountPaid) || 0;
  const paymentDetail = paid > 0 ? ` | ${payMode} ${CURRENCY} ${paid}` : ` | ${payMode}`;
  const narration = `Sale: ${yards} yds ${design || ''} ${shade || ''} pkg ${packageNo || ''} to ${customer || 'unknown'}${paymentDetail}`;
  await ledgerRepo.append({
    entry_id: idGen.ledgerEntry(), txn_id: txnId || '', date, account_code: debitCode, ledger_name: 'Customer Receivable',
    debit: amount, credit: 0, narration, created_by: userId || '',
    customer_id: customerId || '',
  });
  return { amount, narration };
}

/** Single entry: one row to Customer Receivable (credit).
 *  CUS-2: returns now carry the customer (name in narration, id in column K)
 *  so the credit shows up on the right customer's statement instead of
 *  floating anonymously in the receivable account. */
async function recordReturn({ yards, pricePerYard, packageNo, design, shade, userId, txnId, customer, customerId }) {
  const amount = (yards || 0) * (pricePerYard || 0);
  if (amount <= 0) return;
  // TIME-1 — this row's business date decides which daybook and which line
  // of the customer's statement it lands on. The UTC day put every entry
  // made after Lagos midnight onto the previous day, permanently.
  const date = todayInLagos();
  const creditCode = await getAccountCode('Customer Receivable') || RECEIVABLE_CODE;
  const narration = `Return: ${yards} yds ${design || ''} ${shade || ''} pkg ${packageNo || ''}${customer ? ` from ${customer}` : ''}`;
  await ledgerRepo.append({
    entry_id: idGen.ledgerEntry(), txn_id: txnId || '', date, account_code: creditCode, ledger_name: 'Customer Receivable',
    debit: 0, credit: amount, narration, created_by: userId || '',
    customer_id: customerId || '',
  });
}

/** Upper-cased words of a mode or a bank name, for whole-word comparison. */
function modeWords(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * FIX-BANKLEDGER — the ONE place a payment mode becomes the Cash or the Bank
 * account. Pure: `banks` is the Settings BANK_LIST as an array.
 *
 * Until 11-Nov-2026 the rule was "the mode contains the word bank", so the
 * sale wizard's bank chip — stored `Paid to Zenith`, `Paid to GTB`,
 * `Paid to Opay` — was booked to Cash (R-9BF6; bale-yards check item A6).
 *
 *   the word "bank" anywhere              → Bank  (the rule before, kept)
 *   `Cash`, also `Paid to cash`           → Cash
 *   the wizard's `Paid to <bank>` shape   → Bank
 *   names a bank on BANK_LIST             → Bank  (any case, whole words; a
 *                                           "BANK — ACCOUNT" entry also by
 *                                           its bank half)
 *   anything else                         → Cash  (the rule before, kept)
 *
 * It only reads the mode: the stored text is never rewritten.
 */
function paymentAccountFor(method, banks) {
  const raw = String(method == null ? '' : method).trim();
  if (!raw) return 'Cash';
  if (raw.toLowerCase().includes('bank')) return 'Bank';
  const paidTo = /^paid\s+to\s+(.+)$/i.exec(raw);
  const words = modeWords(paidTo ? paidTo[1] : raw);
  if (words === 'CASH') return 'Cash';
  if (paidTo) return 'Bank';
  const padded = ` ${words} `;
  for (const entry of Array.isArray(banks) ? banks : []) {
    for (const name of [modeWords(entry), modeWords(bankEntry.parse(entry).bank)]) {
      if (name && padded.includes(` ${name} `)) return 'Bank';
    }
  }
  return 'Cash';
}

/** Settings BANK_LIST as an array; an unreadable list is an empty one (the
 *  rule before then stands) — booking a payment never fails on this read. */
async function registeredBanks() {
  try {
    const all = await require('../repositories/settingsRepository').getAll();
    return String((all && all.BANK_LIST) || '').split(',').map((b) => b.trim()).filter(Boolean);
  } catch (_) { return []; }
}

async function recordPaymentReceived({ customer, customerId, amount, method, userId, txnId }) {
  if (!amount || amount <= 0) return;
  // TIME-1 — this row's business date decides which daybook and which line
  // of the customer's statement it lands on. The UTC day put every entry
  // made after Lagos midnight onto the previous day, permanently.
  const date = todayInLagos();
  const cashOrBank = paymentAccountFor(method, await registeredBanks());
  // A Bank payment must never fall back to the Cash code (1001).
  const debitCode = await getAccountCode(cashOrBank) || (cashOrBank === 'Bank' ? '1002' : '1001');
  const creditCode = await getAccountCode('Customer Receivable') || '1100';
  const narration = `Payment received from ${customer || 'unknown'}: ${CURRENCY} ${amount} via ${cashOrBank}`;
  // CUS-2 — payments stamp customer_id like sales do, so the customer
  // ledger scopes by id instead of grepping narrations.
  await ledgerRepo.appendPair(
    { entry_id: idGen.ledgerEntry(), txn_id: txnId || '', date, account_code: debitCode, ledger_name: cashOrBank, debit: amount, narration, created_by: userId || '', customer_id: customerId || '' },
    { entry_id: idGen.ledgerEntry(), txn_id: txnId || '', date, account_code: creditCode, ledger_name: 'Customer Receivable', credit: amount, narration, created_by: userId || '', customer_id: customerId || '' },
  );
}

async function getLedgerBalance(accountCode) {
  const entries = await ledgerRepo.findByAccount(accountCode);
  const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
  const totalCredit = entries.reduce((s, e) => s + e.credit, 0);
  return { accountCode, totalDebit, totalCredit, balance: totalDebit - totalCredit };
}

/** Trial balance. Sales Revenue (3001): derived from Customer Receivable debits where narration starts with "Sale:" (Option B). */
async function getTrialBalance() {
  const accounts = await chartRepo.getAll();
  const all = await ledgerRepo.getAll();
  const receivableCode = await getAccountCode('Customer Receivable') || RECEIVABLE_CODE;
  const revenueCode = await getAccountCode('Sales Revenue') || REVENUE_CODE;
  const derivedRevenue = all
    .filter((e) => e.account_code === receivableCode && (e.narration || '').trim().startsWith('Sale:'))
    .reduce((s, e) => s + (e.debit || 0), 0);
  const results = [];
  for (const acc of accounts) {
    const entries = all.filter((e) => e.account_code === acc.account_code);
    let debit = entries.reduce((s, e) => s + (e.debit || 0), 0);
    let credit = entries.reduce((s, e) => s + (e.credit || 0), 0);
    if (acc.account_code === revenueCode) {
      credit += derivedRevenue;
    }
    if (debit || credit) {
      results.push({ ...acc, totalDebit: debit, totalCredit: credit, balance: debit - credit });
    }
  }
  return results;
}

async function getDaybook(date) {
  const target = date || todayInLagos();  // TIME-1 — Lagos day, not UTC
  return ledgerRepo.findByDateRange(target, target);
}

/**
 * Get customer ledger (Customer Receivable only). Optional fromDate, toDate (YYYY-MM-DD) filter entries to that range.
 * Always returns outstandingAsOfToday (full ledger balance). For range view, outstanding = balance at end of range.
 */
/**
 * CUS-2 — does this narration name exactly this customer? Boundary-anchored
 * against the exact templates recordSale / recordPaymentReceived /
 * recordReturn write, replacing the old raw substring test that let
 * "Musa" pull "Alhaji Musa"'s rows into a statement (cross-customer
 * leak) and dropped alias-spelled history after merges.
 */
function narrationNames(narration, name) {
  const s = String(narration || '').toLowerCase();
  const n = String(name || '').trim().toLowerCase();
  if (!s || !n) return false;
  return s.includes(` to ${n} | `) || s.endsWith(` to ${n}`)
    || s.includes(`payment received from ${n}: `)
    || s.endsWith(` from ${n}`);
}

async function getCustomerLedger(customerName, fromDate, toDate) {
  const receivableCode = await getAccountCode('Customer Receivable') || RECEIVABLE_CODE;
  const receivableEntries = await ledgerRepo.findByAccount(receivableCode);
  const q = (customerName || '').toString().trim();
  // CUS-2 — resolve to the entity (accepts an id or any live spelling);
  // entries match by stamped customer_id first, then by precise narration
  // match across every spelling the customer has ever been filed under.
  let cust = null;
  try {
    cust = await require('./customerEntity').resolve({ id: q, name: q });
  } catch (_) { /* fall through to name-only matching */ }
  const names = cust
    ? require('./customerEntity').namesFor(cust)
    : (q ? [q] : []);
  // History stamped under a merged-away row's id still belongs to this
  // customer: collect the ids of husk rows whose name lives on as one of
  // this customer's spellings.
  const acceptIds = new Set();
  if (cust) {
    acceptIds.add(cust.customer_id);
    try {
      const lowerNames = new Set(names.map((n) => String(n).trim().toLowerCase()));
      const allCust = await require('../repositories/customersRepository').getAll();
      for (const c of allCust) {
        if (String(c.status || '').trim().toLowerCase() === 'merged'
          && lowerNames.has(String(c.name || '').trim().toLowerCase())) {
          acceptIds.add(c.customer_id);
        }
      }
    } catch (_) { /* canonical id alone still matches */ }
  }
  const allEntries = names.length ? receivableEntries.filter((e) => (
    (e.customer_id && acceptIds.has(e.customer_id))
    || (!e.customer_id && names.some((n) => narrationNames(e.narration, n)))
  )) : [];
  allEntries.sort((a, b) => (a.date + (a.created_at || '')).localeCompare(b.date + (b.created_at || '')));
  let runningFull = 0;
  const withRunning = allEntries.map((e) => {
    runningFull += (e.debit || 0) - (e.credit || 0);
    return { ...e, running: runningFull };
  });
  const outstandingAsOfToday = runningFull;

  if (fromDate && toDate) {
    const filtered = withRunning.filter((e) => e.date >= fromDate && e.date <= toDate);
    const totalDebit = filtered.reduce((s, e) => s + (e.debit || 0), 0);
    const totalCredit = filtered.reduce((s, e) => s + (e.credit || 0), 0);
    const lastInRange = filtered[filtered.length - 1];
    const outstandingAtEndOfRange = lastInRange ? lastInRange.running : 0;
    return {
      entries: filtered,
      totalDebit,
      totalCredit,
      outstanding: outstandingAtEndOfRange,
      outstandingAsOfToday,
    };
  }
  const totalDebit = allEntries.reduce((s, e) => s + (e.debit || 0), 0);
  const totalCredit = allEntries.reduce((s, e) => s + (e.credit || 0), 0);
  return {
    entries: withRunning,
    totalDebit,
    totalCredit,
    outstanding: totalDebit - totalCredit,
    outstandingAsOfToday,
  };
}

module.exports = { recordSale, recordReturn, recordPaymentReceived, paymentAccountFor, getLedgerBalance, getTrialBalance, getDaybook, getCustomerLedger };
