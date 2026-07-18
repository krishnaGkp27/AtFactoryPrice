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
const { buildShadeNameMap, buildShadeLabel, layoutShadeRows, buildSelectAllLines, formatShadeRef } = require('../utils/shadeButtons');
const cartFormat = require('../utils/cartFormat');
const settingsRepo = require('../repositories/settingsRepository');
const usersRepository = require('../repositories/usersRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const productTypesRepo = require('../repositories/productTypesRepository');
const designCategoriesRepo = require('../repositories/designCategoriesRepository');
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
const designAssetsRepo = require('../repositories/designAssetsRepository');
const designAssetsService = require('../services/designAssetsService');
const pricingService = require('../services/pricingService');
const unitDisplayService = require('../services/unitDisplayService');
const stockValueReport = require('../services/stockValueReport');
const goodsReceiptsRepository = require('../repositories/goodsReceiptsRepository');
const colorDetector = require('../ai/colorDetector');
const catalogFlows = require('./catalogFlowController');
const taskFlow = require('../flows/taskFlow');
const notificationsFlow = require('../flows/notificationsFlow');
const salesWorkflowView = require('../flows/salesWorkflowView');
const goodsReceiptFlow = require('../flows/goodsReceiptFlow');
const procurementPlanView = require('../flows/procurementPlanView');
const bulkReceiveFlow = require('../flows/bulkReceiveFlow');
const photoReceiveFlow = require('../flows/photoReceiveFlow');
const warehouseFlow = require('../flows/warehouseFlow');
const adminFeed = require('../services/adminFeed');
const menuNav = require('../utils/menuNav');
const { downloadTelegramFile } = require('../utils/telegramFiles');
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

// Approval request IDs flow through idGenerator (single source of truth).
const genId = require('../utils/idGenerator').requestId;

const { editOrSend, editOrSendAnchored, sendLong } = require('../utils/telegramUI');
// ANL-1 — usage analytics capture (fire-and-forget; no-op until enabled).
const usageTracker = require('../services/usageTracker');

async function requireApproval(bot, chatId, msg, userId, action, actionJSON, summary) {
  const risk = await riskEvaluate.evaluate({ action, userId });
  if (risk.risk !== 'approval_required') return false;
  const requestId = genId();
  await approvalQueueRepository.append({
    requestId, user: userId, actionJSON, riskReason: risk.reason, status: 'pending',
  });
  await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);
  usageTracker.track({ userId, surface: 'approval', feature: action, event: 'approval_queued', requestId });
  const isAdm = config.access.adminIds.includes(userId);
  const approverLabel = isAdm ? '2nd admin' : 'admin';
  await bot.sendMessage(chatId, `⏳ Needs ${approverLabel} approval (${risk.reason}). Request: ${requestId}`);
  const userLabel = await getRequesterDisplayName(userId, msg);
  const excludeId = isAdm ? userId : undefined;
  await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, risk.reason, excludeId);
  return true;
}

// Currency + formatting are centralized in src/utils/format.js; this controller
// keeps `fmtQty` as a thin wrapper because inventory/sales reports here show
// fractional yards (2 decimals) while format.js defaults to integer quantities.
const {
  CURRENCY,
  currencySymbol: _currencySymbol,
  fmtMoney,
  fmtMoneyShort,
  fmtQty: fmtQtyBase,
} = require('../utils/format');
const CURRENCY_SYMBOL = _currencySymbol(CURRENCY);
const supplyDetailsReport = require('../services/supplyDetailsReport');
// MG-1 — Marketing Group Catalog overlay (spec:
// telegram-ops-bot/specs/marketing-group-catalog.md). Only consumed by
// startSupplyRequestFlow today; later commits (MG-2/3) extend its use.
const marketerOverlay = require('../services/marketerOverlay');
const fieldRoles = require('../services/fieldRoles');
const fieldCatalog = require('../services/fieldCatalog');

function fmtQty(n) { return fmtQtyBase(n, { maxFraction: 2 }); }

/**
 * Render a list with the top-N items expanded and the remainder rolled
 * into a single trailing line. Returns:
 *   { text, hasMore: boolean, restCount: number }
 *
 * @param {Array} items
 * @param {number} n         How many top items to show.
 * @param {(item:any, idx:number)=>string} formatItemFn
 * @param {string} [restLabel='item']  Singular noun for the rest line.
 */
function renderTopNWithRest(items, n, formatItemFn, restLabel = 'item') {
  const out = [];
  const limit = Math.min(n, items.length);
  for (let i = 0; i < limit; i++) out.push(formatItemFn(items[i], i));
  const restCount = Math.max(0, items.length - limit);
  return {
    text: out.join('\n'),
    hasMore: restCount > 0,
    restCount,
  };
}

/**
 * One-line legend that appears once at the top of a report so the
 * data rows can drop their unit labels. Currency line is appended
 * automatically when `hasMoney` is true.
 *
 * @param {string[]} parts Comma-joined into a single italic legend line.
 * @param {boolean} hasMoney
 * @returns {string}
 */
function buildReportLegend(parts, hasMoney) {
  const xs = parts.slice();
  if (hasMoney) xs.push(`amounts in ${CURRENCY}`);
  return `_${xs.join(' · ')}_\n`;
}

const getMaterialInfo = productTypesRepo.getMaterialInfo;
const fmtDate = require('../utils/formatDate');
const { compareWithToday, daysBeforeToday, todayInLagos } = require('../utils/dates');

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

function valStr(value, isAdmin) {
  return isAdmin ? ` — ${fmtMoney(value)}` : '';
}
/** Compact admin-only value tail using short currency symbol. */
function valStrShort(value, isAdmin) {
  return isAdmin ? ` · ${fmtMoneyShort(value)}` : '';
}
/**
 * Per-ROW money tail for supply reports. Hidden by default to keep
 * data rows scannable (Bales/thans/yds is the operational info); the
 * money still shows up at subtotal and grand-total levels via
 * valStrShort. Brought back per-row when the user taps the
 * "💰 Show prices per row" toggle button (sets showRowMoney=true).
 */
function valStrRow(value, isAdmin, showRowMoney) {
  return (isAdmin && showRowMoney) ? ` · ${fmtMoneyShort(value)}` : '';
}
/**
 * Per-group inner formatter used by both Customer-wise and Warehouse-
 * wise supply reports. Returns the compact (top-3) block; full block
 * if `expandAll` is true.
 */
function _supplyDetailsGroupBlock(items, isAdmin, expandAll) {
  const byDS = new Map();
  for (const r of items) {
    const key = `${r.design}|${r.shade || '-'}`;
    if (!byDS.has(key)) byDS.set(key, { design: r.design, shade: r.shade || '-', pkgs: new Set(), thans: 0, yards: 0, value: 0 });
    const ds = byDS.get(key);
    ds.pkgs.add(r.packageNo); ds.thans++; ds.yards += r.yards; ds.value += r.yards * r.pricePerYard;
  }
  const dsSorted = [...byDS.values()].sort((a, b) => b.yards - a.yards);
  const limit = expandAll ? dsSorted.length : Math.min(3, dsSorted.length);
  const lines = [];
  for (let i = 0; i < limit; i++) {
    const ds = dsSorted[i];
    lines.push(`  ${ds.design} Shade ${ds.shade}: ${ds.pkgs.size} · ${ds.thans} thans · ${fmtQty(ds.yards)} yds${valStrShort(ds.value, isAdmin)}`);
  }
  const restCount = dsSorted.length - limit;
  return { lines, restCount, totalDesigns: dsSorted.length };
}

/**
 * Render a per-group block of design+shade rows. The Design value is
 * promoted ("pushed up") when consecutive rows share it: only the
 * first row spells the design out; subsequent rows on the same design
 * just show the shade. Compact top-N + "… and N more" + drill-down
 * stays as before. Money per-row is gated by `showRowMoney`.
 */
function _supplyGroupRender({ items, isAdmin, expandAll, showRowMoney }) {
  const byDS = new Map();
  for (const r of items) {
    const key = `${r.design}|${r.shade || '-'}`;
    if (!byDS.has(key)) byDS.set(key, { design: r.design, shade: r.shade || '-', pkgs: new Set(), thans: 0, yards: 0, value: 0 });
    const ds = byDS.get(key);
    ds.pkgs.add(r.packageNo); ds.thans++; ds.yards += r.yards; ds.value += r.yards * r.pricePerYard;
  }
  const dsSorted = [...byDS.values()].sort((a, b) => b.yards - a.yards);
  const limit = expandAll ? dsSorted.length : Math.min(3, dsSorted.length);
  const visible = dsSorted.slice(0, limit);
  const restCount = dsSorted.length - limit;
  let prevDesign = null;
  const lines = visible.map((ds) => {
    const sameAsPrev = ds.design === prevDesign;
    prevDesign = ds.design;
    const tail = valStrRow(ds.value, isAdmin, showRowMoney);
    if (sameAsPrev) {
      return `      Shade ${ds.shade}: ${ds.pkgs.size} Bales · ${ds.thans} thans · ${fmtQty(ds.yards)} yds${tail}`;
    }
    return `   ${ds.design} Shade ${ds.shade}: ${ds.pkgs.size} Bales · ${ds.thans} thans · ${fmtQty(ds.yards)} yds${tail}`;
  });
  return { block: lines.join('\n'), restCount, totalDesigns: dsSorted.length };
}

// Supply Details report builders live in services/supplyDetailsReport.
// Shared helpers (fmtQty, buildReportLegend, valStrShort, valStrRow,
// _supplyGroupRender) stay here as the single source of truth across
// Supply + Sales reports and are injected to avoid a circular require.
const { getSoldItems } = supplyDetailsReport;
const {
  buildDesignWiseReport,
  buildDesignDateWiseReport,
  buildCustomerWiseReport,
  buildWarehouseWiseReport,
} = supplyDetailsReport.createSupplyDetailsReport({
  fmtQty,
  buildReportLegend,
  valStrShort,
  valStrRow,
  supplyGroupRender: _supplyGroupRender,
});

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
 * Render one shade row in compact form. The legend at the top of the
 * report explains what the columns mean, so we omit per-row labels.
 *
 * Format: "  <head>: <bal>/<total> Bales · <yds> yds avail · sold-bar"
 * — but if nothing has been sold (sold yards == 0), we drop the bar
 * and the redundant "<total>" since avail == total.
 */
function _invShadeLineCompact(ds, head) {
  const balPkgs = ds.balPkgs.size;
  const totalPkgs = ds.totalPkgs.size;
  const noSales = (ds.soldYards || 0) === 0;
  if (noSales) {
    // Pre-sale: avail == total, so a single number is enough.
    return `  ${head}: ${balPkgs} · ${fmtQty(ds.balYards)} yds`;
  }
  const bar = fmtBar(ds.soldYards, ds.totalYards);
  return `  ${head}: ${balPkgs}/${totalPkgs} · ${fmtQty(ds.balYards)}/${fmtQty(ds.totalYards)} yds · ${bar}`;
}

function _invGroupSummary(rows) {
  let totalYards = 0, soldYards = 0, balYards = 0;
  const balPkgs = new Set(), totalPkgs = new Set();
  for (const ds of rows) {
    totalYards += ds.totalYards; soldYards += ds.soldYards; balYards += ds.balYards;
    for (const p of ds.balPkgs) balPkgs.add(p);
    for (const p of ds.totalPkgs) totalPkgs.add(p);
  }
  return { totalYards, soldYards, balYards, balPkgs, totalPkgs };
}

function _invSummaryLine(s) {
  const noSales = s.soldYards === 0;
  if (noSales) {
    return `${s.balPkgs.size} Bales · ${fmtQty(s.balYards)} yds`;
  }
  return `${s.balPkgs.size}/${s.totalPkgs.size} Bales · ${fmtQty(s.balYards)}/${fmtQty(s.totalYards)} yds · ${fmtBar(s.soldYards, s.totalYards)}`;
}

function buildInventoryWarehouseReport(allItems, opts = {}) {
  const expandKey = (opts.expand || '').trim().toLowerCase();
  const warehouses = new Map();
  for (const r of allItems) {
    const wh = r.warehouse || 'Unknown';
    if (!warehouses.has(wh)) warehouses.set(wh, []);
    warehouses.get(wh).push(r);
  }
  let text = `📦 *Inventory Details — Warehouse Wise*\n`;
  text += buildReportLegend(['Bales (avail/total)', 'yds (avail/total)', 'sold-%'], false);
  text += '\n';
  const buttons = [];
  let gTotalYards = 0, gSoldYards = 0, gBalYards = 0, gBalPkgs = new Set(), gTotalPkgs = new Set();
  for (const [wh, items] of [...warehouses.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const rows = aggregateShadeRows(items);
    const summary = _invGroupSummary(rows);
    text += `🏭 *${wh}* — ${_invSummaryLine(summary)}\n`;
    const expandThis = expandKey === wh.toLowerCase();
    const limit = expandThis ? rows.length : Math.min(3, rows.length);
    // Promote the Design value when consecutive shade rows share it.
    let prevDesign = null;
    for (let i = 0; i < limit; i++) {
      const ds = rows[i];
      const head = ds.design === prevDesign
        ? `      Shade ${ds.shade}`
        : `   ${ds.design} Shade ${ds.shade}`;
      text += _invShadeLineCompact(ds, head) + '\n';
      prevDesign = ds.design;
    }
    const restCount = rows.length - limit;
    if (restCount > 0) {
      text += `   _… and ${restCount} more shade${restCount > 1 ? 's' : ''}_\n`;
      buttons.push([{ text: `🔍 ${wh} — show all (${rows.length})`, callback_data: `rxw:inv_w:${wh.slice(0, 50)}` }]);
    }
    text += '\n';
    gTotalYards += summary.totalYards; gSoldYards += summary.soldYards; gBalYards += summary.balYards;
    for (const p of summary.balPkgs) gBalPkgs.add(p);
    for (const p of summary.totalPkgs) gTotalPkgs.add(p);
  }
  const grand = { totalYards: gTotalYards, soldYards: gSoldYards, balYards: gBalYards, balPkgs: gBalPkgs, totalPkgs: gTotalPkgs };
  text += `🧮 *Grand Total: ${_invSummaryLine(grand)}*`;
  return { text, keyboard: buttons.length ? { inline_keyboard: buttons } : null };
}

async function buildInventoryDesignReport(allItems, opts = {}) {
  const expandKey = (opts.expand || '').trim().toLowerCase();
  const userId = opts.userId || null;
  const canBase = userId ? pricingService.canSeeBasePrice(userId) : false;

  // PRICE-VIS-C1 — load finalized landed costs once and resolve per
  // design. Cheap (GRN sheet is small) and joined by grn_id back-pointer
  // already on each inventory row.
  let baseByDesign = new Map();
  if (canBase) {
    try {
      const grns = await goodsReceiptsRepository.getAll();
      baseByDesign = pricingService.resolveBasePriceByDesign(allItems, grns);
    } catch (e) {
      logger.warn(`buildInventoryDesignReport: GRN lookup failed, base prices will show pending: ${e.message}`);
    }
  }

  const designs = new Map();
  for (const r of allItems) {
    const key = r.design || 'Unknown';
    if (!designs.has(key)) designs.set(key, []);
    designs.get(key).push(r);
  }
  let text = `📦 *Inventory Details — Design Wise*\n`;
  text += buildReportLegend(['Bales (avail/total)', 'yds (avail/total)', 'sold-%'], false);
  text += '\n';
  const buttons = [];
  const sortedDesigns = [...designs.entries()].sort((a, b) => {
    const balA = a[1].filter((r) => r.status === 'available').reduce((s, r) => s + r.yards, 0);
    const balB = b[1].filter((r) => r.status === 'available').reduce((s, r) => s + r.yards, 0);
    return balB - balA;
  });
  let gTotalYards = 0, gSoldYards = 0, gBalYards = 0, gBalPkgs = new Set(), gTotalPkgs = new Set();
  for (const [design, items] of sortedDesigns) {
    const rows = aggregateShadeRows(items);
    const summary = _invGroupSummary(rows);
    // Design is the group header — already promoted, so per-row only
    // shows shades. Base price is appended ONLY for admins (Phase 1).
    let baseTail = '';
    if (canBase) {
      const bp = baseByDesign.get(String(design).toUpperCase());
      baseTail = bp
        ? ` · Base: ${fmtMoney(bp.lcNgn)}/yd`
        : ' · Base: pending';
    }
    text += `📦 *${design}* — ${_invSummaryLine(summary)}${baseTail}\n`;
    const expandThis = expandKey === design.toLowerCase();
    const limit = expandThis ? rows.length : Math.min(3, rows.length);
    for (let i = 0; i < limit; i++) {
      const ds = rows[i];
      text += _invShadeLineCompact(ds, `   Shade ${ds.shade}`) + '\n';
    }
    const restCount = rows.length - limit;
    if (restCount > 0) {
      text += `   _… and ${restCount} more shade${restCount > 1 ? 's' : ''}_\n`;
      buttons.push([{ text: `🔍 ${design} — show all (${rows.length})`, callback_data: `rxw:inv_d:${design.slice(0, 50)}` }]);
    }
    text += '\n';
    gTotalYards += summary.totalYards; gSoldYards += summary.soldYards; gBalYards += summary.balYards;
    for (const p of summary.balPkgs) gBalPkgs.add(p);
    for (const p of summary.totalPkgs) gTotalPkgs.add(p);
  }
  const grand = { totalYards: gTotalYards, soldYards: gSoldYards, balYards: gBalYards, balPkgs: gBalPkgs, totalPkgs: gTotalPkgs };
  text += `🧮 *Grand Total: ${_invSummaryLine(grand)}*`;
  return { text, keyboard: buttons.length ? { inline_keyboard: buttons } : null };
}

// ─── Sales Report (Interactive) ─────────────────────────────────────────────

function filterSoldByPeriod(sold, periodDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - periodDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  return sold.filter((r) => r.soldDate >= cutoffStr);
}

function buildSalesDesignReport(sold, periodLabel, opts = {}) {
  const expandAll = !!opts.expand;
  const byDS = new Map();
  for (const r of sold) {
    const key = `${r.design}|${r.shade || '-'}`;
    if (!byDS.has(key)) byDS.set(key, { design: r.design, shade: r.shade || '-', pkgs: new Set(), thans: 0, yards: 0, value: 0 });
    const ds = byDS.get(key);
    ds.pkgs.add(r.packageNo); ds.thans++; ds.yards += r.yards; ds.value += r.yards * r.pricePerYard;
  }
  const sorted = [...byDS.values()].sort((a, b) => b.value - a.value);
  let text = `📊 *Sales Report — ${periodLabel} — Design Wise*\n`;
  text += buildReportLegend(['Bales · thans · yds · value'], true);
  text += '\n';
  if (!sorted.length) {
    return { text: text + 'No sales in this period.', keyboard: null };
  }
  const limit = expandAll ? sorted.length : Math.min(3, sorted.length);
  let gPkgs = new Set(), gThans = 0, gYards = 0, gValue = 0;
  for (const ds of sorted) {
    for (const p of ds.pkgs) gPkgs.add(p);
    gThans += ds.thans; gYards += ds.yards; gValue += ds.value;
  }
  // Promote the Design value when consecutive ranked rows share it.
  let prevDesign = null;
  for (let i = 0; i < limit; i++) {
    const ds = sorted[i];
    if (ds.design === prevDesign) {
      text += `   ${i + 1}. Shade ${ds.shade} — ${ds.pkgs.size} Bales · ${ds.thans} thans · ${fmtQty(ds.yards)} yds · ${fmtMoneyShort(ds.value)}\n`;
    } else {
      text += `${i + 1}. *${ds.design}* Shade ${ds.shade} — ${ds.pkgs.size} Bales · ${ds.thans} thans · ${fmtQty(ds.yards)} yds · ${fmtMoneyShort(ds.value)}\n`;
    }
    prevDesign = ds.design;
  }
  const restCount = sorted.length - limit;
  const buttons = [];
  if (restCount > 0) {
    text += `\n_… and ${restCount} more design${restCount > 1 ? 's' : ''}_\n`;
    buttons.push([{ text: `🔍 Show all (${sorted.length})`, callback_data: `rxw:sales_d:${opts.periodKey || ''}` }]);
  }
  text += `\n🧮 *Grand Total: ${gPkgs.size} Bales · ${gThans} thans · ${fmtQty(gYards)} yds · ${fmtMoneyShort(gValue)}*`;
  return { text, keyboard: buttons.length ? { inline_keyboard: buttons } : null };
}

function buildSalesCustomerReport(sold, periodLabel, opts = {}) {
  const expandKey = (opts.expand || '').trim().toLowerCase();
  const customers = new Map();
  for (const r of sold) {
    const key = r.soldTo || 'Unknown';
    if (!customers.has(key)) customers.set(key, { items: [], pkgs: new Set(), thans: 0, yards: 0, value: 0 });
    const cg = customers.get(key);
    cg.items.push(r);
    cg.pkgs.add(r.packageNo); cg.thans++; cg.yards += r.yards; cg.value += r.yards * r.pricePerYard;
  }
  const sorted = [...customers.entries()].sort((a, b) => b[1].value - a[1].value);
  let text = `📊 *Sales Report — ${periodLabel} — Customer Wise*\n`;
  text += buildReportLegend(['Bales · thans · yds · value'], true);
  text += '\n';
  if (!sorted.length) {
    return { text: text + 'No sales in this period.', keyboard: null };
  }
  const buttons = [];
  let gPkgs = new Set(), gThans = 0, gYards = 0, gValue = 0;
  let rank = 0;
  for (const [customer, cg] of sorted) {
    rank++;
    text += `${rank}. 👤 *${customer}* — ${cg.pkgs.size} Bales · ${cg.thans} thans · ${fmtQty(cg.yards)} yds · ${fmtMoneyShort(cg.value)}\n`;
    const expandThis = expandKey === customer.toLowerCase();
    // Sales reports always show money per row — money IS the focus
    // here, unlike Supply reports where it's secondary context.
    const block = _supplyGroupRender({ items: cg.items, isAdmin: true, expandAll: expandThis, showRowMoney: true });
    if (block.block) text += block.block + '\n';
    if (block.restCount > 0) {
      text += `   _… and ${block.restCount} more design${block.restCount > 1 ? 's' : ''}_\n`;
      buttons.push([{ text: `🔍 ${customer} — show all (${block.totalDesigns})`, callback_data: `rxw:sales_c:${(opts.periodKey || '')}|${customer.slice(0, 40)}` }]);
    }
    text += '\n';
    for (const p of cg.pkgs) gPkgs.add(p);
    gThans += cg.thans; gYards += cg.yards; gValue += cg.value;
  }
  text += `🧮 *Grand Total: ${gPkgs.size} Bales · ${gThans} thans · ${fmtQty(gYards)} yds · ${fmtMoneyShort(gValue)}*`;
  return { text, keyboard: buttons.length ? { inline_keyboard: buttons } : null };
}

// ─── End Inventory & Sales Reports ──────────────────────────────────────────

// ─── Customer CRM Suite ─────────────────────────────────────────────────────

async function buildCustomerTimeline(customerName) {
  const allInv = await inventoryRepository.getAll();
  const sold = allInv.filter((r) => r.status === 'sold' && r.soldTo && r.soldTo.toLowerCase() === customerName.toLowerCase());
  const events = [];

  for (const r of sold) {
    events.push({ date: r.soldDate || r.updatedAt?.slice(0, 10) || '', type: 'Sale', detail: `${r.design} Shade ${r.shade || '-'} | Bale ${r.packageNo} | ${fmtQty(r.yards)} yds — ${fmtMoney(r.yards * r.pricePerYard)}` });
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

  // P3 — admin Quick Add: parse "Name, Phone, [Address]" in one shot and
  // write directly via crmService (no approval queue; admin executes).
  if (session.step === 'quick_add') {
    if (!config.access.adminIds.includes(userId)) {
      await bot.sendMessage(chatId, 'Quick Add is admin-only.');
      return true;
    }
    const parsed = parseQuickAddCustomerLine(trimmed);
    if (!parsed.ok) {
      await bot.sendMessage(chatId, `⚠️ ${parsed.error}\nTry again or tap Cancel.`);
      return true;
    }
    const cust = {
      name: parsed.name, phone: parsed.phone, address: parsed.address,
      category: 'Standard', credit_limit: 0, payment_terms: 'COD', notes: '',
    };
    try {
      await crmService.addCustomer(cust);
    } catch (e) {
      logger.error(`Quick add customer failed: ${e.message}`);
      await bot.sendMessage(chatId, `❌ Failed to save: ${e.message}`);
      return true;
    }
    sessionStore.clear(userId);
    const summary = `✅ *Customer added*\nName: *${cust.name}*${cust.phone ? '\nPhone: ' + cust.phone : ''}${cust.address ? '\nAddress: ' + cust.address : ''}\n_Defaults: category=Standard · credit=₦0 · terms=COD · status=active. Edit later from Customer Details._`;
    if (session.flowMessageId) {
      await bot.editMessageText(summary, {
        chat_id: chatId, message_id: session.flowMessageId, parse_mode: 'Markdown',
      }).catch(() => bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' }));
    } else {
      await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
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
        // APU-1 3.1: was 'new_customer_registration' — a dead action name
        // with no executor; 'new_customer' is what the approve/reject
        // special-cases and the flow-resume hooks actually match.
        action: 'new_customer',
        customer_id: customerId, customer_name: name, phone,
        requesterUserId: userId, from: 'sample_flow',
      },
      riskReason: 'New customer requires admin approval',
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
      `⏳ Customer "*${name}*" sent for admin approval.\n\nYour sample request is *paused* — it will resume automatically once an admin approves the new customer.`,
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

async function sendCustomerHistoryReport(bot, chatId, customerName, opts = {}) {
  const expandAll = !!opts.expand;
  const events = await buildCustomerTimeline(customerName);
  if (!events.length) {
    const emptyText = `No interaction history found for "${customerName}".`;
    const emptyKb = (opts.extraButtons && opts.extraButtons.length)
      ? { reply_markup: { inline_keyboard: opts.extraButtons } } : {};
    if (opts.editMessageId) {
      await editOrSend(bot, chatId, opts.editMessageId, emptyText, emptyKb);
    } else {
      await bot.sendMessage(chatId, emptyText, emptyKb);
    }
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
  out += `💰 Lifetime: ${totalPkgs} Bales, ${fmtQty(totalYards)} yds`;
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
    const pkgTxt = `${g.pkgs.size} Bale${g.pkgs.size > 1 ? 's' : ''}`;
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
  // Compact default: 10 most-recent interactions; expand button reveals
  // up to 30 (the previous default). True expand-all bypasses both.
  const MAX_ITEMS = expandAll ? Infinity : 10;
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
  const hidden = totalItems - shown;
  if (hidden > 0) out += `_…and ${hidden} earlier interaction${hidden > 1 ? 's' : ''}_\n`;
  out += `*${totalItems} total interaction${totalItems > 1 ? 's' : ''}*`;

  const baseRows = (hidden > 0)
    ? [[{ text: `🔍 Show all ${totalItems}`, callback_data: `rxw:hist:${customerName.slice(0, 50)}` }]]
    : [];
  const allRows = [...baseRows, ...(opts.extraButtons || [])];
  const sendOpts = { parse_mode: 'Markdown' };
  if (allRows.length) sendOpts.reply_markup = { inline_keyboard: allRows };

  if (opts.editMessageId) {
    await editOrSend(bot, chatId, opts.editMessageId, out, sendOpts);
  } else {
    await sendLong(bot, chatId, out, sendOpts);
  }
}

async function sendCustomerPatternReport(bot, chatId, customerName, opts = {}) {
  const expandAll = !!opts.expand;
  const pattern = await buildCustomerPattern(customerName);
  if (!pattern) {
    const emptyText = `No purchase data found for "${customerName}".`;
    const emptyKb = (opts.extraButtons && opts.extraButtons.length)
      ? { reply_markup: { inline_keyboard: opts.extraButtons } } : {};
    if (opts.editMessageId) {
      await editOrSend(bot, chatId, opts.editMessageId, emptyText, emptyKb);
    } else {
      await bot.sendMessage(chatId, emptyText, emptyKb);
    }
    return;
  }
  const hasPrices = pattern.totalValue > 0;
  const rankBasis = hasPrices ? pattern.totalValue : pattern.totalYards;
  const sortedItems = hasPrices
    ? pattern.items
    : [...pattern.items].sort((a, b) => b.yards - a.yards);

  let out = `🔍 *Purchase Pattern — ${customerName}*\n`;
  out += buildReportLegend(['Bales · yds · share-of-total'], hasPrices);
  out += '\n';
  out += `📅 ${fmtDate(pattern.firstDate) || pattern.firstDate} → ${fmtDate(pattern.lastDate) || pattern.lastDate}\n`;
  out += `📊 Lifetime: ${pattern.totalPkgs} · ${pattern.totalThans} thans · ${fmtQty(pattern.totalYards)} yds`;
  out += hasPrices ? ` · ${fmtMoneyShort(pattern.totalValue)}\n\n` : `\n_(no price data)_\n\n`;
  out += hasPrices ? `*Preferred items (by value):*\n` : `*Preferred items (by volume):*\n`;

  // Compact view: top 5 designs + roll up remainder into "Other (N)"
  const TOP = 5;
  const limit = expandAll ? sortedItems.length : Math.min(TOP, sortedItems.length);
  for (let i = 0; i < limit; i++) {
    const ds = sortedItems[i];
    const thisMetric = hasPrices ? ds.value : ds.yards;
    const pct = rankBasis > 0 ? Math.round((thisMetric / rankBasis) * 100) : 0;
    const valueStr = hasPrices ? ` · ${fmtMoneyShort(ds.value)}` : '';
    out += `${i + 1}. ${ds.design} Shade ${ds.shade}: ${ds.pkgs.size} · ${fmtQty(ds.yards)} yds${valueStr} (${pct}%)\n`;
  }
  const restItems = sortedItems.slice(limit);
  const buttons = [];
  if (restItems.length > 0) {
    // Roll up the rest into a single "Other" line so users still see
    // the remainder's aggregate weight.
    const restAgg = { pkgs: new Set(), yards: 0, value: 0 };
    for (const ds of restItems) {
      for (const p of ds.pkgs) restAgg.pkgs.add(p);
      restAgg.yards += ds.yards;
      restAgg.value += ds.value;
    }
    const otherMetric = hasPrices ? restAgg.value : restAgg.yards;
    const otherPct = rankBasis > 0 ? Math.round((otherMetric / rankBasis) * 100) : 0;
    const valueStr = hasPrices ? ` · ${fmtMoneyShort(restAgg.value)}` : '';
    out += `…  Other (${restItems.length} more): ${restAgg.pkgs.size} · ${fmtQty(restAgg.yards)} yds${valueStr} (${otherPct}%)\n`;
    buttons.push([{ text: `🔍 Show all ${sortedItems.length}`, callback_data: `rxw:pat:${customerName.slice(0, 50)}` }]);
  }

  const top = sortedItems[0];
  if (top) {
    const topMetric = hasPrices ? top.value : top.yards;
    const topPct = rankBasis > 0 ? Math.round((topMetric / rankBasis) * 100) : 0;
    out += `\n*Top: ${top.design} Shade ${top.shade} (${topPct}% of ${hasPrices ? 'value' : 'volume'})*`;
  }
  const allRows = [...buttons, ...(opts.extraButtons || [])];
  const sendOpts = { parse_mode: 'Markdown' };
  if (allRows.length) sendOpts.reply_markup = { inline_keyboard: allRows };
  if (opts.editMessageId) {
    await editOrSend(bot, chatId, opts.editMessageId, out, sendOpts);
  } else {
    await sendLong(bot, chatId, out, sendOpts);
  }
}

async function sendCustomerNotesReport(bot, chatId, customerName, opts = {}) {
  const expandAll = !!opts.expand;
  const notes = await customerNotesRepo.getByCustomer(customerName);
  if (!notes.length) {
    const emptyText = `No notes found for "${customerName}". Add with: "Note for ${customerName}: your note here"`;
    const emptyKb = (opts.extraButtons && opts.extraButtons.length)
      ? { reply_markup: { inline_keyboard: opts.extraButtons } } : {};
    if (opts.editMessageId) {
      await editOrSend(bot, chatId, opts.editMessageId, emptyText, emptyKb);
    } else {
      await bot.sendMessage(chatId, emptyText, emptyKb);
    }
    return;
  }
  // Compact default: latest 5; expand-all reveals all (was 15).
  const LIMIT = expandAll ? notes.length : 5;
  let out = `📝 *Notes for ${customerName}* (${notes.length})\n\n`;
  const visible = notes.slice(-LIMIT).reverse(); // newest first
  for (const n of visible) {
    out += `• ${fmtDate(n.created_at) || '-'}: ${n.note}\n`;
  }
  const hidden = notes.length - visible.length;
  const buttons = [];
  if (hidden > 0) {
    out += `\n_…and ${hidden} earlier note${hidden > 1 ? 's' : ''}_`;
    buttons.push([{ text: `🔍 Show all ${notes.length}`, callback_data: `rxw:notes:${customerName.slice(0, 50)}` }]);
  }
  const allRows = [...buttons, ...(opts.extraButtons || [])];
  const sendOpts = { parse_mode: 'Markdown' };
  if (allRows.length) sendOpts.reply_markup = { inline_keyboard: allRows };
  if (opts.editMessageId) {
    await editOrSend(bot, chatId, opts.editMessageId, out, sendOpts);
  } else {
    await sendLong(bot, chatId, out, sendOpts);
  }
}

async function sendCustomerRankingReport(bot, chatId, opts = {}) {
  const page = Number.isFinite(opts.page) ? opts.page : 0; // 0 = top 10, 1 = 11-20, …
  const PAGE_SIZE = 10;
  const ranked = await buildCustomerRanking();
  if (!ranked.length) {
    const emptyText = 'No sales data found.';
    const emptyKb = (opts.extraButtons && opts.extraButtons.length)
      ? { reply_markup: { inline_keyboard: opts.extraButtons } } : {};
    if (opts.editMessageId) {
      await editOrSend(bot, chatId, opts.editMessageId, emptyText, emptyKb);
    } else {
      await bot.sendMessage(chatId, emptyText, emptyKb);
    }
    return;
  }
  const topValue = ranked[0][1].value;
  const start = page * PAGE_SIZE;
  const slice = ranked.slice(start, start + PAGE_SIZE);
  if (!slice.length) {
    await bot.sendMessage(chatId, `No customers on page ${page + 1}.`);
    return;
  }
  let out = page === 0
    ? `🏆 *Customer Ranking — Top ${PAGE_SIZE} by Value*\n`
    : `🏆 *Customer Ranking — #${start + 1}-${start + slice.length} by Value*\n`;
  out += `_Bar = % of #1 buyer (${fmtMoneyShort(topValue)})_\n\n`;
  const medals = ['🥇', '🥈', '🥉'];
  let rank = start;
  for (const [name, c] of slice) {
    const medal = rank < 3 ? medals[rank] : `${rank + 1}.`;
    const lastMs = c.lastDate ? new Date(c.lastDate).getTime() : NaN;
    const daysAgo = Number.isFinite(lastMs)
      ? `${Math.floor((Date.now() - lastMs) / 86400000)}d ago`
      : (c.lastDate ? fmtDate(c.lastDate) : '—');
    out += `${medal} *${name}* — ${c.pkgs.size} · ${c.thans} thans · ${fmtQty(c.yards)} yds · ${fmtMoneyShort(c.value)} · ${daysAgo}\n`;
    out += `   ${fmtBar(c.value, topValue, 'of #1')}\n\n`;
    rank++;
  }
  const grandValue = ranked.reduce((s, [, c]) => s + c.value, 0);
  out += `*Total: ${ranked.length} customers · ${fmtMoneyShort(grandValue)}*`;

  const buttons = [];
  const navRow = [];
  // When called from inside the unified customer-details card we route
  // pagination back through the cd: prefix so the message keeps editing
  // in place; the legacy rxw: path stays the default.
  const pageCb = opts.pageCallbackPrefix || 'rxw:rank';
  if (page > 0) navRow.push({ text: '⬅️ Prev', callback_data: `${pageCb}:${page - 1}` });
  if (start + slice.length < ranked.length) navRow.push({ text: 'Next ➡️', callback_data: `${pageCb}:${page + 1}` });
  if (navRow.length) buttons.push(navRow);
  if (opts.extraButtons && opts.extraButtons.length) {
    buttons.push(...opts.extraButtons);
  } else {
    buttons.push(menuNav.backToMenuRow());
  }
  const sendOpts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } };
  if (opts.editMessageId) {
    await editOrSend(bot, chatId, opts.editMessageId, out, sendOpts);
  } else {
    await sendLong(bot, chatId, out, sendOpts);
  }
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
  // Group: shade → Set of distinct *available* packageNo. Available rows
  // are "currently in stock and not sold/scrapped"; this matches what the
  // sales side sees for the same shade.
  const shadeBales = new Map();
  for (const r of allInv) {
    if (r.design !== design) continue;
    if (r.status !== 'available') continue;
    const k = r.shade || '-';
    if (!shadeBales.has(k)) shadeBales.set(k, new Set());
    shadeBales.get(k).add(r.packageNo);
  }
  const shades = [...shadeBales.keys()].sort();
  if (!shades.length) {
    await bot.sendMessage(chatId, `No shades found for design ${design}.`);
    sessionStore.clear(userId);
    return;
  }

  // Catalog name lookup so we can render "<#> - <name> (<qty> bales)".
  let nameMap;
  try {
    const asset = await designAssetsRepo.findActive(design);
    nameMap = buildShadeNameMap(asset);
  } catch (_) {
    nameMap = new Map();
  }

  // Sample flow doesn't carry a productType yet — fabric defaults to "bale/bales".
  const buttons = shades.map((s) => ({
    text: buildShadeLabel(s, nameMap, shadeBales.get(s).size),
    callback_data: `smsh:${s.slice(0, 55)}`,
  }));
  const rows = layoutShadeRows(buttons);
  rows.push([
    { text: '⬅️ Back', callback_data: 'smb:design' },
    { text: '❌ Cancel', callback_data: 'smcanc:0' },
  ]);
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
  rows.push([
    { text: '⬅️ Back', callback_data: 'smb:shade' },
    { text: '❌ Cancel', callback_data: 'smcanc:0' },
  ]);

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
    [
      { text: '⬅️ Back', callback_data: 'smb:customer' },
      { text: '❌ Cancel', callback_data: 'smcanc:0' },
    ],
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
    [
      { text: '⬅️ Back', callback_data: 'smb:quantity' },
      { text: '❌ Cancel', callback_data: 'smcanc:0' },
    ],
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
    [
      { text: '⬅️ Back', callback_data: 'smb:type' },
      { text: '❌ Cancel', callback_data: 'smcanc:0' },
    ],
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
    [{ text: '⬅️ Back', callback_data: 'smb:followup' }],
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
  // P3 — admins see a ⚡ Quick Add fast path that compresses the 8-step
  // pickers into one line ("Name, +234..."). Non-admins keep the existing
  // gated full flow (still routes through admin approval).
  const rows = [];
  if (config.access.adminIds.includes(userId)) {
    rows.push([{ text: '⚡ Quick Add (name+phone in one line)', callback_data: 'acquick:1' }]);
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'accanc:0' }]);
  await _acRender(bot, chatId, userId, 'Enter the customer *full name* (reply in chat), or tap Quick Add for a one-liner:', rows);
}

/**
 * P3 — admin Quick Add path. Switches the active add_customer session into
 * 'quick_add' mode and prompts for "Name, Phone, [Address]" in one line.
 * Direct write (no approval queue) because the path is admin-only.
 */
async function startAddCustomerQuickAdd(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'add_customer_flow') return;
  if (!config.access.adminIds.includes(userId)) return;
  session.step = 'quick_add';
  sessionStore.set(userId, session);
  await _acRender(bot, chatId, userId,
    'Type *Name, Phone* (comma-separated) in one line:\n_Examples:_\n  `Mariam Salisu, +234-803-555-7777`\n  `Ibrahim Yusuf` _(phone optional)_\n  `Wang Tex, +234-1-555-1234, Lagos` _(name, phone, address)_',
    [[{ text: '⬅️ Back to full form', callback_data: 'acb:name' }], [{ text: '❌ Cancel', callback_data: 'accanc:0' }]],
  );
}

const { parseQuickAddCustomerLine } = require('../utils/quickAddParser');

async function showAddCustomerPhoneStep(bot, chatId, userId) {
  const rows = [
    [{ text: '⏭ Skip phone', callback_data: 'acskip:phone' }],
    [
      { text: '⬅️ Back', callback_data: 'acb:name' },
      { text: '❌ Cancel', callback_data: 'accanc:0' },
    ],
  ];
  await _acRender(bot, chatId, userId, 'Enter *phone number* (or tap Skip):', rows);
}

async function showAddCustomerAddressStep(bot, chatId, userId) {
  const rows = [
    [{ text: '⏭ Skip address', callback_data: 'acskip:address' }],
    [
      { text: '⬅️ Back', callback_data: 'acb:phone' },
      { text: '❌ Cancel', callback_data: 'accanc:0' },
    ],
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
  rows.push([
    { text: '⬅️ Back', callback_data: 'acb:address' },
    { text: '❌ Cancel', callback_data: 'accanc:0' },
  ]);
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
  rows.push([
    { text: '⬅️ Back', callback_data: 'acb:category' },
    { text: '❌ Cancel', callback_data: 'accanc:0' },
  ]);
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
    [
      { text: '⬅️ Back', callback_data: 'acb:credit' },
      { text: '❌ Cancel', callback_data: 'accanc:0' },
    ],
  ];
  await _acRender(bot, chatId, userId, 'Pick *payment terms*:', rows);
}

async function showAddCustomerNotesStep(bot, chatId, userId) {
  const rows = [
    [{ text: '⏭ Skip notes', callback_data: 'acskip:notes' }],
    [
      { text: '⬅️ Back', callback_data: 'acb:terms' },
      { text: '❌ Cancel', callback_data: 'accanc:0' },
    ],
  ];
  await _acRender(bot, chatId, userId, 'Add any *notes* (or tap Skip):', rows);
}

async function showAddCustomerConfirmation(bot, chatId, userId) {
  const rows = [
    [
      { text: '✅ Submit for Approval', callback_data: 'acconf:1' },
      { text: '❌ Cancel', callback_data: 'accanc:0' },
    ],
    [{ text: '⬅️ Back', callback_data: 'acb:notes' }],
  ];
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
  // Group: shade → Set of distinct *available* packageNo for this design.
  const designUC = String(session.design).toUpperCase();
  const shadeBales = new Map();
  for (const r of all) {
    if (String(r.design || '').trim().toUpperCase() !== designUC) continue;
    const k = String(r.shade || '').trim();
    if (!k) continue;
    if (!shadeBales.has(k)) shadeBales.set(k, new Set());
    if (r.status === 'available') shadeBales.get(k).add(r.packageNo);
  }
  const shades = [...shadeBales.keys()].sort();

  // Catalog name lookup for "<#> - <name>" display.
  let nameMap;
  try {
    const asset = await designAssetsRepo.findActive(session.design);
    nameMap = buildShadeNameMap(asset);
  } catch (_) {
    nameMap = new Map();
  }

  const shadeButtons = shades.map((s) => ({
    text: buildShadeLabel(s, nameMap, shadeBales.get(s).size),
    callback_data: `ups:${s.slice(0, 50)}`,
  }));

  const rows = [[{ text: '🎨 All shades', callback_data: 'ups:__all__' }]];
  for (const r of layoutShadeRows(shadeButtons)) rows.push(r);
  if (rows.length > 15) rows.splice(15);
  rows.push([
    { text: '⬅️ Back', callback_data: 'upb:design' },
    { text: '❌ Cancel', callback_data: 'upcanc:0' },
  ]);

  // PRICE-VIS-C1 — non-blocking sample-photo warning. Flag was set on the
  // `upd:` callback when maybeSendDesignPreview reported no active asset.
  const warnLine = session.sampleOnFile === false
    ? `\n⚠️ *No sample photo on file for ${session.design}* — upload via Design Photos so you can visually distinguish batches. You can still proceed.\n`
    : '';
  const text = `💲 *Update Price*\n\n✓ Design: *${session.design}*${warnLine}\n\nSelect shade:`;
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
    [
      { text: '⬅️ Back', callback_data: 'upb:shade' },
      { text: '❌ Cancel', callback_data: 'upcanc:0' },
    ],
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

  // PRICE-VIS-C1 — context lines so the admin knows exactly which batch
  // they're pricing. Sample status reflects whether DesignAssets has an
  // active card; latest stock month/year is the most recent dateReceived
  // among matching inventory rows.
  const sampleLine = session.sampleOnFile === false
    ? '📷 Sample: ⚠️ no photo on file'
    : '📷 Sample: ✓ on file';

  let stockLine = '';
  try {
    const all = await inventoryRepository.getAll();
    const designUC = String(session.design).toUpperCase();
    const matchDates = all
      .filter((r) => String(r.design || '').trim().toUpperCase() === designUC)
      .filter((r) => session.shade === '__all__'
        || String(r.shade || '').trim().toUpperCase() === String(session.shade).toUpperCase())
      .map((r) => String(r.dateReceived || '').trim())
      .filter(Boolean);
    if (matchDates.length) {
      matchDates.sort();
      const latest = matchDates[matchDates.length - 1];
      // Expect YYYY-MM-DD; otherwise display as-is.
      const m = /^(\d{4})-(\d{2})/.exec(latest);
      if (m) {
        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        stockLine = `📅 Stock received: *${MONTHS[parseInt(m[2], 10) - 1] || m[2]} ${m[1]}*\n`;
      } else {
        stockLine = `📅 Stock received: *${latest}*\n`;
      }
    } else {
      stockLine = `📅 Stock received: *(no dates on file)*\n`;
    }
  } catch (_) { /* non-fatal: confirm without the date line */ }

  const text = `💲 *Confirm Price Update*\n\nDesign: *${session.design}*\nShade: *${shadeLabel}*\n` +
               `${sampleLine}\n${stockLine}` +
               `Before: *${session.currentPrice ? fmtMoney(session.currentPrice) : '—'}/yard*\n` +
               `After:  *${fmtMoney(session.newPrice)}/yard*\n\n_Will be queued for 2-admin approval._`;
  await editOrSend(bot, chatId, session.flowMessageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [
        { text: '✅ Submit for Approval', callback_data: 'upconf:1' },
        { text: '❌ Cancel', callback_data: 'upcanc:0' },
      ],
      [{ text: '⬅️ Back', callback_data: 'upb:nudge' }],
    ] },
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
    await editOrSend(bot, chatId, messageId, 'No Bales with available thans to transfer.', {});
    return;
  }
  sessionStore.set(userId, { type: 'transfer_package_flow', step: 'package', flowMessageId: messageId || null });
  const rows = [];
  pkgs.slice(0, 30).forEach((p) => {
    rows.push([{ text: `📦 ${p.pkg} · ${p.design}${p.shade ? ' ' + p.shade : ''} (${p.count}) · ${p.warehouse}`, callback_data: `tpp:${p.pkg.slice(0, 50)}` }]);
  });
  rows.push([{ text: '❌ Cancel', callback_data: 'tpcanc:0' }]);
  await editOrSend(bot, chatId, messageId,
    '🚚 *Transfer Bale*\n\nSelect the Bale to transfer:',
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
  rows.push([
    { text: '⬅️ Back', callback_data: 'tpb:package' },
    { text: '❌ Cancel', callback_data: 'tpcanc:0' },
  ]);
  const text = `🚚 *Transfer Bale*\n\n✓ Bale: *${session.packageNo}*\n` +
               `Design: ${session.design}${session.shade ? ' ' + session.shade : ''}\n` +
               `Thans: ${session.availableThans} · Yards: ${fmtQty(session.availableYards)}\n` +
               `From: *${session.fromWh}*\n\nSelect destination warehouse:`;
  await editOrSend(bot, chatId, session.flowMessageId, text,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function showTransferPackageConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const text = `🚚 *Confirm Transfer Bale*\n\nBale: *${session.packageNo}*\n` +
               `Design: ${session.design}${session.shade ? ' ' + session.shade : ''}\n` +
               `Thans: ${session.availableThans} · Yards: ${fmtQty(session.availableYards)}\n` +
               `From: *${session.fromWh}*  →  To: *${session.toWh}*\n\n_Queues 2-admin approval._`;
  await editOrSend(bot, chatId, session.flowMessageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [
        { text: '✅ Submit for Approval', callback_data: 'tpconf:1' },
        { text: '❌ Cancel', callback_data: 'tpcanc:0' },
      ],
      [{ text: '⬅️ Back', callback_data: 'tpb:warehouse' }],
    ] },
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
    await editOrSend(bot, chatId, messageId, 'No Bales with available thans to transfer.', {});
    return;
  }
  sessionStore.set(userId, { type: 'transfer_than_flow', step: 'package', flowMessageId: messageId || null });
  const rows = [];
  pkgs.slice(0, 30).forEach((p) => {
    rows.push([{ text: `📦 ${p.pkg} · ${p.design}${p.shade ? ' ' + p.shade : ''} (${p.count}) · ${p.warehouse}`, callback_data: `ttp:${p.pkg.slice(0, 50)}` }]);
  });
  rows.push([{ text: '❌ Cancel', callback_data: 'ttcanc:0' }]);
  await editOrSend(bot, chatId, messageId,
    '↔️ *Transfer Than*\n\nSelect the Bale:',
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
    await editOrSend(bot, chatId, session.flowMessageId, 'No available thans in this Bale.', {});
    return;
  }
  const rows = [];
  for (let i = 0; i < availableThans.length; i += 3) {
    rows.push(availableThans.slice(i, i + 3).map((t) => ({
      text: `#${t.thanNo} · ${fmtQty(t.yards)}y`, callback_data: `tth:${t.thanNo}`,
    })));
  }
  rows.push([
    { text: '⬅️ Back', callback_data: 'ttb:package' },
    { text: '❌ Cancel', callback_data: 'ttcanc:0' },
  ]);
  const text = `↔️ *Transfer Than*\n\n✓ Bale: *${session.packageNo}* (${session.design}${session.shade ? ' ' + session.shade : ''})\nFrom: *${session.fromWh}*\n\nSelect the than to transfer:`;
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
  rows.push([
    { text: '⬅️ Back', callback_data: 'ttb:than' },
    { text: '❌ Cancel', callback_data: 'ttcanc:0' },
  ]);
  const text = `↔️ *Transfer Than*\n\n✓ Bale: *${session.packageNo}*\n✓ Than: *#${session.thanNo}*\nFrom: *${session.fromWh}*\n\nSelect destination warehouse:`;
  await editOrSend(bot, chatId, session.flowMessageId, text,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function showTransferThanConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const text = `↔️ *Confirm Transfer Than*\n\nBale: *${session.packageNo}*\nThan: *#${session.thanNo}*\nDesign: ${session.design}${session.shade ? ' ' + session.shade : ''}\nFrom: *${session.fromWh}*  →  To: *${session.toWh}*\n\n_Queues 2-admin approval._`;
  await editOrSend(bot, chatId, session.flowMessageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [
        { text: '✅ Submit for Approval', callback_data: 'ttconf:1' },
        { text: '❌ Cancel', callback_data: 'ttcanc:0' },
      ],
      [{ text: '⬅️ Back', callback_data: 'ttb:warehouse' }],
    ] },
  });
}

