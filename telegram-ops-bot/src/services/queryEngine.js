/**
 * Query Engine: Tier 1 predefined reports + Tier 2 free-form AI analyst.
 * All reports show packages + thans + yards consistently.
 */

const OpenAI = require('openai');
const inventoryRepository = require('../repositories/inventoryRepository');
const customersRepo = require('../repositories/customersRepository');
const analytics = require('../ai/analytics');
const config = require('../config');

const CURRENCY = config.currency || 'NGN';
const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;

function fmtQty(v) { return Number(v).toLocaleString('en-NG', { maximumFractionDigits: 0 }); }
function fmtMoney(v) { return `${CURRENCY} ${Number(v).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`; }

// ─── TIER 1: Predefined Reports (no AI cost) ───

async function stockSummary() {
  const designs = await analytics.stockByDesign();
  designs.sort((a, b) => b.availableYards - a.availableYards);
  let totalPkgs = 0, totalThans = 0, totalYards = 0, totalValue = 0;
  let text = `📦 *Stock Summary*\n\n`;
  designs.forEach((d) => {
    text += `${d.design} ${d.shade}: ${d.availPkgs} pkgs (${d.available} thans), ${fmtQty(d.availableYards)} yds — ${fmtMoney(d.value)}\n`;
    totalPkgs += d.availPkgs; totalThans += d.available; totalYards += d.availableYards; totalValue += d.value;
  });
  text += `\n*Total: ${totalPkgs} packages (${totalThans} thans), ${fmtQty(totalYards)} yards — ${fmtMoney(totalValue)}*`;
  return text;
}

async function stockValuation() {
  const all = await inventoryRepository.getAll();
  const available = all.filter((r) => r.status === 'available');
  const pkgs = new Set(available.map((r) => r.packageNo)).size;
  const yards = available.reduce((s, r) => s + r.yards, 0);
  const value = available.reduce((s, r) => s + r.yards * r.pricePerYard, 0);
  return `💰 *Stock Valuation*\n\n${pkgs} packages (${available.length} thans), ${fmtQty(yards)} yards\nTotal value: ${fmtMoney(value)}`;
}

