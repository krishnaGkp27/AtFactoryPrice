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
  }
});

const PORT = config.port;
app.listen(PORT, async () => {
  logger.info(`Server listening on port ${PORT}. Webhook: ${config.baseUrl ? `${config.baseUrl}/webhook` : 'Set BASE_URL and run npm run set-webhook'}`);
  try {
    await schemaMapper.initialize();
    erpEventBus.registerListeners();
    logger.info('ERP modules initialized');
  } catch (e) {
    logger.error('ERP init error (bot still running):', e.message);
  }
});
