/**
 * Analytics for Package/Than inventory — aggregation by design, shade, warehouse, customer.
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const config = require('../config');

const CURRENCY = config.currency || 'NGN';
function fmtMoney(v) { return `${CURRENCY} ${Number(v).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`; }
function fmtQty(v) { return Number(v).toLocaleString('en-NG', { maximumFractionDigits: 0 }); }

/** Stock summary grouped by design+shade. */
async function stockByDesign() {
  const all = await inventoryRepository.getAll();
  const map = new Map();
  all.forEach((r) => {
    const key = `${r.design}|${r.shade}`;
    if (!map.has(key)) map.set(key, { design: r.design, shade: r.shade, total: 0, available: 0, sold: 0, totalYards: 0, availableYards: 0, soldYards: 0, value: 0 });
    const g = map.get(key);
    g.total++;
    g.totalYards += r.yards;
    if (r.status === 'available') { g.available++; g.availableYards += r.yards; g.value += r.yards * r.pricePerYard; }
    else { g.sold++; g.soldYards += r.yards; }
  });
  return Array.from(map.values());
}

/** Stock summary grouped by warehouse. */
async function stockByWarehouse() {
  const all = await inventoryRepository.getAll();
  const map = new Map();
  all.forEach((r) => {
    if (!map.has(r.warehouse)) map.set(r.warehouse, { warehouse: r.warehouse, total: 0, available: 0, availableYards: 0, value: 0 });
    const g = map.get(r.warehouse);
    g.total++;
    if (r.status === 'available') { g.available++; g.availableYards += r.yards; g.value += r.yards * r.pricePerYard; }
  });
  return Array.from(map.values());
}

/** Who bought a specific design (or all designs). */
async function customerAnalysis(design) {
  const all = await inventoryRepository.getAll();
  const sold = all.filter((r) => r.status === 'sold' && r.soldTo);
  const filtered = design ? sold.filter((r) => r.design.toUpperCase() === design.toUpperCase()) : sold;
  const map = new Map();
  filtered.forEach((r) => {
    const key = r.soldTo;
    if (!map.has(key)) map.set(key, { customer: key, thans: 0, yards: 0, value: 0, designs: new Set() });
    const g = map.get(key);
    g.thans++;
    g.yards += r.yards;
    g.value += r.yards * r.pricePerYard;
    g.designs.add(`${r.design} ${r.shade}`);
  });
  return Array.from(map.values()).map((c) => ({ ...c, designs: Array.from(c.designs) }));
}

/** Fast moving: designs with most sold thans. */
async function fastMoving() {
  const byDesign = await stockByDesign();
  return byDesign.filter((d) => d.sold > 0).sort((a, b) => b.soldYards - a.soldYards).slice(0, 10);
}

/** Dead stock: designs with no sales (all thans available). */
async function deadStock() {
  const byDesign = await stockByDesign();
  return byDesign.filter((d) => d.sold === 0 && d.total > 0);
}

/**
 * Human-readable analysis summary. Optionally filter by design/shade.
 */
async function getAnalysisSummary(design, shade) {
  const all = await inventoryRepository.getAll();
  const totalThans = all.length;
  const available = all.filter((r) => r.status === 'available');
  const sold = all.filter((r) => r.status === 'sold');
  const totalAvailYards = available.reduce((s, r) => s + r.yards, 0);
  const totalSoldYards = sold.reduce((s, r) => s + r.yards, 0);
  const stockValue = available.reduce((s, r) => s + r.yards * r.pricePerYard, 0);
  const salesValue = sold.reduce((s, r) => s + r.yards * r.pricePerYard, 0);

  const designs = await stockByDesign();
  const warehouses = await stockByWarehouse();

  let text = `📊 *Inventory Analysis*\n\n`;
  text += `*Total:* ${fmtQty(totalThans)} thans (${fmtQty(totalAvailYards + totalSoldYards)} yards)\n`;
  text += `*Available:* ${fmtQty(available.length)} thans, ${fmtQty(totalAvailYards)} yards (${fmtMoney(stockValue)})\n`;
  text += `*Sold:* ${fmtQty(sold.length)} thans, ${fmtQty(totalSoldYards)} yards (${fmtMoney(salesValue)})\n\n`;

  text += `*By Design (top 5):*\n`;
  designs.sort((a, b) => b.availableYards - a.availableYards);
  designs.slice(0, 5).forEach((d) => {
    text += `  ${d.design} ${d.shade}: ${fmtQty(d.availableYards)} yds avail, ${fmtQty(d.soldYards)} yds sold\n`;
  });

  if (warehouses.length > 1) {
    text += `\n*By Warehouse:*\n`;
    warehouses.forEach((w) => {
      text += `  ${w.warehouse || 'Unassigned'}: ${fmtQty(w.availableYards)} yds (${fmtMoney(w.value)})\n`;
    });
  }

  const topCustomers = await customerAnalysis(design);
  if (topCustomers.length) {
    text += `\n*Top Buyers${design ? ' for ' + design : ''}:*\n`;
    topCustomers.sort((a, b) => b.yards - a.yards);
    topCustomers.slice(0, 5).forEach((c) => {
      text += `  ${c.customer}: ${fmtQty(c.yards)} yds, ${fmtMoney(c.value)}\n`;
    });
  }

  return text;
}

module.exports = {
  stockByDesign,
  stockByWarehouse,
  customerAnalysis,
  fastMoving,
  deadStock,
  getAnalysisSummary,
  fmtMoney,
};