/* ─── Return Than tap flow ──────────────────────────────────────────────
 * List packages that have at least one SOLD than; pick Bale → pick sold
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
    '↩️ *Return Than*\n\nSelect the Bale containing the than to return:',
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
    await editOrSend(bot, chatId, session.flowMessageId, 'No sold thans in this Bale.', {});
    return;
  }
  const rows = [];
  for (let i = 0; i < soldThans.length; i += 2) {
    const mk = (t) => ({ text: `#${t.thanNo} · ${fmtQty(t.yards)}y · ${t.soldTo || '—'}`, callback_data: `rth:${t.thanNo}` });
    const row = [mk(soldThans[i])];
    if (soldThans[i + 1]) row.push(mk(soldThans[i + 1]));
    rows.push(row);
  }
  rows.push([
    { text: '⬅️ Back', callback_data: 'rtb:package' },
    { text: '❌ Cancel', callback_data: 'rtcanc:0' },
  ]);
  const text = `↩️ *Return Than*\n\n✓ Bale: *${session.packageNo}* (${session.design}${session.shade ? ' ' + session.shade : ''})\n\nSelect the sold than to return:`;
  await editOrSend(bot, chatId, session.flowMessageId, text,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function showReturnThanConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const text = `↩️ *Confirm Return Than*\n\nBale: *${session.packageNo}*\nThan: *#${session.thanNo}*\nDesign: ${session.design}${session.shade ? ' ' + session.shade : ''}\n\n_Will mark the than available again. Queues 2-admin approval._`;
  await editOrSend(bot, chatId, session.flowMessageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [
        { text: '✅ Submit for Approval', callback_data: 'rtconf:1' },
        { text: '❌ Cancel', callback_data: 'rtcanc:0' },
      ],
      [{ text: '⬅️ Back', callback_data: 'rtb:than' }],
    ] },
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
      [{ text: '⬅ Back to menu', callback_data: 'act:__back__' }],
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

/* ─── Unified Customer Details card (M3 consolidation) ────────────────────
 * One menu entry, one customer pick, then a card that swaps tabs in place
 * (History / Pattern / Notes / Add Note) — plus a global Ranking jump for
 * admins. Replaces four separate hub entries that each forced a fresh
 * pick-customer round trip.
 *
 * Callback shape (cd: prefix, 64-byte budget):
 *   cd:pk             → re-show picker (top-8)
 *   cd:pk:all         → re-show picker (full list)
 *   cd:rk             → admin: global ranking, page 0
 *   cd:rk:<page>      → admin: ranking pagination
 *   cd:c:<name>       → open card for customer; default tab = history
 *   cd:t:h:<name>     → switch to History tab
 *   cd:t:p:<name>     → switch to Pattern tab
 *   cd:t:n:<name>     → switch to Notes tab
 *   cd:t:a:<name>     → "Add Note" tab → routes to existing add_note_flow
 */

/** Inline-keyboard row(s) shown under every section of the customer card. */
function _cdTabFooter(customerName) {
  const safe = customerName.slice(0, 50);
  return [
    [
      { text: '📋 History',  callback_data: `cd:t:h:${safe}` },
      { text: '🔍 Pattern',  callback_data: `cd:t:p:${safe}` },
    ],
    [
      { text: '📝 Notes',    callback_data: `cd:t:n:${safe}` },
      { text: '✏️ Add Note', callback_data: `cd:t:a:${safe}` },
    ],
    [
      { text: '👤 Pick another', callback_data: 'cd:pk' },
      { text: '⬅ Back to menu',  callback_data: 'act:__back__' },
    ],
  ];
}

async function showCustomerDetailsPicker(bot, chatId, userId, messageId = null, showAll = false) {
  const allCust = await customersRepo.getAll();
  const active = allCust
    .filter((c) => (c.status || 'Active').toLowerCase() === 'active' && c.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!active.length) {
    const msg = 'No active customers found.';
    if (messageId) {
      await editOrSend(bot, chatId, messageId, msg, {});
    } else {
      await bot.sendMessage(chatId, msg);
    }
    return;
  }

  const MAX_VISIBLE = 8;
  const visible = showAll ? active : active.slice(0, MAX_VISIBLE);
  const rows = [];

  // Admin-only shortcut to the global ranking, surfaced as the first row
  // so the most senior insight is one tap away.
  if (config.access.adminIds.includes(userId)) {
    rows.push([{ text: '🏆 Customer Ranking (global)', callback_data: 'cd:rk' }]);
  }

  for (let i = 0; i < visible.length; i += 2) {
    const row = [{ text: `👤 ${visible[i].name}`, callback_data: `cd:c:${visible[i].name.slice(0, 60)}` }];
    if (visible[i + 1]) {
      row.push({ text: `👤 ${visible[i + 1].name}`, callback_data: `cd:c:${visible[i + 1].name.slice(0, 60)}` });
    }
    rows.push(row);
  }
  if (!showAll && active.length > MAX_VISIBLE) {
    rows.push([{ text: `📋 See All (${active.length})`, callback_data: 'cd:pk:all' }]);
  }
  rows.push([{ text: '⬅ Back to menu', callback_data: 'act:__back__' }]);

  const text = '👤 *Customer Details*\n\nPick a customer to see history, pattern, notes, or add a note — all from the same card.';
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  if (messageId) {
    await editOrSend(bot, chatId, messageId, text, opts);
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

/**
 * Render one tab of the customer-details card by editing the same message
 * in place. Delegates to the existing send*Report functions, which already
 * understand `editMessageId` + `extraButtons` (the per-tab footer).
 */
async function renderCustomerCard(bot, chatId, messageId, customerName, tab = 'h') {
  const footer = _cdTabFooter(customerName);
  const baseOpts = { editMessageId: messageId, extraButtons: footer };
  if (tab === 'p') {
    await sendCustomerPatternReport(bot, chatId, customerName, baseOpts);
  } else if (tab === 'n') {
    await sendCustomerNotesReport(bot, chatId, customerName, baseOpts);
  } else {
    // 'h' (history) is the default tab.
    await sendCustomerHistoryReport(bot, chatId, customerName, baseOpts);
  }
}

/* ─── Design Picker for Report Buttons ────────────────────────────────────
 * Shared picker used by button-triggered reports that need a design pick
 * (list_packages, check_stock). Emits callback_data `<prefix>:<design>` and
 * `<prefix>:__more__` to expand the full list. In-place edits supported.
 */
const DESIGN_PICKER_PROMPTS = {
  lpk: { icon: '📋', label: 'List Bales', prompt: 'Pick a design to see its Bales:' },
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

  // Decorate designs that have an active photo with a 🖼 view button.
  let activeDesigns = new Set();
  try {
    const active = await designAssetsRepo.list('active');
    activeDesigns = new Set(active.map((a) => String(a.design).toUpperCase()));
  } catch (_) { /* graceful */ }

  // DCAT-1: append the category label to each chip ("80045 · Senator").
  let pickerCats = new Map();
  try { pickerCats = await designCategoriesRepo.getMap(); } catch (_) { /* bare chips */ }

  const rows = [];
  for (let i = 0; i < visible.length; i += 3) {
    const row = [];
    for (let j = i; j < i + 3 && j < visible.length; j++) {
      const d = visible[j];
      const hasPhoto = activeDesigns.has(d.toUpperCase());
      const cat = pickerCats.get(designCategoriesRepo.normalizeDesign(d)) || '';
      const chip = cat ? `${d} · ${cat}` : d;
      row.push({ text: hasPhoto ? `🖼 ${chip}` : chip, callback_data: `${prefix}:${d.slice(0, 55)}` });
    }
    rows.push(row);
  }
  if (!showAll && designs.length > MAX_VISIBLE) {
    rows.push([{ text: `📋 See All (${designs.length})`, callback_data: `${prefix}:__more__` }]);
  }
  // Navigation footer — return to the Inventory hub or the greeting menu.
  rows.push(menuNav.hubAndMenuFooterRow('inventory', 'Inventory'));

  const text = `${meta.icon} *${meta.label}*\n\n${meta.prompt}${activeDesigns.size ? '\n\n_🖼 = product photo on file. Tap to use; tap and hold to copy the design number._' : ''}`;
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
  // Footer: back to the design list (re-opens the picker) or out to the menu.
  const navFooter = { inline_keyboard: [[
    { text: '⬅ Back to designs', callback_data: 'lpk:__designs__' },
    { text: '🏠 Menu', callback_data: 'act:__back__' },
  ]] };
  const packages = await inventoryService.listPackages(design, shade);
  if (!packages.length) {
    await bot.sendMessage(chatId, `No Bales found for design ${design}${shade ? ' ' + shade : ''}.`,
      { reply_markup: navFooter });
    return;
  }
    let reply = `📋 *Bales for ${design}${shade ? ' ' + shade : ''}:*\n\n`;
  packages.forEach((p) => {
    reply += `Bale ${p.packageNo} (${p.warehouse}): ${p.available}/${p.total} thans avail, ${fmtQty(p.availableYards)} yds\n`;
  });
  const totalAvail = packages.reduce((s, p) => s + p.availableYards, 0);
  reply += `\n*Total: ${packages.length} Bale${packages.length === 1 ? '' : 's'}, ${fmtQty(totalAvail)} yards*`;
  await sendLong(bot, chatId, reply, { parse_mode: 'Markdown', reply_markup: navFooter });
}

/** Design-level selling price line for Check Stock (quoted price, not sold price). */
function fmtSellingHeaderLine({ price, mixed }) {
  if (!price) return 'Selling: not set\n';
  return `Selling: ${fmtMoney(price)}/yd${mixed ? ' ·varies' : ''}\n`;
}

/** Reusable Check Stock report — qty breakdown only; value totals live in Stock Value report. */
async function sendCheckStockReport(bot, chatId, design, userId = null) {
  // Footer: back to the design list (re-opens the picker) or out to the menu.
  const navFooter = { inline_keyboard: [[
    { text: '⬅ Back to designs', callback_data: 'cks:__designs__' },
    { text: '🏠 Menu', callback_data: 'act:__back__' },
  ]] };
  const stock = await inventoryService.checkStock({ design });
  if (!stock || stock.totalThans === 0) {
    await bot.sendMessage(chatId, `⚠️ No available stock for design ${design}.`,
      { reply_markup: navFooter });
    return;
  }
  const canSelling = userId ? pricingService.canSeeSalePrice(userId) : false;
  // DCAT-1: show the admin-approved category next to the design number.
  const stockCat = await designCategoriesRepo.categoryOf(design);
  let reply = `📦 *Stock — Design ${design}${stockCat ? ` · ${stockCat}` : ''}*\n`;
  const allInv = await inventoryRepository.getAll();
  if (canSelling) {
    const sp = pricingService.resolveSalePrice(allInv, design);
    reply += fmtSellingHeaderLine(sp);
  }
  const labels = await productTypesRepo.getLabels('fabric');
  reply += `Available: ${stock.totalPackages} ${productTypesRepo.pluralize(labels.container_label, stock.totalPackages).toLowerCase()} `;
  reply += `(${stock.totalThans} ${productTypesRepo.pluralize(labels.subunit_label, stock.totalThans).toLowerCase()}), `;
  reply += `${fmtQty(stock.totalYards)} ${labels.measure_unit}\n`;

  // TRF-2 — bales mid-transfer sit at the destination as in_transit:
  // visible here so the receiving team can see what's coming, but not
  // sellable until the receiver confirms.
  const inTransit = allInv.filter((r) => r.status === 'in_transit' && r.design === design);
  if (inTransit.length) {
    const byDest = new Map();
    for (const r of inTransit) {
      if (!byDest.has(r.warehouse)) byDest.set(r.warehouse, new Set());
      byDest.get(r.warehouse).add(r.packageNo);
    }
    const parts = [...byDest.entries()].map(([w, pkgs]) => `${pkgs.size} bale${pkgs.size === 1 ? '' : 's'} → ${w}`);
    reply += `🚚 In transit (not yet sellable): ${parts.join(', ')}\n`;
  }

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
      reply += `  Shade ${sh}: ${s.pkgs.size} Bales, ${fmtQty(s.yards)} yds (${whList})\n`;
    }
  }
  await sendLong(bot, chatId, reply, { parse_mode: 'Markdown', reply_markup: navFooter });
}

const STOCK_VALUE_PAGE_SIZE = 10;

/** Reports hub — Step 1: designs ranked by stock value (paginated). */
async function startStockValueFlow(bot, chatId, userId, messageId = null) {
  if (!pricingService.canSeeSalePrice(userId)) {
    await bot.sendMessage(chatId, 'Stock Value is available to admins only.');
    return;
  }
  const page = 0;
  sessionStore.set(userId, { type: 'stock_value', step: 'list', page, flowMessageId: messageId || null });
  await renderStockValueList(bot, chatId, userId, page);
}

