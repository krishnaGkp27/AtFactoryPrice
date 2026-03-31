/**
 * Telegram message and callback handler — Package/Than model.
 */

const intentParser = require('../ai/intentParser');
const inventoryService = require('../services/inventoryService');
const approvalEvents = require('../events/approvalEvents');
const auth = require('../middlewares/auth');
const riskEvaluate = require('../risk/evaluate');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const analytics = require('../ai/analytics');
const queryEngine = require('../services/queryEngine');
const crmService = require('../services/crmService');
const accountingService = require('../services/accountingService');
const salesFlow = require('../services/salesFlowService');
const sessionStore = require('../utils/sessionStore');
const settingsRepo = require('../repositories/settingsRepository');
const usersRepository = require('../repositories/usersRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const ordersRepo = require('../repositories/ordersRepository');
const samplesRepo = require('../repositories/samplesRepository');
const customerFollowupsRepo = require('../repositories/customerFollowupsRepository');
const customerNotesRepo = require('../repositories/customerNotesRepository');
const transactionsRepo = require('../repositories/transactionsRepository');
const receiptsRepo = require('../repositories/receiptsRepository');
const driveClient = require('../repositories/driveClient');
const idGenerator = require('../utils/idGenerator');
const config = require('../config');
const logger = require('../utils/logger');

/** Resolve userId to display name: Users sheet name, then Telegram first_name/username, then ID. */
async function getRequesterDisplayName(userId, msgOrNull) {
  try {
    const u = await usersRepository.findByUserId(userId);
    if (u && u.name) return u.name;
  } catch (_) {}
  if (msgOrNull && msgOrNull.from) {
    if (msgOrNull.from.first_name) return msgOrNull.from.first_name;
    if (msgOrNull.from.username) return `@${msgOrNull.from.username}`;
  }
  return String(userId);
}

function genId() {
  try { return require('crypto').randomUUID(); }
  catch { return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
}

async function sendLong(bot, chatId, text, opts = {}) {
  const MAX = 4000;
  if (text.length <= MAX) {
    await bot.sendMessage(chatId, text, opts);
    return;
  }
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > MAX && chunk) {
      await bot.sendMessage(chatId, chunk, opts);
      chunk = line;
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk) await bot.sendMessage(chatId, chunk, opts);
}

async function requireApproval(bot, chatId, msg, userId, action, actionJSON, summary) {
  const risk = await riskEvaluate.evaluate({ action, userId });
  if (risk.risk !== 'approval_required') return false;
  const requestId = genId();
  await approvalQueueRepository.append({
    requestId, user: userId, actionJSON, riskReason: risk.reason, status: 'pending',
  });
  await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);
  await bot.sendMessage(chatId, `⏳ Needs admin approval (${risk.reason}). Request: ${requestId}`);
  const userLabel = await getRequesterDisplayName(userId, msg);
  await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, risk.reason);
  return true;
}

const CURRENCY = config.currency || 'NGN';

function fmtQty(n) { return Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 }); }
function fmtMoney(n) { return `${CURRENCY} ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`; }

/** Parse date string to YYYY-MM-DD for ledger range. Supports YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY. */
function parseLedgerDate(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  const ymd = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return null;
}

