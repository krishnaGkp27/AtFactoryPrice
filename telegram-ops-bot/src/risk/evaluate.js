/**
 * Risk evaluation for Package/Than inventory actions.
 * Returns { risk: 'safe' | 'approval_required', reason?: string }
 */

const settingsRepository = require('../repositories/settingsRepository');
const config = require('../config');

async function getThresholds() {
  const settings = await settingsRepository.getAll();
  return {
    deductionLimit: Number(settings.RISK_THRESHOLD) || config.risk.defaultDeductionLimit,
    lowStockThreshold: Number(settings.LOW_STOCK_THRESHOLD) || config.risk.defaultLowStockThreshold,
  };
}

/**
 * Evaluate risk for sell_than or sell_package.
 * @param {Object} params - { action, qty (yards), totalValue, packageNo, thanNo, isPriceChange, isEdit }
 */
async function evaluate(params) {
  const { action, qty = 0, totalValue = 0, isPriceChange, isEdit } = params;
  const thresholds = await getThresholds();

  if (action === 'sell_than' || action === 'sell_package' || action === 'sell') {
    const yards = Math.abs(Number(qty));
    if (yards > thresholds.deductionLimit) {
      return {
        risk: 'approval_required',
        reason: `Sale of ${yards} yards exceeds the ${thresholds.deductionLimit}-yard limit.`,
      };
    }
  }

  if (isPriceChange) {
    return { risk: 'approval_required', reason: 'Price change requires admin approval.' };
  }

  if (isEdit) {
    return { risk: 'approval_required', reason: 'Editing past transactions requires admin approval.' };
  }

  return { risk: 'safe' };
}

module.exports = { evaluate, getThresholds };
