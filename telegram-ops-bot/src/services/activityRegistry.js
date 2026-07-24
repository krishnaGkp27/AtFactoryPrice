/**
 * Activity registry: maps activity codes to display metadata.
 * Used by the role-based greeting menu to build tappable options.
 *
 * Each activity entry: { code, label, icon, callback, hub }
 *   hub: id of the menu hub the activity lives under, or null for a
 *        top-level standalone tile, or '_hidden' to keep it resolvable
 *        (text intents) without surfacing it in any menu grid.
 *
 * Each hub entry: { id, label, icon, parent? }
 *   Hubs are virtual groupings; they do not have their own callback — the
 *   greeting menu emits callback_data `act:__hub__:<hubId>` when a hub is
 *   tapped, which expands to that hub's contents. A hub may declare a
 *   `parent` hub id, making it a SUB-HUB rendered one level below its
 *   parent module (nesting is capped at two levels: module → sub-hub →
 *   activity).
 *
 * Top-level hubs follow an ERP-style module layout (Sales & Marketing,
 * Inventory, CRM, Finance, HR, Reporting, Tasks & Planning, Daily). There
 * is intentionally no catch-all "Admin" hub — admin-only actions live in
 * the business module they belong to and are gated by visibility (admin /
 * department CSV / per-user injection) in the controller, not by location.
 */

const HUBS = [
  // ── Top-level ERP-style modules ──────────────────────────────────────
  { id: 'sales',      label: 'Sales & Marketing', icon: '🛒' },
  { id: 'inventory',  label: 'Inventory',         icon: '📦' },
  { id: 'crm',        label: 'CRM',               icon: '👥' },
  { id: 'finance',    label: 'Finance',           icon: '💰' },
  { id: 'hr',         label: 'Human Resources',   icon: '🗓' },
  { id: 'reporting',  label: 'Reporting',         icon: '📊' },
  { id: 'planning',   label: 'Tasks & Planning',  icon: '📋' },
  { id: 'daily',      label: 'Daily',             icon: '🌅' },

  // ── Sub-hubs (one level below a parent module) ───────────────────────
  // Sales & Marketing splits into its three concerns so no single screen
  // is overcrowded.
  { id: 'orders',     label: 'Orders',     icon: '📝', parent: 'sales' },
  { id: 'marketers',  label: 'Marketers',  icon: '🧑‍💼', parent: 'sales' },
  { id: 'designs',    label: 'Designs',    icon: '🎨', parent: 'sales' },
  // Inventory keeps stock lookups shallow; the rarer write ops + warehouse
  // admin sit one tap deeper.
  { id: 'stock_add',  label: 'Add Stock',  icon: '📥', parent: 'inventory' },
  { id: 'stock_move', label: 'Move Stock', icon: '🔁', parent: 'inventory' },
  { id: 'warehouses', label: 'Warehouses', icon: '🏭', parent: 'inventory' },
];

