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
const productTypesRepo = require('../repositories/productTypesRepository');
const ordersRepo = require('../repositories/ordersRepository');
const samplesRepo = require('../repositories/samplesRepository');
const customerFollowupsRepo = require('../repositories/customerFollowupsRepository');
const customerNotesRepo = require('../repositories/customerNotesRepository');
const transactionsRepo = require('../repositories/transactionsRepository');
const receiptsRepo = require('../repositories/receiptsRepository');
const driveClient = require('../repositories/driveClient');
const departmentsRepo = require('../repositories/departmentsRepository');
const activityRegistry = require('../services/activityRegistry');
const customersRepo = require('../repositories/customersRepository');
const userPrefsRepo = require('../repositories/userPrefsRepository');
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
  const isAdm = config.access.adminIds.includes(userId);
  const approverLabel = isAdm ? '2nd admin' : 'admin';
  await bot.sendMessage(chatId, `⏳ Needs ${approverLabel} approval (${risk.reason}). Request: ${requestId}`);
  const userLabel = await getRequesterDisplayName(userId, msg);
  const excludeId = isAdm ? userId : undefined;
  await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, risk.reason, excludeId);
  return true;
}

const CURRENCY = config.currency || 'NGN';

function fmtQty(n) { return Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 }); }
function fmtMoney(n) { return `${CURRENCY} ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`; }

const getMaterialInfo = productTypesRepo.getMaterialInfo;
const fmtDate = require('../utils/formatDate');

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

function valStr(value, isAdmin) {
  return isAdmin ? ` — ${fmtMoney(value)}` : '';
}

function buildDesignWiseReport(sold, isAdmin) {
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
  let text = `📊 *Supply Details — Design Wise (Summary)*\n\n`;
  let grandPkgs = new Set(), grandThans = 0, grandYards = 0, grandValue = 0;
  for (const [design, dg] of sorted) {
    text += `📦 *${design}*\n`;
    const shadesSorted = [...dg.shades.entries()].sort((a, b) => b[1].yards - a[1].yards);
    for (const [shade, sh] of shadesSorted) {
      text += `  Shade ${shade}: ${sh.pkgs.size} pkgs, ${sh.thans} thans, ${fmtQty(sh.yards)} yds${valStr(sh.value, isAdmin)}\n`;
    }
    const topBuyer = [...dg.buyers.entries()].sort((a, b) => b[1] - a[1])[0];
    text += `  *Total: ${dg.totalPkgs.size} pkgs, ${dg.totalThans} thans, ${fmtQty(dg.totalYards)} yds${valStr(dg.totalValue, isAdmin)}*\n`;
    if (topBuyer) text += `  Top buyer: ${topBuyer[0]} (${fmtQty(topBuyer[1])} yds)\n`;
    text += '\n';
    for (const p of dg.totalPkgs) grandPkgs.add(p);
    grandThans += dg.totalThans; grandYards += dg.totalYards; grandValue += dg.totalValue;
  }
  text += `*Grand Total: ${grandPkgs.size} pkgs, ${grandThans} thans, ${fmtQty(grandYards)} yds${valStr(grandValue, isAdmin)}*`;
  return text;
}

function normalizeDate(raw) {
  if (!raw) return { sort: '9999-99-99', display: '—' };
  const s = String(raw).trim();
  const ymd = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (ymd) {
    const [, y, m, d] = ymd;
    const mm = parseInt(m, 10); const dd = parseInt(d, 10);
    return { sort: `${y}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`, display: fmtDate(s) };
  }
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const mm = parseInt(m, 10); const dd = parseInt(d, 10);
    return { sort: `${y}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`, display: fmtDate(s) };
  }
  const longDate = new Date(s);
  if (!isNaN(longDate.getTime())) {
    const y = longDate.getFullYear(); const mm = longDate.getMonth(); const dd = longDate.getDate();
    return { sort: `${y}-${String(mm + 1).padStart(2,'0')}-${String(dd).padStart(2,'0')}`, display: fmtDate(s) };
  }
  return { sort: s, display: s };
}

function buildDesignDateWiseReport(sold, isAdmin) {
  const designs = new Map();
  for (const r of sold) {
    const key = r.design || 'Unknown';
    if (!designs.has(key)) designs.set(key, []);
    designs.get(key).push(r);
  }

  const designTotals = [...designs.entries()].map(([design, items]) => {
    const totalValue = items.reduce((s, r) => s + r.yards * r.pricePerYard, 0);
    return { design, items, totalValue };
  }).sort((a, b) => b.totalValue - a.totalValue);

  let text = `📊 *Supply Details — Design Wise (Date-wise)*\n\n`;
  let grandPkgs = new Set(), grandThans = 0, grandYards = 0, grandValue = 0;

  for (const { design, items } of designTotals) {
    const shades = new Set(items.map((r) => r.shade || '-'));
    const shadeLabel = shades.size === 1 ? ` ${[...shades][0]}` : '';

    const byDateCust = new Map();
    for (const r of items) {
      const nd = normalizeDate(r.soldDate);
      const cust = r.soldTo || 'Unknown';
      const shade = r.shade || '-';
      const key = `${nd.sort}|${cust}|${shade}`;
      if (!byDateCust.has(key)) byDateCust.set(key, { sortDate: nd.sort, displayDate: nd.display, customer: cust, shade, pkgs: new Set(), thans: 0, yards: 0, value: 0 });
      const grp = byDateCust.get(key);
      grp.pkgs.add(r.packageNo); grp.thans++; grp.yards += r.yards; grp.value += r.yards * r.pricePerYard;
    }
    const rows = [...byDateCust.values()].sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.customer.localeCompare(b.customer));

    let dTotal = { pkgs: new Set(), thans: 0, yards: 0, value: 0 };
    text += `📦 *${design}${shadeLabel}*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const row of rows) {
      const shPart = shades.size > 1 ? `  ${row.shade}` : '';
      text += `  ${row.displayDate}  ${row.customer}${shPart}  ${row.pkgs.size} pkg, ${row.thans} th, ${fmtQty(row.yards)} yds${valStr(row.value, isAdmin)}\n`;
      for (const p of row.pkgs) dTotal.pkgs.add(p);
      dTotal.thans += row.thans; dTotal.yards += row.yards; dTotal.value += row.value;
    }
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `*Total: ${dTotal.pkgs.size} pkg, ${dTotal.thans} th, ${fmtQty(dTotal.yards)} yds${valStr(dTotal.value, isAdmin)}*\n\n`;
    for (const p of dTotal.pkgs) grandPkgs.add(p);
    grandThans += dTotal.thans; grandYards += dTotal.yards; grandValue += dTotal.value;
  }
  text += `*Grand Total: ${grandPkgs.size} pkg, ${grandThans} th, ${fmtQty(grandYards)} yds${valStr(grandValue, isAdmin)}*`;
  return text;
}

function buildCustomerWiseReport(sold, isAdmin) {
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
      text += `  ${ds.design} Shade ${ds.shade}: ${ds.pkgs.size} pkgs, ${ds.thans} thans, ${fmtQty(ds.yards)} yds${valStr(ds.value, isAdmin)}\n`;
    }
    text += `  *Total: ${cg.totalPkgs.size} pkgs, ${cg.totalThans} thans, ${fmtQty(cg.totalYards)} yds${valStr(cg.totalValue, isAdmin)}*\n\n`;
    for (const p of cg.totalPkgs) grandPkgs.add(p);
    grandThans += cg.totalThans; grandYards += cg.totalYards; grandValue += cg.totalValue;
  }
  text += `*Grand Total: ${grandPkgs.size} pkgs, ${grandThans} thans, ${fmtQty(grandYards)} yds${valStr(grandValue, isAdmin)}*`;
  return text;
}

function buildWarehouseWiseReport(sold, isAdmin) {
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
      text += `  ${ds.design} Shade ${ds.shade}: ${ds.pkgs.size} pkgs, ${ds.thans} thans, ${fmtQty(ds.yards)} yds${valStr(ds.value, isAdmin)}\n`;
    }
    text += `  *Total: ${wg.totalPkgs.size} pkgs, ${wg.totalThans} thans, ${fmtQty(wg.totalYards)} yds${valStr(wg.totalValue, isAdmin)}*\n\n`;
    for (const p of wg.totalPkgs) grandPkgs.add(p);
    grandThans += wg.totalThans; grandYards += wg.totalYards; grandValue += wg.totalValue;
  }
  text += `*Grand Total: ${grandPkgs.size} pkgs, ${grandThans} thans, ${fmtQty(grandYards)} yds${valStr(grandValue, isAdmin)}*`;
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

function fmtBar(value, total, label = 'sold') {
  if (!total) return '';
  const pct = Math.round((value / total) * 100);
  const filled = Math.round(pct / 10);
  return '▓'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}% ${label}`;
}

/**
 * Edit an existing message in place if messageId is provided, otherwise send
 * a new message. On edit failure (e.g. message too old or identical content),
 * silently falls back to sendMessage so the user always sees the update.
 *
 * opts may include parse_mode and reply_markup (standard Telegram options).
 */
async function editOrSend(bot, chatId, messageId, text, opts = {}) {
  if (messageId) {
    try {
      return await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...opts,
      });
    } catch (_) {
      // fall through
    }
  }
  return bot.sendMessage(chatId, text, opts);
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

async function handleUpdatePriceFlowText(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'update_price_flow') return false;
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === 'cancel') {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, '❌ Update Price cancelled.');
    return true;
  }
  if (session.step === 'price_custom') {
    const n = parseFloat(trimmed.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(n) || n <= 0) {
      await bot.sendMessage(chatId, 'Please enter a valid positive number (e.g. 1500):');
      return true;
    }
    session.newPrice = n;
    session.step = 'confirm';
    sessionStore.set(userId, session);
    await showUpdatePriceConfirm(bot, chatId, userId);
    return true;
  }
  return false;
}

async function handleAddNoteFlowText(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'add_note_flow') return false;
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === 'cancel') {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, '❌ Note cancelled.');
    return true;
  }
  if (session.step === 'note_text') {
    if (trimmed.length < 2) {
      await bot.sendMessage(chatId, 'Note is too short. Type the note or "cancel":');
      return true;
    }
    await customerNotesRepo.append({ customer: session.customer, note: trimmed, created_by: userId });
    sessionStore.clear(userId);
    await bot.sendMessage(chatId,
      `✅ Note added for *${session.customer}*:\n_${trimmed}_`,
      { parse_mode: 'Markdown' });
    return true;
  }
  return false;
}

async function handleAddBankFlowText(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'add_bank_flow') return false;
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === 'cancel') {
    sessionStore.clear(userId);
    if (session.flowMessageId) {
      await showBankManager(bot, chatId, userId, session.flowMessageId);
    }
    return true;
  }
  if (session.step === 'name') {
    if (trimmed.length < 2) {
      await bot.sendMessage(chatId, 'Bank name too short, please re-enter:');
      return true;
    }
    // Dedupe check against current list before queuing approval.
    const all = await settingsRepo.getAll();
    const existing = (all.BANK_LIST || '').split(',').map((b) => b.trim().toLowerCase()).filter(Boolean);
    if (existing.includes(trimmed.toLowerCase())) {
      await bot.sendMessage(chatId, `⚠️ "${trimmed}" already exists. Enter a different name or type "cancel".`);
      return true;
    }

    const requestId = genId();
    await approvalQueueRepository.append({
      requestId, user: userId,
      actionJSON: { action: 'add_bank', bank_name: trimmed },
      riskReason: 'New bank addition requires admin approval', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: 'add_bank', bank: trimmed }, userId);

    if (session.flowMessageId) {
      await bot.editMessageText(
        `🏦 *Add Bank — submitted*\n\nBank: *${trimmed}*\n\n⏳ Waiting for admin approval.\nRequest: \`${requestId}\``,
        { chat_id: chatId, message_id: session.flowMessageId, parse_mode: 'Markdown' },
      ).catch(() => {});
    }
    const userLabel = await getRequesterDisplayName(userId, null);
    await approvalEvents.notifyAdminsApprovalRequest(
      bot, requestId, userLabel, `Add Bank\nBank: ${trimmed}`,
      'New bank addition requires admin approval',
    );
    sessionStore.clear(userId);
    return true;
  }
  return false;
}

async function handleAddCustomerFlowText(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'add_customer_flow') return false;

  const trimmed = text.trim();

  if (trimmed.toLowerCase() === 'cancel') {
    sessionStore.clear(userId);
    if (session.flowMessageId) {
      await bot.editMessageText('❌ Add-customer flow cancelled.', {
        chat_id: chatId, message_id: session.flowMessageId,
      }).catch(() => {});
    } else {
      await bot.sendMessage(chatId, '❌ Add-customer flow cancelled.');
    }
    return true;
  }

  if (session.step === 'name') {
    if (trimmed.length < 2) {
      await bot.sendMessage(chatId, 'Name too short, please re-enter:');
      return true;
    }
    session.name = trimmed;
    session.step = 'phone';
    sessionStore.set(userId, session);
    await showAddCustomerPhoneStep(bot, chatId, userId);
    return true;
  }

  if (session.step === 'phone') {
    session.phone = trimmed;
    session.step = 'address';
    sessionStore.set(userId, session);
    await showAddCustomerAddressStep(bot, chatId, userId);
    return true;
  }

  if (session.step === 'address') {
    session.address = trimmed;
    session.step = 'category';
    sessionStore.set(userId, session);
    await showAddCustomerCategoryPicker(bot, chatId, userId);
    return true;
  }

  if (session.step === 'credit_custom') {
    const n = parseInt(trimmed.replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(n) || n < 0) {
      await bot.sendMessage(chatId, 'Please enter a valid non-negative number (e.g. 75000):');
      return true;
    }
    session.credit_limit = n;
    session.step = 'payment_terms';
    sessionStore.set(userId, session);
    await showAddCustomerPaymentTermsStep(bot, chatId, userId);
    return true;
  }

  if (session.step === 'payment_terms_custom') {
    session.payment_terms = trimmed || 'COD';
    session.step = 'notes';
    sessionStore.set(userId, session);
    await showAddCustomerNotesStep(bot, chatId, userId);
    return true;
  }

  if (session.step === 'notes') {
    session.notes = trimmed;
    session.step = 'confirm';
    sessionStore.set(userId, session);
    await showAddCustomerConfirmation(bot, chatId, userId);
    return true;
  }

  return false;
}

async function handleSampleFlowText(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'sample_flow') return false;

  if (text.toLowerCase() === 'cancel') {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, 'Sample request cancelled.');
    return true;
  }

  /* ─── Button-flow text steps: new customer name / phone, custom qty ─── */
  if (session.step === 'sample_new_cust_name') {
    const name = text.trim();
    if (name.length < 2) {
      await bot.sendMessage(chatId, 'Name too short, please re-enter:');
      return true;
    }
    session.pendingCustomerName = name;
    session.step = 'sample_new_cust_phone';
    sessionStore.set(userId, session);
    await bot.sendMessage(chatId, `Got it: *${name}*\n\nEnter phone number (or type "skip"):`, { parse_mode: 'Markdown' });
    return true;
  }

  if (session.step === 'sample_new_cust_phone') {
    const raw = text.trim();
    const phone = raw.toLowerCase() === 'skip' ? '' : raw;
    const name = session.pendingCustomerName;

    // Queue new-customer approval and pause the sample flow.
    const customerId = `C-${Date.now().toString(36).toUpperCase()}`;
    const customersRepo2 = require('../repositories/customersRepository');
    await customersRepo2.append({
      customer_id: customerId, name, phone, address: '', category: '',
      credit_limit: 0, payment_terms: '', notes: 'Added via sample flow',
      status: 'Pending',
    });

    const requestId = genId();
    await approvalQueueRepository.append({
      requestId, user: userId,
      actionJSON: {
        action: 'new_customer_registration',
        customer_id: customerId, customer_name: name, phone,
        requesterUserId: userId, from: 'sample_flow',
      },
      riskReason: 'New customer registration requires admin approval',
      status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: 'new_customer', from: 'sample_flow' }, userId);

    session.pendingCustomerId = customerId;
    session.customerApprovalId = requestId;
    session.step = 'awaiting_customer_approval';
    sessionStore.set(userId, session);

    const userLabel = await getRequesterDisplayName(userId, null);
    await approvalEvents.notifyAdminsApprovalRequest(
      bot, requestId, userLabel,
      `New Customer Registration\nName: ${name}\nPhone: ${phone || '—'}\n(from sample flow)`,
      'New customer requires admin approval',
    );
    await bot.sendMessage(chatId,
      `⏳ Customer "*${name}*" sent for admin approval.\n\nYour sample request is *paused* — it will resume automatically once a second admin approves the new customer.`,
      { parse_mode: 'Markdown' });
    return true;
  }

  if (session.step === 'quantity_custom') {
    const qty = text.trim();
    if (!qty || isNaN(Number(qty)) || Number(qty) <= 0) {
      await bot.sendMessage(chatId, 'Please enter a valid positive number.');
      return true;
    }
    session.quantity = qty;
    session.step = 'type';
    sessionStore.set(userId, session);
    await showSampleTypePicker(bot, chatId, userId);
    return true;
  }

  /* ─── Legacy text-flow steps (text intent starts the flow) ─── */
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

/* ─── Reusable Report Senders ──────────────────────────────────────────────
 * These wrap the report-building helpers above so the same logic can be
 * invoked from BOTH typed text intents AND inline-keyboard callbacks.
 * Keeping them here (co-located with the builders) avoids duplicating the
 * rendering logic across `handleMessage` and `handleCallbackQuery`.
 */

function _hist_monthKey(dateStr) {
  if (!dateStr) return 'unknown';
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.slice(0, 7);
  const t = new Date(dateStr);
  if (!isNaN(t.getTime())) return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
  return 'unknown';
}
function _hist_dayOf(dateStr) {
  if (!dateStr) return '--';
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.slice(8, 10);
  const t = new Date(dateStr);
  if (!isNaN(t.getTime())) return String(t.getDate()).padStart(2, '0');
  return '--';
}

async function sendCustomerHistoryReport(bot, chatId, customerName) {
  const events = await buildCustomerTimeline(customerName);
  if (!events.length) {
    await bot.sendMessage(chatId, `No interaction history found for "${customerName}".`);
    return;
  }

  // Pull raw sales rows so we can (a) compute accurate lifetime/recent totals
  // and (b) collapse multi-package same-day buys into a single line.
  const allInv = await inventoryRepository.getAll();
  const sold = allInv.filter(
    (r) => r.status === 'sold' && r.soldTo && r.soldTo.toLowerCase() === customerName.toLowerCase(),
  );

  const totalPkgs = new Set(sold.map((r) => r.packageNo)).size;
  const totalYards = sold.reduce((s, r) => s + (r.yards || 0), 0);
  const totalValue = sold.reduce((s, r) => s + (r.yards || 0) * (r.pricePerYard || 0), 0);

  const cutoff30 = Date.now() - 30 * 86400000;
  const recentSold = sold.filter((r) => {
    const t = r.soldDate ? new Date(r.soldDate).getTime() : NaN;
    return Number.isFinite(t) && t >= cutoff30;
  });
  const recentYards = recentSold.reduce((s, r) => s + (r.yards || 0), 0);
  const recentValue = recentSold.reduce((s, r) => s + (r.yards || 0) * (r.pricePerYard || 0), 0);
  const recentTrips = new Set(recentSold.map((r) => r.soldDate)).size;

  const soldDates = sold.map((r) => r.soldDate).filter(Boolean).sort();
  const firstSoldDate = soldDates[0];
  const lastSoldDate = soldDates[soldDates.length - 1];

  const lastMs = events[0].date ? new Date(events[0].date).getTime() : NaN;
  const lastAgo = Number.isFinite(lastMs)
    ? `${Math.floor((Date.now() - lastMs) / 86400000)} days ago`
    : '—';

  // ─── Header: at-a-glance summary ─────────────────────────────────────────
  let out = `👤 *${customerName}*\n`;
  if (firstSoldDate && lastSoldDate) {
    out += `🗓 Active: ${fmtDate(firstSoldDate)} → ${fmtDate(lastSoldDate)}\n`;
  }
  out += `💰 Lifetime: ${totalPkgs} pkgs, ${fmtQty(totalYards)} yds`;
  out += totalValue > 0 ? ` — ${fmtMoney(totalValue)}\n` : `\n`;
  if (recentSold.length > 0) {
    out += `📈 Last 30d: ${recentTrips} trip${recentTrips > 1 ? 's' : ''}, ${fmtQty(recentYards)} yds`;
    out += recentValue > 0 ? ` — ${fmtMoney(recentValue)}\n` : `\n`;
  }
  out += `⏰ Last activity: ${lastAgo}\n\n`;

  // ─── Collapse sales: one line per (date + design + shade) ────────────────
  const soldByKey = new Map();
  for (const r of sold) {
    const key = `${r.soldDate}|${r.design}|${r.shade || '-'}`;
    if (!soldByKey.has(key)) {
      soldByKey.set(key, { date: r.soldDate, design: r.design, shade: r.shade || '-', pkgs: new Set(), yards: 0, value: 0 });
    }
    const g = soldByKey.get(key);
    g.pkgs.add(r.packageNo);
    g.yards += r.yards || 0;
    g.value += (r.yards || 0) * (r.pricePerYard || 0);
  }
  const collapsedSales = [...soldByKey.values()].map((g) => {
    const pkgTxt = `${g.pkgs.size} pkg${g.pkgs.size > 1 ? 's' : ''}`;
    const valueTxt = g.value > 0 ? ` — ${fmtMoney(g.value)}` : '';
    return {
      date: g.date,
      kind: 'sale',
      text: `Bought ${pkgTxt} of ${g.design} Shade ${g.shade} — ${fmtQty(g.yards)} yds${valueTxt}`,
    };
  });

  // ─── Non-sale events in plain language ───────────────────────────────────
  const otherEvents = events
    .filter((e) => !e.type.startsWith('Sale'))
    .map((e) => {
      let kind, text;
      if (e.type.startsWith('Payment')) { kind = 'pay'; text = `Paid ${e.detail}`; }
      else if (e.type.startsWith('Order')) {
        const status = (e.type.match(/\(([^)]+)\)/) || [])[1] || 'pending';
        const verb = status === 'delivered' ? 'Order delivered'
                   : status === 'accepted' ? 'Order accepted'
                   : status === 'cancelled' ? 'Order cancelled'
                   : 'Order placed';
        kind = 'order';
        text = `${verb} — ${e.detail}`;
      } else if (e.type.startsWith('Sample')) {
        const status = (e.type.match(/\(([^)]+)\)/) || [])[1] || 'given';
        kind = 'sample';
        text = `Sample ${status} — ${e.detail}`;
      } else {
        kind = 'other';
        text = `${e.type}: ${e.detail}`;
      }
      return { date: e.date, kind, text };
    });

  const allItems = [...collapsedSales, ...otherEvents]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // ─── Group by month for easy scanning ────────────────────────────────────
  const byMonth = new Map();
  for (const item of allItems) {
    const mk = _hist_monthKey(item.date);
    if (!byMonth.has(mk)) byMonth.set(mk, []);
    byMonth.get(mk).push(item);
  }

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MAX_ITEMS = 30;
  let shown = 0;
  for (const [mk, items] of byMonth) {
    if (shown >= MAX_ITEMS) break;
    let label;
    if (mk === 'unknown') {
      label = 'Older';
    } else {
      const [y, m] = mk.split('-');
      label = `${MONTHS[parseInt(m, 10) - 1]} ${y}`;
    }
    out += `━━━ *${label}* ━━━\n`;
    for (const item of items) {
      if (shown >= MAX_ITEMS) break;
      const icon = item.kind === 'sale' ? '💰'
        : item.kind === 'pay' ? '💳'
        : item.kind === 'order' ? '📦'
        : item.kind === 'sample' ? '🧪'
        : '📌';
      out += `${icon} ${_hist_dayOf(item.date)}  ${item.text}\n`;
      shown++;
    }
    out += `\n`;
  }

  const totalItems = allItems.length;
  if (totalItems > MAX_ITEMS) out += `_...and ${totalItems - MAX_ITEMS} earlier interaction${totalItems - MAX_ITEMS > 1 ? 's' : ''}_\n`;
  out += `*${totalItems} total interaction${totalItems > 1 ? 's' : ''}*`;

  await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
}

