/**
 * Sales flow service: manages guided multi-step sale entry,
 * validates fields, builds sale summary, and handles batch confirmation.
 */

const sessionStore = require('../utils/sessionStore');
const { todayInLagos } = require('../utils/dates');
const customersRepo = require('../repositories/customersRepository');
const usersRepo = require('../repositories/usersRepository');
const settingsRepo = require('../repositories/settingsRepository');
const inventoryService = require('./inventoryService');
const { fmtMoney, fmtQty: fmtQtyBase } = require('../utils/format');

/**
 * Fields the REQUESTER is asked for.
 *
 * DSP-1 (owner, 26-Jul-2026): `customer` and `paymentMode` are deliberately
 * NOT here. The dispatcher raises what physically leaves the warehouse; the
 * admin attaches the buyer and the payment terms when approving. Adding
 * either one back re-opens the bypass this change exists to close — the
 * pipeline prompts for every missing field, so a listed field IS a question
 * put to the requester.
 */
const SALE_FIELDS = ['salesperson', 'salesDate'];

// Sales flow shows fractional yards (e.g. 12.5 yds), so we keep two decimals.
function fmtQty(n) { return fmtQtyBase(n, { maxFraction: 2 }); }

async function getBankList() {
  const all = await settingsRepo.getAll();
  const raw = all.BANK_LIST || '';
  return raw.split(',').map((b) => b.trim()).filter(Boolean);
}

async function getPaymentOptions() {
  const banks = await getBankList();
  return ['Cash', 'Credit', ...banks];
}

function getMissingFields(collected) {
  return SALE_FIELDS.filter((f) => !collected[f]);
}

function getNextQuestion(missingField, paymentOptions) {
  switch (missingField) {
    case 'customer': return 'Customer? Type an existing customer name, say **List** to see customers, or **New customer** to add one with details.';
    case 'salesperson': return 'Salesperson name?';
    case 'paymentMode': return `Payment mode? (${paymentOptions.join(' / ')})`;
    case 'salesDate': return 'Sales date? (type a date like 25-02-2026 or "today")';
    default: return null;
  }
}

async function validateField(field, value) {
  const v = (value || '').trim();
  if (!v) return { valid: false, message: 'Please provide a value.' };

  switch (field) {
    case 'customer': {
      if (/^new\s+customer$/i.test(v)) return { valid: false, message: '__NEW_CUSTOMER__' };
      if (/^list$/i.test(v)) {
        const list = await customersRepo.getAll();
        const names = list.filter((c) => (c.status || 'Active').toLowerCase() === 'active').slice(0, 20).map((c) => c.name);
        return { valid: false, message: names.length ? `Existing customers: ${names.join(', ')}. Type a name or say New customer.` : 'No customers yet. Say New customer to add one.' };
      }
      const cust = await customersRepo.findByName(v);
      if (!cust) return { valid: false, message: `Customer "${v}" not found. Type another name or say New customer.` };
      return { valid: true, value: cust.name };
    }
    case 'salesperson': {
      const users = await usersRepo.getAll();
      const match = users.find((u) => u.name.toLowerCase() === v.toLowerCase());
      if (!match) {
        const envAuth = require('../middlewares/auth');
        if (v.toLowerCase() === 'admin') return { valid: true, value: 'Admin' };
        return { valid: false, message: `Salesperson "${v}" not registered. Registered users: ${users.map((u) => u.name).join(', ') || 'none yet'}` };
      }
      return { valid: true, value: match.name };
    }
    case 'paymentMode': {
      const options = await getPaymentOptions();
      const match = options.find((o) => o.toLowerCase() === v.toLowerCase());
      if (!match) return { valid: false, message: `Invalid payment mode. Options: ${options.join(', ')}` };
      return { valid: true, value: match };
    }
    case 'salesDate': {
      if (v.toLowerCase() === 'today') return { valid: true, value: todayInLagos() };  // TIME-1
      const parsed = parseDate(v);
      if (!parsed) return { valid: false, message: 'Invalid date. Use DD-MM-YYYY or YYYY-MM-DD or "today".' };
      return { valid: true, value: parsed };
    }
    default:
      return { valid: true, value: v };
  }
}

/**
 * TIME-1 — a typed date is already a calendar day; it needs no clock and no
 * timezone. Building a local Date and slicing its UTC ISO made the answer
 * depend on where the server runs (and silently shifted a day on any host
 * behind UTC). Validate the parts, then emit them.
 */