const ACTIVITIES = [
  // ── Sales & Marketing › Orders ───────────────────────────────────────
  { code: 'supply_request',        label: 'Supply Request (detailed)', icon: '🏭', callback: 'act:supply_request',     hub: 'orders' },
  { code: 'create_order',          label: 'Quick Order Entry',         icon: '📝', callback: 'act:create_order',       hub: 'orders' },
  { code: 'my_orders',             label: 'My Orders',                 icon: '📋', callback: 'act:my_orders',          hub: 'orders' },
  { code: 'mark_order_delivered',  label: 'Mark Order Delivered',      icon: '✅', callback: 'act:mark_delivered',     hub: 'orders' },
  // BUNDLE-SALE C1 — design-first, colour-aggregate, bale-by-bale than
  // picker. Reuses the existing `sale_bundle` action so the approval
  // pipeline, ledger emission, and audit log keep working unchanged.
  { code: 'bundle_sale',           label: 'Sell Bundles / Than',       icon: '🧵', callback: 'act:bundle_sale',        hub: 'orders' },
  // ST-1 — fully tappable bale sale: container → warehouse → design →
  // bale cart → customer/salesperson/bank/date chips. Typed sale commands
  // redirect here (owner mandate 14-Jul).
  { code: 'sell_bale',             label: 'Sell Bale',                 icon: '💰', callback: 'act:sell_bale',          hub: 'orders' },
  // SNAP-1 — photo-to-sale: photograph the bale label, OCR matches the
  // bale, tap the customer. Same approval + enrichment as any sale.
  // Standalone (hub: null, owner 18-Jul): sits DIRECTLY on the greeting
  // menu for every user whose department grants the code — field sellers
  // like Yarima reach it in one tap, no hub drill-down.
  { code: 'snap_sale',             label: 'Snap Sale',                 icon: '📸', callback: 'act:snap_sale',          hub: null },

  // ── Sales & Marketing › Marketers (catalog consignment) ──────────────
  { code: 'register_marketer',     label: 'Register Marketer',         icon: '🧑‍💼', callback: 'act:register_marketer',    hub: 'marketers' },
  { code: 'supply_catalog',        label: 'Supply Catalog',            icon: '📦', callback: 'act:supply_catalog',       hub: 'marketers' },
  { code: 'loan_catalog',          label: 'Loan to Marketer',          icon: '📋', callback: 'act:loan_catalog',         hub: 'marketers' },
  { code: 'return_catalog',        label: 'Return Catalog',            icon: '↩️', callback: 'act:return_catalog',       hub: 'marketers' },
  { code: 'catalog_tracker',       label: 'Catalog Tracker',           icon: '📊', callback: 'act:catalog_tracker',      hub: 'marketers' },
  { code: 'manage_catalog_stock',  label: 'Manage Catalog Stock',      icon: '🗂️', callback: 'act:manage_catalog_stock', hub: 'marketers' },
  // MKT-2 — admin controls each marketer's My Products (designs + bale
  // quantities). Admin-only entry gate in the controller; direct write.
  { code: 'allocate_marketer',     label: 'Allocate to Marketer',      icon: '🧑‍💼', callback: 'act:allocate_marketer',    hub: 'marketers' },

  // ── Sales & Marketing › Designs (photo catalog) ──────────────────────
  { code: 'upload_design_photo',   label: 'Upload Product Photo',      icon: '📷', callback: 'act:upload_design_photo',  hub: 'designs' },
  { code: 'manage_design_photos',  label: 'Manage Product Photos',     icon: '🖼️', callback: 'act:manage_design_photos', hub: 'designs' },
  { code: 'browse_catalog',        label: 'Browse Catalog',            icon: '📖', callback: 'act:browse_catalog',       hub: 'designs' },
  { code: 'search_design_photo',   label: 'Search Design Photo',       icon: '🔎', callback: 'act:search_design_photo',  hub: 'designs' },
  { code: 'catalog_stats',         label: 'Catalog Stats',             icon: '📊', callback: 'act:catalog_stats',        hub: 'designs' },
  // DCAT-1 — design → product-category mapping (Cashmere / Chinos / …).
  // Admin-only entry (controller gate); dual-admin approval at submit
  // (set_design_category ∈ ALWAYS_APPROVAL_ACTIONS).
  { code: 'set_design_category',   label: 'Set Design Category',       icon: '🏷️', callback: 'act:set_design_category',  hub: 'designs' },

  // ── Inventory (stock lookups — shallow, high-frequency) ──────────────
  { code: 'check_stock',           label: 'Check Stock',               icon: '📦', callback: 'act:check_stock',        hub: 'inventory' },
  // MKT-1 — warehouse-scoped read-only catalog for marketer/salesman roles.
  // Standalone (hub: null); surfaced only to field roles by the greeting menu.
  { code: 'my_products',           label: 'My Products',               icon: '📦', callback: 'act:my_products',        hub: null },
  { code: 'list_packages',         label: 'List Packages',             icon: '📋', callback: 'act:list_packages',      hub: 'inventory' },
  { code: 'inventory_details',     label: 'Inventory Details',         icon: '🏭', callback: 'act:inventory_details',  hub: 'inventory' },
  // PRICE-VIS — admin-only stock value (selling × yards); Phase 2 widens via permissions.
  { code: 'stock_value',           label: 'Stock Value',               icon: '💰', callback: 'act:stock_value',        hub: 'inventory' },

  // ── Inventory › Add Stock (inbound) ──────────────────────────────────
  // P2 — Goods Receipt Note. Admin executes directly; employee routes
  // through approval (see WRITE_ACTIONS in risk/evaluate.js).
  { code: 'receive_goods',         label: 'Receive Goods',             icon: '📥', callback: 'act:receive_goods',      hub: 'stock_add' },
  // P2.5 / TCSI-2 — Bulk Receive (CSV/XLSX). ALWAYS dual-admin gated.
  // Tile renamed to umbrella 'Add Stock (CSV)'; the callback opens a
  // Strict/Lenient sub-menu in the controller. Code/callback preserved so
  // department permissions, approval queue, and audit history keep
  // referencing the same identifier.
  { code: 'bulk_receive_goods',    label: 'Add Stock (CSV)',           icon: '📦', callback: 'act:bulk_receive_goods', hub: 'stock_add' },
  // P5 — Photo Receive (image/PDF + OCR). Submits through the same
  // bulk_receive_goods approval gate; OCR is purely capture.
  { code: 'photo_receive_goods',   label: 'Photo Receive (image/PDF)', icon: '📷', callback: 'act:photo_receive_goods', hub: 'stock_add' },

  // ── Inventory › Move Stock (transfers / returns) ─────────────────────
  // TRF-2 — staged warehouse transfer (dispatcher → receiver chain) + the
  // read-only open-transfers list.
  { code: 'transfer_stock',        label: 'Transfer Stock',            icon: '🚚', callback: 'act:transfer_stock',     hub: 'stock_move' },
  { code: 'transfers_view',        label: 'Transfers',                 icon: '📋', callback: 'act:transfers_view',     hub: 'stock_move' },
  // TRF-5 — legacy INSTANT transfers retired (owner sign-off Jul 2026):
  // no dispatcher/receiver chain, no in-transit stage, no load photos.
  // hub '_hidden' keeps old menu buttons / department CSVs resolvable; the
  // controller now redirects both codes to Transfer Stock.
  { code: 'transfer_package',      label: 'Transfer Package',          icon: '🚚', callback: 'act:transfer_package',   hub: '_hidden' },
  { code: 'transfer_than',         label: 'Transfer Than',             icon: '↔️', callback: 'act:transfer_than',      hub: '_hidden' },
  { code: 'return_than',           label: 'Return Than',               icon: '↩️', callback: 'act:return_than',        hub: 'stock_move' },

  // ── Inventory › Warehouses (admin org assets) ────────────────────────
  // WH-C1 — add_warehouse (dual-admin gated, ALWAYS_APPROVAL_ACTIONS).
  // Placed just before Manage Warehouses so the two related entries sit
  // side by side.
  { code: 'add_warehouse',         label: 'Add Warehouse',             icon: '🏭', callback: 'act:add_warehouse',     hub: 'warehouses' },
  { code: 'manage_warehouses',     label: 'Manage Warehouses',         icon: '🏭', callback: 'act:manage_wh',          hub: 'warehouses' },
  // WAU-3 (owner 20-Jul) — blind-count stock audit, open to staff whose
  // department grants the code. hub:null = standalone greeting tile so the
  // warehouse boy reaches it in one tap (same pattern as snap_sale).
  { code: 'warehouse_audit',       label: 'Warehouse Audit',           icon: '🔍', callback: 'act:warehouse_audit',    hub: null },
  // TV-2 — bales ⇄ thans display-unit switch (admin/manager request,
  // admin approval via set_unit_display in ALWAYS_APPROVAL_ACTIONS).
  { code: 'display_units',         label: 'Display Units',             icon: '📐', callback: 'act:display_units',      hub: 'warehouses' },

  // ── CRM (customers + samples) ────────────────────────────────────────
  // Customer Details: single-tap card with [History / Pattern / Notes /
  // Add Note] tabs (and Ranking for admins). Replaced four separate hub
  // entries that each required a pick-customer round trip.
  { code: 'customer_details',      label: 'Customer Details',          icon: '👤', callback: 'act:customer_details',   hub: 'crm' },
  // CNET-1b — recursive contact network (category → buyers → their people).
  { code: 'contact_network',       label: 'Contact Network',           icon: '📇', callback: 'act:contact_network',    hub: 'crm' },
  // MORN-1 — daily 10:00 admin digest with category toggles. Standalone
  // (hub: null) so it sits directly on the greeting menu (owner, 17-Jul);
  // employees never see it — the tile is in no department CSV and the
  // flow's start() is admin-gated anyway.
  { code: 'morning_digest',        label: 'Morning Digest',            icon: '⏰', callback: 'act:morning_digest',     hub: null },
  { code: 'add_customer_note',     label: 'Add Note',                  icon: '✏️', callback: 'act:add_note',           hub: 'crm' },
  { code: 'add_customer',          label: 'Add Customer',              icon: '➕', callback: 'act:add_customer',       hub: 'crm' },
  { code: 'give_sample',           label: 'Give Sample',               icon: '🧪', callback: 'act:give_sample',        hub: 'crm' },
  { code: 'sample_status',         label: 'Sample Status',             icon: '📊', callback: 'act:sample_status',      hub: 'crm' },

  // Deprecated read-only customer activities: still resolvable so text
  // intents ("Customer history CJE") keep working, but hub '_hidden' keeps
  // them out of every menu grid. filterByCodes() auto-substitutes
  // `customer_details` when any of these appear in a department CSV.
  { code: 'customer_history',      label: 'Customer History',          icon: '📋', callback: 'act:customer_history',   hub: '_hidden' },
  { code: 'customer_pattern',      label: 'Customer Pattern',          icon: '🔍', callback: 'act:customer_pattern',   hub: '_hidden' },
  { code: 'show_customer_notes',   label: 'Customer Notes',            icon: '📝', callback: 'act:customer_notes',     hub: '_hidden' },
  { code: 'customer_ranking',      label: 'Customer Ranking',          icon: '🏆', callback: 'act:customer_ranking',   hub: '_hidden' },

  // ── Finance & Accounting ─────────────────────────────────────────────
  { code: 'update_price',          label: 'Update Price',              icon: '💲', callback: 'act:update_price',       hub: 'finance' },
  { code: 'add_bank',              label: 'Manage Banks',              icon: '🏦', callback: 'act:manage_banks',       hub: 'finance' },
  // Finance-only — Incentives queue with one-tap Mark Paid. Visibility
  // gated by config.access.financeIds, injected per-user (still in the
  // controller's TASK_CODES injection set).
  { code: 'payouts',               label: 'Payouts',                   icon: '💰', callback: 'act:payouts',            hub: 'finance' },
  // LANDED-COST C1 — admin finalises USD cost/yard + import charges for a
  // GRN. Dual-admin gated via `finalize_landed_cost`.
  { code: 'finalize_landed_cost',  label: 'Finalize Landed Cost',      icon: '💵', callback: 'act:finalize_landed_cost', hub: 'finance' },

  // ── Human Resources (people + attendance) ────────────────────────────
  // ATT-C1 — Mark Attendance (employee-facing). Injected at menu-render
  // time for users in Settings.ATTENDANCE_REQUIRED_USERS; never listed in
  // a department CSV. Housed in HR so that, once surfaced, it sits with the
  // other people/attendance actions — a user whose only HR activity is
  // this one still gets it promoted to a top-level tile.
  { code: 'mark_attendance',       label: 'Mark Attendance',           icon: '📍', callback: 'act:mark_attendance',   hub: 'hr' },
  // ATT-C2 — admin attendance management (required users, locations,
  // reminder/report times, working days, today view, mark-on-behalf).
  { code: 'attendance_admin',      label: 'Attendance',                icon: '🗓', callback: 'act:attendance_admin',  hub: 'hr' },
  // USR-C3 — in-bot add employee (dual-admin gated). Listed just above
  // Manage Users so the two related entries sit together.
  { code: 'add_user',              label: 'Add Employee',              icon: '➕', callback: 'act:add_user',          hub: 'hr' },
  { code: 'manage_users',          label: 'Manage Users',              icon: '👥', callback: 'act:manage_users',       hub: 'hr' },
  // USR-C3b — promote an existing user to admin (super-admin gated).
  { code: 'promote_admin',         label: 'Promote to Admin',          icon: '👑', callback: 'umg:start:promote',    hub: 'hr' },
  // USR-C4 — deactivate (status=inactive). Dual-admin gated.
  { code: 'deactivate_user',       label: 'Deactivate User',           icon: '🛑', callback: 'umg:start:deactivate', hub: 'hr' },
  { code: 'manage_departments',    label: 'Manage Departments',        icon: '🏢', callback: 'act:manage_depts',       hub: 'hr' },

  // ── Reporting ────────────────────────────────────────────────────────
  { code: 'sales_report',          label: 'Sales Report',              icon: '📊', callback: 'act:sales_report',       hub: 'reporting' },
  // RPT-2 — date-wise tappable browser of sales/supplies (admin-only,
  // gated in the flow's start()).
  { code: 'sales_browser',         label: 'Sales Browser',             icon: '📈', callback: 'act:sales_browser',      hub: 'reporting' },
  { code: 'supply_details',        label: 'Supply Details',            icon: '📦', callback: 'act:supply_details',     hub: 'reporting' },
  // SBL-1 — sold-bale drill-down: customer → date → bale/than detail.
  // Read-only; sale price/value gated by pricingService.canSeeSalePrice.
  { code: 'sold_bales_lookup',     label: 'Customer Supplies',         icon: '📒', callback: 'act:sold_bales_lookup',  hub: 'reporting' },
  // ATT-RPT-1 — read-only attendance report (today + window stats). Admin-only for now.
  // ANA-1a — magic-link web login (admins + managers; role-gated in the
  // act: case). Mints a single-use link into the ops dashboard.
  { code: 'web_dashboard',         label: 'Dashboard (web)',           icon: '📊', callback: 'act:web_dashboard',      hub: 'reporting' },
  { code: 'attendance_report',     label: 'Attendance Report',         icon: '🗓', callback: 'act:attendance_report',  hub: 'reporting' },
  // T3 — admin read-only lens on the supply-order pipeline (Orders +
  // Customers + LedgerBalanceCache joined into one view).
  { code: 'sales_workflow_view',   label: 'Sales Workflow',            icon: '📊', callback: 'act:sales_workflow',     hub: 'reporting' },
  // T2 — per-user opt-in/out toggles for the Admin Activity Feed. Injected
  // per-user by the controller (admin-only); not in any department CSV.
  { code: 'notifications_settings',label: 'Notifications',             icon: '⚙️', callback: 'act:notifications',      hub: 'reporting' },

  // ── Tasks & Planning ─────────────────────────────────────────────────
  // Task codes are injected per-user by the controller (admin / has-manages
  // → assign/team/signoff; everyone → My Tasks); never from a department
  // CSV. Do not list these in any department's allowed_activities.
  { code: 'assign_task',           label: 'Assign Task',               icon: '➕', callback: 'act:assign_task',        hub: 'planning' },
  { code: 'my_tasks',              label: 'My Tasks',                  icon: '📋', callback: 'act:my_tasks',           hub: 'planning' },
  { code: 'team_tasks',            label: 'Team Tasks',                icon: '👥', callback: 'act:team_tasks',         hub: 'planning' },
  { code: 'pending_signoff',       label: 'Pending Sign-off',          icon: '⏳', callback: 'act:pending_signoff',    hub: 'planning' },
  // P4 — admin Procurement Plan: low-stock alerts + open POs + new PO flow.
  // Admin-gated in the controller; not in any department CSV.
  { code: 'procurement_plan',      label: 'Procurement Plan',          icon: '📋', callback: 'act:procurement_plan',   hub: 'planning' },

  // ── Daily / Branch Ops ───────────────────────────────────────────────
  // BR-OPS C1 — branch managers' daily routine. Per-user visibility via the
  // Departments.allowed_activities CSV.
  // * daily_branch_ops opens the morning card (camera + opening cash) and
  //   collapses to the status panel for the rest of the day (idempotent).
  // * office_expense queues a batch of expenses for single-admin sign-off.
  // * upload_receipt captures a payment/expense receipt photo.
  // APR-2 — one screen rules every nudge (admin + per-department toggles,
  // changes approval-gated). Managers + admins; gating enforced in-flow.
  { code: 'reminder_controls',     label: 'Reminder Controls',         icon: '⏰', callback: 'act:reminder_controls',  hub: 'daily' },
  { code: 'daily_branch_ops',      label: 'Open Branch (Daily)',       icon: '🌅', callback: 'act:daily_branch_ops',   hub: 'daily' },
  { code: 'office_expense',        label: 'Office Expense',            icon: '💸', callback: 'act:office_expense',     hub: 'daily' },
  { code: 'upload_receipt',        label: 'Upload Receipt',            icon: '🧾', callback: 'act:upload_receipt',     hub: 'daily' },
];

