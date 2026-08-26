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
const { todayInLagos, lagosDayPlus } = require('./src/utils/dates');
const schemaMapper = require('./src/services/schemaMapper');
const erpEventBus = require('./src/events/erpEventBus');
const usageTracker = require('./src/services/usageTracker');

if (!config.telegram.token) {
  logger.warn('TELEGRAM_TOKEN not set. Bot will not start.');
}

// Webhook-only: omitting `polling: false` is identical to passing it (the lib
// defaults to no polling). Keeping the option around invited a future maintainer
// to flip it to `true`, which would race the production webhook for updates.
const bot = config.telegram.token ? new TelegramBot(config.telegram.token) : null;

/**
 * MNU-1 — teach the anchor tracker about every message the bot sends.
 *
 * The staleness signal is `latestMessageId - anchorMessageId`, i.e. how many
 * messages sit BELOW the live menu. Event messages — approval cards, the
 * morning digest, reminders — never become anchors, but they are exactly
 * what buries one. A tracker that could not see them would keep believing a
 * long-buried menu was still on screen. That is acceptance criterion AC9.
 *
 * Wrapping the single shared bot instance is what makes this total: every
 * caller in the codebase, including ones written later, is covered without
 * touching a single call site.
 */
if (bot) {
  // (The callback-answer recorder installs itself inside the dispatcher, so
  // the guarantee does not depend on this wiring — see telegramController.)
  const menuAnchor = require('./src/services/menuAnchor');
  for (const method of ['sendMessage', 'sendPhoto', 'sendDocument', 'sendMediaGroup']) {
    const original = bot[method];
    if (typeof original !== 'function') continue;
    bot[method] = async function trackedSend(chatId, ...rest) {
      const sent = await original.call(this, chatId, ...rest);
      try {
        // sendMediaGroup resolves with an array of messages.
        for (const m of (Array.isArray(sent) ? sent : [sent])) {
          if (m && m.message_id) menuAnchor.noteMessage(m.chat ? m.chat.id : chatId, m.message_id);
        }
      } catch (_) { /* tracking must never break a send */ }
      return sent;
    };
  }
}

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
  // SUP-1: the customer Supply Record page needs POST (a JSON OTP request is
  // preflighted) and Authorization (every /api/ext/supply* read is a bearer
  // session). Without both, ledger.html dies at the preflight and never
  // reaches a handler — and the failure reads as "the page is broken".
  //
  // SCOPED TO /api/ DELIBERATELY. This middleware is global, so announcing
  // POST for every path would also answer the preflight for `/webhook` —
  // teaching browsers they may send a cross-origin JSON POST at the bot's
  // update endpoint, which they refuse today. The API needs POST; the
  // webhook must keep the answer it has always given.
  const isApi = String(req.path || '').startsWith('/api/');
  res.setHeader('Access-Control-Allow-Methods', isApi ? 'GET, POST, PUT, OPTIONS' : 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', isApi ? 'Content-Type, X-API-Key, Authorization' : 'Content-Type, X-API-Key');
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

// WEB-2 — Ops Dashboard API (atfactoryprice.live admin pages; key-gated,
// read-only) + the dashboard page itself served straight from this app so
// it works the moment the domain points at Railway (Firebase hosting can
// serve the same file at /ops via its rewrite).
// EXT-1 — customer-facing OTP ledger (public, self-throttled) + the
// admin-only cumulative channel-usage metric for the website.
app.post('/api/ext/otp/request', apiController.postExtOtpRequest);
app.post('/api/ext/otp/verify', apiController.postExtOtpVerify);
app.get('/api/ext/ledger', apiController.getExtLedger);
// SUP-1 — the customer's Supply Record (atfactoryprice.live/ledger.html).
// Goods only: dates, designs, bales, yards, their own sale documents and the
// catalogue picture for a design they were actually supplied. Same bearer
// session as /api/ext/ledger; documents and photos stream through the bot so
// no Telegram file URL or bot token ever reaches the browser.
app.get('/api/ext/supply', apiController.getExtSupply);
app.get('/api/ext/supply/day/:day', apiController.getExtSupplyDay);
app.get('/api/ext/supply/doc/:day/:i', (req, res) => apiController.getExtSupplyDoc(req, res, bot));
app.get('/api/ext/design/:code/photo', (req, res) => apiController.getExtDesignPhoto(req, res, bot));
app.get('/api/ops/usage', apiController.getOpsUsage);
app.get('/api/ops/tasks', apiController.getOpsTasks);                   // GNT-1 employee gantt (read-only)
app.get('/api/ops/allocations', apiController.getOpsAllocations); // MYP-1
app.post('/api/ops/allocations', apiController.postOpsAllocation);      // MYP-1 §15c session-only write

app.get('/api/ops/overview', apiController.getOpsOverview);
app.get('/api/ops/approvals', apiController.getOpsApprovals);
// WEB-1 — one request in full (read-only; approve/reject stays in Telegram).
app.get('/api/ops/approvals/:requestId', apiController.getOpsApprovalDetail);
app.get('/api/ops/attendance', apiController.getOpsAttendance);
app.get('/api/ops/stocktakes', apiController.getOpsStockTakes);
/**
 * WEB-1 — the pages this server serves behind a magic-link session, and the
 * ONLY destinations /auth will redirect to.
 *
 * Derived from one list rather than hardcoded in two places: the redirect
 * whitelist used to name '/analytics', which no route ever served, so a link
 * built with `?to=/analytics` redeemed the single-use token and then landed
 * on a 404 — the token spent, the user stranded. One list cannot drift.
 */
const SESSION_PAGES = {
  '/ops': 'ops.html',
  '/allocations': 'allocations.html', // MYP-1 §15c — the allocation matrix
  '/gantt': 'gantt.html',             // GNT-1 — the employee work plan
};
for (const [route, file] of Object.entries(SESSION_PAGES)) {
  app.get(route, (req, res) => res.sendFile(require('path').join(__dirname, '..', file)));
}

// ANA-1a — magic-link login: the bot mints a single-use token; redeeming
// it here sets a role-scoped session cookie. Telegram IS the identity
// provider — no passwords. Invalid/expired links get a friendly page.
app.get('/auth', async (req, res) => {
  const webSessionService = require('./src/services/webSessionService');
  const out = await webSessionService.redeemLoginToken(req.query.t);
  if (!out) {
    return res.status(403).type('html').send(
      '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<body style="font-family:sans-serif;padding:40px;text-align:center">'
      + '<h2>Link expired</h2><p>Login links work once and expire after 5 minutes.<br>'
      + 'Open the bot and tap <b>📊 Dashboard</b> again for a fresh one.</p></body>');
  }
  res.setHeader('Set-Cookie',
    `afp_session=${out.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(require('./src/services/webSessionService').SESSION_TTL_MS / 1000)}${config.baseUrl.startsWith('https') ? '; Secure' : ''}`);
  const to = String(req.query.to || '/ops');
  res.redirect(Object.prototype.hasOwnProperty.call(SESSION_PAGES, to) ? to : '/ops');
});
app.get('/auth/logout', async (req, res) => {
  const raw = String(req.headers.cookie || '');
  const m = raw.match(/afp_session=([^;]+)/);
  if (m) await require('./src/services/webSessionService').destroySession(m[1]);
  res.setHeader('Set-Cookie', 'afp_session=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/ops');
});

// INV-1b — public invoice statement (token = capability; OTP phase comes
// with Meta onboarding). .pdf route MUST register before the HTML route so
// "/i/abc.pdf" doesn't resolve as token "abc.pdf".
const invoiceWebController = require('./src/controllers/invoiceWebController');
app.get('/i/:token.pdf', invoiceWebController.viewInvoicePdf);
app.get('/i/:token', invoiceWebController.viewInvoice);

// SLG-1 — per-customer Supply Ledger (goods only). Signed token IS the
// capability; invalid = plain 404. Docs proxied through the bot so no
// Telegram URL or token reaches the visitor.
const supplyLedgerWebController = require('./src/controllers/supplyLedgerWebController');
app.get('/sl/:token/doc/:day/:i', (req, res) => supplyLedgerWebController.viewDoc(req, res, bot));
app.get('/sl/:token', supplyLedgerWebController.viewPage);

// SHR-1 — tracked catalogue share links (signed token = capability; see
// specs/SHR-1_SHARE_TRACKING.md). GET-only so the website page never needs
// a CORS preflight; ACAO * because these are public capability endpoints —
// the ADMIN_ALLOWED_ORIGINS allow-list must not lock the customer page out.
const shareWebController = require('./src/controllers/shareWebController');
app.use('/api/share', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
app.get('/d/:token', shareWebController.viewPage);
app.get('/api/share/resolve/:token', shareWebController.resolve);
app.get('/api/share/e/:token', shareWebController.event);
app.get('/api/share/img/:token', shareWebController.image);
app.get('/api/analytics/shares', apiController.getShareAnalytics);

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

/**
 * MNU-1 — remember recently-handled update ids so a redelivered update is
 * dropped instead of producing a second greeting. Bounded ring: Telegram
 * only ever retries recent updates, so a few thousand ids is ample and the
 * memory cost is fixed.
 */
const _seenUpdates = new Set();
const _seenOrder = [];
const SEEN_UPDATES_MAX = 4096;

/** @returns {boolean} true if this update is NEW and should be processed. */
function seenUpdate(updateId) {
  const id = String(updateId);
  if (_seenUpdates.has(id)) {
    logger.warn(`webhook: dropped duplicate update_id=${id}`);
    return false;
  }
  _seenUpdates.add(id);
  _seenOrder.push(id);
  if (_seenOrder.length > SEEN_UPDATES_MAX) _seenUpdates.delete(_seenOrder.shift());
  return true;
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

  // MNU-1 / audit D-1 — idempotency on update_id.
  //
  // The greeting was arriving 2-3x per summon, and only the last copy carried
  // a keyboard, so the history filled with prompts that look interactive and
  // are not. The 200 above is sent BEFORE any processing, so slow handlers
  // cannot be the cause; redelivery around a restart can, and there was no
  // dedupe at any layer. Cheap, total, and it protects every handler at once.
  if (body.update_id != null && !seenUpdate(body.update_id)) return;

  // Any message the bot can see buries the live menu a little further —
  // including the user's own, which is also the strongest re-anchor signal.
  try {
    const m = body.message || body.edited_message
      || (body.callback_query && body.callback_query.message);
    if (m && m.chat && m.message_id) {
      require('./src/services/menuAnchor').noteMessage(m.chat.id, m.message_id);
    }
  } catch (_) { /* tracking must never break dispatch */ }

  if (body.callback_query) {
    if (bot) {
      telegramController.handleCallbackQuery(bot, body.callback_query).catch((e) => {
        logger.error('Callback error', e);
        // ANL-2 — a handler that threw out of dispatch is the error KPI.
        usageTracker.trackError(body.callback_query.from && body.callback_query.from.id, 'callback', e.message);
      });
    }
    return;
  }

  // SRCH-1 — inline as-you-type inventory search (@bot <query> anywhere).
  // Requires inline mode enabled once via BotFather /setinline.
  if (body.inline_query) {
    if (bot) require('./src/services/searchService').handleInlineQuery(bot, body.inline_query).catch((e) => logger.error('Inline query error', e));
    return;
  }

  const msg = body.message;
  if (msg && msg.text) {
    // ANL-2 — a typed message while a wizard is live is a step of that
    // wizard (taps alone under-counted text-heavy flows).
    if (msg.from) usageTracker.trackTextStep(msg.from.id);
    if (bot) {
      telegramController.handleMessage(bot, msg).catch((e) => {
        logger.error('Message error', e);
        usageTracker.trackError(msg.from && msg.from.id, 'message', e.message);
      });
    }
  } else if (msg && (msg.photo || msg.document)) {
    // ANL-2 — media uploads had no usage hook of any kind.
    if (msg.from) usageTracker.trackMedia(msg.from.id, msg.photo ? 'photo' : 'document');
    if (bot) {
      telegramController.handleFileMessage(bot, msg).catch((e) => {
        logger.error('File message error', e);
        usageTracker.trackError(msg.from && msg.from.id, 'file', e.message);
      });
    }
  } else if (msg && msg.location) {
    // ATT-C4 — GPS shares for attendance verification (previously dropped).
    if (bot) {
      telegramController.handleLocationMessage(bot, msg).catch((e) => {
        logger.error('Location message error', e);
        usageTracker.trackError(msg.from && msg.from.id, 'location', e.message);
      });
    }
  }
});

const REMINDER_INTERVAL_MS = 60 * 60 * 1000;

async function checkOrderReminders() {
  if (!bot) return;
  try {
    const ordersRepo = require('./src/repositories/ordersRepository');
    const reminderPolicy = require('./src/services/reminderPolicy');
    const pending = await ordersRepo.getPendingReminders();
    for (const order of pending) {
      // APR-2: member nudges are per-department opt-in. Skipping does NOT
      // mark the reminder sent — switching the department on later still
      // delivers it.
      if (!(await reminderPolicy.shouldRemindUser(order.salesperson_id))) continue;
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
  // APR-2: admin-directed nudges are opt-in (REMINDER_HOURS_ADMIN > 0).
  if (!(await require('./src/services/reminderPolicy').hoursForAdmin())) return;
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
  // APR-2: admin-directed nudges are opt-in (REMINDER_HOURS_ADMIN > 0).
  if (!(await require('./src/services/reminderPolicy').hoursForAdmin())) return;
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
  // APR-2: admin-directed nudges are opt-in (REMINDER_HOURS_ADMIN > 0).
  if (!(await require('./src/services/reminderPolicy').hoursForAdmin())) return;
  // TIME-1 — the Monday gate and the dedupe day follow the LAGOS calendar:
  // on the UTC clock this alert could fire ~00:30 Lagos on a Tuesday.
  const today = todayInLagos();
  const dayOfWeek = new Date(`${today}T12:00:00Z`).getUTCDay();
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
    // RMV-1 (owner, 16-Aug-2026) — this list is derived from Inventory sold
    // rows alone and never opened the Customers register, so a REMOVED
    // customer could never leave it: they will not buy again, their
    // days-since-activity only grows, and the sort is descending — they
    // would head this DM to every admin permanently. Drop the ones the
    // register says are gone. History itself is untouched (§12): we are
    // filtering a nudge, not rewriting what they bought.
    let liveNames = null;
    try {
      const customersRepository = require('./src/repositories/customersRepository');
      const all = await customersRepository.getAll();
      liveNames = new Set(all
        .filter((c) => String(c.status || 'Active').trim().toLowerCase() !== 'inactive')
        .map((c) => String(c.name || '').trim().toLowerCase())
        .filter(Boolean));
    } catch (e) {
      // A failed read must not silently empty the alert — fall back to the
      // pre-RMV-1 behaviour of nudging on every name history knows.
      logger.warn(`Cold customer alert: customer register unread (${e.message}); not filtering removed customers`);
      liveNames = null;
    }
    const stillLive = (name) => !liveNames || liveNames.has(String(name || '').trim().toLowerCase());

    const cutoffStr = lagosDayPlus(-30);  // TIME-1 — soldDate is a Lagos day
    const inactive = [...customers.entries()]
      .filter(([name, lastDate]) => lastDate && lastDate < cutoffStr && stillLive(name))
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
  // PG-1b/EXT-1 — durable-store bootstrap + the expired-row sweep run in
  // their OWN block BEFORE the main init, so a schemaMapper failure (live
  // Sheets API can 429/500) can never skip the sweep and let ext_otp /
  // ext_sessions / web_sessions / ext_throttle grow unbounded.
  try { require('./src/db/extSchema').ensure(); } catch (e) { logger.warn(`extSchema boot: ${e.message}`); }
  // SHR-1 — share_events bootstrap (no-op without DATABASE_URL).
  try { require('./src/services/shareTrackService').ensureSchema(); } catch (e) { logger.warn(`shareSchema boot: ${e.message}`); }
  // STK-PG — versioned migrations (stock_events shadow ledger; no-op
  // without DATABASE_URL). Awaited nowhere: a PG outage never delays boot.
  try { require('./src/db/migrations').migrate().catch((e) => logger.warn(`migrations boot: ${e.message}`)); } catch (e) { logger.warn(`migrations boot: ${e.message}`); }
  try {
    const extLedgerService = require('./src/services/extLedgerService');
    extLedgerService.sweepExpired().catch(() => {});
    const sweepTimer = setInterval(() => extLedgerService.sweepExpired().catch(() => {}), 60 * 60 * 1000);
    if (sweepTimer.unref) sweepTimer.unref();
  } catch (e) { logger.warn(`extLedger sweep schedule: ${e.message}`); }
  try {
    await schemaMapper.initialize();
    erpEventBus.registerListeners(bot);
    // USR-C1: warm the in-process allow-list cache from the Users sheet so
    // the very first message after boot sees sheet-managed employees, not
    // only env-driven IDs. Failure is non-fatal — the env IDs still work.
    try { await require('./src/middlewares/auth').refresh(); } catch (_) {}
    // DCAT-1: warm the design→category snapshot so the very first card
    // after boot shows category labels (categoryOfSync reads this cache).
    try { await require('./src/repositories/designCategoriesRepository').getMap(); } catch (_) {}
    // CUS-1 — every Customers row must carry a customer_id (the entity key).
    // Hand-added sheet rows arrive without one; backfill is a no-op when
    // clean and non-fatal when Sheets is unreachable.
    try { await require('./src/services/customerEntity').ensureIds(); } catch (_) {}
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
    // TRID-1 — one-shot duplicate-transfer-id repair (owner-approved
    // 01-Aug): renames PENDING rows whose TR id collides with a resolved
    // row, so by-id routing stops opening the wrong transfer. Idempotent —
    // a clean queue is a no-op. Runs BEFORE the reminder sweep so reminders
    // never re-send cards under a colliding id.
    const queueRepair = require('./src/services/queueRepair');
    setTimeout(() => {
      queueRepair.dedupeTransferIds(bot)
        .then((r) => { if (r.repaired.length || r.skippedPendingOnly || r.failed) logger.info(`queueRepair: ${JSON.stringify(r)}`); })
        .catch((e) => logger.warn(`queueRepair boot pass failed: ${e.message}`));
    }, 20 * 1000);
    // REP-2 — one-off guarded bale swap for transfer 02Aug·01 (owner,
    // 02-Aug): the pre-TRF-14 FIFO pre-pick logged 867/842/873/863 while
    // the truck carries 869/843/874/864. Fingerprint-matched, state-guarded,
    // idempotent — once swapped (or if the transfer was rejected) it no-ops.
    setTimeout(() => {
      require('./src/services/transferRepair').repair(bot)
        .then((r) => logger.info(`transferRepair: ${JSON.stringify(r)}`))
        .catch((e) => logger.warn(`transferRepair boot pass failed: ${e.message}`));
    }, 30 * 1000);
    // INV-HDR1 — one-off guarded cleanup of the two orphan Inventory
    // headers (prev_state/state_since) left by the reverted 480d46e.
    // Clears X1:Y1 ONLY when both columns are provably empty; a no-op on
    // every later boot.
    // INV-HDR2 also restores a header cell that has gone broken (`#ERROR!`,
    // another Sheets error value, or blank) back to its canonical name —
    // stands down if any cell holds a real but unexpected word.
    setTimeout(() => {
      require('./src/services/inventoryHeaderRepair').repairAll(bot)
        .then((r) => {
          if (r.orphans.cleared || r.orphans.dataCells) logger.info(`inventoryHeaderRepair: ${JSON.stringify(r.orphans)}`);
          if (r.brokenCells.fixed.length) logger.warn(`inventoryHeaderRepair: ${JSON.stringify(r.brokenCells)}`);
        })
        .catch((e) => logger.warn(`inventoryHeaderRepair boot pass failed: ${e.message}`));
    }, 35 * 1000);
    // CUS-ID1 — guarded one-off: re-key the 10 customers minted onto 4
    // shared ids (restart-reset counter) and re-file their ledger/invoice
    // rows by narration name. Exact-triple guards; no-op once done.
    setTimeout(() => {
      require('./src/services/customerIdRepair').repair(bot)
        .then((r) => { if (r && (r.rekeyed || []).length) logger.info(`customerIdRepair: ${JSON.stringify(r.rekeyed)}`); })
        .catch((e) => logger.warn(`customerIdRepair boot pass failed: ${e.message}`));
    }, 40 * 1000);
    // TRF-INT3 — same-warehouse duplicate bale numbers DM'd to admins until
    // resolved physically (the intake gate blocks new ones; read-only scan).
    setTimeout(() => {
      require('./src/services/baleAuditReport').report(bot)
        .catch((e) => logger.warn(`baleAuditReport boot pass failed: ${e.message}`));
    }, 45 * 1000);
    const approvalReminder = require('./src/services/approvalReminder');
    setTimeout(() => approvalReminder.sweep(bot), 60 * 1000);
    setInterval(() => approvalReminder.sweep(bot), 60 * 60 * 1000);
    // MORN-1 — 09:15 (Lagos) admin morning digest; categories toggle via
    // the ⏰ Morning Digest tile (Settings DIGEST_* keys, no deploy).
    require('./src/services/morningDigest').start(bot);
    // EXP-1 — 🌇 20:00 (Lagos) office-expense report to the finance team
    // (admins for now) + nothing-filed reminder. EXPENSE_REPORT_* Settings.
    require('./src/services/eveningExpenseReport').start(bot);
    // SEN-1 — nightly read-only cross-sheet consistency checks (Data
    // Health). SENTINEL_ENABLED / SENTINEL_HOUR in Settings, no deploy.
    require('./src/services/consistencySentinel').startScheduler(bot);
    // ATT-C3 — 09:00 attendance nudge to department members who haven't
    // marked yet (report-by 09:30, owner 19-Jul). ATTENDANCE_* Settings.
    require('./src/services/attendanceReminder').start(bot);
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
    // BANK-3 — repair any "X — X" BANK_LIST entry approved before the flow
    // fix (e.g. "OPAY — OPAY"). Idempotent; writes nothing when clean.
    require('./src/services/legacyCleanup').normalizeBankList()
      .catch((e) => logger.warn(`legacyCleanup BANK_LIST failed: ${e.message}`));
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
