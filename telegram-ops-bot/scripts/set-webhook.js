/**
 * Set Telegram webhook to BASE_URL/webhook.
 * Run: BASE_URL=https://your-app.onrender.com node scripts/set-webhook.js
 */

const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const token = process.env.TELEGRAM_TOKEN;
const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';

if (!token || !baseUrl) {
  console.error('Set TELEGRAM_TOKEN and BASE_URL in .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });
const url = `${baseUrl}/webhook`;

// TG-2: register the secret with Telegram so it stamps every webhook
// POST with `X-Telegram-Bot-Api-Secret-Token`. The server.js handler
// rejects any request that arrives without the matching value.
const options = secret ? { secret_token: secret } : {};

bot.setWebHook(url, options)
  .then(() => {
    console.log('Webhook set to', url);
    if (secret) {
      console.log('Secret token registered with Telegram (length: ' + secret.length + ').');
    } else {
      console.warn('No TELEGRAM_WEBHOOK_SECRET set — webhook is unauthenticated.');
    }
  })
  .catch((e) => {
    console.error('Failed to set webhook', e.message);
    process.exit(1);
  });
