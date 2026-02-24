/**
 * Schema mapper: detects existing sheets/columns, creates missing ones, seeds defaults.
 * Runs once on startup. Never renames or removes existing structures.
 */

const sheets = require('../repositories/sheetsClient');
const logger = require('../utils/logger');

const REQUIRED_SHEETS = {
  Chart_of_Accounts: {
    headers: ['account_code', 'account_name', 'account_type', 'parent_code', 'is_active'],
    seed: [
      ['1001', 'Cash', 'Asset', '1000', 'TRUE'],
      ['1002', 'Bank', 'Asset', '1000', 'TRUE'],
      ['1100', 'Customer Receivable', 'Asset', '1000', 'TRUE'],
      ['1200', 'Inventory Asset', 'Asset', '1000', 'TRUE'],
      ['2001', 'Supplier Payable', 'Liability', '2000', 'TRUE'],
      ['3001', 'Sales Revenue', 'Revenue', '3000', 'TRUE'],
      ['3002', 'Cost of Goods Sold', 'Expense', '3000', 'TRUE'],
      ['3003', 'Purchase Expense', 'Expense', '3000', 'TRUE'],
    ],
  },
  Ledger_Entries: {
    headers: ['entry_id', 'txn_id', 'date', 'account_code', 'ledger_name', 'debit', 'credit', 'narration', 'created_by', 'created_at'],
  },
  Stock_Ledger: {
    headers: ['entry_id', 'date', 'item_id', 'package_no', 'branch', 'type', 'qty_in', 'qty_out', 'reference_id', 'created_at'],
  },
  Customers: {
    headers: ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at'],
  },
  Users: {
    headers: ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at'],
  },
};

const AUDIT_EXTENDED_HEADERS = ['Module', 'ReferenceId'];

let schemaCache = null;

async function initialize() {
  logger.info('SchemaMapper: detecting existing sheets...');
  const existing = await sheets.getSheetNames();
  logger.info(`SchemaMapper: found sheets: ${existing.join(', ')}`);

  for (const [name, def] of Object.entries(REQUIRED_SHEETS)) {
    if (existing.includes(name)) {
      logger.info(`SchemaMapper: sheet "${name}" exists — reusing`);
    } else {
      logger.info(`SchemaMapper: creating sheet "${name}"`);
      await sheets.addSheet(name);
      await sheets.updateRange(name, `A1:${colLetter(def.headers.length)}1`, [def.headers]);
      if (def.seed && def.seed.length) {
        await sheets.appendRows(name, def.seed);
        logger.info(`SchemaMapper: seeded ${def.seed.length} default rows into "${name}"`);
      }
    }
  }

  if (existing.includes('AuditLog')) {
    try {
      const headerRow = await sheets.readRange('AuditLog', 'A1:F1');
      const h = headerRow[0] || [];
      if (!h.includes('Module')) {
        const nextCol = colLetter(h.length);
        const endCol = colLetter(h.length + AUDIT_EXTENDED_HEADERS.length - 1);
        await sheets.updateRange('AuditLog', `${nextCol}1:${endCol}1`, [AUDIT_EXTENDED_HEADERS]);
        logger.info('SchemaMapper: extended AuditLog with Module, ReferenceId columns');
      }
    } catch (e) {
      logger.warn('SchemaMapper: could not extend AuditLog —', e.message);
    }
  }

  schemaCache = { existing, initialized: true };
  logger.info('SchemaMapper: initialization complete');
  return schemaCache;
}

function colLetter(n) {
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function getCache() { return schemaCache; }

module.exports = { initialize, getCache, REQUIRED_SHEETS };
