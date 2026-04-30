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
  { code: 'transfer_package',      label: 'Transfer Package',          icon: '🚚', callback: 'act:transfer_package',   hub: 'stock' },
  { code: 'transfer_than',         label: 'Transfer Than',             icon: '↔️', callback: 'act:transfer_than',      hub: 'stock' },
  { code: 'return_than',           label: 'Return Than',               icon: '↩️', callback: 'act:return_than',        hub: 'stock' },

  { code: 'customer_history',      label: 'Customer History',          icon: '📋', callback: 'act:customer_history',   hub: 'customers' },
  { code: 'customer_pattern',      label: 'Customer Pattern',          icon: '🔍', callback: 'act:customer_pattern',   hub: 'customers' },
  { code: 'show_customer_notes',   label: 'Customer Notes',            icon: '📝', callback: 'act:customer_notes',     hub: 'customers' },
  { code: 'add_customer_note',     label: 'Add Note',                  icon: '✏️', callback: 'act:add_note',           hub: 'customers' },
  { code: 'customer_ranking',      label: 'Customer Ranking',          icon: '🏆', callback: 'act:customer_ranking',   hub: 'customers' },
  { code: 'add_customer',          label: 'Add Customer',              icon: '➕', callback: 'act:add_customer',       hub: 'customers' },

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

  { code: 'update_price',          label: 'Update Price',              icon: '💲', callback: 'act:update_price',       hub: 'admin' },
  { code: 'manage_users',          label: 'Manage Users',              icon: '👥', callback: 'act:manage_users',       hub: 'admin' },
  { code: 'manage_departments',    label: 'Manage Departments',        icon: '🏢', callback: 'act:manage_depts',       hub: 'admin' },
  { code: 'manage_warehouses',     label: 'Manage Warehouses',         icon: '🏭', callback: 'act:manage_wh',          hub: 'admin' },
  { code: 'add_bank',              label: 'Manage Banks',              icon: '🏦', callback: 'act:manage_banks',       hub: 'admin' },

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

function filterByCodes(codes) {
  if (!codes || !codes.length) return [];
  if (codes.includes('__all__')) return ACTIVITIES;
  return codes.map((c) => byCode.get(c)).filter(Boolean);
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