/** Compute next occurrence of a weekday (1=Mon..5=Fri) as YYYY-MM-DD. */
function nextWeekday(dayOfWeek) {
  const d = new Date();
  const diff = (dayOfWeek - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

// ─── Supply Details Reports ─────────────────────────────────────────────────

async function getSoldItems() {
  const all = await inventoryRepository.getAll();
  return all.filter((r) => r.status === 'sold' && r.soldTo);
}

function buildDesignWiseReport(sold) {
  const designs = new Map();
  for (const r of sold) {
    const key = r.design || 'Unknown';
    if (!designs.has(key)) designs.set(key, { shades: new Map(), totalPkgs: new Set(), totalThans: 0, totalYards: 0, totalValue: 0, buyers: new Map() });
    const dg = designs.get(key);
    const sk = r.shade || '-';
    if (!dg.shades.has(sk)) dg.shades.set(sk, { pkgs: new Set(), thans: 0, yards: 0, value: 0 });
    const sh = dg.shades.get(sk);
    sh.pkgs.add(r.packageNo); sh.thans++; sh.yards += r.yards; sh.value += r.yards * r.pricePerYard;
    dg.totalPkgs.add(r.packageNo); dg.totalThans++; dg.totalYards += r.yards; dg.totalValue += r.yards * r.pricePerYard;
    dg.buyers.set(r.soldTo, (dg.buyers.get(r.soldTo) || 0) + r.yards);
  }
  const sorted = [...designs.entries()].sort((a, b) => b[1].totalValue - a[1].totalValue);
  let text = `📊 *Supply Details — Design Wise*\n\n`;
  let grandPkgs = new Set(), grandThans = 0, grandYards = 0, grandValue = 0;
  for (const [design, dg] of sorted) {
    text += `📦 *${design}*\n`;
    const shadesSorted = [...dg.shades.entries()].sort((a, b) => b[1].yards - a[1].yards);
    for (const [shade, sh] of shadesSorted) {
      text += `  Shade ${shade}: ${sh.pkgs.size} pkgs, ${sh.thans} thans, ${fmtQty(sh.yards)} yds — ${fmtMoney(sh.value)}\n`;
    }
    const topBuyer = [...dg.buyers.entries()].sort((a, b) => b[1] - a[1])[0];
    text += `  *Total: ${dg.totalPkgs.size} pkgs, ${dg.totalThans} thans, ${fmtQty(dg.totalYards)} yds — ${fmtMoney(dg.totalValue)}*\n`;
    if (topBuyer) text += `  Top buyer: ${topBuyer[0]} (${fmtQty(topBuyer[1])} yds)\n`;
    text += '\n';
    for (const p of dg.totalPkgs) grandPkgs.add(p);
    grandThans += dg.totalThans; grandYards += dg.totalYards; grandValue += dg.totalValue;
  }
  text += `*Grand Total: ${grandPkgs.size} pkgs, ${grandThans} thans, ${fmtQty(grandYards)} yds — ${fmtMoney(grandValue)}*`;
  return text;
}

function buildCustomerWiseReport(sold) {
  const customers = new Map();
  for (const r of sold) {
    const key = r.soldTo;
    if (!customers.has(key)) customers.set(key, { items: [], totalPkgs: new Set(), totalThans: 0, totalYards: 0, totalValue: 0 });
    const cg = customers.get(key);
    cg.items.push(r);
    cg.totalPkgs.add(r.packageNo); cg.totalThans++; cg.totalYards += r.yards; cg.totalValue += r.yards * r.pricePerYard;
  }
  const sorted = [...customers.entries()].sort((a, b) => b[1].totalValue - a[1].totalValue);
  let text = `📊 *Supply Details — Customer Wise*\n\n`;
  let grandPkgs = new Set(), grandThans = 0, grandYards = 0, grandValue = 0;
  for (const [customer, cg] of sorted) {
    text += `👤 *${customer}*\n`;
    const byDS = new Map();
    for (const r of cg.items) {
      const key = `${r.design}|${r.shade || '-'}`;
      if (!byDS.has(key)) byDS.set(key, { design: r.design, shade: r.shade || '-', pkgs: new Set(), thans: 0, yards: 0, value: 0 });
      const ds = byDS.get(key);
      ds.pkgs.add(r.packageNo); ds.thans++; ds.yards += r.yards; ds.value += r.yards * r.pricePerYard;
    }
    const dsSorted = [...byDS.values()].sort((a, b) => b.yards - a.yards);
    for (const ds of dsSorted) {
      text += `  ${ds.design} Shade ${ds.shade}: ${ds.pkgs.size} pkgs, ${ds.thans} thans, ${fmtQty(ds.yards)} yds — ${fmtMoney(ds.value)}\n`;
    }
    text += `  *Total: ${cg.totalPkgs.size} pkgs, ${cg.totalThans} thans, ${fmtQty(cg.totalYards)} yds — ${fmtMoney(cg.totalValue)}*\n\n`;
    for (const p of cg.totalPkgs) grandPkgs.add(p);
    grandThans += cg.totalThans; grandYards += cg.totalYards; grandValue += cg.totalValue;
  }
  text += `*Grand Total: ${grandPkgs.size} pkgs, ${grandThans} thans, ${fmtQty(grandYards)} yds — ${fmtMoney(grandValue)}*`;
  return text;
}

function buildWarehouseWiseReport(sold) {
  const warehouses = new Map();
  for (const r of sold) {
    const key = r.warehouse || 'Unknown';
    if (!warehouses.has(key)) warehouses.set(key, { items: [], totalPkgs: new Set(), totalThans: 0, totalYards: 0, totalValue: 0 });
    const wg = warehouses.get(key);
    wg.items.push(r);
    wg.totalPkgs.add(r.packageNo); wg.totalThans++; wg.totalYards += r.yards; wg.totalValue += r.yards * r.pricePerYard;
  }
  const sorted = [...warehouses.entries()].sort((a, b) => b[1].totalValue - a[1].totalValue);
  let text = `📊 *Supply Details — Warehouse Wise*\n\n`;
  let grandPkgs = new Set(), grandThans = 0, grandYards = 0, grandValue = 0;
  for (const [wh, wg] of sorted) {
    text += `🏭 *${wh}*\n`;
    const byDS = new Map();
    for (const r of wg.items) {
      const key = `${r.design}|${r.shade || '-'}`;
      if (!byDS.has(key)) byDS.set(key, { design: r.design, shade: r.shade || '-', pkgs: new Set(), thans: 0, yards: 0, value: 0 });
      const ds = byDS.get(key);
      ds.pkgs.add(r.packageNo); ds.thans++; ds.yards += r.yards; ds.value += r.yards * r.pricePerYard;
    }
    const dsSorted = [...byDS.values()].sort((a, b) => b.yards - a.yards);
    for (const ds of dsSorted) {
      text += `  ${ds.design} Shade ${ds.shade}: ${ds.pkgs.size} pkgs, ${ds.thans} thans, ${fmtQty(ds.yards)} yds — ${fmtMoney(ds.value)}\n`;
    }
    text += `  *Total: ${wg.totalPkgs.size} pkgs, ${wg.totalThans} thans, ${fmtQty(wg.totalYards)} yds — ${fmtMoney(wg.totalValue)}*\n\n`;
    for (const p of wg.totalPkgs) grandPkgs.add(p);
    grandThans += wg.totalThans; grandYards += wg.totalYards; grandValue += wg.totalValue;
  }
  text += `*Grand Total: ${grandPkgs.size} pkgs, ${grandThans} thans, ${fmtQty(grandYards)} yds — ${fmtMoney(grandValue)}*`;
  return text;
}

// ─── End Supply Details Reports ─────────────────────────────────────────────

// ─── Inventory Details Reports ──────────────────────────────────────────────

function aggregateShadeRows(items) {
  const byDS = new Map();
  for (const r of items) {
    const key = `${r.design}|${r.shade || '-'}`;
    if (!byDS.has(key)) byDS.set(key, { design: r.design, shade: r.shade || '-', totalPkgs: new Set(), soldPkgs: new Set(), balPkgs: new Set(), totalThans: 0, soldThans: 0, balThans: 0, totalYards: 0, soldYards: 0, balYards: 0, totalValue: 0 });
    const ds = byDS.get(key);
    ds.totalPkgs.add(r.packageNo); ds.totalThans++; ds.totalYards += r.yards; ds.totalValue += r.yards * r.pricePerYard;
    if (r.status === 'sold') { ds.soldPkgs.add(r.packageNo); ds.soldThans++; ds.soldYards += r.yards; }
    else { ds.balPkgs.add(r.packageNo); ds.balThans++; ds.balYards += r.yards; }
  }
  return [...byDS.values()].sort((a, b) => b.balYards - a.balYards);
}

function fmtBar(sold, total) {
  if (!total) return '';
  const pct = Math.round((sold / total) * 100);
  const filled = Math.round(pct / 10);
  return '▓'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}% sold`;
}

function buildInventoryWarehouseReport(allItems) {
  const warehouses = new Map();
  for (const r of allItems) {
    const wh = r.warehouse || 'Unknown';
    if (!warehouses.has(wh)) warehouses.set(wh, []);
    warehouses.get(wh).push(r);
  }
  let text = '';
  let gTotalYards = 0, gSoldYards = 0, gBalYards = 0, gBalPkgs = new Set(), gTotalPkgs = new Set();
  for (const [wh, items] of [...warehouses.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const rows = aggregateShadeRows(items);
    let whTotalYards = 0, whSoldYards = 0, whBalYards = 0, whBalPkgs = new Set(), whTotalPkgs = new Set();
    text += `🏭 *${wh}*\n`;
    for (const ds of rows) {
      text += `  ${ds.design} Shade ${ds.shade}: ${ds.balPkgs.size} pkgs, ${fmtQty(ds.balYards)} yds avail | ${fmtQty(ds.totalYards)} total | ${fmtBar(ds.soldYards, ds.totalYards)}\n`;
      whTotalYards += ds.totalYards; whSoldYards += ds.soldYards; whBalYards += ds.balYards;
      for (const p of ds.balPkgs) whBalPkgs.add(p);
      for (const p of ds.totalPkgs) whTotalPkgs.add(p);
    }
    text += `  *${wh} Total: ${whTotalPkgs.size} pkgs | ${fmtQty(whTotalYards)} yds total | ${fmtQty(whSoldYards)} sold | Balance: ${whBalPkgs.size} pkgs, ${fmtQty(whBalYards)} yds*\n\n`;
    gTotalYards += whTotalYards; gSoldYards += whSoldYards; gBalYards += whBalYards;
    for (const p of whBalPkgs) gBalPkgs.add(p);
    for (const p of whTotalPkgs) gTotalPkgs.add(p);
  }
  text += `*Grand Total: ${gTotalPkgs.size} pkgs | ${fmtQty(gTotalYards)} yds total | ${fmtQty(gSoldYards)} sold | Balance: ${gBalPkgs.size} pkgs, ${fmtQty(gBalYards)} yds*`;
  return `📦 *Inventory Details — Warehouse Wise*\n\n` + text;
}

function buildInventoryDesignReport(allItems) {
  const designs = new Map();
  for (const r of allItems) {
    const key = r.design || 'Unknown';
    if (!designs.has(key)) designs.set(key, []);
    designs.get(key).push(r);
  }
  let text = '';
  let gTotalYards = 0, gSoldYards = 0, gBalYards = 0, gBalPkgs = new Set(), gTotalPkgs = new Set();
  const sortedDesigns = [...designs.entries()].sort((a, b) => {
    const balA = a[1].filter((r) => r.status === 'available').reduce((s, r) => s + r.yards, 0);
    const balB = b[1].filter((r) => r.status === 'available').reduce((s, r) => s + r.yards, 0);
    return balB - balA;
  });
  for (const [design, items] of sortedDesigns) {
    const rows = aggregateShadeRows(items);
    let dTotalYards = 0, dSoldYards = 0, dBalYards = 0, dBalPkgs = new Set(), dTotalPkgs = new Set();
    text += `📦 *${design}*\n`;
    for (const ds of rows) {
      text += `  Shade ${ds.shade}: ${ds.balPkgs.size} pkgs, ${fmtQty(ds.balYards)} yds avail | ${fmtQty(ds.totalYards)} total | ${fmtBar(ds.soldYards, ds.totalYards)}\n`;
      dTotalYards += ds.totalYards; dSoldYards += ds.soldYards; dBalYards += ds.balYards;
      for (const p of ds.balPkgs) dBalPkgs.add(p);
      for (const p of ds.totalPkgs) dTotalPkgs.add(p);
    }
    text += `  *Total: ${dTotalPkgs.size} pkgs | ${fmtQty(dTotalYards)} yds total | ${fmtQty(dSoldYards)} sold | Balance: ${dBalPkgs.size} pkgs, ${fmtQty(dBalYards)} yds*\n\n`;
    gTotalYards += dTotalYards; gSoldYards += dSoldYards; gBalYards += dBalYards;
    for (const p of dBalPkgs) gBalPkgs.add(p);
    for (const p of dTotalPkgs) gTotalPkgs.add(p);
  }
  text += `*Grand Total: ${gTotalPkgs.size} pkgs | ${fmtQty(gTotalYards)} yds total | ${fmtQty(gSoldYards)} sold | Balance: ${gBalPkgs.size} pkgs, ${fmtQty(gBalYards)} yds*`;
  return `📦 *Inventory Details — Design Wise*\n\n` + text;
}

// ─── Sales Report (Interactive) ─────────────────────────────────────────────

function filterSoldByPeriod(sold, periodDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - periodDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  return sold.filter((r) => r.soldDate >= cutoffStr);
}

function buildSalesDesignReport(sold, periodLabel) {
  const byDS = new Map();
  for (const r of sold) {
    const key = `${r.design}|${r.shade || '-'}`;
    if (!byDS.has(key)) byDS.set(key, { design: r.design, shade: r.shade || '-', pkgs: new Set(), thans: 0, yards: 0, value: 0 });
    const ds = byDS.get(key);
    ds.pkgs.add(r.packageNo); ds.thans++; ds.yards += r.yards; ds.value += r.yards * r.pricePerYard;
  }
  const sorted = [...byDS.values()].sort((a, b) => b.value - a.value);
  let text = `📊 *Sales Report — ${periodLabel} — Design Wise*\n\n`;
  if (!sorted.length) return text + 'No sales in this period.';
  let gPkgs = new Set(), gThans = 0, gYards = 0, gValue = 0;
  let rank = 0;
  for (const ds of sorted) {
    rank++;
    text += `${rank}. *${ds.design}* Shade ${ds.shade}\n`;
    text += `   ${ds.pkgs.size} pkgs, ${ds.thans} thans, ${fmtQty(ds.yards)} yds — ${fmtMoney(ds.value)}\n`;
    for (const p of ds.pkgs) gPkgs.add(p);
    gThans += ds.thans; gYards += ds.yards; gValue += ds.value;
  }
  text += `\n*Grand Total: ${gPkgs.size} pkgs, ${gThans} thans, ${fmtQty(gYards)} yds — ${fmtMoney(gValue)}*`;
  return text;
}

function buildSalesCustomerReport(sold, periodLabel) {
  const customers = new Map();
  for (const r of sold) {
    const key = r.soldTo || 'Unknown';
    if (!customers.has(key)) customers.set(key, { items: [], pkgs: new Set(), thans: 0, yards: 0, value: 0 });
    const cg = customers.get(key);
    cg.items.push(r);
    cg.pkgs.add(r.packageNo); cg.thans++; cg.yards += r.yards; cg.value += r.yards * r.pricePerYard;
  }
  const sorted = [...customers.entries()].sort((a, b) => b[1].value - a[1].value);
  let text = `📊 *Sales Report — ${periodLabel} — Customer Wise*\n\n`;
  if (!sorted.length) return text + 'No sales in this period.';
  let gPkgs = new Set(), gThans = 0, gYards = 0, gValue = 0;
  let rank = 0;
  for (const [customer, cg] of sorted) {
    rank++;
    text += `${rank}. 👤 *${customer}*\n`;
    const byDS = new Map();
    for (const r of cg.items) {
      const key = `${r.design}|${r.shade || '-'}`;
      if (!byDS.has(key)) byDS.set(key, { design: r.design, shade: r.shade || '-', pkgs: new Set(), thans: 0, yards: 0, value: 0 });
      const ds = byDS.get(key);
      ds.pkgs.add(r.packageNo); ds.thans++; ds.yards += r.yards; ds.value += r.yards * r.pricePerYard;
    }
    const dsSorted = [...byDS.values()].sort((a, b) => b.value - a.value);
    for (const ds of dsSorted) {
      text += `   ${ds.design} Shade ${ds.shade}: ${ds.pkgs.size} pkgs, ${ds.thans} thans, ${fmtQty(ds.yards)} yds — ${fmtMoney(ds.value)}\n`;
    }
    text += `   *Total: ${cg.pkgs.size} pkgs, ${cg.thans} thans, ${fmtQty(cg.yards)} yds — ${fmtMoney(cg.value)}*\n\n`;
    for (const p of cg.pkgs) gPkgs.add(p);
    gThans += cg.thans; gYards += cg.yards; gValue += cg.value;
  }
  text += `*Grand Total: ${gPkgs.size} pkgs, ${gThans} thans, ${fmtQty(gYards)} yds — ${fmtMoney(gValue)}*`;
  return text;
}

// ─── End Inventory & Sales Reports ──────────────────────────────────────────

// ─── Customer CRM Suite ─────────────────────────────────────────────────────

async function buildCustomerTimeline(customerName) {
  const allInv = await inventoryRepository.getAll();
  const sold = allInv.filter((r) => r.status === 'sold' && r.soldTo && r.soldTo.toLowerCase() === customerName.toLowerCase());
  const events = [];

  for (const r of sold) {
    events.push({ date: r.soldDate || r.updatedAt?.slice(0, 10) || '', type: 'Sale', detail: `${r.design} Shade ${r.shade || '-'} | Pkg ${r.packageNo} | ${fmtQty(r.yards)} yds — ${fmtMoney(r.yards * r.pricePerYard)}` });
  }

  try {
    const orders = await ordersRepo.getAll();
    for (const o of orders) {
      if (o.customer.toLowerCase() === customerName.toLowerCase()) {
        events.push({ date: o.created_at?.slice(0, 10) || '', type: `Order (${o.status})`, detail: `${o.order_id} | ${o.design} | Qty: ${o.quantity}` });
      }
    }
  } catch (_) {}

  try {
    const samples = await samplesRepo.getAll();
    for (const s of samples) {
      if (s.customer.toLowerCase() === customerName.toLowerCase()) {
        events.push({ date: s.date_given || s.created_at?.slice(0, 10) || '', type: `Sample (${s.status})`, detail: `${s.sample_id} | ${s.design} Shade ${s.shade || '-'} | Type ${s.sample_type} | ${s.quantity} pcs` });
      }
    }
  } catch (_) {}

  try {
    const ledgerRepo = require('../repositories/ledgerRepository');
    const ledgerRows = await ledgerRepo.getAll();
    for (const e of ledgerRows) {
      if (e.ledger_name && e.ledger_name.toLowerCase() === customerName.toLowerCase() && e.credit > 0) {
        events.push({ date: e.date || '', type: 'Payment', detail: `${fmtMoney(e.credit)} — ${e.narration || ''}` });
      }
    }
  } catch (_) {}

  events.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return events;
}

async function buildCustomerRanking() {
  const allInv = await inventoryRepository.getAll();
  const sold = allInv.filter((r) => r.status === 'sold' && r.soldTo);
  const customers = new Map();
  for (const r of sold) {
    const name = r.soldTo;
    if (!customers.has(name)) customers.set(name, { pkgs: new Set(), thans: 0, yards: 0, value: 0, lastDate: '', txns: 0 });
    const c = customers.get(name);
    c.pkgs.add(r.packageNo); c.thans++; c.yards += r.yards; c.value += r.yards * r.pricePerYard; c.txns++;
    if (r.soldDate > c.lastDate) c.lastDate = r.soldDate;
  }
  return [...customers.entries()].sort((a, b) => b[1].value - a[1].value);
}

async function buildCustomerPattern(customerName) {
  const allInv = await inventoryRepository.getAll();
  const sold = allInv.filter((r) => r.status === 'sold' && r.soldTo && r.soldTo.toLowerCase() === customerName.toLowerCase());
  if (!sold.length) return null;

  const byDS = new Map();
  let totalPkgs = new Set(), totalYards = 0, totalValue = 0, firstDate = '9999', lastDate = '';
  for (const r of sold) {
    const key = `${r.design}|${r.shade || '-'}`;
    if (!byDS.has(key)) byDS.set(key, { design: r.design, shade: r.shade || '-', pkgs: new Set(), thans: 0, yards: 0, value: 0 });
    const ds = byDS.get(key);
    ds.pkgs.add(r.packageNo); ds.thans++; ds.yards += r.yards; ds.value += r.yards * r.pricePerYard;
    totalPkgs.add(r.packageNo); totalYards += r.yards; totalValue += r.yards * r.pricePerYard;
    if (r.soldDate && r.soldDate < firstDate) firstDate = r.soldDate;
    if (r.soldDate && r.soldDate > lastDate) lastDate = r.soldDate;
  }

  return {
    items: [...byDS.values()].sort((a, b) => b.value - a.value),
    totalPkgs: totalPkgs.size, totalYards, totalValue, totalThans: sold.length,
    firstDate: firstDate === '9999' ? '-' : firstDate, lastDate: lastDate || '-',
  };
}

async function getInactiveCustomers(daysThreshold = 30) {
  const allInv = await inventoryRepository.getAll();
  const sold = allInv.filter((r) => r.status === 'sold' && r.soldTo);
  const customers = new Map();
  for (const r of sold) {
    const name = r.soldTo;
    if (!customers.has(name)) customers.set(name, { lastDate: '', lastAction: 'Sale' });
    const c = customers.get(name);
    if (r.soldDate > c.lastDate) { c.lastDate = r.soldDate; c.lastAction = 'Sale'; }
  }
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysThreshold);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  return [...customers.entries()]
    .filter(([, c]) => c.lastDate && c.lastDate < cutoffStr)
    .map(([name, c]) => ({ name, lastDate: c.lastDate, lastAction: c.lastAction, daysAgo: Math.floor((Date.now() - new Date(c.lastDate).getTime()) / 86400000) }))
    .sort((a, b) => b.daysAgo - a.daysAgo);
}

// ─── End Customer CRM Suite ─────────────────────────────────────────────────

// ─── Sample Flow Helpers ────────────────────────────────────────────────────

async function handleSampleFlowText(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'sample_flow') return false;

  if (text.toLowerCase() === 'cancel') {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, 'Sample request cancelled.');
    return true;
  }

  if (session.step === 'customer_new') {
    session.customer = text.trim();
    session.step = 'quantity';
    sessionStore.set(userId, session);
    await bot.sendMessage(chatId, `Customer: *${session.customer}*\n\nHow many sample pieces?`, { parse_mode: 'Markdown' });
    return true;
  }

  if (session.step === 'quantity') {
    const qty = text.trim();
    if (!qty || isNaN(Number(qty)) || Number(qty) <= 0) {
      await bot.sendMessage(chatId, 'Please enter a valid positive number.');
      return true;
    }
    session.quantity = qty;
    session.step = 'followup';
    sessionStore.set(userId, session);
    await bot.sendMessage(chatId, 'Follow-up date (DD-MM-YYYY or YYYY-MM-DD):');
    return true;
  }

  if (session.step === 'followup') {
    const parsed = parseLedgerDate(text.trim());
    if (!parsed) {
      await bot.sendMessage(chatId, 'Could not parse date. Use DD-MM-YYYY or YYYY-MM-DD.');
      return true;
    }
    session.followup_date = parsed;
    session.step = 'confirm';
    sessionStore.set(userId, session);
    let summary = `*Sample Request Summary*\n\n`;
    summary += `Design: ${session.design}${session.shade ? ' Shade ' + session.shade : ''}\n`;
    summary += `Type: ${session.sample_type}\n`;
    summary += `Customer: ${session.customer}\n`;
    summary += `Quantity: ${session.quantity} pcs\n`;
    summary += `Follow-up: ${session.followup_date}\n`;
    const keyboard = { inline_keyboard: [[
      { text: '✅ Submit for Approval', callback_data: 'smpconf:1' },
      { text: '❌ Cancel', callback_data: 'smpcanc:1' },
    ]] };
    await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown', reply_markup: keyboard });
    return true;
  }

  return false;
}

function buildSampleStatusReport(samples, title) {
  if (!samples.length) return `${title}\n\nNo active samples found.`;
  const byCustomer = new Map();
  for (const s of samples) {
    if (!byCustomer.has(s.customer)) byCustomer.set(s.customer, []);
    byCustomer.get(s.customer).push(s);
  }
  let text = `${title}\n\n`;
  for (const [customer, list] of byCustomer) {
    text += `👤 *${customer}*\n`;
    for (const s of list) {
      const daysAgo = Math.floor((Date.now() - new Date(s.date_given).getTime()) / 86400000);
      text += `  ${s.sample_id}: ${s.design}${s.shade ? ' Shade ' + s.shade : ''} | Type ${s.sample_type} | ${s.quantity} pcs | ${daysAgo}d ago | Follow-up: ${s.followup_date || '-'}\n`;
    }
    text += '\n';
  }
  text += `*Total: ${samples.length} active samples with ${byCustomer.size} customers*`;
  return text;
}

// ─── End Sample Flow Helpers ────────────────────────────────────────────────

/** Handle text replies during an active order creation session. Returns true if consumed. */
async function handleOrderFlowText(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'order_flow') return false;

  if (text.toLowerCase() === 'cancel') {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, 'Order creation cancelled.');
    return true;
  }

  if (session.step === 'customer_new') {
    session.customer = text.trim();
    session.step = 'quantity';
    sessionStore.set(userId, session);
    await bot.sendMessage(chatId, `Customer: *${session.customer}*\n\nEnter quantity:`, { parse_mode: 'Markdown' });
    return true;
  }

  if (session.step === 'quantity') {
    const qty = text.trim();
    if (!qty || isNaN(Number(qty)) || Number(qty) <= 0) {
      await bot.sendMessage(chatId, 'Please enter a valid positive number for quantity.');
      return true;
    }
    session.quantity = qty;
    session.step = 'salesperson';
    sessionStore.set(userId, session);
    const users = await usersRepository.getAll();
    const active = users.filter((u) => u.status === 'active');
    if (!active.length) {
      await bot.sendMessage(chatId, 'No active employees found in Users sheet. Add employees first.');
      sessionStore.clear(userId);
      return true;
    }
    const rows = [];
    for (let i = 0; i < active.length; i += 2) {
      const row = [{ text: active[i].name, callback_data: `os:${active[i].user_id}` }];
      if (active[i + 1]) row.push({ text: active[i + 1].name, callback_data: `os:${active[i + 1].user_id}` });
      rows.push(row);
    }
    await bot.sendMessage(chatId, 'Select salesperson:', { reply_markup: { inline_keyboard: rows } });
    return true;
  }

  if (session.step === 'date_custom') {
    const parsed = parseLedgerDate(text.trim());
    if (!parsed) {
      await bot.sendMessage(chatId, 'Could not parse date. Use DD-MM-YYYY or YYYY-MM-DD format.');
      return true;
    }
    session.scheduled_date = parsed;
    session.step = 'confirm';
    sessionStore.set(userId, session);
    await showOrderSummary(bot, chatId, session);
    return true;
  }

  return false;
}

async function showOrderSummary(bot, chatId, session) {
  let summary = `*Supply Order Summary*\n\n`;
  summary += `Design: ${session.design}${session.shade ? ' ' + session.shade : ''}\n`;
  summary += `Customer: ${session.customer}\n`;
  summary += `Quantity: ${session.quantity}\n`;
  summary += `Salesperson: ${session.salesperson_name}\n`;
  summary += `Payment: ${session.payment_status}\n`;
  summary += `Scheduled Date: ${session.scheduled_date}\n`;
  const keyboard = { inline_keyboard: [[
    { text: '✅ Confirm Order', callback_data: `oconf:1` },
    { text: '❌ Cancel', callback_data: `ocanc:1` },
  ]] };
  await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown', reply_markup: keyboard });
}

// ─── Receipt Upload Flow ────────────────────────────────────────────────────

async function downloadTelegramFile(bot, fileId) {
  const file = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), filePath: file.file_path }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function startReceiptFlow(bot, chatId, userId) {
  const customersRepoLocal = require('../repositories/customersRepository');
  const allCust = await customersRepoLocal.getAll();
  const active = allCust.filter((c) => (c.status || 'Active').toLowerCase() === 'active' && c.name);
  const rows = [];
  for (let i = 0; i < active.length; i += 2) {
    const row = [{ text: active[i].name, callback_data: `rcc:${active[i].name.slice(0, 50)}` }];
    if (active[i + 1]) row.push({ text: active[i + 1].name, callback_data: `rcc:${active[i + 1].name.slice(0, 50)}` });
    rows.push(row);
  }
  if (rows.length > 20) rows.splice(20);
  rows.push([{ text: '➕ Register New Customer', callback_data: 'rcc:__new__' }]);
  sessionStore.set(userId, { type: 'receipt_flow', step: 'customer', createdBy: userId });
  await bot.sendMessage(chatId, '🧾 *Upload Payment Receipt*\n\nSelect customer:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function handleReceiptFlowText(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'receipt_flow') return false;

  if (text.toLowerCase() === 'cancel') {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, 'Receipt upload cancelled.');
    return true;
  }

  if (session.step === 'customer_new') {
    session.customer = text.trim();
    session.step = 'amount';
    sessionStore.set(userId, session);
    await bot.sendMessage(chatId, `Customer: *${session.customer}*\n\nEnter the payment amount received (NGN):`, { parse_mode: 'Markdown' });
    return true;
  }

  if (session.step === 'amount') {
    const amount = parseFloat(text.replace(/[,]/g, ''));
    if (isNaN(amount) || amount <= 0) {
      await bot.sendMessage(chatId, 'Please enter a valid positive amount (e.g. 50000).');
      return true;
    }
    session.amount = amount;
    session.step = 'bank';
    sessionStore.set(userId, session);
    const allSettings = await settingsRepo.getAll();
    const banks = (allSettings.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean);
    const bankRows = [];
    const allBankOpts = [...banks, 'Cash'];
    for (let i = 0; i < allBankOpts.length; i += 3) {
      const row = [];
      for (let j = i; j < i + 3 && j < allBankOpts.length; j++) {
        row.push({ text: allBankOpts[j], callback_data: `rcb:${allBankOpts[j].slice(0, 50)}` });
      }
      bankRows.push(row);
    }
    await bot.sendMessage(chatId, `Amount: *NGN ${fmtQty(amount)}*\n\nPayment received in which account?`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: bankRows },
    });
    return true;
  }

  if (session.step === 'file') {
    await bot.sendMessage(chatId, 'Please send a *photo* or *PDF document* of the receipt.', { parse_mode: 'Markdown' });
    return true;
  }

  return false;
}

function showReceiptSummary(bot, chatId, userId, session) {
  const fileLabel = session.file_type === 'document' ? '📄 PDF attached' : '📷 Photo attached';
  const summary = `🧾 *Payment Receipt Summary*\n\n` +
    `👤 Customer: *${session.customer}*\n` +
    `💰 Amount: *NGN ${fmtQty(session.amount)}*\n` +
    `🏦 Account: *${session.bank_account}*\n` +
    `📎 File: ${fileLabel}\n` +
    `👷 Uploaded by: ${session.uploaded_by_name} (${session.uploaded_by_id})\n` +
    `📅 Date: ${new Date().toISOString().split('T')[0]}\n\n` +
    `Confirm and submit for approval?`;
  const keyboard = { inline_keyboard: [[
    { text: '✅ Confirm & Submit', callback_data: 'rcconf:1' },
    { text: '❌ Cancel', callback_data: 'rccanc:1' },
  ]] };
  return bot.sendMessage(chatId, summary, { parse_mode: 'Markdown', reply_markup: keyboard });
}

/**
 * Handle incoming photo or document messages.
 * Routes to active receipt_flow or sale_flow sessions that await a file.
 */
async function handleFileMessage(bot, msg) {
  const chatId = msg.chat?.id;
  const userId = String(msg.from?.id || '');

  if (!auth.isAllowed(userId)) {
    await bot.sendMessage(chatId, 'You are not authorized to use this bot.');
    return;
  }

  const session = sessionStore.get(userId);

  if (session && session.type === 'receipt_flow' && session.step === 'file') {
    let telegramFileId, fileType, mimeType;
    if (msg.photo && msg.photo.length) {
      const largest = msg.photo[msg.photo.length - 1];
      telegramFileId = largest.file_id;
      fileType = 'image';
      mimeType = 'image/jpeg';
    } else if (msg.document) {
      telegramFileId = msg.document.file_id;
      fileType = 'document';
      mimeType = msg.document.mime_type || 'application/pdf';
    } else {
      await bot.sendMessage(chatId, 'Please send a photo or PDF file.');
      return;
    }
    session.telegram_file_id = telegramFileId;
    session.file_type = fileType;
    session.mime_type = mimeType;
    session.step = 'confirm';
    sessionStore.set(userId, session);
    await showReceiptSummary(bot, chatId, userId, session);
    return;
  }

  if (session && session.type === 'sale_flow' && session.awaitingDocument) {
    let telegramFileId, fileType, mimeType;
    if (msg.photo && msg.photo.length) {
      const largest = msg.photo[msg.photo.length - 1];
      telegramFileId = largest.file_id;
      fileType = 'image';
      mimeType = 'image/jpeg';
    } else if (msg.document) {
      telegramFileId = msg.document.file_id;
      fileType = 'document';
      mimeType = msg.document.mime_type || 'application/pdf';
    } else {
      await bot.sendMessage(chatId, 'Please send a photo or PDF file of the sales bill.');
      return;
    }
    session.sale_doc_file_id = telegramFileId;
    session.sale_doc_type = fileType;
    session.sale_doc_mime = mimeType;
    session.awaitingDocument = false;
    session.awaitingConfirmation = true;
    sessionStore.set(userId, session);
    const summary = await salesFlow.buildSummary(session);
    const docLabel = fileType === 'document' ? '📄 PDF attached' : '📷 Photo attached';
    const keyboard = { inline_keyboard: [[
      { text: '✅ Confirm', callback_data: `confirm_sale:${userId}` },
      { text: '❌ Cancel', callback_data: `cancel_sale:${userId}` },
    ]] };
    await bot.sendMessage(chatId, `${summary}\n\n📎 Sales bill: ${docLabel}`, { reply_markup: keyboard });
    return;
  }

  await bot.sendMessage(chatId, 'To upload a receipt, first type "Upload receipt" to start the process.');
}

// ─── End Receipt Upload Flow ────────────────────────────────────────────────

async function handleMessage(bot, msg) {
  const chatId = msg.chat?.id;
  const userId = String(msg.from?.id || '');
  const text = (msg.text || '').trim();

  if (!auth.isAllowed(userId)) {
    await bot.sendMessage(chatId, 'You are not authorized to use this bot.');
    return;
  }

  await auditLogRepository.append('telegram_message', { chatId, text: text.slice(0, 200) }, userId);

  if (!text) {
    await bot.sendMessage(chatId, helpText());
    return;
  }

  const ledgerCommands = require('../commands/ledgerCommands');
  if (text.startsWith('/ledger ')) {
    try {
      await ledgerCommands.handleLedger(bot, chatId, userId, text.replace(/^\/ledger\s+/i, '').trim());
    } catch (e) {
      await bot.sendMessage(chatId, `Ledger error: ${e.message || 'Unknown error'}`);
    }
    return;
  }
  if (text.startsWith('/balance ')) {
    try {
      await ledgerCommands.handleBalance(bot, chatId, userId, text.replace(/^\/balance\s+/i, '').trim());
    } catch (e) {
      await bot.sendMessage(chatId, `Balance error: ${e.message || 'Unknown error'}`);
    }
    return;
  }
  if (text.startsWith('/payment ')) {
    try {
      await ledgerCommands.handlePayment(bot, chatId, userId, text.replace(/^\/payment\s+/i, '').trim());
    } catch (e) {
      await bot.sendMessage(chatId, `Payment error: ${e.message || 'Unknown error'}`);
    }
    return;
  }
  if (text.startsWith('/addledgercustomer ')) {
    try {
      await ledgerCommands.handleAddLedgerCustomer(bot, chatId, userId, text.replace(/^\/addledgercustomer\s+/i, '').trim());
    } catch (e) {
      await bot.sendMessage(chatId, `Add customer error: ${e.message || 'Unknown error'}`);
    }
    return;
  }

  if (config.access.adminIds.includes(userId)) {
    const handled = await approvalEvents.handleEnrichmentMessage(bot, chatId, userId, text);
    if (handled) return;
  }

  const orderFlowHandled = await handleOrderFlowText(bot, chatId, userId, text);
  if (orderFlowHandled) return;

  const sampleFlowHandled = await handleSampleFlowText(bot, chatId, userId, text);
  if (sampleFlowHandled) return;

  const receiptFlowHandled = await handleReceiptFlowText(bot, chatId, userId, text);
  if (receiptFlowHandled) return;

  if (text.toLowerCase() === '/create_order' || text.toLowerCase() === 'create order') {
    if (!config.access.adminIds.includes(userId)) {
      await bot.sendMessage(chatId, 'Only admin can create orders.');
      return;
    }
    await startOrderFlow(bot, chatId, userId);
    return;
  }

  const activeSession = salesFlow.getSession(userId);
  if (activeSession) {
    const handled = await handleSaleSession(bot, chatId, msg, userId, text, activeSession);
    if (handled) return;
  }

  const intent = await intentParser.parse(text);

  if (intent.confidence < 0.75 && intent.clarification) {
    await bot.sendMessage(chatId, `Need more info: ${intent.clarification}`);
    return;
  }

  try {
    switch (intent.action) {

      case 'check': {
        const filters = {};
        if (intent.design) filters.design = intent.design;
        if (intent.shade) filters.shade = intent.shade;
        if (intent.warehouse) filters.warehouse = intent.warehouse;
        if (intent.packageNo) filters.packageNo = intent.packageNo;
        const stock = await inventoryService.checkStock(filters);
        const label = [
          intent.design ? `Design: ${intent.design}` : null,
          intent.shade ? `Shade: ${intent.shade}` : null,
          intent.warehouse ? `Warehouse: ${intent.warehouse}` : null,
        ].filter(Boolean).join(', ') || 'All stock';
        let reply = `📦 *${label}*\n`;
        reply += `Available: ${stock.totalPackages} packages (${stock.totalThans} thans), ${fmtQty(stock.totalYards)} yards\n`;
        reply += `Value: ${fmtMoney(stock.totalValue)}`;
        if (stock.totalThans === 0) reply += '\n⚠️ No available stock matching these filters.';
        await sendLong(bot, chatId, reply, { parse_mode: 'Markdown' });
        return;
      }

      case 'list_packages': {
        if (!intent.design) {
          await bot.sendMessage(chatId, 'Which design? e.g. "Show packages for design 44200"');
          return;
        }
        const packages = await inventoryService.listPackages(intent.design, intent.shade);
        if (!packages.length) {
          await bot.sendMessage(chatId, `No packages found for design ${intent.design}${intent.shade ? ' ' + intent.shade : ''}.`);
          return;
        }
        let reply = `📋 *Packages for ${intent.design}${intent.shade ? ' ' + intent.shade : ''}:*\n\n`;
        packages.forEach((p) => {
          reply += `Pkg ${p.packageNo} (${p.warehouse}): ${p.available}/${p.total} thans avail, ${fmtQty(p.availableYards)} yds\n`;
        });
        const totalAvail = packages.reduce((s, p) => s + p.availableYards, 0);
        reply += `\n*Total: ${packages.length} packages, ${fmtQty(totalAvail)} yards*`;
        await sendLong(bot, chatId, reply, { parse_mode: 'Markdown' });
        return;
      }

      case 'package_detail': {
        if (!intent.packageNo) {
          await bot.sendMessage(chatId, 'Which package? e.g. "Details of package 5801"');
          return;
        }
        const summary = await inventoryService.getPackageSummary(intent.packageNo);
        if (!summary) {
          await bot.sendMessage(chatId, `Package ${intent.packageNo} not found.`);
          return;
        }
        let reply = `📦 *Package ${summary.packageNo}*\n`;
        reply += `Design: ${summary.design} | Shade: ${summary.shade}\n`;
        reply += `Indent: ${summary.indent} | Warehouse: ${summary.warehouse}\n`;
        reply += `Price: ${fmtMoney(summary.pricePerYard)}/yard\n\n`;
        reply += `Thans (${summary.availableThans}/${summary.totalThans} available):\n`;
        summary.thans.forEach((t) => {
          const icon = t.status === 'available' ? '🟢' : '🔴';
          const sold = t.soldTo ? ` → ${t.soldTo} (${t.soldDate})` : '';
          reply += `${icon} Than ${t.thanNo}: ${fmtQty(t.yards)} yds${sold}\n`;
        });
        reply += `\n*Available: ${summary.availableThans} thans, ${fmtQty(summary.availableYards)} yds | Sold: ${summary.soldThans} thans, ${fmtQty(summary.soldYards)} yds*`;
        await sendLong(bot, chatId, reply, { parse_mode: 'Markdown' });
        return;
      }

      case 'sell_than': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Sell than 3 from package 5801 to Ibrahim"'); return; }
        if (!intent.thanNo) { await bot.sendMessage(chatId, 'Which than number?'); return; }
        const items = [{ type: 'than', packageNo: intent.packageNo, thanNo: intent.thanNo }];
        await startSaleFlow(bot, chatId, msg, userId, 'sell_than', items, intent);
        return;
      }

      case 'sell_package': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Sell package 5801 to Adamu"'); return; }
        const items = [{ type: 'package', packageNo: intent.packageNo }];
        await startSaleFlow(bot, chatId, msg, userId, 'sell_package', items, intent);
        return;
      }

      case 'sell_batch': {
        if (!intent.packageNos || !intent.packageNos.length) { await bot.sendMessage(chatId, 'Which packages? e.g. "Sell packages 5801, 5802, 5803 to Ibrahim"'); return; }
        const items = intent.packageNos.map((p) => ({ type: 'package', packageNo: p }));
        await startSaleFlow(bot, chatId, msg, userId, 'sell_batch', items, intent);
        return;
      }

      case 'sell_mixed': {
        if (!intent.thanItems || !intent.thanItems.length) { await bot.sendMessage(chatId, 'Which thans? e.g. "Sell than 1 from 5801, than 2 from 5804 to Customer"'); return; }
        const mixedItems = intent.thanItems.map((t) => ({ type: 'than', packageNo: t.packageNo, thanNo: t.thanNo }));
        await startSaleFlow(bot, chatId, msg, userId, 'sell_mixed', mixedItems, intent);
        return;
      }

      case 'return_than': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Return than 2 from package 5801"'); return; }
        if (!intent.thanNo) { await bot.sendMessage(chatId, 'Which than number?'); return; }
        const rtQueued = await requireApproval(bot, chatId, msg, userId, 'return_than',
          { action: 'return_than', packageNo: intent.packageNo, thanNo: intent.thanNo },
          `Return than ${intent.thanNo} from pkg ${intent.packageNo}`);
        if (rtQueued) return;
        const retThan = await inventoryService.returnThan(intent.packageNo, intent.thanNo, userId);
        if (retThan.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Returned than ${intent.thanNo} from package ${intent.packageNo} (${fmtQty(retThan.than.yards)} yds) — now available.`);
        } else {
          await bot.sendMessage(chatId, retThan.message || 'Could not return.');
        }
        return;
      }

      case 'return_package': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Return package 5801"'); return; }
        const rpQueued = await requireApproval(bot, chatId, msg, userId, 'return_package',
          { action: 'return_package', packageNo: intent.packageNo },
          `Return package ${intent.packageNo}`);
        if (rpQueued) return;
        const retPkg = await inventoryService.returnPackage(intent.packageNo, userId);
        if (retPkg.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Returned package ${intent.packageNo}: 1 package (${retPkg.returnedThans} thans), ${fmtQty(retPkg.returnedYards)} yards — now available.`);
        } else {
          await bot.sendMessage(chatId, retPkg.message || 'Could not return.');
        }
        return;
      }

      case 'update_price': {
        if (!config.access.adminIds.includes(userId)) {
          await bot.sendMessage(chatId, 'Only admin can update prices.');
          return;
        }
        if (!intent.price) { await bot.sendMessage(chatId, 'What is the new price per yard? e.g. "Update price of 44200 Shade 3 to 1500"'); return; }
        if (!intent.design) { await bot.sendMessage(chatId, 'Which design? e.g. "Update price of 44200 Shade 3 to 1500"'); return; }
        const filters = {};
        filters.design = intent.design;
        if (intent.shade) filters.shade = intent.shade;
        if (intent.packageNo) filters.packageNo = intent.packageNo;
        if (intent.warehouse) filters.warehouse = intent.warehouse;
        const label = `${filters.design}${filters.shade ? ' Shade ' + filters.shade : ''}${filters.warehouse ? ' at ' + filters.warehouse : ''}`;
        const requestId = genId();
        await approvalQueueRepository.append({
          requestId, user: userId,
          actionJSON: { action: 'update_price', filters, price: intent.price },
          riskReason: '2nd admin approval required for price update', status: 'pending',
        });
        await auditLogRepository.append('approval_queued', { requestId, reason: 'price_update_approval' }, userId);
        const userLabel = await getRequesterDisplayName(userId, msg);
        const summary = `Price Update Request\n${label}\nNew price: ${fmtMoney(intent.price)}/yard\nRequested by: ${userLabel}`;
        const otherAdmins = config.access.adminIds.filter((id) => id !== userId);
        if (!otherAdmins.length) {
          const priceResult = await inventoryService.updatePrice(filters, intent.price, userId);
          if (priceResult.status === 'completed') {
            await bot.sendMessage(chatId, `✅ Updated price for ${priceResult.label}: ${fmtMoney(priceResult.newPrice)}/yard (${priceResult.updated} rows). (Only 1 admin configured — auto-approved)`);
          } else {
            await bot.sendMessage(chatId, priceResult.message || 'Could not update price.');
          }
          return;
        }
        await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, '2nd admin approval required');
        await bot.sendMessage(chatId, `⏳ Price update for ${label} to ${fmtMoney(intent.price)}/yard submitted for 2nd admin approval.\nRequest: ${requestId}`);
        return;
      }

      case 'transfer_than': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Transfer than 3 from package 5801 to Kano"'); return; }
        if (!intent.thanNo) { await bot.sendMessage(chatId, 'Which than number?'); return; }
        if (!intent.warehouse) { await bot.sendMessage(chatId, 'To which warehouse? e.g. "Transfer than 3 from package 5801 to Kano"'); return; }
        const ttInfo = await inventoryService.getPackageSummary(intent.packageNo);
        const ttThan = ttInfo?.thans?.find((t) => t.thanNo === intent.thanNo);
        const ttFrom = ttInfo?.warehouse || '?';
        const ttDetail = `Transfer Than\nPackage: ${intent.packageNo}\nThan: ${intent.thanNo} (${ttThan ? fmtQty(ttThan.yards) + ' yds' : '?'})\nDesign: ${ttInfo?.design || '?'} ${ttInfo?.shade || ''}\nFrom: ${ttFrom}\nTo: ${intent.warehouse}`;
        const ttQueued = await requireApproval(bot, chatId, msg, userId, 'transfer_than',
          { action: 'transfer_than', packageNo: intent.packageNo, thanNo: intent.thanNo, toWarehouse: intent.warehouse },
          ttDetail);
        if (ttQueued) return;
        const ttRes = await inventoryService.transferThan(intent.packageNo, intent.thanNo, intent.warehouse, userId);
        if (ttRes.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Transferred than ${intent.thanNo} from package ${intent.packageNo} (${fmtQty(ttRes.than.yards)} yds): ${ttRes.than.fromWarehouse} → ${intent.warehouse}`);
        } else {
          await bot.sendMessage(chatId, ttRes.message || 'Could not transfer.');
        }
        return;
      }

      case 'transfer_package': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Transfer package 5801 to Kano"'); return; }
        if (!intent.warehouse) { await bot.sendMessage(chatId, 'To which warehouse?'); return; }
        const tpInfo = await inventoryService.getPackageSummary(intent.packageNo);
        const tpFrom = tpInfo?.warehouse || '?';
        const tpDetail = `Transfer Package\nPackage: ${intent.packageNo}\nDesign: ${tpInfo?.design || '?'} ${tpInfo?.shade || ''}\nThans: ${tpInfo?.availableThans || '?'} available\nYards: ${tpInfo ? fmtQty(tpInfo.availableYards) : '?'}\nFrom: ${tpFrom}\nTo: ${intent.warehouse}`;
        const tpQueued = await requireApproval(bot, chatId, msg, userId, 'transfer_package',
          { action: 'transfer_package', packageNo: intent.packageNo, toWarehouse: intent.warehouse },
          tpDetail);
        if (tpQueued) return;
        const tpRes = await inventoryService.transferPackage(intent.packageNo, intent.warehouse, userId);
        if (tpRes.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Transferred package ${intent.packageNo}: 1 package (${tpRes.transferredThans} thans), ${fmtQty(tpRes.totalYards)} yds — ${tpRes.fromWarehouse} → ${intent.warehouse}`);
        } else {
          await bot.sendMessage(chatId, tpRes.message || 'Could not transfer.');
        }
        return;
      }

      case 'transfer_batch': {
        if (!intent.packageNos || !intent.packageNos.length) { await bot.sendMessage(chatId, 'Which packages? e.g. "Transfer packages 5801, 5802, 5803 to Kano"'); return; }
        if (!intent.warehouse) { await bot.sendMessage(chatId, 'To which warehouse?'); return; }
        let batchDetail = `Transfer Batch\nPackages: ${intent.packageNos.join(', ')}\nTo: ${intent.warehouse}\n\nDetails:\n`;
        let batchTotalThans = 0, batchTotalYards = 0;
        for (const pkgNo of intent.packageNos) {
          const pkgInfo = await inventoryService.getPackageSummary(pkgNo);
          if (pkgInfo) {
            batchDetail += `  Pkg ${pkgNo}: ${pkgInfo.design} ${pkgInfo.shade}, ${pkgInfo.availableThans} thans, ${fmtQty(pkgInfo.availableYards)} yds (from ${pkgInfo.warehouse})\n`;
            batchTotalThans += pkgInfo.availableThans;
            batchTotalYards += pkgInfo.availableYards;
          } else {
            batchDetail += `  Pkg ${pkgNo}: not found\n`;
          }
        }
        batchDetail += `\nTotal: ${intent.packageNos.length} packages (${batchTotalThans} thans), ${fmtQty(batchTotalYards)} yards`;
        const tbQueued = await requireApproval(bot, chatId, msg, userId, 'transfer_batch',
          { action: 'transfer_batch', packageNos: intent.packageNos, toWarehouse: intent.warehouse },
          batchDetail);
        if (tbQueued) return;
        const tbRes = await inventoryService.transferBatch(intent.packageNos, intent.warehouse, userId);
        let tbReply = `✅ Batch transfer to ${intent.warehouse}:\n`;
        tbRes.details.forEach((d) => {
          const icon = d.status === 'completed' ? '✅' : '⚠️';
          tbReply += `${icon} Pkg ${d.packageNo}: ${d.status === 'completed' ? `${d.transferredThans} thans, ${fmtQty(d.totalYards)} yds` : (d.message || d.status)}\n`;
        });
        tbReply += `\n*Total: ${tbRes.totalPackages} packages (${tbRes.totalThans} thans), ${fmtQty(tbRes.totalYards)} yards*`;
        await sendLong(bot, chatId, tbReply, { parse_mode: 'Markdown' });
        return;
      }

      case 'add': {
        await bot.sendMessage(chatId, 'To add stock, use the CSV import or add data directly to the Inventory sheet. Bulk import: place CSV in the project folder and run the import script.');
        return;
      }

      case 'analyze': {
        const summary = await analytics.getAnalysisSummary(intent.design, intent.shade);
        await sendLong(bot, chatId, summary, { parse_mode: 'Markdown' });
        return;
      }

      case 'report_stock': {
        await sendLong(bot, chatId, await queryEngine.stockSummary(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_valuation': {
        await sendLong(bot, chatId, await queryEngine.stockValuation(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_sales': {
        const period = intent.salesDate || 'all';
        await sendLong(bot, chatId, await queryEngine.salesReport(period), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_customers': {
        await sendLong(bot, chatId, await queryEngine.customerReport(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_warehouses': {
        await sendLong(bot, chatId, await queryEngine.warehouseSummary(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_fast_moving': {
        await sendLong(bot, chatId, await queryEngine.fastMovingReport(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_dead_stock': {
        await sendLong(bot, chatId, await queryEngine.deadStockReport(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_indents': {
        await sendLong(bot, chatId, await queryEngine.indentStatus(intent.design), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_low_stock': {
        await sendLong(bot, chatId, await queryEngine.lowStockAlert(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_aging': {
        await sendLong(bot, chatId, await queryEngine.agingStock(), { parse_mode: 'Markdown' });
        return;
      }
      case 'report_supply_by_design': {
        if (!intent.design || !String(intent.design).trim()) {
          await bot.sendMessage(chatId, 'Please specify a design, e.g. "Supply to customers for design 44200".');
          return;
        }
        const supplyReport = await queryEngine.supplyByCustomerByDesign(intent.design);
        await sendLong(bot, chatId, supplyReport, { parse_mode: 'Markdown' });
        return;
      }
      case 'report_sold': {
        const soldReportText = await queryEngine.soldReport(intent.warehouse, intent.customer, intent.salesDate || 'all');
        await sendLong(bot, chatId, soldReportText, { parse_mode: 'Markdown' });
        return;
      }
      case 'ask_data': {
        await bot.sendMessage(chatId, '🔍 Analyzing your data...');
        const answer = await queryEngine.freeFormQuery(text);
        await sendLong(bot, chatId, answer);
        return;
      }

      case 'add_customer': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'Customer name is required. e.g. "Add customer Ibrahim, phone +234..."'); return; }
        const rawText = text;
        const phoneMatch = rawText.match(/phone\s+([+\d\s-]+)/i);
        const addressMatch = rawText.match(/address\s+([^,]+)/i);
        const catMatch = rawText.match(/\b(wholesale|retail)\b/i);
        const limitMatch = rawText.match(/credit\s*limit\s+(\d+)/i);
        const termsMatch = rawText.match(/\b(net\s*\d+|cod|credit)\b/i);
        const custData = {
          name: intent.customer,
          phone: phoneMatch ? phoneMatch[1].trim() : '',
          address: addressMatch ? addressMatch[1].trim() : '',
          category: catMatch ? catMatch[1] : 'Retail',
          credit_limit: limitMatch ? parseInt(limitMatch[1]) : 0,
          payment_terms: termsMatch ? termsMatch[1] : 'COD',
        };
        const acQueued = await requireApproval(bot, chatId, msg, userId, 'add_customer',
          { action: 'add_customer', ...custData },
          `Add customer ${intent.customer}`);
        if (acQueued) return;
        const res = await crmService.addCustomer(custData);
        if (res.status === 'exists') {
          await bot.sendMessage(chatId, `Customer "${res.customer.name}" already exists (${res.customer.customer_id}).`);
        } else {
          await bot.sendMessage(chatId, `✅ Customer "${res.customer.name}" created (${res.customer.customer_id}).`);
        }
        return;
      }

      case 'check_customer': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'Which customer? e.g. "Show customer Ibrahim"'); return; }
        const cust = await crmService.getCustomer(intent.customer);
        if (!cust) { await bot.sendMessage(chatId, `Customer "${intent.customer}" not found.`); return; }
        let r = `👤 *${cust.name}* (${cust.customer_id})\n`;
        r += `Category: ${cust.category} | Status: ${cust.status}\n`;
        if (cust.phone) r += `Phone: ${cust.phone}\n`;
        if (cust.address) r += `Address: ${cust.address}\n`;
        r += `Credit limit: ${fmtMoney(cust.credit_limit)}\n`;
        r += `Outstanding: ${fmtMoney(cust.outstanding_balance)}\n`;
        r += `Terms: ${cust.payment_terms}`;
        await bot.sendMessage(chatId, r, { parse_mode: 'Markdown' });
        return;
      }

      case 'check_balance': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'Which customer?'); return; }
        const cb = await crmService.getCustomer(intent.customer);
        if (!cb) { await bot.sendMessage(chatId, `Customer "${intent.customer}" not found.`); return; }
        await bot.sendMessage(chatId, `💰 ${cb.name}: Outstanding balance ${fmtMoney(cb.outstanding_balance)} (limit: ${fmtMoney(cb.credit_limit)})`);
        return;
      }

      case 'record_payment': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'From which customer?'); return; }
        const amt = intent.price;
        if (!amt || amt <= 0) { await bot.sendMessage(chatId, 'How much was paid? e.g. "Record payment 50000 from Ibrahim via bank"'); return; }
        const methodMatch = text.match(/\b(bank|cash|transfer)\b/i);
        const payMethod = methodMatch ? methodMatch[1] : 'cash';
        const rpQueued2 = await requireApproval(bot, chatId, msg, userId, 'record_payment',
          { action: 'record_payment', customer: intent.customer, amount: amt, method: payMethod },
          `Record payment ${fmtMoney(amt)} from ${intent.customer} via ${payMethod}`);
        if (rpQueued2) return;
        const payRes = await crmService.recordPayment({ customer: intent.customer, amount: amt, method: payMethod, userId });
        if (payRes.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Payment recorded: ${fmtMoney(payRes.paid)} from ${payRes.customer}.\nBalance: ${fmtMoney(payRes.previousBalance)} → ${fmtMoney(payRes.newBalance)}`);
        } else {
          await bot.sendMessage(chatId, payRes.message || 'Could not record payment.');
        }
        return;
      }

      case 'show_ledger': {
        if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Ledger access is admin-only.'); return; }
        const customer = intent.customer || (text.match(/ledger\s+for\s+(.+?)(?:\s+from\s|\s+to\s|$)/i) || [])[1];
        const fromMatch = text.match(/from\s+(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i);
        const toMatch = text.match(/to\s+(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i);
        let fromDate = intent.fromDate || (fromMatch && parseLedgerDate(fromMatch[1]));
        let toDate = intent.toDate || (toMatch && parseLedgerDate(toMatch[1]));
        if (!fromDate || !toDate) { fromDate = null; toDate = null; }
        if (customer && String(customer).trim()) {
          const custName = String(customer).trim();
          const { entries: custEntries, totalDebit, totalCredit, outstanding, outstandingAsOfToday } = await accountingService.getCustomerLedger(custName, fromDate, toDate);
          if (!custEntries.length) {
            await bot.sendMessage(chatId, fromDate && toDate
              ? `No ledger entries for "${custName}" between ${fromDate} and ${toDate}.`
              : `No ledger entries found for "${custName}".`);
            return;
          }
          const rangeLabel = fromDate && toDate ? ` (${fromDate} to ${toDate})` : '';
          let ledgerText = `📒 *Ledger for ${custName}${rangeLabel}*\n\n`;
          custEntries.forEach((e) => {
            const dr = e.debit ? `DR ${fmtMoney(e.debit)}` : '';
            const cr = e.credit ? `CR ${fmtMoney(e.credit)}` : '';
            ledgerText += `${e.date} | ${dr}${cr} | Bal ${fmtMoney(e.running)}\n  ${e.narration}\n`;
          });
          ledgerText += `\n*Total DR: ${fmtMoney(totalDebit)} | Total CR: ${fmtMoney(totalCredit)} | Outstanding (${fromDate && toDate ? 'end of range' : 'total'}): ${fmtMoney(outstanding)}*`;
          ledgerText += `\n*Outstanding as of today: ${fmtMoney(outstandingAsOfToday)}*`;
          await sendLong(bot, chatId, ledgerText, { parse_mode: 'Markdown' });
          return;
        }
        const today = new Date().toISOString().split('T')[0];
        const entries = await accountingService.getDaybook(today);
        if (!entries.length) { await bot.sendMessage(chatId, `No ledger entries for ${today}.`); return; }
        let ledgerText = `📒 *Ledger — ${today}*\n\n`;
        entries.forEach((e) => {
          const dr = e.debit ? `DR ${fmtMoney(e.debit)}` : '';
          const cr = e.credit ? `CR ${fmtMoney(e.credit)}` : '';
          ledgerText += `${e.ledger_name}: ${dr}${cr} — ${e.narration}\n`;
        });
        await sendLong(bot, chatId, ledgerText, { parse_mode: 'Markdown' });
        return;
      }

      case 'trial_balance': {
        if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Trial balance is admin-only.'); return; }
        const tb = await accountingService.getTrialBalance();
        if (!tb.length) { await bot.sendMessage(chatId, 'No ledger entries yet.'); return; }
        let tbText = `📊 *Trial Balance*\n\n`;
        let totalDr = 0, totalCr = 0;
        tb.forEach((a) => {
          tbText += `${a.account_name}: DR ${fmtMoney(a.totalDebit)} | CR ${fmtMoney(a.totalCredit)}\n`;
          totalDr += a.totalDebit; totalCr += a.totalCredit;
        });
        tbText += `\n*Totals: DR ${fmtMoney(totalDr)} | CR ${fmtMoney(totalCr)}*`;
        await sendLong(bot, chatId, tbText, { parse_mode: 'Markdown' });
        return;
      }

      case 'report_last_transactions': {
        if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Only admin can view transactions.'); return; }
        const transactionsRepo = require('../repositories/transactionsRepository');
        const n = Math.min(parseInt(intent.price, 10) || 10, 30);
        let lastTxns = await transactionsRepo.getLast(Math.max(n, 50));
        const users = await usersRepository.getAll();
        const userById = new Map(users.map((u) => [String(u.user_id), u.name]));
        const userByName = new Map(users.map((u) => [u.name.toLowerCase(), u.user_id]));
        if (intent.customer && String(intent.customer).trim()) {
          const uid = userByName.get(String(intent.customer).trim().toLowerCase());
          if (uid) lastTxns = lastTxns.filter((t) => String(t.user) === String(uid));
          else lastTxns = lastTxns.filter((t) => (userById.get(String(t.user)) || '').toLowerCase().includes(String(intent.customer).toLowerCase()));
        }
        lastTxns = lastTxns.slice(0, n);
        if (!lastTxns.length) { await bot.sendMessage(chatId, intent.customer ? `No transactions found for "${intent.customer}".` : 'No transactions yet.'); return; }
        const escapeMd = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/\*/g, '\\*');
        let out = `📋 *Last ${lastTxns.length} transaction(s)${intent.customer ? ` for ${escapeMd(intent.customer)}` : ''}*\n\n`;
        lastTxns.forEach((t, i) => {
          const userName = userById.get(String(t.user)) || t.user || '—';
          const ts = (t.timestamp || '').toString().slice(0, 10);
          out += `${i + 1}. ${ts} | *${escapeMd(userName)}* | ${escapeMd(t.action)} | ${escapeMd(t.design || '')} ${escapeMd(t.color || '')} | Qty ${t.qty} | ${escapeMd(t.customerName || '')} | ${escapeMd(t.status)}\n`;
        });
        out += `\n_User column in sheet stores Telegram ID; here we show name from Users._`;
        await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
        return;
      }

      case 'revert_last_transaction': {
        if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Only admin can revert transactions.'); return; }
        const transactionsRepo = require('../repositories/transactionsRepository');
        const lastTxns = await transactionsRepo.getLast(1);
        if (!lastTxns.length) { await bot.sendMessage(chatId, 'No transactions to revert.'); return; }
        const t = lastTxns[0];
        if (t.status === 'reverted') { await bot.sendMessage(chatId, 'Last transaction is already reverted.'); return; }
        if (t.action !== 'sale_bundle' || !t.saleRefId) {
          await bot.sendMessage(chatId, `Last transaction is "${t.action}" (no SaleRefId). Only sale_bundle (approved sales) can be reverted.`);
          return;
        }
        const result = await inventoryService.revertSaleBundle(t.saleRefId, userId);
        if (!result.ok) {
          await bot.sendMessage(chatId, `Revert failed: ${result.message}`);
          return;
        }
        await transactionsRepo.setStatusReverted(t.timestamp, t.user, t.action);
        await bot.sendMessage(chatId, `✅ Last transaction reverted. ${result.revertedThans} thans marked available again; ledger reversed.`);
        return;
      }

      case 'add_bank': {
        if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Only admin can manage banks.'); return; }
        if (!intent.bankName) { await bot.sendMessage(chatId, 'Which bank? e.g. "Add bank GTBank"'); return; }
        const all = await settingsRepo.getAll();
        const banks = (all.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean);
        if (banks.map((b) => b.toLowerCase()).includes(intent.bankName.toLowerCase())) {
          await bot.sendMessage(chatId, `Bank "${intent.bankName}" already exists.`);
          return;
        }
        banks.push(intent.bankName);
        await settingsRepo.set('BANK_LIST', banks.join(','));
        await bot.sendMessage(chatId, `✅ Bank "${intent.bankName}" added. Banks: ${banks.join(', ')}`);
        return;
      }

      case 'remove_bank': {
        if (!auth.isAdmin(userId)) { await bot.sendMessage(chatId, 'Only admin can manage banks.'); return; }
        if (!intent.bankName) { await bot.sendMessage(chatId, 'Which bank? e.g. "Remove bank GTBank"'); return; }
        const allS = await settingsRepo.getAll();
        let banksList = (allS.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean);
        const before = banksList.length;
        banksList = banksList.filter((b) => b.toLowerCase() !== intent.bankName.toLowerCase());
        if (banksList.length === before) { await bot.sendMessage(chatId, `Bank "${intent.bankName}" not found.`); return; }
        await settingsRepo.set('BANK_LIST', banksList.join(','));
        await bot.sendMessage(chatId, `✅ Bank "${intent.bankName}" removed. Banks: ${banksList.join(', ') || 'none'}`);
        return;
      }

      case 'list_banks': {
        const allB = await settingsRepo.getAll();
        const bankList = (allB.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean);
        await bot.sendMessage(chatId, bankList.length ? `Registered banks: ${bankList.join(', ')}` : 'No banks registered. Admin can add with "Add bank GTBank".');
        return;
      }

      case 'add_user': {
        if (!config.access.adminIds.includes(userId)) {
          await bot.sendMessage(chatId, 'Only admin can add users.');
          return;
        }
        const telegramId = intent.price != null ? String(Math.floor(Number(intent.price))) : null;
        const newUserName = intent.customer || intent.salesperson || '';
        if (!telegramId || telegramId === 'NaN' || !newUserName) {
          await bot.sendMessage(chatId, 'Usage: Add user <telegram_id> as <name>. Example: Add user 123456789 as Yarima. (Get Telegram ID from the user when they message the bot or from your logs.)');
          return;
        }
        const existing = await usersRepository.findByUserId(telegramId);
        if (existing) {
          await bot.sendMessage(chatId, `User with ID ${telegramId} already exists: ${existing.name}.`);
          return;
        }
        await usersRepository.append({
          user_id: telegramId,
          name: newUserName.trim(),
          role: 'employee',
          branch: '',
          access_level: 'branch_only',
          status: 'active',
        });
        await bot.sendMessage(chatId, `✅ User added: ${newUserName} (ID: ${telegramId}). You can now assign tasks to them.`);
        return;
      }

      case 'assign_task': {
        if (!config.access.adminIds.includes(userId)) {
          await bot.sendMessage(chatId, 'Only admins can assign tasks.');
          return;
        }
        const title = intent.taskTitle || intent.design || text.replace(/^assign\s+task\s+/i, '').trim();
        const assigneeName = intent.customer;
        if (!title || !assigneeName) {
          await bot.sendMessage(chatId, 'Please specify task title and assignee. Example: "Assign task Deliver order to Abdul".');
          return;
        }
        const tasksRepo = require('../repositories/tasksRepository');
        const users = await usersRepository.getAll();
        const assignee = users.find((u) => u.name.toLowerCase() === assigneeName.toLowerCase());
        if (!assignee) {
          await bot.sendMessage(chatId, `User "${assigneeName}" not found in Users. Add them first.`);
          return;
        }
        const created = await tasksRepo.append({ title, description: '', assigned_to: assignee.user_id, assigned_by: userId, status: 'pending' });
        await bot.sendMessage(chatId, `✅ Task assigned: "${title}" to ${assignee.name} (ID: ${created.task_id}). They can view with "My tasks" and mark done when finished.`);
        return;
      }

      case 'my_tasks': {
        const tasksRepo = require('../repositories/tasksRepository');
        const list = await tasksRepo.getByAssignedTo(userId);
        if (!list.length) {
          await bot.sendMessage(chatId, 'You have no assigned tasks.');
          return;
        }
        let out = '📋 *Your tasks*\n\n';
        for (const t of list) {
          const statusLabel = t.status === 'completed' ? '✅' : t.status === 'submitted' ? '⏳ (pending admin approval)' : '📌';
          out += `${statusLabel} ${t.task_id}: ${t.title}\n  Status: ${t.status}${t.completed_at ? `, completed ${t.completed_at.slice(0, 10)}` : ''}\n\n`;
        }
        out += 'To mark a task done, say: "Mark task <task_id> done" (e.g. Mark task ' + list[0].task_id + ' done)';
        await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
        return;
      }

      case 'add_contact': {
        const name = intent.customer || intent.salesperson || '';
        const typeMatch = text.match(/\b(worker|customer|agent|supplier|other)\b/i);
        const contactType = (intent.design && /^(worker|customer|agent|supplier|other)$/i.test(intent.design)) ? intent.design : (typeMatch ? typeMatch[1] : 'other');
        const phoneMatch = text.match(/phone\s*[:\s]*([+\d\s\-]+)/i) || text.match(/(\+\d[\d\s\-]+)/);
        const phone = phoneMatch ? phoneMatch[1].trim() : '';
        const addressMatch = text.match(/address\s*[:\s]*([^,]+)/i);
        const address = addressMatch ? addressMatch[1].trim() : '';
        const notesMatch = text.match(/notes?\s*[:\s]*([^,]+)/i);
        const notes = notesMatch ? notesMatch[1].trim() : '';
        if (!name) {
          await bot.sendMessage(chatId, 'Please provide contact name and type. Example: "Add contact Ibrahim, worker, phone +2348012345678, address Kano".');
          return;
        }
        const actionJSON = { action: 'add_contact', name, phone, type: contactType, address, notes };
        const summary = `Add contact: ${name} (${contactType})${phone ? ', ' + phone : ''}${address ? ', ' + address : ''}`;
        const addContactQueued = await requireApproval(bot, chatId, msg, userId, 'add_contact', actionJSON, summary);
        if (addContactQueued) return;
        const contactsRepo = require('../repositories/contactsRepository');
        await contactsRepo.append({ name, phone, type: contactType, address, notes });
        await bot.sendMessage(chatId, `✅ Contact added: ${name} (${contactType})${phone ? ', ' + phone : ''}.`);
        return;
      }

      case 'list_contacts': {
        const contactsRepo = require('../repositories/contactsRepository');
        const filterType = intent.design && /^(worker|customer|agent|supplier|other)$/i.test(intent.design) ? intent.design : null;
        const list = filterType ? await contactsRepo.getByType(filterType) : await contactsRepo.getAll();
        if (!list.length) {
          await bot.sendMessage(chatId, filterType ? `No ${filterType} contacts.` : 'Phonebook is empty.');
          return;
        }
        let out = filterType ? `📇 *${filterType} contacts*\n\n` : '📇 *Phonebook*\n\n';
        list.slice(0, 30).forEach((c) => { out += `${c.name} (${c.type})${c.phone ? ' — ' + c.phone : ''}\n`; });
        if (list.length > 30) out += `\n... and ${list.length - 30} more.`;
        await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
        return;
      }

      case 'search_contact': {
        const q = intent.customer || text.replace(/find|in phonebook|search/gi, '').trim();
        if (!q) {
          await bot.sendMessage(chatId, 'Who do you want to find? Example: "Find Ibrahim in phonebook".');
          return;
        }
        const contactsRepo = require('../repositories/contactsRepository');
        const found = await contactsRepo.searchByName(q);
        if (!found.length) {
          await bot.sendMessage(chatId, `No contact found for "${q}".`);
          return;
        }
        let out = `📇 *Contacts matching "${q}"*\n\n`;
        found.forEach((c) => { out += `${c.name} — ${c.type}${c.phone ? ', ' + c.phone : ''}${c.address ? ', ' + c.address : ''}\n`; });
        await bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });
        return;
      }

      case 'mark_task_done': {
        const taskId = intent.taskId || (text.match(/TASK-\d{8}-\d{3}/) || [])[0];
        if (!taskId) {
          await bot.sendMessage(chatId, 'Please specify task ID. Example: "Mark task TASK-20260224-001 done".');
          return;
        }
        const tasksRepo = require('../repositories/tasksRepository');
        const task = await tasksRepo.getById(taskId);
        if (!task) {
          await bot.sendMessage(chatId, `Task ${taskId} not found.`);
          return;
        }
        if (task.assigned_to !== userId) {
          await bot.sendMessage(chatId, 'You can only mark your own tasks as done.');
          return;
        }
        if (task.status === 'completed') {
          await bot.sendMessage(chatId, 'This task is already completed.');
          return;
        }
        await tasksRepo.updateStatus(taskId, 'submitted', new Date().toISOString());
        const requesterName = await getRequesterDisplayName(userId, msg);
        const esc = (s) => (s || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
        const notifText = `📋 *Task submitted for approval*\n\nTask: ${esc(task.title)}\nID: \`${taskId}\`\nMarked done by: ${esc(requesterName)}\n\nApprove to mark as complete for the employee\\.`;
        const keyboard = { inline_keyboard: [[{ text: '✅ Approve completion', callback_data: `approve_task:${taskId}` }]] };
        for (const adminId of config.access.adminIds) {
          try {
            await bot.sendMessage(adminId, notifText, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
          } catch (e) {
            try { await bot.sendMessage(adminId, `Task submitted: ${task.title} (${taskId}) by ${requesterName}. Approve completion?`, { reply_markup: keyboard }); } catch (_) {}
          }
        }
        await bot.sendMessage(chatId, `⏳ Task "${task.title}" submitted for admin approval. You'll be notified when it's approved.`);
        return;
      }

      case 'give_sample': {
        if (!intent.design) {
          await bot.sendMessage(chatId, 'Which design? e.g. "Give sample of 44200 Shade 3 to CJE"');
          return;
        }
        sessionStore.set(userId, {
          type: 'sample_flow', step: 'customer', design: intent.design, shade: intent.shade || '',
          requestedBy: userId,
        });
        if (intent.customer) {
          const session = sessionStore.get(userId);
          session.customer = intent.customer;
          session.step = 'type';
          sessionStore.set(userId, session);
          await bot.sendMessage(chatId, `Design: *${intent.design}*${intent.shade ? ' Shade ' + intent.shade : ''}\nCustomer: *${intent.customer}*\n\nSelect sample type:`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[
              { text: 'Type A', callback_data: 'smpt:A' },
              { text: 'Type B', callback_data: 'smpt:B' },
              { text: 'Type C', callback_data: 'smpt:C' },
            ]] },
          });
        } else {
          const pastCustomers = await transactionsRepo.getCustomersByDesign(intent.design);
          let customerNames = pastCustomers;
          if (!customerNames.length) {
            const customersRepo = require('../repositories/customersRepository');
            const allCust = await customersRepo.getAll();
            customerNames = allCust.filter((c) => c.status === 'Active' && c.name).map((c) => c.name);
          }
          const rows = [];
          for (let i = 0; i < customerNames.length; i += 2) {
            const row = [{ text: customerNames[i], callback_data: `smpc:${customerNames[i].slice(0, 50)}` }];
            if (customerNames[i + 1]) row.push({ text: customerNames[i + 1], callback_data: `smpc:${customerNames[i + 1].slice(0, 50)}` });
            rows.push(row);
          }
          if (rows.length > 20) rows.splice(20);
          rows.push([{ text: '➕ New customer', callback_data: 'smpc:__new__' }]);
          await bot.sendMessage(chatId, `Design: *${intent.design}*${intent.shade ? ' Shade ' + intent.shade : ''}\n\nSelect customer:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
        }
        return;
      }

      case 'return_sample': {
        const sid = intent.sampleId || (text.match(/SMP-\d{8}-\d{3}/) || [])[0];
        if (!sid) { await bot.sendMessage(chatId, 'Which sample? e.g. "Sample SMP-20260221-001 returned"'); return; }
        const sample = await samplesRepo.getById(sid);
        if (!sample) { await bot.sendMessage(chatId, `Sample ${sid} not found.`); return; }
        if (sample.status !== 'with_customer') { await bot.sendMessage(chatId, `Sample ${sid} status is already: ${sample.status}`); return; }
        await samplesRepo.updateStatus(sid, 'returned', userId);
        await bot.sendMessage(chatId, `✅ Sample *${sid}* marked as returned.\n\nDesign: ${sample.design}${sample.shade ? ' Shade ' + sample.shade : ''}\nCustomer: ${sample.customer}\nType: ${sample.sample_type}`, { parse_mode: 'Markdown' });
        return;
      }

      case 'update_sample': {
        const sid = intent.sampleId || (text.match(/SMP-\d{8}-\d{3}/) || [])[0];
        if (!sid) { await bot.sendMessage(chatId, 'Which sample? e.g. "Sample SMP-xxx lost" or "Sample SMP-xxx converted"'); return; }
        const sample = await samplesRepo.getById(sid);
        if (!sample) { await bot.sendMessage(chatId, `Sample ${sid} not found.`); return; }
        if (sample.status !== 'with_customer') { await bot.sendMessage(chatId, `Sample ${sid} status is already: ${sample.status}`); return; }
        const lowerText = text.toLowerCase();
        let newStatus = 'with_customer';
        if (lowerText.includes('lost')) newStatus = 'lost';
        else if (lowerText.includes('convert')) newStatus = 'converted_to_order';
        else {
          await bot.sendMessage(chatId, `What status? Say "${sid} lost" or "${sid} converted".`);
          return;
        }
        await samplesRepo.updateStatus(sid, newStatus, userId);
        await bot.sendMessage(chatId, `✅ Sample *${sid}* marked as *${newStatus}*.\n\nDesign: ${sample.design}${sample.shade ? ' Shade ' + sample.shade : ''}\nCustomer: ${sample.customer}`, { parse_mode: 'Markdown' });
        return;
      }

      case 'sample_status': {
        if (!config.access.adminIds.includes(userId)) {
          await bot.sendMessage(chatId, 'Sample status report is admin-only.');
          return;
        }
        let samples;
        let title;
        if (intent.design) {
          samples = await samplesRepo.getByDesign(intent.design);
          samples = samples.filter((s) => s.status === 'with_customer');
          title = `📋 *Sample Status — Design ${intent.design}*`;
        } else {
          samples = await samplesRepo.getActive();
          title = '📋 *Sample Status — All Active*';
        }
        const report = buildSampleStatusReport(samples, title);
        await sendLong(bot, chatId, report, { parse_mode: 'Markdown' });
        return;
      }

      case 'customer_history': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'Which customer? e.g. "Customer history CJE"'); return; }
        const events = await buildCustomerTimeline(intent.customer);
        if (!events.length) { await bot.sendMessage(chatId, `No interaction history found for "${intent.customer}".`); return; }
        const lastAgo = events[0].date ? Math.floor((Date.now() - new Date(events[0].date).getTime()) / 86400000) : '?';
        let out = `📋 *Customer Timeline — ${intent.customer}*\n_Last activity: ${lastAgo} days ago_\n\n`;
        const shown = events.slice(0, 20);
        for (const e of shown) {
          const icon = e.type.startsWith('Sale') ? '💰' : e.type.startsWith('Payment') ? '💳' : e.type.startsWith('Order') ? '📦' : e.type.startsWith('Sample') ? '🧪' : '📌';
          out += `${icon} *${e.date || '-'}* — ${e.type}\n   ${e.detail}\n\n`;
        }
        if (events.length > 20) out += `_... and ${events.length - 20} more interactions_\n`;
        out += `*Total: ${events.length} interactions*`;
        await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
        return;
      }

      case 'customer_ranking': {
        if (!config.access.adminIds.includes(userId)) { await bot.sendMessage(chatId, 'Customer ranking is admin-only.'); return; }
        const ranked = await buildCustomerRanking();
        if (!ranked.length) { await bot.sendMessage(chatId, 'No sales data found.'); return; }
        let out = `🏆 *Customer Ranking — Top ${Math.min(ranked.length, 20)} by Value*\n\n`;
        let rank = 0;
        const medals = ['🥇', '🥈', '🥉'];
        for (const [name, c] of ranked.slice(0, 20)) {
          const medal = rank < 3 ? medals[rank] : `${rank + 1}.`;
          const daysAgo = c.lastDate ? Math.floor((Date.now() - new Date(c.lastDate).getTime()) / 86400000) : '?';
          out += `${medal} *${name}*\n`;
          out += `   ${c.pkgs.size} pkgs, ${c.thans} thans, ${fmtQty(c.yards)} yds\n`;
          out += `   Value: ${fmtMoney(c.value)} | Last: ${daysAgo}d ago\n`;
          out += `   ${fmtBar(c.value, ranked[0][1].value)}\n\n`;
          rank++;
        }
        const grandValue = ranked.reduce((s, [, c]) => s + c.value, 0);
        out += `*Total Customers: ${ranked.length} | Total Value: ${fmtMoney(grandValue)}*`;
        await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
        return;
      }

      case 'customer_pattern': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'Which customer? e.g. "What does CJE buy"'); return; }
        const pattern = await buildCustomerPattern(intent.customer);
        if (!pattern) { await bot.sendMessage(chatId, `No purchase data found for "${intent.customer}".`); return; }
        let out = `🔍 *Purchase Pattern — ${intent.customer}*\n\n`;
        out += `📅 First purchase: ${pattern.firstDate} | Last: ${pattern.lastDate}\n`;
        out += `📊 Lifetime: ${pattern.totalPkgs} pkgs, ${pattern.totalThans} thans, ${fmtQty(pattern.totalYards)} yds — ${fmtMoney(pattern.totalValue)}\n\n`;
        out += `*Preferred Items (by value):*\n`;
        let rank = 0;
        for (const ds of pattern.items) {
          rank++;
          const pct = Math.round((ds.value / pattern.totalValue) * 100);
          out += `${rank}. ${ds.design} Shade ${ds.shade}: ${ds.pkgs.size} pkgs, ${fmtQty(ds.yards)} yds — ${fmtMoney(ds.value)} (${pct}%)\n`;
        }
        out += `\n*Top design: ${pattern.items[0].design} Shade ${pattern.items[0].shade} (${Math.round((pattern.items[0].value / pattern.totalValue) * 100)}% of total)*`;
        await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
        return;
      }

      case 'add_followup': {
        if (!config.access.adminIds.includes(userId)) { await bot.sendMessage(chatId, 'Only admin can schedule follow-ups.'); return; }
        if (!intent.customer) { await bot.sendMessage(chatId, 'Which customer? e.g. "Follow up with CJE on 28-02-2026 about payment"'); return; }
        const fDate = intent.salesDate ? parseLedgerDate(intent.salesDate) : null;
        if (!fDate) { await bot.sendMessage(chatId, 'Please include a date. e.g. "Follow up with CJE on 28-02-2026 about pending payment"'); return; }
        const reasonMatch = text.match(/\b(?:about|for|regarding|re)\s+(.+)/i);
        const reason = reasonMatch ? reasonMatch[1].trim() : text.replace(/follow\s*up\s*(with)?\s*/i, '').replace(intent.customer, '').replace(intent.salesDate || '', '').replace(/on\s*/i, '').trim() || 'General follow-up';
        const saved = await customerFollowupsRepo.append({ customer: intent.customer, reason, followup_date: fDate, created_by: userId });
        await bot.sendMessage(chatId, `✅ Follow-up scheduled: *${saved.followup_id}*\n\nCustomer: ${intent.customer}\nDate: ${fDate}\nReason: ${reason}\n\nYou'll be reminded on ${fDate}.`, { parse_mode: 'Markdown' });
        return;
      }

      case 'add_customer_note': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'Which customer? e.g. "Note for CJE: wants bulk discount"'); return; }
        const noteText = text.replace(/^note\s*(for)?\s*/i, '').replace(new RegExp(intent.customer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').replace(/^[\s:]+/, '').trim();
        if (!noteText) { await bot.sendMessage(chatId, 'What is the note? e.g. "Note for CJE: prefers Shade 3"'); return; }
        const saved = await customerNotesRepo.append({ customer: intent.customer, note: noteText, created_by: userId });
        await bot.sendMessage(chatId, `✅ Note saved for *${intent.customer}*: ${noteText}`, { parse_mode: 'Markdown' });
        return;
      }

      case 'show_customer_notes': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'Which customer? e.g. "Show notes for CJE"'); return; }
        const notes = await customerNotesRepo.getByCustomer(intent.customer);
        if (!notes.length) { await bot.sendMessage(chatId, `No notes found for "${intent.customer}". Add with: "Note for ${intent.customer}: your note here"`); return; }
        let out = `📝 *Notes for ${intent.customer}* (${notes.length})\n\n`;
        for (const n of notes.slice(-15)) {
          out += `• ${n.created_at?.slice(0, 10) || '-'}: ${n.note}\n`;
        }
        if (notes.length > 15) out += `\n_Showing last 15 of ${notes.length} notes_`;
        await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
        return;
      }

      case 'upload_receipt': {
        await startReceiptFlow(bot, chatId, userId);
        return;
      }

      case 'inventory_details': {
        if (!config.access.adminIds.includes(userId)) {
          await bot.sendMessage(chatId, 'Inventory details is admin-only.');
          return;
        }
        await bot.sendMessage(chatId, '📦 *Inventory Details*\n\nSelect view:', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: '🏭 Warehouse wise', callback_data: 'inv:wh' }],
            [{ text: '📦 Design wise', callback_data: 'inv:design' }],
          ] },
        });
        return;
      }

      case 'sales_report_interactive': {
        if (!config.access.adminIds.includes(userId)) {
          await bot.sendMessage(chatId, 'Sales report is admin-only.');
          return;
        }
        await bot.sendMessage(chatId, '📊 *Sales Report*\n\nSelect period:', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: '📅 Weekly (7 days)', callback_data: 'sr:7' }, { text: '📅 Monthly (30 days)', callback_data: 'sr:30' }],
            [{ text: '📅 Quarterly (90 days)', callback_data: 'sr:90' }, { text: '📅 Yearly (365 days)', callback_data: 'sr:365' }],
          ] },
        });
        return;
      }

      case 'supply_details': {
        if (!config.access.adminIds.includes(userId)) {
          await bot.sendMessage(chatId, 'Supply details is admin-only.');
          return;
        }
        await bot.sendMessage(chatId, '📊 *Supply Details*\n\nSelect view:', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: '📦 Design / Product wise', callback_data: 'sd:design' }],
            [{ text: '👤 Customer wise', callback_data: 'sd:customer' }],
            [{ text: '🏭 Warehouse wise', callback_data: 'sd:warehouse' }],
          ] },
        });
        return;
      }

      case 'create_order': {
        if (!config.access.adminIds.includes(userId)) {
          await bot.sendMessage(chatId, 'Only admin can create orders.');
          return;
        }
        await startOrderFlow(bot, chatId, userId);
        return;
      }

      case 'my_orders': {
        const orders = await ordersRepo.getByAssignee(userId);
        if (!orders.length) {
          await bot.sendMessage(chatId, 'You have no pending supply orders.');
          return;
        }
        let out = '📋 *Your Supply Orders*\n\n';
        for (const o of orders) {
          const icon = o.status === 'accepted' ? '✅' : '⏳';
          out += `${icon} *${o.order_id}*\n  Design: ${o.design} | Customer: ${o.customer}\n  Qty: ${o.quantity} | Date: ${o.scheduled_date}\n  Payment: ${o.payment_status} | Status: ${o.status}\n\n`;
        }
        const accepted = orders.filter((o) => o.status === 'accepted');
        if (accepted.length) {
          out += `To mark delivered: "Mark order ${accepted[0].order_id} delivered"`;
        }
        await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
        return;
      }

      case 'mark_order_delivered': {
        const oid = intent.orderId || (text.match(/ORD-\d{8}-\d{3}/) || [])[0];
        if (!oid) {
          await bot.sendMessage(chatId, 'Please specify order ID. Example: "Mark order ORD-20260221-001 delivered".');
          return;
        }
        const order = await ordersRepo.getById(oid);
        if (!order) {
          await bot.sendMessage(chatId, `Order ${oid} not found.`);
          return;
        }
        if (order.salesperson_id !== userId) {
          await bot.sendMessage(chatId, 'You can only mark your own assigned orders as delivered.');
          return;
        }
        if (order.status === 'delivered') {
          await bot.sendMessage(chatId, `Order ${oid} is already marked as delivered.`);
          return;
        }
        if (order.status !== 'accepted') {
          await bot.sendMessage(chatId, `Order ${oid} must be accepted before it can be marked delivered. Current status: ${order.status}`);
          return;
        }
        await ordersRepo.updateStatus(oid, 'delivered', { delivered_at: new Date().toISOString() });
        await bot.sendMessage(chatId, `✅ Order ${oid} marked as delivered.`);
        for (const adminId of config.access.adminIds) {
          try {
            await bot.sendMessage(adminId, `📦 Order *${oid}* has been delivered.\n\nDesign: ${order.design}\nCustomer: ${order.customer}\nQty: ${order.quantity}\nDelivered by: ${order.salesperson_name}`, { parse_mode: 'Markdown' });
          } catch (_) {}
        }
        return;
      }

      default: {
        await bot.sendMessage(chatId, helpText());
      }
    }
  } catch (err) {
    await bot.sendMessage(chatId, `Error: ${err.message || 'Something went wrong. Please try again.'}`);
  }
}

