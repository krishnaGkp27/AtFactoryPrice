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
};

/** Manufacturing sheets — created in the NYN spreadsheet (MFG_GOOGLE_SHEET_ID). */
const MFG_REQUIRED_SHEETS = {
  Production: {
    headers: [
      'article_no', 'description', 'created_by', 'created_at', 'article_status', 'current_stage',
      'fabric_vendor', 'fabric_receive_date', 'fabric_weight_kg', 'cut_weight_kg', 'waste_weight_kg', 'cut_pieces', 'cut_start_date', 'cut_end_date', 'cut_hours',
      'emb_vendor', 'emb_qty_dispatched', 'emb_dispatch_date', 'emb_qty_received', 'emb_receive_date', 'emb_duration_days', 'emb_hours',
      'stitch_start_date', 'stitch_end_date', 'stitch_qty', 'stitch_hours',
      'threadcut_date', 'threadcut_qty', 'threadcut_hours',
      'iron_start_date', 'iron_end_date', 'iron_qty', 'iron_hours',
      'qc_qty_passed', 'qc_qty_rejected', 'qc_date',
      'pkg_dimension', 'size_breakdown', 'final_stock', 'pkg_date',
    ],
  },
  Fabric_Vendors: {
    headers: ['vendor_code', 'vendor_name', 'contact', 'status', 'created_at'],
  },
  EMB_Vendors: {
    headers: ['vendor_code', 'vendor_name', 'contact', 'status', 'created_at'],
  },
  MFG_Approvals: {
    headers: ['approval_id', 'article_no', 'stage', 'data_json', 'submitted_by', 'status', 'reviewed_by', 'created_at', 'reviewed_at'],
  },
  MFG_Rejections: {
    headers: ['rejection_id', 'article_no', 'qty', 'reason', 'from_stage', 'to_stage', 'status', 'approved_by', 'created_by', 'created_at', 'resolved_at'],
  },
  MFG_Activity_Log: {
    headers: ['log_id', 'timestamp', 'article_no', 'stage', 'action', 'field', 'old_value', 'new_value', 'user_id', 'status'],
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

  // ─── Manufacturing sheets in NYN spreadsheet (MFG_GOOGLE_SHEET_ID) ──────────
  const config = require('../config');
  const mfgSheetId = config.sheets.mfgSheetId;
  if (mfgSheetId) {
    const mfgSheets = require('../repositories/mfgSheetsClient');
    try {
      const mfgExisting = await mfgSheets.getSheetNames();
      logger.info(`SchemaMapper [NYN]: found sheets: ${mfgExisting.join(', ')}`);
      for (const [name, def] of Object.entries(MFG_REQUIRED_SHEETS)) {
        if (mfgExisting.includes(name)) {
          logger.info(`SchemaMapper [NYN]: sheet "${name}" exists — reusing`);
        } else {
          logger.info(`SchemaMapper [NYN]: creating sheet "${name}"`);
          await mfgSheets.addSheet(name);
          await mfgSheets.updateRange(name, `A1:${colLetter(def.headers.length)}1`, [def.headers]);
        }
      }
      logger.info('SchemaMapper [NYN]: manufacturing sheets initialized');
    } catch (e) {
      logger.error('SchemaMapper [NYN]: MFG sheet init error —', e.message);
    }
  } else {
    logger.warn('SchemaMapper: MFG_GOOGLE_SHEET_ID not set — manufacturing sheets will not be initialized. Set it to use a separate spreadsheet for NYN.');
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

module.exports = { initialize, getCache, REQUIRED_SHEETS, MFG_REQUIRED_SHEETS };