async function sendCustomerPatternReport(bot, chatId, customerName) {
  const pattern = await buildCustomerPattern(customerName);
  if (!pattern) {
    await bot.sendMessage(chatId, `No purchase data found for "${customerName}".`);
    return;
  }
  const hasPrices = pattern.totalValue > 0;
  const rankBasis = hasPrices ? pattern.totalValue : pattern.totalYards;
  const sortedItems = hasPrices
    ? pattern.items
    : [...pattern.items].sort((a, b) => b.yards - a.yards);

  let out = `🔍 *Purchase Pattern — ${customerName}*\n\n`;
  out += `📅 First purchase: ${fmtDate(pattern.firstDate) || pattern.firstDate} | Last: ${fmtDate(pattern.lastDate) || pattern.lastDate}\n`;
  out += `📊 Lifetime: ${pattern.totalPkgs} pkgs, ${pattern.totalThans} thans, ${fmtQty(pattern.totalYards)} yds`;
  out += hasPrices ? ` — ${fmtMoney(pattern.totalValue)}\n\n` : `\n_(no price data available for these sales)_\n\n`;
  out += hasPrices ? `*Preferred Items (by value):*\n` : `*Preferred Items (by volume):*\n`;
  let rank = 0;
  for (const ds of sortedItems) {
    rank++;
    const thisMetric = hasPrices ? ds.value : ds.yards;
    const pct = rankBasis > 0 ? Math.round((thisMetric / rankBasis) * 100) : 0;
    const valueStr = hasPrices ? ` — ${fmtMoney(ds.value)}` : '';
    out += `${rank}. ${ds.design} Shade ${ds.shade}: ${ds.pkgs.size} pkgs, ${fmtQty(ds.yards)} yds${valueStr} (${pct}%)\n`;
  }
  const top = sortedItems[0];
  const topMetric = hasPrices ? top.value : top.yards;
  const topPct = rankBasis > 0 ? Math.round((topMetric / rankBasis) * 100) : 0;
  out += `\n*Top design: ${top.design} Shade ${top.shade} (${topPct}% of ${hasPrices ? 'value' : 'volume'})*`;
  await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
}

async function sendCustomerNotesReport(bot, chatId, customerName) {
  const notes = await customerNotesRepo.getByCustomer(customerName);
  if (!notes.length) {
    await bot.sendMessage(chatId,
      `No notes found for "${customerName}". Add with: "Note for ${customerName}: your note here"`);
    return;
  }
  let out = `📝 *Notes for ${customerName}* (${notes.length})\n\n`;
  for (const n of notes.slice(-15)) {
    out += `• ${fmtDate(n.created_at) || '-'}: ${n.note}\n`;
  }
  if (notes.length > 15) out += `\n_Showing last 15 of ${notes.length} notes_`;
  await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
}

async function sendCustomerRankingReport(bot, chatId) {
  const ranked = await buildCustomerRanking();
  if (!ranked.length) {
    await bot.sendMessage(chatId, 'No sales data found.');
    return;
  }
  const topValue = ranked[0][1].value;
  let out = `🏆 *Customer Ranking — Top ${Math.min(ranked.length, 20)} by Value*\n`;
  out += `_Bar shows each customer's value as % of #1 buyer (${fmtMoney(topValue)})_\n\n`;
  let rank = 0;
  const medals = ['🥇', '🥈', '🥉'];
  for (const [name, c] of ranked.slice(0, 20)) {
    const medal = rank < 3 ? medals[rank] : `${rank + 1}.`;
    const lastMs = c.lastDate ? new Date(c.lastDate).getTime() : NaN;
    const daysAgo = Number.isFinite(lastMs)
      ? `${Math.floor((Date.now() - lastMs) / 86400000)}d ago`
      : (c.lastDate ? fmtDate(c.lastDate) : '—');
    out += `${medal} *${name}*\n`;
    out += `   ${c.pkgs.size} pkgs, ${c.thans} thans, ${fmtQty(c.yards)} yds\n`;
    out += `   Value: ${fmtMoney(c.value)} | Last: ${daysAgo}\n`;
    out += `   ${fmtBar(c.value, topValue, 'of #1')}\n\n`;
    rank++;
  }
  const grandValue = ranked.reduce((s, [, c]) => s + c.value, 0);
  out += `*Total Customers: ${ranked.length} | Total Value: ${fmtMoney(grandValue)}*`;
  await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
}

async function sendSampleStatusReport(bot, chatId, options = {}) {
  // Back-compat: a plain string arg used to mean `design`.
  if (typeof options === 'string') options = { design: options };
  const { design = null, daysBack = null } = options || {};

  let samples;
  let title;
  if (design) {
    samples = await samplesRepo.getByDesign(design);
    samples = samples.filter((s) => s.status === 'with_customer');
    title = `📋 *Sample Status — Design ${design}*`;
  } else {
    samples = await samplesRepo.getActive();
    if (daysBack && Number.isFinite(daysBack)) {
      const cutoff = Date.now() - daysBack * 86400000;
      samples = samples.filter((s) => {
        const t = s.date_given ? new Date(s.date_given).getTime() : NaN;
        return Number.isFinite(t) && t >= cutoff;
      });
      title = `📋 *Sample Status — Last ${daysBack} days*`;
    } else {
      title = '📋 *Sample Status — All Active*';
    }
  }
  if (!samples.length) {
    const hint = daysBack ? ` in the last ${daysBack} days` : '';
    await bot.sendMessage(chatId, `No active samples found${hint}.`);
    return;
  }
  const report = buildSampleStatusReport(samples, title);
  await sendLong(bot, chatId, report, { parse_mode: 'Markdown' });
}

/* ─── Give Sample Button Flow ─────────────────────────────────────────────
 * Full tap-driven flow: design → shade → customer → qty → type → follow-up
 * → confirm. Uses a single evolving message that carries a breadcrumb header
 * so the user never loses context of what's been picked so far.
 *
 * Session shape: { type: 'sample_flow', step, design, shade, customer,
 *                  quantity, sample_type, followup_date, requestedBy,
 *                  flowMessageId (for in-place editing) }
 */

function _sampleHeader(session) {
  const lines = ['🧪 *Give Sample*'];
  if (session.design) lines.push(`✓ Design: *${session.design}*${session.shade ? ' Shade ' + session.shade : ''}`);
  if (session.customer) lines.push(`✓ Customer: *${session.customer}*`);
  if (session.quantity) lines.push(`✓ Qty: *${session.quantity} pcs*`);
  if (session.sample_type) lines.push(`✓ Type: *${session.sample_type}*`);
  if (session.followup_date) lines.push(`✓ Follow-up: *${fmtDate(session.followup_date) || session.followup_date}*`);
  return lines.join('\n');
}

async function _sampleRender(bot, chatId, userId, prompt, rows) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const text = _sampleHeader(session) + '\n\n' + prompt;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  const mid = session.flowMessageId;
  if (mid) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...opts });
      return;
    } catch (_) { /* fall through to send */ }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  session.flowMessageId = sent.message_id;
  sessionStore.set(userId, session);
}

async function startSampleFlowButton(bot, chatId, userId, messageId = null) {
  sessionStore.set(userId, {
    type: 'sample_flow', step: 'design', requestedBy: userId,
    flowMessageId: messageId || null,
  });
  await showSampleDesignPicker(bot, chatId, userId);
}

async function showSampleDesignPicker(bot, chatId, userId, showAll = false) {
  const raw = await inventoryRepository.getDistinctDesigns();
  const designs = [...new Set(raw.map((d) => (d.design || '').trim()).filter(Boolean))].sort();
  if (!designs.length) {
    await bot.sendMessage(chatId, 'No designs found in inventory.');
    sessionStore.clear(userId);
    return;
  }
  const MAX_VISIBLE = 12;
  const visible = showAll ? designs : designs.slice(0, MAX_VISIBLE);
  const rows = [];
  for (let i = 0; i < visible.length; i += 3) {
    const row = [];
    for (let j = i; j < i + 3 && j < visible.length; j++) {
      row.push({ text: visible[j], callback_data: `smd:${visible[j].slice(0, 55)}` });
    }
    rows.push(row);
  }
  if (!showAll && designs.length > MAX_VISIBLE) {
    rows.push([{ text: `📋 See All (${designs.length})`, callback_data: 'smd:__more__' }]);
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'smcanc:0' }]);
  await _sampleRender(bot, chatId, userId, 'Pick a design:', rows);
}

async function showSampleShadePicker(bot, chatId, userId, design) {
  const allInv = await inventoryRepository.getAll();
  const shades = [...new Set(
    allInv.filter((r) => r.design === design).map((r) => r.shade || '-'),
  )].sort();
  if (!shades.length) {
    await bot.sendMessage(chatId, `No shades found for design ${design}.`);
    sessionStore.clear(userId);
    return;
  }
  const rows = [];
  for (let i = 0; i < shades.length; i += 2) {
    const row = [{ text: `🎨 ${shades[i]}`, callback_data: `smsh:${shades[i].slice(0, 55)}` }];
    if (shades[i + 1]) row.push({ text: `🎨 ${shades[i + 1]}`, callback_data: `smsh:${shades[i + 1].slice(0, 55)}` });
    rows.push(row);
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'smcanc:0' }]);
  await _sampleRender(bot, chatId, userId, 'Pick a shade:', rows);
}

async function showSampleCustomerPicker(bot, chatId, userId, showAll = false) {
  const session = sessionStore.get(userId);
  if (!session) return;

  const allCust = await customersRepo.getAll();
  const active = allCust.filter((c) => (c.status || 'Active').toLowerCase() === 'active' && c.name);

  const topBuyers = await getTopBuyersForDesigns([session.design]);
  const suggestedSet = new Set(topBuyers.slice(0, 6));
  const suggested = active.filter((c) => suggestedSet.has(c.name));
  const remaining = active.filter((c) => !suggestedSet.has(c.name)).sort((a, b) => a.name.localeCompare(b.name));

  const list = showAll ? remaining : (suggested.length ? suggested : active.slice(0, 6));
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    const icon = showAll ? '👤' : '⭐';
    const row = [{ text: `${icon} ${list[i].name}`, callback_data: `smcu:${list[i].name.slice(0, 55)}` }];
    if (list[i + 1]) row.push({ text: `${icon} ${list[i + 1].name}`, callback_data: `smcu:${list[i + 1].name.slice(0, 55)}` });
    rows.push(row);
  }
  if (!showAll && remaining.length) {
    rows.push([{ text: '📋 See More Customers', callback_data: 'smcu:__more__' }]);
  }
  rows.push([{ text: '➕ Add New Customer', callback_data: 'smcu:__new__' }]);
  rows.push([{ text: '❌ Cancel', callback_data: 'smcanc:0' }]);

  const prompt = showAll ? 'All other customers:' : 'Who is this sample for?\n(⭐ top buyers of this design)';
  await _sampleRender(bot, chatId, userId, prompt, rows);
}

async function showSampleQuantityPicker(bot, chatId, userId) {
  const rows = [
    [
      { text: '1 pc',  callback_data: 'smq:1' },
      { text: '2 pcs', callback_data: 'smq:2' },
      { text: '3 pcs', callback_data: 'smq:3' },
      { text: '5 pcs', callback_data: 'smq:5' },
    ],
    [{ text: '✏️ Custom', callback_data: 'smq:__custom__' }],
    [{ text: '❌ Cancel', callback_data: 'smcanc:0' }],
  ];
  await _sampleRender(bot, chatId, userId, 'How many sample pieces?', rows);
}

async function showSampleTypePicker(bot, chatId, userId) {
  const rows = [
    [
      { text: 'Type A', callback_data: 'smpt:A' },
      { text: 'Type B', callback_data: 'smpt:B' },
      { text: 'Type C', callback_data: 'smpt:C' },
    ],
    [{ text: '❌ Cancel', callback_data: 'smcanc:0' }],
  ];
  await _sampleRender(bot, chatId, userId, 'Select sample type:', rows);
}

async function showSampleFollowupPicker(bot, chatId, userId) {
  const now = new Date();
  const mkDate = (d) => d.toISOString().slice(0, 10);
  const d3 = mkDate(new Date(now.getTime() + 3 * 86400000));
  const d7 = mkDate(new Date(now.getTime() + 7 * 86400000));
  const d14 = mkDate(new Date(now.getTime() + 14 * 86400000));
  const rows = [
    [
      { text: `📅 ${fmtDate(d3)} (+3d)`,  callback_data: `smfq:${d3}` },
      { text: `📅 ${fmtDate(d7)} (+7d)`,  callback_data: `smfq:${d7}` },
    ],
    [
      { text: `📅 ${fmtDate(d14)} (+14d)`, callback_data: `smfq:${d14}` },
      { text: '🗓️ Pick from calendar',    callback_data: 'smfcal:0' },
    ],
    [{ text: '❌ Cancel', callback_data: 'smcanc:0' }],
  ];
  await _sampleRender(bot, chatId, userId, 'When to follow up with customer?', rows);
}

async function showSampleConfirmation(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const rows = [
    [
      { text: '✅ Submit for Approval', callback_data: 'smpconf:1' },
      { text: '❌ Cancel', callback_data: 'smcanc:0' },
    ],
  ];
  await _sampleRender(bot, chatId, userId, '*Confirm and submit?*', rows);
}

/* ─── Add Customer Button Flow ────────────────────────────────────────────
 * name (text) → phone (text/skip) → address (text/skip) → category (tap)
 * → credit limit (tap preset or custom) → payment terms (text)
 * → notes (text/skip) → confirm (tap) → 2-admin approval queue.
 *
 * Session shape: { type: 'add_customer_flow', step, name, phone, address,
 *                  category, credit_limit, payment_terms, notes,
 *                  flowMessageId }
 */

const CUSTOMER_CATEGORIES = ['Wholesale', 'Retail', 'Distributor', 'Wholesaler'];
const CREDIT_PRESETS = [0, 50000, 100000, 200000, 500000];

function _acHeader(session) {
  const lines = ['👥 *Add Customer*'];
  if (session.name) lines.push(`✓ Name: *${session.name}*`);
  if (session.phone) lines.push(`✓ Phone: *${session.phone}*`);
  if (session.phone === '') lines.push(`✓ Phone: _skipped_`);
  if (session.address) lines.push(`✓ Address: *${session.address}*`);
  if (session.address === '') lines.push(`✓ Address: _skipped_`);
  if (session.category) lines.push(`✓ Category: *${session.category}*`);
  if (session.credit_limit !== undefined && session.credit_limit !== null) {
    lines.push(`✓ Credit limit: *${fmtMoney(session.credit_limit)}*`);
  }
  if (session.payment_terms) lines.push(`✓ Payment terms: *${session.payment_terms}*`);
  if (session.notes) lines.push(`✓ Notes: *${session.notes}*`);
  if (session.notes === '') lines.push(`✓ Notes: _skipped_`);
  return lines.join('\n');
}

async function _acRender(bot, chatId, userId, prompt, rows) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const text = _acHeader(session) + '\n\n' + prompt;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  const mid = session.flowMessageId;
  if (mid) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...opts });
      return;
    } catch (_) { /* fall through */ }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  session.flowMessageId = sent.message_id;
  sessionStore.set(userId, session);
}

async function startAddCustomerFlow(bot, chatId, userId, messageId = null) {
  sessionStore.set(userId, {
    type: 'add_customer_flow', step: 'name', requestedBy: userId,
    flowMessageId: messageId || null,
  });
  // Entry screen: explain flow, offer Cancel. Name is captured via free text.
  const rows = [[{ text: '❌ Cancel', callback_data: 'accanc:0' }]];
  await _acRender(bot, chatId, userId, 'Enter the customer *full name* (reply in chat):', rows);
}

async function showAddCustomerPhoneStep(bot, chatId, userId) {
  const rows = [
    [{ text: '⏭ Skip phone', callback_data: 'acskip:phone' }],
    [{ text: '❌ Cancel', callback_data: 'accanc:0' }],
  ];
  await _acRender(bot, chatId, userId, 'Enter *phone number* (or tap Skip):', rows);
}

async function showAddCustomerAddressStep(bot, chatId, userId) {
  const rows = [
    [{ text: '⏭ Skip address', callback_data: 'acskip:address' }],
    [{ text: '❌ Cancel', callback_data: 'accanc:0' }],
  ];
  await _acRender(bot, chatId, userId, 'Enter *address* (or tap Skip):', rows);
}

async function showAddCustomerCategoryPicker(bot, chatId, userId) {
  const rows = [];
  for (let i = 0; i < CUSTOMER_CATEGORIES.length; i += 2) {
    const row = [{ text: `🏷 ${CUSTOMER_CATEGORIES[i]}`, callback_data: `accat:${CUSTOMER_CATEGORIES[i]}` }];
    if (CUSTOMER_CATEGORIES[i + 1]) row.push({ text: `🏷 ${CUSTOMER_CATEGORIES[i + 1]}`, callback_data: `accat:${CUSTOMER_CATEGORIES[i + 1]}` });
    rows.push(row);
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'accanc:0' }]);
  await _acRender(bot, chatId, userId, 'Pick *category*:', rows);
}

async function showAddCustomerCreditPicker(bot, chatId, userId) {
  const rows = [];
  // 3-per-row grid: 0 / 50k / 100k, 200k / 500k / Custom
  const cells = [
    ...CREDIT_PRESETS.map((v) => ({ text: v === 0 ? '₦ 0' : `₦ ${(v / 1000).toFixed(0)}k`, callback_data: `accred:${v}` })),
    { text: '✏️ Custom', callback_data: 'accred:__custom__' },
  ];
  for (let i = 0; i < cells.length; i += 3) {
    rows.push(cells.slice(i, i + 3));
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'accanc:0' }]);
  await _acRender(bot, chatId, userId, 'Pick *credit limit*:', rows);
}

async function showAddCustomerPaymentTermsStep(bot, chatId, userId) {
  // Payment terms stays as free-text (Q3 answer). Offer common hint + cancel.
  const rows = [
    [
      { text: 'COD',    callback_data: 'acpt:COD' },
      { text: 'Net 7',  callback_data: 'acpt:Net 7' },
      { text: 'Net 14', callback_data: 'acpt:Net 14' },
    ],
    [
      { text: 'Net 30', callback_data: 'acpt:Net 30' },
      { text: 'Credit', callback_data: 'acpt:Credit' },
      { text: '✏️ Custom', callback_data: 'acpt:__custom__' },
    ],
    [{ text: '❌ Cancel', callback_data: 'accanc:0' }],
  ];
  await _acRender(bot, chatId, userId, 'Pick *payment terms*:', rows);
}

async function showAddCustomerNotesStep(bot, chatId, userId) {
  const rows = [
    [{ text: '⏭ Skip notes', callback_data: 'acskip:notes' }],
    [{ text: '❌ Cancel', callback_data: 'accanc:0' }],
  ];
  await _acRender(bot, chatId, userId, 'Add any *notes* (or tap Skip):', rows);
}

async function showAddCustomerConfirmation(bot, chatId, userId) {
  const rows = [[
    { text: '✅ Submit for Approval', callback_data: 'acconf:1' },
    { text: '❌ Cancel', callback_data: 'accanc:0' },
  ]];
  await _acRender(bot, chatId, userId, '*Confirm and submit for admin approval?*', rows);
}

/* ─── Bank Manager (admin-only, tap-based) ────────────────────────────────
 * Shows current banks as tappable buttons; taps trigger a remove-confirm.
 * An "➕ Add New Bank" button asks for a bank name (free-text, only this
 * one text input in the flow). All mutations go through 2-admin approval.
 */

