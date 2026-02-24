/**
 * Set Telegram webhook to BASE_URL/webhook.
 * Run: BASE_URL=https://your-app.onrender.com node scripts/set-webhook.js
 */

const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const token = process.env.TELEGRAM_TOKEN;
const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');

if (!token || !baseUrl) {
  console.error('Set TELEGRAM_TOKEN and BASE_URL in .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });
const url = `${baseUrl}/webhook`;

bot.setWebHook(url)
  .then(() => console.log('Webhook set to', url))
  .catch((e) => {
    console.error('Failed to set webhook', e.message);
    process.exit(1);
  });