async function renderStockValueList(bot, chatId, userId, page) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'stock_value') return;

  const allInv = await inventoryRepository.getAll();
  const summaries = stockValueReport.computeDesignSummaries(allInv);
  const { grandValue, grandYards, designCount } = stockValueReport.computeGrandTotals(summaries);

  if (!summaries.length) {
    await editOrSend(bot, chatId, session.flowMessageId,
      '💰 *Stock Value*\n\n_No available stock in inventory._',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '❌ Close', callback_data: 'svr:cancel' }],
        menuNav.backToMenuRow(),
      ] } });
    return;
  }

  let activeDesigns = new Set();
  try {
    const active = await designAssetsRepo.list('active');
    activeDesigns = new Set(active.map((a) => String(a.design).toUpperCase()));
  } catch (_) { /* graceful */ }

  const totalPages = Math.max(1, Math.ceil(summaries.length / STOCK_VALUE_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = summaries.slice(safePage * STOCK_VALUE_PAGE_SIZE, (safePage + 1) * STOCK_VALUE_PAGE_SIZE);

  let text = '💰 *Stock Value*\n';
  text += '_Selling × available yards. Tap a design to drill into shade detail._\n\n';

  for (const s of slice) {
    const hasPhoto = activeDesigns.has(String(s.design).toUpperCase());
    const icon = hasPhoto ? '🖼 ' : '';
    const sellStr = s.priceSet
      ? `${fmtMoney(s.dominantSelling)}/yd${s.varies ? ' ·varies' : ''}`
      : 'price not set';
    text += `${icon}*${s.design}* — ${fmtMoney(s.value)} (${fmtQty(s.availYards)} yds · ${sellStr})\n`;
  }

  if (totalPages > 1) {
    text += `\n_Page ${safePage + 1} of ${totalPages}_\n`;
  }
  text += `\n🧮 *Grand Total:* ${fmtMoney(grandValue)} · ${fmtQty(grandYards)} yds · ${designCount} design${designCount === 1 ? '' : 's'}`;

  const rows = slice.map((s) => ([{
    text: `${s.design} · ${fmtMoneyShort(s.value)}`,
    callback_data: `svr:dg:${s.design.slice(0, 50)}`,
  }]));

  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅ Prev', callback_data: `svr:pg:${safePage - 1}` });
  if (safePage < totalPages - 1) nav.push({ text: 'Next ➡', callback_data: `svr:pg:${safePage + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🔄 Refresh', callback_data: `svr:pg:${safePage}` }]);
  rows.push([{ text: '❌ Close', callback_data: 'svr:cancel' }]);

  session.page = safePage;
  sessionStore.set(userId, session);
  await editOrSend(bot, chatId, session.flowMessageId, text,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

/** Reports hub — Step 2: shade-level value breakdown for one design. */
async function showStockValueDesign(bot, chatId, userId, design) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'stock_value') return;

  const allInv = await inventoryRepository.getAll();
  const bd = stockValueReport.computeShadeBreakdown(allInv, design);

  if (!bd.rows.length) {
    await editOrSend(bot, chatId, session.flowMessageId,
      `💰 *Stock Value — ${design}*\n\n_No available stock for this design._`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅ Back', callback_data: 'svr:back' }]] } });
    return;
  }

  session.step = 'design';
  session.drillDesign = design;
  sessionStore.set(userId, session);

  let text = `💰 *Stock Value — Design ${bd.design}*\n\n`;
  if (bd.dominantSelling > 0) {
    text += `Selling: ${fmtMoney(bd.dominantSelling)}/yd${bd.varies ? ' ·varies' : ''}\n`;
  } else {
    text += 'Selling: not set\n';
  }
  text += `Available: ${bd.availPkgs} Bales · ${fmtQty(bd.availYards)} yds · ${fmtMoney(bd.designTotal)}\n\n`;
  text += '*By shade (value-ranked):*\n';

  for (const row of bd.rows) {
    let line = `  Shade ${row.shade}: ${row.pkgs} Bales · ${fmtQty(row.yards)} yds · ${fmtMoney(row.value)}`;
    if (row.differsFromDominant && row.sellingPrice > 0) {
      line += ` _(Selling: ${fmtMoney(row.sellingPrice)}/yd)_`;
    }
    text += `${line}\n`;
  }
  text += `\n🧮 *Design Total:* ${fmtMoney(bd.designTotal)}`;

  await editOrSend(bot, chatId, session.flowMessageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '⬅ Back to all designs', callback_data: 'svr:back' }],
      [{ text: '❌ Close', callback_data: 'svr:cancel' }],
    ] },
  });
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
  await adminFeed.notify(bot, 'order.delivered',
    `📦 Order *${orderId}* has been delivered.\n\nDesign: ${order.design}\nCustomer: ${order.customer}\nQty: ${order.quantity}\nDelivered by: ${order.salesperson_name}`,
    { parse_mode: 'Markdown' });
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
    return usersRepository.inDepartment(u, 'Sales');
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
  rows.push([
    { text: '⬅️ Back', callback_data: 'obb:quantity' },
    { text: '❌ Cancel', callback_data: 'ocanc:1' },
  ]);
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
        // APU-1 3.1: was 'new_customer_registration' — a dead action name
        // with no executor; 'new_customer' is what the approve/reject
        // special-cases and the flow-resume hooks actually match.
        action: 'new_customer',
        customer_id: customerId, customer_name: name, phone,
        requesterUserId: userId, from: 'order_flow',
      },
      riskReason: 'New customer requires admin approval',
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
      `⏳ Customer "*${name}*" sent for admin approval.\n\nYour order is *paused* — it will resume automatically once an admin approves the new customer.`,
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
// (downloadTelegramFile is now imported from ../utils/telegramFiles — used by
// receipt, sale-doc, and design-asset upload flows.)

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
        // APU-1 3.1: was 'new_customer_registration' — a dead action name
        // with no executor; 'new_customer' is what the approve/reject
        // special-cases and the flow-resume hooks actually match.
        action: 'new_customer',
        customer_id: customerId, customer_name: name, phone,
        requesterUserId: userId, from: 'receipt_flow',
      },
      riskReason: 'New customer requires admin approval',
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

  if (session && session.type === 'design_asset_flow' && session.step === 'photo') {
    const handled = await handleDesignAssetPhotoMessage(bot, chatId, userId, msg);
    if (handled) return;
  }

  if (session && session.type === 'marketer_reg_flow' && (session.step === 'person_photo' || session.step === 'catalog_photo')) {
    const handled = await catalogFlows.handleCatalogFlowPhotoStep(bot, chatId, userId, msg);
    if (handled) return;
  }

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

  // P2.5 — Bulk Receive: when a CSV/XLSX document arrives during an
  // active bulk_receive_flow session, route it to the flow's document
  // handler. handleDocument returns true when consumed so we short-
  // circuit; false leaves the document for other handlers (none today).
  if (session && session.type === 'bulk_receive_flow' && msg.document) {
    const handled = await bulkReceiveFlow.handleDocument(bot, msg);
    if (handled) return;
  }

  // TCSI-2: strict Add-stock flow — CSV upload routed to the new flow's
  // document handler, which adds R1/R2 inventory conflict scan on top of
  // upstream's bulkValidator before handing off to the dual-admin queue.
  if (session && session.type === 'add_stock:awaiting_file' && msg.document) {
    const addStockFlow = require('../flows/addStockFlow');
    const handled = await addStockFlow.handleDocument({ bot, chatId, userId, msg, session });
    if (handled) return;
  }

  // P5 — Photo Receive: accepts both compressed photos (msg.photo) and
  // documents (msg.document, including PDFs and full-quality images).
  // The flow's handleFile decides which is which.
  if (session && session.type === 'photo_receive_flow'
      && (msg.photo || msg.document)) {
    const handled = await photoReceiveFlow.handleFile(bot, msg);
    if (handled) return;
  }

  // TRF-3 — dispatch / receive load photo: when the transfer flow has armed
  // an await_doc session, route the uploaded photo/PDF to it.
  if (session && session.type === 'transfer_flow' && session.step === 'await_doc'
      && (msg.photo || msg.document)) {
    const handled = await require('../flows/transferFlow').handleFile(bot, msg);
    if (handled) return;
  }

  // SNAP-1 — bale label photo while Snap Sale awaits it.
  if (session && session.type === 'snap_sale_flow' && session.step === 'await_photo' && msg.photo) {
    const handled = await require('../flows/snapSaleFlow').handleFile(bot, msg);
    if (handled) return;
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
    // USR-C2 — strangers who tap /start (or just say hi) get captured into
    // PendingUsers and an admin is notified, instead of seeing a curt
    // "not authorized" message. Anyone else (an unknown sender pushing
    // arbitrary text) still gets the polite-but-firm rejection so we
    // don't spam admins with noise from drive-by traffic.
    const looksLikeFirstContact = !text
      || /^\/start\b/i.test(text)
      || /^(hi|hello|hey)\b/i.test(text);
    if (looksLikeFirstContact) {
      try {
        const pendingUserService = require('../services/pendingUserService');
        await pendingUserService.captureStranger(bot, msg);
      } catch (e) {
        try { require('../utils/logger').warn(`captureStranger failed: ${e.message}`); } catch (_) {}
      }
      return;
    }
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

  // MKT-1 — marketer / salesman are strictly view-only. Greetings and the
  // empty-text menu are handled above; ANY other free text is ignored and
  // simply re-shows their single "My Products" tile. They have no
  // text-driven actions (sell, transfer, reports, CRM, samples, etc.), so
  // we short-circuit before every flow/intent handler below.
  {
    const fieldUser = await usersRepository.findByUserId(userId);
    if (fieldUser
      && !config.access.adminIds.includes(userId)
      && fieldRoles.isFieldRole(fieldUser.role)) {
      await bot.sendMessage(chatId, '👋 Tap *📦 My Products* to see the designs and quantities available in your warehouse.', { parse_mode: 'Markdown' });
      await buildGreetingMenu(bot, chatId, userId);
      return;
    }
  }

  // Stage-1 reject reason / Stage-3 decline reason — these run on a
  // separate pendingReason map inside approvalEvents (not on the
  // shared sessionStore), so we check them BEFORE any other text
  // state handler. handleReasonReply returns true when it consumed
  // the message, false when it wasn't waiting for one.
  if (await approvalEvents.handleReasonReply(bot, msg)) {
    return;
  }

  // Catalog: design-asset upload/edit text steps. Self-contained — handles
  // its own cancel.
  {
    const dapSession = sessionStore.get(userId);
    if (dapSession && dapSession.type === 'design_asset_flow') {
      const handled = await handleDesignAssetTextStep(bot, chatId, userId, text);
      if (handled) return;
    }
  }

  // P5 — Photo Receive: per-row field edits accept free-text input.
  // Only matches when an edit subflow is active (session.editingField
  // is set), so harmless when the flow is in any other step.
  {
    const prSession = sessionStore.get(userId);
    if (prSession && prSession.type === 'photo_receive_flow') {
      const handled = await photoReceiveFlow.handleText(bot, msg);
      if (handled) return;
    }
  }

  // ARRIVAL-BATCH C1 — Bulk Receive accepts a free-typed container label
  // (e.g. "July26") during its `await_container` step on the preview card.
  {
    const brSession = sessionStore.get(userId);
    if (brSession && brSession.type === 'bulk_receive_flow') {
      const handled = await bulkReceiveFlow.handleText(bot, msg);
      if (handled) return;
    }
    // ST-1 — typing during the Sell Bale customer step = search filter.
    if (brSession && brSession.type === 'sell_bale_flow') {
      const handled = await require('../flows/sellBaleFlow').handleText(bot, msg);
      if (handled) return;
    }
  }

  // WH-C1 — standalone Add Warehouse flow accepts the new warehouse
  // name via free-text reply during the `await_name` step.
  {
    const whSession = sessionStore.get(userId);
    if (whSession && whSession.type === 'wh_add_flow') {
      const handled = await warehouseFlow.handleText(bot, msg);
      if (handled) return;
    }
  }

  // LANDED-COST C1 — Finalize Landed Cost flow accepts free-text input
  // for the USD-cost-per-yard step and the per-charge amount step.
  {
    const lcSession = sessionStore.get(userId);
    if (lcSession && lcSession.type === 'landed_cost_flow') {
      const landedCostFlow = require('../flows/landedCostFlow');
      const handled = await landedCostFlow.handleText(bot, msg);
      if (handled) return;
    }
  }

  // BR-OPS C1 — daily branch ops (camera-note + opening cash text steps).
  {
    const bopsSession = sessionStore.get(userId);
    if (bopsSession && bopsSession.type === 'daily_branch_ops') {
      const dailyBranchOpsFlow = require('../flows/dailyBranchOpsFlow');
      const handled = await dailyBranchOpsFlow.handleText(bot, msg);
      if (handled) return;
    }
  }

  // BR-OPS C1 — office expense batch (free-title + amount text steps).
  {
    const ofexSession = sessionStore.get(userId);
    if (ofexSession && ofexSession.type === 'office_expense_flow') {
      const officeExpenseFlow = require('../flows/officeExpenseFlow');
      const handled = await officeExpenseFlow.handleText(bot, msg);
      if (handled) return;
    }
  }

  // BUNDLE-SALE C1 — Kano poly-colour bundle picker accepts free-text
  // input for smart-pack target yardage, customer search, and rate entry.
  {
    const bsSession = sessionStore.get(userId);
    if (bsSession && bsSession.type === 'bundle_sale_flow') {
      const bundleSaleFlow = require('../flows/bundleSaleFlow');
      const handled = await bundleSaleFlow.handleText(bot, msg);
      if (handled) return;
    }
  }

  // TRF-7 — dispatcher bale-number search: partial bale numbers typed while
  // the picker's 🔎 step is armed return instant checkbox matches.
  {
    const trfSession = sessionStore.get(userId);
    if (trfSession && trfSession.type === 'transfer_flow' && trfSession.step === 'dispatch_search') {
      const handled = await require('../flows/transferFlow').handleText(bot, msg);
      if (handled) return;
    }
  }
  // CNET-1b — contact-network typed steps (add-person + update-details).
  {
    const cnSession = sessionStore.get(userId);
    const cnStep = String((cnSession && cnSession.step) || '');
    if (cnSession && cnSession.type === 'contact_network_flow' && (cnStep.startsWith('add_') || cnStep.startsWith('edit_'))) {
      const handled = await require('../flows/contactNetworkFlow').handleText(bot, msg);
      if (handled) return;
    }
  }

  // USR-C3 — Add Employee flow accepts free-text input for telegram_id,
  // name, and new-department steps.
  {
    const userAddSession = sessionStore.get(userId);
    if (userAddSession && userAddSession.type === 'user_add_flow') {
      const userAddFlow = require('../flows/userAddFlow');
      const handled = await userAddFlow.handleText(bot, msg);
      if (handled) return;
    }
  }

  // ATT-C2 — Attendance Admin hub accepts text input only on HH:MM,
  // timezone, and new-location steps. handleText returns false unless
  // an await_* step is active.
  {
    const atdAdmSession = sessionStore.get(userId);
    if (atdAdmSession && atdAdmSession.type === 'attendance_admin_flow') {
      const attendanceAdminFlow = require('../flows/attendanceAdminFlow');
      const handled = await attendanceAdminFlow.handleText(bot, msg);
      if (handled) return;
    }
  }

  // Catalog: search design photo — free-text design number lookup.
  {
    const dasSession = sessionStore.get(userId);
    if (dasSession && dasSession.type === 'catalog_search_flow') {
      const handled = await handleCatalogSearchTextStep(bot, chatId, userId, text);
      if (handled) return;
    }
  }

  // Physical catalog flows: supply, loan, return, register marketer.
  {
    const cfSession = sessionStore.get(userId);
    if (cfSession && ['catalog_supply_flow', 'catalog_loan_flow', 'catalog_return_flow', 'marketer_reg_flow'].includes(cfSession.type)) {
      const handled = await catalogFlows.handleCatalogFlowTextStep(bot, chatId, userId, text);
      if (handled) return;
    }
  }

  // Manage catalog stock (admin): add/set quantity text input.
  {
    const cmsSession = sessionStore.get(userId);
    if (cmsSession && ['cms_add_flow', 'cms_setqt_flow'].includes(cmsSession.type)) {
      const handled = await catalogFlows.handleCmsTextStep(bot, chatId, userId, text);
      if (handled) return;
    }
  }

  // Task assign flow: title / description text input.
  {
    const tskSession = sessionStore.get(userId);
    if (tskSession && tskSession.type === 'task_assign_flow') {
      const handled = await taskFlow.handleTextStep(bot, msg);
      if (handled) return;
    }
  }

  // TCSI-2: strict Add-stock flow — typed new-warehouse name, or
  // reminders during awaiting-file / conflict-blocked stages.
  {
    const ascSession = sessionStore.get(userId);
    if (ascSession && typeof ascSession.type === 'string' && ascSession.type.startsWith('add_stock:')) {
      const addStockFlow = require('../flows/addStockFlow');
      const handled = await addStockFlow.handleTextMessage({ bot, chatId, userId, text, session: ascSession });
      if (handled) return;
    }
  }

  // P2 — Goods Receipt Note flow: warehouse-name / supplier-name / bales /
  // yards-custom text input.
  {
    const grnSession = sessionStore.get(userId);
    if (grnSession && grnSession.type === 'grn_flow') {
      const handled = await goodsReceiptFlow.handleTextStep(bot, msg);
      if (handled) return;
    }
  }

  // P4 — Procurement PO new-flow: supplier/design/shade/qty/date text input.
  {
    const poSession = sessionStore.get(userId);
    if (poSession && poSession.type === 'po_new_flow') {
      const handled = await procurementPlanView.handleTextStep(bot, msg);
      if (handled) return;
    }
  }

  // Orphan-flow detection: if the user just posted a reply that *looks* like
  // it was meant for a recently expired flow (e.g. comma-separated shade
  // names while the design_asset_flow session timed out), send a clear
  // "session expired — please restart" message instead of letting the AI
  // intent parser hallucinate a clarification.
  {
    const hint = sessionStore.getLastSessionHint(userId);
    if (hint && hint.type === 'design_asset_flow') {
      const looksLikeFlowReply =
        (hint.step === 'shade_names' && (text.includes(',') || /^skip$/i.test(text))) ||
        (hint.step === 'design_typing' && text.length > 0 && text.length <= 30) ||
        (hint.step === 'edit_names' && text.includes(','));
      if (looksLikeFlowReply) {
        sessionStore.clearLastSessionHint(userId);
        await bot.sendMessage(chatId,
          '⏳ Your *Upload Product Photo* session expired before this reply arrived.\n\nPlease restart from 📷 *Catalog → Upload Product Photo* — your input was not lost, just not connected to a live flow.',
          { parse_mode: 'Markdown' });
        return;
      }
    }
  }

  if (text.toLowerCase() === 'cancel') {
    const s = sessionStore.get(userId);
    if (s && (s.type === 'supply_req_flow' || s.type === 'adm_flow')) {
      if (s.type === 'supply_req_flow') {
        await clearDesignPreview(bot, chatId, userId);
      }
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
        await showSupplySalespersonPicker(bot, chatId, userId, false);
        return;
      }
      srfSession.newCustomerName = name;
      srfSession.step = 'new_srf_customer_phone';
      sessionStore.set(userId, srfSession);
      await bot.sendMessage(chatId, '📱 Enter customer phone number:', {
        reply_markup: { inline_keyboard: [[
          { text: '⬅️ Back to customers', callback_data: 'srf_back:customer' },
          { text: '❌ Cancel', callback_data: 'srf_cart:cancel' },
        ]] },
      });
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
      const requestId = genId();
      srfSession.customerApprovalId = requestId;
      sessionStore.set(userId, srfSession);
      const approvalQueueRepository = require('../repositories/approvalQueueRepository');
      await approvalQueueRepository.append({
        requestId,
        user: userId,
        actionJSON: { action: 'new_customer', customer_id: custId, customer_name: name, phone, requesterUserId: userId },
        riskReason: 'New customer requires admin approval',
        status: 'pending',
      });
      await auditLogRepository.append('approval_queued', { requestId, reason: 'new_customer', from: 'supply_req_flow' }, userId);
      const approvalEvents = require('../events/approvalEvents');
      const userLabel = await getRequesterDisplayName(userId, null);
      await approvalEvents.notifyAdminsApprovalRequest(
        bot, requestId, userLabel,
        `New Customer Registration\nName: ${name}\nPhone: ${phone || '—'}\n(from supply request flow)`,
        'New customer requires admin approval',
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
      await bot.sendMessage(chatId, 'Only admin can revert Bales.');
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
    await bot.sendMessage(chatId, `📦 *Revert Bales*\n\n${results.join('\n')}\n\nTotal: ${restored} thans restored to available.`, { parse_mode: 'Markdown' });
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

  // P4 — /setlowstock N  (admin-only) — tunes the low-stock alert
  // threshold used by the Procurement Plan view. Persisted to Settings
  // so all flows see it immediately.
  if (/^\/setlowstock\b/i.test(text.trim())) {
    if (!config.access.adminIds.includes(userId)) {
      await bot.sendMessage(chatId, 'Admin only.');
      return;
    }
    const m = text.trim().match(/^\/setlowstock\s+(\d+)\s*$/i);
    if (!m) {
      await bot.sendMessage(chatId, 'Usage: `/setlowstock N` — e.g. `/setlowstock 5`', { parse_mode: 'Markdown' });
      return;
    }
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n < 0) {
      await bot.sendMessage(chatId, 'N must be a non-negative integer.');
      return;
    }
    try {
      const settingsRepo = require('../repositories/settingsRepository');
      await settingsRepo.set('LOW_STOCK_THRESHOLD', String(n));
      await bot.sendMessage(chatId, `✅ Low-stock threshold set to *${n}* bales.`, { parse_mode: 'Markdown' });
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Failed to save: ${e.message}`);
    }
    return;
  }

  // P2.5 — /bulkformat returns a copy-pasteable CSV template for the
  // Bulk Receive Goods flow. Open to anyone with bot access so Abdul can
  // reference the format on his phone without having to remember it.
  if (/^\/bulkformat\b/i.test(text.trim())) {
    await bulkReceiveFlow.sendTemplate(bot, chatId);
    return;
  }

  const activeSession = salesFlow.getSession(userId);
  if (activeSession) {
    const handled = await handleSaleSession(bot, chatId, msg, userId, text, activeSession);
    if (handled) return;
  }

  // P3 — userId enables the per-user OpenAI rate limit inside the parser.
  const intent = await intentParser.parse(text, userId);
  // ANL-1 — typed-command usage (surface=nlp); no-op until analytics enabled.
  usageTracker.track({ userId, surface: 'nlp', feature: (intent && intent.action) || 'unknown', event: 'nlp_intent', meta: { confidence: intent && intent.confidence } });

  // TCSI-2: 'add' starts a tappable wizard that collects every detail
  // itself (warehouse, then CSV). Bypass the clarification gate so the
  // wizard runs even when the parser is unsure about the params.
  if (intent.confidence < 0.75 && intent.clarification && intent.action !== 'add') {
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
        if (intent.design && pricingService.canSeeSalePrice(userId)) {
          const allInv = await inventoryRepository.getAll();
          reply += fmtSellingHeaderLine(pricingService.resolveSalePrice(allInv, intent.design));
        }
        const stockLabels = await productTypesRepo.getLabels('fabric');
        reply += `Available: ${stock.totalPackages} ${productTypesRepo.pluralize(stockLabels.container_label, stock.totalPackages).toLowerCase()} (${stock.totalThans} ${productTypesRepo.pluralize(stockLabels.subunit_label, stock.totalThans).toLowerCase()}), ${fmtQty(stock.totalYards)} ${stockLabels.measure_unit}\n`;
        if (stock.totalThans === 0) reply += '⚠️ No available stock matching these filters.';
        await sendLong(bot, chatId, reply, { parse_mode: 'Markdown' });
        return;
      }

      case 'list_packages': {
        if (!intent.design) {
          await bot.sendMessage(chatId, 'Which design? e.g. "Show Bales for design 44200"');
          return;
        }
        await sendListPackagesReport(bot, chatId, intent.design, intent.shade || null);
        return;
      }

      case 'package_detail': {
        if (!intent.packageNo) {
          await bot.sendMessage(chatId, 'Which package? e.g. "Details of Bale 5801"');
          return;
        }
        const summary = await inventoryService.getPackageSummary(intent.packageNo);
        if (!summary) {
          await bot.sendMessage(chatId, `Bale ${intent.packageNo} not found.`);
          return;
        }
        let reply = `📦 *Bale ${summary.packageNo}*\n`;
        // DCAT-1: category label rides along with the design number.
        const pkgCat = await designCategoriesRepo.categoryOf(summary.design);
        reply += `Design: ${summary.design}${pkgCat ? ` · ${pkgCat}` : ''} | Shade: ${summary.shade}\n`;
        reply += `Indent: ${summary.indent} | Warehouse: ${summary.warehouse}\n`;
        if (pricingService.canSeeSalePrice(userId)) {
          reply += `Price: ${fmtMoney(summary.pricePerYard)}/yard\n\n`;
        }
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
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Sell than 3 from Bale 5801 to Ibrahim"'); return; }
        if (!intent.thanNo) { await bot.sendMessage(chatId, 'Which than number?'); return; }
        const items = [{ type: 'than', packageNo: intent.packageNo, thanNo: intent.thanNo }];
        await startSaleFlow(bot, chatId, msg, userId, 'sell_than', items, intent);
        return;
      }

      case 'sell_package': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Sell Bale 5801 to Adamu"'); return; }
        const items = [{ type: 'package', packageNo: intent.packageNo }];
        await startSaleFlow(bot, chatId, msg, userId, 'sell_package', items, intent);
        return;
      }

      case 'sell_batch': {
        if (!intent.packageNos || !intent.packageNos.length) { await bot.sendMessage(chatId, 'Which Bales? e.g. "Sell Bales 5801, 5802, 5803 to Ibrahim"'); return; }
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
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which package? e.g. "Return than 2 from Bale 5801"'); return; }
        if (!intent.thanNo) { await bot.sendMessage(chatId, 'Which than number?'); return; }
        const rtQueued = await requireApproval(bot, chatId, msg, userId, 'return_than',
          { action: 'return_than', packageNo: intent.packageNo, thanNo: intent.thanNo },
          await require('../services/approvalCards').buildReturnCard({ packageNo: intent.packageNo, thanNo: intent.thanNo }));
        if (rtQueued) return;
        const retThan = await inventoryService.returnThan(intent.packageNo, intent.thanNo, userId);
        if (retThan.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Returned than ${intent.thanNo} from Bale ${intent.packageNo} (${fmtQty(retThan.than.yards)} yds) — now available.`);
        } else {
          await bot.sendMessage(chatId, retThan.message || 'Could not return.');
        }
        return;
      }

      case 'return_package': {
        if (!intent.packageNo) { await bot.sendMessage(chatId, 'Which Bale? e.g. "Return Bale 5801"'); return; }
        const rpQueued = await requireApproval(bot, chatId, msg, userId, 'return_package',
          { action: 'return_package', packageNo: intent.packageNo },
          await require('../services/approvalCards').buildReturnCard({ packageNo: intent.packageNo }));
        if (rpQueued) return;
        const retPkg = await inventoryService.returnPackage(intent.packageNo, userId);
        if (retPkg.status === 'completed') {
          await bot.sendMessage(chatId, `✅ Returned Bale ${intent.packageNo}: 1 Bale (${retPkg.returnedThans} thans), ${fmtQty(retPkg.returnedYards)} yards — now available.`);
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
        const label = `${filters.design}${filters.shade ? ' Shade ' + filters.shade : ''}${filters.packageNo ? ' Bale ' + filters.packageNo : ''}${filters.warehouse ? ' at ' + filters.warehouse : ''}`;
        // APU-1 3.4: solo-admin auto-approve is decided BEFORE queueing —
        // the old order appended the queue row first, so the auto-approve
        // path left a forever-pending (re-approvable) orphan in the queue.
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
        const requestId = genId();
        await approvalQueueRepository.append({
          requestId, user: userId,
          actionJSON: { action: 'update_price', filters, price: intent.price },
          riskReason: '2nd admin approval required for price update', status: 'pending',
        });
        await auditLogRepository.append('approval_queued', { requestId, reason: 'price_update_approval' }, userId);
        const userLabel = await getRequesterDisplayName(userId, msg);
        const summary = `Price Update Request\n${label}\nNew price: ${fmtMoney(intent.price)}/yard`;
        await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, '2nd admin approval required', userId);
        await bot.sendMessage(chatId, `⏳ Price update for ${label} to ${fmtMoney(intent.price)}/yard submitted for 2nd admin approval.\nRequest: ${requestId}`);
        return;
      }

      case 'transfer_than':
      case 'transfer_package':
      case 'transfer_batch': {
        // TRF-5 — legacy instant transfers retired: no dispatcher/receiver
        // chain, no in-transit stage, no photos. Typed requests are still
        // recognised but redirect into the staged Transfer Stock flow.
        await bot.sendMessage(chatId,
          '🚚 Warehouse transfers now go through *Transfer Stock* — the staged flow where the dispatcher logs the actual bales and the receiver confirms arrival.', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [{ text: '🚚 Open Transfer Stock', callback_data: 'act:transfer_stock' }],
            ] },
          });
        return;
      }

      case 'add': {
        const addStockFlow = require('../flows/addStockFlow');
        await addStockFlow.start({ bot, chatId, userId });
        return;
      }

      case 'analyze': {
        const summary = await analytics.getAnalysisSummary(intent.design, intent.shade);
        await sendLong(bot, chatId, summary, { parse_mode: 'Markdown' });
        return;
      }

      case 'report_stock': {
        await sendLong(bot, chatId, await queryEngine.stockSummary(userId), { parse_mode: 'Markdown' });
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
        // Build a human-readable summary of what's about to be reverted so
        // the 2nd admin can audit before approving. We hand the original
        // sale's request_id and txn timestamp into the approval payload so
        // the executor can roll back inventory + ledger and mark the
        // original transaction row "reverted" once approved.
        let summaryDetail = '';
        try {
          const approvalRow = await approvalQueueRepository.getByRequestId(t.saleRefId);
          const aj = approvalRow?.actionJSON || {};
          if (aj && Array.isArray(aj.items)) {
            const totalItems = aj.items.length;
            summaryDetail = `\nOriginal sale: ${aj.customer || '?'} · ${totalItems} item(s) · request \`${t.saleRefId}\``;
          }
        } catch (_) { /* best-effort */ }
        const queued = await requireApproval(bot, chatId, msg, userId, 'revert_sale_bundle',
          { action: 'revert_sale_bundle', saleRefId: t.saleRefId, txnTimestamp: t.timestamp, txnUser: t.user, txnAction: t.action },
          `Revert last transaction${summaryDetail}`);
        if (queued) return;
        // Should be unreachable — revert_sale_bundle is in
        // ALWAYS_APPROVAL_ACTIONS so requireApproval always queues. Keep a
        // fallback message just in case the risk config drifts.
        await bot.sendMessage(chatId, '⚠️ Could not queue revert for approval. Check risk configuration.');
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
        // Consolidated onboarding: every add-user path funnels into the single
        // Add Employee flow (branch → dept → warehouses → role → dual-admin
        // approval). When the NL command carried an ID/name, prefill them.
        const userAddFlow = require('../flows/userAddFlow');
        const telegramId = intent.price != null ? String(Math.floor(Number(intent.price))) : null;
        const newUserName = (intent.customer || intent.salesperson || '').trim();
        const prefill = (telegramId && telegramId !== 'NaN')
          ? { telegram_id: telegramId, first_name: newUserName, source: 'admin' }
          : null;
        await userAddFlow.start(bot, chatId, String(userId), null, prefill);
        return;
      }

      case 'assign_task': {
        // Tappable picker is the canonical entry point now — NL just launches it.
        await taskFlow.startAssign(bot, chatId, userId, null);
        return;
      }

      case 'my_tasks': {
        // Send a fresh anchor message; taskFlow.showMyTasks edits in place.
        const sent = await bot.sendMessage(chatId, 'Loading your tasks…');
        await taskFlow.showMyTasks(bot, chatId, userId, sent.message_id);
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
            [{ text: '⬅ Back to menu', callback_data: 'act:__back__' }],
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
            [{ text: '⬅ Back to menu', callback_data: 'act:__back__' }],
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
↩️ "Return than 2 from Bale 5801"
🔄 "Transfer Bale 5801 to Kano"
💲 "Update price of 44200 BLACK to 1500"
📦 "How much 44200 BLACK do we have?"
📋 "Show Bales for design 44200"

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
  // Multi-dept users (e.g. Yarima in Sales + Dispatch) see the UNION
  // of allowed activities across every department they belong to —
  // this is the natural "I can do anything any of my departments can
  // do" behavior. Falls back to the single-dept legacy field if the
  // multi-dept array isn't populated yet.
  const userDepts = (user && Array.isArray(user.departments) && user.departments.length)
    ? user.departments
    : (user && user.department ? [user.department] : (isAdminUser ? ['Admin'] : []));
  const deptName = userDepts[0] || (isAdminUser ? 'Admin' : '');

  // MKT-1 — marketer / salesman get a controlled, single-tile menu ("My
  // Products"), independent of any department activities. Admins are never
  // treated as a field role.
  const fieldRole = (!isAdminUser && user) ? fieldRoles.classify(user.role) : null;

  let allowed = [];
  const TASK_CODES = new Set(['assign_task', 'my_tasks', 'team_tasks', 'pending_signoff', 'payouts']);
  if (fieldRole) {
    allowed = activityRegistry.filterByCodes(['my_products']);
  } else if (isAdminUser) {
    // Admin sees the entire registry; we'll still let taskFlow gate the
    // Task hub entries below so non-managing admins are not noisy with
    // every task tile (admins ARE managers by definition, so all 4 show).
    allowed = activityRegistry.getAll().filter((a) => !TASK_CODES.has(a.code));
  } else if (userDepts.length) {
    const seen = new Set();
    for (const name of userDepts) {
      const dept = await departmentsRepo.findByName(name);
      if (!dept) continue;
      for (const a of activityRegistry.filterByCodes(dept.allowed_activities)) {
        // Skip task codes — they're injected per-user below, not from
        // Departments.allowed_activities.
        if (TASK_CODES.has(a.code)) continue;
        if (!seen.has(a.code)) {
          seen.add(a.code);
          allowed.push(a);
        }
      }
    }
  }

  // Inject Task hub activities based on user attributes (admin / manages).
  if (!fieldRole) try {
    const taskCodes = await taskFlow.visibleTaskActivityCodes(userId);
    for (const a of activityRegistry.filterByCodes(taskCodes)) {
      allowed.push(a);
    }
  } catch (e) {
    logger.warn(`buildGreetingMenuMarkup: taskFlow visibility failed: ${e.message}`);
  }

  // ATT-C1 — Inject the "📍 Mark Attendance" tile for users that admin has
  // added to ATTENDANCE_REQUIRED_USERS. Hub is null on the registry entry,
  // so this is the ONLY path that surfaces the tile. Admins also get the
  // tile if they happen to be in the required list (test path).
  if (!fieldRole) try {
    const attendanceService = require('../services/attendanceService');
    const isReq = await attendanceService.isRequired(userId);
    if (isReq) {
      for (const a of activityRegistry.filterByCodes(['mark_attendance'])) {
        if (!allowed.find((x) => x.code === a.code)) allowed.push(a);
      }
    }
  } catch (e) {
    logger.warn(`buildGreetingMenuMarkup: attendance visibility failed: ${e.message}`);
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
  const userDepts = (user && Array.isArray(user.departments) && user.departments.length)
    ? user.departments
    : (user && user.department ? [user.department] : (isAdminUser ? ['Admin'] : []));

  let allowed = [];
  const TASK_CODES = new Set(['assign_task', 'my_tasks', 'team_tasks', 'pending_signoff', 'payouts']);
  if (isAdminUser) {
    allowed = activityRegistry.getAll().filter((a) => !TASK_CODES.has(a.code));
  } else if (userDepts.length) {
    const seen = new Set();
    for (const name of userDepts) {
      const dept = await departmentsRepo.findByName(name);
      if (!dept) continue;
      for (const a of activityRegistry.filterByCodes(dept.allowed_activities)) {
        if (TASK_CODES.has(a.code)) continue;
        if (!seen.has(a.code)) {
          seen.add(a.code);
          allowed.push(a);
        }
      }
    }
  }
  try {
    const taskCodes = await taskFlow.visibleTaskActivityCodes(userId);
    for (const a of activityRegistry.filterByCodes(taskCodes)) {
      allowed.push(a);
    }
  } catch (e) {
    logger.warn(`renderHubSubmenu: taskFlow visibility failed: ${e.message}`);
  }
  // A hub renders its visible child sub-hubs (each holding ≥1 allowed
  // activity) PLUS the activities that sit directly on it. Sub-hub tiles
  // re-enter this same handler via act:__hub__:<childId>.
  const childHubs = activityRegistry.getChildHubs(hubId)
    .filter((ch) => allowed.some((a) => a.hub === ch.id));
  const directSubs = allowed.filter((a) => a.hub === hubId);

  if (!childHubs.length && !directSubs.length) {
    await bot.editMessageText(`${hub.icon} *${hub.label}*\n\n_No actions available in this section._`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⬅ Back', callback_data: 'act:__back__' }]] },
    }).catch(() => {});
    return;
  }

  const counts = await userPrefsRepo.getCountsForUser(userId);
  // Unified, usage-sorted entry list: sub-hub tiles + direct actions.
  const entries = [];
  for (const ch of childHubs) {
    const agg = allowed
      .filter((a) => a.hub === ch.id)
      .reduce((s, a) => s + (counts[a.code] || 0), 0);
    entries.push({ kind: 'hub', hub: ch, count: agg });
  }
  for (const a of directSubs) {
    entries.push({ kind: 'activity', activity: a, count: counts[a.code] || 0 });
  }
  entries.sort((a, b) => b.count - a.count);

  const rows = [];
  for (let i = 0; i < entries.length; i += 2) {
    const row = [entryToButton(entries[i])];
    if (entries[i + 1]) row.push(entryToButton(entries[i + 1]));
    rows.push(row);
  }
  // Back goes to the parent module for a sub-hub, else to the greeting menu.
  if (hub.parent) {
    const parent = activityRegistry.getHub(hub.parent);
    rows.push([
      { text: `⬅ ${parent ? parent.label : 'Back'}`, callback_data: `act:__hub__:${hub.parent}` },
      { text: '🏠 Menu', callback_data: 'act:__back__' },
    ]);
  } else {
    rows.push([{ text: '⬅ Back', callback_data: 'act:__back__' }]);
  }

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

/**
 * SRF-CAT — sentinel for the "Others" category chip (designs with no
 * design_category stamped yet). Kept short: callback_data is 64-byte capped.
 */
const SUPPLY_OTHERS_CATEGORY = '__others__';

/**
 * SRF-CAT — does a design belong to the supply-flow category filter?
 * Empty/absent filter matches everything (step skipped or legacy session).
 * @param {string} design Design number.
 * @param {string} category Canonical label or SUPPLY_OTHERS_CATEGORY.
 * @returns {boolean} True when the design passes the filter.
 */
function matchesSupplyCategory(design, category) {
  if (!category) return true;
  const cat = designCategoriesRepo.categoryOfSync(design);
  if (category === SUPPLY_OTHERS_CATEGORY) return !cat;
  return String(cat).toLowerCase() === String(category).toLowerCase();
}

/** SRF-CAT — human label for a session category value ('' when unset). */
function supplyCategoryLabel(category) {
  if (!category) return '';
  return category === SUPPLY_OTHERS_CATEGORY ? 'Others' : String(category);
}

async function getAdjustedAvailability(warehouse, cart, arrivalBatch = null, category = null) {
  const all = await inventoryRepository.getAll();
  // SRF-CAT — make sure the design→category snapshot is fresh before the
  // sync lookups below (no-op within its 60 s TTL).
  if (category) await designCategoriesRepo.getMap();
  // ARRIVAL-BATCH C1 — when a container is selected upstream, restrict
  // availability to that batch. UNLABELLED_BATCH matches rows whose
  // arrival_batch is still empty (pre-backfill). null = all containers.
  const ab = arrivalBatch ? String(arrivalBatch).toUpperCase() : null;
  const isUnlabelled = ab === String(inventoryRepository.UNLABELLED_BATCH).toUpperCase();
  const available = all.filter((r) => {
    if (r.warehouse !== warehouse || r.status !== 'available') return false;
    if (category && !matchesSupplyCategory(r.design, category)) return false;
    if (!ab) return true;
    const rab = (r.arrivalBatch || '').toUpperCase();
    return isUnlabelled ? rab === '' : rab === ab;
  });
  const designMap = new Map();
  for (const r of available) {
    const key = `${r.design}||${r.shade || 'DEFAULT'}`;
    if (!designMap.has(key)) designMap.set(key, { design: r.design, shade: r.shade || 'DEFAULT', pkgs: new Set(), pkgThans: new Map(), pkgValues: new Map(), productType: r.productType || 'fabric' });
    const entry = designMap.get(key);
    entry.pkgs.add(r.packageNo);
    // TV-1 — each Inventory row is one than; track per-bale than counts so
    // than-visibility warehouses can list subunit availability.
    entry.pkgThans.set(r.packageNo, (entry.pkgThans.get(r.packageNo) || 0) + 1);
    // WH-SUM — per-bale stock value (yards × price) for the admin-only
    // warehouse header summary.
    entry.pkgValues.set(r.packageNo, (entry.pkgValues.get(r.packageNo) || 0) + (r.yards || 0) * (r.pricePerYard || 0));
  }
  const result = [];
  for (const [, entry] of designMap) {
    const inCart = getCartQtyForDesignShade(cart, entry.design, entry.shade);
    const remaining = entry.pkgs.size - inCart;
    if (remaining > 0) {
      // TV-1 — thans of the remaining bales, assuming the cart consumes
      // bales in sheet order (exact whenever the cart is empty).
      const sizes = Array.from(entry.pkgThans.values());
      const skip = inCart > 0 ? inCart : 0;
      const availThans = sizes.slice(skip).reduce((a, b) => a + b, 0);
      const availValue = Array.from(entry.pkgValues.values()).slice(skip).reduce((a, b) => a + b, 0);
      result.push({ design: entry.design, shade: entry.shade, availPkgs: remaining, availThans, availValue, productType: entry.productType });
    }
  }
  return result;
}

async function startSupplyRequestFlow(bot, chatId, userId) {
  const user = await usersRepository.findByUserId(userId);
  // MG-1: marketers are pinned to their marketing group's warehouse(s)
  // (spec: marketing-group-catalog.md §4.1). For non-marketers, admins,
  // or when the master flag is off, getGroupWarehouses returns [] and
  // we fall through to the existing user.warehouses path unchanged.
  const isAdminUser = config.access.adminIds.includes(userId);
  const groupWhs = await marketerOverlay.getGroupWarehouses(user, isAdminUser);
  const scopeWarehouses = groupWhs.length
    ? groupWhs
    : (user && user.warehouses.length ? user.warehouses : []);

  // Non-admins with no assigned warehouse can't supply.
  if (!scopeWarehouses.length && !isAdminUser) {
    await bot.sendMessage(chatId, '⚠️ You have no warehouses assigned. Ask your admin to assign you.');
    return;
  }

  // ARRIVAL-BATCH C1 — the flow now opens on a "Select Container" step. The
  // container list is scoped to the warehouses this user may supply from
  // (all warehouses for an admin with none assigned). A container is the
  // arrival/shipment batch label (e.g. "Mar26") stamped on stock at intake.
  const containers = await inventoryRepository.getArrivalBatches({ warehouses: scopeWarehouses });
  if (!containers.length) {
    await bot.sendMessage(chatId, scopeWarehouses.length
      ? '⚠️ No available stock in your warehouse(s).'
      : '⚠️ No available stock in inventory.');
    return;
  }

  sessionStore.set(userId, {
    type: 'supply_req_flow',
    step: 'container',
    arrivalBatch: '',
    cart: [],
    _scopeWarehouses: scopeWarehouses,
  });
  await showContainerPicker(bot, chatId, userId, containers);
}

/**
 * CV-1/CV-2 — who may see ₦ container values: ONLY Railway env IDs
 * (ADMIN_IDS ∪ FINANCE_IDS), per owner mandate 13-Jul-2026. Deliberately
 * NOT auth.isAdmin(): sheet-promoted admins are excluded until the owner
 * adds them to the env lists.
 */
function canSeeContainerValues(userId) {
  const uid = String(userId);
  return config.access.adminIds.includes(uid) || config.access.financeIds.includes(uid);
}

/** Inline button for one arrival-batch (container) tile. */
function containerButton(c) {
  return { text: `🚢 ${c.label} (${c.bales} bls · ${c.thans} thans)`, callback_data: `srf_ct:${c.batch}` };
}

/**
 * Render the "Select Container" step (2-col tiles). `containers` may be
 * pre-fetched; when omitted it is recomputed from the session scope. Edits
 * the anchored flow message in place when one exists.
 */
async function showContainerPicker(bot, chatId, userId, containers = null, messageId = null) {
  const session = sessionStore.get(userId);
  const list = containers
    || await inventoryRepository.getArrivalBatches({ warehouses: (session && session._scopeWarehouses) || [] });
  const resolvedMsgId = messageId || (session && session.flowMessageId) || null;
  if (!list.length) {
    await editOrSend(bot, chatId, resolvedMsgId, '⚠️ No available stock to supply.', { parse_mode: 'Markdown' });
    return;
  }
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    const row = [containerButton(list[i])];
    if (list[i + 1]) row.push(containerButton(list[i + 1]));
    rows.push(row);
  }
  rows.push([{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]);
  // CV-1/CV-2 — value block for env admins/finance only (PRICE-VIS):
  // bold grand total on top, then one clean line per container (owner's
  // approved layout, 13-Jul). Everyone else keeps the unchanged picker.
  let cvBlock = '';
  if (canSeeContainerValues(userId)) {
    const sumYards = list.reduce((s, c) => s + (c.yards || 0), 0);
    const sumValue = list.reduce((s, c) => s + (c.value || 0), 0);
    cvBlock = `💰 *Total: ${fmtQty(sumYards)} yds · ${fmtMoney(sumValue)}*\n\n`
      + list.map((c) => `· ${c.label}: ${fmtQty(c.yards || 0)} yds · ${fmtMoney(c.value || 0)}`).join('\n')
      + '\n\n';
  }
  const sent = await editOrSend(bot, chatId, resolvedMsgId,
    `📦 *Supply Request*\n${cvBlock}🚢 Select container (arrival batch):`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
  if (session && session.type === 'supply_req_flow' && sent && sent.message_id) {
    session.flowMessageId = sent.message_id;
    sessionStore.set(userId, session);
  }
}

/**
 * Distinct warehouses (within the user's scope) that have AVAILABLE stock in
 * the given arrival batch. UNLABELLED_BATCH matches rows with an empty
 * arrival_batch (pre-backfill). SRF-CAT: optionally restricted to one
 * design category.
 */
async function getSupplyWarehouses(arrivalBatch, scopeWarehouses, category = null) {
  const all = await inventoryRepository.getAll();
  if (category) await designCategoriesRepo.getMap();
  const scope = new Set((scopeWarehouses || []).map((w) => String(w).toLowerCase()));
  const ab = arrivalBatch ? String(arrivalBatch).toUpperCase() : null;
  const isUnlabelled = ab === String(inventoryRepository.UNLABELLED_BATCH).toUpperCase();
  const set = new Set();
  for (const r of all) {
    if (r.status !== 'available') continue;
    const rab = (r.arrivalBatch || '').toUpperCase();
    if (ab && (isUnlabelled ? rab !== '' : rab !== ab)) continue;
    if (scope.size && !scope.has(String(r.warehouse || '').toLowerCase())) continue;
    if (category && !matchesSupplyCategory(r.design, category)) continue;
    if (r.warehouse) set.add(r.warehouse);
  }
  return Array.from(set).sort();
}

/**
 * SRF-CAT — categories with AVAILABLE stock in the chosen container within
 * the user's warehouse scope. Bale counts are distinct packageNos. Order:
 * DEFAULT_CATEGORIES first (owner's canonical order), extras alphabetically,
 * "Others" (uncategorized designs) last.
 * @returns {Promise<Array<{category: string, label: string, bales: number}>>}
 */
async function getSupplyCategories(arrivalBatch, scopeWarehouses) {
  const all = await inventoryRepository.getAll();
  await designCategoriesRepo.getMap();
  const scope = new Set((scopeWarehouses || []).map((w) => String(w).toLowerCase()));
  const ab = arrivalBatch ? String(arrivalBatch).toUpperCase() : null;
  const isUnlabelled = ab === String(inventoryRepository.UNLABELLED_BATCH).toUpperCase();
  const baleSets = new Map(); // label ('' = Others) -> Set of warehouse||packageNo
  // CV-1 — yards + selling value per category (value rendered admin-only).
  const totals = new Map(); // label -> { yards, value }
  for (const r of all) {
    if (r.status !== 'available') continue;
    const rab = (r.arrivalBatch || '').toUpperCase();
    if (ab && (isUnlabelled ? rab !== '' : rab !== ab)) continue;
    if (scope.size && !scope.has(String(r.warehouse || '').toLowerCase())) continue;
    const cat = designCategoriesRepo.categoryOfSync(r.design) || '';
    if (!baleSets.has(cat)) baleSets.set(cat, new Set());
    baleSets.get(cat).add(`${r.warehouse}||${r.packageNo}`);
    if (!totals.has(cat)) totals.set(cat, { yards: 0, value: 0 });
    const t = totals.get(cat);
    t.yards += r.yards || 0;
    t.value += (r.pricePerYard || 0) * (r.yards || 0);
  }
  const defaults = designCategoriesRepo.DEFAULT_CATEGORIES.map((c) => c.toLowerCase());
  const labels = Array.from(baleSets.keys()).filter((c) => c !== '');
  labels.sort((a, b) => {
    const ia = defaults.indexOf(a.toLowerCase());
    const ib = defaults.indexOf(b.toLowerCase());
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  const result = labels.map((c) => ({
    category: c, label: c, bales: baleSets.get(c).size,
    yards: (totals.get(c) || {}).yards || 0, value: (totals.get(c) || {}).value || 0,
  }));
  if (baleSets.has('')) {
    result.push({
      category: SUPPLY_OTHERS_CATEGORY, label: 'Others', bales: baleSets.get('').size,
      yards: (totals.get('') || {}).yards || 0, value: (totals.get('') || {}).value || 0,
    });
  }
  return result;
}

/**
 * SRF-CAT — render the "Select category" step (between container and
 * warehouse). `cats` may be pre-fetched by proceedAfterContainerToCategory.
 */
async function showSupplyCategoryPicker(bot, chatId, userId, cats = null) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const list = cats || await getSupplyCategories(session.arrivalBatch, session._scopeWarehouses);
  if (!list.length) {
    await editOrSendAnchored(bot, chatId, userId, '⚠️ No available stock in this container.', { parse_mode: 'Markdown' });
    return;
  }
  const catButton = (c) => ({
    text: `${c.category === SUPPLY_OTHERS_CATEGORY ? '📦' : designCategoriesRepo.iconFor(c.label)} ${c.label} (${c.bales} bls)`,
    callback_data: `srf_cg:${c.category.slice(0, 55)}`,
  });
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    const row = [catButton(list[i])];
    if (list[i + 1]) row.push(catButton(list[i + 1]));
    rows.push(row);
  }
  rows.push([{ text: '⬅️ Back to containers', callback_data: 'srf_back:container' }]);
  const safeBatch = String(session.arrivalBatch).replace(/[*_`[\]]/g, '\\$&');
  // CV-1 — container totals: bold total on top, clean per-category lines
  // (owner's approved layout, 13-Jul). Yards are safe for every role; the
  // ₦ value parts render only for env admins/finance (PRICE-VIS).
  const totBales = list.reduce((s, c) => s + (c.bales || 0), 0);
  const totYards = list.reduce((s, c) => s + (c.yards || 0), 0);
  const totValue = list.reduce((s, c) => s + (c.value || 0), 0);
  let totalsBlock;
  if (canSeeContainerValues(userId)) {
    totalsBlock = `💰 *Total: ${totBales} bls · ${fmtQty(totYards)} yds · ${fmtMoney(totValue)}*\n\n`
      + list.map((c) => `· ${c.label}: ${fmtQty(c.yards || 0)} yds · ${fmtMoney(c.value || 0)}`).join('\n')
      + '\n';
  } else {
    totalsBlock = `Total: ${totBales} bls · ${fmtQty(totYards)} yds\n`;
  }
  await editOrSendAnchored(bot, chatId, userId,
    `📦 *Supply Request*\n🚢 Container: *${safeBatch}*\n${totalsBlock}\nSelect category:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

/**
 * SRF-CAT — after a container is chosen, advance to the category step.
 * Auto-skips (straight to warehouse) when the container holds a single
 * category, so the flow feels exactly like before when there is no choice.
 */
async function proceedAfterContainerToCategory(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const cats = await getSupplyCategories(session.arrivalBatch, session._scopeWarehouses);
  if (!cats.length) {
    await editOrSendAnchored(bot, chatId, userId, '⚠️ No available stock in this container.', { parse_mode: 'Markdown' });
    return;
  }
  if (cats.length === 1) {
    session.category = cats[0].category;
    session.categoryStepShown = false;
    session.step = 'warehouse';
    sessionStore.set(userId, session);
    await proceedAfterContainer(bot, chatId, userId);
    return;
  }
  session.categoryStepShown = true;
  session.step = 'category';
  sessionStore.set(userId, session);
  await showSupplyCategoryPicker(bot, chatId, userId, cats);
}

/**
 * After a container (and SRF-CAT category) is chosen, advance to the
 * warehouse step: auto-skip to the design picker when exactly one warehouse
 * has matching stock, otherwise render the warehouse picker.
 */
async function proceedAfterContainer(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const warehouses = await getSupplyWarehouses(session.arrivalBatch, session._scopeWarehouses, session.category);
  if (!warehouses.length) {
    await editOrSendAnchored(bot, chatId, userId, '⚠️ No available stock in this container.', { parse_mode: 'Markdown' });
    return;
  }
  if (warehouses.length === 1) {
    session.warehouse = warehouses[0];
    session.multiWarehouse = false;
    session.step = 'design';
    sessionStore.set(userId, session);
    await showDesignsForWarehouse(bot, chatId, userId, warehouses[0], session.flowMessageId);
    return;
  }
  session.multiWarehouse = true;
  session.step = 'warehouse';
  sessionStore.set(userId, session);
  const rows = warehouses.map((w) => [{ text: `🏭 ${w}`, callback_data: `srf_wh:${w}` }]);
  rows.push([{
    text: session.categoryStepShown ? '⬅️ Back to categories' : '⬅️ Back to containers',
    callback_data: session.categoryStepShown ? 'srf_back:category' : 'srf_back:container',
  }]);
  const safeBatch = String(session.arrivalBatch).replace(/[*_`[\]]/g, '\\$&');
  const catLabel = supplyCategoryLabel(session.category);
  const catLine = catLabel
    ? `\n${session.category === SUPPLY_OTHERS_CATEGORY ? '📦' : designCategoriesRepo.iconFor(catLabel)} Category: *${catLabel.replace(/[*_`[\]]/g, '\\$&')}*`
    : '';
  await editOrSendAnchored(bot, chatId, userId,
    `📦 *Supply Request*\n🚢 Container: *${safeBatch}*${catLine}\n\nSelect warehouse:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function showDesignsForWarehouse(bot, chatId, userId, warehouse, messageId = null) {
  const session = sessionStore.get(userId);
  const cart = session ? session.cart || [] : [];
  const avail = await getAdjustedAvailability(warehouse, cart, session && session.arrivalBatch, session && session.category);

  const designAgg = new Map();
  let detectedType = 'fabric';
  for (const a of avail) {
    if (!designAgg.has(a.design)) designAgg.set(a.design, { design: a.design, totalPkgs: 0, totalThans: 0 });
    designAgg.get(a.design).totalPkgs += a.availPkgs;
    designAgg.get(a.design).totalThans += a.availThans || 0;
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
  // TV-1 — warehouses flagged in Settings list stock by than (subunit),
  // not bale. Display-only: selection + cart semantics stay in bales.
  const useThans = await unitDisplayService.isThanVisibilityWarehouse(warehouse);
  const designTag = (d) => (useThans
    ? `${d.totalThans} ${productTypesRepo.pluralize(labels.subunit_label, d.totalThans).toLowerCase()}`
    : `${d.totalPkgs} ${cShort}`);
  const MAX_VISIBLE = 8;
  const page = (session && session.designPage) || 0;
  const start = page * MAX_VISIBLE;
  const visible = designs.slice(start, start + MAX_VISIBLE);
  const rows = [];
  for (let i = 0; i < visible.length; i += 2) {
    const row = [{ text: `${visible[i].design} (${designTag(visible[i])})`, callback_data: `srf_dg:${visible[i].design}` }];
    if (visible[i + 1]) row.push({ text: `${visible[i + 1].design} (${designTag(visible[i + 1])})`, callback_data: `srf_dg:${visible[i + 1].design}` });
    rows.push(row);
  }
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: 'srf_dgpg:prev' });
  if (start + MAX_VISIBLE < designs.length) nav.push({ text: `More (${designs.length - start - MAX_VISIBLE}) ➡️`, callback_data: 'srf_dgpg:next' });
  if (nav.length) rows.push(nav);
  // Navigation footer: the design picker is reachable as the first
  // interactive step (single-warehouse user), after picking a warehouse
  // (multi-warehouse), or via "Add More" with items already in the cart.
  // Offer the right "back" target for each case and always a Cancel so the
  // user is never stranded on a one-way screen.
  const backRow = [];
  if (cart.length) {
    backRow.push({ text: '⬅️ Back to cart', callback_data: 'srf_back:cart' });
  } else if (session && session.multiWarehouse) {
    backRow.push({ text: '⬅️ Back to warehouses', callback_data: 'srf_back:warehouse' });
  } else if (session && session.categoryStepShown) {
    // SRF-CAT — single-warehouse category: the previous screen was the
    // Select Category step, not the container list.
    backRow.push({ text: '⬅️ Back to categories', callback_data: 'srf_back:category' });
  } else {
    // Single-warehouse container: no warehouse step to return to, so the
    // back target is the Select Container step (ARRIVAL-BATCH C1).
    backRow.push({ text: '⬅️ Back to containers', callback_data: 'srf_back:container' });
  }
  backRow.push({ text: '❌ Cancel', callback_data: 'srf_cart:cancel' });
  rows.push(backRow);
  const cartNote = cart.length ? `\n🛒 Cart: ${cart.length} item(s)` : '';
  const pageNote = designs.length > MAX_VISIBLE ? ` (${start + 1}–${Math.min(start + MAX_VISIBLE, designs.length)} of ${designs.length})` : '';
  // WH-SUM — warehouse totals under the header: unit total for everyone
  // (thans on TV-1 warehouses, bales elsewhere); stock value admin-only.
  const totalUnits = avail.reduce((s, a) => s + (useThans ? (a.availThans || 0) : a.availPkgs), 0);
  const unitWord = productTypesRepo.pluralize(useThans ? labels.subunit_label : labels.container_label, totalUnits).toLowerCase();
  let summaryNote = `\n📊 Total: ${fmtQty(totalUnits)} ${unitWord}`;
  if (config.access.adminIds.includes(String(userId))) {
    const totalValue = avail.reduce((s, a) => s + (a.availValue || 0), 0);
    summaryNote += ` · 💰 ${fmtMoneyShort(totalValue)}`;
  }
  const resolvedMsgId = messageId || (session && session.flowMessageId) || null;
  // SRF-CAT — surface the active category filter in the header so the user
  // always knows which slice of the warehouse they are browsing.
  const catLabel = supplyCategoryLabel(session && session.category);
  const catNote = catLabel
    ? ` · ${session.category === SUPPLY_OTHERS_CATEGORY ? '📦' : designCategoriesRepo.iconFor(catLabel)} ${catLabel.replace(/[*_`[\]]/g, '\\$&')}`
    : '';
  const sent = await editOrSend(bot, chatId, resolvedMsgId,
    `📦 *Warehouse: ${warehouse}*${catNote}${summaryNote}${cartNote}\n\nSelect design:${pageNote}`, {
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
  const avail = await getAdjustedAvailability(warehouse, cart, session && session.arrivalBatch, session && session.category);
  const shades = avail.filter((a) => a.design === design).sort((a, b) => b.availPkgs - a.availPkgs);
  const labels = await productTypesRepo.getLabels(session?.productType || 'fabric');

  // Always start fresh: any prior preview/combo from another design is
  // stale once we render a new shade picker.
  await clearDesignPreview(bot, chatId, userId);

  if (!shades.length) {
    await editOrSendAnchored(bot, chatId, userId, `⚠️ No remaining stock for ${design} in ${warehouse}.`, {});
    if (cart.length) await showCartSummary(bot, chatId, userId);
    return;
  }

  // Load the catalog asset (if any) BEFORE the single-shade branch so
  // we can stamp the shade name onto the session no matter which path
  // we take. The shade name persists into every subsequent step
  // (quantity picker, cart, customer, …, admin notification) so the
  // user can still tell which color they picked once the photo bubble
  // is gone.
  let asset = null;
  let nameMap;
  try {
    asset = await designAssetsRepo.findActive(design);
    nameMap = buildShadeNameMap(asset);
  } catch (_) {
    nameMap = new Map();
  }

  if (shades.length === 1) {
    const s = shades[0];
    if (session && session.type === 'supply_req_flow') {
      session.currentDesign = design;
      session.currentShade = s.shade;
      session.currentShadeName = nameMap.get(String(s.shade)) || '';
      session.currentAvailPkgs = s.availPkgs;
      // Drives the quantity picker to show the catalog photo AND a
      // "Back to designs" button (there is no shade step to return to).
      session.singleShadeDesign = true;
      session.step = 'quantity';
      sessionStore.set(userId, session);
    }
    await showQuantityPicker(bot, chatId, userId, design, s.shade, warehouse, s.availPkgs, labels);
    return;
  }

  if (session && session.type === 'supply_req_flow') {
    session.currentDesign = design;
    session.singleShadeDesign = false;
    session.step = 'shade';
    sessionStore.set(userId, session);
  }
  const unit = {
    singular: labels.container_label.toLowerCase(),
    plural: productTypesRepo.pluralize(labels.container_label, 2).toLowerCase(),
  };
  // TV-1 — flagged warehouses show shade availability in thans (subunit).
  // Display-only: callback payloads, quantity picking and the cart stay
  // in bales exactly as before.
  const useThans = await unitDisplayService.isThanVisibilityWarehouse(warehouse);
  const dispUnit = useThans
    ? {
      singular: labels.subunit_label.toLowerCase(),
      plural: productTypesRepo.pluralize(labels.subunit_label, 2).toLowerCase(),
    }
    : unit;
  const dispQty = (s) => (useThans ? (s.availThans || 0) : s.availPkgs);

  const buttons = shades.map((s) => ({
    text: buildShadeLabel(s.shade, nameMap, dispQty(s), dispUnit),
    callback_data: `srf_sh:${design}|${s.shade}|${s.availPkgs}`,
  }));
  const rows = layoutShadeRows(buttons);
  // Bulk shortcut: take every shade of this design at its full remaining
  // quantity in one tap (cart-adjusted), instead of picking shade-by-shade.
  const totalBales = shades.reduce((sum, s) => sum + (s.availPkgs > 0 ? s.availPkgs : 0), 0);
  if (totalBales > 0) {
    const totalDisplay = useThans
      ? shades.reduce((sum, s) => sum + (s.availPkgs > 0 ? (s.availThans || 0) : 0), 0)
      : totalBales;
    const balesWord = totalDisplay === 1 ? dispUnit.singular : dispUnit.plural;
    rows.push([{
      text: `✅ Take ALL ${shades.length} shades (${totalDisplay} ${balesWord})`,
      callback_data: `srf_all:${design}`,
    }]);
  }
  rows.push([{ text: '⬅️ Back to designs', callback_data: 'srf_back:design' }]);

  // ── Path A: catalog photo exists → send a single photo+caption+buttons
  // message so the shade buttons sit directly under the image with no
  // separator text in between. We track its message_id on the session
  // (previewMessageId) so the next step can delete it cleanly. flowMessageId
  // is nulled because Telegram doesn't allow editMessageText on photo
  // messages — the next text-only step (quantity) will land as a fresh send
  // and re-anchor flowMessageId itself.
  let comboSent = null;
  if (asset && session) {
    try {
      const photoAsset = await designAssetsService.getPhotoForSend(design);
      if (photoAsset && photoAsset.photo) {
        comboSent = await bot.sendPhoto(chatId, photoAsset.photo, {
          caption: `📷 *${design}* — *${warehouse}*`,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: rows },
        });
        // Cache the Telegram file_id (best effort) so subsequent sends
        // for this design hit the fast path immediately.
        if (photoAsset.photoSource !== 'telegram_file_id' && comboSent && comboSent.photo && comboSent.photo.length) {
          const fid = comboSent.photo[comboSent.photo.length - 1].file_id;
          designAssetsService.cacheTelegramFileId(photoAsset.rowIndex, fid).catch(() => {});
        }
      }
    } catch (e) {
      logger.warn(`showShadesForDesign(${design}): photo+combo send failed, falling back to text picker — ${e.message}`);
      comboSent = null;
    }
  }

  if (comboSent && comboSent.message_id) {
    session.previewMessageId = comboSent.message_id;
    session.flowMessageId = null;
    sessionStore.set(userId, session);
    return;
  }

  // ── Path B: no catalog photo (or send failed) → text-only shade picker
  // edited in place, exactly as before.
  await editOrSendAnchored(bot, chatId, userId, `📦 *${design}* in *${warehouse}*\n\nSelect shade:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

async function showQuantityPicker(bot, chatId, userId, design, shade, warehouse, availPkgs, labelsOverride, opts = {}) {
  const labels = labelsOverride || await productTypesRepo.getLabels('fabric');
  const containerPlural = productTypesRepo.pluralize(labels.container_label, availPkgs).toLowerCase();
  const session = sessionStore.get(userId);
  // Look the name up by shade key on the active session — set when the
  // user tapped the shade combo (or when single-shade auto-pick fired
  // in showShadesForDesign). If the design has no catalog asset, this
  // is empty and the header degrades to plain "Shade: 3".
  const shadeRef = formatShadeRef(shade, session && session.currentShadeName);

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
  // Single-shade designs have no shade-selection step, so "Back to shades"
  // would just loop straight back to this same quantity page. Send them to
  // the design picker instead. Multi-shade designs keep "Back to shades".
  const singleShade = !!(session && session.singleShadeDesign);
  rows.push([singleShade
    ? { text: '⬅️ Back to designs', callback_data: 'srf_back:design' }
    : { text: '⬅️ Back to shades', callback_data: 'srf_back:shade' }]);

  const caption = `📦 *${design}* │ Shade: *${shadeRef}* │ 🏭 *${warehouse}*\n${availPkgs} ${containerPlural} available\n\nHow many ${containerPlural} to supply?`;

  // SINGLE-SHADE PHOTO PARITY: multi-shade designs show the catalog photo on
  // the shade picker (Path A in showShadesForDesign), but single-shade designs
  // skip that step and land straight here — leaving them photo-less. For a
  // single-shade design, render the quantity step as a photo+buttons combo so
  // it gets the same visual. Falls back to the text picker when there's no
  // catalog asset or the send fails.
  if (singleShade && session) {
    try {
      const photoAsset = await designAssetsService.getPhotoForSend(design);
      if (photoAsset && photoAsset.photo) {
        await clearDesignPreview(bot, chatId, userId);
        const sent = await bot.sendPhoto(chatId, photoAsset.photo, {
          caption,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: rows },
        });
        if (photoAsset.photoSource !== 'telegram_file_id' && sent && sent.photo && sent.photo.length) {
          const fid = sent.photo[sent.photo.length - 1].file_id;
          designAssetsService.cacheTelegramFileId(photoAsset.rowIndex, fid).catch(() => {});
        }
        if (sent && sent.message_id) {
          session.previewMessageId = sent.message_id;
          session.flowMessageId = null;
          sessionStore.set(userId, session);
          return;
        }
      }
    } catch (e) {
      logger.warn(`showQuantityPicker(${design}): photo combo failed, text fallback — ${e.message}`);
    }
  }

  await editOrSendAnchored(bot, chatId, userId, caption, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

function addToCart(session, design, shade, quantity) {
  if (!session.cart) session.cart = [];
  // Capture the shade name (from session.currentShadeName, set when the
  // shade was picked) on every cart line. This is what lets cart text,
  // confirmation summaries, and admin notifications all show the shade
  // color even though the photo bubble is no longer in the chat.
  const shadeName = (session.currentShadeName || '').trim();
  const existing = session.cart.find((c) => c.design === design && c.shade === shade);
  if (existing) {
    existing.quantity += quantity;
    if (!existing.shadeName && shadeName) existing.shadeName = shadeName;
  } else {
    session.cart.push({ design, shade, shadeName, quantity });
  }
}

async function buildCartText(session) {
  const cart = session.cart || [];
  if (!cart.length) return '🛒 Cart is empty.';
  const labels = await productTypesRepo.getLabels(session.productType || 'fabric');
  const cShort = labels.container_short;
  // SRF-UX: shades of one design fold into a single line.
  const lines = cartFormat.formatCartLines(cart.map((c) => {
    const m = getMaterialInfo(c.design);
    return { icon: m.icon, design: c.design, name: m.name, shadeRef: formatShadeRef(c.shade, c.shadeName), quantity: c.quantity };
  }), cShort);
  const total = cart.reduce((s, c) => s + c.quantity, 0);
  const containerPlural = productTypesRepo.pluralize(labels.container_label, total).toLowerCase();
  return `🛒 *Supply Cart* — 🏭 ${session.warehouse}\n━━━━━━━━━━━━━━━━━━━━━━\n${lines.join('\n')}\n━━━━━━━━━━━━━━━━━━━━━━\n📦 Total: ${total} ${containerPlural}`;
}

/**
 * Minimalist cart view for the Transfer handoff: design shown once as a
 * header, shades folded into bullet lines, total in the header. Distinct from
 * buildCartText (the supply-checkout view) so the supply flow is untouched.
 * @param {object} session supply_req_flow session with a `cart`
 * @returns {Promise<string>} Markdown text
 */
async function buildTransferCartText(session) {
  const cart = session.cart || [];
  if (!cart.length) return '🚚 Transfer cart is empty.';
  const labels = await productTypesRepo.getLabels(session.productType || 'fabric');
  const total = cart.reduce((s, c) => s + c.quantity, 0);
  const balesPlural = productTypesRepo.pluralize(labels.container_label, total).toLowerCase();
  const byDesign = new Map();
  for (const c of cart) {
    if (!byDesign.has(c.design)) byDesign.set(c.design, []);
    byDesign.get(c.design).push(c);
  }
  const blocks = [];
  for (const [design, items] of byDesign) {
    const m = getMaterialInfo(design);
    const head = `${m.icon} *${design}* ${m.name}`.trimEnd();
    const bullets = items.map((c) => ` • ${formatShadeRef(c.shade, c.shadeName)} ×${c.quantity}`);
    blocks.push([head, ...bullets].join('\n'));
  }
  return `🚚 *Transfer Cart* · 🏭 ${session.warehouse} · ${total} ${balesPlural}\n\n${blocks.join('\n\n')}`;
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
  // Admin-only handoff into the TRF-2 transfer wizard (prefilled from cart).
  if (auth.isAdmin(String(userId))) {
    rows.splice(1, 0, [{ text: '🚚 Transfer', callback_data: 'srf_cart:transfer' }]);
  }
  await editOrSendAnchored(bot, chatId, userId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
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

  const allCust = await customersRepo.getAll();
  const active = allCust.filter((c) => (c.status || 'Active').toLowerCase() === 'active');
  const activeNames = new Set(active.map((c) => c.name));

  const topBuyers = await getTopBuyersForDesigns(cartDesigns);
  const suggested = topBuyers.filter((n) => activeNames.has(n)).slice(0, 6);
  const suggestedSet = new Set(suggested);

  const rows = [];
  if (suggested.length) {
    const designLabel = cartDesigns.length <= 3 ? cartDesigns.join(', ') : `${cartDesigns.length} designs`;
    const headerText = `👤 Select customer:\n━━━━━━━━━━━━━━━━━━━━━━\n⭐ *Top buyers of ${designLabel}:*`;
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
    rows.push([{ text: '⬅️ Back to cart', callback_data: 'srf_back:cart' }]);
    await editOrSendAnchored(bot, chatId, userId, headerText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  } else {
    for (let i = 0; i < active.length; i += 2) {
      const row = [{ text: `👤 ${active[i].name}`, callback_data: `srf_cu:${active[i].name}` }];
      if (active[i + 1]) row.push({ text: `👤 ${active[i + 1].name}`, callback_data: `srf_cu:${active[i + 1].name}` });
      rows.push(row);
    }
    rows.push([{ text: '➕ Add New Customer', callback_data: 'srf_cu:__new__' }]);
    rows.push([{ text: '⬅️ Back to cart', callback_data: 'srf_back:cart' }]);
    await editOrSendAnchored(bot, chatId, userId, '👤 Select customer:', { reply_markup: { inline_keyboard: rows } });
  }
}

async function showSupplySalespersonPicker(bot, chatId, userId, showAll = false) {
  const allUsers = await usersRepository.getAll();
  const adminIds = new Set(config.access.adminIds || []);
  const salesUsers = allUsers.filter((u) => {
    if (u.status && u.status !== 'active') return false;
    if (adminIds.has(u.user_id)) return true;
    return usersRepository.inDepartment(u, 'Sales');
  });
  if (!salesUsers.length) {
    await editOrSendAnchored(bot, chatId, userId, '⚠️ No salespersons found. Please ask admin to assign users to the Sales department.');
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
  rows.push([{ text: '⬅️ Back to customer', callback_data: 'srf_back:customer' }]);
  await editOrSendAnchored(bot, chatId, userId, '🧑 Select salesperson (order collected by):', {
    reply_markup: { inline_keyboard: rows },
  });
}

async function showSupplyPaymentPicker(bot, chatId, userId) {
  const options = await salesFlow.getPaymentOptions();
  const rows = [];
  for (let i = 0; i < options.length; i += 3) {
    const row = [];
    for (let j = i; j < Math.min(i + 3, options.length); j++) {
      row.push({ text: `💳 ${options[j]}`, callback_data: `srf_pm:${options[j]}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '⬅️ Back to salesperson', callback_data: 'srf_back:salesperson' }]);
  await editOrSendAnchored(bot, chatId, userId, '💳 Select payment mode:', { reply_markup: { inline_keyboard: rows } });
}

async function showSupplyDatePicker(bot, chatId, userId) {
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
    [{ text: '⬅️ Back to payment', callback_data: 'srf_back:payment' }],
  ];
  return editOrSendAnchored(bot, chatId, userId, '📅 Select supply date:', { reply_markup: { inline_keyboard: rows } });
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

  await editOrSendAnchored(bot, chatId, userId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '⏭️ Skip (No receipt)', callback_data: 'srf_doc:skip' }, { text: '❌ Cancel', callback_data: 'srf_doc:cancel' }],
      [{ text: '⬅️ Back to date', callback_data: 'srf_back:date' }],
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

  await editOrSendAnchored(bot, chatId, userId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Confirm & Submit', callback_data: 'srf_conf:yes' }],
      [{ text: '⬅️ Back', callback_data: 'srf_back:document' }, { text: '❌ Cancel', callback_data: 'srf_conf:cancel' }],
    ] },
  });
}

/* ─── ADMIN CONTROLS ─── */

async function showUserManagement(bot, chatId) {
  const users = await usersRepository.getAll();
  let text = '👥 *User Management*\n\n';
  for (const u of users) {
    const depts = (Array.isArray(u.departments) && u.departments.length)
      ? u.departments.join(', ')
      : (u.department || '-');
    const wh = u.warehouses.length ? u.warehouses.join(', ') : '-';
    text += `• *${u.name || u.user_id}* (${u.user_id})\n  Depts: ${depts} | Warehouses: ${wh}\n`;
  }
  text += '\nSelect action:';
  await sendLong(bot, chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🏢 Assign Department', callback_data: 'adm:assign_dept' }],
      [{ text: '🏭 Assign Warehouses', callback_data: 'adm:assign_wh' }],
      [{ text: '🎚 Change Role', callback_data: 'rol:start' }],
      [{ text: '➕ Add New User', callback_data: 'adm:add_user' }],
    ] },
  });
}

/**
 * Start a sale flow: collect all required fields, then show summary for confirmation.
 */
async function startSaleFlow(bot, chatId, msg, userId, saleType, items, intent) {
  // ST-1 migration (owner mandate 14-Jul): typed sale commands now route
  // into the tappable 💰 Sell Bale flow — chips for customer, salesperson,
  // bank and date eliminate the typo class entirely (TRF-5 pattern).
  await bot.sendMessage(chatId,
    '🛒 Sales now run through *💰 Sell Bale* — tap your way through container, bales, customer, bank and date. No more typos.',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💰 Open Sell Bale', callback_data: 'act:sell_bale' }]] } });
  return;
  // Typed path retained below for a fast rollback (delete the redirect
  // block above to restore it).
  // eslint-disable-next-line no-unreachable
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
  const sDate = details.salesDate || todayInLagos();

  // Date gating (Lagos TZ):
  //   future → block (those belong in Supply Request with scheduling)
  //   past   → force 2-admin approval even for admins, flag as BACKDATED
  //   today  → proceed as normal
  const cmp = compareWithToday(sDate);
  if (cmp > 0) {
    await bot.sendMessage(chatId,
      `⚠️ *Future-dated sales aren't allowed.* The sale date ${fmtDate(sDate)} is ahead of today (${fmtDate(todayInLagos())}).\n\nUse *Supply Request* for scheduled future deliveries.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }
  const isBackdated = cmp < 0;
  const daysBack = isBackdated ? daysBeforeToday(sDate) : 0;

  // Fix C — Validate cart at submit-time. Reject if ANY item can't be
  // resolved or has no available thans, so phantoms never enter the queue.
  const cartIssues = [];
  for (const item of session.items) {
    const info = await inventoryService.getPackageSummary(item.packageNo);
    if (!info) {
      cartIssues.push(`• Bale ${item.packageNo}: not found in inventory`);
      continue;
    }
    if (item.type === 'package') {
      if (!info.availableThans || info.availableThans < 1) {
        cartIssues.push(`• Bale ${item.packageNo}: already sold / no available thans`);
      }
    } else if (item.type === 'than') {
      const t = info.thans?.find((th) => th.thanNo === item.thanNo);
      if (!t) {
        cartIssues.push(`• Bale ${item.packageNo} Than ${item.thanNo}: than not found`);
      } else if (String(t.status || '').toLowerCase() !== 'available') {
        cartIssues.push(`• Bale ${item.packageNo} Than ${item.thanNo}: not available (${t.status || 'unknown'})`);
      }
    } else {
      cartIssues.push(`• Bale ${item.packageNo}: unknown item type "${item.type}"`);
    }
  }
  if (cartIssues.length) {
    await bot.sendMessage(chatId,
      `⚠️ *Cart has ${cartIssues.length} stale/invalid item${cartIssues.length > 1 ? 's' : ''}.* Submission blocked.\n\n${cartIssues.join('\n')}\n\nPlease remove these items and re-submit, or restart the sale.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const risk = await riskEvaluate.evaluate({ action: 'sell_batch', userId });
  const needsApproval = risk.risk === 'approval_required' || isBackdated;

  if (needsApproval) {
    // Create ONE approval request for the entire sale
    const requestId = genId();
    let detailText = `Sale Request\nCustomer: ${session.collected.customer}`;
    if (isBackdated) {
      detailText = `⚠️ BACKDATED — sale date is ${daysBack} day${daysBack === 1 ? '' : 's'} in the past. Verify the date and inventory are correct before approving.\n\n` + detailText;
    }
    try {
      const cust = await crmService.getCustomer(session.collected.customer);
      if (cust && (cust.phone || cust.address)) {
        if (cust.phone) detailText += `\nPhone: ${cust.phone}`;
        if (cust.address) detailText += `\nAddress: ${cust.address}`;
      }
    } catch (_) {}
    // Owner mandate 14-Jul: the approval card ALWAYS shows the canonical
    // DD-MMM-YYYY date regardless of how the requester typed it.
    detailText += `\nSalesperson: ${details.salesPerson}\nPayment: ${details.paymentMode}\nDate: ${fmtDate(sDate)}\n\nItems:\n`;
    // Fix A — count only items actually rendered; surface any phantom that
    // slipped through (defence-in-depth; Fix C should prevent this entirely).
    let totalYards = 0, totalThans = 0;
    const renderedPkgs = new Set();
    const phantomLines = [];
    // ST-1 Part B — per-design yardage snapshot so the enrichment "Paid in
    // full" chip can compute the sale total at approval time.
    const yardsByDesign = {};
    for (const item of session.items) {
      const info = await inventoryService.getPackageSummary(item.packageNo);
      if (item.type === 'package' && info) {
        detailText += `  Bale ${item.packageNo}: ${info.design} ${info.shade}, ${info.availableThans} thans, ${fmtQty(info.availableYards)} yds (${info.warehouse})\n`;
        totalThans += info.availableThans;
        totalYards += info.availableYards;
        yardsByDesign[info.design] = (yardsByDesign[info.design] || 0) + info.availableYards;
        renderedPkgs.add(item.packageNo);
      } else if (item.type === 'than' && info) {
        const t = info.thans?.find((th) => th.thanNo === item.thanNo);
        detailText += `  Bale ${item.packageNo} Than ${item.thanNo}: ${info.design} ${info.shade}, ${t ? fmtQty(t.yards) + ' yds' : '?'} (${info.warehouse})\n`;
        totalThans += 1;
        totalYards += t ? t.yards : 0;
        if (t) yardsByDesign[info.design] = (yardsByDesign[info.design] || 0) + t.yards;
        renderedPkgs.add(item.packageNo);
      } else {
        phantomLines.push(`  ⚠️ Bale ${item.packageNo}${item.type === 'than' ? ` Than ${item.thanNo}` : ''}: UNRESOLVED (skipped)`);
      }
    }
    const totalPkgs = renderedPkgs.size;
    detailText += `\nTotal: ${totalPkgs} Bale${totalPkgs === 1 ? '' : 's'} (${totalThans} thans), ${fmtQty(totalYards)} yards`;
    if (phantomLines.length) {
      detailText += `\n\n⚠️ ${phantomLines.length} item${phantomLines.length > 1 ? 's' : ''} could not be resolved and will NOT be applied:\n${phantomLines.join('\n')}`;
    }

    const saleDocInfo = session.sale_doc_file_id
      ? { sale_doc_file_id: session.sale_doc_file_id, sale_doc_type: session.sale_doc_type, sale_doc_mime: session.sale_doc_mime }
      : {};
    const backdatedNote = isBackdated ? `Backdated sale (${daysBack} day${daysBack === 1 ? '' : 's'} in past). ` : '';
    const effectiveRiskReason = backdatedNote + (risk.reason || (isBackdated ? 'All backdated sales require admin approval.' : 'All sale operations require admin approval.'));
    await approvalQueueRepository.append({
      requestId, user: userId,
      actionJSON: { action: 'sale_bundle', items: session.items, customer: session.collected.customer, salesDate: sDate, salesPerson: details.salesPerson, paymentMode: details.paymentMode, backdated: isBackdated, daysBack, totalYards, yardsByDesign, ...saleDocInfo },
      riskReason: effectiveRiskReason, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);

    const userLabel = await getRequesterDisplayName(userId, null);
    const isSubmitterAdmin = config.access.adminIds.includes(userId);
    const excludeId = isSubmitterAdmin ? userId : undefined;
    if (session.sale_doc_file_id) detailText += '\n📎 Sales bill attached (see below)';
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, detailText, effectiveRiskReason, excludeId);
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
    await bot.sendMessage(chatId, `⏳ Supply request submitted for ${approverLabel} approval. Request: ${requestId}\n${totalPkgs} Bale${totalPkgs === 1 ? '' : 's'} (${totalThans} thans), ${fmtQty(totalYards)} yards to ${session.collected.customer}`);
    sessionStore.clear(userId);
    return;
  }

  // Admin: execute all items directly in sequence. Fix B — track any items
  // that silently fail so the operator is told exactly what DID NOT apply.
  let soldThans = 0, totalYards = 0;
  const soldPkgs = new Set();
  const failedItems = [];
  for (const item of session.items) {
    if (item.type === 'package') {
      const result = await inventoryService.sellPackage(item.packageNo, session.collected.customer, userId, sDate);
      if (result.status === 'completed') { soldThans += result.soldThans; totalYards += result.soldYards; soldPkgs.add(item.packageNo); }
      else failedItems.push(`Bale ${item.packageNo}: ${result.status}${result.message ? ' — ' + result.message : ''}`);
    } else if (item.type === 'than') {
      const result = await inventoryService.sellThan(item.packageNo, item.thanNo, session.collected.customer, userId, sDate);
      if (result.status === 'completed') { soldThans += 1; totalYards += result.than?.yards || 0; soldPkgs.add(item.packageNo); }
      else failedItems.push(`Bale ${item.packageNo} Than ${item.thanNo}: ${result.status}${result.message ? ' — ' + result.message : ''}`);
    } else {
      failedItems.push(`Bale ${item.packageNo}: unknown item type "${item.type}"`);
    }
  }
  let saleMsg = `✅ Sale complete: ${soldPkgs.size} Bale${soldPkgs.size === 1 ? '' : 's'} (${soldThans} thans), ${fmtQty(totalYards)} yards to ${session.collected.customer}`;
  if (failedItems.length) {
    saleMsg += `\n\n⚠️ ${failedItems.length} of ${session.items.length} item${session.items.length > 1 ? 's' : ''} did NOT apply:\n${failedItems.map((l) => '  • ' + l).join('\n')}`;
  }
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
  rows.push([{ text: '❌ Cancel', callback_data: 'ocanc:1' }]);
  await bot.sendMessage(chatId, '📦 *Create Supply Order*\n\nSelect a design:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

// ── Flow-module callback routes ──────────────────────────────────────────
// Uniform delegation table for handleCallbackQuery: the first route whose
// prefix matches gets the callback; a truthy return means handled. Thunks
// keep the original lazy-require semantics. Inline/legacy branches (e.g.
// bulkrcv:mode:, pu:, the approval chain) stay in the dispatcher body.
// Register new flows HERE (one line) — see CLAUDE.md "Feature recipe".
const FLOW_CALLBACK_ROUTES = [
  // ST-1 — tappable Sell Bale flow.
  { prefixes: ['sb:'], handle: (bot, cq) => require('../flows/sellBaleFlow').handleCallback(bot, cq) },
  // Catalog hub: design assets / browse / search / catalog + CMS flows.
  { prefixes: ['dap:', 'dam:'], handle: (bot, cq) => handleDesignAssetCallback(bot, cq) },
  { prefixes: ['dav:'], handle: (bot, cq) => handleDesignAssetViewCallback(bot, cq) },
  { prefixes: ['dab:', 'das:', 'dat:'], handle: (bot, cq) => handleCatalogBrowseSearchCallback(bot, cq) },
  { prefixes: ['csf:', 'clf:', 'crf:', 'mkr:', 'ctr:'], handle: (bot, cq) => catalogFlows.handleCatalogFlowCallback(bot, cq) },
  { prefixes: ['cms:'], handle: (bot, cq) => catalogFlows.handleCmsCallback(bot, cq) },
  // Hubs + admin lenses.
  { prefixes: ['tsk:'], handle: (bot, cq) => taskFlow.handleCallback(bot, cq) },
  { prefixes: ['nf:'], handle: (bot, cq) => notificationsFlow.handleCallback(bot, cq) },
  { prefixes: ['swv:'], handle: (bot, cq) => salesWorkflowView.handleCallback(bot, cq) },
  { prefixes: ['pp:'], handle: (bot, cq) => procurementPlanView.handleCallback(bot, cq) },
  // Inbound stock flows.
  { prefixes: ['gr:'], handle: (bot, cq) => goodsReceiptFlow.handleCallback(bot, cq) },
  { prefixes: ['br:'], handle: (bot, cq) => bulkReceiveFlow.handleCallback(bot, cq) },
  { prefixes: ['addstock:'], handle: (bot, cq) => require('../flows/addStockFlow').handleCallback(bot, cq) },
  { prefixes: ['pr:'], handle: (bot, cq) => photoReceiveFlow.handleCallback(bot, cq) },
  // Warehouse / inventory flows.
  { prefixes: ['wh:'], handle: (bot, cq) => warehouseFlow.handleCallback(bot, cq) },
  { prefixes: ['lcost:'], handle: (bot, cq) => require('../flows/landedCostFlow').handleCallback(bot, cq) },
  { prefixes: ['bops:'], handle: (bot, cq) => require('../flows/dailyBranchOpsFlow').handleCallback(bot, cq) },
  { prefixes: ['ofex:'], handle: (bot, cq) => require('../flows/officeExpenseFlow').handleCallback(bot, cq) },
  { prefixes: ['bs:'], handle: (bot, cq) => require('../flows/bundleSaleFlow').handleCallback(bot, cq) },
  { prefixes: ['wai:'], handle: (bot, cq) => require('../flows/warehouseAuditFlow').handleCallback(bot, cq) },
  { prefixes: ['udf:'], handle: (bot, cq) => require('../flows/unitDisplayFlow').handleCallback(bot, cq) },
  { prefixes: ['trf:'], handle: (bot, cq) => require('../flows/transferFlow').handleCallback(bot, cq) },
  { prefixes: ['sbl:'], handle: (bot, cq) => require('../flows/soldBalesFlow').handleCallback(bot, cq) },
  // DCAT-1 — design → product-category mapping (dual-admin approval).
  { prefixes: ['dcat:'], handle: (bot, cq) => require('../flows/designCategoryFlow').handleCallback(bot, cq) },
  // MKT-2 — marketer allocations: admin flow + marketer category catalog.
  { prefixes: ['mal:'], handle: (bot, cq) => require('../flows/allocateMarketerFlow').handleCallback(bot, cq) },
  { prefixes: ['mkp:'], handle: (bot, cq) => require('../flows/marketerCatalogFlow').handleCallback(bot, cq) },
  // People / HR flows.
  { prefixes: ['usr:'], handle: (bot, cq) => require('../flows/userAddFlow').handleCallback(bot, cq) },
  { prefixes: ['umg:'], handle: (bot, cq) => require('../flows/userManageFlow').handleCallback(bot, cq) },
  { prefixes: ['rol:'], handle: (bot, cq) => require('../flows/roleEditFlow').handleCallback(bot, cq) },
  { prefixes: ['atd:'], handle: (bot, cq) => require('../flows/attendanceFlow').handleCallback(bot, cq) },
  { prefixes: ['atd_rpt:'], handle: (bot, cq) => require('../flows/attendanceReportFlow').handleCallback(bot, cq) },
  { prefixes: ['atd_adm:'], handle: (bot, cq) => require('../flows/attendanceAdminFlow').handleCallback(bot, cq) },
  // CNET-1b — contact network (category → buyers → people, recursive).
  { prefixes: ['cn:'], handle: (bot, cq) => require('../flows/contactNetworkFlow').handleCallback(bot, cq) },
  // MORN-1 — morning digest settings (admin-only).
  { prefixes: ['rmd:'], handle: (bot, cq) => require('../flows/morningDigestFlow').handleCallback(bot, cq) },
  // SNAP-1 — photo-to-sale (bale label OCR).
  { prefixes: ['sns:'], handle: (bot, cq) => require('../flows/snapSaleFlow').handleCallback(bot, cq) },
];

async function handleCallbackQuery(bot, callbackQuery) {
  const data = (callbackQuery.data || '').trim();

  // SEC-P1 (C2): global allow-list gate for button taps — the same boundary
  // handleMessage/handleFileMessage already enforce. Without it, a revoked or
  // never-approved user (or, on an unauthenticated webhook, a forged update)
  // could drive any flow callback below. Telegram lets clients send arbitrary
  // callback_data, so per-callback checks are defence-in-depth, not the fence;
  // this is the fence.
  const cbUserId = String(callbackQuery.from?.id || '');
  if (!auth.isAllowed(cbUserId)) {
    try {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'You are not authorized to use this bot.',
        show_alert: true,
      });
    } catch { /* stale callback id — nothing to answer */ }
    return;
  }
  // ANL-1 — every authorized tap (tiles, hubs, flow steps); no-op until enabled.
  usageTracker.trackCallback(cbUserId, data);

  // Uniform flow-module delegation (see FLOW_CALLBACK_ROUTES above). All
  // route prefixes are disjoint, so at most one route can match; an
  // unhandled match falls through to the legacy chain below, exactly as
  // the old per-prefix if-blocks did.
  for (const route of FLOW_CALLBACK_ROUTES) {
    if (route.prefixes.some((p) => data.startsWith(p))) {
      const handled = await route.handle(bot, callbackQuery);
      if (handled) return;
      break;
    }
  }

  // TCSI-2 (M1): Strict/Lenient mode sub-menu under the umbrella "Add Stock
  // (CSV)" tile. We delegate to the existing flow start() of the chosen
  // mode — no duplication, no upstream modification.
  if (data.startsWith('bulkrcv:mode:')) {
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const mode = data.slice('bulkrcv:mode:'.length);
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: callbackQuery.message.message_id,
    }).catch(() => {});
    if (mode === 'strict') {
      const addStockFlow = require('../flows/addStockFlow');
      await addStockFlow.start({ bot, chatId, userId: uid });
    } else if (mode === 'lenient') {
      await bulkReceiveFlow.start(bot, chatId, uid, callbackQuery.message.message_id);
    } else if (mode === 'back') {
      await bot.sendMessage(chatId, '↩️ Returned to menu. Type "Hi" to re-open the activity hub.');
    }
    return;
  }

  // USR-C2 — Pending user actions from the admin-feed notification card.
  //   pu:onboard:<telegramId>  → ack now; USR-C3 will route into Add Employee.
  //   pu:ignore:<telegramId>   → flip status=ignored, edit card to confirm.
  if (data.startsWith('pu:')) {
    const adminId = String(callbackQuery.from.id);
    if (!auth.isAdmin(adminId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.', show_alert: true });
      return;
    }
    const parts = data.split(':'); // pu, action, telegramId
    const action = parts[1];
    const targetId = parts[2] || '';
    const pendingUserService = require('../services/pendingUserService');
    if (action === 'ignore') {
      try { await pendingUserService.ignore(targetId, adminId); } catch (_) {}
      try {
        await bot.editMessageText(
          `🚫 *Ignored* — \`${targetId}\` will no longer prompt the admin feed.\n\n_Marked by_ ${adminId}`,
          { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown' },
        );
      } catch (_) {}
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Ignored.' });
      return;
    }
    if (action === 'onboard') {
      // USR-C3: launch the Add Employee flow with the PendingUser's
      // tg_id / name pre-filled. The flow validates and submits to the
      // dual-admin approval queue exactly like the cold-start path.
      try {
        const pendingUsersRepo = require('../repositories/pendingUsersRepository');
        const pu = await pendingUsersRepo.findByTelegramId(targetId);
        if (!pu) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'PendingUser row not found.', show_alert: true });
          return;
        }
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Opening onboarding flow…' });
        const userAddFlow = require('../flows/userAddFlow');
        await userAddFlow.start(bot, callbackQuery.message.chat.id, adminId,
          callbackQuery.message.message_id,
          {
            telegram_id: pu.telegram_id,
            first_name: pu.first_name,
            last_name: pu.last_name,
            username: pu.username,
            source: 'pending_user',
          });
      } catch (e) {
        try { require('../utils/logger').warn(`pu:onboard failed: ${e.message}`); } catch (_) {}
        await bot.answerCallbackQuery(callbackQuery.id, { text: `Failed: ${e.message}`, show_alert: true });
      }
      return;
    }
  }

  if (data.startsWith('enr:')) {
    // ST-1 Part B — tappable sale-enrichment chips (rate / payment / amount).
    await approvalEvents.handleEnrichmentCallback(bot, callbackQuery);
  } else if (data.startsWith('approve:')) {
    await approvalEvents.handleApprovalCallback(bot, callbackQuery, 'approve');
  } else if (data.startsWith('reject:')) {
    await approvalEvents.handleApprovalCallback(bot, callbackQuery, 'reject');
  } else if (data.startsWith('srf_assign:')) {
    await approvalEvents.handleSupplyAssign(bot, callbackQuery);
  } else if (data.startsWith('srf_acc:') || data.startsWith('srf_ack:')) {
    // srf_acc:  = new Stage-3 Accept button.
    // srf_ack:  = legacy Acknowledge button kept for back-compat with
    //             messages already in users' chats from before the
    //             Accept/Decline upgrade. handleSupplyAccept handles
    //             both prefixes.
    await approvalEvents.handleSupplyAccept(bot, callbackQuery);
  } else if (data.startsWith('srf_dec:')) {
    await approvalEvents.handleSupplyDecline(bot, callbackQuery);
  } else if (data.startsWith('smc:')) {
    // Stage 1 dispatch-manager confirm/reject/show-details.
    await approvalEvents.handleDispatchManagerCallback(bot, callbackQuery);
  } else if (data.startsWith('confirm_sale:')) {
    const saleUserId = data.replace('confirm_sale:', '');
    // SEC-P1 (C3): the pending sale session belongs to `saleUserId`, but the
    // id rode in on forgeable callback_data. Only the owner of that sale may
    // confirm it — otherwise any allowed user could execute (or, below,
    // cancel) another user's pending sale by guessing their Telegram id.
    if (String(callbackQuery.from.id) !== saleUserId) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'This confirmation is not yours to make.', show_alert: true });
      return;
    }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Processing sale...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id,
    });
    await executeSale(bot, callbackQuery.message.chat.id, saleUserId);
  } else if (data.startsWith('cancel_sale:')) {
    const cancelUserId = data.replace('cancel_sale:', '');
    // SEC-P1 (C3): same ownership check as confirm_sale — don't let one user
    // clear another user's pending-sale session.
    if (String(callbackQuery.from.id) !== cancelUserId) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'This action is not yours to make.', show_alert: true });
      return;
    }
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
      // Append a hub/menu footer unless the report already carries act: nav.
      const withInvFooter = (rows) => {
        const base = Array.isArray(rows) ? rows : [];
        const hasNav = base.some((r) => Array.isArray(r) && r.some((b) =>
          b && typeof b.callback_data === 'string' && b.callback_data.startsWith('act:')));
        return hasNav ? base : [...base, menuNav.hubAndMenuFooterRow('inventory', 'Inventory')];
      };
      if (!allItems.length) {
        await bot.sendMessage(callbackQuery.message.chat.id, 'No inventory data found.',
          { reply_markup: { inline_keyboard: withInvFooter([]) } });
        return;
      }
      const report = view === 'wh'
        ? buildInventoryWarehouseReport(allItems)
        : await buildInventoryDesignReport(allItems, { userId: uid });
      await sendLong(bot, callbackQuery.message.chat.id, report.text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: withInvFooter(report.keyboard ? report.keyboard.inline_keyboard : []) },
      });
    } catch (e) {
      logger.error('Inventory details error', e);
      await bot.sendMessage(callbackQuery.message.chat.id, `Report error: ${e.message}`,
        { reply_markup: { inline_keyboard: [menuNav.hubAndMenuFooterRow('inventory', 'Inventory')] } });
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
      const report = groupBy === 'design'
        ? buildSalesDesignReport(filtered, periodLabel, { periodKey: String(days) })
        : buildSalesCustomerReport(filtered, periodLabel, { periodKey: String(days) });
      await sendLong(bot, callbackQuery.message.chat.id, report.text, {
        parse_mode: 'Markdown',
        ...(report.keyboard ? { reply_markup: report.keyboard } : {}),
      });
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
    await maybeSendDesignPreview(bot, callbackQuery.message.chat.id, val, null, uid);
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

  } else if (data.startsWith('smb:')) {
    // Step-by-step Back inside the Give-Sample flow.
    //   smb:design   — re-show the design picker (first step). Clears all later state.
    //   smb:shade    — re-show shade picker.
    //   smb:customer — re-show customer picker.
    //   smb:quantity — re-show quantity picker.
    //   smb:type     — re-show type picker.
    //   smb:followup — re-show follow-up date picker.
    const target = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'sample_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);

    if (target === 'design') {
      delete session.design; delete session.shade; delete session.customer;
      delete session.quantity; delete session.sampleType; delete session.followupDate;
      session.step = 'design';
      sessionStore.set(uid, session);
      await showSampleDesignPicker(bot, chatId, uid);
    } else if (target === 'shade') {
      delete session.shade; delete session.customer;
      delete session.quantity; delete session.sampleType; delete session.followupDate;
      session.step = 'shade';
      sessionStore.set(uid, session);
      await showSampleShadePicker(bot, chatId, uid, session.design);
    } else if (target === 'customer') {
      delete session.customer; delete session.quantity;
      delete session.sampleType; delete session.followupDate;
      session.step = 'customer';
      sessionStore.set(uid, session);
      await showSampleCustomerPicker(bot, chatId, uid);
    } else if (target === 'quantity') {
      delete session.quantity; delete session.sampleType; delete session.followupDate;
      session.step = 'quantity';
      sessionStore.set(uid, session);
      await showSampleQuantityPicker(bot, chatId, uid);
    } else if (target === 'type') {
      delete session.sampleType; delete session.followupDate;
      session.step = 'type';
      sessionStore.set(uid, session);
      await showSampleTypePicker(bot, chatId, uid);
    } else if (target === 'followup') {
      delete session.followupDate;
      session.step = 'followup';
      sessionStore.set(uid, session);
      await showSampleFollowupPicker(bot, chatId, uid);
    }

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

  // P3 — Quick Add fast path (admin-only). Swaps the session into quick_add
  // step which expects "Name, Phone, [Address]" as a single text reply.
  } else if (data.startsWith('acquick:')) {
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    if (!config.access.adminIds.includes(uid)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' });
      return;
    }
    await bot.answerCallbackQuery(callbackQuery.id);
    await startAddCustomerQuickAdd(bot, chatId, uid);

  } else if (data.startsWith('acb:')) {
    // Step-by-step Back inside the Add-Customer flow.
    // The session step name matches each picker; we just rewind the
    // step pointer + clear later fields, then re-render.
    const target = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'add_customer_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);

    // Wipe any field captured AT or AFTER the target step so the user
    // genuinely re-answers from there. Order: name, phone, address,
    // category, credit, terms, notes.
    const order = ['name', 'phone', 'address', 'category', 'credit', 'terms', 'notes'];
    const idx = order.indexOf(target);
    if (idx >= 0) {
      for (let i = idx; i < order.length; i++) {
        const f = order[i];
        if (f === 'name') delete session.name;
        else if (f === 'phone') delete session.phone;
        else if (f === 'address') delete session.address;
        else if (f === 'category') delete session.category;
        else if (f === 'credit') delete session.credit_limit;
        else if (f === 'terms') delete session.payment_terms;
        else if (f === 'notes') delete session.notes;
      }
    }
    session.step = target;
    sessionStore.set(uid, session);

    if (target === 'name') {
      // Restart from the entry screen. _acRender shows the prompt and
      // a Cancel button; name itself is captured via free text.
      await _acRender(bot, chatId, uid, 'Enter the customer *full name* (reply in chat):',
        [[{ text: '❌ Cancel', callback_data: 'accanc:0' }]]);
    } else if (target === 'phone') {
      await showAddCustomerPhoneStep(bot, chatId, uid);
    } else if (target === 'address') {
      await showAddCustomerAddressStep(bot, chatId, uid);
    } else if (target === 'category') {
      await showAddCustomerCategoryPicker(bot, chatId, uid);
    } else if (target === 'credit') {
      await showAddCustomerCreditPicker(bot, chatId, uid);
    } else if (target === 'terms') {
      await showAddCustomerPaymentTermsStep(bot, chatId, uid);
    } else if (target === 'notes') {
      await showAddCustomerNotesStep(bot, chatId, uid);
    }

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
      riskReason: 'New customer requires admin approval',
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

  } else if (data.startsWith('upb:')) {
    // Step-by-step Back inside the Update-Price flow.
    //   upb:design — re-show the design picker (clears all later state).
    //   upb:shade  — re-show the shade picker (clears nudge/newPrice).
    //   upb:nudge  — re-show the nudge/custom-price picker (clears newPrice).
    const target = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'update_price_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);

    if (target === 'design') {
      delete session.design;
      delete session.shade;
      delete session.currentPrice;
      delete session.newPrice;
      session.step = 'design';
      sessionStore.set(uid, session);
      await startUpdatePriceFlow(bot, chatId, uid, session.flowMessageId);
    } else if (target === 'shade') {
      delete session.shade;
      delete session.currentPrice;
      delete session.newPrice;
      session.step = 'shade';
      sessionStore.set(uid, session);
      await showUpdatePriceShadePicker(bot, chatId, uid);
    } else if (target === 'nudge') {
      delete session.newPrice;
      session.step = 'nudge';
      sessionStore.set(uid, session);
      await showUpdatePriceNudgePicker(bot, chatId, uid);
    }

  } else if (data.startsWith('upd:')) {
    const design = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'update_price_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    session.design = design;
    session.step = 'shade';
    sessionStore.set(uid, session);
    // PRICE-VIS-C1 — sample photo guardrail. maybeSendDesignPreview returns
    // false when no active DesignAssets card exists, in which case we warn
    // (non-blocking) at the next step rather than silently letting the
    // admin re-price the wrong batch.
    const preview = await maybeSendDesignPreview(bot, callbackQuery.message.chat.id, design, null, uid);
    const refreshed = sessionStore.get(uid) || session;
    refreshed.sampleOnFile = !!preview;
    sessionStore.set(uid, refreshed);
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
        { chat_id: chatId, message_id: session.flowMessageId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [menuNav.hubAndMenuFooterRow('finance', 'Finance')] } },
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
      await bot.editMessageText('❌ Transfer Bale cancelled.', {
        chat_id: callbackQuery.message.chat.id, message_id: session.flowMessageId,
      }).catch(() => {});
    }
    sessionStore.clear(uid);

  } else if (data.startsWith('tpb:')) {
    // Step-by-step Back inside the Transfer-Bale flow.
    //   tpb:package   — re-show the Bale picker (clears packageNo/toWh).
    //   tpb:warehouse — re-show warehouse picker (clears toWh).
    const target = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'transfer_package_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);

    if (target === 'package') {
      delete session.packageNo;
      delete session.toWh;
      delete session.fromWh;
      delete session.design;
      delete session.shade;
      delete session.availableThans;
      delete session.availableYards;
      session.step = 'package';
      sessionStore.set(uid, session);
      await startTransferPackageFlow(bot, chatId, uid, session.flowMessageId);
    } else if (target === 'warehouse') {
      delete session.toWh;
      session.step = 'warehouse';
      sessionStore.set(uid, session);
      await showTransferPackageWarehousePicker(bot, chatId, uid);
    }

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
      riskReason: 'Bale transfer requires admin approval', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: 'transfer_package', via: 'tap_flow' }, uid);
    if (session.flowMessageId) {
      await bot.editMessageText(
        `🚚 *Transfer Bale — submitted*\n\nBale: *${session.packageNo}*\n${session.fromWh} → *${session.toWh}*\n\n⏳ Waiting for admin approval.\nRequest: \`${requestId}\``,
        { chat_id: chatId, message_id: session.flowMessageId, parse_mode: 'Markdown' },
      ).catch(() => {});
    }
    const userLabel = await getRequesterDisplayName(uid, null);
    const summary = `Transfer Bale\nBale: ${session.packageNo}\nDesign: ${session.design || '?'} ${session.shade || ''}\nThans: ${session.availableThans} · Yards: ${fmtQty(session.availableYards)}\nFrom: ${session.fromWh}\nTo: ${session.toWh}`;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, 'Bale transfer requires admin approval');
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

  } else if (data.startsWith('ttb:')) {
    // Step-by-step Back inside the Transfer-Than flow.
    //   ttb:package   — re-show the Bale picker (clears all flow state below it).
    //   ttb:than      — re-show than picker (clears thanNo/toWh).
    //   ttb:warehouse — re-show warehouse picker (clears toWh).
    const target = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'transfer_than_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);

    if (target === 'package') {
      delete session.packageNo;
      delete session.thanNo;
      delete session.toWh;
      delete session.fromWh;
      delete session.design;
      delete session.shade;
      session.step = 'package';
      sessionStore.set(uid, session);
      await startTransferThanFlow(bot, chatId, uid, session.flowMessageId);
    } else if (target === 'than') {
      delete session.thanNo;
      delete session.toWh;
      session.step = 'than';
      sessionStore.set(uid, session);
      await showTransferThanThanPicker(bot, chatId, uid);
    } else if (target === 'warehouse') {
      delete session.toWh;
      session.step = 'warehouse';
      sessionStore.set(uid, session);
      await showTransferThanWarehousePicker(bot, chatId, uid);
    }

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
        `↔️ *Transfer Than — submitted*\n\nBale: *${session.packageNo}* · Than: *#${session.thanNo}*\n${session.fromWh} → *${session.toWh}*\n\n⏳ Waiting for admin approval.\nRequest: \`${requestId}\``,
        { chat_id: chatId, message_id: session.flowMessageId, parse_mode: 'Markdown' },
      ).catch(() => {});
    }
    const userLabel = await getRequesterDisplayName(uid, null);
    const summary = `Transfer Than\nBale: ${session.packageNo}\nThan: ${session.thanNo}\nDesign: ${session.design || '?'} ${session.shade || ''}\nFrom: ${session.fromWh}\nTo: ${session.toWh}`;
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

  } else if (data.startsWith('rtb:')) {
    // Step-by-step Back inside the Return-Than flow.
    //   rtb:package — re-show the Bale picker (clears the previously picked Bale + than).
    //   rtb:than    — re-show the than picker for the same Bale (clears thanNo).
    const target = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'return_than_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);

    if (target === 'package') {
      delete session.packageNo;
      delete session.thanNo;
      delete session.design;
      delete session.shade;
      session.step = 'package';
      sessionStore.set(uid, session);
      await startReturnThanFlow(bot, chatId, uid, session.flowMessageId);
    } else if (target === 'than') {
      delete session.thanNo;
      session.step = 'than';
      sessionStore.set(uid, session);
      await showReturnThanThanPicker(bot, chatId, uid);
    }

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
    // Returns require approval from a different admin than the requester.
    // Mirror the wording used by the NL path (requireApproval) so admin
    // requesters see "2nd admin" and employee requesters see "admin".
    const isAdm = config.access.adminIds.includes(uid);
    const approverLabel = isAdm ? '2nd admin' : 'admin';
    const riskReason = `All return operations require ${approverLabel} approval.`;
    const requestId = genId();
    await approvalQueueRepository.append({
      requestId, user: uid,
      actionJSON: { action: 'return_than', packageNo: session.packageNo, thanNo: session.thanNo },
      riskReason, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: 'return_than', via: 'tap_flow' }, uid);
    if (session.flowMessageId) {
      await bot.editMessageText(
        `↩️ *Return Than — submitted*\n\nBale: *${session.packageNo}* · Than: *#${session.thanNo}*\n\n⏳ Waiting for ${approverLabel} approval.\nRequest: \`${requestId}\``,
        { chat_id: chatId, message_id: session.flowMessageId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [menuNav.hubAndMenuFooterRow('stock_move', 'Move Stock')] } },
      ).catch(() => {});
    }
    const userLabel = await getRequesterDisplayName(uid, null);
    const summary = `Return Than\nBale: ${session.packageNo}\nThan: ${session.thanNo}\nDesign: ${session.design || '?'} ${session.shade || ''}`;
    // Exclude the requester from the broadcast so an admin can't approve
    // their own return request. The other admin(s) still get it.
    const excludeId = isAdm ? uid : undefined;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, userLabel, summary, riskReason, excludeId);
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
      await sendLong(bot, callbackQuery.message.chat.id, report.text, {
        parse_mode: 'Markdown',
        ...(report.keyboard ? { reply_markup: report.keyboard } : {}),
      });
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
      await sendLong(bot, callbackQuery.message.chat.id, report.text, {
        parse_mode: 'Markdown',
        ...(report.keyboard ? { reply_markup: report.keyboard } : {}),
      });
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
    await maybeSendDesignPreview(bot, callbackQuery.message.chat.id, design, null, uid);
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
    rows.push([
      { text: '⬅️ Back', callback_data: 'obb:design' },
      { text: '❌ Cancel', callback_data: 'ocanc:1' },
    ]);
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
            { text: '1 Bale',  callback_data: 'oq:1' },
            { text: '2 Bales', callback_data: 'oq:2' },
            { text: '5 Bales', callback_data: 'oq:5' },
            { text: '10 Bales', callback_data: 'oq:10' },
          ],
          [{ text: '✏️ Custom', callback_data: 'oq:__custom__' }],
          [
            { text: '⬅️ Back', callback_data: 'obb:customer' },
            { text: '❌ Cancel', callback_data: 'ocanc:1' },
          ],
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
      await bot.sendMessage(chatId, 'Enter custom quantity (number of Bales):');
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
      reply_markup: { inline_keyboard: [
        [{ text: '💰 PAID', callback_data: 'op:PAID' }, { text: '📝 UNPAID', callback_data: 'op:UNPAID' }],
        [
          { text: '⬅️ Back', callback_data: 'obb:salesperson' },
          { text: '❌ Cancel', callback_data: 'ocanc:1' },
        ],
      ] },
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
        [
          { text: '⬅️ Back', callback_data: 'obb:payment' },
          { text: '❌ Cancel', callback_data: 'ocanc:1' },
        ],
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
    // T2: notify admins that an order was proposed. The creator (uid) is
    // excluded so admins who created the order themselves don't get a
    // duplicate echo of what they just did.
    await adminFeed.notify(bot, 'order.created',
      `🆕 *New order proposed*\n\nOrder: *${saved.order_id}*\nDesign: ${session.design}\nCustomer: ${session.customer}\nQuantity: ${session.quantity}\nPayment: ${session.payment_status}\nScheduled: ${session.scheduled_date}\nSalesperson: ${session.salesperson_name}\n\n_Awaiting acceptance._`,
      { parse_mode: 'Markdown' }, { excludeUserId: uid });
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

  } else if (data.startsWith('obb:')) {
    // Step-by-step Back inside the Order-creation flow.
    // Order flow uses fresh sends for each step (no in-place edits), so
    // each Back tap simply rewinds session.step + clears later fields,
    // hides the current message's keyboard, and re-renders the prior
    // step as a new message.
    const target = data.slice(4);
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'order_flow') { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

    if (target === 'design') {
      delete session.design; delete session.customer;
      delete session.quantity; delete session.salesperson_id; delete session.salesperson_name;
      delete session.payment_status; delete session.scheduled_date;
      session.step = 'design';
      sessionStore.set(uid, session);
      await startOrderFlow(bot, chatId, uid);
    } else if (target === 'customer') {
      delete session.customer; delete session.quantity;
      delete session.salesperson_id; delete session.salesperson_name;
      delete session.payment_status; delete session.scheduled_date;
      session.step = 'customer';
      sessionStore.set(uid, session);
      // Re-render customer picker from scratch (mirrors `od:` branch).
      let customerNames = await transactionsRepo.getCustomersByDesign(session.design);
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
      rows.push([
        { text: '⬅️ Back', callback_data: 'obb:design' },
        { text: '❌ Cancel', callback_data: 'ocanc:1' },
      ]);
      await bot.sendMessage(chatId, `Design: *${session.design}*\n\nSelect customer (${label}):`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    } else if (target === 'quantity') {
      delete session.quantity; delete session.salesperson_id; delete session.salesperson_name;
      delete session.payment_status; delete session.scheduled_date;
      session.step = 'quantity';
      sessionStore.set(uid, session);
      await bot.sendMessage(chatId, `Customer: *${session.customer}*\n\nPick quantity:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [
            { text: '1 Bale',  callback_data: 'oq:1' },
            { text: '2 Bales', callback_data: 'oq:2' },
            { text: '5 Bales', callback_data: 'oq:5' },
            { text: '10 Bales', callback_data: 'oq:10' },
          ],
          [{ text: '✏️ Custom', callback_data: 'oq:__custom__' }],
          [
            { text: '⬅️ Back', callback_data: 'obb:customer' },
            { text: '❌ Cancel', callback_data: 'ocanc:1' },
          ],
        ] },
      });
    } else if (target === 'salesperson') {
      delete session.salesperson_id; delete session.salesperson_name;
      delete session.payment_status; delete session.scheduled_date;
      session.step = 'salesperson';
      sessionStore.set(uid, session);
      await showOrderSalespersonPicker(bot, chatId, uid);
    } else if (target === 'payment') {
      delete session.payment_status; delete session.scheduled_date;
      session.step = 'payment';
      sessionStore.set(uid, session);
      await bot.sendMessage(chatId, `Salesperson: *${session.salesperson_name}*\n\nPayment status:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '💰 PAID', callback_data: 'op:PAID' }, { text: '📝 UNPAID', callback_data: 'op:UNPAID' }],
          [
            { text: '⬅️ Back', callback_data: 'obb:salesperson' },
            { text: '❌ Cancel', callback_data: 'ocanc:1' },
          ],
        ] },
      });
    }

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
    await adminFeed.notify(bot, 'order.accepted',
      `✅ *${order.salesperson_name}* accepted order *${orderId}*\n\nDesign: ${order.design} | Customer: ${order.customer}\nQty: ${order.quantity} | Date: ${order.scheduled_date}`,
      { parse_mode: 'Markdown' });

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
    await adminFeed.notify(bot, 'order.delivered',
      `📦 Order *${orderId}* has been delivered.\n\nDesign: ${order.design}\nCustomer: ${order.customer}\nQty: ${order.quantity}\nDelivered by: ${order.salesperson_name}`,
      { parse_mode: 'Markdown' });

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

    // APU-1 3.5: the receipts pipeline previously wrote NO audit entries.
    await auditLogRepository.append('receipt_submitted',
      { receiptId, customer: session.customer, amount: session.amount, bank: session.bank_account }, uid);

    // BR-OPS C1 — pointer for the branch daily roll-up. Receipt rows
    // start in `pending` admin-approval, but the manager still wants
    // them visible in their "today's activity" panel immediately. The
    // pointer itself logs at submission time; the receipt's own
    // approval pipeline (rcapr:* / rcrej:*) is independent.
    try {
      const branchOpsService = require('../services/branchOpsService');
      await branchOpsService.logPointer({
        kind: 'receipt_logged', userId: uid,
        ref_id: receiptId,
        subject: `Receipt: ${session.customer} · ₦${(Number(session.amount) || 0).toLocaleString()}`,
        amount: Number(session.amount) || 0,
        notes: session.bank_account || '',
      });
    } catch (_) { /* swallowed in service */ }

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

  } else if (data.startsWith('rcapr:')) {
    const receiptId = data.slice(6);
    const adminId = String(callbackQuery.from.id);
    if (!config.access.adminIds.includes(adminId)) { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only admins can approve.' }); return; }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Approving receipt...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });

    const receipt = await receiptsRepo.getById(receiptId);
    if (!receipt) { await bot.sendMessage(callbackQuery.message.chat.id, `Receipt ${receiptId} not found.`); return; }
    if (receipt.status === 'approved') { await bot.sendMessage(callbackQuery.message.chat.id, `Receipt ${receiptId} already approved.`); return; }
    // APU-1 3.5: a rejected receipt could be approved later from any stale
    // admin card (rejected→approved flip). Decisions are final; re-upload.
    if (receipt.status === 'rejected') {
      await bot.sendMessage(callbackQuery.message.chat.id,
        `⚠️ Receipt ${receiptId} was already REJECTED — it cannot be approved from an old card. Ask ${receipt.uploaded_by_name || 'the uploader'} to submit it again.`);
      return;
    }
    // APU-1 3.5 (H1-parity): an admin may not approve their OWN receipt
    // while another admin exists to review it (mirrors the SEC-P1 guard
    // on the standard approve: pipeline).
    if (String(receipt.uploaded_by_id) === adminId && config.access.adminIds.filter((id) => id !== adminId).length) {
      await bot.sendMessage(callbackQuery.message.chat.id,
        `🚫 You uploaded receipt ${receiptId} yourself — a different admin must approve it.`);
      return;
    }

    try {
      const { buffer, filePath } = await downloadTelegramFile(bot, receipt.telegram_file_id);
      const ext = filePath.split('.').pop() || (receipt.file_type === 'document' ? 'pdf' : 'jpg');
      const fileName = `receipt_${receipt.customer.replace(/\s+/g, '_')}_${receiptId}.${ext}`;
      const mimeType = receipt.file_type === 'document' ? 'application/pdf' : 'image/jpeg';
      const { fileId: driveFileId, webViewLink } = await driveClient.uploadFile(buffer, fileName, mimeType);
      await receiptsRepo.updateDriveInfo(receiptId, driveFileId, webViewLink, adminId);
      await auditLogRepository.append('receipt_approved', { receiptId, customer: receipt.customer, amount: receipt.amount }, adminId);

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

    // APU-1 3.5: decisions are final — a decided receipt can't be
    // re-decided from a stale card, and (H1-parity) an admin can't reject
    // their own upload while another admin exists.
    const rcCheck = await receiptsRepo.getById(receiptId);
    if (!rcCheck) { await bot.sendMessage(callbackQuery.message.chat.id, `Receipt ${receiptId} not found.`); return; }
    if (rcCheck.status && rcCheck.status !== 'pending') {
      await bot.sendMessage(callbackQuery.message.chat.id, `Receipt ${receiptId} is already ${rcCheck.status} — no change made.`);
      return;
    }
    if (String(rcCheck.uploaded_by_id) === adminId && config.access.adminIds.filter((id) => id !== adminId).length) {
      await bot.sendMessage(callbackQuery.message.chat.id,
        `🚫 You uploaded receipt ${receiptId} yourself — a different admin must decide it.`);
      return;
    }

    await receiptsRepo.updateStatus(receiptId, 'rejected');
    await auditLogRepository.append('receipt_rejected', { receiptId, customer: rcCheck.customer, amount: rcCheck.amount }, adminId);
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

  /* ─── REPORT EXPAND (rxw:<reportType>[:payload]) ───────────────────────
   * Drill-down dispatcher for the compact reports. Each report ships
   * with top-N rows visible by default; tapping the inline "🔍 Show
   * all" button lands here and we re-run the underlying report builder
   * in expand mode. The new (longer) version is sent as a fresh
   * message — the original compact one stays in scrollback as a
   * concise reference.
   */
  } else if (data.startsWith('rxw:')) {
    // Callback grammar:  rxw:<reportType>:<payload>[::<flag>=<value>]
    // Flags currently supported:
    //   ::m=y / ::m=n  — Supply reports' "Show prices per row" toggle.
    // Older "::v=t|l" view-toggle suffix is gracefully ignored (kept
    // for compatibility with stale callbacks from earlier deploys).
    const rest = data.slice(4);
    const dblIdx = rest.indexOf('::');
    const head = dblIdx >= 0 ? rest.slice(0, dblIdx) : rest;
    const tail = dblIdx >= 0 ? rest.slice(dblIdx + 2) : '';
    const sepIdx = head.indexOf(':');
    const reportType = sepIdx >= 0 ? head.slice(0, sepIdx) : head;
    const payload = sepIdx >= 0 ? head.slice(sepIdx + 1) : '';
    let showRowMoney; // undefined → builder default (false)
    if (tail.startsWith('m=')) {
      const v = tail.slice(2);
      if (v === 'y') showRowMoney = true;
      else if (v === 'n') showRowMoney = false;
    }
    const isMoneyToggle = showRowMoney !== undefined;
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    const isAdminUser = config.access.adminIds.includes(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: isMoneyToggle ? 'Switching prices…' : 'Expanding…' });

    try {
      switch (reportType) {
        case 'inv_w': {
          const allItems = await inventoryRepository.getAll();
          const expanded = buildInventoryWarehouseReport(allItems, { expand: payload });
          await sendLong(bot, chatId, expanded.text, {
            parse_mode: 'Markdown',
            ...(expanded.keyboard ? { reply_markup: expanded.keyboard } : {}),
          });
          break;
        }
        case 'inv_d': {
          const allItems = await inventoryRepository.getAll();
          const expanded = await buildInventoryDesignReport(allItems, { expand: payload, userId: uid });
          await sendLong(bot, chatId, expanded.text, {
            parse_mode: 'Markdown',
            ...(expanded.keyboard ? { reply_markup: expanded.keyboard } : {}),
          });
          break;
        }
        case 'sales_d': {
          const days = parseInt(payload, 10) || 30;
          const allItems = await inventoryRepository.getAll();
          const sold = allItems.filter((r) => r.status === 'sold' && r.soldTo && r.soldDate);
          const filtered = filterSoldByPeriod(sold, days);
          const labels = { 7: 'Last 7 Days', 30: 'Last 30 Days', 90: 'Last 90 Days', 365: 'Last 365 Days' };
          const periodLabel = labels[days] || `Last ${days} Days`;
          const expanded = buildSalesDesignReport(filtered, periodLabel, { expand: true, periodKey: payload });
          await sendLong(bot, chatId, expanded.text, {
            parse_mode: 'Markdown',
            ...(expanded.keyboard ? { reply_markup: expanded.keyboard } : {}),
          });
          break;
        }
        case 'sales_c': {
          const pipe = payload.indexOf('|');
          const days = parseInt(pipe > 0 ? payload.slice(0, pipe) : payload, 10) || 30;
          const customer = pipe > 0 ? payload.slice(pipe + 1) : '';
          const allItems = await inventoryRepository.getAll();
          const sold = allItems.filter((r) => r.status === 'sold' && r.soldTo && r.soldDate);
          const filtered = filterSoldByPeriod(sold, days);
          const labels = { 7: 'Last 7 Days', 30: 'Last 30 Days', 90: 'Last 90 Days', 365: 'Last 365 Days' };
          const periodLabel = labels[days] || `Last ${days} Days`;
          const expanded = buildSalesCustomerReport(filtered, periodLabel, { expand: customer, periodKey: String(days) });
          await sendLong(bot, chatId, expanded.text, {
            parse_mode: 'Markdown',
            ...(expanded.keyboard ? { reply_markup: expanded.keyboard } : {}),
          });
          break;
        }
        case 'supply_c': {
          const sold = await getSoldItems();
          // Money-toggle taps want a fresh compact render, NOT a
          // group-expanded one — pass empty expand so the top-3 +
          // "Show all" UX is preserved.
          const expandArg = isMoneyToggle ? '' : payload;
          const expanded = buildCustomerWiseReport(sold, isAdminUser, { expand: expandArg, showRowMoney });
          await sendLong(bot, chatId, expanded.text, {
            parse_mode: 'Markdown',
            ...(expanded.keyboard ? { reply_markup: expanded.keyboard } : {}),
          });
          break;
        }
        case 'supply_w': {
          const sold = await getSoldItems();
          const expandArg = isMoneyToggle ? '' : payload;
          const expanded = buildWarehouseWiseReport(sold, isAdminUser, { expand: expandArg, showRowMoney });
          await sendLong(bot, chatId, expanded.text, {
            parse_mode: 'Markdown',
            ...(expanded.keyboard ? { reply_markup: expanded.keyboard } : {}),
          });
          break;
        }
        case 'supply_ds': {
          const sold = await getSoldItems();
          const expanded = buildDesignWiseReport(sold, isAdminUser, { showRowMoney });
          await sendLong(bot, chatId, expanded.text, {
            parse_mode: 'Markdown',
            ...(expanded.keyboard ? { reply_markup: expanded.keyboard } : {}),
          });
          break;
        }
        case 'supply_dd': {
          const sold = await getSoldItems();
          const expanded = buildDesignDateWiseReport(sold, isAdminUser, { showRowMoney });
          await sendLong(bot, chatId, expanded.text, {
            parse_mode: 'Markdown',
            ...(expanded.keyboard ? { reply_markup: expanded.keyboard } : {}),
          });
          break;
        }
        case 'hist': {
          await sendCustomerHistoryReport(bot, chatId, payload, { expand: true });
          break;
        }
        case 'pat': {
          await sendCustomerPatternReport(bot, chatId, payload, { expand: true });
          break;
        }
        case 'notes': {
          await sendCustomerNotesReport(bot, chatId, payload, { expand: true });
          break;
        }
        case 'rank': {
          const page = parseInt(payload, 10) || 0;
          await sendCustomerRankingReport(bot, chatId, { page });
          break;
        }
        default:
          await bot.sendMessage(chatId, `Unknown report drill-down: ${reportType}`);
      }
    } catch (e) {
      logger.error('rxw drill-down error', e);
      await bot.sendMessage(chatId, `Couldn't expand report: ${e.message}`);
    }

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

  /* ─── UNIFIED CUSTOMER DETAILS (cd:*) — M3 ─── */
  } else if (data.startsWith('cd:')) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);

    const rest = data.slice(3);

    if (rest === 'pk' || rest === 'pk:all') {
      await showCustomerDetailsPicker(bot, chatId, uid, messageId, rest === 'pk:all');
      return;
    }

    if (rest === 'rk' || rest.startsWith('rk:')) {
      if (!config.access.adminIds.includes(uid)) {
        await bot.sendMessage(chatId, 'Customer ranking is admin-only.');
        return;
      }
      const page = rest.startsWith('rk:') ? (parseInt(rest.slice(3), 10) || 0) : 0;
      const backFooter = [[{ text: '👤 Back to customer picker', callback_data: 'cd:pk' }]];
      await sendCustomerRankingReport(bot, chatId, {
        page,
        editMessageId: messageId,
        extraButtons: backFooter,
        pageCallbackPrefix: 'cd:rk',
      });
      return;
    }

    if (rest.startsWith('c:')) {
      const customerName = rest.slice(2);
      await renderCustomerCard(bot, chatId, messageId, customerName, 'h');
      return;
    }

    if (rest.startsWith('t:')) {
      const after = rest.slice(2);
      // tab is single char (h|p|n|a); the colon after it separates the name
      const sepIdx = after.indexOf(':');
      if (sepIdx < 0) return;
      const tab = after.slice(0, sepIdx);
      const customerName = after.slice(sepIdx + 1);
      if (tab === 'a') {
        // Reuse the existing add-note flow; it owns its own prompt + session.
        sessionStore.set(uid, { type: 'add_note_flow', step: 'note_text', customer: customerName });
        await editOrSend(bot, chatId, messageId,
          `✏️ *Add Note for ${customerName}*\n\nType the note (e.g. "prefers Shade 3", "wants bulk discount"):`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '⬅ Back to customer', callback_data: `cd:c:${customerName.slice(0, 60)}` }],
          ] } });
        return;
      }
      await renderCustomerCard(bot, chatId, messageId, customerName, tab);
      return;
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
    if (design === '__designs__') {
      await showDesignPickerForReport(bot, chatId, 'lpk', false, messageId);
      return;
    }
    await bot.editMessageReplyMarkup({ inline_keyboard: [] },
      { chat_id: chatId, message_id: messageId }).catch(() => {});
    await maybeSendDesignPreview(bot, chatId, design);
    await sendListPackagesReport(bot, chatId, design);

  /* ─── STOCK VALUE REPORT (Reports hub) ─── */
  } else if (data.startsWith('svr:')) {
    const uid = String(callbackQuery.from.id);
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    if (!pricingService.canSeeSalePrice(uid)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' });
      return;
    }
    await bot.answerCallbackQuery(callbackQuery.id);

    if (data === 'svr:cancel') {
      sessionStore.clear(uid);
      await bot.editMessageText('❌ Stock Value closed.', {
        chat_id: chatId, message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]] },
      }).catch(() => {});
      return;
    }

    if (data === 'svr:back') {
      const session = sessionStore.get(uid);
      const page = (session && session.type === 'stock_value') ? (session.page || 0) : 0;
      sessionStore.set(uid, { type: 'stock_value', step: 'list', page, flowMessageId: messageId });
      await renderStockValueList(bot, chatId, uid, page);
      return;
    }

    if (data.startsWith('svr:pg:')) {
      const page = parseInt(data.slice('svr:pg:'.length), 10) || 0;
      const session = sessionStore.get(uid);
      sessionStore.set(uid, {
        type: 'stock_value',
        step: 'list',
        page,
        flowMessageId: messageId || (session && session.flowMessageId) || null,
      });
      await renderStockValueList(bot, chatId, uid, page);
      return;
    }

    if (data.startsWith('svr:dg:')) {
      const design = data.slice('svr:dg:'.length);
      const session = sessionStore.get(uid);
      sessionStore.set(uid, {
        type: 'stock_value',
        step: 'design',
        page: session && session.page != null ? session.page : 0,
        drillDesign: design,
        flowMessageId: messageId,
      });
      await showStockValueDesign(bot, chatId, uid, design);
      return;
    }

  /* ─── CHECK STOCK: DESIGN PICK ─── */
  } else if (data.startsWith('cks:')) {
    const design = data.slice(4);
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    if (design === '__more__') {
      await showDesignPickerForReport(bot, chatId, 'cks', true, messageId);
      return;
    }
    if (design === '__designs__') {
      await showDesignPickerForReport(bot, chatId, 'cks', false, messageId);
      return;
    }
    await bot.editMessageReplyMarkup({ inline_keyboard: [] },
      { chat_id: chatId, message_id: messageId }).catch(() => {});
    await maybeSendDesignPreview(bot, chatId, design);
    await sendCheckStockReport(bot, chatId, design, uid);

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
        if (!orders.length) {
          await editOrSend(bot, chatId, messageId, 'You have no pending supply orders.', {
            reply_markup: { inline_keyboard: [menuNav.backToMenuRow()] },
          });
          break;
        }
        let out = '📋 *Your Supply Orders*\n\n';
        for (const o of orders) {
          const icon = o.status === 'accepted' ? '✅' : '⏳';
          out += `${icon} *${o.order_id}*\n  Design: ${o.design} | Customer: ${o.customer}\n  Qty: ${o.quantity} | Date: ${o.scheduled_date}\n  Payment: ${o.payment_status} | Status: ${o.status}\n\n`;
        }
        await sendLong(bot, chatId, out, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [menuNav.backToMenuRow()] },
        });
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
            menuNav.backToMenuRow(),
          ] },
        });
        break;
      case 'stock_value':
        if (!pricingService.canSeeSalePrice(uid)) {
          await bot.sendMessage(chatId, 'Stock Value is available to admins only.');
          break;
        }
        await startStockValueFlow(bot, chatId, uid, messageId);
        break;
      case 'my_products': {
        // MKT-1 — warehouse-scoped catalog for marketer/salesman. Salesman
        // also sees today's selling price; marketer sees quantities only.
        const u = await usersRepository.findByUserId(uid);
        // MKT-2 — marketers get the category-first, allocation-scoped view
        // (admin controls which designs + quantities they see). Salesman
        // and everyone else keep the classic warehouse catalog.
        if (fieldRoles.classify(u && u.role) === fieldRoles.MARKETER) {
          await require('../flows/marketerCatalogFlow').start(bot, chatId, uid, messageId);
          break;
        }
        const items = await inventoryRepository.getAll();
        const cat = fieldCatalog.buildCatalog(items, (u && u.warehouses) || [], {
          showPrice: fieldRoles.canSeePrice(u && u.role),
        });
        await sendLong(bot, chatId, cat.text, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [menuNav.backToMenuRow()] },
        });
        break;
      }
      case 'customer_details':
        await showCustomerDetailsPicker(bot, chatId, uid, messageId);
        break;
      // CNET-1b — 📇 Contact Network flow.
      case 'contact_network':
        await require('../flows/contactNetworkFlow').start(bot, chatId, uid, messageId);
        break;
      // MORN-1 — ⏰ Morning Digest settings (admin gate inside the flow).
      case 'morning_digest':
        await require('../flows/morningDigestFlow').start(bot, chatId, uid, messageId);
        break;
      // SNAP-1 — 📸 photo-to-sale.
      case 'snap_sale':
        await require('../flows/snapSaleFlow').start(bot, chatId, uid, messageId);
        break;
      // Legacy entry points — kept so text intents that still hit these
      // callbacks (older keyboards in a user's chat history, etc.) keep
      // working. New menus surface only `customer_details`.
      case 'customer_history':
      case 'customer_pattern':
      case 'customer_notes':
        await showCustomerDetailsPicker(bot, chatId, uid, messageId);
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
            [{ text: '⬅ Back to menu', callback_data: 'act:__back__' }],
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
            [{ text: '⬅ Back to menu', callback_data: 'act:__back__' }],
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
        await sendLong(bot, chatId, text, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [menuNav.backToMenuRow()] },
        });
        break;
      }
      case 'add_user': {
        // USR-C3: in-bot Add Employee flow. Admin-only entry; dual-admin
        // approval enforced at submit via ALWAYS_APPROVAL_ACTIONS.
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        const userAddFlow = require('../flows/userAddFlow');
        await userAddFlow.start(bot, chatId, uid, messageId);
        break;
      }
      case 'mark_attendance': {
        // ATT-C1: employee picks today's location. The flow itself
        // verifies the user is in ATTENDANCE_REQUIRED_USERS and renders
        // a polite gate message if not (so a curious admin tapping the
        // tile during testing gets a sensible screen).
        const attendanceFlow = require('../flows/attendanceFlow');
        await attendanceFlow.start(bot, chatId, uid, messageId);
        break;
      }
      case 'attendance_admin': {
        // ATT-C2: admin hub for attendance config + today view + mark-on-behalf.
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        const attendanceAdminFlow = require('../flows/attendanceAdminFlow');
        await attendanceAdminFlow.start(bot, chatId, uid, messageId);
        break;
      }
      case 'attendance_report': {
        // ATT-RPT-1: read-only Reports view (today + 7d/Week/Month + per-employee %).
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        const attendanceReportFlow = require('../flows/attendanceReportFlow');
        await attendanceReportFlow.start(bot, chatId, uid, messageId);
        break;
      }
      case 'add_warehouse': {
        // WH-C1: first-class entry into the standalone Add-Warehouse flow.
        // Admin-only gate matches the existing `add_warehouse` action's
        // dual-admin approval policy (the requester then still can't
        // self-approve at the queue stage).
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        await warehouseFlow.start(bot, chatId, uid, messageId);
        break;
      }
      case 'set_design_category': {
        // DCAT-1: design → product-category mapping. Admin-only entry;
        // the action itself sits in ALWAYS_APPROVAL_ACTIONS so a 2nd
        // admin must approve before the label goes live anywhere.
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        await require('../flows/designCategoryFlow').start(bot, chatId, uid, messageId);
        break;
      }
      case 'allocate_marketer': {
        // MKT-2: admin controls which designs (and how many bales) each
        // marketer sees in My Products. Direct admin write — no approval
        // queue — so allocation changes are instant during field testing.
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        await require('../flows/allocateMarketerFlow').start(bot, chatId, uid, messageId);
        break;
      }
      case 'finalize_landed_cost': {
        // LANDED-COST C1 — admin finalises USD cost / yard + container
        // charges for a GRN. Dual-admin gated at submit time (action in
        // ALWAYS_APPROVAL_ACTIONS); admin-only entry gate prevents
        // employees from even reaching the flow.
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        const landedCostFlow = require('../flows/landedCostFlow');
        await landedCostFlow.start(bot, chatId, uid, messageId);
        break;
      }
      case 'daily_branch_ops': {
        // BR-OPS C1 — branch manager's daily routine (camera check +
        // opening cash). No admin gate; per-user visibility is enforced
        // by the Departments.allowed_activities CSV at menu-render time.
        // The flow itself is idempotent — re-tapping after open just
        // shows the status panel.
        const dailyBranchOpsFlow = require('../flows/dailyBranchOpsFlow');
        await dailyBranchOpsFlow.start(bot, chatId, uid, messageId);
        break;
      }
      case 'sell_bale': {
        // ST-1 — fully tappable sale (container → bales → customer →
        // salesperson → bank → date), typo-free by construction. Hands off
        // to the proven sale pipeline (bill photo → approval → enrichment).
        const sellBaleFlow = require('../flows/sellBaleFlow');
        await sellBaleFlow.start(bot, chatId, uid);
        break;
      }
      case 'bundle_sale': {
        // BUNDLE-SALE C1 — Kano poly-colour design-first picker.
        // Reuses the dual-admin sale_bundle gate at submit, so any
        // employee with sell permission can launch it; the approval
        // queue still enforces 2nd-admin review.
        const bundleSaleFlow = require('../flows/bundleSaleFlow');
        await bundleSaleFlow.start(bot, chatId, uid, messageId);
        break;
      }
      case 'warehouse_audit': {
        // DBP-1.5 Concept A — admin-only tappable bale->than audit picker
        // (spec dbp-1.5-than-bale-allocation.md §9A). Read/inspect only;
        // no inventory writes. Admin gate mirrors other admin-only tiles.
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        const warehouseAuditFlow = require('../flows/warehouseAuditFlow');
        await warehouseAuditFlow.start(bot, chatId, uid, messageId);
        break;
      }
      case 'display_units': {
        // TV-2 — bales ⇄ thans display-unit switch. Admin/manager request
        // gate lives inside the flow; the change itself only applies after
        // admin approval (set_unit_display, ALWAYS_APPROVAL_ACTIONS).
        const unitDisplayFlow = require('../flows/unitDisplayFlow');
        await unitDisplayFlow.start(bot, chatId, uid, messageId);
        break;
      }
      case 'transfer_stock': {
        // TRF-2 — staged warehouse transfer wizard (admin-only gate lives
        // inside the flow; dispatcher/receiver chain is the control).
        const transferFlow = require('../flows/transferFlow');
        await transferFlow.start(bot, chatId, uid, messageId);
        break;
      }
      case 'transfers_view': {
        // TRF-2 — read-only open-transfers list.
        const transferFlow = require('../flows/transferFlow');
        await transferFlow.showList(bot, chatId, uid, messageId);
        break;
      }
      case 'sold_bales_lookup': {
        // SBL-1 — read-only sold-bale drill-down (customer → date → bale
        // detail). Visibility is via the Reporting hub; sale price/value
        // inside the flow is gated by pricingService.canSeeSalePrice, so
        // no admin gate here (non-price roles see quantities only).
        const soldBalesFlow = require('../flows/soldBalesFlow');
        await soldBalesFlow.start(bot, chatId, uid, messageId);
        break;
      }
      case 'office_expense': {
        // BR-OPS C1 — batch entry of office expenses. Single-admin
        // sign-off (record_office_expense ∈ WRITE_ACTIONS). Same
        // department-driven visibility model as daily_branch_ops.
        const officeExpenseFlow = require('../flows/officeExpenseFlow');
        await officeExpenseFlow.start(bot, chatId, uid, messageId);
        break;
      }
      case 'manage_wh': {
        if (!config.access.adminIds.includes(uid)) { await bot.sendMessage(chatId, 'Admin only.'); break; }
        // WH-C1: read the MERGED list (Inventory-derived ∪ WAREHOUSE_LIST)
        // so a warehouse the admin just added but hasn't yet received
        // into is still visible here. The old version read only
        // inventoryRepository.getWarehouses() and silently dropped names
        // that existed only in the settings CSV.
        const { raw: whs } = await warehouseFlow.listMergedWarehouses();
        let text = '🏭 *Warehouses*\n\n';
        if (whs.length === 0) {
          text += '_No warehouses registered yet._\nTap below to add one.\n';
        } else {
          for (const w of whs) text += `• ${w}\n`;
          text += '\nTo assign a warehouse to a user, use 👥 Manage Users.';
        }
        const rows = [
          [{ text: '➕ Add Warehouse', callback_data: 'act:add_warehouse' }],
          menuNav.backToMenuRow(),
        ];
        await editOrSend(bot, chatId, messageId, text, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: rows },
        });
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
      case 'transfer_than':
        // TRF-5 — legacy instant transfers retired: no dispatcher/receiver
        // chain, no in-transit stage, no photos. Redirect to Transfer Stock.
        await editOrSend(bot, chatId, messageId,
          '🚚 Warehouse transfers now go through *Transfer Stock* — the staged flow where the dispatcher logs the actual bales and the receiver confirms arrival.', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [{ text: '🚚 Open Transfer Stock', callback_data: 'act:transfer_stock' }],
              menuNav.backToMenuRow(),
            ] },
          });
        break;
      case 'return_than':
        await startReturnThanFlow(bot, chatId, uid, messageId);
        break;
      case 'add_customer':
        await startAddCustomerFlow(bot, chatId, uid, messageId);
        break;
      case 'upload_design_photo':
        await startDesignAssetUploadFlow(bot, chatId, uid);
        break;
      case 'manage_design_photos':
        await startManageDesignPhotos(bot, chatId, uid, messageId);
        break;
      case 'browse_catalog':
        await startBrowseCatalog(bot, chatId, uid, messageId);
        break;
      case 'search_design_photo':
        await startSearchDesignPhoto(bot, chatId, uid, messageId);
        break;
      case 'catalog_stats':
        await showCatalogStats(bot, chatId, uid, messageId);
        break;
      case 'supply_catalog':
        await catalogFlows.startSupplyCatalogFlow(bot, chatId, uid, messageId);
        break;
      case 'loan_catalog':
        await catalogFlows.startLoanCatalogFlow(bot, chatId, uid, messageId);
        break;
      case 'return_catalog':
        await catalogFlows.startReturnCatalogFlow(bot, chatId, uid, messageId);
        break;
      case 'register_marketer':
        await catalogFlows.startRegisterMarketerFlow(bot, chatId, uid, messageId);
        break;
      case 'catalog_tracker':
        await catalogFlows.startCatalogTracker(bot, chatId, uid, messageId);
        break;
      case 'manage_catalog_stock':
        await catalogFlows.startManageCatalogStock(bot, chatId, uid, messageId);
        break;
      // Task hub entries — delegate to taskFlow module.
      case 'assign_task':
        await taskFlow.startAssign(bot, chatId, uid, messageId);
        break;
      case 'my_tasks':
        await taskFlow.showMyTasks(bot, chatId, uid, messageId);
        break;
      case 'team_tasks':
        await taskFlow.showTeamTasks(bot, chatId, uid, messageId);
        break;
      case 'pending_signoff':
        await taskFlow.showPendingSignOff(bot, chatId, uid, messageId);
        break;
      case 'payouts':
        await taskFlow.showPayouts(bot, chatId, uid, messageId);
        break;
      case 'notifications':
        // T2 — per-admin opt-in/out toggles for the Admin Activity Feed.
        if (!config.access.adminIds.includes(uid)) {
          await bot.sendMessage(chatId, 'Notifications settings are admin-only.');
          break;
        }
        await notificationsFlow.renderToggleScreen(bot, chatId, uid, messageId);
        break;
      case 'sales_workflow':
        // T3 — admin read-only lens on the supply-order pipeline.
        if (!config.access.adminIds.includes(uid)) {
          await bot.sendMessage(chatId, 'Sales Workflow is admin-only.');
          break;
        }
        await salesWorkflowView.showSalesWorkflow(bot, chatId, uid, messageId);
        break;
      case 'receive_goods':
        // P2 — GRN flow. Admins execute directly; employees route through
        // admin approval (see WRITE_ACTIONS in risk/evaluate.js).
        await goodsReceiptFlow.start(bot, chatId, uid, messageId);
        break;
      case 'bulk_receive_goods':
        // TCSI-2: tile now opens a Strict/Lenient sub-menu so both modes
        // share one umbrella tile ("Add Stock (CSV)"). Each branch reuses
        // its own flow's start() — neither flow is modified here.
        await bot.sendMessage(chatId,
          '📦 *Add Stock (CSV) — choose mode*\n\n' +
          '🛡️ *Strict* — block if same bale # or design # already exists in the chosen warehouse. ' +
          'Recommended for normal restock.\n\n' +
          '🔄 *Lenient* — batch-aware (P2.5 original). Same bale # is welcomed as a new physical bale ' +
          'with its own `bale_uid`. Use when re-baling or re-importing legitimately.\n\n' +
          '_Both modes share the same dual-admin approval, file-hash idempotency, and audit trail._',
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [{ text: '🛡️ Strict (recommended)',     callback_data: 'bulkrcv:mode:strict' }],
              [{ text: '🔄 Lenient (batch-aware)',    callback_data: 'bulkrcv:mode:lenient' }],
              [{ text: '⬅️ Back',                     callback_data: 'bulkrcv:mode:back' }],
            ] },
          });
        break;
      case 'photo_receive_goods':
        // P5 — Photo Receive (image/PDF + OCR). Same dual-admin gate as
        // bulk_receive_goods; OCR is purely a capture mechanism, the
        // approval + persistence path is shared.
        await photoReceiveFlow.start(bot, chatId, uid, messageId);
        break;
      case 'procurement_plan':
        // P4 — admin Procurement Plan view (low-stock + open POs + new PO).
        if (!config.access.adminIds.includes(uid)) {
          await bot.sendMessage(chatId, 'Procurement Plan is admin-only.');
          break;
        }
        await procurementPlanView.showPlan(bot, chatId, uid, messageId);
        break;
      default:
        await bot.sendMessage(chatId, 'Feature coming soon.');
    }

  /* ─── SUPPLY REQUEST FLOW: CONTAINER (arrival batch) ─── */
  } else if (data.startsWith('srf_ct:')) {
    const batch = data.slice('srf_ct:'.length);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    let session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') {
      // Session expired mid-flow — rebuild a minimal one so the pick still works.
      session = { type: 'supply_req_flow', cart: [], _scopeWarehouses: [], flowMessageId: callbackQuery.message.message_id };
    }
    session.arrivalBatch = batch;
    // SRF-CAT — a new container invalidates any earlier category pick.
    delete session.category;
    delete session.categoryStepShown;
    session.step = 'category';
    session.flowMessageId = session.flowMessageId || callbackQuery.message.message_id;
    sessionStore.set(uid, session);
    await proceedAfterContainerToCategory(bot, chatId, uid);

  /* ─── SUPPLY REQUEST FLOW: CATEGORY (SRF-CAT) ─── */
  } else if (data.startsWith('srf_cg:')) {
    const cat = data.slice('srf_cg:'.length);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') {
      await bot.sendMessage(chatId, '⚠️ Session expired. Open 📦 Supply Request again.');
      return;
    }
    session.category = cat;
    session.categoryStepShown = true;
    session.step = 'warehouse';
    sessionStore.set(uid, session);
    await proceedAfterContainer(bot, chatId, uid);

  /* ─── SUPPLY REQUEST FLOW: WAREHOUSE ─── */
  } else if (data.startsWith('srf_wh:')) {
    const warehouse = data.slice(7);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    // Preserve the container choice (+ scope) made on the prior step; only
    // stamp the warehouse and advance. multiWarehouse stays true since the
    // user reached here from a warehouse list (design picker offers "Back
    // to warehouses").
    const session = sessionStore.get(uid) || { type: 'supply_req_flow', cart: [], arrivalBatch: '' };
    session.type = 'supply_req_flow';
    session.warehouse = warehouse;
    session.cart = session.cart || [];
    session.step = 'design';
    session.multiWarehouse = true;
    session.flowMessageId = session.flowMessageId || callbackQuery.message.message_id;
    sessionStore.set(uid, session);
    await showDesignsForWarehouse(bot, chatId, uid, warehouse, session.flowMessageId);

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

  /* ─── SUPPLY REQUEST FLOW: BACK NAVIGATION ─── */
  // One callback prefix `srf_back:<target>` covers every step. Each
  // branch resets the session step back, clears any partial selection
  // captured beyond that point, and re-renders the target picker via
  // editOrSendAnchored (which edits the current flow message in place).
  } else if (data.startsWith('srf_back:')) {
    const target = data.slice('srf_back:'.length);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') return;

    if (target === 'design') {
      session.step = 'design';
      delete session.currentDesign;
      delete session.currentShade;
      delete session.currentShadeName;
      delete session.currentAvailPkgs;
      sessionStore.set(uid, session);
      // The current preview photo (if any) is for the design we're
      // navigating away from — drop it so the design picker isn't
      // sitting under a stale photo.
      await clearDesignPreview(bot, chatId, uid);
      await showDesignsForWarehouse(bot, chatId, uid, session.warehouse);
    } else if (target === 'shade') {
      session.step = 'shade';
      delete session.currentShade;
      delete session.currentShadeName;
      delete session.currentAvailPkgs;
      // The currently-live message is the text quantity picker
      // (flowMessageId). Deleting it lets the new shade picker — which
      // is a fresh photo+buttons combo when a catalog asset exists —
      // take its place without leaving the quantity message stranded.
      if (session.flowMessageId) {
        await bot.deleteMessage(chatId, session.flowMessageId).catch(() => {});
        session.flowMessageId = null;
      }
      sessionStore.set(uid, session);
      await showShadesForDesign(bot, chatId, uid, session.currentDesign, session.warehouse);
    } else if (target === 'cart') {
      session.step = 'cart';
      delete session.customer;
      delete session.salesperson;
      delete session.paymentMode;
      delete session.supplyDate;
      sessionStore.set(uid, session);
      await showCartSummary(bot, chatId, uid);
    } else if (target === 'customer') {
      session.step = 'customer';
      delete session.salesperson;
      delete session.paymentMode;
      delete session.supplyDate;
      sessionStore.set(uid, session);
      await showSupplyCustomerPicker(bot, chatId, uid);
    } else if (target === 'salesperson') {
      session.step = 'salesperson';
      delete session.paymentMode;
      delete session.supplyDate;
      sessionStore.set(uid, session);
      await showSupplySalespersonPicker(bot, chatId, uid, false);
    } else if (target === 'payment') {
      session.step = 'payment';
      delete session.supplyDate;
      sessionStore.set(uid, session);
      await showSupplyPaymentPicker(bot, chatId, uid);
    } else if (target === 'date') {
      session.step = 'date';
      session.awaitingDocument = false;
      delete session.docFileId;
      sessionStore.set(uid, session);
      await showSupplyDatePicker(bot, chatId, uid);
    } else if (target === 'warehouse') {
      // Back to the warehouse list for the CURRENT container (preserve the
      // arrival-batch pick). Only offered on the design picker while the
      // cart is empty, so resetting the warehouse step is safe.
      await clearDesignPreview(bot, chatId, uid);
      session.step = 'warehouse';
      delete session.warehouse;
      delete session.currentDesign;
      delete session.designPage;
      sessionStore.set(uid, session);
      await proceedAfterContainer(bot, chatId, uid);
    } else if (target === 'category') {
      // SRF-CAT — back to the Select Category step for the CURRENT
      // container. Clear the category + everything below it; keep the
      // arrival batch, cart and scope.
      await clearDesignPreview(bot, chatId, uid);
      session.step = 'category';
      delete session.category;
      delete session.warehouse;
      delete session.multiWarehouse;
      delete session.currentDesign;
      delete session.designPage;
      sessionStore.set(uid, session);
      await showSupplyCategoryPicker(bot, chatId, uid);
    } else if (target === 'container') {
      // ARRIVAL-BATCH C1 — back to the Select Container step. Clear the
      // warehouse + any design-level selection; keep cart + scope. Offered
      // on the warehouse picker, and on the design picker for single-
      // warehouse containers (where there is no warehouse step to go to).
      await clearDesignPreview(bot, chatId, uid);
      session.step = 'container';
      session.arrivalBatch = '';
      delete session.category;
      delete session.categoryStepShown;
      delete session.warehouse;
      delete session.multiWarehouse;
      delete session.currentDesign;
      delete session.designPage;
      sessionStore.set(uid, session);
      await showContainerPicker(bot, chatId, uid);
    } else if (target === 'quantity') {
      session.step = 'quantity';
      sessionStore.set(uid, session);
      const lbl = await productTypesRepo.getLabels(session.productType || 'fabric');
      await showQuantityPicker(bot, chatId, uid, session.currentDesign, session.currentShade, session.warehouse, session.currentAvailPkgs, lbl);
    } else if (target === 'document') {
      await showSupplyConfirmation(bot, chatId, uid);
    }

  /* ─── SUPPLY REQUEST FLOW: DESIGN ─── */
  } else if (data.startsWith('srf_dg:')) {
    const design = data.slice(7);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    // Delete the design picker outright (instead of just wiping its
    // keyboard) so the chat doesn't carry a stale "Select design: …"
    // tombstone above the photo. If the user taps "Back to designs"
    // later we'll send a brand-new picker.
    const session = sessionStore.get(uid);
    if (session) {
      await bot.deleteMessage(chatId, callbackQuery.message.message_id).catch(() => {});
      if (session.flowMessageId === callbackQuery.message.message_id) {
        session.flowMessageId = null;
        sessionStore.set(uid, session);
      }
    }
    const wh = session ? session.warehouse : '';
    // showShadesForDesign now sends photo+shade buttons as ONE combo
    // message (when a catalog asset exists), so we no longer pre-send
    // a separate preview photo here.
    await showShadesForDesign(bot, chatId, uid, design, wh);

  /* ─── SUPPLY REQUEST FLOW: SHADE ─── */
  } else if (data.startsWith('srf_all:')) {
    /* ─── SUPPLY REQUEST FLOW: TAKE ALL SHADES OF A DESIGN ─── */
    const design = data.slice('srf_all:'.length);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired. Start again.' });
      return;
    }
    // Recompute availability against the live cart so we never over-add a
    // shade the user already put some of into the cart.
    const adjusted = await getAdjustedAvailability(session.warehouse, session.cart || [], session.arrivalBatch, session.category);
    const designShades = adjusted.filter((a) => a.design === design);
    let nameMap;
    try {
      const asset = await designAssetsRepo.findActive(design);
      nameMap = buildShadeNameMap(asset);
    } catch (_) {
      nameMap = new Map();
    }
    const lines = buildSelectAllLines(designShades, nameMap);
    if (!lines.length) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Nothing left to add for this design.' });
      return;
    }
    for (const line of lines) {
      session.currentShadeName = line.shadeName;
      addToCart(session, line.design, line.shade, line.quantity);
    }
    session.currentShadeName = '';
    sessionStore.set(uid, session);
    const totalAdded = lines.reduce((sum, l) => sum + l.quantity, 0);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: `Added all ${lines.length} shades (${totalAdded}) of ${design}.`,
    });
    // The shade picker may be a photo+buttons combo; drop it like srf_sh does
    // so the cart summary is the only live message.
    await clearDesignPreview(bot, chatId, uid);
    await showCartSummary(bot, chatId, uid);

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
    // Resolve the shade name from the catalog so the quantity picker
    // (and every step after — cart, customer, …, admin notification)
    // can show "Shade: 3 - Beige" instead of just "Shade: 3". The photo
    // bubble is about to be deleted, so this is what carries the color
    // forward visually.
    try {
      const asset = await designAssetsRepo.findActive(design);
      const nameMap = buildShadeNameMap(asset);
      session.currentShadeName = nameMap.get(String(shade)) || '';
    } catch (_) {
      session.currentShadeName = '';
    }
    session.step = 'quantity';
    sessionStore.set(uid, session);
    // The shade picker was a photo-and-buttons combo (or a text-only
    // fallback). Either way, drop it so the next text-only step is the
    // only "live" message in the flow.
    await clearDesignPreview(bot, chatId, uid);
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
      await bot.sendMessage(chatId, `Type the number of ${cPlural} (max ${session.currentAvailPkgs}):`, {
        reply_markup: { inline_keyboard: [[
          { text: '⬅️ Back', callback_data: 'srf_back:quantity' },
          { text: '❌ Cancel', callback_data: 'srf_cart:cancel' },
        ]] },
      });
      return;
    }

    const qty = parseInt(val);
    if (isNaN(qty) || qty < 1 || qty > session.currentAvailPkgs) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: `Invalid. Choose 1 – ${session.currentAvailPkgs}.` });
      return;
    }
    await bot.answerCallbackQuery(callbackQuery.id, { text: `${qty} added: ${session.currentDesign} ${formatShadeRef(session.currentShade, session.currentShadeName)}` });
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
        text: `🗑️ ${c.design} ${formatShadeRef(c.shade, c.shadeName)} × ${c.quantity}`,
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
    } else if (action === 'transfer') {
      if (!auth.isAdmin(uid)) {
        await bot.sendMessage(chatId, '🚚 Transfers can be created by admins only.');
        await showCartSummary(bot, chatId, uid);
        return;
      }
      // TRF-3 — hand the FULL cart to the transfer flow: every line
      // (design/shade/qty) carries over, so nothing is re-selected. The
      // flow jumps straight to the destination step. Relabel the leftover
      // cart message to a compact "Transfer Cart" so it reads as the
      // previous step rather than a stray supply cart.
      const transferCartText = await buildTransferCartText(session);
      await bot.editMessageText(transferCartText, {
        chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown',
      }).catch(() => {});
      const transferLines = (session.cart || []).map((c) => ({ design: c.design, shade: c.shade, qty: c.quantity }));
      await clearDesignPreview(bot, chatId, uid);
      sessionStore.clear(uid);
      await require('../flows/transferFlow').start(bot, chatId, uid, null, {
        from: session.warehouse,
        lines: transferLines,
      });
    } else if (action === 'cancel') {
      await clearDesignPreview(bot, chatId, uid);
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
      rows.push([{ text: '⬅️ Back to top buyers', callback_data: 'srf_back:customer' }]);
      await editOrSendAnchored(bot, chatId, uid, '👤 All other customers:', {
        reply_markup: { inline_keyboard: rows },
      });
      return;
    }

    if (val === '__new__') {
      session.step = 'new_srf_customer_name';
      sessionStore.set(uid, session);
      await editOrSendAnchored(bot, chatId, uid, '📝 Enter new customer *full name*:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '⬅️ Back to customers', callback_data: 'srf_back:customer' },
          { text: '❌ Cancel', callback_data: 'srf_cart:cancel' },
        ]] },
      });
      return;
    }
    session.customer = val;
    session.step = 'salesperson';
    sessionStore.set(uid, session);
    await showSupplySalespersonPicker(bot, chatId, uid, false);

  /* ─── SUPPLY REQUEST FLOW: SALESPERSON ─── */
  } else if (data.startsWith('srf_sp:')) {
    const val = data.slice(7);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);

    const session = sessionStore.get(uid);
    if (!session || session.type !== 'supply_req_flow') return;

    if (val === '__more__') {
      await showSupplySalespersonPicker(bot, chatId, uid, true);
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
      rows.push([{ text: '⬅️ Back to dates', callback_data: 'srf_back:date' }]);
      await bot.answerCallbackQuery(callbackQuery.id);
      await bot.editMessageReplyMarkup({ inline_keyboard: rows }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    } else if (data.startsWith('srf_dtnav:')) {
      const offset = parseInt(data.replace('srf_dtnav:', ''));
      const rows = buildDatePicker('srf_dt', offset);
      rows.push([{ text: '⬅️ Back to dates', callback_data: 'srf_back:date' }]);
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
      await clearDesignPreview(bot, chatId, uid);
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
      await clearDesignPreview(bot, chatId, uid);
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
      arrivalBatch: session.arrivalBatch || '',
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
    await clearDesignPreview(bot, chatId, uid);
    sessionStore.clear(uid);

    const requestId = genId();
    const isAdmin = config.access.adminIds.includes(uid);
    const approvalReason = isAdmin ? '2nd admin approval required' : 'Admin approval required';

    // Stage-1 routing: supply requests now go to Dispatch first for
    // feasibility confirmation, THEN to admins. We tag the actionJSON
    // up front so the queue row carries its current stage at all
    // times (admin_review = ready for 2nd-admin tap).
    actionJSON.stage = 'dispatch_review';

    await approvalQueueRepository.append({
      requestId, user: uid, actionJSON, riskReason: approvalReason, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: approvalReason }, uid);

    const userLabel = await getRequesterDisplayName(uid, null);
    const labels = await productTypesRepo.getLabels(session.productType || 'fabric');
    const cShort = labels.container_short;
    // SRF-UX: shades of one design fold into a single line.
    const cartLines = cartFormat.formatCartLines(cart.map((c) => {
      const m = getMaterialInfo(c.design);
      return { icon: m.icon, design: c.design, name: m.name, shadeRef: formatShadeRef(c.shade, c.shadeName), quantity: c.quantity };
    }), cShort).join('\n');
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

    // Try Stage 1 — notify Dispatch dept for confirmation.
    // notifyDispatchManagers self-heals (creates the Dispatch dept
    // row if missing) and excludes the requester. If no eligible
    // dispatch users exist, we fall through to the original direct-
    // to-admin notification so the request is never deadlocked.
    const queueItem = { requestId, user: uid, actionJSON };
    const stage1 = await approvalEvents.notifyDispatchManagers(bot, requestId, queueItem, uid);

    let stage1Skipped = false;
    if (!stage1.routed) {
      stage1Skipped = true;
      // Fallback: ensure actionJSON reflects the skip so admins
      // reviewing later don't see a phantom 'dispatch_review' tag.
      try {
        await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review', dispatchSkipped: true });
      } catch (_) {}

      const excludeId = isAdmin ? uid : undefined;
      await approvalEvents.notifyAdminsApprovalRequest(
        bot, requestId, userLabel, summary, approvalReason, excludeId,
        { prependNote: '⚠️ No active Dispatch members — Stage 1 confirmation skipped.' },
      );
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
    }

    const waitingFor = stage1Skipped
      ? (isAdmin ? '2nd admin approval' : 'admin approval')
      : 'Dispatch confirmation';
    await bot.sendMessage(chatId,
      `✅ Supply request submitted.\n\n🏭 ${actionJSON.warehouse}\n━━━━━━━━━━━━━━━━━━━━━━\n${cartLines}\n━━━━━━━━━━━━━━━━━━━━━━\n📦 Total: ${totalPkgs} ${containerPlural}\n👤 ${actionJSON.customer}\n📅 ${fmtDate(actionJSON.salesDate)}\n\n⏳ Waiting for ${waitingFor}.\nRequest: ${requestId}`, {
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
      const rows = users.map((u) => {
        const depts = (Array.isArray(u.departments) && u.departments.length)
          ? u.departments.join(',')
          : (u.department || 'none');
        return [{ text: `${u.name || u.user_id} (${depts})`, callback_data: `adm_du:${u.user_id}` }];
      });
      sessionStore.set(uid, { type: 'adm_flow', action: 'assign_dept', step: 'pick_user' });
      await bot.sendMessage(chatId, '🏢 Select user to assign departments:', { reply_markup: { inline_keyboard: rows } });
    } else if (action === 'assign_wh') {
      const users = await usersRepository.getAll();
      const rows = users.map((u) => [{ text: `${u.name || u.user_id} (${u.warehouses.join(', ') || 'none'})`, callback_data: `adm_wu:${u.user_id}` }]);
      sessionStore.set(uid, { type: 'adm_flow', action: 'assign_wh', step: 'pick_user' });
      await bot.sendMessage(chatId, '🏭 Select user to assign warehouse:', { reply_markup: { inline_keyboard: rows } });
    } else if (action === 'add_user') {
      // Consolidated: legacy 2-field admin-flow add-user now launches the full
      // Add Employee flow (branch/dept/warehouses/role + dual-admin approval).
      const userAddFlow = require('../flows/userAddFlow');
      await userAddFlow.start(bot, chatId, String(uid), null, null);
    }

  } else if (data.startsWith('adm_du:')) {
    // Multi-toggle department picker (mirrors the warehouse picker's
    // ✅/⬜ pattern). Tapping a department flips it in/out of the
    // user's pending list; tapping 💾 Save persists the CSV.
    const targetUserId = data.slice(7);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

    const depts = (await departmentsRepo.getAll()).filter((d) => d.status === 'active');
    const targetUser = await usersRepository.findByUserId(targetUserId);
    const current = (targetUser && Array.isArray(targetUser.departments) && targetUser.departments.length)
      ? targetUser.departments.slice()
      : (targetUser && targetUser.department ? [targetUser.department] : []);
    const rows = depts.map((d) => {
      const has = current.some((c) => String(c).trim().toLowerCase() === d.dept_name.toLowerCase());
      return [{ text: `${has ? '✅' : '⬜'} 🏢 ${d.dept_name}`, callback_data: `adm_dt:${targetUserId}|${d.dept_name}` }];
    });
    rows.push([{ text: '💾 Save', callback_data: `adm_ds:${targetUserId}` }]);
    rows.push([{ text: '⬅️ Back', callback_data: 'adm:assign_dept' }]);
    sessionStore.set(uid, { type: 'adm_flow', action: 'assign_dept', targetUserId, pendingDepartments: current });
    await bot.sendMessage(chatId, `🏢 Toggle departments for ${targetUser ? targetUser.name : targetUserId}:`, { reply_markup: { inline_keyboard: rows } });

  } else if (data.startsWith('adm_dt:')) {
    const [targetUserId, deptName] = data.slice(7).split('|');
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'adm_flow' || session.targetUserId !== targetUserId) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired. Re-open the user.' });
      return;
    }
    if (!session.pendingDepartments) session.pendingDepartments = [];
    const idx = session.pendingDepartments.findIndex((c) => String(c).trim().toLowerCase() === deptName.toLowerCase());
    if (idx >= 0) session.pendingDepartments.splice(idx, 1);
    else session.pendingDepartments.push(deptName);
    sessionStore.set(uid, session);

    const depts = (await departmentsRepo.getAll()).filter((d) => d.status === 'active');
    const rows = depts.map((d) => {
      const has = session.pendingDepartments.some((c) => String(c).trim().toLowerCase() === d.dept_name.toLowerCase());
      return [{ text: `${has ? '✅' : '⬜'} 🏢 ${d.dept_name}`, callback_data: `adm_dt:${targetUserId}|${d.dept_name}` }];
    });
    rows.push([{ text: '💾 Save', callback_data: `adm_ds:${targetUserId}` }]);
    rows.push([{ text: '⬅️ Back', callback_data: 'adm:assign_dept' }]);
    await bot.answerCallbackQuery(callbackQuery.id, { text: `${idx >= 0 ? 'Removed' : 'Added'} ${deptName}` });
    await bot.editMessageReplyMarkup({ inline_keyboard: rows }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

  } else if (data.startsWith('adm_ds:')) {
    const targetUserId = data.slice(7);
    const chatId = callbackQuery.message.chat.id;
    const uid = String(callbackQuery.from.id);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'adm_flow' || session.targetUserId !== targetUserId) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' });
      return;
    }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Saving...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

    const finalDepts = (session.pendingDepartments || []).map((d) => String(d).trim()).filter(Boolean);
    const ok = await usersRepository.updateDepartment(targetUserId, finalDepts);
    if (ok) {
      const list = finalDepts.length ? finalDepts.join(', ') : '(none)';
      await bot.sendMessage(chatId, `✅ User ${targetUserId} departments saved: *${list}*.`, { parse_mode: 'Markdown' });
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

async function handleAdminFlowText(_bot, _chatId, _userId, _text, _session) {
  // The legacy 2-field add-user text steps were retired (USR onboarding
  // cleanup): all add-user paths now go through the anchored Add Employee
  // flow (flows/userAddFlow.js), which handles its own text input. No
  // adm_flow action currently collects free-text, so this is a no-op guard.
  return false;
}

/* ─── DESIGN ASSET FLOW (Catalog hub) ─────────────────────────────────────
 * Anyone with the activity can submit a product photo for a design. The
 * upload is queued for 2-admin approval (admin → 2nd admin). On approval,
 * the labeled photo becomes the "active" asset and is served to consumer
 * pickers (sample / supply / order / update price / reports / stock).
 *
 * Session shape (sessionStore):
 *   {
 *     type: 'design_asset_flow',
 *     step: 'design' | 'shade_count' | 'shade_names' | 'photo' | 'preview',
 *     design, shadeCount, shadeNames[],
 *     rawBufferB64, labeledBufferB64,        // encoded buffers (memory-only TTL session)
 *     stagedRequestId,
 *     flowMessageId,
 *   }
 *
 * Callback prefixes: dap:* (design-asset-photo).
 * Manage hub callback prefixes: dam:* (design-asset-manage).
 */

const DAP_MAX_SHADES = 20;
const DAP_MAX_DESIGN_LEN = 30;

// 30 minutes — photo upload involves stepping away to take pictures, so the
// usual 5-min default is far too tight. Carried forward by sessionStore.set
// as long as the session is read-modify-written (the pattern this flow uses).
const DESIGN_ASSET_TTL_MS = 30 * 60 * 1000;

async function startDesignAssetUploadFlow(bot, chatId, userId) {
  sessionStore.clear(userId);
  sessionStore.set(userId, {
    type: 'design_asset_flow',
    step: 'design',
    shadeNames: [],
    ttlMs: DESIGN_ASSET_TTL_MS,
  });
  await showDesignAssetDesignPicker(bot, chatId, userId);
}

async function showDesignAssetDesignPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  let designs = [];
  try {
    const raw = await inventoryRepository.getDistinctDesigns();
    designs = [...new Set(raw.map((d) => (d.design || '').trim()).filter(Boolean))].sort();
  } catch (_) { /* ignore — show free-text fallback */ }

  // Already-photographed designs are not blocked, but we mark them so admins
  // know they're replacing the existing photo.
  let activeDesigns = new Set();
  try {
    const active = await designAssetsRepo.list('active');
    activeDesigns = new Set(active.map((a) => String(a.design).toUpperCase()));
  } catch (_) {}

  const visible = designs.slice(0, 24);
  const rows = [];
  for (let i = 0; i < visible.length; i += 3) {
    const row = [];
    for (let j = i; j < Math.min(i + 3, visible.length); j++) {
      const d = visible[j];
      const tick = activeDesigns.has(d.toUpperCase()) ? '✓ ' : '';
      row.push({ text: `${tick}${d}`, callback_data: `dap:dpick:${d.slice(0, DAP_MAX_DESIGN_LEN)}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '✏️ Type a design number', callback_data: 'dap:dtype' }]);
  rows.push([{ text: '❌ Cancel', callback_data: 'dap:cancel' }]);

  const text = '📷 *Upload Product Photo*\n\nStep 1 / 4 — Pick a design number.\n_(✓ = photo already exists; submitting again will replace it after admin approval)_';
  const sent = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
  if (sent && sent.message_id) {
    session.flowMessageId = sent.message_id;
    sessionStore.set(userId, session);
  }
}

/**
 * CAT-C1 — Step 2/4: which shipment container does this photo show?
 * Same design can carry different shades per container, so photos are
 * keyed by (design, batch). Index-based callbacks (64-byte safe); the
 * label list rides in the session. "Generic" = blank batch (legacy look,
 * shown on container-less screens as fallback).
 */
async function showDesignAssetContainerPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  let batches = [];
  try {
    batches = (await inventoryRepository.getArrivalBatches())
      .map((c) => c.batch)
      .filter((b) => b && b !== inventoryRepository.UNLABELLED_BATCH);
  } catch (_) { /* chips optional — Generic is always available */ }
  session.containerChoices = batches;
  sessionStore.set(userId, session);
  const rows = [];
  for (let i = 0; i < batches.length; i += 2) {
    const row = [{ text: `🚢 ${batches[i]}`, callback_data: `dap:ct:${i}` }];
    if (batches[i + 1]) row.push({ text: `🚢 ${batches[i + 1]}`, callback_data: `dap:ct:${i + 1}` });
    rows.push(row);
  }
  rows.push([{ text: '🌐 Generic (all containers)', callback_data: 'dap:ct:generic' }]);
  rows.push([{ text: '❌ Cancel', callback_data: 'dap:cancel' }]);
  await editOrSend(bot, chatId, session.flowMessageId,
    `📷 *Upload Product Photo*\n\nStep 2 / 4 — Which container (shipment) does *${session.design}* look like in this photo?\n_Shades can differ per shipment — the photo shows only for the container you pick._`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

/**
 * Build the canonical example shade-list strings shown in the prompt.
 * If the asset already has structured shades (replace flow), seed the
 * example with those numbers so the employee can simply edit. Otherwise
 * fall back to a generic 1..N sample.
 */
function _buildShadeExamples(seedShades) {
  const SAMPLE_NAMES = ['White', 'Beige', 'Brown', 'Olive', 'Burgundy', 'Purple', 'Sky', 'Cream', 'Navy', 'Forest', 'Off-white', 'Black', 'Gold', 'Silver', 'Wine', 'Teal', 'Coral', 'Mint', 'Charcoal', 'Tan'];
  const fallbackCount = 8;
  if (Array.isArray(seedShades) && seedShades.length) {
    const numbered = seedShades.map((s, i) => `${s.number}:${s.name || SAMPLE_NAMES[i] || ('Shade' + (i + 1))}`).join(', ');
    return { numbered, plain: seedShades.map((s, i) => s.name || SAMPLE_NAMES[i] || ('Shade' + (i + 1))).join(', ') };
  }
  const numbered = Array.from({ length: fallbackCount }, (_, i) => `${i + 1}:${SAMPLE_NAMES[i] || ('Shade' + (i + 1))}`).join(', ');
  const plain    = Array.from({ length: fallbackCount }, (_, i) => SAMPLE_NAMES[i] || ('Shade' + (i + 1))).join(', ');
  return { numbered, plain };
}

/**
 * Parse the user's shade-names reply into canonical [{number, name}].
 *
 * Supported formats (auto-detected per entry):
 *   - "3:Dark Green"     → {number: 3,  name: "Dark Green"}
 *   - "3=Dark Green"     → {number: 3,  name: "Dark Green"}
 *   - "Dark Green"       → {number: i+1, name: "Dark Green"}   (positional fallback)
 *
 * Returns { ok: true, shades: [...] } or { ok: false, reason: "…" }.
 */
function parseShadeReply(text, expectedCount) {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, reason: 'Got an empty list — please send shade names.' };
  const shades = [];
  const seen = new Set();
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    const m = raw.match(/^\s*(\d+)\s*[:=]\s*(.+?)\s*$/);
    let number, name;
    if (m) {
      number = parseInt(m[1], 10);
      name = m[2];
    } else {
      number = i + 1;
      name = raw;
    }
    if (!Number.isFinite(number) || number <= 0) {
      return { ok: false, reason: `Entry "${raw}" has an invalid number.` };
    }
    if (seen.has(number)) {
      return { ok: false, reason: `Number ${number} is repeated — each tab number must appear only once.` };
    }
    if (!name) {
      return { ok: false, reason: `Entry "${raw}" is missing a name.` };
    }
    seen.add(number);
    shades.push({ number, name: name.slice(0, 30) });
  }
  if (Number.isFinite(expectedCount) && expectedCount > 0 && shades.length !== expectedCount) {
    return { ok: false, reason: `Got ${shades.length} entries but expected ${expectedCount} (you said ${expectedCount} shades).` };
  }
  shades.sort((a, b) => a.number - b.number);
  return { ok: true, shades };
}

function formatShadesPreview(shades) {
  if (!Array.isArray(shades) || !shades.length) return '_(none)_';
  return shades.map((s) => `${s.number}. ${s.name}`).join(' • ');
}

async function showDesignAssetPhotoPrompt(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'photo';
  sessionStore.set(userId, session);
  await editOrSend(bot, chatId, session.flowMessageId,
    `📷 *Upload Product Photo*\n\n` +
    `✓ Design: *${session.design}*${session.arrivalBatch ? `\n✓ Container: *${session.arrivalBatch}*` : '\n✓ Container: 🌐 generic'}\n\n` +
    `Step 3 / 4 — *Send the product photo* now (as a Telegram photo, not a file).\n\n` +
    `💡 Lay shades L→R with paper tabs (numbers/letters) visible on each — you'll map them to colours in the next step using the photo as reference.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'dap:cancel' }]] } });
}

/**
 * Step 3/3 — after the photo has been processed and shown, prompt the
 * employee to map physical tab numbers to shade names. The labeled photo
 * sits directly above this prompt in the chat, so the employee can
 * read tab numbers off it directly.
 */
async function showDesignAssetShadeNamesPromptAfterPhoto(bot, chatId, userId, seedShades) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'shade_names';
  sessionStore.set(userId, session);
  const ex = _buildShadeExamples(seedShades);
  await bot.sendMessage(chatId,
    `📷 *Upload Product Photo*\n\n` +
    `✓ Design: *${session.design}*\n` +
    `✓ Photo received\n\n` +
    `Step 4 / 4 — *Enter shade numbers + names*, comma-separated, in the order they appear in the photo above.\n\n` +
    `🅰 *Numbered* (use the physical tab numbers visible on the photo):\n` +
    `\`${ex.numbered}\`\n\n` +
    `🅱 *Or plain names* (sequential 1…N is auto-assigned):\n` +
    `\`${ex.plain}\`\n\n` +
    `Tip: count is taken from your input — no need to specify it separately.\n` +
    `Or type *skip* for generic names (Shade 1, Shade 2, …).`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '⏭ Skip — use generic names', callback_data: 'dap:skipnames' }],
      [{ text: '❌ Cancel', callback_data: 'dap:cancel' }],
    ] } });
}

