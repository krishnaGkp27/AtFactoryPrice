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
    headers: ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'department', 'warehouses'],
  },
  Departments: {
    headers: ['dept_id', 'dept_name', 'allowed_activities', 'status', 'created_at'],
    seed: [
      ['DEPT-001', 'Sales', 'supply_request,upload_receipt,my_orders,give_sample,supply_details,customer_history,customer_pattern,show_customer_notes', 'active'],
      ['DEPT-002', 'Dispatch', 'mark_order_delivered,my_orders', 'active'],
      ['DEPT-003', 'Admin', '__all__', 'active'],
    ],
  },
  Tasks: {
    headers: ['task_id', 'title', 'description', 'assigned_to', 'assigned_by', 'status', 'created_at', 'submitted_at', 'completed_at'],
  },
  Contacts: {
    headers: ['contact_id', 'name', 'phone', 'type', 'address', 'notes', 'created_at'],
  },
  // Industry-standard customer ledger architecture (scalable for invoices, analytics, reports)
  Ledger_Customers: {
    headers: ['customer_id', 'customer_name', 'phone', 'credit_limit', 'created_at', 'status'],
  },
  LedgerTransactions: {
    headers: ['txn_id', 'timestamp', 'customer_id', 'txn_type', 'direction', 'amount', 'description', 'reference', 'created_by', 'status'],
  },
  LedgerBalanceCache: {
    headers: ['customer_id', 'balance', 'last_updated'],
  },
  Orders: {
    headers: [
      'order_id', 'design', 'shade', 'customer', 'quantity',
      'salesperson_id', 'salesperson_name', 'payment_status', 'scheduled_date',
      'status', 'created_by', 'created_at', 'accepted_at', 'delivered_at', 'reminder_sent',
    ],
  },
  Samples: {
    headers: [
      'sample_id', 'design', 'shade', 'sample_type', 'customer', 'quantity',
      'date_given', 'followup_date', 'status', 'updated_by',
      'created_at', 'updated_at', 'notes', 'reminder_sent',
    ],
  },
  CustomerFollowups: {
    headers: ['followup_id', 'customer', 'reason', 'followup_date', 'status', 'created_by', 'created_at', 'reminder_sent'],
  },
  CustomerNotes: {
    headers: ['note_id', 'customer', 'note', 'created_by', 'created_at'],
  },
  Receipts: {
    headers: [
      'receipt_id', 'customer', 'amount', 'bank_account',
      'uploaded_by_id', 'uploaded_by_name', 'telegram_file_id', 'file_type',
      'drive_file_id', 'drive_url', 'status', 'approved_by',
      'upload_date', 'created_at', 'notes',
    ],
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

  // Extend Transactions sheet with sale detail columns if missing
  if (existing.includes('Transactions')) {
    try {
      const txnHeader = await sheets.readRange('Transactions', 'A1:Q1');
      const h = txnHeader[0] || [];
      if (h.length < 15 && !h.includes('SalesDate')) {
        const extCols = ['SalesDate', 'Warehouse', 'CustomerName', 'SalesPerson', 'PaymentMode', 'SaleRefId'];
        const nextCol = colLetter(h.length + 1);
        const endCol = colLetter(h.length + extCols.length);
        await sheets.updateRange('Transactions', `${nextCol}1:${endCol}1`, [extCols]);
        logger.info('SchemaMapper: extended Transactions with sale detail columns');
      }
      if (h.length < 17 && !h.includes('PricePerYard')) {
        const nextCol = colLetter(h.length + 1);
        const endCol = colLetter(h.length + 2);
        await sheets.updateRange('Transactions', `${nextCol}1:${endCol}1`, [['PricePerYard', 'AmountPaid']]);
        logger.info('SchemaMapper: extended Transactions with PricePerYard, AmountPaid');
      }
    } catch (e) {
      logger.warn('SchemaMapper: could not extend Transactions —', e.message);
    }
  }

  if (existing.includes('Users')) {
    try {
      const userHeader = await sheets.readRange('Users', 'A1:I1');
      const h = userHeader[0] || [];
      if (!h.includes('department')) {
        const nextCol = colLetter(h.length + 1);
        const endCol = colLetter(h.length + 2);
        await sheets.updateRange('Users', `${nextCol}1:${endCol}1`, [['department', 'warehouses']]);
        logger.info('SchemaMapper: extended Users with department, warehouses columns');
      }
    } catch (e) {
      logger.warn('SchemaMapper: could not extend Users —', e.message);
    }
  }

  // Seed BANK_LIST in Settings if not present
  if (existing.includes('Settings')) {
    try {
      const settingsRepo = require('../repositories/settingsRepository');
      const all = await settingsRepo.getAll();
      if (!all.BANK_LIST) {
        await settingsRepo.set('BANK_LIST', 'GTBank,Zenith,FirstBank,Access,UBA');
        logger.info('SchemaMapper: seeded default BANK_LIST in Settings');
      }
    } catch (e) {
      logger.warn('SchemaMapper: could not seed BANK_LIST —', e.message);
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
