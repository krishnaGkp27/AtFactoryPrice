/**
 * Risk evaluation for inventory and financial actions.
 * Sale/supply and ledger-impacting actions ALWAYS require approval:
 *   Employee → Admin approval
 *   Admin → 2nd Admin approval
 * Other write actions: employees need admin approval, admins execute directly.
 */

const settingsRepository = require('../repositories/settingsRepository');
const config = require('../config');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');

const WRITE_ACTIONS = [
  'sell_than', 'sell_package', 'sell_batch', 'sell_mixed', 'sell',
  'return_than', 'return_package', 'revert_sale_bundle',
  'update_price',
  'add', 'add_stock',
  'record_payment',
  'add_customer',
  'add_contact',
  'transfer_than', 'transfer_package', 'transfer_batch',
  // Bank management — settings writes, admin only in controller
  'add_bank', 'remove_bank',
  // User management — admin only in controller
  'add_user',
  // P2 — Goods Receipt Note (admin executes directly; employee routes
  // through admin approval).
  'receive_goods',
  // P2.5 — Bulk Receive (CSV/XLSX upload). Always dual-admin gated; see
  // ALWAYS_APPROVAL_ACTIONS below.
  'bulk_receive_goods',
];

// Actions that ALWAYS go through the approval queue, regardless of whether
// the requester is an admin. Admin → 2nd-admin gate; employee → admin gate.
// Returns and full-bundle reverts belong here because they modify approved
// sales (inventory state + customer ledger) and a single admin should never
// be able to roll those back unilaterally.
//
// Warehouse mutations (add/rename) live here because the user explicitly
// asked for dual-admin sign-off on every structural change to warehouses
// (theft history made loose ad-hoc edits costly). The existing approval
// queue + admin-broadcast pipeline enforces approver != requester
// automatically (requireApproval excludes admin requesters from the
// notification list — see telegramController.js requireApproval).
const ALWAYS_APPROVAL_ACTIONS = [
  'sell_than', 'sell_package', 'sell_batch', 'sell_mixed', 'sell',
  'return_than', 'return_package', 'revert_sale_bundle',
  'record_payment', 'update_price', 'supply_request',
  // P2 — dual-admin gate for warehouse structural changes.
  'add_warehouse', 'rename_warehouse',
  // P2.5 — Bulk Receive uploads can land hundreds of rows in one stroke.
  // Always dual-admin to ensure a 2nd pair of eyes on the parsed summary
  // (file_hash + bale count + warehouse) before any Inventory write.
  'bulk_receive_goods',
  // USR-C3 — in-bot user onboarding. Adding someone to the active-users
  // roster grants them access to the bot (sheet-driven auth list), so
  // every add_user goes through dual-admin approval. USR-C3b reserves a
  // tighter SUPER_ADMIN gate for the special case of promoting to admin.
  'add_user',
];

async function getThresholds() {
  const settings = await settingsRepository.getAll();
  return {
    deductionLimit: Number(settings.RISK_THRESHOLD) || config.risk.defaultDeductionLimit,
    lowStockThreshold: Number(settings.LOW_STOCK_THRESHOLD) || config.risk.defaultLowStockThreshold,
  };
}

/**
 * Evaluate risk for any action.
 * Sale/supply/payment/price actions ALWAYS need approval (even admins → 2nd admin).
 * Other write actions: employee → admin approval; admin → safe.
 */
async function evaluate(params) {
  const { action, userId } = params;

  const isAdm = userId && auth.isAdmin(userId);
  logger.info(`Risk evaluate: action=${action}, userId=${userId}, isAdmin=${isAdm}`);

  if (ALWAYS_APPROVAL_ACTIONS.includes(action)) {
    const who = isAdm ? '2nd admin' : 'admin';
    return {
      risk: 'approval_required',
      reason: `All ${formatAction(action)} operations require ${who} approval.`,
    };
  }

  if (isAdm) {
    return { risk: 'safe' };
  }

  if (WRITE_ACTIONS.includes(action)) {
    return {
      risk: 'approval_required',
      reason: `All ${formatAction(action)} operations require admin approval.`,
    };
  }

  return { risk: 'safe' };
}

function formatAction(action) {
  const map = {
    sell_than: 'sale', sell_package: 'sale', sell_batch: 'sale', sell_mixed: 'sale', sell: 'sale',
    return_than: 'return', return_package: 'return', revert_sale_bundle: 'sale revert',
    update_price: 'price update', add: 'stock addition', add_stock: 'stock addition',
    record_payment: 'payment', add_customer: 'customer creation', add_contact: 'contact creation',
    transfer_than: 'transfer', transfer_package: 'transfer', transfer_batch: 'transfer',
    receive_goods: 'goods receipt', add_warehouse: 'warehouse creation', rename_warehouse: 'warehouse rename',
    bulk_receive_goods: 'bulk goods receipt',
  };
  return map[action] || action.replace(/_/g, ' ');
}

module.exports = { evaluate, getThresholds, WRITE_ACTIONS, ALWAYS_APPROVAL_ACTIONS };
