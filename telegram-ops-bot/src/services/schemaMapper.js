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
    // Column K = notification_prefs (JSON object string). Stores per-user
    // opt-in/opt-out flags for the Admin Activity Feed events. Empty means
    // "use default policy" (currently: preserve today's all-ON behavior).
    headers: ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'department', 'warehouses', 'manages', 'notification_prefs'],
  },
  Departments: {
    headers: ['dept_id', 'dept_name', 'allowed_activities', 'status', 'created_at', 'parent_department'],
    seed: [
      ['DEPT-001', 'Sales', 'supply_request,upload_receipt,my_orders,give_sample,supply_details,customer_details,add_customer_note', 'active', '', ''],
      ['DEPT-002', 'Dispatch', 'mark_order_delivered,my_orders', 'active', '', ''],
      ['DEPT-003', 'Admin', '__all__', 'active', '', ''],
    ],
  },
  Tasks: {
    headers: [
      'task_id', 'title', 'description', 'assigned_to', 'assigned_by',
      'status', 'created_at', 'submitted_at', 'completed_at',
      // TG-7.5 Phase C — track + timestamps + negotiated timeline.
      'track', 'priority', 'assigned_at', 'accepted_at',
      'proposed_hours', 'proposed_deadline', 'negotiation_rounds',
      'timeline_agreed_at', 'started_at', 'approved_at', 'last_event_at',
    ],
  },
  // Money-side of the Tasks workflow. Kept in its own sheet so admin /
  // scrum-master Tasks views cannot leak incentive amounts. Only
  // config.access.financeIds users should be allowed to read this sheet
  // through the bot.
  Incentives: {
    headers: [
      'task_id', 'amount', 'currency', 'set_by', 'set_at',
      'doer_confirmed_at', 'paid_status', 'paid_at', 'paid_amount', 'notes',
    ],
  },
  // Append-only audit log; powers performance analysis (planned vs
  // actual duration, negotiation latency, Gantt timelines later).
  TaskEvents: {
    headers: [
      'event_id', 'task_id', 'event_type', 'from_status', 'to_status',
      'actor_user_id', 'at', 'meta_json',
    ],
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
  ProductTypes: {
    headers: ['type_id', 'type_name', 'container_label', 'container_short', 'subunit_label', 'measure_unit', 'has_subunits', 'status'],
    seed: [
      ['fabric', 'Fabric Rolls', 'Bale', 'bls', 'Than', 'yards', 'yes', 'active'],
      ['garment', 'Garments', 'Box', 'box', 'Piece', 'pcs', 'yes', 'active'],
      ['innerwear', 'Innerwear', 'Carton', 'ctn', 'Dozen', 'pcs', 'yes', 'active'],
    ],
  },
  UserPrefs: {
    headers: ['user_id', 'activity_counts', 'updated_at'],
  },
  CatalogStock: {
    headers: ['Design', 'CatalogSize', 'Warehouse', 'TotalQty', 'InOfficeQty', 'WithCustomersQty', 'WithMarketersQty', 'UpdatedAt'],
  },
  CatalogLedger: {
    headers: ['LedgerId', 'Design', 'CatalogSize', 'Warehouse', 'Quantity', 'Action', 'RecipientType', 'RecipientName', 'Status', 'DateOut', 'DateReturned', 'RequestedBy', 'ApprovedBy', 'ApprovalRequestId', 'Notes', 'CreatedAt'],
  },
  Marketers: {
    headers: ['MarketerId', 'Name', 'Phone', 'Area', 'PersonPhotoFileId', 'PersonPhotoDriveId', 'CatalogPhotoFileId', 'CatalogPhotoDriveId', 'Status', 'ApprovedBy', 'ApprovalRequestId', 'Notes', 'CreatedAt'],
  },
  // P2 — Goods Receipt Note (GRN) header doc. Bales themselves go into the
  // Inventory sheet directly with grn_id back-pointer; this sheet groups
  // them per "delivery" for audit and supplier reconciliation.
  GoodsReceipts: {
    headers: [
      'grn_id', 'warehouse', 'supplier', 'supplier_id', 'po_id',
      'received_by', 'received_at', 'total_bales', 'total_yards',
      'photo_file_id', 'notes', 'status',
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
      let userHeader = await sheets.readRange('Users', 'A1:Z1');
      let h = userHeader[0] || [];
      if (!h.includes('department')) {
        const nextCol = colLetter(h.length + 1);
        const endCol = colLetter(h.length + 2);
        await sheets.updateRange('Users', `${nextCol}1:${endCol}1`, [['department', 'warehouses']]);
        logger.info('SchemaMapper: extended Users with department, warehouses columns');
        userHeader = await sheets.readRange('Users', 'A1:Z1');
        h = userHeader[0] || [];
      }
      if (!h.includes('manages')) {
        const nextCol = colLetter(h.length + 1);
        await sheets.updateRange('Users', `${nextCol}1:${nextCol}1`, [['manages']]);
        logger.info('SchemaMapper: extended Users with manages column (TG-7.5)');
        userHeader = await sheets.readRange('Users', 'A1:Z1');
        h = userHeader[0] || [];
      }
      // T2 — per-user opt-in/out toggles for the Admin Activity Feed.
      if (!h.includes('notification_prefs')) {
        const nextCol = colLetter(h.length + 1);
        await sheets.updateRange('Users', `${nextCol}1:${nextCol}1`, [['notification_prefs']]);
        logger.info('SchemaMapper: extended Users with notification_prefs column (T2)');
      }
    } catch (e) {
      logger.warn('SchemaMapper: could not extend Users —', e.message);
    }
  }

  if (existing.includes('Departments')) {
    try {
      const deptHeader = await sheets.readRange('Departments', 'A1:Z1');
      const h = deptHeader[0] || [];
      if (!h.includes('parent_department')) {
        const nextCol = colLetter(h.length + 1);
        await sheets.updateRange('Departments', `${nextCol}1:${nextCol}1`, [['parent_department']]);
        logger.info('SchemaMapper: extended Departments with parent_department (TG-7.5)');
      }
    } catch (e) {
      logger.warn('SchemaMapper: could not extend Departments —', e.message);
    }
  }

  // TG-7.5 Phase C: extend pre-existing Tasks sheet with the new
  // negotiation + timestamp columns. New deployments get the full
  // header via REQUIRED_SHEETS above; this branch is only hit when
  // the sheet already existed with the legacy 9-column header.
  if (existing.includes('Tasks')) {
    try {
      const TASK_NEW_COLS = [
        'track', 'priority', 'assigned_at', 'accepted_at',
        'proposed_hours', 'proposed_deadline', 'negotiation_rounds',
        'timeline_agreed_at', 'started_at', 'approved_at', 'last_event_at',
      ];
      const taskHeader = await sheets.readRange('Tasks', 'A1:Z1');
      const h = taskHeader[0] || [];
      const missing = TASK_NEW_COLS.filter((c) => !h.includes(c));
      if (missing.length) {
        const startCol = colLetter(h.length + 1);
        const endCol = colLetter(h.length + missing.length);
        await sheets.updateRange('Tasks', `${startCol}1:${endCol}1`, [missing]);
        logger.info(`SchemaMapper: extended Tasks with ${missing.length} TG-7.5 columns (${missing.join(', ')})`);
      }
    } catch (e) {
      logger.warn('SchemaMapper: could not extend Tasks —', e.message);
    }
  }

  if (existing.includes('Inventory')) {
    try {
      let invHeader = await sheets.readRange('Inventory', 'A1:Z1');
      let h = invHeader[0] || [];
      if (!h.includes('ProductType')) {
        const nextCol = colLetter(h.length + 1);
        await sheets.updateRange('Inventory', `${nextCol}1:${nextCol}1`, [['ProductType']]);
        logger.info('SchemaMapper: extended Inventory with ProductType column');
        invHeader = await sheets.readRange('Inventory', 'A1:Z1');
        h = invHeader[0] || [];
      }
      // P1 — composite-key foundation: bale_uid + addedAt + grn_id columns.
      // Existing rows are left empty; inventoryRepository.parseRow injects a
      // synthetic BAL-LEGACY-<rowIndex> bale_uid at read time, and
      // backfillLegacyBales() may be invoked to persist them in a single
      // batch when the operator is ready.
      const INV_NEW_COLS = ['bale_uid', 'addedAt', 'grn_id'];
      const missingInv = INV_NEW_COLS.filter((c) => !h.includes(c));
      if (missingInv.length) {
        const startCol = colLetter(h.length + 1);
        const endCol = colLetter(h.length + missingInv.length);
        await sheets.updateRange('Inventory', `${startCol}1:${endCol}1`, [missingInv]);
        logger.info(`SchemaMapper: extended Inventory with ${missingInv.length} P1 columns (${missingInv.join(', ')})`);
      }
    } catch (e) {
      logger.warn('SchemaMapper: could not extend Inventory —', e.message);
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