/** After a photo is received, generate the labeled preview and ask for confirmation. */
async function processDesignAssetPhoto(bot, chatId, userId, telegramFileId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'design_asset_flow') return;

  await bot.sendMessage(chatId, '⏳ Processing photo (downloading + stamping design number)…');

  let dl;
  try {
    dl = await downloadTelegramFile(bot, telegramFileId);
  } catch (e) {
    logger.error('design_asset_flow: download failed', e.message);
    await bot.sendMessage(chatId, `⚠️ Could not download photo: ${e.message}\n\nPlease try sending it again, or type "cancel" to abort.`);
    return;
  }

  // Stage upload uses a placeholder shade list ([{1, "Shade 1"}]) — the
  // real list will arrive in step 3/3 and replace this. The photo itself,
  // Drive uploads, and the labeled Sharp render are produced now so the
  // employee can see the labeled photo while typing shade names.
  let staged;
  try {
    staged = await designAssetsService.stageUpload({
      design: session.design,
      rawBuffer: dl.buffer,
      shades: [{ number: 1, name: 'Shade 1' }],   // placeholder, overwritten in step 3/3
      uploadedBy: userId,
    });
  } catch (e) {
    logger.error('design_asset_flow: stageUpload failed', e.message);
    await bot.sendMessage(chatId, `⚠️ Could not process photo: ${e.message}\n\nPlease try a different image, or type "cancel" to abort.`);
    return;
  }

  // Stash the staged result on the session (without buffers — we re-fetch
  // from Drive at preview/submit time using the file ids).
  session.staged = {
    design: staged.design,
    productType: staged.productType,
    shadeCount: staged.shadeCount,
    shades: staged.shades,
    shadeNames: staged.shadeNames,
    rawDriveFileId: staged.rawDriveFileId,
    rawDriveUrl: staged.rawDriveUrl,
    labeledDriveFileId: staged.labeledDriveFileId,
    labeledDriveUrl: staged.labeledDriveUrl,
    uploadedBy: staged.uploadedBy,
    uploadedAt: staged.uploadedAt,
  };
  // Send the labeled photo (no buttons) so the employee can read tab
  // numbers off it while typing shade names. Cache the file_id so the
  // preview message in step 3/3 can use it instantly.
  try {
    const sent = await bot.sendPhoto(chatId, staged.labeledBuffer, {
      caption: `📷 *${staged.design}* — photo ready.`,
      parse_mode: 'Markdown',
    });
    if (sent && sent.photo && sent.photo.length) {
      session.previewFileId = sent.photo[sent.photo.length - 1].file_id;
    }
  } catch (e) {
    logger.warn('design_asset_flow: labeled photo send failed', e.message);
  }
  // Seed example numbers from any prior asset for this design (replace flow).
  let seed = null;
  try {
    const prior = await designAssetsRepo.findActive(session.design);
    if (prior && prior.shades && prior.shades.length) seed = prior.shades;
  } catch (_) {}
  sessionStore.set(userId, session);

  // ── AUTO-DETECT shades using OpenAI Vision ─────────────────────────────
  // This is an *optional* convenience layered on top of the existing
  // manual-input flow. If the model returns a high-confidence list, we
  // show the employee a "Looks right — proceed" button. Otherwise (or
  // on any failure) we silently fall back to manual N:name input.
  let detection = null;
  try {
    const statusMsg = await bot.sendMessage(chatId, '🤖 Auto-detecting shades from the photo…').catch(() => null);
    detection = await colorDetector.detectShadesFromPhoto(dl.buffer, 'image/jpeg');
    if (statusMsg && statusMsg.message_id) {
      bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    }
  } catch (e) {
    logger.warn(`design_asset_flow: auto-detect failed for ${session.design}: ${e.message}`);
    detection = null;
  }

  if (detection && detection.shades && detection.shades.length && detection.confidence >= 0.5) {
    // Stash the proposal on the session so the "Proceed" callback can
    // commit it. We don't overwrite session.staged.shades yet — the
    // employee must explicitly accept first.
    session.detectedShades = detection.shades;
    session.detectionConfidence = detection.confidence;
    session.step = 'awaiting_detection_confirm';
    sessionStore.set(userId, session);
    await showDesignAssetDetectionProposal(bot, chatId, userId);
    return;
  }

  // Detection unavailable or low-confidence → fall through to manual input.
  await showDesignAssetShadeNamesPromptAfterPhoto(bot, chatId, userId, seed);
}

