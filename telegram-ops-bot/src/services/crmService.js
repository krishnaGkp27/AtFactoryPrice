/**
 * CRM service: customer management, balance tracking, payment recording.
 */

const customersRepo = require('../repositories/customersRepository');
const accountingService = require('../services/accountingService');
const idGen = require('../utils/idGenerator');
const config = require('../config');

const CURRENCY = config.currency || 'NGN';

async function findOrCreateCustomer(name) {
  if (!name) return null;
  let customer = await customersRepo.findByName(name);
  if (customer) return customer;
  const newCust = {
    customer_id: idGen.customer(),
    name,
    category: 'Retail',
    status: 'Active',
  };
  await customersRepo.append(newCust);
  return { ...newCust, outstanding_balance: 0, credit_limit: 0 };
}

async function addCustomer({ name, phone, address, category, credit_limit, payment_terms, notes }) {
  const existing = await customersRepo.findByName(name);
  if (existing) return { status: 'exists', customer: existing };
  const cust = {
    customer_id: idGen.customer(),
    name, phone: phone || '', address: address || '',
    category: category || 'Retail', credit_limit: credit_limit || 0,
    outstanding_balance: 0, payment_terms: payment_terms || 'COD',
    notes: notes || '', status: 'Active',
  };
  await customersRepo.append(cust);
  return { status: 'created', customer: cust };
}

async function getCustomer(nameOrId) {
  let c = await customersRepo.findById(nameOrId);
  if (!c) c = await customersRepo.findByName(nameOrId);
  return c;
}

async function searchCustomers(query) {
  return customersRepo.searchByName(query);
}

async function listCustomers() {
  return customersRepo.getAll();
}

async function recordPayment({ customer, amount, method, userId }) {
  const cust = await getCustomer(customer);
  if (!cust) return { status: 'not_found', message: `Customer "${customer}" not found.` };
  const txnId = `PAY-${Date.now()}`;
  await accountingService.recordPaymentReceived({ customer: cust.name, amount, method, userId, txnId });
  const newBalance = Math.max(0, cust.outstanding_balance - amount);
  await customersRepo.updateOutstanding(cust.customer_id, newBalance);
  return { status: 'completed', customer: cust.name, paid: amount, previousBalance: cust.outstanding_balance, newBalance };
}

async function addToOutstanding(customerName, amount) {
  const cust = await customersRepo.findByName(customerName);
  if (!cust) return;
  const newBalance = cust.outstanding_balance + amount;
  await customersRepo.updateOutstanding(cust.customer_id, newBalance);
}

function fmtMoney(v) { return `${CURRENCY} ${Number(v).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`; }

module.exports = { findOrCreateCustomer, addCustomer, getCustomer, searchCustomers, listCustomers, recordPayment, addToOutstanding, fmtMoney };