async function salesReport(period) {
  const all = await inventoryRepository.getAll();
  const sold = all.filter((r) => r.status === 'sold' && r.soldDate);
  const now = new Date();
  let from;
  let label;
  if (period === 'today') { from = now.toISOString().split('T')[0]; label = 'Today'; }
  else if (period === 'this week' || period === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    from = d.toISOString().split('T')[0]; label = 'This Week';
  } else if (period === 'this month' || period === 'month') {
    from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`; label = 'This Month';
  } else { from = '2000-01-01'; label = 'All Time'; }

  const filtered = sold.filter((r) => r.soldDate >= from);
  const pkgs = new Set(filtered.map((r) => r.packageNo)).size;
  const yards = filtered.reduce((s, r) => s + r.yards, 0);
  const value = filtered.reduce((s, r) => s + r.yards * r.pricePerYard, 0);

  const byCustomer = new Map();
  filtered.forEach((r) => {
    if (!r.soldTo) return;
    if (!byCustomer.has(r.soldTo)) byCustomer.set(r.soldTo, { thans: 0, yards: 0 });
    const g = byCustomer.get(r.soldTo); g.thans++; g.yards += r.yards;
  });
  const topBuyer = Array.from(byCustomer.entries()).sort((a, b) => b[1].yards - a[1].yards)[0];

  let text = `📊 *Sales Report — ${label}*\n\n`;
  text += `Sold: ${pkgs} packages (${filtered.length} thans), ${fmtQty(yards)} yards\n`;
  text += `Revenue: ${fmtMoney(value)}\n`;
  if (topBuyer) text += `Top buyer: ${topBuyer[0]} (${topBuyer[1].thans} thans, ${fmtQty(topBuyer[1].yards)} yds)`;
  return text;
}

async function customerReport() {
  const customers = await analytics.customerAnalysis();
  customers.sort((a, b) => b.yards - a.yards);
  let text = `👥 *Customer Report*\n\n`;
  customers.forEach((c) => {
    text += `${c.customer}: ${c.pkgs} pkgs (${c.thans} thans), ${fmtQty(c.yards)} yds, ${fmtMoney(c.value)}\n`;
  });
  if (!customers.length) text += 'No sales recorded yet.';
  return text;
}

/** Supply (sold) by customer for a specific design. Totals computed in code only. */
async function supplyByCustomerByDesign(design) {
  if (!design || !String(design).trim()) return 'Please specify a design, e.g. "Supply to customers for design 44200".';
  const customers = await analytics.customerAnalysis(String(design).trim());
  customers.sort((a, b) => b.yards - a.yards);
  if (!customers.length) return `No supply recorded for design ${design}.`;
  let totalPkgs = 0, totalThans = 0, totalYards = 0;
  let text = `📤 *Supply to customers — design ${design}*\n\n`;
  customers.forEach((c, i) => {
    text += `${i + 1}. ${c.customer}: ${c.pkgs} pkgs (${c.thans} thans, ${fmtQty(c.yards)} yds)\n`;
    totalPkgs += c.pkgs;
    totalThans += c.thans;
    totalYards += c.yards;
  });
  text += `\n*Total supply: ${totalPkgs} pkgs (${totalThans} thans, ${fmtQty(totalYards)} yds)*`;
  return text;
}

async function warehouseSummary() {
  const warehouses = await analytics.stockByWarehouse();
  let text = `🏭 *Warehouse Summary*\n\n`;
  warehouses.forEach((w) => {
    text += `${w.warehouse || 'Unassigned'}: ${w.availPkgs} pkgs (${w.available} thans), ${fmtQty(w.availableYards)} yds — ${fmtMoney(w.value)}\n`;
  });
  if (!warehouses.length) text += 'No warehouse data.';
  return text;
}

async function fastMovingReport() {
  const fast = await analytics.fastMoving();
  let text = `🔥 *Fast Moving Designs*\n\n`;
  fast.forEach((d, i) => {
    text += `${i + 1}. ${d.design} ${d.shade}: ${d.soldPkgs} pkgs sold (${d.sold} thans), ${fmtQty(d.soldYards)} yds\n`;
  });
  if (!fast.length) text += 'No sales data yet.';
  return text;
}

async function deadStockReport() {
  const dead = await analytics.deadStock();
  let text = `⚠️ *Dead Stock (no sales)*\n\n`;
  dead.forEach((d) => {
    text += `${d.design} ${d.shade}: ${d.availPkgs} pkgs (${d.available} thans), ${fmtQty(d.availableYards)} yds — ${fmtMoney(d.value)}\n`;
  });
  if (!dead.length) text += 'All designs have sales — no dead stock.';
  return text;
}

async function indentStatus(indent) {
  const all = await inventoryRepository.getAll();
  const map = new Map();
  const filtered = indent ? all.filter((r) => r.indent.toUpperCase().includes(indent.toUpperCase())) : all;
  filtered.forEach((r) => {
    if (!map.has(r.indent)) map.set(r.indent, { indent: r.indent, total: 0, available: 0, sold: 0, totalYards: 0, availYards: 0, pkgs: new Set() });
    const g = map.get(r.indent);
    g.total++; g.totalYards += r.yards; g.pkgs.add(r.packageNo);
    if (r.status === 'available') { g.available++; g.availYards += r.yards; }
    else { g.sold++; }
  });
  let text = `📋 *Indent Status${indent ? ' — ' + indent : ''}*\n\n`;
  Array.from(map.values()).forEach((g) => {
    const pct = g.total > 0 ? Math.round((g.sold / g.total) * 100) : 0;
    text += `${g.indent}: ${g.pkgs.size} Bales, ${g.available}/${g.total} thans avail, ${fmtQty(g.availYards)} yds remaining (${pct}% sold)\n`;
  });
  if (!map.size) text += 'No indent data found.';
  return text;
}

async function lowStockAlert(threshold) {
  const limit = threshold || 100;
  const designs = await analytics.stockByDesign();
  const low = designs.filter((d) => d.availableYards > 0 && d.availableYards < limit);
  low.sort((a, b) => a.availableYards - b.availableYards);
  let text = `⚠️ *Low Stock (below ${limit} yards)*\n\n`;
  low.forEach((d) => {
    text += `${d.design} ${d.shade}: ${d.availPkgs} pkgs (${d.available} thans), ${fmtQty(d.availableYards)} yds remaining\n`;
  });
  if (!low.length) text += `All designs have ${limit}+ yards available.`;
  return text;
}

async function agingStock(days) {
  const limit = days || 60;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - limit);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const all = await inventoryRepository.getAll();
  const old = all.filter((r) => r.status === 'available' && r.dateReceived && r.dateReceived < cutoffStr);
  const pkgs = new Set(old.map((r) => r.packageNo)).size;
  const yards = old.reduce((s, r) => s + r.yards, 0);
  let text = `📅 *Aging Stock (received over ${limit} days ago, unsold)*\n\n`;
  text += `${pkgs} packages (${old.length} thans), ${fmtQty(yards)} yards still available\n\n`;
  const byDesign = new Map();
  old.forEach((r) => {
    const key = `${r.design} ${r.shade}`;
    if (!byDesign.has(key)) byDesign.set(key, { thans: 0, yards: 0, pkgs: new Set() });
    const g = byDesign.get(key); g.thans++; g.yards += r.yards; g.pkgs.add(r.packageNo);
  });
  Array.from(byDesign.entries()).forEach(([name, g]) => {
    text += `  ${name}: ${g.pkgs.size} pkgs (${g.thans} thans), ${fmtQty(g.yards)} yds\n`;
  });
  if (!old.length) text += `No unsold stock older than ${limit} days.`;
  return text;
}

/** Sold stock report: filter by warehouse, customer, and/or period. Totals in code. */
async function soldReport(warehouse, customer, period) {
  const all = await inventoryRepository.getAll();
  let sold = all.filter((r) => r.status === 'sold' && r.soldDate);
  if (warehouse && String(warehouse).trim()) {
    const wh = String(warehouse).trim().toLowerCase();
    sold = sold.filter((r) => (r.warehouse || '').toLowerCase() === wh || (r.warehouse || '').toLowerCase().includes(wh) || wh.includes((r.warehouse || '').toLowerCase()));
  }
  if (customer && String(customer).trim()) {
    const cust = String(customer).trim().toLowerCase();
    sold = sold.filter((r) => (r.soldTo || '').toLowerCase() === cust || (r.soldTo || '').toLowerCase().includes(cust) || cust.includes((r.soldTo || '').toLowerCase()));
  }
  const now = new Date();
  let from;
  let label;
  if (period === 'today') { from = now.toISOString().split('T')[0]; label = 'Today'; }
  else if (period === 'this week' || period === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    from = d.toISOString().split('T')[0]; label = 'This Week';
  } else if (period === 'this month' || period === 'month') {
    from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`; label = 'This Month';
  } else { from = '2000-01-01'; label = 'All Time'; }
  const filtered = sold.filter((r) => r.soldDate >= from);
  const pkgs = new Set(filtered.map((r) => r.packageNo)).size;
  const thans = filtered.length;
  const yards = filtered.reduce((s, r) => s + r.yards, 0);
  const value = filtered.reduce((s, r) => s + r.yards * r.pricePerYard, 0);
  const parts = [];
  if (warehouse && String(warehouse).trim()) parts.push(`warehouse "${warehouse}"`);
  if (customer && String(customer).trim()) parts.push(`customer "${customer}"`);
  const sub = parts.length ? ` (${parts.join(', ')} — ${label})` : ` — ${label}`;
  let text = `📤 *Sold Report${sub}*\n\n`;
  text += `Sold: ${pkgs} packages (${thans} thans), ${fmtQty(yards)} yards\n`;
  text += `Value: ${fmtMoney(value)}`;
  return text;
}