/**
 * Step 3a / 3 — show the auto-detected shade proposal with two choices:
 *   ✅ Proceed (use these shades as-is) → jumps directly to preview
 *   ✏️ Type manually                    → falls into the existing N:name flow
 */
async function showDesignAssetDetectionProposal(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.detectedShades) return;
  const lines = formatShadesPreview(session.detectedShades);
  const conf = Math.round((session.detectionConfidence || 0) * 100);
  await bot.sendMessage(chatId,
    `🤖 *Auto-detected ${session.detectedShades.length} shade${session.detectedShades.length === 1 ? '' : 's'}* (confidence ${conf}%)\n\n` +
    `${lines}\n\n` +
    `If this matches the photo, tap *Proceed*. Otherwise tap *Type manually* to enter the list yourself.`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Proceed — looks right',     callback_data: 'dap:autoaccept' }],
        [{ text: '✏️ Type manually',              callback_data: 'dap:manual' }],
        [{ text: '❌ Cancel',                     callback_data: 'dap:cancel' }],
      ] },
    });
}

/**
 * Send (or re-send) the labeled preview with action buttons. Used after a
 * fresh photo is processed and after an in-place edit of shade metadata.
 */
async function sendDesignAssetPreview(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.staged) return;
  const staged = session.staged;
  const previewLines = formatShadesPreview(staged.shades);
  const caption = `📷 *Preview — ${staged.design}* (${staged.shadeCount} shades)\n\n${previewLines}\n\nSubmit for admin approval, edit the numbers/names, or retake the photo.`;
  const kb = { inline_keyboard: [
    [{ text: '✅ Submit for approval',          callback_data: 'dap:submit' }],
    [{ text: '✏️ Edit shade numbers / names',   callback_data: 'dap:editmeta' }],
    [{ text: '🔁 Retake photo',                  callback_data: 'dap:retake' }],
    [{ text: '❌ Cancel',                        callback_data: 'dap:cancel' }],
  ] };
  // First time: send the labeled buffer directly (Drive may not be public-readable yet to Telegram).
  // Subsequent edits: prefer the cached previewFileId for instant resend.
  const photoSrc = session.previewFileId
    || (staged.labeledDriveFileId ? `https://drive.google.com/uc?export=download&id=${staged.labeledDriveFileId}` : null);
  // If we have neither, the upload pipeline failed earlier — bail.
  if (!photoSrc && !session._labeledBuffer) {
    await bot.sendMessage(chatId, '⚠️ Preview unavailable. Tap retake or cancel.', { parse_mode: 'Markdown' });
    return;
  }
  try {
    const sent = await bot.sendPhoto(chatId, photoSrc || session._labeledBuffer, {
      caption, parse_mode: 'Markdown', reply_markup: kb,
    });
    if (sent && sent.photo && sent.photo.length) {
      session.previewFileId = sent.photo[sent.photo.length - 1].file_id;
      sessionStore.set(userId, session);
    }
  } catch (e) {
    logger.error('design_asset_flow: preview send failed', e.message);
    await bot.sendMessage(chatId, '⚠️ Preview could not be sent, but the photo was processed. Reply *submit* to send for approval, *edit* to redo names, or *cancel* to abort.', { parse_mode: 'Markdown' });
  }
}

