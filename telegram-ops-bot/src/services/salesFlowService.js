/**
 * Sales flow service: manages guided multi-step sale entry,
 * validates fields, builds sale summary, and handles batch confirmation.
 */

const sessionStore = require('../utils/sessionStore');
const customersRepo = require('../repositories/customersRepository');
const usersRepo = require('../repositories/usersRepository');
const settingsRepo = require('../repositories/settingsRepository');
const inventoryService = require('./inventoryService');
const config = require('../config');

const CURRENCY = config.currency || 'NGN';
const SALE_FIELDS = ['customer', 'salesperson', 'paymentMode', 'salesDate'];

function fmtQty(n) { return Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 }); }
function fmtMoney(n) { return `${CURRENCY} ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`; }

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
    case 'customer': return 'Who is the customer?';
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
      const cust = await customersRepo.findByName(v);
      if (!cust) return { valid: false, message: `Customer "${v}" not found. Add them first with "Add customer ${v}".` };
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
      if (v.toLowerCase() === 'today') return { valid: true, value: new Date().toISOString().split('T')[0] };
      const parsed = parseDate(v);
      if (!parsed) return { valid: false, message: 'Invalid date. Use DD-MM-YYYY or YYYY-MM-DD or "today".' };
      return { valid: true, value: parsed };
    }
    default:
      return { valid: true, value: v };
  }
}

function parseDate(str) {
  const ddmmyyyy = str.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (ddmmyyyy) {
    const [, d, m, y] = ddmmyyyy;
    const date = new Date(y, m - 1, d);
    if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
  }
  const yyyymmdd = str.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (yyyymmdd) {
    const [, y, m, d] = yyyymmdd;
    const date = new Date(y, m - 1, d);
    if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
  }
  return null;
}

function startSession(userId, saleType, items, intentData) {
  const collected = {};
  if (intentData.customer) collected.customer = intentData.customer;
  if (intentData.salesperson) collected.salesperson = intentData.salesperson;
  if (intentData.paymentMode) collected.paymentMode = intentData.paymentMode;
  if (intentData.salesDate) {
    collected.salesDate = intentData.salesDate.toLowerCase() === 'today'
      ? new Date().toISOString().split('T')[0] : intentData.salesDate;
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
  text += `  Salesperson: ${collected.salesperson}\n`;
  text += `  Payment: ${collected.paymentMode}\n`;
  text += `  Date: ${collected.salesDate}\n\n`;

  let totalThans = 0, totalYards = 0, totalValue = 0;
  for (const item of items) {
    if (item.type === 'package') {
      const info = await inventoryService.getPackageSummary(item.packageNo);
      if (info) {
        text += `  Pkg ${item.packageNo}: ${info.design} ${info.shade}, ${info.availableThans} thans, ${fmtQty(info.availableYards)} yds (${info.warehouse})\n`;
        totalThans += info.availableThans;
        totalYards += info.availableYards;
        totalValue += info.availableYards * info.pricePerYard;
      } else {
        text += `  Pkg ${item.packageNo}: not found\n`;
      }
    } else if (item.type === 'than') {
      const info = await inventoryService.getPackageSummary(item.packageNo);
      const than = info?.thans?.find((t) => t.thanNo === item.thanNo);
      if (than) {
        text += `  Pkg ${item.packageNo} Than ${item.thanNo}: ${fmtQty(than.yards)} yds\n`;
        totalThans += 1;
        totalYards += than.yards;
        totalValue += than.yards * (info.pricePerYard || 0);
      }
    }
  }
  text += `\n  Total: ${totalThans} thans, ${fmtQty(totalYards)} yards, ${fmtMoney(totalValue)}`;
  return text;
}

function getSaleDetails(session) {
  return {
    salesDate: session.collected.salesDate || new Date().toISOString().split('T')[0],
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
