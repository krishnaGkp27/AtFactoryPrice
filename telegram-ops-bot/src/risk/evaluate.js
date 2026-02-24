/**
 * Risk evaluation for inventory actions.
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
 * Evaluate risk for a proposed action.
 * @param {Object} params - { action, qty, design, color, warehouse, beforeQty, isPriceChange, isEdit }
 */
async function evaluate(params) {
  const { action, qty = 0, beforeQty, isPriceChange, isEdit } = params;
  const thresholds = await getThresholds();

  if (action === 'sell' || action === 'deduct') {
    const deductQty = Math.abs(Number(qty));
    if (deductQty > thresholds.deductionLimit) {
      return {
        risk: 'approval_required',
        reason: `Deduction (${deductQty} yards) exceeds limit of ${thresholds.deductionLimit} yards.`,
      };
    }
    const afterQty = (parseFloat(beforeQty) || 0) - deductQty;
    if (afterQty < 0) {
      return {
        risk: 'approval_required',
        reason: `This would make stock negative (current: ${beforeQty}, deduct: ${deductQty}).`,
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