function helpText() {
  return `Here's what I can do:

*Inventory:*
📦 "How much 44200 BLACK do we have?"
📋 "Show packages for design 44200"
🔍 "Details of package 5801"
💰 "Sell than 3 from package 5801 to Ibrahim, salesperson Abdul, cash, date today"
📦 "Sell package 5802 to Adamu, salesperson Yarima, via GTBank"
📦 "Sell packages 5801, 5802 to Ibrahim, salesperson Abdul, cash"
↩️ "Return than 2 from package 5801"
🔄 "Transfer package 5801 to Kano"
🔄 "Transfer packages 5801, 5802 to Kano"
🔄 "Transfer than 3 from package 5801 to Kano"
💲 "Update price of 44200 BLACK to 1500"
📊 "Analyze stock"

*Reports:*
📦 "Stock summary" / "Stock valuation"
📊 "Sales report today" / "Sales this week"
👥 "Customer report" / "Top customers"
🏭 "Warehouse summary" / "Compare warehouses"
🔥 "Fast moving designs" / "Dead stock"
📋 "Indent status" / "Low stock alert"
📅 "Aging stock"
🔍 Ask anything: "Show all buyers of 44200 in descending order"

*CRM:*
👤 "Add customer Ibrahim, phone +234..., wholesale"
🔍 "Show customer Ibrahim"
💰 "Record payment 50000 from Ibrahim via bank"
💳 "What is Ibrahim's outstanding?"

*Accounting (admin):*
📒 "Show ledger for today"
📊 "Show trial balance"
🏦 "Add bank GTBank" / "List banks" (admin)

*Customer CRM:*
📋 "Customer history CJE" — Full interaction timeline
🏆 "Customer ranking" — Top customers by value
🔍 "What does CJE buy" — Purchase patterns
📅 "Follow up with CJE on 28-02-2026 about payment"
📝 "Note for CJE: wants bulk discount"
📝 "Show notes for CJE"

*Samples:*
🧪 "Give sample of 44200 Shade 3 to CJE" — Submit sample request
↩️ "Sample SMP-xxx returned" — Mark returned
📋 "Sample status" — Active samples report (admin)

*Inventory & Sales (admin):*
📦 "Inventory details" — Warehouse / Design wise stock with balance
📊 "Sales report" — Period + Design / Customer wise sales

*Supply Details (admin):*
📊 "Supply details" — Design / Customer / Warehouse wise sold reports

*Supply Orders (admin):*
📦 "Create order" — Guided order creation
📋 "My orders" — View assigned orders (employee)
✅ "Mark order ORD-xxx delivered" — Mark as delivered

*Receipts:*
🧾 "Upload receipt" — Upload payment receipt (guided flow)

*Ledger commands (admin, Ledger_Customers):*
/addledgercustomer <name> [phone] [credit_limit]
/ledger <customer_id> — Customer ledger (paginated)
/balance <customer_id> — Current balance
/payment <customer_id> <amount> — Record payment`;
}