const byCode = new Map(ACTIVITIES.map((a) => [a.code, a]));
const byCallback = new Map(ACTIVITIES.map((a) => [a.callback, a]));
const hubsById = new Map(HUBS.map((h) => [h.id, h]));

function getActivity(code) { return byCode.get(code) || null; }

/**
 * Look up an activity by its full callback_data (e.g. "act:mark_delivered").
 * Useful because some callbacks differ from the activity code.
 */
function getByCallback(callback) { return byCallback.get(callback) || null; }

function getAll() { return ACTIVITIES; }

// Codes that have been consolidated into the unified `customer_details`
// hub entry. Departments seeded before the consolidation may still list
// these in their allowed_activities CSV; filterByCodes() detects them and
// injects `customer_details` so the CRM hub keeps populating without
// requiring a Departments-sheet migration.
const DEPRECATED_CUSTOMER_READS = new Set([
  'customer_history',
  'customer_pattern',
  'show_customer_notes',
  'customer_ranking',
]);

function filterByCodes(codes) {
  if (!codes || !codes.length) return [];
  if (codes.includes('__all__')) return ACTIVITIES;
  const resolved = codes.map((c) => byCode.get(c)).filter(Boolean);
  const hasLegacyRead = codes.some((c) => DEPRECATED_CUSTOMER_READS.has(c));
  const hasNewEntry = codes.includes('customer_details');
  if (hasLegacyRead && !hasNewEntry) {
    const cd = byCode.get('customer_details');
    if (cd) resolved.push(cd);
  }
  return resolved;
}

