/**
 * AtFactoryPrice Telegram Operations Bot — Entry point.
 * Webhook mode: Telegram sends updates to BASE_URL/webhook.
 */
require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const config = require('./src/config');
const telegramController = require('./src/controllers/telegramController');
const apiController = require('./src/controllers/apiController');
const logger = require('./src/utils/logger');
const schemaMapper = require('./src/services/schemaMapper');
const erpEventBus = require('./src/events/erpEventBus');

if (!config.telegram.token) {
  logger.warn('TELEGRAM_TOKEN not set. Bot will not start.');
}

const bot = config.telegram.token ? new TelegramBot(config.telegram.token, { polling: false }) : null;

const app = express();
app.use(express.json());

// Allow admin page (and any origin) to call /api/settings
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Telegram-User-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'telegram-ops-bot' });
});

app.get('/api/settings', apiController.getSettings);
app.put('/api/settings', apiController.updateSettings);

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (!body) return;

  if (body.callback_query) {
    if (bot) telegramController.handleCallbackQuery(bot, body.callback_query).catch((e) => logger.error('Callback error', e));
    return;
  }

  const msg = body.message;
  if (msg && msg.text) {
    if (bot) telegramController.handleMessage(bot, msg).catch((e) => logger.error('Message error', e));
  } else if (msg && (msg.photo || msg.document)) {
    if (bot) telegramController.handleFileMessage(bot, msg).catch((e) => logger.error('File message error', e));
  }
});

const REMINDER_INTERVAL_MS = 60 * 60 * 1000;

async function checkOrderReminders() {
  if (!bot) return;
  try {
    const ordersRepo = require('./src/repositories/ordersRepository');
    const pending = await ordersRepo.getPendingReminders();
    for (const order of pending) {
      try {
        await bot.sendMessage(order.salesperson_id,
          `⏰ *Reminder: Supply order ${order.order_id}*\n\nDesign: ${order.design}\nCustomer: ${order.customer}\nQuantity: ${order.quantity}\nScheduled: *${order.scheduled_date}* (tomorrow)\nPayment: ${order.payment_status}\n\nPlease prepare for delivery. Mark done with: "Mark order ${order.order_id} delivered"`,
          { parse_mode: 'Markdown' });
        await ordersRepo.updateStatus(order.order_id, 'accepted', { reminder_sent: 'true' });
        logger.info(`Reminder sent for order ${order.order_id} to ${order.salesperson_name}`);
      } catch (e) {
        logger.error(`Failed to send reminder for order ${order.order_id}`, e.message);
      }
    }
  } catch (e) {
    logger.error('Order reminder check failed:', e.message);
  }
}

async function checkSampleFollowups() {
  if (!bot) return;
  try {
    const samplesRepo = require('./src/repositories/samplesRepository');
    const pending = await samplesRepo.getPendingFollowups();
    for (const sample of pending) {
      const daysAgo = Math.floor((Date.now() - new Date(sample.date_given).getTime()) / 86400000);
      for (const adminId of config.access.adminIds) {
        try {
          await bot.sendMessage(adminId,
            `🔔 *Sample Follow-up: ${sample.sample_id}*\n\nDesign: ${sample.design}${sample.shade ? ' Shade ' + sample.shade : ''}\nType: ${sample.sample_type}\nCustomer: ${sample.customer}\nQty: ${sample.quantity} pcs\nGiven: ${sample.date_given} (${daysAgo} days ago)\n\nPlease follow up with the customer. Update with:\n"Sample ${sample.sample_id} returned" or "Sample ${sample.sample_id} converted"`,
            { parse_mode: 'Markdown' });
        } catch (e) {
          logger.error(`Failed to send sample followup to admin ${adminId}`, e.message);
        }
      }
      await samplesRepo.markReminderSent(sample.sample_id);
      logger.info(`Sample followup sent for ${sample.sample_id} (customer: ${sample.customer})`);
    }
  } catch (e) {
    logger.error('Sample followup check failed:', e.message);
  }
}

async function checkCustomerFollowups() {
  if (!bot) return;
  try {
    const followupsRepo = require('./src/repositories/customerFollowupsRepository');
    const pending = await followupsRepo.getPendingReminders();
    for (const f of pending) {
      for (const adminId of config.access.adminIds) {
        try {
          await bot.sendMessage(adminId,
            `📅 *Follow-up Reminder: ${f.customer}*\n\nReason: ${f.reason}\nScheduled: ${f.followup_date}\nID: ${f.followup_id}\n\nPlease reach out to the customer.`,
            { parse_mode: 'Markdown' });
        } catch (e) {
          logger.error(`Failed to send followup reminder to admin ${adminId}`, e.message);
        }
      }
      await followupsRepo.markReminderSent(f.followup_id);
      logger.info(`Follow-up reminder sent for ${f.followup_id} (customer: ${f.customer})`);
    }
  } catch (e) {
    logger.error('Customer followup check failed:', e.message);
  }
}

let lastColdAlertDay = '';
async function checkColdCustomerAlerts() {
  if (!bot) return;
  const today = new Date().toISOString().split('T')[0];
  const dayOfWeek = new Date().getDay();
  if (dayOfWeek !== 1 || lastColdAlertDay === today) return;
  lastColdAlertDay = today;
  try {
    const inventoryRepository = require('./src/repositories/inventoryRepository');
    const allInv = await inventoryRepository.getAll();
    const sold = allInv.filter((r) => r.status === 'sold' && r.soldTo);
    const customers = new Map();
    for (const r of sold) {
      if (!customers.has(r.soldTo)) customers.set(r.soldTo, '');
      if (r.soldDate > customers.get(r.soldTo)) customers.set(r.soldTo, r.soldDate);
    }
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const inactive = [...customers.entries()]
      .filter(([, lastDate]) => lastDate && lastDate < cutoffStr)
      .map(([name, lastDate]) => ({ name, lastDate, daysAgo: Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000) }))
      .sort((a, b) => b.daysAgo - a.daysAgo);
    if (!inactive.length) return;
    let msg = `⚠️ *Weekly Cold Customer Alert*\n_${inactive.length} customers inactive for 30+ days_\n\n`;
    for (const c of inactive.slice(0, 15)) {
      msg += `👤 *${c.name}* — Last activity: ${c.daysAgo}d ago (${c.lastDate})\n`;
    }
    if (inactive.length > 15) msg += `\n_... and ${inactive.length - 15} more_`;
    msg += `\n\nConsider reaching out. Use "Customer history <name>" for details.`;
    for (const adminId of config.access.adminIds) {
      try { await bot.sendMessage(adminId, msg, { parse_mode: 'Markdown' }); } catch (_) {}
    }
    logger.info(`Cold customer alert sent: ${inactive.length} inactive customers`);
  } catch (e) {
    logger.error('Cold customer alert failed:', e.message);
  }
}

const PORT = config.port;
app.listen(PORT, async () => {
  logger.info(`Server listening on port ${PORT}. Webhook: ${config.baseUrl ? `${config.baseUrl}/webhook` : 'Set BASE_URL and run npm run set-webhook'}`);
  try {
    await schemaMapper.initialize();
    erpEventBus.registerListeners();
    logger.info('ERP modules initialized');
    setInterval(() => { checkOrderReminders(); checkSampleFollowups(); checkCustomerFollowups(); checkColdCustomerAlerts(); }, REMINDER_INTERVAL_MS);
    logger.info('Scheduler started (hourly): orders, samples, follow-ups, cold alerts');
  } catch (e) {
    logger.error('Init error (bot still running):', e.message);
  }
});
