/**
 * CRM service: customer management, balance tracking, payment recording.
 */

const customersRepo = require('../repositories/customersRepository');
const accountingService = require('../services/accountingService');
const idGen = require('../utils/idGenerator');
const { fmtMoney } = require('../utils/format');

// CUS-2 — findOrCreateCustomer is GONE. It was a zero-gate silent-creation
// door (no approval, no CUSTOMER_CREATION_ENABLED check, auto-Active) with
// no remaining callers; keeping it exported was one require away from
// reintroducing the typo problem CUS-1 exists to end.

async function addCustomer({ name, phone, address, category, credit_limit, payment_terms, notes }) {
  // CUS-2 — the creation door enforces the entity invariant: no new ACTIVE
  // customer may collide with an existing canonical name OR alias.
  const customerEntity = require('./customerEntity');
  const free = await customerEntity.assertNameFree(name);
  if (!free.ok) return { status: 'exists', customer: free.existing };
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
  // CUS-1 — resolve through the entity: id first, then canonical name, then
  // ALIAS, so a payment or ledger read for an old spelling still lands on
  // the real customer after a merge.
  const customerEntity = require('./customerEntity');
  return customerEntity.resolve({ id: nameOrId, name: nameOrId });
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
  await accountingService.recordPaymentReceived({ customer: cust.name, customerId: cust.customer_id, amount, method, userId, txnId });
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

module.exports = { addCustomer, getCustomer, searchCustomers, listCustomers, recordPayment, addToOutstanding, fmtMoney };
