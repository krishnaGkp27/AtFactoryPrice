/**
 * Activity registry: maps activity codes to display metadata.
 * Used by the role-based greeting menu to build tappable options.
 *
 * Each activity entry: { code, label, icon, callback, hub }
 *   hub: id of the menu hub the activity lives under, or null for top-level.
 *
 * Each hub entry: { id, label, icon }
 *   Hubs are virtual groupings; they do not have their own callback — the
 *   greeting menu emits callback_data `act:__hub__:<hubId>` when a hub is
 *   tapped, which expands to the sub-activities belonging to that hub.
 */

const HUBS = [
  { id: 'new_order',  label: 'New Order / Supply',   icon: '📦' },
  { id: 'orders',     label: 'Orders',               icon: '📋' },
  { id: 'stock',      label: 'Stock',                icon: '📦' },
  { id: 'customers',  label: 'Customers',            icon: '👤' },
  { id: 'samples',    label: 'Samples',              icon: '🧪' },
  { id: 'catalog',    label: 'Catalog',              icon: '📷' },
  { id: 'reports',    label: 'Reports',              icon: '📊' },
  { id: 'tasks',      label: 'Tasks',                icon: '📌' },
  { id: 'admin',      label: 'Admin Settings',       icon: '⚙️' },
];

const ACTIVITIES = [
  { code: 'supply_request',        label: 'Supply Request (detailed)', icon: '🏭', callback: 'act:supply_request',     hub: 'new_order' },
  { code: 'create_order',          label: 'Quick Order Entry',         icon: '📝', callback: 'act:create_order',       hub: 'new_order' },

  { code: 'my_orders',             label: 'My Orders',                 icon: '📋', callback: 'act:my_orders',          hub: 'orders' },
  { code: 'mark_order_delivered',  label: 'Mark Order Delivered',      icon: '✅', callback: 'act:mark_delivered',     hub: 'orders' },

  { code: 'check_stock',           label: 'Check Stock',               icon: '📦', callback: 'act:check_stock',        hub: 'stock' },
  { code: 'list_packages',         label: 'List Packages',             icon: '📋', callback: 'act:list_packages',      hub: 'stock' },
  { code: 'inventory_details',     label: 'Inventory Details',         icon: '🏭', callback: 'act:inventory_details',  hub: 'stock' },
  // P2 — Goods Receipt Note. Admin executes directly; employee routes
  // through approval (see WRITE_ACTIONS in risk/evaluate.js).
  { code: 'receive_goods',         label: 'Receive Goods',             icon: '📥', callback: 'act:receive_goods',      hub: 'stock' },
  // P2.5 — Bulk Receive (CSV/XLSX upload). ALWAYS dual-admin gated
  // regardless of who submits (see ALWAYS_APPROVAL_ACTIONS).
  { code: 'bulk_receive_goods',    label: 'Bulk Receive (CSV/XLSX)',   icon: '📤', callback: 'act:bulk_receive_goods', hub: 'stock' },
  // P5 — Photo Receive (image/PDF + OCR). Submits through the same
  // bulk_receive_goods approval gate; the OCR layer is purely capture.
  { code: 'photo_receive_goods',   label: 'Photo Receive (image/PDF)', icon: '📷', callback: 'act:photo_receive_goods', hub: 'stock' },
  { code: 'transfer_package',      label: 'Transfer Package',          icon: '🚚', callback: 'act:transfer_package',   hub: 'stock' },
  { code: 'transfer_than',         label: 'Transfer Than',             icon: '↔️', callback: 'act:transfer_than',      hub: 'stock' },
  { code: 'return_than',           label: 'Return Than',               icon: '↩️', callback: 'act:return_than',        hub: 'stock' },

  // Customer Details: single-tap entry that opens a customer card with
  // [History / Pattern / Notes / Add Note] tabs (and Ranking for admins).
  // Replaces four separate hub entries that each required a separate
  // pick-customer round trip.
  { code: 'customer_details',      label: 'Customer Details',          icon: '👤', callback: 'act:customer_details',   hub: 'customers' },
  { code: 'add_customer_note',     label: 'Add Note',                  icon: '✏️', callback: 'act:add_note',           hub: 'customers' },
  { code: 'add_customer',          label: 'Add Customer',              icon: '➕', callback: 'act:add_customer',       hub: 'customers' },

  // Deprecated read-only customer activities: still resolvable so text
  // intents ("Customer history CJE") keep working, but their hub is set
  // to '_hidden' so they no longer appear in the Customers hub grid.
  // filterByCodes() auto-substitutes `customer_details` when any of these
  // are present in a department's allowed_activities CSV.
  { code: 'customer_history',      label: 'Customer History',          icon: '📋', callback: 'act:customer_history',   hub: '_hidden' },
  { code: 'customer_pattern',      label: 'Customer Pattern',          icon: '🔍', callback: 'act:customer_pattern',   hub: '_hidden' },
  { code: 'show_customer_notes',   label: 'Customer Notes',            icon: '📝', callback: 'act:customer_notes',     hub: '_hidden' },
  { code: 'customer_ranking',      label: 'Customer Ranking',          icon: '🏆', callback: 'act:customer_ranking',   hub: '_hidden' },

  { code: 'give_sample',           label: 'Give Sample',               icon: '🧪', callback: 'act:give_sample',        hub: 'samples' },
  { code: 'sample_status',         label: 'Sample Status',             icon: '📊', callback: 'act:sample_status',      hub: 'samples' },

  { code: 'upload_design_photo',   label: 'Upload Product Photo',      icon: '📷', callback: 'act:upload_design_photo', hub: 'catalog' },
  { code: 'manage_design_photos',  label: 'Manage Product Photos',     icon: '🖼️', callback: 'act:manage_design_photos', hub: 'catalog' },
  { code: 'browse_catalog',        label: 'Browse Catalog',            icon: '📖', callback: 'act:browse_catalog',       hub: 'catalog' },
  { code: 'search_design_photo',   label: 'Search Design Photo',       icon: '🔎', callback: 'act:search_design_photo',  hub: 'catalog' },
  { code: 'catalog_stats',         label: 'Catalog Stats',             icon: '📊', callback: 'act:catalog_stats',        hub: 'catalog' },
  { code: 'supply_catalog',        label: 'Supply Catalog',            icon: '📦', callback: 'act:supply_catalog',       hub: 'catalog' },
  { code: 'loan_catalog',          label: 'Loan to Marketer',          icon: '📋', callback: 'act:loan_catalog',         hub: 'catalog' },
  { code: 'return_catalog',        label: 'Return Catalog',            icon: '↩️', callback: 'act:return_catalog',       hub: 'catalog' },
  { code: 'register_marketer',     label: 'Register Marketer',         icon: '🧑‍💼', callback: 'act:register_marketer',    hub: 'catalog' },
  { code: 'catalog_tracker',       label: 'Catalog Tracker',           icon: '📊', callback: 'act:catalog_tracker',      hub: 'catalog' },
  { code: 'manage_catalog_stock', label: 'Manage Catalog Stock',      icon: '🗂️', callback: 'act:manage_catalog_stock', hub: 'catalog' },

  { code: 'sales_report',          label: 'Sales Report',              icon: '📊', callback: 'act:sales_report',       hub: 'reports' },
  { code: 'supply_details',        label: 'Supply Details',            icon: '📦', callback: 'act:supply_details',     hub: 'reports' },

  // Tasks hub — visibility is *injected* per-user by the controller
  // (admin / has-manages → sees assign/team/signoff; everyone else
  // sees only My Tasks). Do not list these codes in any department's
  // allowed_activities — controller decides visibility from
  // user.manages / isAdmin, not from the Departments sheet.
  { code: 'assign_task',           label: 'Assign Task',               icon: '➕', callback: 'act:assign_task',        hub: 'tasks' },
  { code: 'my_tasks',              label: 'My Tasks',                  icon: '📋', callback: 'act:my_tasks',           hub: 'tasks' },
  { code: 'team_tasks',            label: 'Team Tasks',                icon: '👥', callback: 'act:team_tasks',         hub: 'tasks' },
  { code: 'pending_signoff',       label: 'Pending Sign-off',          icon: '⏳', callback: 'act:pending_signoff',    hub: 'tasks' },
  // Finance-only — sees the Incentives queue with one-tap Mark Paid.
  // Visibility gated by config.access.financeIds, injected per-user.
  { code: 'payouts',               label: 'Payouts',                   icon: '💰', callback: 'act:payouts',            hub: 'tasks' },

  { code: 'update_price',          label: 'Update Price',              icon: '💲', callback: 'act:update_price',       hub: 'admin' },
  // USR-C3 — in-bot add employee (dual-admin gated, ALWAYS_APPROVAL_ACTIONS).
  // Listed above Manage Users so the two related entries sit together.
  { code: 'add_user',              label: 'Add Employee',              icon: '➕', callback: 'act:add_user',          hub: 'admin' },
  // USR-C3b — promote an existing user to admin. Approval is super-admin
  // gated (SUPER_ADMIN_APPROVAL_ACTIONS in risk/evaluate).
  { code: 'promote_admin',         label: 'Promote to Admin',          icon: '👑', callback: 'umg:start:promote',    hub: 'admin' },
  // USR-C4 — deactivate (status=inactive). Dual-admin gated.
  { code: 'deactivate_user',       label: 'Deactivate User',           icon: '🛑', callback: 'umg:start:deactivate', hub: 'admin' },
  { code: 'manage_users',          label: 'Manage Users',              icon: '👥', callback: 'act:manage_users',       hub: 'admin' },
  { code: 'manage_departments',    label: 'Manage Departments',        icon: '🏢', callback: 'act:manage_depts',       hub: 'admin' },
  // WH-C1: standalone add-warehouse activity. Same `add_warehouse`
  // action under the hood (dual-admin gated, ALWAYS_APPROVAL_ACTIONS).
  // Placed just before Manage Warehouses so the two related entries
  // sit side-by-side in the admin hub.
  { code: 'add_warehouse',         label: 'Add Warehouse',             icon: '🏭', callback: 'act:add_warehouse',     hub: 'admin' },
  { code: 'manage_warehouses',     label: 'Manage Warehouses',         icon: '🏭', callback: 'act:manage_wh',          hub: 'admin' },
  { code: 'add_bank',              label: 'Manage Banks',              icon: '🏦', callback: 'act:manage_banks',       hub: 'admin' },
  // T2 — per-user opt-in/out toggles for the Admin Activity Feed.
  // Injected per-user by the controller (admin-only); not listed in any
  // department's allowed_activities CSV.
  { code: 'notifications_settings',label: 'Notifications',             icon: '⚙️', callback: 'act:notifications',      hub: 'admin' },
  // T3 — admin read-only lens on the supply-order pipeline (Orders +
  // Customers + LedgerBalanceCache joined into one view).
  { code: 'sales_workflow_view',   label: 'Sales Workflow',            icon: '📊', callback: 'act:sales_workflow',     hub: 'admin' },
  // P4 — admin Procurement Plan: low-stock alerts + open POs + new PO flow.
  // Visibility gated to admins in the controller; not listed in any
  // department's allowed_activities CSV.
  { code: 'procurement_plan',      label: 'Procurement Plan',          icon: '📋', callback: 'act:procurement_plan',   hub: 'admin' },

  { code: 'upload_receipt',        label: 'Upload Receipt',            icon: '🧾', callback: 'act:upload_receipt',     hub: null },
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
// injects `customer_details` so the customers hub keeps populating without
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

/**
 * Group a list of allowed activities by hub.
 * Returns:
 *   {
 *     hubs: [{ hub, activities: [...] }, ...],   // only hubs that have ≥1 allowed activity
 *     standalone: [...]                          // activities with hub === null
 *   }
 * Order of hubs follows the declaration order in HUBS.
 */
function groupByHub(activities) {
  const map = new Map();
  const standalone = [];
  for (const a of activities) {
    if (!a.hub) { standalone.push(a); continue; }
    if (!map.has(a.hub)) map.set(a.hub, []);
    map.get(a.hub).push(a);
  }
  const hubs = [];
  for (const h of HUBS) {
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
  groupByHub,
};
