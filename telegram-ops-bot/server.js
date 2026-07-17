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

// Webhook-only: omitting `polling: false` is identical to passing it (the lib
// defaults to no polling). Keeping the option around invited a future maintainer
// to flip it to `true`, which would race the production webhook for updates.
const bot = config.telegram.token ? new TelegramBot(config.telegram.token) : null;

const app = express();
app.use(express.json());

// SEC-P1 (H5): CORS for the admin settings page. Previously this reflected
// ANY `Origin` back (`req.headers.origin || '*'`), which — combined with the
// old forgeable `X-Telegram-User-Id` auth — let a malicious webpage call
// `PUT /api/settings` from a victim admin's browser. Now the allowed origins
// are an explicit env allow-list (ADMIN_ALLOWED_ORIGINS, comma-separated);
// when unset we fall back to `*` for GET-style reads but never echo an
// arbitrary origin. The forgeable Telegram-ID header is no longer an accepted
// auth header (see apiController) so it is dropped from the allow list too.
const ADMIN_ALLOWED_ORIGINS = config.adminAllowedOrigins || [];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ADMIN_ALLOWED_ORIGINS.length) {
    if (origin && ADMIN_ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// DEPLOY-C1: /health is what Railway probes BEFORE routing traffic to a
// new container. We return:
//   - 200 OK if the bot is past initial schema bootstrap (default state)
//   - 503 once we've received SIGTERM and are draining (Railway then
//     stops sending us new traffic, letting in-flight callbacks finish)
let _shuttingDown = false;
let _bootedAt = Date.now();
app.get('/health', (req, res) => {
  if (_shuttingDown) {
    return res.status(503).json({ ok: false, state: 'draining' });
  }
  return res.json({
    ok: true,
    service: 'telegram-ops-bot',
    uptimeSeconds: Math.round((Date.now() - _bootedAt) / 1000),
  });
});

app.get('/api/settings', apiController.getSettings);
app.put('/api/settings', apiController.updateSettings);

// ANL-1 — read-only usage analytics for the admin dashboard. Always
// key-gated (503 until BOT_API_KEY is set); serves usage_daily rollups only.
app.get('/api/analytics/summary', apiController.getAnalyticsSummary);
app.get('/api/analytics/feature/:code', apiController.getAnalyticsFeature);
// CNET-1c — contact-network payload for the atfactoryprice.live admin
// dashboard (contacts.html). Always key-gated.
app.get('/api/contacts/graph', apiController.getContactsGraph);

// TG-2: when TELEGRAM_WEBHOOK_SECRET is set, Telegram includes it in the
// `X-Telegram-Bot-Api-Secret-Token` header on every webhook POST. Reject
// any request that arrives without the matching token — this is the
// primary defence against anyone POSTing fake updates to the public
// webhook URL. The check happens BEFORE we acknowledge with 200 so
// spoofed requests don't even get a "delivered" signal.
const WEBHOOK_SECRET = config.telegram.webhookSecret || '';
if (!WEBHOOK_SECRET) {
  // SEC-P1 (C1): an unauthenticated webhook lets anyone who knows the public
  // URL POST forged updates with any `from.id` (including an admin's) and
  // drive sales/approvals/sheet writes.
  //
  // Enforcement is OPT-IN via REQUIRE_WEBHOOK_SECRET so this hardening can
  // ship BEFORE the secret exists on the host — turning fail-closed on by
  // default would crash-loop a running deploy that hasn't set the secret yet.
  // Activation order (see specs/SEC-P1-P2_PICKUP.md): set
  // TELEGRAM_WEBHOOK_SECRET → run `npm run set-webhook` → set
  // REQUIRE_WEBHOOK_SECRET=1 → redeploy. Once on, the process refuses to boot
  // without a secret instead of exposing an open webhook.
  if (config.requireWebhookSecret) {
    logger.error('FATAL: REQUIRE_WEBHOOK_SECRET=1 but TELEGRAM_WEBHOOK_SECRET is not set. Set the secret, run `npm run set-webhook`, then redeploy. Refusing to start with an unauthenticated webhook.');
    process.exit(1);
  }
  logger.warn('TELEGRAM_WEBHOOK_SECRET not set — webhook is UNAUTHENTICATED. Set it, run `npm run set-webhook`, then set REQUIRE_WEBHOOK_SECRET=1 to enforce.');
}

app.post('/webhook', (req, res) => {
  if (WEBHOOK_SECRET) {
    const incoming = req.headers['x-telegram-bot-api-secret-token'];
    if (incoming !== WEBHOOK_SECRET) {
      logger.warn(`webhook: rejected request with bad/missing secret token (ip=${req.ip || req.headers['x-forwarded-for'] || 'unknown'})`);
      return res.sendStatus(401);
    }
  }

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
const server = app.listen(PORT, async () => {
  _bootedAt = Date.now();
  logger.info(`Server listening on port ${PORT}. Webhook: ${config.baseUrl ? `${config.baseUrl}/webhook` : 'Set BASE_URL and run npm run set-webhook'}`);
  try {
    await schemaMapper.initialize();
    erpEventBus.registerListeners();
    // USR-C1: warm the in-process allow-list cache from the Users sheet so
    // the very first message after boot sees sheet-managed employees, not
    // only env-driven IDs. Failure is non-fatal — the env IDs still work.
    try { await require('./src/middlewares/auth').refresh(); } catch (_) {}
    // DCAT-1: warm the design→category snapshot so the very first card
    // after boot shows category labels (categoryOfSync reads this cache).
    try { await require('./src/repositories/designCategoriesRepository').getMap(); } catch (_) {}
    logger.info('ERP modules initialized');
    setInterval(() => { checkOrderReminders(); checkSampleFollowups(); checkCustomerFollowups(); checkColdCustomerAlerts(); }, REMINDER_INTERVAL_MS);
    logger.info('Scheduler started (hourly): orders, samples, follow-ups, cold alerts');
    // SJ-1 — minutely stale-flow janitor: tombstones hanging flow messages
    // after their (Settings-tunable) per-activity grace period lapses.
    require('./src/services/sessionJanitor').start(bot);
    // BKP-1 — daily snapshot of the master sheet into the backup Drive
    // folder (Settings-tunable hour/retention; admins DM'd on failure).
    require('./src/services/sheetBackup').start(bot);
    // APR-1 — pending-approval reminder: re-sends admin cards for stale
    // pending ApprovalQueue rows, covering approvals queued outside this
    // process (Drive photo imports) and missed one-shot cards. First pass
    // shortly after boot, then the service self-paces per
    // APPROVAL_REMINDER_HOURS (Settings, 0 disables).
    const approvalReminder = require('./src/services/approvalReminder');
    setTimeout(() => approvalReminder.sweep(bot), 60 * 1000);
    setInterval(() => approvalReminder.sweep(bot), 60 * 60 * 1000);
    // MORN-1 — 09:15 (Lagos) admin morning digest; categories toggle via
    // the ⏰ Morning Digest tile (Settings DIGEST_* keys, no deploy).
    require('./src/services/morningDigest').start(bot);
    // PG-1 — mirror Inventory → Postgres for parity checks (reads stay on
    // Sheets until PG-2). No-op when DATABASE_URL unset or mirror disabled.
    try { require('./src/services/inventoryMirrorService').start(); } catch (e) {
      logger.warn(`inventoryMirror start skipped: ${e.message}`);
    }
    // ANL-1 — usage analytics capture. No-op until ANALYTICS_ENABLED=1
    // (plus DATABASE_URL). Fire-and-forget: can never block a flow.
    try { require('./src/services/usageTracker').init(); } catch (e) {
      logger.warn(`usageTracker init skipped: ${e.message}`);
    }
    // ANL-1 — nightly usage_events → usage_daily rollup (02:00; D4).
    try { require('./src/services/usageRollupJob').start(); } catch (e) {
      logger.warn(`usageRollup start skipped: ${e.message}`);
    }
    // TRF-5 cleanup — close any still-pending legacy transfer_* approval
    // rows (retired actions the executor refuses anyway). One-shot, async.
    require('./src/services/legacyCleanup').rejectStaleLegacyTransfers()
      .catch((e) => logger.warn(`legacyCleanup failed: ${e.message}`));
  } catch (e) {
    logger.error('Init error (bot still running):', e.message);
  }
});

// DEPLOY-C1: graceful shutdown so Railway's container swap is zero-downtime.
//
// Sequence on SIGTERM (sent by Railway ~10s before SIGKILL):
//   1. Flip _shuttingDown=true → /health starts returning 503
//   2. Wait 2s so Railway's load balancer notices and stops sending us
//      new webhook traffic
//   3. Stop accepting new HTTP connections (server.close())
//   4. Give in-flight requests up to 7s to finish before exit
//
// Without this handler, container swaps drop every callback that's
// mid-flight — exactly the "tap goes nowhere" symptom we hit today.
function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  logger.info(`Shutdown signal received (${signal}). Draining…`);
  setTimeout(() => {
    server.close((err) => {
      if (err) {
        logger.error('server.close error during shutdown:', err.message);
        process.exit(1);
      }
      logger.info('HTTP server closed cleanly. Exiting.');
      process.exit(0);
    });
    // Hard timeout — if some socket refuses to close in 7s, force exit
    // anyway. Railway will SIGKILL us at ~10s total, so leave ourselves
    // a 1s buffer to log the forced exit.
    setTimeout(() => {
      logger.warn('Graceful shutdown timed out. Forcing exit.');
      process.exit(0);
    }, 7000).unref();
  }, 2000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
// Surface unhandled rejections in logs (silent failures are how the
// "tap does nothing" bug class hides itself).
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err.stack || err.message || err);
  // Don't auto-exit — Railway will restart us via restartPolicy if the
  // process dies, but most uncaught exceptions are recoverable (e.g.
  // a single bad webhook payload) and killing the bot for them would
  // be more disruptive than logging and continuing.
});