async function submitDesignAssetForApproval(bot, chatId, userId, msg) {
  const session = sessionStore.get(userId);
  if (!session || !session.staged) {
    await bot.sendMessage(chatId, '⚠️ No staged upload to submit. Start again with "Upload Product Photo".');
    return;
  }
  const staged = session.staged;
  const requestId = require('crypto').randomUUID();

  try {
    await designAssetsService.persistPending({
      design: staged.design,
      productType: staged.productType,
      shadeCount: staged.shadeCount,
      shades: staged.shades,
      shadeNames: staged.shadeNames,
      rawDriveFileId: staged.rawDriveFileId,
      rawDriveUrl: staged.rawDriveUrl,
      labeledDriveFileId: staged.labeledDriveFileId,
      labeledDriveUrl: staged.labeledDriveUrl,
      // Persist the Telegram file_id captured during the upload preview.
      // This makes the asset serveable even when Drive uploads have
      // failed (e.g. Drive API disabled). Without this, getPhotoForSend
      // has no Drive id to download from and the picker shows nothing.
      telegramFileId: session.previewFileId || '',
      uploadedBy: staged.uploadedBy,
      uploadedAt: staged.uploadedAt,
      // CAT-C1 — which shipment container this photo shows ('' = generic).
      arrivalBatch: session.arrivalBatch || '',
    }, requestId);
  } catch (e) {
    logger.error('design_asset_flow: persistPending failed', e.message);
    await bot.sendMessage(chatId, `⚠️ Could not save the asset: ${e.message}`);
    return;
  }

  // Risk: design_asset_upload always requires 2-admin approval (anyone uploads).
  await approvalQueueRepository.append({
    requestId,
    user: userId,
    actionJSON: {
      action: 'design_asset_upload',
      design: staged.design,
      productType: staged.productType,
      shadeCount: staged.shadeCount,
      shades: staged.shades,
      shadeNames: staged.shadeNames,
      labeledDriveUrl: staged.labeledDriveUrl,
      uploaderUserId: userId,
      arrivalBatch: session.arrivalBatch || '',
    },
    riskReason: 'Product-photo asset must be approved before it appears to consumers.',
    status: 'pending',
  });
  await auditLogRepository.append('approval_queued', { requestId, action: 'design_asset_upload', design: staged.design }, userId);

  const userLabel = await getRequesterDisplayName(userId, msg);
  const isAdm = config.access.adminIds.includes(userId);
  const summary = `Product photo: ${staged.design} (${staged.shadeCount} shades)`;
  const previewPhoto = session.previewFileId || (staged.labeledDriveFileId ? `https://drive.google.com/uc?export=download&id=${staged.labeledDriveFileId}` : null);
  const previewLines = formatShadesPreview(staged.shades);
  await approvalEvents.notifyAdminsApprovalRequest(
    bot, requestId, userLabel, summary,
    'Product-photo asset must be approved before it appears to consumers.',
    isAdm ? userId : undefined,
    previewPhoto ? { previewPhoto, previewCaption: `📷 *${staged.design}* — preview\n${previewLines}` } : {},
  );

  sessionStore.clear(userId);
  const approverLabel = isAdm ? '2nd admin' : 'admin';
  await bot.sendMessage(chatId,
    `✅ *Submitted for approval*\n\nDesign: *${staged.design}*\nShades: *${staged.shadeCount}*\nRequest ID: \`${requestId}\`\n\n⏳ Waiting for ${approverLabel}. You'll be notified when the photo goes live.`,
    { parse_mode: 'Markdown' });
}

