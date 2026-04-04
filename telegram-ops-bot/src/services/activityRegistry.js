/**
 * Activity registry: maps activity codes to display metadata.
 * Used by the role-based greeting menu to build tappable options.
 * Each entry: { code, label, icon, callback }
 *   callback: the callback_data prefix sent when the activity button is tapped.
 */

const ACTIVITIES = [
  { code: 'supply_request', label: 'Supply Request', icon: '📦', callback: 'act:supply_request' },
  { code: 'upload_receipt', label: 'Upload Receipt', icon: '🧾', callback: 'act:upload_receipt' },
  { code: 'my_orders', label: 'My Orders', icon: '📋', callback: 'act:my_orders' },
  { code: 'mark_order_delivered', label: 'Mark Order Delivered', icon: '✅', callback: 'act:mark_delivered' },
  { code: 'give_sample', label: 'Give Sample', icon: '🧪', callback: 'act:give_sample' },
  { code: 'supply_details', label: 'Supply Details', icon: '📊', callback: 'act:supply_details' },
  { code: 'customer_history', label: 'Customer History', icon: '📋', callback: 'act:customer_history' },
  { code: 'customer_pattern', label: 'Customer Pattern', icon: '🔍', callback: 'act:customer_pattern' },
  { code: 'show_customer_notes', label: 'Customer Notes', icon: '📝', callback: 'act:customer_notes' },
  { code: 'check_stock', label: 'Check Stock', icon: '📦', callback: 'act:check_stock' },
  { code: 'list_packages', label: 'List Packages', icon: '📋', callback: 'act:list_packages' },
  { code: 'inventory_details', label: 'Inventory Details', icon: '🏭', callback: 'act:inventory_details' },
  { code: 'sales_report', label: 'Sales Report', icon: '📊', callback: 'act:sales_report' },
  { code: 'customer_ranking', label: 'Customer Ranking', icon: '🏆', callback: 'act:customer_ranking' },
  { code: 'create_order', label: 'Create Order', icon: '📦', callback: 'act:create_order' },
  { code: 'sample_status', label: 'Sample Status', icon: '🧪', callback: 'act:sample_status' },
  { code: 'manage_users', label: 'Manage Users', icon: '👥', callback: 'act:manage_users' },
  { code: 'manage_departments', label: 'Manage Departments', icon: '🏢', callback: 'act:manage_depts' },
  { code: 'manage_warehouses', label: 'Manage Warehouses', icon: '🏭', callback: 'act:manage_wh' },
  { code: 'add_bank', label: 'Manage Banks', icon: '🏦', callback: 'act:manage_banks' },
  { code: 'add_customer', label: 'Add Customer', icon: '👤', callback: 'act:add_customer' },
];

const byCode = new Map(ACTIVITIES.map((a) => [a.code, a]));

function getActivity(code) { return byCode.get(code) || null; }

function getAll() { return ACTIVITIES; }

function filterByCodes(codes) {
  if (!codes || !codes.length) return [];
  if (codes.includes('__all__')) return ACTIVITIES;
  return codes.map((c) => byCode.get(c)).filter(Boolean);
}

module.exports = { getActivity, getAll, filterByCodes };
