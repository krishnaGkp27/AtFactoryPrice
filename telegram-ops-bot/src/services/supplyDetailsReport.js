'use strict';

/**
 * Supply Details reports.
 *
 * Behaviour-preserving extraction of the four "Supply Details" report
 * builders (Design-wise summary, Design date-wise, Customer-wise,
 * Warehouse-wise) and their supply-only helpers out of
 * `controllers/telegramController.js` (TG-8 prep).
 *
 * Cross-report helpers that are also used by Sales / other reports
 * (`fmtQty`, `buildReportLegend`, `valStrShort`, `valStrRow`,
 * `_supplyGroupRender`) remain owned by the controller and are injected
 * via {@link createSupplyDetailsReport} so there is a single source of
 * truth and no circular `require` between controller and service.
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const fmtDate = require('../utils/formatDate');

/**
 * Sold inventory rows (status `sold` with a buyer). Shared data source
 * for every Supply Details view.
 *
 * @returns {Promise<Array<object>>} Sold inventory rows.
 */
async function getSoldItems() {
  const all = await inventoryRepository.getAll();
  return all.filter((r) => r.status === 'sold' && r.soldTo);
}

/**
 * Normalise a raw sold-date into a sortable key + display string.
 * Accepts `YYYY-MM-DD`, `DD-MM-YYYY`, `DD/MM/YYYY` and long dates;
 * unparseable values sort last and display as-is.
 *
 * @param {string} raw
 * @returns {{ sort: string, display: string }}
 */
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

/**
 * Build the per-row-money toggle button row for supply reports.
 * The button alternates between "💰 Show prices per row" and
 * "💵 Hide row prices" depending on current state, both encoded via
 * the rxw: callback grammar.
 *
 * @param {string} reportType  rxw report type token (e.g. `supply_ds`).
 * @param {string} payload     Drill-down payload (empty for top-level).
 * @param {boolean} showRowMoney Current per-row money visibility.
 * @returns {Array<object>} A single inline-keyboard row.
 */
function buildRowMoneyToggleRow(reportType, payload, showRowMoney) {
  const label = showRowMoney ? '💵 Hide row prices' : '💰 Show prices per row';
  const flag = showRowMoney ? 'n' : 'y';
  return [{ text: label, callback_data: `rxw:${reportType}:${payload}::m=${flag}` }];
}

/**
 * @typedef {object} SupplyReportDeps Controller-owned shared helpers.
 * @property {(n:number)=>string} fmtQty
 * @property {(parts:string[], hasMoney:boolean)=>string} buildReportLegend
 * @property {(value:number, isAdmin:boolean)=>string} valStrShort
 * @property {(value:number, isAdmin:boolean, showRowMoney:boolean)=>string} valStrRow
 * @property {(args:{items:Array, isAdmin:boolean, expandAll:boolean, showRowMoney:boolean})=>{block:string, restCount:number, totalDesigns:number}} supplyGroupRender
 */

/**
 * Bind the Supply Details report builders to the controller-owned shared
 * helpers. Builders keep their original `(sold, isAdmin, opts)` signature
 * and produce byte-identical output to the pre-extraction controller.
 *
 * @param {SupplyReportDeps} deps Shared formatting/render helpers.
 * @returns {{
 *   buildDesignWiseReport: (sold: Array, isAdmin: boolean, opts?: object) => {text: string, keyboard: object|null},
 *   buildDesignDateWiseReport: (sold: Array, isAdmin: boolean, opts?: object) => {text: string, keyboard: object|null},
 *   buildCustomerWiseReport: (sold: Array, isAdmin: boolean, opts?: object) => {text: string, keyboard: object|null},
 *   buildWarehouseWiseReport: (sold: Array, isAdmin: boolean, opts?: object) => {text: string, keyboard: object|null},
 * }}
 */