async function showBankManager(bot, chatId, userId, messageId = null) {
  const all = await settingsRepo.getAll();
  const banks = (all.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean);

  const rows = [];
  if (banks.length) {
    for (let i = 0; i < banks.length; i += 2) {
      const row = [{ text: `🏦 ${banks[i]}  ✕`, callback_data: `bkrm:${banks[i].slice(0, 50)}` }];
      if (banks[i + 1]) row.push({ text: `🏦 ${banks[i + 1]}  ✕`, callback_data: `bkrm:${banks[i + 1].slice(0, 50)}` });
      rows.push(row);
    }
  }
  rows.push([{ text: '➕ Add New Bank', callback_data: 'bkadd:0' }]);
  rows.push([{ text: '⬅ Back', callback_data: 'act:__back__' }]);

  const text = `🏦 *Bank Manager*\n\nRegistered banks: ${banks.length}\n_Tap a bank to remove it. Changes go to 2-admin approval._`;
  await editOrSend(bot, chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function showBankRemoveConfirm(bot, chatId, bankName, messageId = null) {
  const rows = [[
    { text: '✅ Confirm Remove', callback_data: `bkrmc:${bankName.slice(0, 50)}` },
    { text: '❌ Cancel',         callback_data: 'bkback:0' },
  ]];
  const text = `🏦 *Remove Bank*\n\nBank: *${bankName}*\n\n_This will queue a 2-admin approval to remove it from the payment options._`;
  await editOrSend(bot, chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

/* ─── Update Price tap flow ──────────────────────────────────────────────
 * Design pick → Shade pick (or All) → nudge presets → confirm → queue approval.
 * Session: { type: 'update_price_flow', design, shade, currentPrice, newPrice, flowMessageId }
 */
async function startUpdatePriceFlow(bot, chatId, userId, messageId = null) {
  const designs = await inventoryRepository.getDistinctDesigns();
  const uniqDesigns = [...new Set(designs.map((d) => String(d.design || '').trim()).filter(Boolean))].sort();
  if (!uniqDesigns.length) {
    await editOrSend(bot, chatId, messageId, 'No designs in inventory.', {});
    return;
  }
  sessionStore.set(userId, { type: 'update_price_flow', step: 'design', flowMessageId: messageId || null });
  const rows = [];
  for (let i = 0; i < uniqDesigns.length; i += 3) {
    rows.push(uniqDesigns.slice(i, i + 3).map((d) => ({ text: d, callback_data: `upd:${d.slice(0, 50)}` })));
  }
  if (rows.length > 15) rows.splice(15);
  rows.push([{ text: '❌ Cancel', callback_data: 'upcanc:0' }]);
  await editOrSend(bot, chatId, messageId,
    '💲 *Update Price*\n\nSelect the design:',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function showUpdatePriceShadePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const all = await inventoryRepository.getAll();
  const shades = [...new Set(all
    .filter((r) => String(r.design || '').trim().toUpperCase() === String(session.design).toUpperCase())
    .map((r) => String(r.shade || '').trim())
    .filter(Boolean))].sort();
  const rows = [[{ text: '🎨 All shades', callback_data: 'ups:__all__' }]];
  for (let i = 0; i < shades.length; i += 3) {
    rows.push(shades.slice(i, i + 3).map((s) => ({ text: `🎨 ${s}`, callback_data: `ups:${s.slice(0, 50)}` })));
  }
  if (rows.length > 15) rows.splice(15);
  rows.push([{ text: '❌ Cancel', callback_data: 'upcanc:0' }]);
  const text = `💲 *Update Price*\n\n✓ Design: *${session.design}*\n\nSelect shade:`;
  await editOrSend(bot, chatId, session.flowMessageId, text,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function showUpdatePriceNudgePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  // Find current price (most recent) for the filter.
  const all = await inventoryRepository.getAll();
  const matches = all.filter((r) => {
    if (String(r.design || '').trim().toUpperCase() !== String(session.design).toUpperCase()) return false;
    if (session.shade !== '__all__' && String(r.shade || '').trim().toUpperCase() !== String(session.shade).toUpperCase()) return false;
    return true;
  });
  const prices = matches.map((r) => Number(r.pricePerYard)).filter((n) => Number.isFinite(n) && n > 0);
  const currentPrice = prices.length ? prices[prices.length - 1] : 0;
  session.currentPrice = currentPrice;
  sessionStore.set(userId, session);

  const base = currentPrice || 1000;
  const mk = (d) => ({ text: `${d >= 0 ? '+' : ''}${d}`, callback_data: `upn:${base + d}` });
  const rows = [
    [mk(-20), mk(-10), mk(-5), mk(5), mk(10), mk(20)],
    [{ text: '✏️ Custom price', callback_data: 'upn:__custom__' }],
    [{ text: '❌ Cancel', callback_data: 'upcanc:0' }],
  ];
  const shadeLabel = session.shade === '__all__' ? 'All shades' : session.shade;
  const text = `💲 *Update Price*\n\n✓ Design: *${session.design}*\n✓ Shade: *${shadeLabel}*\n` +
               `💰 Current price: *${currentPrice ? fmtMoney(currentPrice) : '—'}/yard*\n\nPick a nudge or enter custom:`;
  await editOrSend(bot, chatId, session.flowMessageId, text,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function showUpdatePriceConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const shadeLabel = session.shade === '__all__' ? 'All shades' : session.shade;
  const text = `💲 *Confirm Price Update*\n\nDesign: *${session.design}*\nShade: *${shadeLabel}*\n` +
               `Before: *${session.currentPrice ? fmtMoney(session.currentPrice) : '—'}/yard*\n` +
               `After:  *${fmtMoney(session.newPrice)}/yard*\n\n_Will be queued for 2-admin approval._`;
  await editOrSend(bot, chatId, session.flowMessageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Submit for Approval', callback_data: 'upconf:1' },
      { text: '❌ Cancel', callback_data: 'upcanc:0' },
    ]] },
  });
}

/* ─── Transfer Package tap flow ─────────────────────────────────────────── */
async function startTransferPackageFlow(bot, chatId, userId, messageId = null) {
  const all = await inventoryRepository.getAll();
  // Packages with at least one available than.
  const byPkg = new Map();
  all.forEach((r) => {
    if (r.status !== 'available') return;
    const key = String(r.packageNo || '').trim();
    if (!key) return;
    if (!byPkg.has(key)) byPkg.set(key, { pkg: key, design: r.design, shade: r.shade, warehouse: r.warehouse, count: 0 });
    byPkg.get(key).count += 1;
  });
  const pkgs = [...byPkg.values()].sort((a, b) => String(a.pkg).localeCompare(String(b.pkg)));
  if (!pkgs.length) {
    await editOrSend(bot, chatId, messageId, 'No packages with available thans to transfer.', {});
    return;
  }
  sessionStore.set(userId, { type: 'transfer_package_flow', step: 'package', flowMessageId: messageId || null });
  const rows = [];
  pkgs.slice(0, 30).forEach((p) => {
    rows.push([{ text: `📦 ${p.pkg} · ${p.design}${p.shade ? ' ' + p.shade : ''} (${p.count}) · ${p.warehouse}`, callback_data: `tpp:${p.pkg.slice(0, 50)}` }]);
  });
  rows.push([{ text: '❌ Cancel', callback_data: 'tpcanc:0' }]);
  await editOrSend(bot, chatId, messageId,
    '🚚 *Transfer Package*\n\nSelect the package to transfer:',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function showTransferPackageWarehousePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const info = await inventoryService.getPackageSummary(session.packageNo);
  session.fromWh = info?.warehouse || '?';
  session.design = info?.design || '';
  session.shade = info?.shade || '';
  session.availableThans = info?.availableThans || 0;
  session.availableYards = info?.availableYards || 0;
  sessionStore.set(userId, session);

  const whs = await inventoryRepository.getWarehouses();
  const options = whs.filter((w) => String(w).trim() && String(w).trim() !== String(session.fromWh).trim());
  if (!options.length) {
    await editOrSend(bot, chatId, session.flowMessageId, 'No other warehouses available.', {});
    return;
  }
  const rows = [];
  for (let i = 0; i < options.length; i += 2) {
    const row = [{ text: `🏭 ${options[i]}`, callback_data: `tpw:${String(options[i]).slice(0, 50)}` }];
    if (options[i + 1]) row.push({ text: `🏭 ${options[i + 1]}`, callback_data: `tpw:${String(options[i + 1]).slice(0, 50)}` });
    rows.push(row);
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'tpcanc:0' }]);
  const text = `🚚 *Transfer Package*\n\n✓ Package: *${session.packageNo}*\n` +
               `Design: ${session.design}${session.shade ? ' ' + session.shade : ''}\n` +
               `Thans: ${session.availableThans} · Yards: ${fmtQty(session.availableYards)}\n` +
               `From: *${session.fromWh}*\n\nSelect destination warehouse:`;
  await editOrSend(bot, chatId, session.flowMessageId, text,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function showTransferPackageConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const text = `🚚 *Confirm Transfer Package*\n\nPackage: *${session.packageNo}*\n` +
               `Design: ${session.design}${session.shade ? ' ' + session.shade : ''}\n` +
               `Thans: ${session.availableThans} · Yards: ${fmtQty(session.availableYards)}\n` +
               `From: *${session.fromWh}*  →  To: *${session.toWh}*\n\n_Queues 2-admin approval._`;
  await editOrSend(bot, chatId, session.flowMessageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Submit for Approval', callback_data: 'tpconf:1' },
      { text: '❌ Cancel', callback_data: 'tpcanc:0' },
    ]] },
  });
}

/* ─── Transfer Than tap flow ─────────────────────────────────────────── */
async function startTransferThanFlow(bot, chatId, userId, messageId = null) {
  const all = await inventoryRepository.getAll();
  const byPkg = new Map();
  all.forEach((r) => {
    if (r.status !== 'available') return;
    const key = String(r.packageNo || '').trim();
    if (!key) return;
    if (!byPkg.has(key)) byPkg.set(key, { pkg: key, design: r.design, shade: r.shade, warehouse: r.warehouse, count: 0 });
    byPkg.get(key).count += 1;
  });
  const pkgs = [...byPkg.values()].sort((a, b) => String(a.pkg).localeCompare(String(b.pkg)));
  if (!pkgs.length) {
    await editOrSend(bot, chatId, messageId, 'No packages with available thans to transfer.', {});
    return;
  }
  sessionStore.set(userId, { type: 'transfer_than_flow', step: 'package', flowMessageId: messageId || null });
  const rows = [];
  pkgs.slice(0, 30).forEach((p) => {
    rows.push([{ text: `📦 ${p.pkg} · ${p.design}${p.shade ? ' ' + p.shade : ''} (${p.count}) · ${p.warehouse}`, callback_data: `ttp:${p.pkg.slice(0, 50)}` }]);
  });
  rows.push([{ text: '❌ Cancel', callback_data: 'ttcanc:0' }]);
  await editOrSend(bot, chatId, messageId,
    '↔️ *Transfer Than*\n\nSelect the package:',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function showTransferThanThanPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const info = await inventoryService.getPackageSummary(session.packageNo);
  session.fromWh = info?.warehouse || '?';
  session.design = info?.design || '';
  session.shade = info?.shade || '';
  sessionStore.set(userId, session);
  const availableThans = (info?.thans || []).filter((t) => t.status === 'available');
  if (!availableThans.length) {
    await editOrSend(bot, chatId, session.flowMessageId, 'No available thans in this package.', {});
    return;
  }
  const rows = [];
  for (let i = 0; i < availableThans.length; i += 3) {
    rows.push(availableThans.slice(i, i + 3).map((t) => ({
      text: `#${t.thanNo} · ${fmtQty(t.yards)}y`, callback_data: `tth:${t.thanNo}`,
    })));
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'ttcanc:0' }]);
  const text = `↔️ *Transfer Than*\n\n✓ Package: *${session.packageNo}* (${session.design}${session.shade ? ' ' + session.shade : ''})\nFrom: *${session.fromWh}*\n\nSelect the than to transfer:`;
  await editOrSend(bot, chatId, session.flowMessageId, text,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function showTransferThanWarehousePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const whs = await inventoryRepository.getWarehouses();
  const options = whs.filter((w) => String(w).trim() && String(w).trim() !== String(session.fromWh).trim());
  if (!options.length) {
    await editOrSend(bot, chatId, session.flowMessageId, 'No other warehouses available.', {});
    return;
  }
  const rows = [];
  for (let i = 0; i < options.length; i += 2) {
    const row = [{ text: `🏭 ${options[i]}`, callback_data: `ttw:${String(options[i]).slice(0, 50)}` }];
    if (options[i + 1]) row.push({ text: `🏭 ${options[i + 1]}`, callback_data: `ttw:${String(options[i + 1]).slice(0, 50)}` });
    rows.push(row);
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'ttcanc:0' }]);
  const text = `↔️ *Transfer Than*\n\n✓ Package: *${session.packageNo}*\n✓ Than: *#${session.thanNo}*\nFrom: *${session.fromWh}*\n\nSelect destination warehouse:`;
  await editOrSend(bot, chatId, session.flowMessageId, text,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function showTransferThanConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const text = `↔️ *Confirm Transfer Than*\n\nPackage: *${session.packageNo}*\nThan: *#${session.thanNo}*\nDesign: ${session.design}${session.shade ? ' ' + session.shade : ''}\nFrom: *${session.fromWh}*  →  To: *${session.toWh}*\n\n_Queues 2-admin approval._`;
  await editOrSend(bot, chatId, session.flowMessageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Submit for Approval', callback_data: 'ttconf:1' },
      { text: '❌ Cancel', callback_data: 'ttcanc:0' },
    ]] },
  });
}

/* ─── Return Than tap flow ──────────────────────────────────────────────
 * List packages that have at least one SOLD than; pick package → pick sold
 * than → confirm → queue approval (mark than available again).
 */
async function startReturnThanFlow(bot, chatId, userId, messageId = null) {
  const all = await inventoryRepository.getAll();
  const byPkg = new Map();
  all.forEach((r) => {
    if (r.status !== 'sold') return;
    const key = String(r.packageNo || '').trim();
    if (!key) return;
    if (!byPkg.has(key)) byPkg.set(key, { pkg: key, design: r.design, shade: r.shade, count: 0 });
    byPkg.get(key).count += 1;
  });
  const pkgs = [...byPkg.values()].sort((a, b) => String(a.pkg).localeCompare(String(b.pkg)));
  if (!pkgs.length) {
    await editOrSend(bot, chatId, messageId, 'No sold thans to return.', {});
    return;
  }
  sessionStore.set(userId, { type: 'return_than_flow', step: 'package', flowMessageId: messageId || null });
  const rows = [];
  pkgs.slice(0, 30).forEach((p) => {
    rows.push([{ text: `📦 ${p.pkg} · ${p.design}${p.shade ? ' ' + p.shade : ''} (${p.count} sold)`, callback_data: `rtp:${p.pkg.slice(0, 50)}` }]);
  });
  rows.push([{ text: '❌ Cancel', callback_data: 'rtcanc:0' }]);
  await editOrSend(bot, chatId, messageId,
    '↩️ *Return Than*\n\nSelect the package containing the than to return:',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function showReturnThanThanPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const info = await inventoryService.getPackageSummary(session.packageNo);
  session.design = info?.design || '';
  session.shade = info?.shade || '';
  sessionStore.set(userId, session);
  const soldThans = (info?.thans || []).filter((t) => t.status === 'sold');
  if (!soldThans.length) {
    await editOrSend(bot, chatId, session.flowMessageId, 'No sold thans in this package.', {});
    return;
  }
  const rows = [];
  for (let i = 0; i < soldThans.length; i += 2) {
    const mk = (t) => ({ text: `#${t.thanNo} · ${fmtQty(t.yards)}y · ${t.soldTo || '—'}`, callback_data: `rth:${t.thanNo}` });
    const row = [mk(soldThans[i])];
    if (soldThans[i + 1]) row.push(mk(soldThans[i + 1]));
    rows.push(row);
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'rtcanc:0' }]);
  const text = `↩️ *Return Than*\n\n✓ Package: *${session.packageNo}* (${session.design}${session.shade ? ' ' + session.shade : ''})\n\nSelect the sold than to return:`;
  await editOrSend(bot, chatId, session.flowMessageId, text,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function showReturnThanConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const text = `↩️ *Confirm Return Than*\n\nPackage: *${session.packageNo}*\nThan: *#${session.thanNo}*\nDesign: ${session.design}${session.shade ? ' ' + session.shade : ''}\n\n_Will mark the than available again. Queues 2-admin approval._`;
  await editOrSend(bot, chatId, session.flowMessageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Submit for Approval', callback_data: 'rtconf:1' },
      { text: '❌ Cancel', callback_data: 'rtcanc:0' },
    ]] },
  });
}

/** Date-range picker shown when user taps the Sample Status button. */
async function showSampleStatusDatePicker(bot, chatId, messageId = null) {
  const text = '🧪 *Sample Status*\n\nPick a time window:';
  const markup = {
    inline_keyboard: [
      [
        { text: '📅 Last 7 days',  callback_data: 'smsd:7' },
        { text: '📅 Last 30 days', callback_data: 'smsd:30' },
      ],
      [
        { text: '📅 Last 90 days', callback_data: 'smsd:90' },
        { text: '📋 All active',   callback_data: 'smsd:all' },
      ],
    ],
  };
  const opts = { parse_mode: 'Markdown', reply_markup: markup };
  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }).catch(async () => {
      await bot.sendMessage(chatId, text, opts);
    });
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

/* ─── Customer Picker for Report Buttons ──────────────────────────────────
 * Shared picker used by button-triggered reports (history / pattern / notes).
 * Emits callback_data `rpt:<reportType>:<customerName>` on selection and
 * `rpt:<reportType>:__more__` to expand the full list.
 *
 * We send customer names directly in callback_data (same pattern as
 * showSupplyCustomerPicker). Telegram's 64-byte limit on callback_data
 * means customer names longer than ~50 bytes would fail; in practice this
 * codebase's customers are short (CJE, Christ, BLESSING, etc.). If long
 * names ever appear, switch to an index-based scheme.
 */
const REPORT_PICKER_PROMPTS = {
  history:   { icon: '📋', label: 'Customer History', prompt: 'Pick a customer to see their timeline:' },
  pattern:   { icon: '🔍', label: 'Customer Pattern', prompt: 'Pick a customer to see their buying pattern:' },
  notes:     { icon: '📝', label: 'Customer Notes',   prompt: 'Pick a customer to see their notes:' },
  writenote: { icon: '✏️', label: 'Add Note',         prompt: 'Pick a customer to add a note for:' },
};

/** Entry point for the Add Note activity (tap-driven). */
async function startAddNoteFlow(bot, chatId, userId, messageId = null) {
  await showCustomerPickerForReport(bot, chatId, 'writenote', false, messageId);
}

async function showCustomerPickerForReport(bot, chatId, reportType, showAll = false, messageId = null) {
  const meta = REPORT_PICKER_PROMPTS[reportType];
  if (!meta) return;

  const allCust = await customersRepo.getAll();
  const active = allCust
    .filter((c) => (c.status || 'Active').toLowerCase() === 'active' && c.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!active.length) {
    if (messageId) {
      await bot.editMessageText('No active customers found.', { chat_id: chatId, message_id: messageId }).catch(() => {});
    } else {
      await bot.sendMessage(chatId, 'No active customers found.');
    }
    return;
  }

  const MAX_VISIBLE = 8;
  const visible = showAll ? active : active.slice(0, MAX_VISIBLE);
  const rows = [];
  for (let i = 0; i < visible.length; i += 2) {
    const row = [{ text: `👤 ${visible[i].name}`, callback_data: `rpt:${reportType}:${visible[i].name}` }];
    if (visible[i + 1]) {
      row.push({ text: `👤 ${visible[i + 1].name}`, callback_data: `rpt:${reportType}:${visible[i + 1].name}` });
    }
    rows.push(row);
  }
  if (!showAll && active.length > MAX_VISIBLE) {
    rows.push([{ text: `📋 See All (${active.length})`, callback_data: `rpt:${reportType}:__more__` }]);
  }

  const text = `${meta.icon} *${meta.label}*\n\n${meta.prompt}`;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };

  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }).catch(async () => {
      await bot.sendMessage(chatId, text, opts);
    });
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

/* ─── Design Picker for Report Buttons ────────────────────────────────────
 * Shared picker used by button-triggered reports that need a design pick
 * (list_packages, check_stock). Emits callback_data `<prefix>:<design>` and
 * `<prefix>:__more__` to expand the full list. In-place edits supported.
 */
const DESIGN_PICKER_PROMPTS = {
  lpk: { icon: '📋', label: 'List Packages', prompt: 'Pick a design to see its packages:' },
  cks: { icon: '📦', label: 'Check Stock',   prompt: 'Pick a design to see available stock:' },
};

async function showDesignPickerForReport(bot, chatId, prefix, showAll = false, messageId = null) {
  const meta = DESIGN_PICKER_PROMPTS[prefix];
  if (!meta) return;

  const raw = await inventoryRepository.getDistinctDesigns();
  const designs = [...new Set(raw.map((d) => (d.design || '').trim()).filter(Boolean))].sort();

  if (!designs.length) {
    const msg = 'No designs found in inventory.';
    if (messageId) {
      await bot.editMessageText(msg, { chat_id: chatId, message_id: messageId }).catch(() => {});
    } else {
      await bot.sendMessage(chatId, msg);
    }
    return;
  }

  const MAX_VISIBLE = 12;
  const visible = showAll ? designs : designs.slice(0, MAX_VISIBLE);
  const rows = [];
  for (let i = 0; i < visible.length; i += 3) {
    const row = [];
    for (let j = i; j < i + 3 && j < visible.length; j++) {
      row.push({ text: visible[j], callback_data: `${prefix}:${visible[j].slice(0, 55)}` });
    }
    rows.push(row);
  }
  if (!showAll && designs.length > MAX_VISIBLE) {
    rows.push([{ text: `📋 See All (${designs.length})`, callback_data: `${prefix}:__more__` }]);
  }

  const text = `${meta.icon} *${meta.label}*\n\n${meta.prompt}`;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };

  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }).catch(async () => {
      await bot.sendMessage(chatId, text, opts);
    });
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

