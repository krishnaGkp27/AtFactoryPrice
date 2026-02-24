/**
 * AI-powered analytics: fast moving, dead stock, revenue, trends, unusual spike.
 * Uses repository data; can add OpenAI for natural-language explanations later.
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const transactionsRepository = require('../repositories/transactionsRepository');
const config = require('../config');

const CURRENCY = config.currency || 'NGN';

function formatMoney(value) {
  return `${CURRENCY} ${Number(value).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

/**
 * Get distinct design+color+warehouse from inventory and optionally from transaction history.
 * Fast moving = sold recently (we don't have dates on inventory; we use Transactions if available).
 */
async function getFastMovingDesigns(lastXDays = 30) {
  const inventory = await inventoryRepository.getAll();
  const byKey = new Map();
  inventory.forEach((r) => {
    const key = `${r.design}|${r.color}|${r.warehouse}`;
    if (!byKey.has(key)) byKey.set(key, { design: r.design, color: r.color, warehouse: r.warehouse, qty: 0, totalValue: 0 });
    const cur = byKey.get(key);
    cur.qty += r.qty;
    cur.totalValue += r.qty * r.price;
  });
  const list = Array.from(byKey.values()).filter((x) => x.qty > 0);
  list.sort((a, b) => b.qty - a.qty);
  return list.slice(0, 20).map((x) => ({
    ...x,
    totalValueFormatted: formatMoney(x.totalValue),
  }));
}

/**
 * Dead stock = design+color+warehouse with no movement for N days.
 * Without transaction dates we approximate: low qty or zero movement (simplified).
 */
async function getDeadStock(noMovementDays = 90) {
  const inventory = await inventoryRepository.getAll();
  const lowOrZero = inventory.filter((r) => r.qty <= 0 || (r.qty > 0 && r.qty < 50));
  return lowOrZero.map((r) => ({
    ...r,
    valueFormatted: formatMoney(r.qty * r.price),
  }));
}

/**
 * Simple monthly revenue: sum (qty sold * price) from transactions would require parsing Transactions.
 * Placeholder: sum inventory value as "stock value" for now; real revenue needs transaction type "sell" and amounts.
 */
async function monthlyRevenueReport() {
  const inventory = await inventoryRepository.getAll();
  let totalValue = 0;
  inventory.forEach((r) => {
    totalValue += r.qty * r.price;
  });
  return {
    period: 'current stock',
    totalStockValue: totalValue,
    totalStockValueFormatted: formatMoney(totalValue),
    note: 'Revenue from sales requires transaction history; this is total inventory value.',
  };
}

/**
 * Detect unusual spike: compare recent activity to baseline. Simplified without full transaction history.
 */
async function detectUnusualSpike() {
  const inventory = await inventoryRepository.getAll();
  const high = inventory.filter((r) => r.qty > 1000);
  return {
    hasSpike: high.length > 0,
    highStockItems: high.map((r) => ({ design: r.design, color: r.color, warehouse: r.warehouse, qty: r.qty })),
    message: high.length ? `${high.length} item(s) have very high stock (>1000 yards).` : 'No unusual spikes detected.',
  };
}

/**
 * Human-readable summary for "analyze" intent.
 */
async function getAnalysisSummary() {
  const [fast, dead, revenue, spike] = await Promise.all([
    getFastMovingDesigns(30),
    getDeadStock(90),
    monthlyRevenueReport(),
    detectUnusualSpike(),
  ]);
  let text = `📊 **Analysis summary**\n\n`;
  text += `**Stock value (current):** ${revenue.totalStockValueFormatted}\n\n`;
  text += `**Top stock (by quantity):** ${fast.slice(0, 5).map((x) => `${x.design} ${x.color} (${x.qty} yd)`).join(', ') || 'N/A'}\n\n`;
  text += `**Low/zero stock items:** ${dead.length}\n`;
  if (spike.hasSpike) text += `\n⚠️ ${spike.message}\n`;
  return text;
}

module.exports = {
  getFastMovingDesigns,
  getDeadStock,
  monthlyRevenueReport,
  detectUnusualSpike,
  getAnalysisSummary,
  formatMoney,
};
