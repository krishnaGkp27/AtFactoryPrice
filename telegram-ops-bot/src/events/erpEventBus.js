/**
 * ERP Event Bus: simple EventEmitter that bridges existing inventory operations
 * to new ERP services (accounting, stock ledger, audit). Fire-and-forget pattern
 * so failures in ERP hooks never break existing flows.
 */

const { EventEmitter } = require('events');
const logger = require('../utils/logger');

const bus = new EventEmitter();
bus.setMaxListeners(20);

function registerListeners() {
  const accountingService = require('../services/accountingService');
  const stockLedgerService = require('../services/stockLedgerService');
  const auditService = require('../services/auditService');
  const crmService = require('../services/crmService');

  bus.on('sale', async (data) => {
    try {
      await crmService.findOrCreateCustomer(data.customer);
      await accountingService.recordSale(data);
      await stockLedgerService.recordSaleOut(data);
      await auditService.log(data.userId, 'sale', 'inventory', data.txnId);
    } catch (e) { logger.error('ERP sale hook error (non-blocking):', e.message); }
  });

  bus.on('return', async (data) => {
    try {
      await accountingService.recordReturn(data);
      await stockLedgerService.recordReturnIn(data);
      await auditService.log(data.userId, 'return', 'inventory', data.txnId);
    } catch (e) { logger.error('ERP return hook error (non-blocking):', e.message); }
  });

  bus.on('stock_in', async (data) => {
    try {
      await stockLedgerService.recordPurchaseIn(data);
      await auditService.log(data.userId, 'stock_in', 'inventory', data.txnId);
    } catch (e) { logger.error('ERP stock_in hook error (non-blocking):', e.message); }
  });

  bus.on('payment_received', async (data) => {
    try {
      await accountingService.recordPaymentReceived(data);
      await auditService.log(data.userId, 'payment_received', 'accounting', data.txnId);
    } catch (e) { logger.error('ERP payment hook error (non-blocking):', e.message); }
  });

  bus.on('price_update', async (data) => {
    try {
      await auditService.log(data.userId, 'price_update', 'inventory', data.label);
    } catch (e) { logger.error('ERP price_update hook error (non-blocking):', e.message); }
  });

  logger.info('ERP event listeners registered');
}

module.exports = { bus, registerListeners };
