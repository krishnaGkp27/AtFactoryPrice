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
    // MG-1: column G `warehouses` is a CSV of warehouse names this
    // department (when used as a marketing group) draws stock from.
    // Empty for non-marketing departments — harmless. resolveGroup()
    // in marketerOverlay.js keys "is this dept a marketing group?" on
    // whether this column is non-empty.
    headers: ['dept_id', 'dept_name', 'allowed_activities', 'status', 'created_at', 'parent_department', 'warehouses'],
    seed: [
      ['DEPT-001', 'Sales', 'supply_request,upload_receipt,my_orders,give_sample,supply_details,customer_details,add_customer_note', 'active', '', '', ''],
      ['DEPT-002', 'Dispatch', 'mark_order_delivered,my_orders', 'active', '', '', ''],
      ['DEPT-003', 'Admin', '__all__', 'active', '', '', ''],
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
      // P2.5 — bulk-import provenance (CSV/XLSX). Empty for manual GRNs.
      'source', 'file_hash',
      // FILE-C1 — clickable Drive URL + readable Drive filename for any
      // non-manual receipt (bulk + photo OCR). Empty for interactive GRNs.
      'source_url', 'source_filename',
      // LANDED-COST C1 — landed-cost finalisation state. All 8 cols are
      // empty for a freshly-received GRN; populated when admin runs the
      // "Finalize Landed Cost" flow and the 2nd admin approves.
      //   lc_status: provisional | pending_approval | finalized
      //   lc_usd_per_yard: admin's USD-cost-per-yard input
      //   lc_charges_usd:  sum of ContainerCharges rows for this GRN
      //   lc_fx_rate:      FX rate locked from ForexRates at finalize time
      //   lc_ngn_per_yard: (usd_per_yard + charges_usd/total_yards) * fx_rate
      //   lc_finalized_at, lc_finalized_by, lc_request_id
      'lc_status', 'lc_usd_per_yard', 'lc_charges_usd', 'lc_fx_rate',
      'lc_ngn_per_yard', 'lc_finalized_at', 'lc_finalized_by', 'lc_request_id',
    ],
  },
  // P4 — Procurement Order header. Drafted before goods arrive; GRN flow
  // may optionally reference po_id so receipts auto-reconcile against the
  // PO's lines and advance its status.
  ProcurementOrders: {
    headers: [
      'po_id', 'supplier', 'supplier_id', 'expected_date', 'status',
      'created_by', 'created_at', 'updated_at', 'photo_file_id', 'notes',
    ],
  },
  ProcurementOrderLines: {
    headers: [
      'line_id', 'po_id', 'design', 'shade', 'qty_bales', 'qty_yards',
      'unit_price', 'received_bales', 'received_yards',
    ],
  },
  // USR-C2 — strangers who sent /start but aren't in the Users sheet yet.
  // Admin sees a notification with [Onboard] | [Ignore]; Onboard routes
  // into the dual-admin Add Employee flow (USR-C3).
  PendingUsers: {
    headers: [
      'telegram_id', 'username', 'first_name', 'last_name',
      'arrived_at', 'status', 'last_notified_msg_id',
      'handled_by', 'handled_at',
    ],
  },
  // ATT-C1 — daily attendance log. One row per (date, telegram_id).
  // V1 stores only 'present' marks; missing rows imply not-yet-logged
  // (the C3 scheduler will later auto-stamp `not_logged` after the
  // configured cutoff so the next morning's report is clean).
  Attendance: {
    headers: [
      'date', 'telegram_id', 'employee_name', 'status',
      'location', 'logged_at', 'logged_via', 'marked_by', 'reason',
    ],
  },
  // TG-INT 1.4 — manual FX rates entered by admin/finance. The forex
  // adapter's `manual` provider reads from this sheet: most recent
  // entry on/before the queried date wins. API providers (when wired)
  // can write back here too so we get a unified rate history.
  ForexRates: {
    headers: ['date', 'base', 'quote', 'rate', 'source', 'entered_by', 'entered_at', 'notes'],
  },
  // TG-INT 1.3 — courier tracking events. One row per status update.
  // Multiple rows per tracking_number form a chronological trail.
  ShipmentEvents: {
    headers: [
      'event_id', 'tracking_number', 'carrier', 'status', 'description',
      'location', 'event_time', 'fetched_at', 'reference_id', 'raw_json',
    ],
  },
  // TG-INT 1.2 — raw bank-feed transactions before reconciliation.
  // Reconciler reads here, writes the match into Ledger_Entries.
  BankFeed: {
    headers: [
      'txn_id', 'account_id', 'posted_at', 'amount', 'currency',
      'direction', 'counterparty', 'narration', 'reference',
      'fetched_at', 'matched_ledger_entry_id', 'reconciliation_status',
    ],
  },
  // TG-INT 1.1 — WhatsApp message templates registered with the
  // provider. Admin maintains this; bot uses it to know which template
  // names + variables are available for outbound.
  WhatsAppTemplates: {
    headers: ['template_id', 'name', 'language', 'category', 'body', 'variables', 'status', 'updated_at'],
  },
  // TG-INT 1.1 — outbound message log (one row per send attempt).
  // Reconciles to provider delivery webhooks when those land.
  WhatsAppOutbound: {
    headers: [
      'send_id', 'recipient_phone', 'template_name', 'variables_json',
      'status', 'provider', 'provider_message_id', 'cost_usd',
      'sent_at', 'delivered_at', 'error',
    ],
  },
  // LANDED-COST C1 — editable catalogue of import-charge types. Admin /
  // finance can add new types over time (Demurrage, Customs Duty, etc.)
  // without a code change. Seeded with the 7 common types named in the
  // owner brief (2026-05-21).
  LandedCostTypes: {
    headers: ['type_id', 'type_name', 'active', 'created_at', 'created_by', 'notes'],
    seed: [
      ['LCT-001', 'Container Clearance', 'TRUE', '', 'system', 'Port + handling fees'],
      ['LCT-002', 'Clearing Agent',      'TRUE', '', 'system', 'Customs broker / agent commission'],
      ['LCT-003', 'Logistics',           'TRUE', '', 'system', 'Port → warehouse transport'],
      ['LCT-004', 'Demurrage',           'TRUE', '', 'system', 'Container storage past free days'],
      ['LCT-005', 'Insurance',           'TRUE', '', 'system', 'Marine + transit cover'],
      ['LCT-006', 'Customs Duty',        'TRUE', '', 'system', 'Government import duty'],
      ['LCT-007', 'Bank Transfer Fee',   'TRUE', '', 'system', 'Foreign-wire / TT cost'],
    ],
  },
  // LANDED-COST C1 — itemised charges per GRN. The "Finalize Landed
  // Cost" flow appends one row per charge entered by the admin. The
  // sum is then allocated PER YARD across the GRN's bales.
  ContainerCharges: {
    headers: [
      'charge_id', 'grn_id', 'type_id', 'type_name',
      'amount_usd', 'entered_by', 'entered_at', 'notes',
    ],
  },
  // BUNDLE-SALE C1 — lookup table for colour-name → display-emoji and the
  // supplier's COLOUR NO (printed on each bale tag). Admin can append rows
  // over time without a code change. Bot falls back to a generic chip
  // when a shade isn't in the table.
  Shades: {
    headers: ['shade_id', 'shade_name', 'display_emoji', 'supplier_colour_no', 'active', 'aliases', 'created_at', 'notes'],
    seed: [
      ['SHD-001', 'Red',    '🔴', '', 'TRUE', 'red,crimson,maroon',  '', ''],
      ['SHD-002', 'Green',  '🟢', '', 'TRUE', 'green,olive,emerald', '', ''],
      ['SHD-003', 'Blue',   '🔵', '', 'TRUE', 'blue,navy,royal',     '', ''],
      ['SHD-004', 'Yellow', '🟡', '', 'TRUE', 'yellow,gold',         '', ''],
      ['SHD-005', 'Purple', '🟣', '', 'TRUE', 'purple,wine,violet',  '', ''],
      ['SHD-006', 'Orange', '🟠', '', 'TRUE', 'orange,peach',        '', ''],
      ['SHD-007', 'White',  '⚪', '', 'TRUE', 'white,cream,off-white','', ''],
      ['SHD-008', 'Black',  '⚫', '', 'TRUE', 'black,jet,blk',       '', ''],
      ['SHD-009', 'Brown',  '🟤', '', 'TRUE', 'brown,coffee,khaki',  '', ''],
      ['SHD-010', 'Pink',   '🌸', '', 'TRUE', 'pink,rose,fuchsia',   '', ''],
    ],
  },
  // BR-OPS C1 — single umbrella sheet for the branch managers' daily
  // routine (Abdul / Muhammad). Polymorphic via `kind`: daily_open,
  // camera_check, opening_cash, expense, sample_issued, receipt_logged,
  // customer_registered, marketer_registered, day_close. Detailed
  // entities (samples, receipts, customers, marketers) stay in their
  // own sheets — this sheet only stores pointers (ref_id) so the
  // daily timeline view + weekly finance roll-up read ONE place.
  // Adding a new daily-routine item later = new kind value, no new sheet.
  BranchOpsLog: {
    headers: [
      'op_id', 'date', 'branch', 'manager_id', 'manager_name',
      'kind', 'subject', 'amount', 'ref_id', 'photo_url',
      'status', 'approval_request_id', 'notes',
      'created_at', 'updated_at',
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
      let deptHeader = await sheets.readRange('Departments', 'A1:Z1');
      let h = deptHeader[0] || [];
      if (!h.includes('parent_department')) {
        const nextCol = colLetter(h.length + 1);
        await sheets.updateRange('Departments', `${nextCol}1:${nextCol}1`, [['parent_department']]);
        logger.info('SchemaMapper: extended Departments with parent_department (TG-7.5)');
        deptHeader = await sheets.readRange('Departments', 'A1:Z1');
        h = deptHeader[0] || [];
      }
      // MG-1: marketing-group warehouses column (CSV of warehouse names).
      if (!h.includes('warehouses')) {
        const nextCol = colLetter(h.length + 1);
        await sheets.updateRange('Departments', `${nextCol}1:${nextCol}1`, [['warehouses']]);
        logger.info('SchemaMapper: extended Departments with warehouses (MG-1)');
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
      // BUNDLE-SALE C1 — added optional `bin_location` so the bundle picker
      // can show "Bale 6035 · shelf K-3" alongside the than chips. Empty
      // for warehouses that don't track shelves; cheap to add.
      const INV_NEW_COLS = ['bale_uid', 'addedAt', 'grn_id', 'bin_location'];
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

  // P2.5 — extend existing GoodsReceipts sheets with source + file_hash so
  // deployments created before Bulk Receive land can read/write bulk-import
  // rows without losing data. New deployments get them via REQUIRED_SHEETS.
  if (existing.includes('GoodsReceipts')) {
    try {
      const grnHeader = await sheets.readRange('GoodsReceipts', 'A1:Z1');
      const h = grnHeader[0] || [];
      // P2.5 added source + file_hash; FILE-C1 added source_url +
      // source_filename; LANDED-COST C1 added 8 landed-cost finalisation
      // columns. All three migrations run idempotently here — the
      // filter only appends columns the deployed sheet is missing.
      const GRN_NEW_COLS = [
        'source', 'file_hash', 'source_url', 'source_filename',
        'lc_status', 'lc_usd_per_yard', 'lc_charges_usd', 'lc_fx_rate',
        'lc_ngn_per_yard', 'lc_finalized_at', 'lc_finalized_by', 'lc_request_id',
      ];
      const missingGrn = GRN_NEW_COLS.filter((c) => !h.includes(c));
      if (missingGrn.length) {
        const startCol = colLetter(h.length + 1);
        const endCol = colLetter(h.length + missingGrn.length);
        await sheets.updateRange('GoodsReceipts', `${startCol}1:${endCol}1`, [missingGrn]);
        logger.info(`SchemaMapper: extended GoodsReceipts with ${missingGrn.length} column(s) (${missingGrn.join(', ')})`);
      }
    } catch (e) {
      logger.warn('SchemaMapper: could not extend GoodsReceipts —', e.message);
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
