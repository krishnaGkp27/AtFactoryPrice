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

/**
 * MNU-1 — the bot's permanent entry points.
 *
 * Without these the ONLY way into the bot is to find a live keyboard in the
 * history, which is exactly the cold-start penalty the audit recorded: the
 * chat shows a one-word message sent twice in a morning purely to summon a
 * menu. A registered Menu button and a `/` command list make the menu one
 * tap away no matter what happened to the last one — which also means a
 * mis-tuned anchor threshold can never strand anybody.
 *
 * The Bot Info panel is populated for the same reason: it is the first
 * screen a new operator opens, and today it teaches them nothing.
 */
const COMMANDS = [
  { command: 'menu', description: 'Open the main menu' },
  { command: 'start', description: 'Start / re-open the bot' },
];
const SHORT_DESCRIPTION = 'AtFactoryPrice operations — stock, sales, approvals and reports.';
const DESCRIPTION = 'Operations bot for AtFactoryPrice. '
  + 'Tap /menu for stock, sales, approvals, reports and attendance. '
  + 'Every write is approved by an admin before it lands.';

async function registerEntryPoints() {
  // Each is independent: a failure on one must not block the others, and
  // none of them should fail the webhook registration that matters most.
  const steps = [
    ['commands', () => bot.setMyCommands(COMMANDS)],
    ['menu button', () => bot.setChatMenuButton({ menu_button: { type: 'commands' } })],
    ['short description', () => bot.setMyShortDescription(SHORT_DESCRIPTION)],
    ['description', () => bot.setMyDescription(DESCRIPTION)],
  ];
  for (const [label, run] of steps) {
    try {
      await run();
      console.log(`Registered bot ${label}.`);
    } catch (e) {
      console.warn(`Could not register bot ${label}: ${e.message}`);
    }
  }
}

bot.setWebHook(url, options)
  .then(async () => {
    console.log('Webhook set to', url);
    if (secret) {
      console.log('Secret token registered with Telegram (length: ' + secret.length + ').');
    } else {
      console.warn('No TELEGRAM_WEBHOOK_SECRET set — webhook is unauthenticated.');
    }
    await registerEntryPoints();
  })
  .catch((e) => {
    console.error('Failed to set webhook', e.message);
    process.exit(1);
  });