/** Reusable List Packages report — mirrors the text intent handler. */
async function sendListPackagesReport(bot, chatId, design, shade = null) {
  const packages = await inventoryService.listPackages(design, shade);
  if (!packages.length) {
    await bot.sendMessage(chatId, `No packages found for design ${design}${shade ? ' ' + shade : ''}.`);
    return;
  }
  let reply = `📋 *Packages for ${design}${shade ? ' ' + shade : ''}:*\n\n`;
  packages.forEach((p) => {
    reply += `Pkg ${p.packageNo} (${p.warehouse}): ${p.available}/${p.total} thans avail, ${fmtQty(p.availableYards)} yds\n`;
  });
  const totalAvail = packages.reduce((s, p) => s + p.availableYards, 0);
  reply += `\n*Total: ${packages.length} packages, ${fmtQty(totalAvail)} yards*`;
  await sendLong(bot, chatId, reply, { parse_mode: 'Markdown' });
}

/** Reusable Check Stock report — shows totals + shade/warehouse breakdown. */
async function sendCheckStockReport(bot, chatId, design) {
  const stock = await inventoryService.checkStock({ design });
  if (!stock || stock.totalThans === 0) {
    await bot.sendMessage(chatId, `⚠️ No available stock for design ${design}.`);
    return;
  }
  let reply = `📦 *Stock — Design ${design}*\n`;
  const labels = await productTypesRepo.getLabels('fabric');
  reply += `Available: ${stock.totalPackages} ${productTypesRepo.pluralize(labels.container_label, stock.totalPackages).toLowerCase()} `;
  reply += `(${stock.totalThans} ${productTypesRepo.pluralize(labels.subunit_label, stock.totalThans).toLowerCase()}), `;
  reply += `${fmtQty(stock.totalYards)} ${labels.measure_unit}\n`;
  reply += `Value: ${fmtMoney(stock.totalValue)}\n`;

  // Break down by shade + warehouse for a richer picture
  const allInv = await inventoryRepository.getAll();
  const avail = allInv.filter((r) => r.status === 'available' && r.design === design);
  if (avail.length) {
    const byShade = new Map();
    for (const r of avail) {
      const sh = r.shade || '-';
      if (!byShade.has(sh)) byShade.set(sh, { pkgs: new Set(), yards: 0, warehouses: new Map() });
      const s = byShade.get(sh);
      s.pkgs.add(r.packageNo);
      s.yards += r.yards || 0;
      s.warehouses.set(r.warehouse, (s.warehouses.get(r.warehouse) || 0) + 1);
    }
    reply += `\n*By shade:*\n`;
    for (const [sh, s] of [...byShade.entries()].sort((a, b) => b[1].yards - a[1].yards)) {
      const whList = [...s.warehouses.keys()].join(', ');
      reply += `  Shade ${sh}: ${s.pkgs.size} pkgs, ${fmtQty(s.yards)} yds (${whList})\n`;
    }
  }
  await sendLong(bot, chatId, reply, { parse_mode: 'Markdown' });
}

/** Reusable Mark-Order-Delivered executor — shared by text intent and button. */
async function executeMarkOrderDelivered(bot, chatId, userId, orderId) {
  const order = await ordersRepo.getById(orderId);
  if (!order) {
    await bot.sendMessage(chatId, `Order ${orderId} not found.`);
    return;
  }
  if (order.salesperson_id !== userId) {
    await bot.sendMessage(chatId, 'You can only mark your own assigned orders as delivered.');
    return;
  }
  if (order.status === 'delivered') {
    await bot.sendMessage(chatId, `Order ${orderId} is already marked as delivered.`);
    return;
  }
  if (order.status !== 'accepted') {
    await bot.sendMessage(chatId, `Order ${orderId} must be accepted before it can be marked delivered. Current status: ${order.status}`);
    return;
  }
  await ordersRepo.updateStatus(orderId, 'delivered', { delivered_at: new Date().toISOString() });
  await bot.sendMessage(chatId, `✅ Order ${orderId} marked as delivered.`);
  for (const adminId of config.access.adminIds) {
    try {
      await bot.sendMessage(adminId, `📦 Order *${orderId}* has been delivered.\n\nDesign: ${order.design}\nCustomer: ${order.customer}\nQty: ${order.quantity}\nDelivered by: ${order.salesperson_name}`, { parse_mode: 'Markdown' });
    } catch (_) {}
  }
}