/**
 * Start a sale flow: collect all required fields, then show summary for confirmation.
 */
async function startSaleFlow(bot, chatId, msg, userId, saleType, items, intent) {
  salesFlow.startSession(userId, saleType, items, intent);
  const session = salesFlow.getSession(userId);
  const missing = salesFlow.getMissingFields(session.collected);

  if (!missing.length) {
    session.awaitingDocument = true;
    session.pendingField = null;
    sessionStore.set(userId, session);
    await bot.sendMessage(chatId, '📎 Please send the *sales bill photo or PDF* to attach with this sale.', { parse_mode: 'Markdown' });
    return;
  }

  const payOpts = await salesFlow.getPaymentOptions();
  session.pendingField = missing[0];
  sessionStore.set(userId, session);
  await bot.sendMessage(chatId, salesFlow.getNextQuestion(missing[0], payOpts));
}

/**
 * Handle responses during an active sale flow session.
 */
async function handleSaleSession(bot, chatId, msg, userId, text, session) {
  if (text.toLowerCase() === 'cancel') {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, 'Sale cancelled.');
    return true;
  }

  if (session.awaitingDocument) {
    await bot.sendMessage(chatId, '📎 Please send a *photo* or *PDF document* of the sales bill. Type "cancel" to abort.', { parse_mode: 'Markdown' });
    return true;
  }

  if (!session.pendingField) return false;

  if (session.pendingNewCustomer) {
    if (session.pendingField === 'new_customer_name') {
      session.collected.newCustomerName = text.trim();
      session.pendingField = 'new_customer_phone';
      sessionStore.set(userId, session);
      await bot.sendMessage(chatId, 'Phone number?');
      return true;
    }
    if (session.pendingField === 'new_customer_phone') {
      session.collected.newCustomerPhone = text.trim();
      session.pendingField = 'new_customer_address';
      sessionStore.set(userId, session);
      await bot.sendMessage(chatId, 'Address? (or type Skip)');
      return true;
    }
    if (session.pendingField === 'new_customer_address') {
      session.collected.newCustomerAddress = text.trim().toLowerCase() === 'skip' ? '' : text.trim();
      const name = session.collected.newCustomerName;
      try {
        await crmService.addCustomer({
          name,
          phone: session.collected.newCustomerPhone || '',
          address: session.collected.newCustomerAddress || '',
          category: 'Retail',
          credit_limit: 0,
          payment_terms: 'COD',
        });
      } catch (e) {
        await bot.sendMessage(chatId, `Could not add customer: ${e.message}. Try again or use existing customer.`);
        return true;
      }
      session.collected.customer = name;
      delete session.collected.newCustomerName;
      delete session.collected.newCustomerPhone;
      delete session.collected.newCustomerAddress;
      session.pendingNewCustomer = false;
      session.pendingField = null;
      const missing = salesFlow.getMissingFields(session.collected);
      if (missing.length) {
        const payOpts = await salesFlow.getPaymentOptions();
        session.pendingField = missing[0];
        sessionStore.set(userId, session);
        await bot.sendMessage(chatId, `✅ Customer "${name}" added.\n\n${salesFlow.getNextQuestion(missing[0], payOpts)}`);
        return true;
      }
      session.awaitingDocument = true;
      sessionStore.set(userId, session);
      await bot.sendMessage(chatId, `✅ Customer "${name}" added.\n\n📎 Please send the *sales bill photo or PDF* to attach with this sale.`, { parse_mode: 'Markdown' });
      return true;
    }
  }

  const validation = await salesFlow.validateField(session.pendingField, text);
  if (!validation.valid) {
    if (validation.message === '__NEW_CUSTOMER__') {
      session.pendingNewCustomer = true;
      session.pendingField = 'new_customer_name';
      sessionStore.set(userId, session);
      await bot.sendMessage(chatId, 'Enter new customer full name.');
      return true;
    }
    await bot.sendMessage(chatId, validation.message);
    return true;
  }

  session.collected[session.pendingField] = validation.value;
  session.pendingField = null;
  const missing = salesFlow.getMissingFields(session.collected);

  if (missing.length) {
    const payOpts = await salesFlow.getPaymentOptions();
    session.pendingField = missing[0];
    sessionStore.set(userId, session);
    await bot.sendMessage(chatId, salesFlow.getNextQuestion(missing[0], payOpts));
    return true;
  }

  session.awaitingDocument = true;
  sessionStore.set(userId, session);
  await bot.sendMessage(chatId, '📎 Please send the *sales bill photo or PDF* to attach with this sale.', { parse_mode: 'Markdown' });
  return true;
}