// ─── TIER 2: Free-form AI Analyst ───

async function freeFormQuery(userQuestion) {
  if (!openai) return 'AI is not configured. Use predefined reports instead.';

  const all = await inventoryRepository.getAll();

  const byDesign = new Map();
  const byWarehouse = new Map();
  const byCustomer = new Map();
  const byIndent = new Map();

  all.forEach((r) => {
    const dk = `${r.design}|${r.shade}`;
    if (!byDesign.has(dk)) byDesign.set(dk, { design: r.design, shade: r.shade, availThans: 0, soldThans: 0, availYards: 0, soldYards: 0, availPkgs: new Set(), soldPkgs: new Set(), value: 0, customers: new Set() });
    const dg = byDesign.get(dk);
    if (r.status === 'available') { dg.availThans++; dg.availYards += r.yards; dg.value += r.yards * r.pricePerYard; dg.availPkgs.add(r.packageNo); }
    else { dg.soldThans++; dg.soldYards += r.yards; dg.soldPkgs.add(r.packageNo); if (r.soldTo) dg.customers.add(r.soldTo); }

    if (!byWarehouse.has(r.warehouse)) byWarehouse.set(r.warehouse, { availThans: 0, availYards: 0, availPkgs: new Set(), value: 0 });
    const wg = byWarehouse.get(r.warehouse);
    if (r.status === 'available') { wg.availThans++; wg.availYards += r.yards; wg.availPkgs.add(r.packageNo); wg.value += r.yards * r.pricePerYard; }

    if (r.soldTo) {
      if (!byCustomer.has(r.soldTo)) byCustomer.set(r.soldTo, { thans: 0, yards: 0, value: 0, pkgs: new Set(), designs: new Set() });
      const cg = byCustomer.get(r.soldTo); cg.thans++; cg.yards += r.yards; cg.value += r.yards * r.pricePerYard; cg.pkgs.add(r.packageNo); cg.designs.add(`${r.design} ${r.shade}`);
    }

    if (!byIndent.has(r.indent)) byIndent.set(r.indent, { total: 0, avail: 0, sold: 0, pkgs: new Set() });
    const ig = byIndent.get(r.indent); ig.total++; ig.pkgs.add(r.packageNo);
    if (r.status === 'available') ig.avail++; else ig.sold++;
  });

  const designSummary = Array.from(byDesign.values()).map((d) => `${d.design} ${d.shade}: ${d.availPkgs.size} pkgs avail (${d.availThans} thans, ${d.availYards} yds, ${CURRENCY}${d.value}), ${d.soldPkgs.size} pkgs sold (${d.soldThans} thans, ${d.soldYards} yds), buyers: ${Array.from(d.customers).join(', ') || 'none'}`).join('\n');
  const whSummary = Array.from(byWarehouse.entries()).map(([w, g]) => `${w || 'Unassigned'}: ${g.availPkgs.size} pkgs (${g.availThans} thans, ${g.availYards} yds, ${CURRENCY}${g.value})`).join('\n');
  const custSummary = Array.from(byCustomer.entries()).map(([c, g]) => `${c}: ${g.pkgs.size} pkgs (${g.thans} thans, ${g.yards} yds, ${CURRENCY}${g.value}), designs: ${Array.from(g.designs).join(', ')}`).join('\n');
  const indentSummary = Array.from(byIndent.entries()).map(([i, g]) => `${i}: ${g.pkgs.size} Bales, ${g.avail}/${g.total} thans avail (${Math.round(g.sold / g.total * 100)}% sold)`).join('\n');

  const dataContext = `INVENTORY DATA SUMMARY (currency: ${CURRENCY}):

BY DESIGN/SHADE:
${designSummary}

BY WAREHOUSE:
${whSummary}

BY CUSTOMER (buyers):
${custSummary}

BY INDENT/SHIPMENT:
${indentSummary}

TOTAL RECORDS: ${all.length} thans across ${new Set(all.map((r) => r.packageNo)).size} packages`;

  try {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: 'system', content: `You are a data analyst for a textile inventory. The user asks questions about their stock. Use ONLY the provided data to answer. Always include package counts, than counts, and yards in your answers. Format the response clearly for Telegram (use plain text, no markdown tables). Be concise and direct. If the data doesn't contain enough info to answer, say so.` },
        { role: 'user', content: `DATA:\n${dataContext}\n\nQUESTION: ${userQuestion}` },
      ],
      temperature: 0.3,
      max_tokens: 800,
    });
    return completion.choices[0]?.message?.content?.trim() || 'Could not generate a response.';
  } catch (e) {
    return `AI query failed: ${e.message}`;
  }
}

module.exports = {
  stockSummary, stockValuation, salesReport, customerReport,
  supplyByCustomerByDesign, soldReport,
  warehouseSummary, fastMovingReport, deadStockReport,
  indentStatus, lowStockAlert, agingStock, freeFormQuery,
};
