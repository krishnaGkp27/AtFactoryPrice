/**
 * ERP Event Bus: simple EventEmitter that bridges existing inventory operations
 * to new ERP services (accounting, stock ledger, audit). Fire-and-forget pattern
 * so failures in ERP hooks never break existing flows.
 */

const { EventEmitter } = require('events');
const logger = require('../utils/logger');

const bus = new EventEmitter();
bus.setMaxListeners(20);

/**
 * H6 — raw ERP handlers, one per event, ERRORS PROPAGATE. `bus.emit` paths
 * stay fire-and-forget (registerListeners wraps each handler in a logging
 * catch), but `emitAsync` calls these directly so money-path callers can
 * detect "inventory applied but ledger append failed" instead of the
 * failure vanishing into a log line nobody reads.
 */
const handlers = {
  async sale(data) {
    const accountingService = require('../services/accountingService');
    const stockLedgerService = require('../services/stockLedgerService');
    const auditService = require('../services/auditService');
    const crmService = require('../services/crmService');
    await crmService.findOrCreateCustomer(data.customer);
    await accountingService.recordSale(data);
    await stockLedgerService.recordSaleOut(data);
    await auditService.log(data.userId, 'sale', 'inventory', data.txnId);
  },
  async return(data) {
    const accountingService = require('../services/accountingService');
    const stockLedgerService = require('../services/stockLedgerService');
    const auditService = require('../services/auditService');
    await accountingService.recordReturn(data);
    await stockLedgerService.recordReturnIn(data);
    await auditService.log(data.userId, 'return', 'inventory', data.txnId);
  },
  async stock_in(data) {
    const stockLedgerService = require('../services/stockLedgerService');
    const auditService = require('../services/auditService');
    await stockLedgerService.recordPurchaseIn(data);
    await auditService.log(data.userId, 'stock_in', 'inventory', data.txnId);
  },
  async payment_received(data) {
    const accountingService = require('../services/accountingService');
    const auditService = require('../services/auditService');
    await accountingService.recordPaymentReceived(data);
    await auditService.log(data.userId, 'payment_received', 'accounting', data.txnId);
  },
  async price_update(data) {
    const auditService = require('../services/auditService');
    await auditService.log(data.userId, 'price_update', 'inventory', data.label);
  },
};

function registerListeners() {
  for (const [event, handler] of Object.entries(handlers)) {
    bus.on(event, (data) => {
      handler(data).catch((e) => logger.error(`ERP ${event} hook error (non-blocking): ${e.message}`));
    });
  }
  logger.info('ERP event listeners registered');
}

/**
 * Run the ERP handler for an event and PROPAGATE failures (H6). Use on
 * money paths where the caller must know the ledger/audit write failed;
 * callers are responsible for catching and surfacing the error.
 */
function emitAsync(event, data) {
  const handler = handlers[event];
  if (!handler) return Promise.resolve();
  return handler(data);
}

module.exports = { bus, registerListeners, emitAsync };