/** Handle text input during design_asset_flow. Returns true if handled. */
async function handleDesignAssetTextStep(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'design_asset_flow') return false;

  if (text.toLowerCase() === 'cancel') {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, '❌ Upload cancelled.');
    return true;
  }
  if (session.step === 'preview' && text.toLowerCase() === 'submit') {
    await submitDesignAssetForApproval(bot, chatId, userId, null);
    return true;
  }
  // If the user types while we're waiting for them to tap "Proceed" or
  // "Type manually" on the auto-detection card, treat the typing as an
  // implicit "type manually" and route them into the standard
  // shade-names handler with their text already in hand.
  if (session.step === 'awaiting_detection_confirm') {
    const seed = session.detectedShades || null;
    delete session.detectedShades;
    delete session.detectionConfidence;
    session.step = 'shade_names';
    sessionStore.set(userId, session);
    // Fall through to shade_names handling below by re-invoking ourselves
    // — this avoids duplicating the parse / validation logic.
    return await handleDesignAssetTextStep(bot, chatId, userId, text);
  }
  if (session.step === 'manage_search') {
    const q = text.trim().toUpperCase();
    if (!q) {
      await bot.sendMessage(chatId, '⚠️ Type a design number to search.');
      return true;
    }
    sessionStore.clear(userId);
    const row = await designAssetsRepo.findActive(q);
    if (row) {
      await showDesignAssetDetail(bot, chatId, userId, q);
    } else {
      let actives = [];
      try { actives = await designAssetsRepo.list('active'); } catch (_) {}
      const partials = actives.filter((a) => a.design.toUpperCase().includes(q)).slice(0, 8);
      if (partials.length) {
        const rows = partials.map((a) => [{ text: `📷 ${a.design} — ${a.shadeCount} shades`, callback_data: `dam:view:${a.design.slice(0, 30)}` }]);
        rows.push([{ text: '◀️ Back', callback_data: 'dam:back' }]);
        await bot.sendMessage(chatId,
          `🔎 No exact match for *${q}*. Similar designs:`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
      } else {
        await bot.sendMessage(chatId,
          `🔎 No design found matching *${q}*.`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'dam:back' }]] } });
      }
    }
    return true;
  }
  if (session.step === 'design_typing') {
    const d = text.trim();
    if (!d || d.length > DAP_MAX_DESIGN_LEN) {
      await bot.sendMessage(chatId, `⚠️ Enter a non-empty design number (≤ ${DAP_MAX_DESIGN_LEN} chars).`);
      return true;
    }
    session.design = d;
    sessionStore.set(userId, session);
    await showDesignAssetContainerPicker(bot, chatId, userId);
    return true;
  }
  if (session.step === 'shade_names') {
    // Step 3/3 — photo already staged. Update shades on the staged record
    // and jump straight to the final preview.
    if (!session.staged) {
      // Defensive: if step is shade_names but no staged photo, restart at photo step.
      await bot.sendMessage(chatId, '⚠️ The photo step was missed. Please send the photo first.');
      session.step = 'photo';
      sessionStore.set(userId, session);
      return true;
    }
    let shades;
    if (text.toLowerCase() === 'skip') {
      // Default to a single placeholder shade; admin can edit before submit.
      shades = [{ number: 1, name: 'Shade 1' }];
    } else {
      const parsed = parseShadeReply(text, null); // count derived from input
      if (!parsed.ok) {
        await bot.sendMessage(chatId,
          `⚠️ ${parsed.reason}\n\nUse *N:name* (e.g. \`3:Dark Green, 4:Beige, …\`) or plain names. Or tap *Skip*.`,
          { parse_mode: 'Markdown' });
        return true;
      }
      shades = parsed.shades;
    }
    session.staged.shades = shades;
    session.staged.shadeCount = shades.length;
    session.staged.shadeNames = shades.map((s) => s.name);
    session.step = 'preview';
    sessionStore.set(userId, session);
    await sendDesignAssetPreview(bot, chatId, userId);
    return true;
  }
  if (session.step === 'edit_meta' && session.staged) {
    // In-flow edit before submission: photo already processed, just rewrite shades.
    if (text.toLowerCase() === 'skip') {
      session.staged.shades = Array.from({ length: session.staged.shadeCount }, (_, i) =>
        ({ number: i + 1, name: `Shade ${i + 1}` })
      );
      session.staged.shadeNames = session.staged.shades.map((s) => s.name);
    } else {
      const parsed = parseShadeReply(text, null); // count may change on edit
      if (!parsed.ok) {
        await bot.sendMessage(chatId,
          `⚠️ ${parsed.reason}\n\nUse *N:name* or plain names, comma-separated.`,
          { parse_mode: 'Markdown' });
        return true;
      }
      session.staged.shades = parsed.shades;
      session.staged.shadeCount = parsed.shades.length;
      session.staged.shadeNames = parsed.shades.map((s) => s.name);
    }
    session.step = 'preview';
    sessionStore.set(userId, session);
    await bot.sendMessage(chatId, '✅ Updated. Re-rendering preview…');
    await sendDesignAssetPreview(bot, chatId, userId);
    return true;
  }
  if (session.step === 'edit_names' && session.editingDesign) {
    // Manage-hub edit (post-approval): touches the persisted active asset.
    let shades;
    if (text.toLowerCase() === 'skip') {
      const row = await designAssetsRepo.findActive(session.editingDesign);
      if (!row) { await bot.sendMessage(chatId, `⚠️ No active asset for ${session.editingDesign}.`); sessionStore.clear(userId); return true; }
      shades = Array.from({ length: row.shadeCount || 1 }, (_, i) => ({ number: i + 1, name: `Shade ${i + 1}` }));
    } else {
      const parsed = parseShadeReply(text, null);
      if (!parsed.ok) {
        await bot.sendMessage(chatId,
          `⚠️ ${parsed.reason}\n\nUse *N:name* or plain names, comma-separated. Type *cancel* to abort.`,
          { parse_mode: 'Markdown' });
        return true;
      }
      shades = parsed.shades;
    }
    try {
      const row = await designAssetsRepo.findActive(session.editingDesign);
      if (!row) {
        await bot.sendMessage(chatId, `⚠️ No active asset for ${session.editingDesign}.`);
      } else {
        await designAssetsRepo.setShades(row.rowIndex, shades);
        await bot.sendMessage(chatId,
          `✅ Shades updated for *${session.editingDesign}*.\n${formatShadesPreview(shades)}`,
          { parse_mode: 'Markdown' });
      }
    } catch (e) {
      await bot.sendMessage(chatId, `⚠️ Update failed: ${e.message}`);
    }
    sessionStore.clear(userId);
    return true;
  }
  return false;
}

/** Handle photo upload for design_asset_flow. Returns true if handled. */
async function handleDesignAssetPhotoMessage(bot, chatId, userId, msg) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'design_asset_flow' || session.step !== 'photo') return false;
  if (!msg.photo || !msg.photo.length) {
    await bot.sendMessage(chatId, '⚠️ Please send the image as a *photo* (not a file/document).', { parse_mode: 'Markdown' });
    return true;
  }
  const largest = msg.photo[msg.photo.length - 1];
  await processDesignAssetPhoto(bot, chatId, userId, largest.file_id);
  return true;
}

/* ─── MANAGE PRODUCT PHOTOS (admin) ─── */

async function startManageDesignPhotos(bot, chatId, userId, messageId) {
  await showManageDesignPhotosPage(bot, chatId, userId, 0, messageId);
}

async function showDesignAssetDetail(bot, chatId, userId, design, callerMessageId) {
  if (!config.access.adminIds.includes(userId)) {
    await bot.sendMessage(chatId, 'Admin only.');
    return;
  }
  const row = await designAssetsRepo.findActive(design);
  if (!row) {
    await bot.sendMessage(chatId, `⚠️ No active photo for ${design}.`);
    return;
  }

  // Delete the caller message (list/previous photo) to replace it in place.
  if (callerMessageId) {
    await bot.deleteMessage(chatId, callerMessageId).catch(() => {});
  }

  const photoSrc = row.telegramFileId
    ? row.telegramFileId
    : (row.labeledDriveFileId ? `https://drive.google.com/uc?export=download&id=${row.labeledDriveFileId}` : '');
  const caption = `📷 *${row.design}* — ${row.productType}\nShades (${row.shadeCount}):\n${formatShadesPreview(row.shades || [])}\nUploaded by: ${row.uploadedBy} • ${fmtDate(row.uploadedAt) || row.uploadedAt}\nApproved by: ${row.approvedBy || '_(legacy)_'}`;
  const kb = { inline_keyboard: [
    [{ text: '🔁 Replace photo',         callback_data: `dam:replace:${row.design.slice(0, 30)}` }],
    [{ text: '✏️ Edit shade names',      callback_data: `dam:editnames:${row.design.slice(0, 30)}` }],
    [{ text: '🔍 Diagnose dispatch',     callback_data: `dam:diag:${row.design.slice(0, 30)}` }],
    [{ text: '🗑️ Deactivate',            callback_data: `dam:deact:${row.design.slice(0, 30)}` }],
    [{ text: '◀️ Back',                  callback_data: 'dam:back' }],
  ] };
  if (photoSrc) {
    try {
      const sent = await bot.sendPhoto(chatId, photoSrc, { caption, parse_mode: 'Markdown', reply_markup: kb });
      if (!row.telegramFileId && sent && sent.photo && sent.photo.length) {
        designAssetsService.cacheTelegramFileId(row.rowIndex, sent.photo[sent.photo.length - 1].file_id).catch(() => {});
      }
      return;
    } catch (e) {
      logger.warn(`showDesignAssetDetail sendPhoto failed: ${e.message}`);
    }
  }
  await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: kb });
}

