/**
 * Risk evaluation for inventory and financial actions.
 * ALL write operations by non-admin users require admin approval.
 * Admin users execute directly.
 */

const settingsRepository = require('../repositories/settingsRepository');
const config = require('../config');
const auth = require('../middlewares/auth');

const WRITE_ACTIONS = [
  'sell_than', 'sell_package', 'sell_batch', 'sell',
  'return_than', 'return_package',
  'update_price',
  'add', 'add_stock',
  'record_payment',
  'add_customer',
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
 * Non-admin users always need approval for write operations.
 * Admin users always get 'safe'.
 */
async function evaluate(params) {
  const { action, userId } = params;

  if (userId && auth.isAdmin(userId)) {
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
    sell_than: 'sale', sell_package: 'sale', sell_batch: 'sale', sell: 'sale',
    return_than: 'return', return_package: 'return',
    update_price: 'price update', add: 'stock addition', add_stock: 'stock addition',
    record_payment: 'payment', add_customer: 'customer creation',
  };
  return map[action] || action;
}

module.exports = { evaluate, getThresholds, WRITE_ACTIONS };