function createSupplyDetailsReport(deps) {
  const { fmtQty, buildReportLegend, valStrShort, valStrRow, supplyGroupRender } = deps;

  function buildDesignWiseReport(sold, isAdmin, opts = {}) {
    // Per-design "summary" already groups by Design → Shade naturally.
    // Money is hidden per-row by default so the qty columns dominate;
    // it still appears at subtotal + grand total. The user can toggle
    // per-row money on with "💰 Show prices per row".
    const showRowMoney = !!opts.showRowMoney;
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
    let text = `📊 *Supply Details — Design Wise (Summary)*\n`;
    text += buildReportLegend(['Bales · thans · yds'], isAdmin);
    text += '\n';
    let grandPkgs = new Set(), grandThans = 0, grandYards = 0, grandValue = 0;
    for (const [design, dg] of sorted) {
      const shadesSorted = [...dg.shades.entries()].sort((a, b) => b[1].yards - a[1].yards);
      const topBuyer = [...dg.buyers.entries()].sort((a, b) => b[1] - a[1])[0];
      text += `📦 *${design}*${topBuyer ? `  · top buyer: ${topBuyer[0]}` : ''}\n`;
      for (const [shade, sh] of shadesSorted) {
        text += `   Shade ${shade}: ${sh.pkgs.size} Bales · ${sh.thans} thans · ${fmtQty(sh.yards)} yds${valStrRow(sh.value, isAdmin, showRowMoney)}\n`;
      }
      text += `   *Subtotal: ${dg.totalPkgs.size} Bales · ${dg.totalThans} thans · ${fmtQty(dg.totalYards)} yds${valStrShort(dg.totalValue, isAdmin)}*\n\n`;
      for (const p of dg.totalPkgs) grandPkgs.add(p);
      grandThans += dg.totalThans; grandYards += dg.totalYards; grandValue += dg.totalValue;
    }
    text += `🧮 *Grand Total: ${grandPkgs.size} Bales · ${grandThans} thans · ${fmtQty(grandYards)} yds${valStrShort(grandValue, isAdmin)}*`;
    const keyboard = isAdmin ? { inline_keyboard: [buildRowMoneyToggleRow('supply_ds', '', showRowMoney)] } : null;
    return { text, keyboard };
  }

  /**
   * Date-wise per-design supply report. List rendering with two
   * promotions:
   *   1. If a design has only one customer in the period, the customer
   *      gets pulled UP into the design header (no longer repeated on
   *      every row).
   *   2. The DATE is always promoted into a sub-header: rows for the
   *      same date are grouped under it instead of repeating the date
   *      on every line. This is the "push up the order" the user asked
   *      for — keeps the original column ordering, just removes the
   *      visual duplication.
   *
   * No code blocks (avoids the multi-fence Markdown parser bug); regular
   * Markdown renders reliably across all Telegram clients.
   */
  function buildDesignDateWiseReport(sold, isAdmin, opts = {}) {
    const showRowMoney = !!opts.showRowMoney;
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

    let text = `📊 *Supply Details — Design Wise (Date-wise)*\n`;
    text += buildReportLegend(['Bales · thans · yds'], isAdmin);
    text += '\n';
    let grandPkgs = new Set(), grandThans = 0, grandYards = 0, grandValue = 0;

    for (const { design, items } of designTotals) {
      const shades = new Set(items.map((r) => r.shade || '-'));
      const onlyShade = shades.size === 1 ? [...shades][0] : null;

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

      // If only one customer ever appears in this design's period,
      // promote that customer into the design header so per-row
      // repetition disappears.
      const customers = new Set(rows.map((r) => r.customer));
      const onlyCustomer = customers.size === 1 ? [...customers][0] : null;

      let dTotal = { pkgs: new Set(), thans: 0, yards: 0, value: 0 };
      for (const row of rows) {
        for (const p of row.pkgs) dTotal.pkgs.add(p);
        dTotal.thans += row.thans; dTotal.yards += row.yards; dTotal.value += row.value;
      }

      const headerCtx = [];
      if (onlyCustomer) headerCtx.push(`Customer: ${onlyCustomer}`);
      if (onlyShade) headerCtx.push(`Shade: ${onlyShade}`);
      text += `📦 *${design}*${headerCtx.length ? `  (${headerCtx.join(' · ')})` : ''}\n`;

      // Group by date and render each date as a sub-header. Within a
      // date, any field still varying (customer when there's >1, shade
      // when there's >1) is shown on its own row.
      const byDate = new Map();
      for (const row of rows) {
        if (!byDate.has(row.displayDate)) byDate.set(row.displayDate, []);
        byDate.get(row.displayDate).push(row);
      }
      for (const [date, dateRows] of byDate) {
        text += `📅 ${date}\n`;
        let dt = { pkgs: new Set(), thans: 0, yards: 0, value: 0 };
        for (const row of dateRows) {
          const parts = [];
          if (!onlyCustomer) parts.push(row.customer);
          if (!onlyShade) parts.push(`Shade ${row.shade}`);
          const lead = parts.length ? `${parts.join(' · ')}: ` : '';
          text += `   ${lead}${row.pkgs.size} Bales · ${row.thans} thans · ${fmtQty(row.yards)} yds${valStrRow(row.value, isAdmin, showRowMoney)}\n`;
          for (const p of row.pkgs) dt.pkgs.add(p);
          dt.thans += row.thans; dt.yards += row.yards; dt.value += row.value;
        }
        // Per-date subtotal — only emitted when there are multiple
        // dates AND multiple rows on this date. Single-row dates don't
        // need a subtotal because the row IS the subtotal.
        if (byDate.size > 1 && dateRows.length > 1) {
          text += `   _Subtotal: ${dt.pkgs.size} Bales · ${dt.thans} thans · ${fmtQty(dt.yards)} yds${valStrShort(dt.value, isAdmin)}_\n`;
        }
        text += '\n';
      }
      text += `*Total ${design}: ${dTotal.pkgs.size} Bales · ${dTotal.thans} thans · ${fmtQty(dTotal.yards)} yds${valStrShort(dTotal.value, isAdmin)}*\n\n`;
      for (const p of dTotal.pkgs) grandPkgs.add(p);
      grandThans += dTotal.thans; grandYards += dTotal.yards; grandValue += dTotal.value;
    }
    text += `🧮 *Grand Total: ${grandPkgs.size} Bales · ${grandThans} thans · ${fmtQty(grandYards)} yds${valStrShort(grandValue, isAdmin)}*`;
    const keyboard = isAdmin ? { inline_keyboard: [buildRowMoneyToggleRow('supply_dd', '', showRowMoney)] } : null;
    return { text, keyboard };
  }

  function buildCustomerWiseReport(sold, isAdmin, opts = {}) {
    const showRowMoney = !!opts.showRowMoney;
    const expandKey = (opts.expand || '').trim().toLowerCase();
    const customers = new Map();
    for (const r of sold) {
      const key = r.soldTo;
      if (!customers.has(key)) customers.set(key, { items: [], totalPkgs: new Set(), totalThans: 0, totalYards: 0, totalValue: 0 });
      const cg = customers.get(key);
      cg.items.push(r);
      cg.totalPkgs.add(r.packageNo); cg.totalThans++; cg.totalYards += r.yards; cg.totalValue += r.yards * r.pricePerYard;
    }
    const sorted = [...customers.entries()].sort((a, b) => b[1].totalValue - a[1].totalValue);
    let text = `📊 *Supply Details — Customer Wise*\n`;
    text += buildReportLegend(['Bales · thans · yds'], isAdmin);
    text += '\n';
    const buttons = [];
    let grandPkgs = new Set(), grandThans = 0, grandYards = 0, grandValue = 0;
    for (const [customer, cg] of sorted) {
      text += `👤 *${customer}* — ${cg.totalPkgs.size} Bales · ${cg.totalThans} thans · ${fmtQty(cg.totalYards)} yds${valStrShort(cg.totalValue, isAdmin)}\n`;
      const expandThis = expandKey === customer.toLowerCase();
      const block = supplyGroupRender({ items: cg.items, isAdmin, expandAll: expandThis, showRowMoney });
      if (block.block) text += block.block + '\n';
      if (block.restCount > 0) {
        text += `   _… and ${block.restCount} more design${block.restCount > 1 ? 's' : ''}_\n`;
        buttons.push([{ text: `🔍 ${customer} — show all (${block.totalDesigns})`, callback_data: `rxw:supply_c:${customer.slice(0, 50)}` }]);
      }
      text += '\n';
      for (const p of cg.totalPkgs) grandPkgs.add(p);
      grandThans += cg.totalThans; grandYards += cg.totalYards; grandValue += cg.totalValue;
    }
    text += `🧮 *Grand Total: ${grandPkgs.size} Bales · ${grandThans} thans · ${fmtQty(grandYards)} yds${valStrShort(grandValue, isAdmin)}*`;
    if (isAdmin) buttons.push(buildRowMoneyToggleRow('supply_c', '', showRowMoney));
    return { text, keyboard: buttons.length ? { inline_keyboard: buttons } : null };
  }

  function buildWarehouseWiseReport(sold, isAdmin, opts = {}) {
    const showRowMoney = !!opts.showRowMoney;
    const expandKey = (opts.expand || '').trim().toLowerCase();
    const warehouses = new Map();
    for (const r of sold) {
      const key = r.warehouse || 'Unknown';
      if (!warehouses.has(key)) warehouses.set(key, { items: [], totalPkgs: new Set(), totalThans: 0, totalYards: 0, totalValue: 0 });
      const wg = warehouses.get(key);
      wg.items.push(r);
      wg.totalPkgs.add(r.packageNo); wg.totalThans++; wg.totalYards += r.yards; wg.totalValue += r.yards * r.pricePerYard;
    }
    const sorted = [...warehouses.entries()].sort((a, b) => b[1].totalValue - a[1].totalValue);
    let text = `📊 *Supply Details — Warehouse Wise*\n`;
    text += buildReportLegend(['Bales · thans · yds'], isAdmin);
    text += '\n';
    const buttons = [];
    let grandPkgs = new Set(), grandThans = 0, grandYards = 0, grandValue = 0;
    for (const [wh, wg] of sorted) {
      text += `🏭 *${wh}* — ${wg.totalPkgs.size} Bales · ${wg.totalThans} thans · ${fmtQty(wg.totalYards)} yds${valStrShort(wg.totalValue, isAdmin)}\n`;
      const expandThis = expandKey === wh.toLowerCase();
      const block = supplyGroupRender({ items: wg.items, isAdmin, expandAll: expandThis, showRowMoney });
      if (block.block) text += block.block + '\n';
      if (block.restCount > 0) {
        text += `   _… and ${block.restCount} more design${block.restCount > 1 ? 's' : ''}_\n`;
        buttons.push([{ text: `🔍 ${wh} — show all (${block.totalDesigns})`, callback_data: `rxw:supply_w:${wh.slice(0, 50)}` }]);
      }
      text += '\n';
      for (const p of wg.totalPkgs) grandPkgs.add(p);
      grandThans += wg.totalThans; grandYards += wg.totalYards; grandValue += wg.totalValue;
    }
    text += `🧮 *Grand Total: ${grandPkgs.size} Bales · ${grandThans} thans · ${fmtQty(grandYards)} yds${valStrShort(grandValue, isAdmin)}*`;
    if (isAdmin) buttons.push(buildRowMoneyToggleRow('supply_w', '', showRowMoney));
    return { text, keyboard: buttons.length ? { inline_keyboard: buttons } : null };
  }

  return {
    buildDesignWiseReport,
    buildDesignDateWiseReport,
    buildCustomerWiseReport,
    buildWarehouseWiseReport,
  };
}

module.exports = {
  getSoldItems,
  createSupplyDetailsReport,
};