/** Picker showing the user's own pending (accepted, not delivered) orders. */
async function showMarkDeliveredPicker(bot, chatId, userId) {
  const all = await ordersRepo.getAll();
  const mine = all.filter((o) => o.salesperson_id === userId && o.status === 'accepted');
  if (!mine.length) {
    await bot.sendMessage(chatId, 'You have no accepted orders awaiting delivery.');
    return;
  }
  mine.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

  let header = '📦 *Mark Order Delivered*\n\nPick an order to mark as delivered:\n\n';
  const rows = [];
  const MAX = 10;
  for (const o of mine.slice(0, MAX)) {
    const date = fmtDate(o.created_at) || (o.created_at || '').slice(0, 10);
    header += `• *${o.order_id}* — ${o.design}${o.shade ? ' ' + o.shade : ''} | ${o.customer} | Qty ${o.quantity} | ${date}\n`;
    rows.push([{ text: `✅ ${o.order_id} — ${o.customer}`, callback_data: `mdo:${o.order_id}` }]);
  }
  if (mine.length > MAX) header += `\n_Showing first ${MAX} of ${mine.length}_`;
  await bot.sendMessage(chatId, header, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

/** Handle text replies during an active order creation session. Returns true if consumed. */
async function showOrderSalespersonPicker(bot, chatId, userId) {
  const users = await usersRepository.getAll();
  const adminIds = new Set(config.access.adminIds || []);
  const active = users.filter((u) => {
    if (u.status !== 'active') return false;
    if (adminIds.has(u.user_id)) return true;
    return (u.department || '').toLowerCase() === 'sales';
  });
  if (!active.length) {
    await bot.sendMessage(chatId, '⚠️ No salespersons found (Sales dept or admin). Ask admin to assign users.');
    sessionStore.clear(userId);
    return;
  }
  const rows = [];
  for (let i = 0; i < active.length; i += 2) {
    const row = [{ text: `🧑 ${active[i].name}`, callback_data: `os:${active[i].user_id}` }];
    if (active[i + 1]) row.push({ text: `🧑 ${active[i + 1].name}`, callback_data: `os:${active[i + 1].user_id}` });
    rows.push(row);
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'ocanc:1' }]);
  await bot.sendMessage(chatId, '🧑 *Select salesperson:*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function handleOrderFlowText(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'order_flow') return false;

  if (text.toLowerCase() === 'cancel') {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, 'Order creation cancelled.');
    return true;
  }

  /* ─── Proper new-customer flow with approval gate (Batch 5) ─── */
  if (session.step === 'new_order_customer_name') {
    const name = text.trim();
    if (name.length < 2) {
      await bot.sendMessage(chatId, 'Name too short, please re-enter:');
      return true;
    }
    session.pendingCustomerName = name;
    session.step = 'new_order_customer_phone';
    sessionStore.set(userId, session);
    await bot.sendMessage(chatId, `Got it: *${name}*\n\nEnter phone number (or type "skip"):`, { parse_mode: 'Markdown' });
    return true;
  }

  if (session.step === 'new_order_customer_phone') {
    const raw = text.trim();
    const phone = raw.toLowerCase() === 'skip' ? '' : raw;
    const name = session.pendingCustomerName;

    const customerId = `C-${Date.now().toString(36).toUpperCase()}`;
    const customersRepo2 = require('../repositories/customersRepository');
    await customersRepo2.append({
      customer_id: customerId, name, phone, address: '', category: '',
      credit_limit: 0, payment_terms: '', notes: 'Added via order flow',
      status: 'Pending',
    });

    const requestId = genId();
    await approvalQueueRepository.append({
      requestId, user: userId,
      actionJSON: {
        action: 'new_customer_registration',
        customer_id: customerId, customer_name: name, phone,
        requesterUserId: userId, from: 'order_flow',
      },
      riskReason: 'New customer registration requires admin approval',
      status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: 'new_customer', from: 'order_flow' }, userId);

    session.pendingCustomerId = customerId;
    session.customerApprovalId = requestId;
    session.step = 'awaiting_customer_approval';
    sessionStore.set(userId, session);

    const userLabel = await getRequesterDisplayName(userId, null);
    await approvalEvents.notifyAdminsApprovalRequest(
      bot, requestId, userLabel,
      `New Customer Registration\nName: ${name}\nPhone: ${phone || '—'}\n(from order flow)`,
      'New customer requires admin approval',
    );
    await bot.sendMessage(chatId,
      `⏳ Customer "*${name}*" sent for admin approval.\n\nYour order is *paused* — it will resume automatically once a second admin approves the new customer.`,
      { parse_mode: 'Markdown' });
    return true;
  }

  /* ─── Custom quantity (tapped "Custom" in presets) ─── */
  if (session.step === 'quantity_custom') {
    const qty = text.trim();
    if (!qty || isNaN(Number(qty)) || Number(qty) <= 0) {
      await bot.sendMessage(chatId, 'Please enter a valid positive number for quantity.');
      return true;
    }
    session.quantity = qty;
    session.step = 'salesperson';
    sessionStore.set(userId, session);
    await showOrderSalespersonPicker(bot, chatId, userId);
    return true;
  }

  /* ─── Legacy text step kept for back-compat with any stale sessions ─── */
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
    await showOrderSalespersonPicker(bot, chatId, userId);
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

async function startReceiptFlow(bot, chatId, userId, messageId = null) {
  sessionStore.set(userId, { type: 'receipt_flow', step: 'customer', createdBy: userId });
  await showReceiptCustomerPicker(bot, chatId, userId, false, messageId);
}

/** Customer picker for the receipt flow, top-buyers-first with See-More pagination. */
async function showReceiptCustomerPicker(bot, chatId, userId, showAll = false, messageId = null) {
  const customersRepoLocal = require('../repositories/customersRepository');
  const allCust = await customersRepoLocal.getAll();
  const active = allCust.filter((c) => (c.status || 'Active').toLowerCase() === 'active' && c.name);

  // Rank by recent purchase volume if transactions repo has data.
  let ranked = active;
  try {
    const txs = await transactionsRepo.getAll();
    const totals = {};
    txs.forEach((t) => {
      const name = (t.customer || '').trim();
      if (!name) return;
      totals[name] = (totals[name] || 0) + (Number(t.qty) || 0);
    });
    ranked = [...active].sort((a, b) => (totals[b.name] || 0) - (totals[a.name] || 0));
  } catch (_) { /* keep unsorted if transactions fetch fails */ }

  const CAP = showAll ? ranked.length : 10;
  const visible = ranked.slice(0, CAP);
  const rows = [];
  for (let i = 0; i < visible.length; i += 2) {
    const row = [{ text: `👤 ${visible[i].name}`, callback_data: `rcc:${visible[i].name.slice(0, 50)}` }];
    if (visible[i + 1]) row.push({ text: `👤 ${visible[i + 1].name}`, callback_data: `rcc:${visible[i + 1].name.slice(0, 50)}` });
    rows.push(row);
  }
  if (!showAll && ranked.length > CAP) {
    rows.push([{ text: `📋 See all ${ranked.length} customers`, callback_data: 'rcc:__more__' }]);
  }
  rows.push([{ text: '➕ Register New Customer', callback_data: 'rcc:__new__' }]);
  rows.push([{ text: '❌ Cancel', callback_data: 'rccanc:0' }]);

  const label = showAll ? 'All customers' : 'Top customers (by volume)';
  const text = `🧾 *Upload Payment Receipt*\n\nSelect customer — ${label}:`;
  await editOrSend(bot, chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function handleReceiptFlowText(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'receipt_flow') return false;

  if (text.toLowerCase() === 'cancel') {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, 'Receipt upload cancelled.');
    return true;
  }

  /* ─── Approval-gated new-customer registration from receipt flow (Batch 6) ─── */
  if (session.step === 'receipt_new_cust_name') {
    const name = text.trim();
    if (name.length < 2) {
      await bot.sendMessage(chatId, 'Name too short, please re-enter:');
      return true;
    }
    session.pendingCustomerName = name;
    session.step = 'receipt_new_cust_phone';
    sessionStore.set(userId, session);
    await bot.sendMessage(chatId, `Got it: *${name}*\n\nEnter phone number (or type "skip"):`, { parse_mode: 'Markdown' });
    return true;
  }

  if (session.step === 'receipt_new_cust_phone') {
    const raw = text.trim();
    const phone = raw.toLowerCase() === 'skip' ? '' : raw;
    const name = session.pendingCustomerName;
    const customerId = `C-${Date.now().toString(36).toUpperCase()}`;
    const customersRepo2 = require('../repositories/customersRepository');
    await customersRepo2.append({
      customer_id: customerId, name, phone, address: '', category: '',
      credit_limit: 0, payment_terms: '', notes: 'Added via receipt flow',
      status: 'Pending',
    });
    const requestId = genId();
    await approvalQueueRepository.append({
      requestId, user: userId,
      actionJSON: {
        action: 'new_customer_registration',
        customer_id: customerId, customer_name: name, phone,
        requesterUserId: userId, from: 'receipt_flow',
      },
      riskReason: 'New customer registration requires admin approval',
      status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: 'new_customer', from: 'receipt_flow' }, userId);
    session.pendingCustomerId = customerId;
    session.customerApprovalId = requestId;
    session.step = 'awaiting_customer_approval';
    sessionStore.set(userId, session);
    const userLabel = await getRequesterDisplayName(userId, null);
    await approvalEvents.notifyAdminsApprovalRequest(
      bot, requestId, userLabel,
      `New Customer Registration\nName: ${name}\nPhone: ${phone || '—'}\n(from receipt flow)`,
      'New customer requires admin approval',
    );
    await bot.sendMessage(chatId,
      `⏳ Customer "*${name}*" sent for admin approval.\n\nYour receipt upload is *paused* — it will resume once the new customer is approved.`,
      { parse_mode: 'Markdown' });
    return true;
  }

  /* ─── Legacy step kept for back-compat ─── */
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
    `📅 Date: ${fmtDate(new Date().toISOString())}\n\n` +
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

  if (session && session.type === 'supply_req_flow' && session.awaitingDocument) {
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
    session.docFileId = telegramFileId;
    session.docType = fileType;
    session.docMime = mimeType;
    session.awaitingDocument = false;
    sessionStore.set(userId, session);
    await finalizeSupplyRequest(bot, chatId, userId);
    return;
  }

  await bot.sendMessage(chatId, 'To upload a receipt, first type "Upload receipt" to start the process.\nFor a supply request, tap "Supply Request" from the menu.');
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
    await buildGreetingMenu(bot, chatId, userId);
    return;
  }

  if (GREETINGS.test(text.trim())) {
    await buildGreetingMenu(bot, chatId, userId);
    return;
  }

  if (text.toLowerCase() === 'cancel') {
    const s = sessionStore.get(userId);
    if (s && (s.type === 'supply_req_flow' || s.type === 'adm_flow')) {
      sessionStore.clear(userId);
      await bot.sendMessage(chatId, '❌ Cancelled.');
      return;
    }
  }

  const srfSession = sessionStore.get(userId);
  if (srfSession && srfSession.type === 'supply_req_flow') {
    if (srfSession.awaitingDocument) {
      await bot.sendMessage(chatId, '📎 Please send a *photo* or *PDF* of the sales bill, or tap *Skip*.', { parse_mode: 'Markdown' });
      return;
    }
    if (srfSession.step === 'custom_quantity') {
      const qty = parseInt(text.trim());
      if (isNaN(qty) || qty < 1) {
        await bot.sendMessage(chatId, '⚠️ Enter a valid number (minimum 1).');
        return;
      }
      if (qty > srfSession.currentAvailPkgs) {
        const lbl = await productTypesRepo.getLabels(srfSession.productType || 'fabric');
        const cPlural = productTypesRepo.pluralize(lbl.container_label, srfSession.currentAvailPkgs).toLowerCase();
        await bot.sendMessage(chatId, `⚠️ Only ${srfSession.currentAvailPkgs} ${cPlural} available. Enter a lower number.`);
        return;
      }
      addToCart(srfSession, srfSession.currentDesign, srfSession.currentShade, qty);
      sessionStore.set(userId, srfSession);
      await showCartSummary(bot, chatId, userId);
      return;
    }
    if (srfSession.step === 'new_srf_customer_name') {
      const name = text.trim();
      if (!name) { await bot.sendMessage(chatId, 'Please enter a valid customer name.'); return; }
      const existing = await customersRepo.findByName(name);
      if (existing) {
        srfSession.customer = existing.name;
        srfSession.step = 'salesperson';
        sessionStore.set(userId, srfSession);
        await bot.sendMessage(chatId, `👤 Customer "${existing.name}" already exists. Continuing...`);
        await showSupplySalespersonPicker(bot, chatId, false, srfSession.flowMessageId || null);
        return;
      }
      srfSession.newCustomerName = name;
      srfSession.step = 'new_srf_customer_phone';
      sessionStore.set(userId, srfSession);
      await bot.sendMessage(chatId, '📱 Enter customer phone number:');
      return;
    }
    if (srfSession.step === 'new_srf_customer_phone') {
      const phone = text.trim();
      if (!phone) { await bot.sendMessage(chatId, 'Please enter a phone number.'); return; }
      const name = srfSession.newCustomerName;
      const custId = idGenerator.customer();
      await customersRepo.append({
        customer_id: custId, name, phone, status: 'Pending',
        category: 'Retail', notes: `Registered during supply request by ${userId}`,
      });
      srfSession.step = 'awaiting_customer_approval';
      srfSession.pendingCustomerId = custId;
      srfSession.pendingCustomerName = name;
      sessionStore.set(userId, srfSession);
      const requestId = require('crypto').randomUUID();
      srfSession.customerApprovalId = requestId;
      sessionStore.set(userId, srfSession);
      const approvalQueueRepository = require('../repositories/approvalQueueRepository');
      await approvalQueueRepository.append({
        requestId,
        user: userId,
        actionJSON: { action: 'new_customer', customer_id: custId, customer_name: name, phone, requesterUserId: userId },
        riskReason: 'New customer registration requires admin approval',
        status: 'pending',
      });
      const approvalEvents = require('../events/approvalEvents');
      const userLabel = await getRequesterDisplayName(userId, null);
      await approvalEvents.notifyAdminsApprovalRequest(
        bot, requestId, userLabel,
        `New customer: "${name}" (${phone})`,
        'New customer registration requires admin approval',
        null,
      );
      await bot.sendMessage(chatId,
        `⏳ Customer "*${name}*" registered as *Pending*.\n\nWaiting for admin approval before proceeding. You'll be notified once approved.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }
  }
  if (srfSession && srfSession.type === 'adm_flow') {
    const handled = await handleAdminFlowText(bot, chatId, userId, text, srfSession);
    if (handled) return;
  }

  if (/^\/revert_package[s]?\s/i.test(text)) {
    if (!config.access.adminIds.includes(userId)) {
      await bot.sendMessage(chatId, 'Only admin can revert packages.');
      return;
    }
    const pkgNos = text.replace(/^\/revert_package[s]?\s+/i, '').split(/[\s,]+/).filter(Boolean);
    if (!pkgNos.length) {
      await bot.sendMessage(chatId, 'Usage: /revert_packages 6422 6423 6424 ...');
      return;
    }
    let restored = 0;
    const results = [];
    for (const p of pkgNos) {
      try {
        const reverted = await inventoryRepository.markPackageAvailable(p);
        restored += reverted.length;
        results.push(`✅ ${p}: ${reverted.length} thans restored`);
      } catch (e) {
        results.push(`⚠️ ${p}: ${e.message}`);
      }
    }
    await bot.sendMessage(chatId, `📦 *Revert Packages*\n\n${results.join('\n')}\n\nTotal: ${restored} thans restored to available.`, { parse_mode: 'Markdown' });
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

  const addCustFlowHandled = await handleAddCustomerFlowText(bot, chatId, userId, text);
  if (addCustFlowHandled) return;

  const addBankFlowHandled = await handleAddBankFlowText(bot, chatId, userId, text);
  if (addBankFlowHandled) return;

  const addNoteFlowHandled = await handleAddNoteFlowText(bot, chatId, userId, text);
  if (addNoteFlowHandled) return;

  const updatePriceFlowHandled = await handleUpdatePriceFlowText(bot, chatId, userId, text);
  if (updatePriceFlowHandled) return;

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
        const stockLabels = await productTypesRepo.getLabels('fabric');
        reply += `Available: ${stock.totalPackages} ${productTypesRepo.pluralize(stockLabels.container_label, stock.totalPackages).toLowerCase()} (${stock.totalThans} ${productTypesRepo.pluralize(stockLabels.subunit_label, stock.totalThans).toLowerCase()}), ${fmtQty(stock.totalYards)} ${stockLabels.measure_unit}\n`;
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
        await sendListPackagesReport(bot, chatId, intent.design, intent.shade || null);
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
          const sold = t.soldTo ? ` → ${t.soldTo} (${fmtDate(t.soldDate)})` : '';
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
        if (!entries.length) { await bot.sendMessage(chatId, `No ledger entries for ${fmtDate(today)}.`); return; }
        let ledgerText = `📒 *Ledger — ${fmtDate(today)}*\n\n`;
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
          const ts = fmtDate(t.timestamp);
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
          out += `${statusLabel} ${t.task_id}: ${t.title}\n  Status: ${t.status}${t.completed_at ? `, completed ${fmtDate(t.completed_at)}` : ''}\n\n`;
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
        await sendSampleStatusReport(bot, chatId, intent.design || null);
        return;
      }

      case 'customer_history': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'Which customer? e.g. "Customer history CJE"'); return; }
        await sendCustomerHistoryReport(bot, chatId, intent.customer);
        return;
      }

      case 'customer_ranking': {
        if (!config.access.adminIds.includes(userId)) { await bot.sendMessage(chatId, 'Customer ranking is admin-only.'); return; }
        await sendCustomerRankingReport(bot, chatId);
        return;
      }

      case 'customer_pattern': {
        if (!intent.customer) { await bot.sendMessage(chatId, 'Which customer? e.g. "What does CJE buy"'); return; }
        await sendCustomerPatternReport(bot, chatId, intent.customer);
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
        await bot.sendMessage(chatId, `✅ Follow-up scheduled: *${saved.followup_id}*\n\nCustomer: ${intent.customer}\nDate: ${fmtDate(fDate)}\nReason: ${reason}\n\nYou'll be reminded on ${fmtDate(fDate)}.`, { parse_mode: 'Markdown' });
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
        await sendCustomerNotesReport(bot, chatId, intent.customer);
        return;
      }

      case 'upload_receipt': {
        await startReceiptFlow(bot, chatId, userId);
        return;
      }

      case 'supply_request': {
        await startSupplyRequestFlow(bot, chatId, userId);
        return;
      }

      case 'manage_users': {
        if (!config.access.adminIds.includes(userId)) {
          await bot.sendMessage(chatId, 'Only admin can manage users.');
          return;
        }
        await showUserManagement(bot, chatId);
        return;
      }

      case 'manage_departments': {
        if (!config.access.adminIds.includes(userId)) {
          await bot.sendMessage(chatId, 'Only admin can manage departments.');
          return;
        }
        const depts = await departmentsRepo.getAll();
        let text = '🏢 *Departments*\n\n';
        for (const d of depts) {
          text += `*${d.dept_name}* (${d.dept_id})\n  Activities: ${d.allowed_activities.join(', ')}\n  Status: ${d.status}\n\n`;
        }
        await sendLong(bot, chatId, text, { parse_mode: 'Markdown' });
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
        await executeMarkOrderDelivered(bot, chatId, userId, oid);
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
  return `Type *hi* to see your personalized activity menu.

*Quick Commands:*

📦 *Supply Request* — Guided tappable flow (warehouse → design → customer → date)
📦 "Sell 5801, 5802 to Ibrahim, salesperson Abdul, cash, date today" — Text-based supply
↩️ "Return than 2 from package 5801"
🔄 "Transfer package 5801 to Kano"
💲 "Update price of 44200 BLACK to 1500"
📦 "How much 44200 BLACK do we have?"
📋 "Show packages for design 44200"

*Reports:*
📊 "Supply details" / "Sales report" / "Inventory details"
📦 "Stock summary" / "Customer ranking"

*CRM:*
👤 "Add customer Ibrahim" / "Customer history CJE"
📝 "Note for CJE: wants bulk discount"

*Samples & Orders:*
🧪 "Give sample of 44200 to CJE" / "Sample status"
📦 "Create order" / "My orders"

*Receipts:*
🧾 "Upload receipt" — Upload payment receipt

*Admin:*
👥 "Manage users" — Assign departments & warehouses
🏢 "Manage departments" — View department activities

*Ledger (admin):*
/ledger <customer_id> / /balance <customer_id> / /payment <customer_id> <amount>`;
}

/* ─── GREETING MENU ─── */

const GREETINGS = /^(hi|hello|hey|start|menu|home|main\s*menu)$/i;

/**
 * Build the hub-based greeting menu.
 * Activities belonging to a hub are collapsed behind a single hub button;
 * only standalone activities (hub === null) remain at top level alongside
 * the hubs. Hubs are sorted by aggregated sub-activity usage; standalones
 * by their own usage. A hub containing only one allowed sub-activity is
 * auto-promoted to top level (no redundant single-item drilldown).
 */
async function buildGreetingMenuMarkup(userId, showAll = false) {
  const isAdminUser = config.access.adminIds.includes(userId);
  const user = await usersRepository.findByUserId(userId);
  const deptName = (user && user.department) || (isAdminUser ? 'Admin' : '');

  let allowed = [];
  if (isAdminUser) {
    allowed = activityRegistry.getAll();
  } else if (deptName) {
    const dept = await departmentsRepo.findByName(deptName);
    if (dept) allowed = activityRegistry.filterByCodes(dept.allowed_activities);
  }

  if (!allowed.length) {
    return {
      empty: true,
      text: '👋 Welcome! You have no activities assigned yet.\nPlease ask your admin to assign you to a department.',
      reply_markup: { inline_keyboard: [] },
    };
  }

  const counts = await userPrefsRepo.getCountsForUser(userId);
  const { hubs, standalone } = activityRegistry.groupByHub(allowed);

  // Build a unified list of entries (hub OR standalone activity),
  // each with an aggregated usage count for sorting.
  const entries = [];
  for (const { hub, activities } of hubs) {
    if (activities.length === 1) {
      // Promote a single-item hub directly to top level.
      const a = activities[0];
      entries.push({ kind: 'activity', activity: a, count: counts[a.code] || 0 });
    } else {
      const agg = activities.reduce((s, a) => s + (counts[a.code] || 0), 0);
      entries.push({ kind: 'hub', hub, activities, count: agg });
    }
  }
  for (const a of standalone) {
    entries.push({ kind: 'activity', activity: a, count: counts[a.code] || 0 });
  }

  entries.sort((a, b) => b.count - a.count);

  const MAX_MENU = 6;
  const visible = showAll ? entries : entries.slice(0, MAX_MENU);

  const rows = [];
  for (let i = 0; i < visible.length; i += 2) {
    const row = [entryToButton(visible[i])];
    if (visible[i + 1]) row.push(entryToButton(visible[i + 1]));
    rows.push(row);
  }
  if (!showAll && entries.length > MAX_MENU) {
    rows.push([{ text: `📋 More Options (${entries.length - MAX_MENU})`, callback_data: 'act:__more__' }]);
  }

  const name = (user && user.name) || 'there';
  const deptBadge = deptName ? ` (${deptName})` : '';
  return {
    empty: false,
    text: `👋 Hi *${name}*${deptBadge}! What would you like to do?`,
    reply_markup: { inline_keyboard: rows },
  };
}

function entryToButton(entry) {
  if (entry.kind === 'hub') {
    return {
      text: `${entry.hub.icon} ${entry.hub.label}`,
      callback_data: `act:__hub__:${entry.hub.id}`,
    };
  }
  const a = entry.activity;
  return { text: `${a.icon} ${a.label}`, callback_data: a.callback };
}

async function buildGreetingMenu(bot, chatId, userId, showAll = false) {
  const markup = await buildGreetingMenuMarkup(userId, showAll);
  if (markup.empty) {
    await bot.sendMessage(chatId, markup.text);
    return;
  }
  await bot.sendMessage(chatId, markup.text, {
    parse_mode: 'Markdown',
    reply_markup: markup.reply_markup,
  });
}

/**
 * Render a hub's sub-activities in place (editing the tapped message).
 * Sub-activities are ordered by the user's individual usage counts.
 */
async function renderHubSubmenu(bot, chatId, messageId, userId, hubId) {
  const hub = activityRegistry.getHub(hubId);
  if (!hub) {
    await bot.sendMessage(chatId, 'Unknown menu section.');
    return;
  }

  const isAdminUser = config.access.adminIds.includes(userId);
  const user = await usersRepository.findByUserId(userId);
  const deptName = (user && user.department) || (isAdminUser ? 'Admin' : '');

  let allowed = [];
  if (isAdminUser) {
    allowed = activityRegistry.getAll();
  } else if (deptName) {
    const dept = await departmentsRepo.findByName(deptName);
    if (dept) allowed = activityRegistry.filterByCodes(dept.allowed_activities);
  }
  const subs = allowed.filter((a) => a.hub === hubId);

  if (!subs.length) {
    await bot.editMessageText(`${hub.icon} *${hub.label}*\n\n_No actions available in this section._`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⬅ Back', callback_data: 'act:__back__' }]] },
    }).catch(() => {});
    return;
  }

  const counts = await userPrefsRepo.getCountsForUser(userId);
  const sorted = [...subs].sort((a, b) => (counts[b.code] || 0) - (counts[a.code] || 0));

  const rows = [];
  for (let i = 0; i < sorted.length; i += 2) {
    const row = [{ text: `${sorted[i].icon} ${sorted[i].label}`, callback_data: sorted[i].callback }];
    if (sorted[i + 1]) {
      row.push({ text: `${sorted[i + 1].icon} ${sorted[i + 1].label}`, callback_data: sorted[i + 1].callback });
    }
    rows.push(row);
  }
  rows.push([{ text: '⬅ Back', callback_data: 'act:__back__' }]);

  await bot.editMessageText(`${hub.icon} *${hub.label}*\n\nPick an action:`, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  }).catch(async () => {
    // Fallback if edit fails (original message too old / deleted).
    await bot.sendMessage(chatId, `${hub.icon} *${hub.label}*\n\nPick an action:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: rows },
    });
  });
}

/**
 * Edit an existing message back to the greeting menu (used by ⬅ Back).
 */
async function renderGreetingMenuEdit(bot, chatId, messageId, userId, showAll = false) {
  const markup = await buildGreetingMenuMarkup(userId, showAll);
  if (markup.empty) {
    await bot.sendMessage(chatId, markup.text);
    return;
  }
  await bot.editMessageText(markup.text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: markup.reply_markup,
  }).catch(async () => {
    await bot.sendMessage(chatId, markup.text, {
      parse_mode: 'Markdown',
      reply_markup: markup.reply_markup,
    });
  });
}

/* ─── FUTURE-ONLY DATE PICKER ─── */

function buildDatePicker(callbackPrefix, monthOffset = 0) {
  const today = new Date();
  const viewDate = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = viewDate.getDay();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const rows = [];
  rows.push([{ text: `◀️`, callback_data: `${callbackPrefix}nav:${monthOffset - 1}` },
    { text: `${monthNames[month]} ${year}`, callback_data: 'noop' },
    { text: `▶️`, callback_data: `${callbackPrefix}nav:${monthOffset + 1}` }]);
  rows.push(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => ({ text: d, callback_data: 'noop' })));

  let week = [];
  const mondayOffset = firstDay === 0 ? 6 : firstDay - 1;
  for (let i = 0; i < mondayOffset; i++) week.push({ text: ' ', callback_data: 'noop' });

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    const isFuture = d >= new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (isFuture) {
      week.push({ text: String(day), callback_data: `${callbackPrefix}pick:${dateStr}` });
    } else {
      week.push({ text: `·`, callback_data: 'noop' });
    }
    if (week.length === 7) { rows.push(week); week = []; }
  }
  if (week.length) {
    while (week.length < 7) week.push({ text: ' ', callback_data: 'noop' });
    rows.push(week);
  }
  rows.push([{ text: '📅 Today', callback_data: `${callbackPrefix}pick:${today.toISOString().split('T')[0]}` }]);
  return rows;
}

/* ─── TAPPABLE SUPPLY REQUEST FLOW (MULTI-ITEM CART) ─── */

function getCartQtyForDesignShade(cart, design, shade) {
  const entry = (cart || []).find((c) => c.design === design && c.shade === shade);
  return entry ? entry.quantity : 0;
}

function getCartQtyForDesign(cart, design) {
  return (cart || []).filter((c) => c.design === design).reduce((s, c) => s + c.quantity, 0);
}

async function getAdjustedAvailability(warehouse, cart) {
  const all = await inventoryRepository.getAll();
  const available = all.filter((r) => r.warehouse === warehouse && r.status === 'available');
  const designMap = new Map();
  for (const r of available) {
    const key = `${r.design}||${r.shade || 'DEFAULT'}`;
    if (!designMap.has(key)) designMap.set(key, { design: r.design, shade: r.shade || 'DEFAULT', pkgs: new Set(), productType: r.productType || 'fabric' });
    designMap.get(key).pkgs.add(r.packageNo);
  }
  const result = [];
  for (const [, entry] of designMap) {
    const inCart = getCartQtyForDesignShade(cart, entry.design, entry.shade);
    const remaining = entry.pkgs.size - inCart;
    if (remaining > 0) result.push({ design: entry.design, shade: entry.shade, availPkgs: remaining, productType: entry.productType });
  }
  return result;
}

async function startSupplyRequestFlow(bot, chatId, userId) {
  const user = await usersRepository.findByUserId(userId);
  const warehouses = user && user.warehouses.length ? user.warehouses : [];

  if (!warehouses.length) {
    const isAdminUser = config.access.adminIds.includes(userId);
    if (isAdminUser) {
      const allWarehouses = await inventoryRepository.getWarehouses();
      if (!allWarehouses.length) {
        await bot.sendMessage(chatId, '⚠️ No warehouses found in inventory.');
        return;
      }
      const rows = allWarehouses.map((w) => [{ text: `🏭 ${w}`, callback_data: `srf_wh:${w}` }]);
      await bot.sendMessage(chatId, '📦 *Supply Request*\n\nSelect warehouse:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
      });
      return;
    }
    await bot.sendMessage(chatId, '⚠️ You have no warehouses assigned. Ask your admin to assign you.');
    return;
  }

  if (warehouses.length === 1) {
    sessionStore.set(userId, { type: 'supply_req_flow', warehouse: warehouses[0], cart: [], step: 'design' });
    await showDesignsForWarehouse(bot, chatId, userId, warehouses[0]);
    return;
  }

  const rows = warehouses.map((w) => [{ text: `🏭 ${w}`, callback_data: `srf_wh:${w}` }]);
  await bot.sendMessage(chatId, '📦 *Supply Request*\n\nSelect warehouse:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function showDesignsForWarehouse(bot, chatId, userId, warehouse, messageId = null) {
  const session = sessionStore.get(userId);
  const cart = session ? session.cart || [] : [];
  const avail = await getAdjustedAvailability(warehouse, cart);

  const designAgg = new Map();
  let detectedType = 'fabric';
  for (const a of avail) {
    if (!designAgg.has(a.design)) designAgg.set(a.design, { design: a.design, totalPkgs: 0 });
    designAgg.get(a.design).totalPkgs += a.availPkgs;
    if (a.productType) detectedType = a.productType;
  }
  const designs = Array.from(designAgg.values()).sort((a, b) => b.totalPkgs - a.totalPkgs);
  const labels = await productTypesRepo.getLabels(detectedType);

  if (!designs.length) {
    if (cart.length) {
      await bot.sendMessage(chatId, '⚠️ All available stock is already in your cart.');
      await showCartSummary(bot, chatId, userId);
    } else {
      await editOrSend(bot, chatId, messageId, `⚠️ No available stock in warehouse *${warehouse}*.`, { parse_mode: 'Markdown' });
    }
    return;
  }

  if (session && session.type === 'supply_req_flow') {
    session.step = 'design';
    session.productType = detectedType;
    sessionStore.set(userId, session);
  }

  const cShort = labels.container_short;
  const MAX_VISIBLE = 8;
  const page = (session && session.designPage) || 0;
  const start = page * MAX_VISIBLE;
  const visible = designs.slice(start, start + MAX_VISIBLE);
  const rows = [];
  for (let i = 0; i < visible.length; i += 2) {
    const row = [{ text: `${visible[i].design} (${visible[i].totalPkgs} ${cShort})`, callback_data: `srf_dg:${visible[i].design}` }];
    if (visible[i + 1]) row.push({ text: `${visible[i + 1].design} (${visible[i + 1].totalPkgs} ${cShort})`, callback_data: `srf_dg:${visible[i + 1].design}` });
    rows.push(row);
  }
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: 'srf_dgpg:prev' });
  if (start + MAX_VISIBLE < designs.length) nav.push({ text: `More (${designs.length - start - MAX_VISIBLE}) ➡️`, callback_data: 'srf_dgpg:next' });
  if (nav.length) rows.push(nav);
  const cartNote = cart.length ? `\n🛒 Cart: ${cart.length} item(s)` : '';
  const pageNote = designs.length > MAX_VISIBLE ? ` (${start + 1}–${Math.min(start + MAX_VISIBLE, designs.length)} of ${designs.length})` : '';
  const resolvedMsgId = messageId || (session && session.flowMessageId) || null;
  const sent = await editOrSend(bot, chatId, resolvedMsgId,
    `📦 *Warehouse: ${warehouse}*${cartNote}\n\nSelect design:${pageNote}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
  // Capture flow-scoped message id on first render so later pickers can edit in place.
  if (session && session.type === 'supply_req_flow' && !session.flowMessageId && sent && sent.message_id) {
    session.flowMessageId = sent.message_id;
    sessionStore.set(userId, session);
  }
}

async function showShadesForDesign(bot, chatId, userId, design, warehouse) {
  const session = sessionStore.get(userId);
  const cart = session ? session.cart || [] : [];
  const avail = await getAdjustedAvailability(warehouse, cart);
  const shades = avail.filter((a) => a.design === design).sort((a, b) => b.availPkgs - a.availPkgs);
  const labels = await productTypesRepo.getLabels(session?.productType || 'fabric');
  const msgId = session && session.flowMessageId;

  if (!shades.length) {
    await editOrSend(bot, chatId, msgId, `⚠️ No remaining stock for ${design} in ${warehouse}.`, {});
    if (cart.length) await showCartSummary(bot, chatId, userId);
    return;
  }

  if (shades.length === 1) {
    const s = shades[0];
    if (session && session.type === 'supply_req_flow') {
      session.currentDesign = design;
      session.currentShade = s.shade;
      session.currentAvailPkgs = s.availPkgs;
      session.step = 'quantity';
      sessionStore.set(userId, session);
    }
    await showQuantityPicker(bot, chatId, userId, design, s.shade, warehouse, s.availPkgs, labels);
    return;
  }

  if (session && session.type === 'supply_req_flow') {
    session.currentDesign = design;
    session.step = 'shade';
    sessionStore.set(userId, session);
  }

  const cShort = labels.container_short;
  const rows = [];
  for (let i = 0; i < shades.length; i += 2) {
    const row = [{ text: `${shades[i].shade} (${shades[i].availPkgs} ${cShort})`, callback_data: `srf_sh:${design}|${shades[i].shade}|${shades[i].availPkgs}` }];
    if (shades[i + 1]) row.push({ text: `${shades[i + 1].shade} (${shades[i + 1].availPkgs} ${cShort})`, callback_data: `srf_sh:${design}|${shades[i + 1].shade}|${shades[i + 1].availPkgs}` });
    rows.push(row);
  }
  await editOrSend(bot, chatId, msgId, `📦 *${design}* in *${warehouse}*\n\nSelect shade:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function showQuantityPicker(bot, chatId, userId, design, shade, warehouse, availPkgs, labelsOverride) {
  const labels = labelsOverride || await productTypesRepo.getLabels('fabric');
  const containerPlural = productTypesRepo.pluralize(labels.container_label, availPkgs).toLowerCase();
  const session = sessionStore.get(userId);
  const msgId = session && session.flowMessageId;

  const quickNums = [];
  for (let n = 1; n <= Math.min(availPkgs, 10); n++) quickNums.push(n);
  if (availPkgs > 10 && !quickNums.includes(availPkgs)) quickNums.push(availPkgs);

  const rows = [];
  for (let i = 0; i < quickNums.length; i += 5) {
    const row = [];
    for (let j = i; j < Math.min(i + 5, quickNums.length); j++) {
      const n = quickNums[j];
      const label = n === availPkgs ? `All (${n})` : String(n);
      row.push({ text: label, callback_data: `srf_qty:${n}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '✏️ Custom Quantity', callback_data: 'srf_qty:__custom__' }]);

  await editOrSend(bot, chatId, msgId,
    `📦 *${design}* │ Shade: *${shade}* │ 🏭 *${warehouse}*\n${availPkgs} ${containerPlural} available\n\nHow many ${containerPlural} to supply?`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: rows },
    });
}

function addToCart(session, design, shade, quantity) {
  if (!session.cart) session.cart = [];
  const existing = session.cart.find((c) => c.design === design && c.shade === shade);
  if (existing) {
    existing.quantity += quantity;
  } else {
    session.cart.push({ design, shade, quantity });
  }
}

async function buildCartText(session) {
  const cart = session.cart || [];
  if (!cart.length) return '🛒 Cart is empty.';
  const labels = await productTypesRepo.getLabels(session.productType || 'fabric');
  const cShort = labels.container_short;
  const lines = cart.map((c) => {
    const m = getMaterialInfo(c.design);
    return `${m.icon} ${c.design} [${m.name}] │ Shade: ${c.shade} │ ×${c.quantity} ${cShort}`;
  });
  const total = cart.reduce((s, c) => s + c.quantity, 0);
  const containerPlural = productTypesRepo.pluralize(labels.container_label, total).toLowerCase();
  return `🛒 *Supply Cart* — 🏭 ${session.warehouse}\n━━━━━━━━━━━━━━━━━━━━━━\n${lines.join('\n')}\n━━━━━━━━━━━━━━━━━━━━━━\n📦 Total: ${total} ${containerPlural}`;
}