function parseDate(str) {
  const pad = (n) => String(n).padStart(2, '0');
  const ok = (y, m, d) => {
    const yi = +y, mi = +m, di = +d;
    if (mi < 1 || mi > 12 || di < 1 || di > 31) return null;
    // Reject a day the month does not have (31-Feb), using UTC so the check
    // itself carries no timezone.
    const probe = new Date(Date.UTC(yi, mi - 1, di));
    if (probe.getUTCMonth() !== mi - 1 || probe.getUTCDate() !== di) return null;
    return `${yi}-${pad(mi)}-${pad(di)}`;
  };
  const ddmmyyyy = str.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (ddmmyyyy) { const [, d, m, y] = ddmmyyyy; return ok(y, m, d); }
  const yyyymmdd = str.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (yyyymmdd) { const [, y, m, d] = yyyymmdd; return ok(y, m, d); }
  return null;
}

function startSession(userId, saleType, items, intentData) {
  const collected = {};
  if (intentData.customer) collected.customer = intentData.customer;
  if (intentData.salesperson) collected.salesperson = intentData.salesperson;
  if (intentData.paymentMode) collected.paymentMode = intentData.paymentMode;
  if (intentData.salesDate) {
    collected.salesDate = intentData.salesDate.toLowerCase() === 'today'
      ? todayInLagos() : intentData.salesDate;  // TIME-1
  }

  sessionStore.set(userId, {
    type: 'sale_flow',
    saleType,
    items,
    collected,
    pendingField: null,
    awaitingConfirmation: false,
  });
  return collected;
}

function getSession(userId) {
  const s = sessionStore.get(userId);
  if (!s || s.type !== 'sale_flow') return null;
  return s;
}

async function buildSummary(session) {
  const { saleType, items, collected } = session;
  let text = 'Sale Summary:\n';
  text += `  Customer: ${collected.customer}\n`;
  try {
    const cust = await customersRepo.findByName(collected.customer);
    if (cust) {
      if (cust.phone) text += `  Phone: ${cust.phone}\n`;
      if (cust.address) text += `  Address: ${cust.address}\n`;
    }
  } catch (_) {}
  text += `  Salesperson: ${collected.salesperson}\n`;
  text += `  Payment: ${collected.paymentMode}\n`;
  text += `  Date: ${collected.salesDate}\n\n`;

  let totalThans = 0, totalYards = 0, totalValue = 0;
  for (const item of items) {
    if (item.type === 'package') {
      // TRF-INT4 — scoped to the item's own warehouse when it carries one.
      const info = await inventoryService.getPackageSummary(item.packageNo, { warehouse: item.warehouse });
      if (info) {
        text += `  Bale ${item.packageNo}: ${info.design} ${info.shade}, ${info.availableThans} thans, ${fmtQty(info.availableYards)} yds (${info.warehouse})\n`;
        totalThans += info.availableThans;
        totalYards += info.availableYards;
        totalValue += info.availableYards * info.pricePerYard;
      } else {
        text += `  Bale ${item.packageNo}: not found\n`;
      }
    } else if (item.type === 'than') {
      // TRF-INT4 — scoped to the item's own warehouse when it carries one.
      const info = await inventoryService.getPackageSummary(item.packageNo, { warehouse: item.warehouse });
      const than = info?.thans?.find((t) => t.thanNo === item.thanNo);
      if (than) {
        text += `  Bale ${item.packageNo} Than ${item.thanNo}: ${fmtQty(than.yards)} yds\n`;
        totalThans += 1;
        totalYards += than.yards;
        totalValue += than.yards * (info.pricePerYard || 0);
      }
    }
  }
  const totalPkgs = new Set(items.map((i) => i.packageNo)).size;
  text += `\n  Total: ${totalPkgs} Bale${totalPkgs === 1 ? '' : 's'} (${totalThans} thans), ${fmtQty(totalYards)} yards, ${fmtMoney(totalValue)}`;
  return text;
}

function getSaleDetails(session) {
  return {
    salesDate: session.collected.salesDate || todayInLagos(),  // TIME-1
    customerName: session.collected.customer || '',
    salesPerson: session.collected.salesperson || '',
    paymentMode: session.collected.paymentMode || '',
  };
}

module.exports = {
  getBankList,
  getPaymentOptions,
  getMissingFields,
  getNextQuestion,
  validateField,
  startSession,
  getSession,
  buildSummary,
  getSaleDetails,
  SALE_FIELDS,
  fmtMoney,
};
