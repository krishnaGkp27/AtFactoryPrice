/**
 * Data access for Ledger_Entries sheet (append-only double-entry journal).
 */

const sheets = require('./sheetsClient');

const SHEET = 'Ledger_Entries';

function parse(r) {
  return {
    entry_id: (r[0] || '').toString().trim(),
    txn_id: (r[1] || '').toString().trim(),
    date: (r[2] || '').toString().trim(),
    account_code: (r[3] || '').toString().trim(),
    ledger_name: (r[4] || '').toString().trim(),
    debit: parseFloat(r[5]) || 0,
    credit: parseFloat(r[6]) || 0,
    narration: (r[7] || '').toString().trim(),
    created_by: (r[8] || '').toString().trim(),
    created_at: (r[9] || '').toString().trim(),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:J');
  return rows.map(parse).filter((r) => r.entry_id);
}

async function append(entry) {
  await sheets.appendRows(SHEET, [[
    entry.entry_id, entry.txn_id, entry.date, entry.account_code, entry.ledger_name,
    entry.debit || 0, entry.credit || 0, entry.narration || '',
    entry.created_by || '', entry.created_at || new Date().toISOString(),
  ]]);
}

async function appendPair(debitEntry, creditEntry) {
  await sheets.appendRows(SHEET, [
    [debitEntry.entry_id, debitEntry.txn_id, debitEntry.date, debitEntry.account_code, debitEntry.ledger_name,
     debitEntry.debit || 0, 0, debitEntry.narration || '', debitEntry.created_by || '', debitEntry.created_at || new Date().toISOString()],
    [creditEntry.entry_id, creditEntry.txn_id, creditEntry.date, creditEntry.account_code, creditEntry.ledger_name,
     0, creditEntry.credit || 0, creditEntry.narration || '', creditEntry.created_by || '', creditEntry.created_at || new Date().toISOString()],
  ]);
}

async function findByTxnId(txnId) {
  const all = await getAll();
  return all.filter((e) => e.txn_id === txnId);
}

async function findByAccount(accountCode) {
  const all = await getAll();
  return all.filter((e) => e.account_code === accountCode);
}

async function findByDateRange(from, to) {
  const all = await getAll();
  return all.filter((e) => e.date >= from && e.date <= to);
}

module.exports = { getAll, append, appendPair, findByTxnId, findByAccount, findByDateRange, SHEET };