async function showCartSummary(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'supply_req_flow') return;
  session.step = 'cart';
  sessionStore.set(userId, session);

  const text = await buildCartText(session);
  const rows = [
    [{ text: '➕ Add More', callback_data: 'srf_cart:add' }, { text: '🗑️ Remove', callback_data: 'srf_cart:remove' }],
    [{ text: '➡️ Checkout', callback_data: 'srf_cart:proceed' }, { text: '❌ Cancel', callback_data: 'srf_cart:cancel' }],
  ];
  await editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function getTopBuyersForDesigns(designs) {
  const allInv = await inventoryRepository.getAll();
  const designSet = new Set(designs.map((d) => String(d).toUpperCase()));
  const sold = allInv.filter((r) => r.status === 'sold' && r.soldTo && designSet.has(String(r.design).toUpperCase()));
  const buyerMap = new Map();
  for (const r of sold) {
    const name = r.soldTo;
    if (!buyerMap.has(name)) buyerMap.set(name, 0);
    buyerMap.set(name, buyerMap.get(name) + (r.yards * r.pricePerYard));
  }
  return [...buyerMap.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

async function showSupplyCustomerPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const cart = (session && session.cart) || [];
  const cartDesigns = [...new Set(cart.map((c) => c.design))];
  const msgId = session && session.flowMessageId;

  const allCust = await customersRepo.getAll();
  const active = allCust.filter((c) => (c.status || 'Active').toLowerCase() === 'active');
  const activeNames = new Set(active.map((c) => c.name));

  const topBuyers = await getTopBuyersForDesigns(cartDesigns);
  const suggested = topBuyers.filter((n) => activeNames.has(n)).slice(0, 6);
  const suggestedSet = new Set(suggested);

  const rows = [];
  if (suggested.length) {
    const designLabel = cartDesigns.length <= 3 ? cartDesigns.join(', ') : `${cartDesigns.length} designs`;
    let headerText = `👤 Select customer:\n━━━━━━━━━━━━━━━━━━━━━━\n⭐ *Top buyers of ${designLabel}:*`;
    for (let i = 0; i < suggested.length; i += 2) {
      const row = [{ text: `⭐ ${suggested[i]}`, callback_data: `srf_cu:${suggested[i]}` }];
      if (suggested[i + 1]) row.push({ text: `⭐ ${suggested[i + 1]}`, callback_data: `srf_cu:${suggested[i + 1]}` });
      rows.push(row);
    }
    const remaining = active.filter((c) => !suggestedSet.has(c.name));
    if (remaining.length) {
      rows.push([{ text: '📋 See More Customers', callback_data: 'srf_cu:__more__' }]);
    }
    rows.push([{ text: '➕ Add New Customer', callback_data: 'srf_cu:__new__' }]);
    await editOrSend(bot, chatId, msgId, headerText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  } else {
    for (let i = 0; i < active.length; i += 2) {
      const row = [{ text: `👤 ${active[i].name}`, callback_data: `srf_cu:${active[i].name}` }];
      if (active[i + 1]) row.push({ text: `👤 ${active[i + 1].name}`, callback_data: `srf_cu:${active[i + 1].name}` });
      rows.push(row);
    }
    rows.push([{ text: '➕ Add New Customer', callback_data: 'srf_cu:__new__' }]);
    await editOrSend(bot, chatId, msgId, '👤 Select customer:', { reply_markup: { inline_keyboard: rows } });
  }
}

async function showSupplySalespersonPicker(bot, chatId, showAll = false, messageId = null) {
  const allUsers = await usersRepository.getAll();
  const adminIds = new Set(config.access.adminIds || []);
  const salesUsers = allUsers.filter((u) => {
    if (adminIds.has(u.user_id)) return true;
    const dept = (u.department || '').toLowerCase();
    return dept === 'sales';
  });
  if (!salesUsers.length) {
    await editOrSend(bot, chatId, messageId, '⚠️ No salespersons found. Please ask admin to assign users to the Sales department.');
    return;
  }
  const MAX_SP = 6;
  const visible = showAll ? salesUsers : salesUsers.slice(0, MAX_SP);
  const rows = [];
  for (let i = 0; i < visible.length; i += 2) {
    const row = [{ text: `🧑 ${visible[i].name || visible[i].user_id}`, callback_data: `srf_sp:${visible[i].name || visible[i].user_id}` }];
    if (visible[i + 1]) row.push({ text: `🧑 ${visible[i + 1].name || visible[i + 1].user_id}`, callback_data: `srf_sp:${visible[i + 1].name || visible[i + 1].user_id}` });
    rows.push(row);
  }
  if (!showAll && salesUsers.length > MAX_SP) rows.push([{ text: `📋 See All (${salesUsers.length})`, callback_data: 'srf_sp:__more__' }]);
  await editOrSend(bot, chatId, messageId, '🧑 Select salesperson (order collected by):', {
    reply_markup: { inline_keyboard: rows },
  });
}

async function showSupplyPaymentPicker(bot, chatId, userId) {
  const session = userId ? sessionStore.get(userId) : null;
  const msgId = session && session.flowMessageId;
  const options = await salesFlow.getPaymentOptions();
  const rows = [];
  for (let i = 0; i < options.length; i += 3) {
    const row = [];
    for (let j = i; j < Math.min(i + 3, options.length); j++) {
      row.push({ text: `💳 ${options[j]}`, callback_data: `srf_pm:${options[j]}` });
    }
    rows.push(row);
  }
  await editOrSend(bot, chatId, msgId, '💳 Select payment mode:', { reply_markup: { inline_keyboard: rows } });
}

async function showSupplyDatePicker(bot, chatId, userId) {
  const session = userId ? sessionStore.get(userId) : null;
  const msgId = session && session.flowMessageId;
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const nextMon = nextWeekday(1);
  const nextFri = nextWeekday(5);
  const rows = [
    [{ text: `📅 Today (${fmtDate(today)})`, callback_data: `srf_dtpick:${today}` }],
    [{ text: `📅 Tomorrow (${fmtDate(tomorrow)})`, callback_data: `srf_dtpick:${tomorrow}` }],
    [
      { text: `Mon (${fmtDate(nextMon)})`, callback_data: `srf_dtpick:${nextMon}` },
      { text: `Fri (${fmtDate(nextFri)})`, callback_data: `srf_dtpick:${nextFri}` },
    ],
    [{ text: '🗓️ Pick from calendar', callback_data: 'srf_dtcal:0' }],
  ];
  return editOrSend(bot, chatId, msgId, '📅 Select supply date:', { reply_markup: { inline_keyboard: rows } });
}

async function showSupplyConfirmation(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'supply_req_flow') return;

  const cartText = await buildCartText(session);
  let text = `📦 *Supply Request Summary*\n\n`;
  text += `${cartText}\n\n`;
  text += `👤 Customer: *${session.customer}*\n`;
  text += `🧑 Salesperson: *${session.salesperson}*\n`;
  text += `💳 Payment: *${session.paymentMode}*\n`;
  text += `📅 Date: *${fmtDate(session.supplyDate)}*\n\n`;
  text += `📎 If payment was already received, send the *receipt photo or PDF*.\nOtherwise tap Skip.`;

  session.step = 'document';
  session.awaitingDocument = true;
  sessionStore.set(userId, session);

  await editOrSend(bot, chatId, session.flowMessageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '⏭️ Skip (No receipt)', callback_data: 'srf_doc:skip' }, { text: '❌ Cancel', callback_data: 'srf_doc:cancel' }],
    ] },
  });
}

async function finalizeSupplyRequest(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'supply_req_flow') return;

  session.step = 'confirm';
  session.awaitingDocument = false;
  sessionStore.set(userId, session);

  const cartText = await buildCartText(session);
  let text = `✅ *Confirm Supply Request*\n\n`;
  text += `${cartText}\n\n`;
  text += `👤 ${session.customer}\n`;
  text += `🧑 ${session.salesperson}\n`;
  text += `💳 ${session.paymentMode}\n`;
  text += `📅 ${fmtDate(session.supplyDate)}\n`;
  if (session.docFileId) text += `📎 Document attached\n`;
  text += `\nTap Confirm to submit.`;

  await editOrSend(bot, chatId, session.flowMessageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Confirm & Submit', callback_data: 'srf_conf:yes' }],
      [{ text: '❌ Cancel', callback_data: 'srf_conf:cancel' }],
    ] },
  });
}

/* ─── ADMIN CONTROLS ─── */