function getHubs() { return HUBS; }

function getHub(id) { return hubsById.get(id) || null; }

/** Top-level modules only (hubs without a parent), in declaration order. */
function getTopHubs() { return HUBS.filter((h) => !h.parent); }

/** Direct child sub-hubs of a parent hub, in declaration order. */
function getChildHubs(parentId) { return HUBS.filter((h) => h.parent === parentId); }

/**
 * Resolve the TOP-LEVEL module id for any hub id. Walks at most one parent
 * hop, since nesting is capped at two levels (module → sub-hub → activity).
 * Returns null for unknown hub ids (e.g. '_hidden').
 */
function topHubIdOf(hubId) {
  const h = hubsById.get(hubId);
  if (!h) return null;
  return h.parent || h.id;
}

/**
 * Group a list of allowed activities by their TOP-LEVEL module for the
 * greeting menu. Activities living in a sub-hub roll up to the sub-hub's
 * parent, so the greeting only ever shows the top-level modules (or a
 * single promoted action). Returns:
 *   {
 *     hubs: [{ hub, activities: [...] }, ...],  // top-level hubs with ≥1 allowed descendant
 *     standalone: [...]                          // activities with hub === null
 *   }
 * Order of hubs follows the declaration order in HUBS. Activities with an
 * unknown/'_hidden' hub are not surfaced.
 */
function groupByHub(activities) {
  const map = new Map();
  const standalone = [];
  for (const a of activities) {
    if (!a.hub) { standalone.push(a); continue; }
    const top = topHubIdOf(a.hub);
    if (!top) continue; // unknown / '_hidden' — never surfaced
    if (!map.has(top)) map.set(top, []);
    map.get(top).push(a);
  }
  const hubs = [];
  for (const h of HUBS) {
    if (h.parent) continue; // only top-level modules surface at the greeting
    if (map.has(h.id)) hubs.push({ hub: h, activities: map.get(h.id) });
  }
  return { hubs, standalone };
}

module.exports = {
  getActivity,
  getByCallback,
  getAll,
  filterByCodes,
  getHubs,
  getHub,
  getTopHubs,
  getChildHubs,
  topHubIdOf,
  groupByHub,
};