/** Handle dap:* and dam:* callbacks. Returns true if handled. */
async function handleDesignAssetCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  const uid = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;

  /* DAP — upload flow */
  if (data === 'dap:cancel') {
    sessionStore.clear(uid);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    await bot.sendMessage(chatId, '❌ Upload cancelled.');
    return true;
  }
  if (data === 'dap:dtype') {
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'design_asset_flow') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' });
      return true;
    }
    session.step = 'design_typing';
    sessionStore.set(uid, session);
    await bot.answerCallbackQuery(callbackQuery.id);
    await editOrSend(bot, chatId, session.flowMessageId,
      `📷 *Upload Product Photo*\n\nStep 1 / 4 — Type the design number (e.g. \`9006\`).`,
      { parse_mode: 'Markdown' });
    return true;
  }
  if (data.startsWith('dap:dpick:')) {
    const design = data.slice('dap:dpick:'.length);
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'design_asset_flow') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' });
      return true;
    }
    session.design = design;
    sessionStore.set(uid, session);
    await bot.answerCallbackQuery(callbackQuery.id);
    await showDesignAssetContainerPicker(bot, chatId, uid);
    return true;
  }
  // CAT-C1 — container pick (index into session.containerChoices, or generic).
  if (data.startsWith('dap:ct:')) {
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'design_asset_flow') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' });
      return true;
    }
    const pick = data.slice('dap:ct:'.length);
    if (pick === 'generic') {
      session.arrivalBatch = '';
    } else {
      const idx = parseInt(pick, 10);
      const b = Array.isArray(session.containerChoices) ? session.containerChoices[idx] : undefined;
      if (b === undefined) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired — start again.', show_alert: true });
        return true;
      }
      session.arrivalBatch = b;
    }
    delete session.containerChoices;
    sessionStore.set(uid, session);
    await bot.answerCallbackQuery(callbackQuery.id);
    await showDesignAssetPhotoPrompt(bot, chatId, uid);
    return true;
  }
  if (data === 'dap:skipnames') {
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'design_asset_flow' || !session.staged) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' });
      return true;
    }
    // Single placeholder shade — admin can edit before submitting.
    session.staged.shades = [{ number: 1, name: 'Shade 1' }];
    session.staged.shadeCount = 1;
    session.staged.shadeNames = ['Shade 1'];
    session.step = 'preview';
    sessionStore.set(uid, session);
    await bot.answerCallbackQuery(callbackQuery.id);
    await sendDesignAssetPreview(bot, chatId, uid);
    return true;
  }
  // ── AUTO-DETECT: accept the model's shade proposal verbatim and skip
  // straight to the preview step. The employee can still hit "Edit shade
  // numbers / names" on the preview if they spot any small mismatch.
  if (data === 'dap:autoaccept') {
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'design_asset_flow' || !session.staged || !session.detectedShades) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' });
      return true;
    }
    const shades = session.detectedShades;
    session.staged.shades = shades;
    session.staged.shadeCount = shades.length;
    session.staged.shadeNames = shades.map((s) => s.name);
    session.step = 'preview';
    delete session.detectedShades;
    delete session.detectionConfidence;
    sessionStore.set(uid, session);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Using detected shades' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    await sendDesignAssetPreview(bot, chatId, uid);
    return true;
  }
  // ── AUTO-DETECT: reject the proposal and fall through to manual N:name
  // input. The proposal is still useful as a "starting point" — we seed
  // the manual prompt's example block with it.
  if (data === 'dap:manual') {
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'design_asset_flow') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' });
      return true;
    }
    const seed = session.detectedShades || null;
    delete session.detectedShades;
    delete session.detectionConfidence;
    session.step = 'shade_names';
    sessionStore.set(uid, session);
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    await showDesignAssetShadeNamesPromptAfterPhoto(bot, chatId, uid, seed);
    return true;
  }
  if (data === 'dap:editmeta') {
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'design_asset_flow' || !session.staged) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' });
      return true;
    }
    session.step = 'edit_meta';
    sessionStore.set(uid, session);
    await bot.answerCallbackQuery(callbackQuery.id);
    const current = formatShadesPreview(session.staged.shades);
    await bot.sendMessage(chatId,
      `✏️ *Edit shade numbers / names — ${session.staged.design}*\n\n` +
      `Current:\n${current}\n\n` +
      `Reply with the corrected list, comma-separated. Use *N:name* to set the physical tab number, e.g.\n` +
      `\`3:Dark Green, 4:Beige, 5:Dark Brown, 6:Olive, 7:Purple, 8:Sky Blue, 9:Cream, 10:Navy, 11:Green, 12:White\`\n\n` +
      `Or plain names if numbering should stay 1…N. Type *skip* for generic names.`,
      { parse_mode: 'Markdown' });
    return true;
  }
  if (data === 'dap:retake') {
    const session = sessionStore.get(uid);
    if (!session || session.type !== 'design_asset_flow') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired.' });
      return true;
    }
    session.step = 'photo';
    delete session.staged;
    delete session.previewFileId;
    sessionStore.set(uid, session);
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.sendMessage(chatId, '📷 Send the new photo now.');
    return true;
  }
  if (data === 'dap:submit') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Submitting...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    await submitDesignAssetForApproval(bot, chatId, uid, callbackQuery.message);
    return true;
  }

  /* DAM — manage flow (admin) */
  if (data === 'dam:back') {
    await bot.answerCallbackQuery(callbackQuery.id);
    // Delete the photo message (the one this callback is attached to).
    await bot.deleteMessage(chatId, callbackQuery.message.message_id).catch(() => {});
    await startManageDesignPhotos(bot, chatId, uid, null);
    return true;
  }
  if (data === 'dam:noop') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Pending items appear in the admin approval feed.' });
    return true;
  }
  if (data.startsWith('dam:pg:')) {
    const page = parseInt(data.slice('dam:pg:'.length), 10) || 0;
    await bot.answerCallbackQuery(callbackQuery.id);
    await showManageDesignPhotosPage(bot, chatId, uid, page, callbackQuery.message.message_id);
    return true;
  }
  if (data === 'dam:search') {
    if (!config.access.adminIds.includes(uid)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' });
      return true;
    }
    await bot.answerCallbackQuery(callbackQuery.id);
    sessionStore.set(uid, { type: 'design_asset_flow', step: 'manage_search', shadeNames: [], ttlMs: DESIGN_ASSET_TTL_MS });
    await bot.sendMessage(chatId,
      '🔎 *Search Manage Photos*\n\nType a design number to jump to it.\nType *cancel* to go back.',
      { parse_mode: 'Markdown' });
    return true;
  }
  if (data.startsWith('dam:view:')) {
    const design = data.slice('dam:view:'.length);
    await bot.answerCallbackQuery(callbackQuery.id);
    await showDesignAssetDetail(bot, chatId, uid, design, callbackQuery.message.message_id);
    return true;
  }
  if (data.startsWith('dam:replace:')) {
    const design = data.slice('dam:replace:'.length);
    if (!config.access.adminIds.includes(uid)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' });
      return true;
    }
    await bot.answerCallbackQuery(callbackQuery.id);
    sessionStore.clear(uid);
    sessionStore.set(uid, { type: 'design_asset_flow', step: 'photo', design, shadeNames: [], ttlMs: DESIGN_ASSET_TTL_MS });
    // Send a fresh prompt instance so the next step has a flowMessageId to edit.
    const sent = await bot.sendMessage(chatId, '📷 *Upload Product Photo*\n\nLoading…', { parse_mode: 'Markdown' });
    if (sent && sent.message_id) {
      const s = sessionStore.get(uid);
      if (s) { s.flowMessageId = sent.message_id; sessionStore.set(uid, s); }
    }
    // CAT-C1 — re-uploads also declare which container the photo shows.
    await showDesignAssetContainerPicker(bot, chatId, uid);
    return true;
  }
  if (data.startsWith('dam:editnames:')) {
    const design = data.slice('dam:editnames:'.length);
    if (!config.access.adminIds.includes(uid)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' });
      return true;
    }
    await bot.answerCallbackQuery(callbackQuery.id);
    sessionStore.set(uid, { type: 'design_asset_flow', step: 'edit_names', editingDesign: design, shadeNames: [], ttlMs: DESIGN_ASSET_TTL_MS });
    const row = await designAssetsRepo.findActive(design);
    const cur = row ? formatShadesPreview(row.shades || []) : '_(none)_';
    await bot.sendMessage(chatId,
      `✏️ *Edit shade numbers / names — ${design}*\n\n` +
      `Current:\n${cur}\n\n` +
      `Reply with the new list, comma-separated. Use *N:name* to set the physical tab number, e.g.\n` +
      `\`3:Dark Green, 4:Beige, 5:Dark Brown, …\`\n\n` +
      `Or plain names if numbering should stay 1…N. Type *cancel* to abort.`,
      { parse_mode: 'Markdown' });
    return true;
  }
  if (data.startsWith('dam:diag:')) {
    const design = data.slice('dam:diag:'.length);
    if (!config.access.adminIds.includes(uid)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' });
      return true;
    }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Running…' });
    await runDesignAssetDiagnostic(bot, chatId, design);
    return true;
  }
  if (data.startsWith('dam:deact:')) {
    const design = data.slice('dam:deact:'.length);
    if (!config.access.adminIds.includes(uid)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' });
      return true;
    }
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Deactivating...' });
    try {
      const row = await designAssetsRepo.findActive(design);
      if (row) {
        await designAssetsRepo.updateStatus(row.rowIndex, 'inactive', uid);
        await bot.sendMessage(chatId, `🗑️ Photo for *${design}* deactivated. Pickers will fall back to text-only until a new photo is uploaded.`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, `⚠️ No active photo for ${design}.`);
      }
    } catch (e) {
      await bot.sendMessage(chatId, `⚠️ Deactivate failed: ${e.message}`);
    }
    return true;
  }

  return false;
}

/**
 * Best-effort: send the active product photo as a *preview* message before
 * the next picker step (shade / quantity). Decorative only — never blocks
 * or interferes with the existing in-place edit flow. Falls back silently
 * if no photo is on file or sending fails.
 *
 * When `userId` is given and the photo lands successfully, we also clear
 * `session.flowMessageId`. This is critical: in-place edits target an
 * existing message at its original chronological slot; if we leave the
 * old flowMessageId in place, the *edited* picker stays above the freshly
 * sent photo. Clearing it forces the next picker render to be a brand-new
 * send, so the chat order becomes (photo) → (picker) — which is what the
 * user expects.
 *
 * Called from design-tap callback sites in supply-request, sample,
 * update-price, order, and report flows. Reports pass no userId and
 * are unaffected (they don't use flowMessageId anyway).
 */
async function maybeSendDesignPreview(bot, chatId, design, captionExtra, userId) {
  try {
    if (!design) return false;
    // Delete any previous design-preview photo so we never leave stale
    // photos for older designs hanging in the chat when the user picks
    // a different design or hits "Back to designs".
    if (userId) {
      const prior = sessionStore.get(userId);
      if (prior && prior.previewMessageId) {
        await bot.deleteMessage(chatId, prior.previewMessageId).catch(() => {});
        prior.previewMessageId = null;
        sessionStore.set(userId, prior);
      }
    }
    const captionPrefix = captionExtra ? `${captionExtra}\n` : '';
    // CAT-C1 — container-scoped flows (supply, bundle sale) carry
    // session.arrivalBatch: show THAT container's photo or the pending
    // notice, never another shipment's shades. The '(unlabelled)' sentinel
    // and container-less flows resolve to the newest active photo.
    let arrivalBatch;
    if (userId) {
      const s = sessionStore.get(userId);
      if (s && s.arrivalBatch && s.arrivalBatch !== inventoryRepository.UNLABELLED_BATCH) {
        arrivalBatch = s.arrivalBatch;
      }
    }
    const sent = await designAssetsService.sendDesignPhoto({
      bot, chatId, design, arrivalBatch,
      caption: `${captionPrefix}📷 *${design}*${arrivalBatch ? ` · 🚢 ${arrivalBatch}` : ''}`,
      returnSentMessage: true,
    });
    if (!sent) {
      logger.info(`maybeSendDesignPreview(${design}): no active asset or send failed`);
      return false;
    }
    if (userId) {
      const session = sessionStore.get(userId);
      if (session) {
        // Clear flowMessageId so the next picker is a brand-new send
        // *below* this photo (chronological order = photo first, then
        // picker). Track the photo id so we can delete it on navigation.
        if (session.flowMessageId) session.flowMessageId = null;
        if (sent && sent.message_id) session.previewMessageId = sent.message_id;
        sessionStore.set(userId, session);
      }
    }
    return true;
  } catch (e) {
    logger.warn(`maybeSendDesignPreview failed for ${design}: ${e.message}`);
    return false;
  }
}

/** Helper: delete the active preview photo (if any) and clear the session ref. */
async function clearDesignPreview(bot, chatId, userId) {
  if (!userId) return;
  const session = sessionStore.get(userId);
  if (session && session.previewMessageId) {
    await bot.deleteMessage(chatId, session.previewMessageId).catch(() => {});
    session.previewMessageId = null;
    sessionStore.set(userId, session);
  }
}

/**
 * Admin diagnostic — given a design number, walk through every step of
 * the photo dispatch pipeline and report exactly where it succeeds or
 * fails. Used to debug "I approved but no photo appears" reports.
 */
async function runDesignAssetDiagnostic(bot, chatId, design) {
  const lines = [];
  const tag = (icon, msg) => lines.push(`${icon} ${msg}`);
  tag('🔍', `*Diagnostic — ${design}*`);
  lines.push('');

  // 1. Sheet read.
  let allRows;
  try {
    allRows = await designAssetsRepo.getAll();
    tag('✅', `DesignAssets sheet read: ${allRows.length} total row${allRows.length === 1 ? '' : 's'}`);
  } catch (e) {
    tag('❌', `DesignAssets sheet read failed: ${e.message}`);
    await sendLong(bot, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  // 2. Filter for this design.
  const matching = allRows.filter((r) => String(r.design).toUpperCase() === String(design).toUpperCase());
  if (!matching.length) {
    tag('❌', `No row matches design *${design}* (case-insensitive).`);
    tag('💡', 'Either the upload was never persisted, or the Design column has different text. Check the DesignAssets sheet directly.');
    await sendLong(bot, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }
  tag('✅', `Found ${matching.length} row${matching.length === 1 ? '' : 's'} for ${design}:`);
  for (const r of matching) {
    const tfid = r.telegramFileId ? `cached(${r.telegramFileId.slice(0, 12)}…)` : '(none)';
    const drv = r.labeledDriveFileId ? `labeled(${r.labeledDriveFileId.slice(0, 12)}…)` : (r.rawDriveFileId ? `raw(${r.rawDriveFileId.slice(0, 12)}…)` : '(no drive id)');
    lines.push(`  • row ${r.rowIndex}: status=*${r.status}*, shades=${r.shadeCount}, telegram_file_id=${tfid}, drive=${drv}`);
  }

  // 3. findActive.
  const active = matching.find((r) => r.status === 'active');
  if (!active) {
    tag('❌', 'No row has status *active*. Pickers will not show a photo.');
    tag('💡', 'If this is supposed to be approved, an admin can run 🖼️ Manage Product Photos and confirm the latest row is marked active. If row exists but is "pending", the approval execution failed — check the bot logs.');
    await sendLong(bot, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }
  tag('✅', `Active row: row ${active.rowIndex}`);

  // 4. Try the dispatch pipeline.
  let dispatchInfo;
  try {
    dispatchInfo = await designAssetsService.getPhotoForSend(design);
  } catch (e) {
    tag('❌', `getPhotoForSend threw: ${e.message}`);
    await sendLong(bot, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }
  if (!dispatchInfo) {
    tag('❌', 'getPhotoForSend returned null — neither cached file_id nor Drive download succeeded.');
    tag('💡', 'Check the bot logs for "Drive download failed" — usually means the GOOGLE_CREDENTIALS_JSON service account does not have read access to the Drive folder.');
    await sendLong(bot, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }
  tag('✅', `Dispatch path: *${dispatchInfo.photoSource}*` + (dispatchInfo.photoSource === 'drive_buffer' ? ` (${(dispatchInfo.photo && dispatchInfo.photo.length) || 0} bytes)` : ''));

  // 5. Actually try to send the photo and report.
  try {
    const sent = await bot.sendPhoto(chatId, dispatchInfo.photo, {
      caption: `📷 *${design}* — diagnostic test send (source: ${dispatchInfo.photoSource})`,
      parse_mode: 'Markdown',
    });
    tag('✅', 'sendPhoto succeeded.');
    if (dispatchInfo.photoSource !== 'telegram_file_id' && sent && sent.photo && sent.photo.length) {
      const fid = sent.photo[sent.photo.length - 1].file_id;
      try {
        await designAssetsRepo.setTelegramFileId(active.rowIndex, fid);
        tag('💾', `Cached new file_id (${fid.slice(0, 12)}…) — subsequent sends will be instant.`);
      } catch (e) {
        tag('⚠️', `Send worked but file_id cache write failed: ${e.message}`);
      }
    }
  } catch (e) {
    tag('❌', `sendPhoto failed: ${e.message}`);
    tag('💡', 'Common causes: bot has no permission for this chat; Drive URL returns HTML interstitial (use Buffer path); image too large.');
  }

  await sendLong(bot, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
}

/* ─── DESIGN ASSET FLOW: View-on-demand button (Reports / Stock) ───
 * Consumers in list views show a 🖼 View button per design. Tapping it
 * sends the photo as a follow-up message without disturbing the report.
 */
async function handleDesignAssetViewCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('dav:')) return false;
  const design = data.slice('dav:'.length);
  const uid = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Loading photo…' });
  const ok = await designAssetsService.sendDesignPhoto({ bot, chatId, design });
  if (!ok) {
    await bot.sendMessage(chatId, `📷 No product photo on file for ${design}. An admin can add one via 📷 Catalog → Upload Product Photo.`);
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════════════════
 * CATALOG: Browse / Search / Stats — additional tappable options
 * ═══════════════════════════════════════════════════════════════════════ */

const DAB_PAGE_SIZE = 8;

async function startBrowseCatalog(bot, chatId, userId, messageId) {
  const session = sessionStore.get(userId);
  if (session && session.type !== 'catalog_browse') sessionStore.clear(userId);
  sessionStore.set(userId, { type: 'catalog_browse', page: 0, filter: null });
  await showCatalogBrowsePage(bot, chatId, userId, 0, messageId);
}

async function showCatalogBrowsePage(bot, chatId, userId, page, messageId) {
  const session = sessionStore.get(userId);

  let actives = [];
  try { actives = await designAssetsRepo.list('active'); } catch (_) {}
  if (!actives.length) {
    if (messageId) await bot.deleteMessage(chatId, messageId).catch(() => {});
    const sent = await bot.sendMessage(chatId,
      '📖 *Browse Catalog*\n\n_No product photos in the catalog yet._',
      { parse_mode: 'Markdown' });
    if (session && sent) { session.flowMessageId = sent.message_id; sessionStore.set(userId, session); }
    return;
  }

  let filtered = actives;
  if (session && session.filter) {
    const f = session.filter.toLowerCase();
    filtered = actives.filter((a) => (a.productType || '').toLowerCase() === f);
  }
  filtered.sort((a, b) => a.design.localeCompare(b.design, undefined, { numeric: true }));

  const totalPages = Math.max(1, Math.ceil(filtered.length / DAB_PAGE_SIZE));
  if (page < 0) page = 0;
  if (page >= totalPages) page = totalPages - 1;

  const slice = filtered.slice(page * DAB_PAGE_SIZE, (page + 1) * DAB_PAGE_SIZE);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, slice.length); j++) {
      const a = slice[j];
      row.push({ text: `📷 ${a.design} (${a.shadeCount})`, callback_data: `dab:view:${a.design.slice(0, 30)}` });
    }
    rows.push(row);
  }

  const nav = [];
  if (page > 0)              nav.push({ text: '⬅️ Prev', callback_data: `dab:pg:${page - 1}` });
  if (page < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `dab:pg:${page + 1}` });
  if (nav.length) rows.push(nav);

  const types = [...new Set(actives.map((a) => (a.productType || 'fabric').toLowerCase()))].sort();
  if (types.length > 1) {
    const filterRow = [];
    for (const t of types.slice(0, 4)) {
      const active = session && session.filter === t;
      filterRow.push({ text: `${active ? '✓ ' : ''}${t.charAt(0).toUpperCase() + t.slice(1)}`, callback_data: `dab:filter:${t.slice(0, 20)}` });
    }
    rows.push(filterRow);
    if (session && session.filter) {
      rows.push([{ text: '✖ Clear filter', callback_data: 'dab:filter:__clear__' }]);
    }
  }

  const filterLabel = session && session.filter ? ` (${session.filter})` : '';
  const header = `📖 *Browse Catalog*${filterLabel}\n\n` +
    `${filtered.length} design${filtered.length === 1 ? '' : 's'} with photos — page ${page + 1}/${totalPages}\n\n` +
    `Tap a design to view its photo and shades.`;

  // Try to edit the current message. If we can't (e.g. it was a photo
  // that got deleted), delete it and send a fresh text message.
  let sent;
  if (messageId) {
    try {
      sent = await bot.editMessageText(header, {
        chat_id: chatId, message_id: messageId,
        parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows },
      });
    } catch (_) {
      await bot.deleteMessage(chatId, messageId).catch(() => {});
      sent = await bot.sendMessage(chatId, header,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    }
  } else {
    sent = await bot.sendMessage(chatId, header,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  }
  if (session && sent && sent.message_id) {
    session.flowMessageId = sent.message_id;
    sessionStore.set(userId, session);
  }
}

async function showCatalogBrowseDetail(bot, chatId, userId, design, callerMessageId) {
  const session = sessionStore.get(userId);
  const row = await designAssetsRepo.findActive(design);
  if (!row) {
    await bot.sendMessage(chatId, `⚠️ No active photo for *${design}*.`, { parse_mode: 'Markdown' });
    return;
  }

  // Delete the text picker message so we replace it with the photo.
  if (callerMessageId) {
    await bot.deleteMessage(chatId, callerMessageId).catch(() => {});
  }

  const shadesText = formatShadesPreview(row.shades || []);
  const caption = `📖 *${row.design}* — ${row.productType || 'fabric'}\n` +
    `Shades (${row.shadeCount}): ${shadesText}`;

  const kb = { inline_keyboard: [
    [{ text: '◀️ Back to catalog', callback_data: 'dab:back' }],
  ] };

  const photoSrc = row.telegramFileId
    || (row.labeledDriveFileId ? `https://drive.google.com/uc?export=download&id=${row.labeledDriveFileId}` : '');
  if (photoSrc) {
    try {
      const sent = await bot.sendPhoto(chatId, photoSrc, { caption, parse_mode: 'Markdown', reply_markup: kb });
      if (session && sent) {
        session.flowMessageId = sent.message_id;
        sessionStore.set(userId, session);
      }
      if (!row.telegramFileId && sent && sent.photo && sent.photo.length) {
        designAssetsService.cacheTelegramFileId(row.rowIndex, sent.photo[sent.photo.length - 1].file_id).catch(() => {});
      }
      return;
    } catch (e) {
      logger.warn(`showCatalogBrowseDetail sendPhoto failed: ${e.message}`);
    }
  }
  const sent = await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: kb });
  if (session && sent) {
    session.flowMessageId = sent.message_id;
    sessionStore.set(userId, session);
  }
}

/* ─── SEARCH DESIGN PHOTO ─── */

async function startSearchDesignPhoto(bot, chatId, userId, messageId) {
  const prev = sessionStore.get(userId);
  // Clean up the current flow message (could be a photo or result text).
  if (prev && prev.flowMessageId && prev.flowMessageId !== messageId) {
    await bot.deleteMessage(chatId, prev.flowMessageId).catch(() => {});
  }
  sessionStore.clear(userId);
  sessionStore.set(userId, { type: 'catalog_search_flow', step: 'awaiting_query' });

  let actives = [];
  try { actives = await designAssetsRepo.list('active'); } catch (_) {}
  const rows = [];
  if (actives.length) {
    const recent = actives
      .filter((a) => a.uploadedAt)
      .sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''))
      .slice(0, 6);
    if (recent.length) {
      const btnRow = [];
      for (const a of recent) {
        btnRow.push({ text: `📷 ${a.design}`, callback_data: `das:pick:${a.design.slice(0, 30)}` });
        if (btnRow.length === 3) { rows.push([...btnRow]); btnRow.length = 0; }
      }
      if (btnRow.length) rows.push(btnRow);
    }
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'das:cancel' }]);

  const text = `🔎 *Search Design Photo*\n\n` +
    `Type a design number to look up its photo and shade info.\n` +
    (actives.length ? `\nOr tap a recently added design:` : '');
  const sent = await editOrSend(bot, chatId, messageId, text,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  if (sent && sent.message_id) {
    const s = sessionStore.get(userId);
    if (s) { s.flowMessageId = sent.message_id; sessionStore.set(userId, s); }
  }
}

async function handleCatalogSearchTextStep(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'catalog_search_flow') return false;

  if (text.toLowerCase() === 'cancel') {
    if (session.flowMessageId) {
      await bot.deleteMessage(chatId, session.flowMessageId).catch(() => {});
    }
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, '❌ Search cancelled.');
    return true;
  }

  const query = text.trim().toUpperCase();
  if (!query) {
    await bot.sendMessage(chatId, '⚠️ Please type a design number.');
    return true;
  }

  // showCatalogSearchResult will delete the flow message (prompt) and
  // send the result as a replacement.
  await showCatalogSearchResult(bot, chatId, userId, query);
  return true;
}

async function showCatalogSearchResult(bot, chatId, userId, query) {
  const session = sessionStore.get(userId);

  // Delete the previous flow message (prompt or prior result) to keep one active message.
  if (session && session.flowMessageId) {
    await bot.deleteMessage(chatId, session.flowMessageId).catch(() => {});
    session.flowMessageId = null;
    sessionStore.set(userId, session);
  }

  let allActive = [];
  try { allActive = await designAssetsRepo.list('active'); } catch (_) {}

  const exact = allActive.find((a) => a.design.toUpperCase() === query);
  const partials = exact
    ? []
    : allActive.filter((a) => a.design.toUpperCase().includes(query)).slice(0, 8);

  if (exact) {
    const shadesText = formatShadesPreview(exact.shades || []);
    const caption = `🔎 *${exact.design}* — ${exact.productType || 'fabric'}\n` +
      `Shades (${exact.shadeCount}): ${shadesText}`;
    const kb = { inline_keyboard: [
      [{ text: '🔎 Search another', callback_data: 'das:again' }],
    ] };
    const photoSrc = exact.telegramFileId
      || (exact.labeledDriveFileId ? `https://drive.google.com/uc?export=download&id=${exact.labeledDriveFileId}` : '');
    if (photoSrc) {
      try {
        const sent = await bot.sendPhoto(chatId, photoSrc, { caption, parse_mode: 'Markdown', reply_markup: kb });
        if (session && sent) { session.flowMessageId = sent.message_id; sessionStore.set(userId, session); }
        if (!exact.telegramFileId && sent && sent.photo && sent.photo.length) {
          designAssetsService.cacheTelegramFileId(exact.rowIndex, sent.photo[sent.photo.length - 1].file_id).catch(() => {});
        }
        return;
      } catch (e) {
        logger.warn(`showCatalogSearchResult sendPhoto failed: ${e.message}`);
      }
    }
    const sent = await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: kb });
    if (session && sent) { session.flowMessageId = sent.message_id; sessionStore.set(userId, session); }
    return;
  }

  if (partials.length) {
    const rows = [];
    for (let i = 0; i < partials.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, partials.length); j++) {
        row.push({ text: `📷 ${partials[j].design}`, callback_data: `das:pick:${partials[j].design.slice(0, 30)}` });
      }
      rows.push(row);
    }
    rows.push([{ text: '🔎 Search another', callback_data: 'das:again' }]);
    const sent = await bot.sendMessage(chatId,
      `🔎 No exact match for *${query}*, but found ${partials.length} similar:\n\nTap one to view its photo.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    if (session && sent) { session.flowMessageId = sent.message_id; sessionStore.set(userId, session); }
    return;
  }

  const sent = await bot.sendMessage(chatId,
    `🔎 No design photo found for *${query}*.\n\nMake sure the design has an approved photo in the catalog.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '🔎 Search another', callback_data: 'das:again' }],
    ] } });
  if (session && sent) { session.flowMessageId = sent.message_id; sessionStore.set(userId, session); }
}

/* ─── CATALOG STATS ─── */

async function showCatalogStats(bot, chatId, userId, messageId) {
  let all = [];
  try { all = await designAssetsRepo.getAll(); } catch (_) {}

  const active   = all.filter((r) => r.status === 'active');
  const pending  = all.filter((r) => r.status === 'pending');
  const replaced = all.filter((r) => r.status === 'replaced');
  const inactive = all.filter((r) => r.status === 'inactive');

  const byType = {};
  for (const a of active) {
    const t = (a.productType || 'fabric').toLowerCase();
    byType[t] = (byType[t] || 0) + 1;
  }
  const typeLines = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `  • ${t.charAt(0).toUpperCase() + t.slice(1)}: *${c}*`)
    .join('\n') || '  _(none)_';

  let totalShades = 0;
  let maxShades = { design: '—', count: 0 };
  for (const a of active) {
    totalShades += a.shadeCount || 0;
    if ((a.shadeCount || 0) > maxShades.count) {
      maxShades = { design: a.design, count: a.shadeCount };
    }
  }
  const avgShades = active.length ? (totalShades / active.length).toFixed(1) : '0';

  let inventoryDesigns = 0;
  try {
    const raw = await inventoryRepository.getDistinctDesigns();
    inventoryDesigns = [...new Set(raw.map((d) => (d.design || '').trim().toUpperCase()).filter(Boolean))].length;
  } catch (_) {}
  const coverage = inventoryDesigns > 0
    ? `${Math.round((active.length / inventoryDesigns) * 100)}% (${active.length}/${inventoryDesigns} designs)`
    : `${active.length} designs photographed`;

  const recentUploads = active
    .filter((a) => a.uploadedAt)
    .sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''))
    .slice(0, 5)
    .map((a) => `  • ${a.design} — ${fmtDate(a.uploadedAt) || a.uploadedAt}`)
    .join('\n') || '  _(none)_';

  const text = `📊 *Catalog Statistics*\n\n` +
    `*Status breakdown*\n` +
    `  ✅ Active: *${active.length}*\n` +
    `  ⏳ Pending: *${pending.length}*\n` +
    `  🔄 Replaced: *${replaced.length}*\n` +
    `  🗑️ Inactive: *${inactive.length}*\n\n` +
    `*By product type*\n${typeLines}\n\n` +
    `*Coverage*: ${coverage}\n\n` +
    `*Shade stats*\n` +
    `  Total shades across catalog: *${totalShades}*\n` +
    `  Average per design: *${avgShades}*\n` +
    `  Most shades: *${maxShades.design}* (${maxShades.count})\n\n` +
    `*Recently added*\n${recentUploads}`;

  const rows = [
    [{ text: '📖 Browse Catalog',       callback_data: 'dat:browse' }],
    [{ text: '🔎 Search Design Photo',  callback_data: 'dat:search' }],
    [{ text: '🔄 Refresh',              callback_data: 'dat:refresh' }],
  ];

  await editOrSend(bot, chatId, messageId, text,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

/* ─── MANAGE FLOW PAGINATION ─── */

const DAM_PAGE_SIZE = 10;

async function showManageDesignPhotosPage(bot, chatId, userId, page, messageId) {
  if (!config.access.adminIds.includes(userId)) {
    await bot.sendMessage(chatId, 'Admin only.');
    return;
  }
  let actives = [];
  try { actives = await designAssetsRepo.list('active'); } catch (_) {}
  let pending = [];
  try { pending = await designAssetsRepo.list('pending'); } catch (_) {}

  if (!actives.length && !pending.length) {
    await editOrSend(bot, chatId, messageId,
      '🖼️ *Manage Product Photos*\n\n_No photos uploaded yet._',
      { parse_mode: 'Markdown' });
    return;
  }

  actives.sort((a, b) => a.design.localeCompare(b.design, undefined, { numeric: true }));
  const totalPages = Math.max(1, Math.ceil(actives.length / DAM_PAGE_SIZE));
  if (page < 0) page = 0;
  if (page >= totalPages) page = totalPages - 1;

  const slice = actives.slice(page * DAM_PAGE_SIZE, (page + 1) * DAM_PAGE_SIZE);
  const rows = [];
  for (const a of slice) {
    rows.push([{ text: `📷 ${a.design} — ${a.shadeCount} shades`, callback_data: `dam:view:${String(a.design).slice(0, 30)}` }]);
  }
  if (pending.length) {
    rows.push([{ text: `⏳ ${pending.length} pending approval`, callback_data: 'dam:noop' }]);
  }

  const nav = [];
  if (page > 0)              nav.push({ text: '⬅️ Prev', callback_data: `dam:pg:${page - 1}` });
  if (page < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `dam:pg:${page + 1}` });
  if (nav.length) rows.push(nav);

  rows.push([{ text: '🔎 Search', callback_data: 'dam:search' }]);

  const msgText = `🖼️ *Manage Product Photos*\n\nActive: *${actives.length}* • Pending: *${pending.length}* — page ${page + 1}/${totalPages}\n\nTap a design to view, replace, or deactivate.`;
  const msgOpts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };

  // Try editMessageText first; if it fails (e.g. message was a photo),
  // delete the old message and send a fresh one.
  if (messageId) {
    try {
      await bot.editMessageText(msgText, { chat_id: chatId, message_id: messageId, ...msgOpts });
      return;
    } catch (_) {
      await bot.deleteMessage(chatId, messageId).catch(() => {});
    }
  }
  await bot.sendMessage(chatId, msgText, msgOpts);
}

/* ─── CALLBACK HANDLER for Browse / Search / Stats ─── */

async function handleCatalogBrowseSearchCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  const uid = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  /* DAB — browse catalog */
  if (data === 'dab:back') {
    await bot.answerCallbackQuery(callbackQuery.id);
    const session = sessionStore.get(uid);
    const page = (session && session.type === 'catalog_browse') ? (session.page || 0) : 0;
    // Delete the photo message and re-render the text list in its place.
    await bot.deleteMessage(chatId, messageId).catch(() => {});
    await showCatalogBrowsePage(bot, chatId, uid, page, null);
    return true;
  }
  if (data.startsWith('dab:pg:')) {
    const page = parseInt(data.slice('dab:pg:'.length), 10) || 0;
    await bot.answerCallbackQuery(callbackQuery.id);
    const session = sessionStore.get(uid);
    if (session && session.type === 'catalog_browse') {
      session.page = page;
      sessionStore.set(uid, session);
    }
    await showCatalogBrowsePage(bot, chatId, uid, page, messageId);
    return true;
  }
  if (data.startsWith('dab:view:')) {
    const design = data.slice('dab:view:'.length);
    await bot.answerCallbackQuery(callbackQuery.id);
    await showCatalogBrowseDetail(bot, chatId, uid, design, messageId);
    return true;
  }
  if (data.startsWith('dab:filter:')) {
    const filter = data.slice('dab:filter:'.length);
    await bot.answerCallbackQuery(callbackQuery.id);
    const session = sessionStore.get(uid) || { type: 'catalog_browse', page: 0 };
    session.filter = filter === '__clear__' ? null : filter;
    session.page = 0;
    sessionStore.set(uid, session);
    await showCatalogBrowsePage(bot, chatId, uid, 0, messageId);
    return true;
  }

  /* DAS — search design photo */
  if (data === 'das:cancel') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled' });
    // Delete the message the cancel button is on.
    await bot.deleteMessage(chatId, messageId).catch(() => {});
    sessionStore.clear(uid);
    return true;
  }
  if (data === 'das:again') {
    await bot.answerCallbackQuery(callbackQuery.id);
    // Delete the current result message, then re-show the search prompt.
    await bot.deleteMessage(chatId, messageId).catch(() => {});
    const session = sessionStore.get(uid);
    if (session) { session.flowMessageId = null; sessionStore.set(uid, session); }
    await startSearchDesignPhoto(bot, chatId, uid, null);
    return true;
  }
  if (data.startsWith('das:pick:')) {
    const design = data.slice('das:pick:'.length);
    await bot.answerCallbackQuery(callbackQuery.id);
    // flowMessageId points at the message this button is on — showCatalogSearchResult
    // will delete it before sending the result.
    const session = sessionStore.get(uid);
    if (session) { session.flowMessageId = messageId; sessionStore.set(uid, session); }
    await showCatalogSearchResult(bot, chatId, uid, design.toUpperCase());
    return true;
  }

  /* DAT — catalog stats quick links */
  if (data === 'dat:refresh') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Refreshing…' });
    designAssetsRepo.invalidateCache();
    await showCatalogStats(bot, chatId, uid, messageId);
    return true;
  }
  if (data === 'dat:browse') {
    await bot.answerCallbackQuery(callbackQuery.id);
    await startBrowseCatalog(bot, chatId, uid, messageId);
    return true;
  }
  if (data === 'dat:search') {
    await bot.answerCallbackQuery(callbackQuery.id);
    await startSearchDesignPhoto(bot, chatId, uid, messageId);
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