/**
 * Execute a confirmed sale: if admin, execute directly in batch.
 * If employee, create ONE consolidated approval request for the entire sale.
 */
async function executeSale(bot, chatId, userId) {
  const session = salesFlow.getSession(userId);
  if (!session) return;
  const details = salesFlow.getSaleDetails(session);
  const sDate = details.salesDate || new Date().toISOString().split('T')[0];

  const risk = await riskEvaluate.evaluate({ action: 'sell_batch', userId });

  if (risk.risk === 'approval_required') {
    // Create ONE approval request for the entire sale
    const requestId = genId();
    let detailText = `Sale Request\nCustomer: ${session.collected.customer}`;
    try {
      const cust = await crmService.getCustomer(session.collected.customer);
      if (cust && (cust.phone || cust.address)) {
        if (cust.phone) detailText += `\nPhone: ${cust.phone}`;
        if (cust.address) detailText += `\nAddress: ${cust.address}`;
      }
    } catch (_) {}
    detailText += `\nSalesperson: ${details.salesPerson}\nPayment: ${details.paymentMode}\nDate: ${sDate}\n\nItems:\n`;
    let totalYards = 0, totalThans = 0;
    for (const item of session.items) {
      const info = await inventoryService.getPackageSummary(item.packageNo);
      if (item.type === 'package' && info) {
        detailText += `  Pkg ${item.packageNo}: ${info.design} ${info.shade}, ${info.availableThans} thans, ${fmtQty(info.availableYards)} yds (${info.warehouse})\n`;
        totalThans += info.availableThans;
        totalYards += info.availableYards;
      } else if (item.type === 'than' && info) {
        const t = info.thans?.find((th) => th.thanNo === item.thanNo);
        detailText += `  Pkg ${item.packageNo} Than ${item.thanNo}: ${info.design} ${info.shade}, ${t ? fmtQty(t.yards) + ' yds' : '?'} (${info.warehouse})\n`;
        totalThans += 1;
        totalYards += t ? t.yards : 0;
      }
    }
    const totalPkgs = new Set(session.items.map((i) => i.packageNo)).size;
    detailText += `\nTotal: ${totalPkgs} packages (${totalThans} thans), ${fmtQty(totalYards)} yards`;

    const saleDocInfo = session.sale_doc_file_id
      ? { sale_doc_file_id: session.sale_doc_file_id, sale_doc_type: session.sale_doc_type, sale_doc_mime: session.sale_doc_mime }
      : {};
    await approvalQueueRepository.append({
      requestId, user: userId,
      actionJSON: { action: 'sale_bundle', items: session.items, customer: session.collected.customer, salesDate: sDate, salesPerson: details.salesPerson, paymentMode: details.paymentMode, ...saleDocInfo },
      riskReason: risk.reason, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);

    const userLabel = await getRequesterDisplayName(userId, null);
    if (session.sale_doc_file_id) detailText += '\n📎 Sales bill attached (see below)';
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, detailText, risk.reason);
    if (session.sale_doc_file_id) {
      for (const adminId of config.access.adminIds) {
        try {
          if (session.sale_doc_type === 'document') {
            await bot.sendDocument(adminId, session.sale_doc_file_id, { caption: `📄 Sales bill for request ${requestId}` });
          } else {
            await bot.sendPhoto(adminId, session.sale_doc_file_id, { caption: `📷 Sales bill for request ${requestId}` });
          }
        } catch (e) { logger.error(`Failed to send sale doc to admin ${adminId}`, e.message); }
      }
    }
    await bot.sendMessage(chatId, `⏳ Sale submitted for admin approval. Request: ${requestId}\n${totalPkgs} packages (${totalThans} thans), ${fmtQty(totalYards)} yards to ${session.collected.customer}`);
    sessionStore.clear(userId);
    return;
  }

  // Admin: execute all items directly in sequence
  let soldThans = 0, totalYards = 0;
  const soldPkgs = new Set();
  for (const item of session.items) {
    if (item.type === 'package') {
      const result = await inventoryService.sellPackage(item.packageNo, session.collected.customer, userId, sDate);
      if (result.status === 'completed') { soldThans += result.soldThans; totalYards += result.soldYards; soldPkgs.add(item.packageNo); }
    } else if (item.type === 'than') {
      const result = await inventoryService.sellThan(item.packageNo, item.thanNo, session.collected.customer, userId, sDate);
      if (result.status === 'completed') { soldThans += 1; totalYards += result.than?.yards || 0; soldPkgs.add(item.packageNo); }
    }
  }
  let saleMsg = `✅ Sale complete: ${soldPkgs.size} packages (${soldThans} thans), ${fmtQty(totalYards)} yards to ${session.collected.customer}`;
  if (session.sale_doc_file_id) {
    try {
      const { buffer, filePath } = await downloadTelegramFile(bot, session.sale_doc_file_id);
      const ext = filePath.split('.').pop() || (session.sale_doc_type === 'document' ? 'pdf' : 'jpg');
      const customer = (session.collected.customer || 'unknown').replace(/\s+/g, '_');
      const fileName = `sale_bill_${customer}_${new Date().toISOString().slice(0, 10)}.${ext}`;
      const mimeType = session.sale_doc_type === 'document' ? 'application/pdf' : 'image/jpeg';
      const driveRes = await driveClient.uploadFile(buffer, fileName, mimeType);
      saleMsg += `\n📎 [View Sales Bill](${driveRes.webViewLink})`;
    } catch (e) { logger.error('Failed to upload sale doc to Drive (admin direct)', e.message); }
  }
  await bot.sendMessage(chatId, saleMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
  sessionStore.clear(userId);
}

/** Start the order creation flow — show available designs as inline buttons. */
async function startOrderFlow(bot, chatId, userId) {
  const designs = await inventoryRepository.getDistinctDesigns();
  const designNums = [...new Set(designs.map((d) => d.design.trim()).filter(Boolean))].sort();
  if (!designNums.length) {
    await bot.sendMessage(chatId, 'No designs available in inventory.');
    return;
  }
  sessionStore.set(userId, { type: 'order_flow', step: 'design', createdBy: userId });
  const rows = [];
  for (let i = 0; i < designNums.length; i += 3) {
    const row = [];
    for (let j = i; j < i + 3 && j < designNums.length; j++) {
      row.push({ text: designNums[j], callback_data: `od:${designNums[j].slice(0, 50)}` });
    }
    rows.push(row);
  }
  if (rows.length > 30) rows.splice(30);
  await bot.sendMessage(chatId, '📦 *Create Supply Order*\n\nSelect a design:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function handleCallbackQuery(bot, callbackQuery) {
  const data = (callbackQuery.data || '').trim();
  if (data.startsWith('approve:')) {
    await approvalEvents.handleApprovalCallback(bot, callbackQuery, 'approve');
  } else if (data.startsWith('reject:')) {
    await approvalEvents.handleApprovalCallback(bot, callbackQuery, 'reject');
  } else if (data.startsWith('confirm_sale:')) {
    const saleUserId = data.replace('confirm_sale:', '');
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Processing sale...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id,
    });
    await executeSale(bot, callbackQuery.message.chat.id, saleUserId);
  } else if (data.startsWith('cancel_sale:')) {
    const cancelUserId = data.replace('cancel_sale:', '');
    sessionStore.clear(cancelUserId);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled.' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id,
    });
    await bot.sendMessage(callbackQuery.message.chat.id, 'Sale cancelled.');
  } else if (data.startsWith('approve_task:')) {
    const taskId = data.replace('approve_task:', '');
    const adminId = String(callbackQuery.from.id);
    if (!config.access.adminIds.includes(adminId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only admins can approve task completion.' });
      return;
    }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Approving...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id,
    });
    const tasksRepo = require('../repositories/tasksRepository');
    const task = await tasksRepo.getById(taskId);
    if (!task) {
      await bot.sendMessage(callbackQuery.message.chat.id, `Task ${taskId} not found.`);
      return;
    }
    await tasksRepo.updateStatus(taskId, 'completed', new Date().toISOString());
    let employeeNotified = false;
    try {
      await bot.sendMessage(task.assigned_to, `✅ Your task "${task.title}" (${taskId}) has been approved by admin and marked complete.`);
      employeeNotified = true;
    } catch (notifErr) {
      const logger = require('../utils/logger');
      logger.error(`Failed to notify employee ${task.assigned_to} about task ${taskId} approval`, notifErr.message);
    }
    await bot.sendMessage(callbackQuery.message.chat.id, employeeNotified
      ? `✅ Task "${task.title}" (${taskId}) marked complete. Employee has been notified.`
      : `✅ Task "${task.title}" (${taskId}) marked complete. ⚠️ Could not notify the employee — please inform them manually.`);
  } else if (data.startsWith('inv:')) {
    const view = data.slice(4);
    const uid = String(callbackQuery.from.id);
    if (!config.access.adminIds.includes(uid)) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Generating...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    try {
      const allItems = await inventoryRepository.getAll();
      if (!allItems.length) { await bot.sendMessage(callbackQuery.message.chat.id, 'No inventory data found.'); return; }
      const report = view === 'wh' ? buildInventoryWarehouseReport(allItems) : buildInventoryDesignReport(allItems);
      await sendLong(bot, callbackQuery.message.chat.id, report, { parse_mode: 'Markdown' });
    } catch (e) {
      logger.error('Inventory details error', e);
      await bot.sendMessage(callbackQuery.message.chat.id, `Report error: ${e.message}`);
    }

  } else if (data.startsWith('sr:')) {
    const days = parseInt(data.slice(3));
    const uid = String(callbackQuery.from.id);
    if (!config.access.adminIds.includes(uid)) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    sessionStore.set(uid, { type: 'sales_report_period', days });
    const labels = { 7: 'Weekly', 30: 'Monthly', 90: 'Quarterly', 365: 'Yearly' };
    const periodLabel = labels[days] || `Last ${days} days`;
    await bot.sendMessage(callbackQuery.message.chat.id, `📊 *${periodLabel} Sales Report*\n\nGroup by:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '📦 Design wise', callback_data: 'srg:design' }],
        [{ text: '👤 Customer wise', callback_data: 'srg:customer' }],
      ] },
    });

  } else if (data.startsWith('srg:')) {
    const groupBy = data.slice(4);
    const uid = String(callbackQuery.from.id);
    if (!config.access.adminIds.includes(uid)) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' }); return; }
    const session = sessionStore.get(uid);
    const days = (session && session.type === 'sales_report_period') ? session.days : 30;
    sessionStore.clear(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Generating...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    try {
      const allItems = await inventoryRepository.getAll();
      const sold = allItems.filter((r) => r.status === 'sold' && r.soldTo && r.soldDate);
      const filtered = filterSoldByPeriod(sold, days);
      const labels = { 7: 'Last 7 Days', 30: 'Last 30 Days', 90: 'Last 90 Days', 365: 'Last 365 Days' };
      const periodLabel = labels[days] || `Last ${days} Days`;
      const report = groupBy === 'design' ? buildSalesDesignReport(filtered, periodLabel) : buildSalesCustomerReport(filtered, periodLabel);
      await sendLong(bot, callbackQuery.message.chat.id, report, { parse_mode: 'Markdown' });
    } catch (e) {
      logger.error('Sales report error', e);
      await bot.sendMessage(callbackQuery.message.chat.id, `Report error: ${e.message}`);
    }

  } else if (data.startsWith('smpc:')) {
    const val = data.slice(5);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'sample_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    if (val === '__new__') {
      session.step = 'customer_new';
      sessionStore.set(uid, session);
      await bot.sendMessage(callbackQuery.message.chat.id, 'Enter new customer name:');
    } else {
      session.customer = val;
      session.step = 'type';
      sessionStore.set(uid, session);
      await bot.sendMessage(callbackQuery.message.chat.id, `Customer: *${val}*\n\nSelect sample type:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: 'Type A', callback_data: 'smpt:A' },
          { text: 'Type B', callback_data: 'smpt:B' },
          { text: 'Type C', callback_data: 'smpt:C' },
        ]] },
      });
    }

  } else if (data.startsWith('smpt:')) {
    const sType = data.slice(5);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'sample_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    session.sample_type = sType;
    session.step = 'quantity';
    sessionStore.set(uid, session);
    await bot.sendMessage(callbackQuery.message.chat.id, `Type: *${sType}*\n\nHow many sample pieces?`, { parse_mode: 'Markdown' });

  } else if (data.startsWith('smpconf:')) {
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'sample_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Submitting...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    const requestId = genId();
    const summary = `Sample Request\nDesign: ${session.design}${session.shade ? ' Shade ' + session.shade : ''}\nType: ${session.sample_type}\nCustomer: ${session.customer}\nQty: ${session.quantity} pcs\nFollow-up: ${session.followup_date}`;
    await approvalQueueRepository.append({
      requestId, user: uid,
      actionJSON: { action: 'give_sample', design: session.design, shade: session.shade, sample_type: session.sample_type, customer: session.customer, quantity: session.quantity, followup_date: session.followup_date },
      riskReason: 'Admin approval required for sample', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: 'sample_approval' }, uid);
    const userLabel = await getRequesterDisplayName(uid, null);
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, 'Sample requires admin approval');
    await bot.sendMessage(callbackQuery.message.chat.id, `⏳ Sample request submitted for admin approval.\nRequest: ${requestId}`);
    sessionStore.clear(uid);

  } else if (data.startsWith('smpcanc:')) {
    const uid = String(callbackQuery.from.id);
    sessionStore.clear(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled.' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    await bot.sendMessage(callbackQuery.message.chat.id, 'Sample request cancelled.');

  } else if (data.startsWith('sd:')) {
    const view = data.slice(3);
    const uid = String(callbackQuery.from.id);
    if (!config.access.adminIds.includes(uid)) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Generating report...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    try {
      const sold = await getSoldItems();
      if (!sold.length) {
        await bot.sendMessage(callbackQuery.message.chat.id, 'No sold items found in inventory.');
        return;
      }
      let report;
      if (view === 'design') report = buildDesignWiseReport(sold);
      else if (view === 'customer') report = buildCustomerWiseReport(sold);
      else if (view === 'warehouse') report = buildWarehouseWiseReport(sold);
      else { await bot.sendMessage(callbackQuery.message.chat.id, 'Unknown view.'); return; }
      await sendLong(bot, callbackQuery.message.chat.id, report, { parse_mode: 'Markdown' });
    } catch (e) {
      logger.error('Supply details report error', e);
      await bot.sendMessage(callbackQuery.message.chat.id, `Report error: ${e.message}`);
    }

  } else if (data.startsWith('od:')) {
    const design = data.slice(3);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'order_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    session.design = design;
    session.shade = '';
    session.step = 'customer';
    sessionStore.set(uid, session);
    let customerNames = await transactionsRepo.getCustomersByDesign(design);
    let label = 'past buyers shown';
    if (!customerNames.length) {
      const customersRepo = require('../repositories/customersRepository');
      const allCust = await customersRepo.getAll();
      customerNames = allCust.filter((c) => c.status === 'Active' && c.name).map((c) => c.name);
      if (customerNames.length) label = 'registered customers shown';
    }
    const rows = [];
    for (let i = 0; i < customerNames.length; i += 2) {
      const row = [{ text: customerNames[i], callback_data: `oc:${customerNames[i].slice(0, 50)}` }];
      if (customerNames[i + 1]) row.push({ text: customerNames[i + 1], callback_data: `oc:${customerNames[i + 1].slice(0, 50)}` });
      rows.push(row);
    }
    if (rows.length > 20) rows.splice(20);
    rows.push([{ text: '➕ New customer', callback_data: 'oc:__new__' }]);
    await bot.sendMessage(callbackQuery.message.chat.id, `Design: *${design}*\n\nSelect customer (${label}):`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });

  } else if (data.startsWith('oc:')) {
    const val = data.slice(3);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'order_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    if (val === '__new__') {
      session.step = 'customer_new';
      sessionStore.set(uid, session);
      await bot.sendMessage(callbackQuery.message.chat.id, 'Enter new customer name:');
    } else {
      session.customer = val;
      session.step = 'quantity';
      sessionStore.set(uid, session);
      await bot.sendMessage(callbackQuery.message.chat.id, `Customer: *${val}*\n\nEnter quantity:`, { parse_mode: 'Markdown' });
    }

  } else if (data.startsWith('os:')) {
    const spId = data.slice(3);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'order_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    const spUser = await usersRepository.findByUserId(spId);
    session.salesperson_id = spId;
    session.salesperson_name = spUser ? spUser.name : spId;
    session.step = 'payment';
    sessionStore.set(uid, session);
    await bot.sendMessage(callbackQuery.message.chat.id, `Salesperson: *${session.salesperson_name}*\n\nPayment status:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '💰 PAID', callback_data: 'op:PAID' }, { text: '📝 UNPAID', callback_data: 'op:UNPAID' }]] },
    });

  } else if (data.startsWith('op:')) {
    const pay = data.slice(3);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'order_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    session.payment_status = pay;
    session.step = 'date';
    sessionStore.set(uid, session);
    const nextMon = nextWeekday(1);
    const nextFri = nextWeekday(5);
    const today = new Date().toISOString().split('T')[0];
    await bot.sendMessage(callbackQuery.message.chat.id, 'Schedule supply date:', {
      reply_markup: { inline_keyboard: [
        [{ text: `📅 Today (${today})`, callback_data: 'odt:today' }],
        [{ text: `📅 Next Monday (${nextMon})`, callback_data: 'odt:mon' }, { text: `📅 Next Friday (${nextFri})`, callback_data: 'odt:fri' }],
        [{ text: '✏️ Custom date', callback_data: 'odt:custom' }],
      ] },
    });

  } else if (data.startsWith('odt:')) {
    const val = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'order_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    if (val === 'today') {
      session.scheduled_date = new Date().toISOString().split('T')[0];
    } else if (val === 'mon') {
      session.scheduled_date = nextWeekday(1);
    } else if (val === 'fri') {
      session.scheduled_date = nextWeekday(5);
    } else {
      session.step = 'date_custom';
      sessionStore.set(uid, session);
      await bot.sendMessage(callbackQuery.message.chat.id, 'Enter date (DD-MM-YYYY or YYYY-MM-DD):');
      return;
    }
    session.step = 'confirm';
    sessionStore.set(uid, session);
    await showOrderSummary(bot, callbackQuery.message.chat.id, session);

  } else if (data.startsWith('oconf:')) {
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'order_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Creating order...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    const saved = await ordersRepo.append({
      design: session.design,
      shade: session.shade || '',
      customer: session.customer,
      quantity: session.quantity,
      salesperson_id: session.salesperson_id,
      salesperson_name: session.salesperson_name,
      payment_status: session.payment_status,
      scheduled_date: session.scheduled_date,
      status: 'pending_accept',
      created_by: uid,
    });
    sessionStore.clear(uid);
    await bot.sendMessage(callbackQuery.message.chat.id, `✅ Order *${saved.order_id}* created and sent to ${session.salesperson_name} for acceptance.`, { parse_mode: 'Markdown' });
    try {
      const orderMsg = `📦 *New Supply Order Assigned*\n\nOrder: *${saved.order_id}*\nDesign: ${session.design}\nCustomer: ${session.customer}\nQuantity: ${session.quantity}\nPayment: ${session.payment_status}\nScheduled Date: ${session.scheduled_date}\n\nPlease accept this order:`;
      await bot.sendMessage(session.salesperson_id, orderMsg, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '✅ Accept Order', callback_data: `oacc:${saved.order_id}` }]] },
      });
    } catch (e) {
      logger.error(`Failed to notify employee ${session.salesperson_id} about order ${saved.order_id}`, e.message);
      await bot.sendMessage(callbackQuery.message.chat.id, `⚠️ Could not notify ${session.salesperson_name}. Please inform them manually about order ${saved.order_id}.`);
    }

  } else if (data.startsWith('ocanc:')) {
    const uid = String(callbackQuery.from.id);
    sessionStore.clear(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled.' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    await bot.sendMessage(callbackQuery.message.chat.id, 'Order creation cancelled.');

  } else if (data.startsWith('oacc:')) {
    const orderId = data.slice(5);
    const uid = String(callbackQuery.from.id);
    const order = await ordersRepo.getById(orderId);
    if (!order) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Order not found.' }); return; }
    if (order.salesperson_id !== uid) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'This order is not assigned to you.' }); return; }
    if (order.status !== 'pending_accept') { await bot.answerCallbackQuery(callbackQuery.id, { text: `Order already ${order.status}.` }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Accepting...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    await ordersRepo.updateStatus(orderId, 'accepted', { accepted_at: new Date().toISOString() });
    await bot.sendMessage(callbackQuery.message.chat.id, `✅ You accepted order *${orderId}*.\n\nDesign: ${order.design}\nCustomer: ${order.customer}\nQty: ${order.quantity}\nScheduled: ${order.scheduled_date}\n\nYou'll get a reminder 1 day before. Mark delivered with: "Mark order ${orderId} delivered"`, { parse_mode: 'Markdown' });
    for (const adminId of config.access.adminIds) {
      try {
        await bot.sendMessage(adminId, `✅ *${order.salesperson_name}* accepted order *${orderId}*\n\nDesign: ${order.design} | Customer: ${order.customer}\nQty: ${order.quantity} | Date: ${order.scheduled_date}`, { parse_mode: 'Markdown' });
      } catch (_) {}
    }

  } else if (data.startsWith('odel:')) {
    const orderId = data.slice(5);
    const uid = String(callbackQuery.from.id);
    const order = await ordersRepo.getById(orderId);
    if (!order) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Order not found.' }); return; }
    if (order.salesperson_id !== uid) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Not your order.' }); return; }
    if (order.status !== 'accepted') { await bot.answerCallbackQuery(callbackQuery.id, { text: `Order must be accepted first. Status: ${order.status}` }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Marking delivered...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    await ordersRepo.updateStatus(orderId, 'delivered', { delivered_at: new Date().toISOString() });
    await bot.sendMessage(callbackQuery.message.chat.id, `✅ Order *${orderId}* marked as delivered.`, { parse_mode: 'Markdown' });
    for (const adminId of config.access.adminIds) {
      try {
        await bot.sendMessage(adminId, `📦 Order *${orderId}* has been delivered.\n\nDesign: ${order.design}\nCustomer: ${order.customer}\nQty: ${order.quantity}\nDelivered by: ${order.salesperson_name}`, { parse_mode: 'Markdown' });
      } catch (_) {}
    }

  // ─── Receipt Flow Callbacks ─────────────────────────────────────────────
  } else if (data.startsWith('rcc:')) {
    const val = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'receipt_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    if (val === '__new__') {
      session.step = 'customer_new';
      sessionStore.set(uid, session);
      await bot.sendMessage(callbackQuery.message.chat.id, 'Enter new customer name:');
    } else {
      session.customer = val;
      session.step = 'amount';
      sessionStore.set(uid, session);
      await bot.sendMessage(callbackQuery.message.chat.id, `Customer: *${val}*\n\nEnter the payment amount received (NGN):`, { parse_mode: 'Markdown' });
    }

  } else if (data.startsWith('rcb:')) {
    const bank = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'receipt_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    session.bank_account = bank;
    session.step = 'file';
    const displayName = await getRequesterDisplayName(uid, null);
    session.uploaded_by_id = uid;
    session.uploaded_by_name = displayName;
    sessionStore.set(uid, session);
    await bot.sendMessage(callbackQuery.message.chat.id, `Account: *${bank}*\n\nNow please send the *receipt photo or PDF*.`, { parse_mode: 'Markdown' });

  } else if (data.startsWith('rcconf:')) {
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'receipt_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Submitting...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });

    const receiptId = idGenerator.receipt();
    await receiptsRepo.append({
      receipt_id: receiptId,
      customer: session.customer,
      amount: session.amount,
      bank_account: session.bank_account,
      uploaded_by_id: session.uploaded_by_id,
      uploaded_by_name: session.uploaded_by_name,
      telegram_file_id: session.telegram_file_id,
      file_type: session.file_type,
      status: 'pending',
    });

    const isAdmin = config.access.adminIds.includes(uid);
    const otherAdmins = config.access.adminIds.filter((id) => id !== uid);
    const summary = `🧾 Receipt Approval Pending: ${receiptId}\n\nCustomer: ${session.customer}\nAmount: NGN ${fmtQty(session.amount)}\nAccount: ${session.bank_account}\nUploaded by: ${session.uploaded_by_name} (${session.uploaded_by_id})`;

    if (isAdmin && otherAdmins.length) {
      const keyboard = { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `rcapr:${receiptId}` },
        { text: '❌ Reject', callback_data: `rcrej:${receiptId}` },
      ]] };
      for (const adminId of otherAdmins) {
        try {
          await bot.sendMessage(adminId, summary, { reply_markup: keyboard });
          if (session.file_type === 'document') {
            await bot.sendDocument(adminId, session.telegram_file_id, { caption: `📄 Receipt for ${receiptId}` });
          } else {
            await bot.sendPhoto(adminId, session.telegram_file_id, { caption: `📷 Receipt for ${receiptId}` });
          }
        } catch (e) { logger.error(`Failed to notify admin ${adminId} for receipt ${receiptId}`, e.message); }
      }
      await bot.sendMessage(callbackQuery.message.chat.id, `⏳ Receipt ${receiptId} submitted for 2nd admin approval.`);
    } else {
      const keyboard = { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `rcapr:${receiptId}` },
        { text: '❌ Reject', callback_data: `rcrej:${receiptId}` },
      ]] };
      for (const adminId of config.access.adminIds) {
        try {
          await bot.sendMessage(adminId, summary, { reply_markup: keyboard });
          if (session.file_type === 'document') {
            await bot.sendDocument(adminId, session.telegram_file_id, { caption: `📄 Receipt for ${receiptId}` });
          } else {
            await bot.sendPhoto(adminId, session.telegram_file_id, { caption: `📷 Receipt for ${receiptId}` });
          }
        } catch (e) { logger.error(`Failed to notify admin ${adminId} for receipt ${receiptId}`, e.message); }
      }
      await bot.sendMessage(callbackQuery.message.chat.id, `⏳ Receipt ${receiptId} submitted for admin approval.`);
    }
    sessionStore.clear(uid);

  } else if (data.startsWith('rccanc:')) {
    const uid = String(callbackQuery.from.id);
    sessionStore.clear(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled.' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    await bot.sendMessage(callbackQuery.message.chat.id, 'Receipt upload cancelled.');

  } else if (data.startsWith('rcapr:')) {
    const receiptId = data.slice(6);
    const adminId = String(callbackQuery.from.id);
    if (!config.access.adminIds.includes(adminId)) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only admins can approve.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Approving receipt...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });

    const receipt = await receiptsRepo.getById(receiptId);
    if (!receipt) { await bot.sendMessage(callbackQuery.message.chat.id, `Receipt ${receiptId} not found.`); return; }
    if (receipt.status === 'approved') { await bot.sendMessage(callbackQuery.message.chat.id, `Receipt ${receiptId} already approved.`); return; }

    try {
      const { buffer, filePath } = await downloadTelegramFile(bot, receipt.telegram_file_id);
      const ext = filePath.split('.').pop() || (receipt.file_type === 'document' ? 'pdf' : 'jpg');
      const fileName = `receipt_${receipt.customer.replace(/\s+/g, '_')}_${receiptId}.${ext}`;
      const mimeType = receipt.file_type === 'document' ? 'application/pdf' : 'image/jpeg';
      const { fileId: driveFileId, webViewLink } = await driveClient.uploadFile(buffer, fileName, mimeType);
      await receiptsRepo.updateDriveInfo(receiptId, driveFileId, webViewLink, adminId);

      await bot.sendMessage(callbackQuery.message.chat.id,
        `✅ Receipt ${receiptId} approved.\n\n👤 ${receipt.customer}\n💰 NGN ${fmtQty(receipt.amount)}\n🏦 ${receipt.bank_account}\n📎 [View Receipt](${webViewLink})`,
        { parse_mode: 'Markdown', disable_web_page_preview: true });

      try {
        await bot.sendMessage(receipt.uploaded_by_id,
          `✅ Your receipt (${receiptId}) for ${receipt.customer} — NGN ${fmtQty(receipt.amount)} has been approved.`);
      } catch (e) { logger.error(`Failed to notify employee ${receipt.uploaded_by_id} about receipt ${receiptId}`, e.message); }
    } catch (e) {
      logger.error(`Receipt approval error for ${receiptId}`, e);
      await bot.sendMessage(callbackQuery.message.chat.id, `⚠️ Error processing receipt ${receiptId}: ${e.message}`);
    }

  } else if (data.startsWith('rcrej:')) {
    const receiptId = data.slice(6);
    const adminId = String(callbackQuery.from.id);
    if (!config.access.adminIds.includes(adminId)) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only admins can reject.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Rejecting...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });

    await receiptsRepo.updateStatus(receiptId, 'rejected');
    await bot.sendMessage(callbackQuery.message.chat.id, `❌ Receipt ${receiptId} rejected.`);

    const receipt = await receiptsRepo.getById(receiptId);
    if (receipt) {
      try {
        await bot.sendMessage(receipt.uploaded_by_id, `❌ Your receipt (${receiptId}) for ${receipt.customer} — NGN ${fmtQty(receipt.amount)} has been rejected by admin.`);
      } catch (e) { logger.error(`Failed to notify employee ${receipt.uploaded_by_id} about receipt ${receiptId} rejection`, e.message); }
    }

  } else {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Unknown action.' });
  }
}

module.exports = { handleMessage, handleCallbackQuery, handleFileMessage };