async function showUserManagement(bot, chatId) {
  const users = await usersRepository.getAll();
  let text = '👥 *User Management*\n\n';
  for (const u of users) {
    const dept = u.department || '-';
    const wh = u.warehouses.length ? u.warehouses.join(', ') : '-';
    text += `• *${u.name || u.user_id}* (${u.user_id})\n  Dept: ${dept} | Warehouses: ${wh}\n`;
  }
  text += '\nSelect action:';
  await sendLong(bot, chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🏢 Assign Department', callback_data: 'adm:assign_dept' }],
      [{ text: '🏭 Assign Warehouses', callback_data: 'adm:assign_wh' }],
      [{ text: '➕ Add New User', callback_data: 'adm:add_user' }],
    ] },
  });
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
    const isSubmitterAdmin = config.access.adminIds.includes(userId);
    const excludeId = isSubmitterAdmin ? userId : undefined;
    if (session.sale_doc_file_id) detailText += '\n📎 Sales bill attached (see below)';
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, detailText, risk.reason, excludeId);
    if (session.sale_doc_file_id) {
      for (const adminId of config.access.adminIds) {
        if (excludeId && String(adminId) === String(excludeId)) continue;
        try {
          if (session.sale_doc_type === 'document') {
            await bot.sendDocument(adminId, session.sale_doc_file_id, { caption: `📄 Sales bill for request ${requestId}` });
          } else {
            await bot.sendPhoto(adminId, session.sale_doc_file_id, { caption: `📷 Sales bill for request ${requestId}` });
          }
        } catch (e) { logger.error(`Failed to send sale doc to admin ${adminId}`, e.message); }
      }
    }
    const approverLabel = isSubmitterAdmin ? '2nd admin' : 'admin';
    await bot.sendMessage(chatId, `⏳ Supply request submitted for ${approverLabel} approval. Request: ${requestId}\n${totalPkgs} packages (${totalThans} thans), ${fmtQty(totalYards)} yards to ${session.collected.customer}`);
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
  } else if (data.startsWith('srf_assign:')) {
    await approvalEvents.handleSupplyAssign(bot, callbackQuery);
  } else if (data.startsWith('srf_ack:')) {
    await approvalEvents.handleSupplyAcknowledge(bot, callbackQuery);
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
    sessionStore.set(uid, { type: 'sales_report_period', days });
    const labels = { 7: 'Weekly', 30: 'Monthly', 90: 'Quarterly', 365: 'Yearly' };
    const periodLabel = labels[days] || `Last ${days} days`;
    await editOrSend(bot, callbackQuery.message.chat.id, callbackQuery.message.message_id,
      `📊 *${periodLabel} Sales Report*\n\nGroup by:`, {
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

  /* ─── SAMPLE BUTTON FLOW: DESIGN ─── */
  } else if (data.startsWith('smd:')) {
    const val = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'sample_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    if (val === '__more__') { await showSampleDesignPicker(bot, callbackQuery.message.chat.id, uid, true); return; }
    session.design = val;
    session.step = 'shade';
    sessionStore.set(uid, session);
    await showSampleShadePicker(bot, callbackQuery.message.chat.id, uid, val);

  /* ─── SAMPLE BUTTON FLOW: SHADE ─── */
  } else if (data.startsWith('smsh:')) {
    const val = data.slice(5);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'sample_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    session.shade = val === '-' ? '' : val;
    session.step = 'customer';
    sessionStore.set(uid, session);
    await showSampleCustomerPicker(bot, callbackQuery.message.chat.id, uid);

  /* ─── SAMPLE BUTTON FLOW: CUSTOMER ─── */
  } else if (data.startsWith('smcu:')) {
    const val = data.slice(5);
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'sample_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);

    if (val === '__more__') { await showSampleCustomerPicker(bot, chatId, uid, true); return; }
    if (val === '__new__') {
      session.step = 'sample_new_cust_name';
      sessionStore.set(uid, session);
      await bot.sendMessage(chatId, '📝 Enter new customer *full name*:', { parse_mode: 'Markdown' });
      return;
    }
    session.customer = val;
    session.step = 'quantity';
    sessionStore.set(uid, session);
    await showSampleQuantityPicker(bot, chatId, uid);

  /* ─── SAMPLE BUTTON FLOW: QUANTITY ─── */
  } else if (data.startsWith('smq:')) {
    const val = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'sample_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    if (val === '__custom__') {
      session.step = 'quantity_custom';
      sessionStore.set(uid, session);
      await bot.sendMessage(chatId, 'Enter custom quantity (number of pieces):');
      return;
    }
    session.quantity = val;
    session.step = 'type';
    sessionStore.set(uid, session);
    await showSampleTypePicker(bot, chatId, uid);

  /* ─── SAMPLE BUTTON FLOW: FOLLOW-UP QUICK ─── */
  } else if (data.startsWith('smfq:')) {
    const dateStr = data.slice(5);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'sample_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: `Follow-up: ${dateStr}` });
    session.followup_date = dateStr;
    session.step = 'confirm';
    sessionStore.set(uid, session);
    await showSampleConfirmation(bot, callbackQuery.message.chat.id, uid);

  /* ─── SAMPLE BUTTON FLOW: CALENDAR (entry + nav + pick) ─── */
  } else if (data.startsWith('smfcal:') || data.startsWith('smfnav:')) {
    const offset = parseInt(data.split(':')[1] || '0');
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'sample_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    const rows = buildDatePicker('smf', offset);
    rows.push([{ text: '❌ Cancel', callback_data: 'smcanc:0' }]);
    await bot.answerCallbackQuery(callbackQuery.id);
    await _sampleRender(bot, callbackQuery.message.chat.id, uid, 'Pick follow-up date:', rows);

  } else if (data.startsWith('smfpick:')) {
    const dateStr = data.slice(8);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'sample_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: `Follow-up: ${dateStr}` });
    session.followup_date = dateStr;
    session.step = 'confirm';
    sessionStore.set(uid, session);
    await showSampleConfirmation(bot, callbackQuery.message.chat.id, uid);

  /* ─── SAMPLE BUTTON FLOW: CANCEL ─── */
  } else if (data.startsWith('smcanc:')) {
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled.' });
    if (session && session.flowMessageId) {
      await bot.editMessageText('❌ Sample request cancelled.', {
        chat_id: callbackQuery.message.chat.id,
        message_id: session.flowMessageId,
      }).catch(() => {});
    } else {
      await bot.sendMessage(callbackQuery.message.chat.id, '❌ Sample request cancelled.');
    }
    sessionStore.clear(uid);

  /* ─── ADD CUSTOMER BUTTON FLOW ─── */
  } else if (data.startsWith('accanc:')) {
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled.' });
    if (session && session.flowMessageId) {
      await bot.editMessageText('❌ Add-customer flow cancelled.', {
        chat_id: callbackQuery.message.chat.id,
        message_id: session.flowMessageId,
      }).catch(() => {});
    }
    sessionStore.clear(uid);

  } else if (data.startsWith('acskip:')) {
    const field = data.slice(7);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'add_customer_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Skipped.' });
    if (field === 'phone') {
      session.phone = '';
      session.step = 'address';
      sessionStore.set(uid, session);
      await showAddCustomerAddressStep(bot, callbackQuery.message.chat.id, uid);
    } else if (field === 'address') {
      session.address = '';
      session.step = 'category';
      sessionStore.set(uid, session);
      await showAddCustomerCategoryPicker(bot, callbackQuery.message.chat.id, uid);
    } else if (field === 'notes') {
      session.notes = '';
      session.step = 'confirm';
      sessionStore.set(uid, session);
      await showAddCustomerConfirmation(bot, callbackQuery.message.chat.id, uid);
    }

  } else if (data.startsWith('accat:')) {
    const cat = data.slice(6);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'add_customer_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    session.category = cat;
    session.step = 'credit_limit';
    sessionStore.set(uid, session);
    await showAddCustomerCreditPicker(bot, callbackQuery.message.chat.id, uid);

  } else if (data.startsWith('accred:')) {
    const val = data.slice(7);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'add_customer_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    if (val === '__custom__') {
      session.step = 'credit_custom';
      sessionStore.set(uid, session);
      await bot.sendMessage(callbackQuery.message.chat.id, 'Enter custom credit limit (number, e.g. 75000):');
      return;
    }
    session.credit_limit = parseInt(val, 10) || 0;
    session.step = 'payment_terms';
    sessionStore.set(uid, session);
    await showAddCustomerPaymentTermsStep(bot, callbackQuery.message.chat.id, uid);

  } else if (data.startsWith('acpt:')) {
    const val = data.slice(5);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'add_customer_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    if (val === '__custom__') {
      session.step = 'payment_terms_custom';
      sessionStore.set(uid, session);
      await bot.sendMessage(callbackQuery.message.chat.id, 'Enter custom payment terms (e.g. "Net 45", "50% advance"):');
      return;
    }
    session.payment_terms = val;
    session.step = 'notes';
    sessionStore.set(uid, session);
    await showAddCustomerNotesStep(bot, callbackQuery.message.chat.id, uid);

  } else if (data.startsWith('acconf:')) {
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'add_customer_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Submitting...' });

    const custData = {
      name: session.name,
      phone: session.phone || '',
      address: session.address || '',
      category: session.category || 'Retail',
      credit_limit: session.credit_limit || 0,
      payment_terms: session.payment_terms || 'COD',
      notes: session.notes || '',
    };

    // Queue for 2-admin approval (same pattern as existing add_customer text flow).
    const requestId = genId();
    await approvalQueueRepository.append({
      requestId, user: uid,
      actionJSON: { action: 'add_customer', ...custData },
      riskReason: 'New customer registration requires admin approval',
      status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: 'add_customer' }, uid);

    if (session.flowMessageId) {
      await bot.editMessageText(
        `👥 *Add Customer — submitted*\n\n${_acHeader(session)}\n\n⏳ Waiting for admin approval.\nRequest: \`${requestId}\``,
        { chat_id: chatId, message_id: session.flowMessageId, parse_mode: 'Markdown' },
      ).catch(() => {});
    }

    const userLabel = await getRequesterDisplayName(uid, null);
    const summary =
      `Add Customer\nName: ${custData.name}\nPhone: ${custData.phone || '—'}\nAddress: ${custData.address || '—'}\n` +
      `Category: ${custData.category}\nCredit limit: ${fmtMoney(custData.credit_limit)}\n` +
      `Payment terms: ${custData.payment_terms}\nNotes: ${custData.notes || '—'}`;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, 'New customer requires admin approval');

    sessionStore.clear(uid);

  /* ─── BANK MANAGER: Add New Bank (prompt for text) ─── */
  } else if (data.startsWith('bkadd:')) {
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    if (!config.access.adminIds.includes(uid)) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    sessionStore.set(uid, {
      type: 'add_bank_flow', step: 'name',
      flowMessageId: callbackQuery.message.message_id,
    });
    await editOrSend(bot, chatId, callbackQuery.message.message_id,
      '🏦 *Add New Bank*\n\nEnter the bank name (reply in chat), or tap Cancel.', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'bkback:0' }]] },
    });

  /* ─── BANK MANAGER: back to manager screen ─── */
  } else if (data.startsWith('bkback:')) {
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    await bot.answerCallbackQuery(callbackQuery.id);
    sessionStore.clear(uid);
    await showBankManager(bot, chatId, uid, callbackQuery.message.message_id);

  /* ─── BANK MANAGER: tap existing bank → confirm remove ─── */
  } else if (data.startsWith('bkrm:')) {
    const bankName = data.slice(5);
    const uid = String(callbackQuery.from.id);
    if (!config.access.adminIds.includes(uid)) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await showBankRemoveConfirm(bot, callbackQuery.message.chat.id, bankName, callbackQuery.message.message_id);

  /* ─── BANK MANAGER: confirm remove → queue approval ─── */
  } else if (data.startsWith('bkrmc:')) {
    const bankName = data.slice(6);
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    if (!config.access.adminIds.includes(uid)) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Submitting...' });

    const requestId = genId();
    await approvalQueueRepository.append({
      requestId, user: uid,
      actionJSON: { action: 'remove_bank', bank_name: bankName },
      riskReason: 'Bank removal requires admin approval', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: 'remove_bank', bank: bankName }, uid);

    await editOrSend(bot, chatId, callbackQuery.message.message_id,
      `🏦 *Remove Bank — submitted*\n\nBank: *${bankName}*\n\n⏳ Waiting for admin approval.\nRequest: \`${requestId}\``, {
      parse_mode: 'Markdown',
    });
    const userLabel = await getRequesterDisplayName(uid, null);
    await approvalEvents.notifyAdminsApprovalRequest(
      bot, requestId, userLabel,
      `Remove Bank\nBank: ${bankName}`,
      'Bank removal requires admin approval',
    );

  /* ─── UPDATE PRICE TAP FLOW ─── */
  } else if (data.startsWith('upcanc:')) {
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled.' });
    if (session && session.flowMessageId) {
      await bot.editMessageText('❌ Update Price cancelled.', {
        chat_id: callbackQuery.message.chat.id, message_id: session.flowMessageId,
      }).catch(() => {});
    }
    sessionStore.clear(uid);

  } else if (data.startsWith('upd:')) {
    const design = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'update_price_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    session.design = design;
    session.step = 'shade';
    sessionStore.set(uid, session);
    await showUpdatePriceShadePicker(bot, callbackQuery.message.chat.id, uid);

  } else if (data.startsWith('ups:')) {
    const shade = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'update_price_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    session.shade = shade;
    session.step = 'nudge';
    sessionStore.set(uid, session);
    await showUpdatePriceNudgePicker(bot, callbackQuery.message.chat.id, uid);

  } else if (data.startsWith('upn:')) {
    const val = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'update_price_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    if (val === '__custom__') {
      session.step = 'price_custom';
      sessionStore.set(uid, session);
      await bot.sendMessage(chatId, 'Enter the new price per yard (number, e.g. 1500):');
      return;
    }
    const n = parseFloat(val);
    if (!Number.isFinite(n) || n <= 0) { await bot.sendMessage(chatId, 'Invalid price.'); return; }
    session.newPrice = n;
    session.step = 'confirm';
    sessionStore.set(uid, session);
    await showUpdatePriceConfirm(bot, chatId, uid);

  } else if (data.startsWith('upconf:')) {
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'update_price_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Submitting...' });
    const filters = { design: session.design };
    if (session.shade && session.shade !== '__all__') filters.shade = session.shade;
    const requestId = genId();
    await approvalQueueRepository.append({
      requestId, user: uid,
      actionJSON: { action: 'update_price', filters, price: session.newPrice },
      riskReason: '2nd admin approval required for price update', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: 'price_update_approval', via: 'tap_flow' }, uid);
    const shadeLabel = session.shade === '__all__' ? 'All shades' : session.shade;
    if (session.flowMessageId) {
      await bot.editMessageText(
        `💲 *Update Price — submitted*\n\nDesign: *${session.design}*\nShade: *${shadeLabel}*\nNew: *${fmtMoney(session.newPrice)}/yard*\n\n⏳ Waiting for 2nd-admin approval.\nRequest: \`${requestId}\``,
        { chat_id: chatId, message_id: session.flowMessageId, parse_mode: 'Markdown' },
      ).catch(() => {});
    }
    const userLabel = await getRequesterDisplayName(uid, null);
    const summary = `Price Update Request\n${session.design}${session.shade !== '__all__' ? ' Shade ' + session.shade : ''}\nNew price: ${fmtMoney(session.newPrice)}/yard\nRequested by: ${userLabel}`;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, '2nd admin approval required');
    sessionStore.clear(uid);

  /* ─── TRANSFER PACKAGE TAP FLOW ─── */
  } else if (data.startsWith('tpcanc:')) {
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled.' });
    if (session && session.flowMessageId) {
      await bot.editMessageText('❌ Transfer Package cancelled.', {
        chat_id: callbackQuery.message.chat.id, message_id: session.flowMessageId,
      }).catch(() => {});
    }
    sessionStore.clear(uid);

  } else if (data.startsWith('tpp:')) {
    const pkg = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'transfer_package_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    session.packageNo = pkg;
    session.step = 'warehouse';
    sessionStore.set(uid, session);
    await showTransferPackageWarehousePicker(bot, callbackQuery.message.chat.id, uid);

  } else if (data.startsWith('tpw:')) {
    const wh = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'transfer_package_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    session.toWh = wh;
    session.step = 'confirm';
    sessionStore.set(uid, session);
    await showTransferPackageConfirm(bot, callbackQuery.message.chat.id, uid);

  } else if (data.startsWith('tpconf:')) {
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'transfer_package_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Submitting...' });
    const requestId = genId();
    await approvalQueueRepository.append({
      requestId, user: uid,
      actionJSON: { action: 'transfer_package', packageNo: session.packageNo, toWarehouse: session.toWh },
      riskReason: 'Package transfer requires admin approval', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: 'transfer_package', via: 'tap_flow' }, uid);
    if (session.flowMessageId) {
      await bot.editMessageText(
        `🚚 *Transfer Package — submitted*\n\nPackage: *${session.packageNo}*\n${session.fromWh} → *${session.toWh}*\n\n⏳ Waiting for admin approval.\nRequest: \`${requestId}\``,
        { chat_id: chatId, message_id: session.flowMessageId, parse_mode: 'Markdown' },
      ).catch(() => {});
    }
    const userLabel = await getRequesterDisplayName(uid, null);
    const summary = `Transfer Package\nPackage: ${session.packageNo}\nDesign: ${session.design || '?'} ${session.shade || ''}\nThans: ${session.availableThans} · Yards: ${fmtQty(session.availableYards)}\nFrom: ${session.fromWh}\nTo: ${session.toWh}`;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, 'Package transfer requires admin approval');
    sessionStore.clear(uid);

  /* ─── TRANSFER THAN TAP FLOW ─── */
  } else if (data.startsWith('ttcanc:')) {
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled.' });
    if (session && session.flowMessageId) {
      await bot.editMessageText('❌ Transfer Than cancelled.', {
        chat_id: callbackQuery.message.chat.id, message_id: session.flowMessageId,
      }).catch(() => {});
    }
    sessionStore.clear(uid);

  } else if (data.startsWith('ttp:')) {
    const pkg = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'transfer_than_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    session.packageNo = pkg;
    session.step = 'than';
    sessionStore.set(uid, session);
    await showTransferThanThanPicker(bot, callbackQuery.message.chat.id, uid);

  } else if (data.startsWith('tth:')) {
    const thanNo = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'transfer_than_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    session.thanNo = thanNo;
    session.step = 'warehouse';
    sessionStore.set(uid, session);
    await showTransferThanWarehousePicker(bot, callbackQuery.message.chat.id, uid);

  } else if (data.startsWith('ttw:')) {
    const wh = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'transfer_than_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    session.toWh = wh;
    session.step = 'confirm';
    sessionStore.set(uid, session);
    await showTransferThanConfirm(bot, callbackQuery.message.chat.id, uid);

  } else if (data.startsWith('ttconf:')) {
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'transfer_than_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Submitting...' });
    const requestId = genId();
    await approvalQueueRepository.append({
      requestId, user: uid,
      actionJSON: { action: 'transfer_than', packageNo: session.packageNo, thanNo: session.thanNo, toWarehouse: session.toWh },
      riskReason: 'Than transfer requires admin approval', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: 'transfer_than', via: 'tap_flow' }, uid);
    if (session.flowMessageId) {
      await bot.editMessageText(
        `↔️ *Transfer Than — submitted*\n\nPackage: *${session.packageNo}* · Than: *#${session.thanNo}*\n${session.fromWh} → *${session.toWh}*\n\n⏳ Waiting for admin approval.\nRequest: \`${requestId}\``,
        { chat_id: chatId, message_id: session.flowMessageId, parse_mode: 'Markdown' },
      ).catch(() => {});
    }
    const userLabel = await getRequesterDisplayName(uid, null);
    const summary = `Transfer Than\nPackage: ${session.packageNo}\nThan: ${session.thanNo}\nDesign: ${session.design || '?'} ${session.shade || ''}\nFrom: ${session.fromWh}\nTo: ${session.toWh}`;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, 'Than transfer requires admin approval');
    sessionStore.clear(uid);

  /* ─── RETURN THAN TAP FLOW ─── */
  } else if (data.startsWith('rtcanc:')) {
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled.' });
    if (session && session.flowMessageId) {
      await bot.editMessageText('❌ Return Than cancelled.', {
        chat_id: callbackQuery.message.chat.id, message_id: session.flowMessageId,
      }).catch(() => {});
    }
    sessionStore.clear(uid);

  } else if (data.startsWith('rtp:')) {
    const pkg = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'return_than_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    session.packageNo = pkg;
    session.step = 'than';
    sessionStore.set(uid, session);
    await showReturnThanThanPicker(bot, callbackQuery.message.chat.id, uid);

  } else if (data.startsWith('rth:')) {
    const thanNo = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'return_than_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    session.thanNo = thanNo;
    session.step = 'confirm';
    sessionStore.set(uid, session);
    await showReturnThanConfirm(bot, callbackQuery.message.chat.id, uid);

  } else if (data.startsWith('rtconf:')) {
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'return_than_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Submitting...' });
    const requestId = genId();
    await approvalQueueRepository.append({
      requestId, user: uid,
      actionJSON: { action: 'return_than', packageNo: session.packageNo, thanNo: session.thanNo },
      riskReason: 'Than return requires admin approval', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: 'return_than', via: 'tap_flow' }, uid);
    if (session.flowMessageId) {
      await bot.editMessageText(
        `↩️ *Return Than — submitted*\n\nPackage: *${session.packageNo}* · Than: *#${session.thanNo}*\n\n⏳ Waiting for admin approval.\nRequest: \`${requestId}\``,
        { chat_id: chatId, message_id: session.flowMessageId, parse_mode: 'Markdown' },
      ).catch(() => {});
    }
    const userLabel = await getRequesterDisplayName(uid, null);
    const summary = `Return Than\nPackage: ${session.packageNo}\nThan: ${session.thanNo}\nDesign: ${session.design || '?'} ${session.shade || ''}`;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, 'Than return requires admin approval');
    sessionStore.clear(uid);

  /* ─── LEGACY: existing text-started sample flow customer pick (kept for back-compat) ─── */
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

    session.sample_type = sType;
    sessionStore.set(uid, session);

    // Button-flow path → after type → follow-up picker (edit in place)
    if (session.flowMessageId) {
      session.step = 'followup';
      sessionStore.set(uid, session);
      await showSampleFollowupPicker(bot, callbackQuery.message.chat.id, uid);
    } else {
      // Legacy text-flow path → ask for qty in text
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }).catch(() => {});
      session.step = 'quantity';
      sessionStore.set(uid, session);
      await bot.sendMessage(callbackQuery.message.chat.id, `Type: *${sType}*\n\nHow many sample pieces?`, { parse_mode: 'Markdown' });
    }

  } else if (data.startsWith('smpconf:')) {
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'sample_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Submitting...' });
    if (session.flowMessageId) {
      await bot.editMessageText(`🧪 *Give Sample — submitted*\n\n${_sampleHeader(session)}\n\n⏳ Waiting for admin approval.`, {
        chat_id: callbackQuery.message.chat.id,
        message_id: session.flowMessageId,
        parse_mode: 'Markdown',
      }).catch(() => {});
    } else {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }).catch(() => {});
    }
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
    const isAdminUser = config.access.adminIds.includes(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: view === 'design' ? 'Select sub-view...' : 'Generating report...' });

    if (view === 'design') {
      await editOrSend(bot, callbackQuery.message.chat.id, callbackQuery.message.message_id,
        '📦 *Design Wise — Select view:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '📦 Summary', callback_data: 'sdv:design_summary' }, { text: '📅 Date-wise', callback_data: 'sdv:design_datewise' }],
        ] },
      });
      return;
    }

    // Terminal view: wipe the keyboard so the selector can't be re-tapped;
    // the actual (long) report will post as a new message below.
    await bot.editMessageReplyMarkup({ inline_keyboard: [] },
      { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id }).catch(() => {});

    try {
      const sold = await getSoldItems();
      if (!sold.length) {
        await bot.sendMessage(callbackQuery.message.chat.id, 'No sold items found in inventory.');
        return;
      }
      let report;
      if (view === 'customer') report = buildCustomerWiseReport(sold, isAdminUser);
      else if (view === 'warehouse') report = buildWarehouseWiseReport(sold, isAdminUser);
      else { await bot.sendMessage(callbackQuery.message.chat.id, 'Unknown view.'); return; }
      await sendLong(bot, callbackQuery.message.chat.id, report, { parse_mode: 'Markdown' });
    } catch (e) {
      logger.error('Supply details report error', e);
      await bot.sendMessage(callbackQuery.message.chat.id, `Report error: ${e.message}`);
    }

  } else if (data.startsWith('sdv:')) {
    const subView = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const isAdminUser = config.access.adminIds.includes(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Generating report...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    try {
      const sold = await getSoldItems();
      if (!sold.length) {
        await bot.sendMessage(callbackQuery.message.chat.id, 'No sold items found in inventory.');
        return;
      }
      let report;
      if (subView === 'design_summary') report = buildDesignWiseReport(sold, isAdminUser);
      else if (subView === 'design_datewise') report = buildDesignDateWiseReport(sold, isAdminUser);
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
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'order_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id });
    if (val === '__new__') {
      session.step = 'new_order_customer_name';
      sessionStore.set(uid, session);
      await bot.sendMessage(chatId,
        '📝 Enter *new customer name* (will be sent for 2-admin approval):',
        { parse_mode: 'Markdown' });
    } else {
      session.customer = val;
      session.step = 'quantity';
      sessionStore.set(uid, session);
      await bot.sendMessage(chatId, `Customer: *${val}*\n\nPick quantity:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [
            { text: '1 pkg',  callback_data: 'oq:1' },
            { text: '2 pkgs', callback_data: 'oq:2' },
            { text: '5 pkgs', callback_data: 'oq:5' },
            { text: '10 pkgs', callback_data: 'oq:10' },
          ],
          [{ text: '✏️ Custom', callback_data: 'oq:__custom__' }],
          [{ text: '❌ Cancel', callback_data: 'ocanc:1' }],
        ] },
      });
    }

  } else if (data.startsWith('oq:')) {
    const val = data.slice(3);
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'order_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    if (val === '__custom__') {
      session.step = 'quantity_custom';
      sessionStore.set(uid, session);
      await bot.sendMessage(chatId, 'Enter custom quantity (number of packages):');
      return;
    }
    session.quantity = val;
    session.step = 'salesperson';
    sessionStore.set(uid, session);
    await showOrderSalespersonPicker(bot, chatId, uid);

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
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'order_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    if (val === 'today') {
      session.scheduled_date = new Date().toISOString().split('T')[0];
    } else if (val === 'mon') {
      session.scheduled_date = nextWeekday(1);
    } else if (val === 'fri') {
      session.scheduled_date = nextWeekday(5);
    } else if (val === 'custom') {
      // Show calendar picker instead of free-text date prompt.
      const rows = buildDatePicker('odc', 0);
      rows.push([{ text: '❌ Cancel', callback_data: 'ocanc:1' }]);
      await bot.editMessageText('📅 Pick scheduled supply date:', {
        chat_id: chatId, message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: rows },
      }).catch(async () => {
        await bot.sendMessage(chatId, '📅 Pick scheduled supply date:', { reply_markup: { inline_keyboard: rows } });
      });
      return;
    }
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    session.step = 'confirm';
    sessionStore.set(uid, session);
    await showOrderSummary(bot, chatId, session);

  } else if (data.startsWith('odcnav:')) {
    // Calendar month navigation for order-flow date picker.
    const offset = parseInt(data.replace('odcnav:', ''));
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'order_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    const rows = buildDatePicker('odc', offset);
    rows.push([{ text: '❌ Cancel', callback_data: 'ocanc:1' }]);
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: rows }, {
      chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id,
    }).catch(() => {});

  } else if (data.startsWith('odcpick:')) {
    const dateStr = data.slice(8);
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'order_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: `Date: ${dateStr}` });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: callbackQuery.message.message_id,
    }).catch(() => {});
    session.scheduled_date = dateStr;
    session.step = 'confirm';
    sessionStore.set(uid, session);
    await showOrderSummary(bot, chatId, session);

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
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'receipt_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    if (val === '__more__') {
      // In-place expand to full customer list.
      await showReceiptCustomerPicker(bot, chatId, uid, true, callbackQuery.message.message_id);
      return;
    }
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    if (val === '__new__') {
      session.step = 'receipt_new_cust_name';
      sessionStore.set(uid, session);
      await bot.sendMessage(chatId, '📝 Enter *new customer name* (will be sent for 2-admin approval):', { parse_mode: 'Markdown' });
    } else {
      session.customer = val;
      session.step = 'amount';
      sessionStore.set(uid, session);
      await bot.sendMessage(chatId, `Customer: *${val}*\n\nEnter the payment amount received (NGN):`, { parse_mode: 'Markdown' });
    }

  } else if (data.startsWith('rccanc:')) {
    const uid = String(callbackQuery.from.id);
    sessionStore.clear(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled.' });
    await bot.editMessageText('❌ Receipt upload cancelled.', {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id,
    }).catch(() => {});

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

  /* ─── NOOP (calendar headers etc.) ─── */
  } else if (data === 'noop') {
    await bot.answerCallbackQuery(callbackQuery.id);

  /* ─── REPORT CUSTOMER PICKER (rpt:<type>:<customerName>) ─── */
  } else if (data.startsWith('rpt:')) {
    const rest = data.slice(4);
    const sepIdx = rest.indexOf(':');
    if (sepIdx < 0) { await bot.answerCallbackQuery(callbackQuery.id); return; }
    const reportType = rest.slice(0, sepIdx);
    const payload = rest.slice(sepIdx + 1);

    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    await bot.answerCallbackQuery(callbackQuery.id);

    if (payload === '__more__') {
      await showCustomerPickerForReport(bot, chatId, reportType, true, messageId);
      return;
    }

    // Wipe the picker's keyboard so it can't be re-tapped, then run the report.
    await bot.editMessageReplyMarkup({ inline_keyboard: [] },
      { chat_id: chatId, message_id: messageId }).catch(() => {});

    // Note: activity counts were already incremented when the user tapped
    // the hub sub-button (handled in the act: branch below). No double-count here.
    const customerName = payload;
    if (reportType === 'history') {
      await sendCustomerHistoryReport(bot, chatId, customerName);
    } else if (reportType === 'pattern') {
      await sendCustomerPatternReport(bot, chatId, customerName);
    } else if (reportType === 'notes') {
      await sendCustomerNotesReport(bot, chatId, customerName);
    } else if (reportType === 'writenote') {
      const uid = String(callbackQuery.from.id);
      sessionStore.set(uid, { type: 'add_note_flow', step: 'note_text', customer: customerName });
      await bot.sendMessage(chatId,
        `✏️ *Add Note for ${customerName}*\n\nType the note (e.g. "prefers Shade 3", "wants bulk discount"):`,
        { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, 'Unknown report type.');
    }

  /* ─── SAMPLE STATUS DATE WINDOW ─── */
  } else if (data.startsWith('smsd:')) {
    const val = data.slice(5);
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] },
      { chat_id: chatId, message_id: messageId }).catch(() => {});
    const opts = val === 'all' ? {} : { daysBack: parseInt(val, 10) };
    await sendSampleStatusReport(bot, chatId, opts);

  /* ─── LIST PACKAGES: DESIGN PICK ─── */
  } else if (data.startsWith('lpk:')) {
    const design = data.slice(4);
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    await bot.answerCallbackQuery(callbackQuery.id);
    if (design === '__more__') {
      await showDesignPickerForReport(bot, chatId, 'lpk', true, messageId);
      return;
    }
    await bot.editMessageReplyMarkup({ inline_keyboard: [] },
      { chat_id: chatId, message_id: messageId }).catch(() => {});
    await sendListPackagesReport(bot, chatId, design);

  /* ─── CHECK STOCK: DESIGN PICK ─── */
  } else if (data.startsWith('cks:')) {
    const design = data.slice(4);
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    await bot.answerCallbackQuery(callbackQuery.id);
    if (design === '__more__') {
      await showDesignPickerForReport(bot, chatId, 'cks', true, messageId);
      return;
    }
    await bot.editMessageReplyMarkup({ inline_keyboard: [] },
      { chat_id: chatId, message_id: messageId }).catch(() => {});
    await sendCheckStockReport(bot, chatId, design);

  /* ─── MARK ORDER DELIVERED: ORDER PICK ─── */
  } else if (data.startsWith('mdo:')) {
    const oid = data.slice(4);
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] },
      { chat_id: chatId, message_id: messageId }).catch(() => {});
    await executeMarkOrderDelivered(bot, chatId, uid, oid);

  /* ─── GREETING MENU ACTIVITY TAP ─── */
  } else if (data.startsWith('act:')) {
    const actCode = data.slice(4);
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);

    // Hub tap → expand sub-activities in place (no keyboard wipe).
    if (actCode.startsWith('__hub__:')) {
      const hubId = actCode.slice('__hub__:'.length);
      await renderHubSubmenu(bot, chatId, messageId, uid, hubId);
      return;
    }

    // Back tap → restore greeting menu in place.
    if (actCode === '__back__') {
      await renderGreetingMenuEdit(bot, chatId, messageId, uid, false);
      return;
    }

    // Any other tap ends the menu lifecycle → wipe the keyboard so the
    // stale message can't be tapped again.
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});

    if (actCode === '__more__') {
      await buildGreetingMenu(bot, chatId, uid, true);
      return;
    }

    // Normalize count key to the activity's canonical `code` (some
    // callbacks differ from their code, e.g. act:mark_delivered ↔ mark_order_delivered).
    const tappedActivity = activityRegistry.getByCallback(`act:${actCode}`);
    const countKey = tappedActivity ? tappedActivity.code : actCode;
    userPrefsRepo.incrementActivity(uid, countKey).catch(() => {});

    switch (actCode) {
      case 'supply_request': await startSupplyRequestFlow(bot, chatId, uid); break;
      case 'upload_receipt': await startReceiptFlow(bot, chatId, uid); break;
      case 'my_orders': {
        const orders = await ordersRepo.getByAssignee(uid);
        if (!orders.length) { await bot.sendMessage(chatId, 'You have no pending supply orders.'); break; }
        let out = '📋 *Your Supply Orders*\n\n';
        for (const o of orders) {
          const icon = o.status === 'accepted' ? '✅' : '⏳';
          out += `${icon} *${o.order_id}*\n  Design: ${o.design} | Customer: ${o.customer}\n  Qty: ${o.quantity} | Date: ${o.scheduled_date}\n  Payment: ${o.payment_status} | Status: ${o.status}\n\n`;
        }
        await sendLong(bot, chatId, out, { parse_mode: 'Markdown' });
        break;
      }
      case 'mark_delivered':
        await showMarkDeliveredPicker(bot, chatId, uid);
        break;
      case 'give_sample':
        await startSampleFlowButton(bot, chatId, uid, messageId);
        break;
      case 'supply_details':
        await editOrSend(bot, chatId, messageId, '📊 *Supply Details*\n\nSelect view:', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: '📦 Design / Product wise', callback_data: 'sd:design' }],
            [{ text: '👤 Customer wise', callback_data: 'sd:customer' }],
            [{ text: '🏭 Warehouse wise', callback_data: 'sd:warehouse' }],
          ] },
        });
        break;
      case 'customer_history':
        await showCustomerPickerForReport(bot, chatId, 'history');
        break;
      case 'customer_pattern':
        await showCustomerPickerForReport(bot, chatId, 'pattern');
        break;
      case 'customer_notes':
        await showCustomerPickerForReport(bot, chatId, 'notes');
        break;
      case 'add_note':
        await startAddNoteFlow(bot, chatId, uid, messageId);
        break;
      case 'check_stock':
        await showDesignPickerForReport(bot, chatId, 'cks');
        break;
      case 'list_packages':
        await showDesignPickerForReport(bot, chatId, 'lpk');
        break;
      case 'inventory_details': {
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        await editOrSend(bot, chatId, messageId, '📦 *Inventory Details*\n\nSelect view:', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: '🏭 Warehouse wise', callback_data: 'inv:wh' }],
            [{ text: '📦 Design wise', callback_data: 'inv:design' }],
          ] },
        });
        break;
      }
      case 'sales_report': {
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        await editOrSend(bot, chatId, messageId, '📊 *Sales Report*\n\nSelect period:', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: '📅 Weekly (7 days)', callback_data: 'sr:7' }, { text: '📅 Monthly (30 days)', callback_data: 'sr:30' }],
            [{ text: '📅 Quarterly (90 days)', callback_data: 'sr:90' }, { text: '📅 Yearly (365 days)', callback_data: 'sr:365' }],
          ] },
        });
        break;
      }
      case 'customer_ranking': {
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        await sendCustomerRankingReport(bot, chatId);
        break;
      }
      case 'create_order': {
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        await startOrderFlow(bot, chatId, uid);
        break;
      }
      case 'sample_status': {
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Sample status report is admin-only.'); break; }
        await showSampleStatusDatePicker(bot, chatId);
        break;
      }
      case 'manage_users': {
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        await showUserManagement(bot, chatId);
        break;
      }
      case 'manage_depts': {
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        const depts = await departmentsRepo.getAll();
        let text = '🏢 *Departments*\n\n';
        for (const d of depts) {
          text += `*${d.dept_name}* (${d.dept_id})\n  Activities: ${d.allowed_activities.join(', ')}\n  Status: ${d.status}\n\n`;
        }
        await sendLong(bot, chatId, text, { parse_mode: 'Markdown' });
        break;
      }
      case 'manage_wh': {
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        const whs = await inventoryRepository.getWarehouses();
        let text = '🏭 *Warehouses*\n\n';
        for (const w of whs) text += `• ${w}\n`;
        text += '\nTo assign a warehouse to a user, use 👥 Manage Users.';
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        break;
      }
      case 'manage_banks':
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        await showBankManager(bot, chatId, uid, messageId);
        break;
      case 'update_price':
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        await startUpdatePriceFlow(bot, chatId, uid, messageId);
        break;
      case 'transfer_package':
        await startTransferPackageFlow(bot, chatId, uid, messageId);
        break;
      case 'transfer_than':
        await startTransferThanFlow(bot, chatId, uid, messageId);
        break;
      case 'return_than':
        await startReturnThanFlow(bot, chatId, uid, messageId);
        break;
      case 'add_customer':
        await startAddCustomerFlow(bot, chatId, uid, messageId);
        break;
      default:
        await bot.sendMessage(chatId, 'Feature coming soon.');
    }

  /* ─── SUPPLY REQUEST FLOW: WAREHOUSE ─── */
  } else if (data.startsWith('srf_wh:')) {
    const warehouse = data.slice(7);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    sessionStore.set(uid, { type: 'supply_req_flow', warehouse, cart: [], step: 'design' });
    await showDesignsForWarehouse(bot, chatId, uid, warehouse);

  /* ─── SUPPLY REQUEST FLOW: DESIGN PAGE NAV ─── */
  } else if (data.startsWith('srf_dgpg:')) {
    const dir = data.slice(9);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    const session = sessionStore.get(uid);
    if (session && session.type === 'supply_req_flow') {
      session.designPage = (session.designPage || 0) + (dir === 'next' ? 1 : -1);
      if (session.designPage < 0) session.designPage = 0;
      sessionStore.set(uid, session);
      await showDesignsForWarehouse(bot, chatId, uid, session.warehouse);
    }

  /* ─── SUPPLY REQUEST FLOW: DESIGN ─── */
  } else if (data.startsWith('srf_dg:')) {
    const design = data.slice(7);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    const session = sessionStore.get(uid);
    const wh = session ? session.warehouse : '';
    await showShadesForDesign(bot, chatId, uid, design, wh);

  /* ─── SUPPLY REQUEST FLOW: SHADE ─── */
  } else if (data.startsWith('srf_sh:')) {
    const parts = data.slice(7).split('|');
    const design = parts[0];
    const shade = parts[1];
    const availPkgs = parseInt(parts[2]) || 0;
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') return;
    session.currentDesign = design;
    session.currentShade = shade;
    session.currentAvailPkgs = availPkgs;
    session.step = 'quantity';
    sessionStore.set(uid, session);
    await showQuantityPicker(bot, chatId, uid, design, shade, session.warehouse, availPkgs);

  /* ─── SUPPLY REQUEST FLOW: QUANTITY SELECTION ─── */
  } else if (data.startsWith('srf_qty:')) {
    const val = data.slice(8);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired. Start again.' });
      return;
    }

    if (val === '__custom__') {
      await bot.answerCallbackQuery(callbackQuery.id);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
      session.step = 'custom_quantity';
      sessionStore.set(uid, session);
      const lbl = await productTypesRepo.getLabels(session.productType || 'fabric');
      const cPlural = productTypesRepo.pluralize(lbl.container_label, 2).toLowerCase();
      await bot.sendMessage(chatId, `Type the number of ${cPlural} (max ${session.currentAvailPkgs}):`);
      return;
    }

    const qty = parseInt(val);
    if (isNaN(qty) || qty < 1 || qty > session.currentAvailPkgs) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: `Invalid. Choose 1 – ${session.currentAvailPkgs}.` });
      return;
    }
    await bot.answerCallbackQuery(callbackQuery.id, { text: `${qty} added: ${session.currentDesign} ${session.currentShade}` });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    addToCart(session, session.currentDesign, session.currentShade, qty);
    sessionStore.set(uid, session);
    await showCartSummary(bot, chatId, uid);

  /* ─── SUPPLY REQUEST FLOW: CART ACTIONS ─── */
  } else if (data.startsWith('srf_cart:')) {
    const action = data.slice(9);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') return;

    if (action === 'add') {
      await showDesignsForWarehouse(bot, chatId, uid, session.warehouse);
    } else if (action === 'remove') {
      if (!session.cart || !session.cart.length) {
        await bot.sendMessage(chatId, '🛒 Cart is empty.');
        return;
      }
      const rows = session.cart.map((c, i) => [{
        text: `🗑️ ${c.design} ${c.shade} × ${c.quantity}`,
        callback_data: `srf_rm:${i}`,
      }]);
      rows.push([{ text: '⬅️ Back', callback_data: 'srf_cart:back' }]);
      await bot.sendMessage(chatId, 'Tap an item to remove:', { reply_markup: { inline_keyboard: rows } });
    } else if (action === 'proceed') {
      if (!session.cart || !session.cart.length) {
        await bot.sendMessage(chatId, '⚠️ Add at least one item to proceed.');
        await showCartSummary(bot, chatId, uid);
        return;
      }
      session.step = 'customer';
      sessionStore.set(uid, session);
      await showSupplyCustomerPicker(bot, chatId, uid);
    } else if (action === 'cancel') {
      sessionStore.clear(uid);
      await bot.sendMessage(chatId, '❌ Supply request cancelled.');
    } else if (action === 'back') {
      await showCartSummary(bot, chatId, uid);
    }

  /* ─── SUPPLY REQUEST FLOW: REMOVE CART ITEM ─── */
  } else if (data.startsWith('srf_rm:')) {
    const idx = parseInt(data.slice(7));
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') return;

    if (session.cart && idx >= 0 && idx < session.cart.length) {
      const removed = session.cart.splice(idx, 1)[0];
      await bot.answerCallbackQuery(callbackQuery.id, { text: `Removed ${removed.design} ${removed.shade}.` });
    } else {
      await bot.answerCallbackQuery(callbackQuery.id);
    }
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    sessionStore.set(uid, session);
    await showCartSummary(bot, chatId, uid);

  /* ─── SUPPLY REQUEST FLOW: CUSTOMER ─── */
  } else if (data.startsWith('srf_cu:')) {
    const val = data.slice(7);
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);

    const session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') return;

    if (val === '__more__') {
      const allCust = await customersRepo.getAll();
      const active = allCust.filter((c) => (c.status || 'Active').toLowerCase() === 'active');
      const cart = session.cart || [];
      const cartDesigns = [...new Set(cart.map((c) => c.design))];
      const topBuyers = await getTopBuyersForDesigns(cartDesigns);
      const suggestedSet = new Set(topBuyers.slice(0, 6));
      const remaining = active.filter((c) => !suggestedSet.has(c.name));
      const rows = [];
      for (let i = 0; i < remaining.length; i += 2) {
        const row = [{ text: `👤 ${remaining[i].name}`, callback_data: `srf_cu:${remaining[i].name}` }];
        if (remaining[i + 1]) row.push({ text: `👤 ${remaining[i + 1].name}`, callback_data: `srf_cu:${remaining[i + 1].name}` });
        rows.push(row);
      }
      rows.push([{ text: '➕ Add New Customer', callback_data: 'srf_cu:__new__' }]);
      await editOrSend(bot, chatId, messageId, '👤 All other customers:', {
        reply_markup: { inline_keyboard: rows },
      });
      return;
    }

    if (val === '__new__') {
      session.step = 'new_srf_customer_name';
      sessionStore.set(uid, session);
      await editOrSend(bot, chatId, messageId, '📝 Enter new customer *full name*:', { parse_mode: 'Markdown' });
      return;
    }
    session.customer = val;
    session.step = 'salesperson';
    sessionStore.set(uid, session);
    await showSupplySalespersonPicker(bot, chatId, false, messageId);

  /* ─── SUPPLY REQUEST FLOW: SALESPERSON ─── */
  } else if (data.startsWith('srf_sp:')) {
    const val = data.slice(7);
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);

    const session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') return;

    if (val === '__more__') {
      await showSupplySalespersonPicker(bot, chatId, true, messageId);
      return;
    }

    session.salesperson = val;
    session.step = 'payment';
    sessionStore.set(uid, session);
    await showSupplyPaymentPicker(bot, chatId, uid);

  /* ─── SUPPLY REQUEST FLOW: PAYMENT ─── */
  } else if (data.startsWith('srf_pm:')) {
    const val = data.slice(7);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);

    const session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') return;

    session.paymentMode = val;
    session.step = 'date';
    sessionStore.set(uid, session);
    await showSupplyDatePicker(bot, chatId, uid);

  /* ─── SUPPLY REQUEST FLOW: DATE PICKER ─── */
  } else if (data.startsWith('srf_dt')) {
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);

    if (data.startsWith('srf_dtcal:')) {
      const offset = parseInt(data.replace('srf_dtcal:', '') || '0');
      const rows = buildDatePicker('srf_dt', offset);
      await bot.answerCallbackQuery(callbackQuery.id);
      await bot.editMessageReplyMarkup({ inline_keyboard: rows }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    } else if (data.startsWith('srf_dtnav:')) {
      const offset = parseInt(data.replace('srf_dtnav:', ''));
      const rows = buildDatePicker('srf_dt', offset);
      await bot.answerCallbackQuery(callbackQuery.id);
      await bot.editMessageReplyMarkup({ inline_keyboard: rows }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    } else if (data.startsWith('srf_dtpick:')) {
      const dateStr = data.replace('srf_dtpick:', '');
      await bot.answerCallbackQuery(callbackQuery.id, { text: `Date: ${dateStr}` });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

      if (session && session.type === 'supply_req_flow') {
        session.supplyDate = dateStr;
        sessionStore.set(uid, session);
        await showSupplyConfirmation(bot, chatId, uid);
      }
    }

  /* ─── SUPPLY REQUEST FLOW: DOCUMENT ─── */
  } else if (data.startsWith('srf_doc:')) {
    const val = data.slice(8);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

    const session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') return;

    if (val === 'cancel') {
      sessionStore.clear(uid);
      await bot.sendMessage(chatId, '❌ Supply request cancelled.');
      return;
    }
    await finalizeSupplyRequest(bot, chatId, uid);

  /* ─── SUPPLY REQUEST FLOW: CONFIRM ─── */
  } else if (data.startsWith('srf_conf:')) {
    const val = data.slice(9);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id, { text: val === 'yes' ? 'Submitting...' : 'Cancelled.' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

    if (val === 'cancel') {
      sessionStore.clear(uid);
      await bot.sendMessage(chatId, '❌ Supply request cancelled.');
      return;
    }

    const session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') return;

    const docInfo = { fileId: session.docFileId, type: session.docType, mime: session.docMime };
    const cart = session.cart || [];
    const actionJSON = {
      action: 'supply_request',
      warehouse: session.warehouse,
      productType: session.productType || 'fabric',
      cart,
      customer: session.customer,
      salesperson: session.salesperson,
      paymentMode: session.paymentMode,
      salesDate: session.supplyDate,
      sale_doc_file_id: docInfo.fileId || null,
      sale_doc_type: docInfo.type || null,
      sale_doc_mime: docInfo.mime || null,
    };
    sessionStore.clear(uid);

    const requestId = genId();
    const isAdmin = config.access.adminIds.includes(uid);
    const approvalReason = isAdmin ? '2nd admin approval required' : 'Admin approval required';

    await approvalQueueRepository.append({
      requestId, user: uid, actionJSON, riskReason: approvalReason, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: approvalReason }, uid);

    const userLabel = await getRequesterDisplayName(uid, null);
    const labels = await productTypesRepo.getLabels(session.productType || 'fabric');
    const cShort = labels.container_short;
    const cartLines = cart.map((c) => {
      const m = getMaterialInfo(c.design);
      return `${m.icon} ${c.design} [${m.name}] │ Shade: ${c.shade} │ ×${c.quantity} ${cShort}`;
    }).join('\n');
    const totalPkgs = cart.reduce((s, c) => s + c.quantity, 0);
    const containerPlural = productTypesRepo.pluralize(labels.container_label, totalPkgs).toLowerCase();

    let summary = `Supply Request\n`;
    summary += `🏭 ${actionJSON.warehouse}\n`;
    summary += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    summary += `${cartLines}\n`;
    summary += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    summary += `📦 Total: ${totalPkgs} ${containerPlural}\n`;
    summary += `👤 ${actionJSON.customer}\n`;
    summary += `🧑 ${actionJSON.salesperson}\n`;
    summary += `💳 ${actionJSON.paymentMode}\n`;
    summary += `📅 ${fmtDate(actionJSON.salesDate)}`;
    if (actionJSON.sale_doc_file_id) summary += `\n📎 Document attached`;

    const excludeId = isAdmin ? uid : undefined;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, approvalReason, excludeId);

    if (actionJSON.sale_doc_file_id) {
      for (const adminId of config.access.adminIds) {
        if (excludeId && String(adminId) === String(excludeId)) continue;
        try {
          if (actionJSON.sale_doc_type === 'photo') {
            await bot.sendPhoto(adminId, actionJSON.sale_doc_file_id, { caption: `📎 Bill for ${requestId}` });
          } else {
            await bot.sendDocument(adminId, actionJSON.sale_doc_file_id, { caption: `📎 Bill for ${requestId}` });
          }
        } catch (_) {}
      }
    }

    const approverLabel = isAdmin ? '2nd admin' : 'admin';
    await bot.sendMessage(chatId,
      `✅ Supply request submitted.\n\n🏭 ${actionJSON.warehouse}\n━━━━━━━━━━━━━━━━━━━━━━\n${cartLines}\n━━━━━━━━━━━━━━━━━━━━━━\n📦 Total: ${totalPkgs} ${containerPlural}\n👤 ${actionJSON.customer}\n📅 ${fmtDate(actionJSON.salesDate)}\n\n⏳ Waiting for ${approverLabel} approval.\nRequest: ${requestId}`, {
        parse_mode: 'Markdown',
      });

  /* ─── ADMIN: ASSIGN DEPT / WAREHOUSE ─── */
  } else if (data.startsWith('adm:')) {
    const action = data.slice(4);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    if (!config.access.adminIds.includes(uid)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' });
      return;
    }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

    if (action === 'assign_dept') {
      const users = await usersRepository.getAll();
      const rows = users.map((u) => [{ text: `${u.name || u.user_id} (${u.department || 'none'})`, callback_data: `adm_du:${u.user_id}` }]);
      sessionStore.set(uid, { type: 'adm_flow', action: 'assign_dept', step: 'pick_user' });
      await bot.sendMessage(chatId, '🏢 Select user to assign department:', { reply_markup: { inline_keyboard: rows } });
    } else if (action === 'assign_wh') {
      const users = await usersRepository.getAll();
      const rows = users.map((u) => [{ text: `${u.name || u.user_id} (${u.warehouses.join(', ') || 'none'})`, callback_data: `adm_wu:${u.user_id}` }]);
      sessionStore.set(uid, { type: 'adm_flow', action: 'assign_wh', step: 'pick_user' });
      await bot.sendMessage(chatId, '🏭 Select user to assign warehouse:', { reply_markup: { inline_keyboard: rows } });
    } else if (action === 'add_user') {
      sessionStore.set(uid, { type: 'adm_flow', action: 'add_user', step: 'enter_id' });
      await bot.sendMessage(chatId, 'Enter the new user Telegram ID (numeric):');
    }

  } else if (data.startsWith('adm_du:')) {
    const targetUserId = data.slice(7);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

    const depts = await departmentsRepo.getAll();
    const rows = depts.filter((d) => d.status === 'active').map((d) => [{ text: `🏢 ${d.dept_name}`, callback_data: `adm_dd:${targetUserId}|${d.dept_name}` }]);
    await bot.sendMessage(chatId, `Select department for user ${targetUserId}:`, { reply_markup: { inline_keyboard: rows } });

  } else if (data.startsWith('adm_dd:')) {
    const [targetUserId, deptName] = data.slice(7).split('|');
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Assigning...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

    const ok = await usersRepository.updateDepartment(targetUserId, deptName);
    if (ok) {
      await bot.sendMessage(chatId, `✅ User ${targetUserId} assigned to department *${deptName}*.`, { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, `⚠️ User ${targetUserId} not found in Users sheet. Add them first.`);
    }
    sessionStore.clear(uid);

  } else if (data.startsWith('adm_wu:')) {
    const targetUserId = data.slice(7);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

    const warehouses = await inventoryRepository.getWarehouses();
    const user = await usersRepository.findByUserId(targetUserId);
    const current = user ? user.warehouses : [];
    const rows = warehouses.map((w) => {
      const has = current.includes(w);
      return [{ text: `${has ? '✅' : '⬜'} ${w}`, callback_data: `adm_wt:${targetUserId}|${w}` }];
    });
    rows.push([{ text: '💾 Save', callback_data: `adm_ws:${targetUserId}` }]);
    sessionStore.set(uid, { type: 'adm_flow', action: 'assign_wh', targetUserId, pendingWarehouses: [...current] });
    await bot.sendMessage(chatId, `🏭 Toggle warehouses for ${user ? user.name : targetUserId}:`, { reply_markup: { inline_keyboard: rows } });

  } else if (data.startsWith('adm_wt:')) {
    const [targetUserId, wh] = data.slice(7).split('|');
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'adm_flow') return;

    if (!session.pendingWarehouses) session.pendingWarehouses = [];
    const idx = session.pendingWarehouses.indexOf(wh);
    if (idx >= 0) { session.pendingWarehouses.splice(idx, 1); }
    else { session.pendingWarehouses.push(wh); }
    sessionStore.set(uid, session);

    const warehouses = await inventoryRepository.getWarehouses();
    const rows = warehouses.map((w) => {
      const has = session.pendingWarehouses.includes(w);
      return [{ text: `${has ? '✅' : '⬜'} ${w}`, callback_data: `adm_wt:${targetUserId}|${w}` }];
    });
    rows.push([{ text: '💾 Save', callback_data: `adm_ws:${targetUserId}` }]);
    await bot.answerCallbackQuery(callbackQuery.id, { text: `${idx >= 0 ? 'Removed' : 'Added'} ${wh}` });
    await bot.editMessageReplyMarkup({ inline_keyboard: rows }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

  } else if (data.startsWith('adm_ws:')) {
    const targetUserId = data.slice(7);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'adm_flow') return;

    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Saving...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

    const ok = await usersRepository.updateWarehouses(targetUserId, session.pendingWarehouses || []);
    if (ok) {
      await bot.sendMessage(chatId, `✅ Warehouses for ${targetUserId} updated: ${(session.pendingWarehouses || []).join(', ') || 'none'}`, { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, `⚠️ User ${targetUserId} not found.`);
    }
    sessionStore.clear(uid);

  } else {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Unknown action.' });
  }
}

async function handleAdminFlowText(bot, chatId, userId, text, session) {
  if (session.action === 'add_user' && session.step === 'enter_id') {
    const numId = text.trim();
    if (!/^\d+$/.test(numId)) {
      await bot.sendMessage(chatId, 'Please enter a valid numeric Telegram ID.');
      return true;
    }
    session.newUserId = numId;
    session.step = 'enter_name';
    sessionStore.set(userId, session);
    await bot.sendMessage(chatId, 'Enter the user name:');
    return true;
  }
  if (session.action === 'add_user' && session.step === 'enter_name') {
    const name = text.trim();
    if (!name) {
      await bot.sendMessage(chatId, 'Please enter a name.');
      return true;
    }
    await usersRepository.append({ user_id: session.newUserId, name, role: 'employee' });
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, `✅ User *${name}* (${session.newUserId}) added successfully. Assign department and warehouses via 👥 Manage Users.`, { parse_mode: 'Markdown' });
    return true;
  }
  return false;
}

module.exports = {
  handleMessage,
  handleCallbackQuery,
  handleFileMessage,
  // Exposed for cross-module flow resumption (e.g. approval events).
  showSampleQuantityPicker,
  showSampleCustomerPicker,
};
