'use strict';

/**
 * sessionJanitor — SJ-1 stale-flow cleanup.
 *
 * Abandoned multi-step flows leave their anchored chat message "hanging"
 * with live-looking buttons after the session times out. The janitor
 * sweeps timed-out sessions once a minute and, after a per-activity grace
 * period, replaces the hanging message with a tombstone:
 *
 *   ⌛ Supply Request timed out — nothing was saved.
 *   [ 🏠 Back to menu ]
 *
 * Submitted / completed flows are never touched: they clear their session
 * deliberately (sessionStore.clear), which does NOT enter the cleanup
 * queue — only TIMEOUTS do. Cleanup is silent (no extra ping) and
 * audit-logged as `flow_expired`.
 *
 * Grace periods are Settings-editable (connectivity is inconsistent in
 * the field, so defaults are generous and everything can be tuned in the
 * Settings sheet without a deploy):
 *   FLOW_CLEANUP_MINUTES        default 30 — simple flows
 *   FLOW_CLEANUP_MINUTES_HEAVY  default 60 — cart/receiving flows where
 *                               re-entering data is costly
 *   FLOW_CLEANUP_HEAVY_TYPES    CSV of session types counted as heavy
 *
 * Sessions are keyed by user id and all flows run in private chats, so
 * chat id === user id for the edits below.
 */

const sessionStore = require('../utils/sessionStore');
const settingsRepository = require('../repositories/settingsRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const logger = require('../utils/logger');

const TICK_MS = 60 * 1000;
const SETTINGS_CACHE_MS = 5 * 60 * 1000;
const PENDING_MAX = 500;

/** Friendly names for tombstone text; anything unknown is humanized. */
const FLOW_LABELS = {
  supply_req_flow: 'Supply Request',
  grn_flow: 'Receive Goods',
  bulk_receive_flow: 'Add Stock (CSV)',
  photo_receive_flow: 'Photo Receive',
  bundle_sale_flow: 'Bundle Sale',
  order_flow: 'Quick Order',
  receipt_flow: 'Receipt Upload',
  landed_cost_flow: 'Landed Cost',
  po_new_flow: 'Procurement Order',
  update_price_flow: 'Update Price',
  transfer_package_flow: 'Transfer Package',
  transfer_than_flow: 'Transfer Than',
  return_than_flow: 'Return Than',
  add_customer_flow: 'Add Customer',
  sample_flow: 'Give Sample',
  sold_bales_flow: 'Sold Bales Lookup',
  unit_display_flow: 'Display Units',
  wh_audit_flow: 'Warehouse Audit',
};

const pending = [];
let _settingsCache = null;
let _settingsCacheTs = 0;
let _timer = null;

function humanize(type) {
  if (FLOW_LABELS[type]) return FLOW_LABELS[type];
  const words = String(type || '').replace(/_flow$/, '').replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'This process';
}

/** Resolve grace config from Settings (cached ~5 min). */
async function getConfig() {
  const now = Date.now();
  if (_settingsCache && now - _settingsCacheTs < SETTINGS_CACHE_MS) return _settingsCache;
  let s = {};
  try {
    s = await settingsRepository.getAll();
  } catch (_) { /* fall back to defaults below */ }
  const num = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);
  const heavyCsv = typeof s.FLOW_CLEANUP_HEAVY_TYPES === 'string' ? s.FLOW_CLEANUP_HEAVY_TYPES : '';
  _settingsCache = {
    defaultMs: num(s.FLOW_CLEANUP_MINUTES, 30) * 60 * 1000,
    heavyMs: num(s.FLOW_CLEANUP_MINUTES_HEAVY, 60) * 60 * 1000,
    heavyTypes: new Set(heavyCsv.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)),
  };
  _settingsCacheTs = now;
  return _settingsCache;
}

function invalidateConfigCache() {
  _settingsCache = null;
  _settingsCacheTs = 0;
}

function graceMsFor(type, cfg) {
  return cfg.heavyTypes.has(String(type || '').toLowerCase()) ? cfg.heavyMs : cfg.defaultMs;
}

/** Best-effort tombstone of one abandoned flow's chat messages. */
async function tombstone(bot, entry) {
  const chatId = entry.userId; // private chats: chat id === user id
  const text = `⌛ ${humanize(entry.type)} timed out — nothing was saved.\nStart again from the menu whenever you're ready.`;
  const keyboard = { inline_keyboard: [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]] };
  if (entry.flowMessageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: entry.flowMessageId, reply_markup: keyboard,
      });
    } catch (_) {
      // Photo/caption messages can't be text-edited — at least kill the buttons.
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: entry.flowMessageId });
      } catch (_) { /* message gone — nothing to clean */ }
    }
  }
  // Transient photo previews are ephemeral by design — delete outright.
  for (const mid of [entry.previewMessageId, entry.comboMessageId]) {
    if (!mid) continue;
    try { await bot.deleteMessage(chatId, mid); } catch (_) { /* already gone */ }
  }
  try {
    await auditLogRepository.append('flow_expired', { type: entry.type, step: entry.step }, entry.userId);
  } catch (_) { /* audit is best-effort */ }
}

/**
 * One janitor pass: expire timed-out sessions, then tombstone the ones
 * whose per-activity grace has lapsed. Exposed for tests and for the
 * interval installed by start().
 * @param {object} bot Telegram bot instance
 * @returns {Promise<number>} how many messages were tombstoned
 */
async function tick(bot) {
  if (!bot) return 0;
  sessionStore.sweepExpired();
  pending.push(...sessionStore.drainExpiredForCleanup());
  if (pending.length > PENDING_MAX) pending.splice(0, pending.length - PENDING_MAX);
  if (!pending.length) return 0;

  const cfg = await getConfig();
  const now = Date.now();
  let cleaned = 0;
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const entry = pending[i];
    if (now - entry.lastActiveAt < graceMsFor(entry.type, cfg)) continue;
    pending.splice(i, 1);
    try {
      await tombstone(bot, entry);
      cleaned += 1;
    } catch (e) {
      logger.warn(`sessionJanitor: cleanup failed for ${entry.userId}/${entry.type}: ${e.message}`);
    }
  }
  if (cleaned) logger.info(`sessionJanitor: tombstoned ${cleaned} abandoned flow message(s)`);
  return cleaned;
}

/**
 * Install the minutely janitor. Call once from server startup.
 * SJ-2 — also registers the read-expiry hook: when a RETURNING user's own
 * tap/message discovers their expired session, the hanging message is
 * tombstoned immediately (no grace wait — they're looking at it).
 * @param {object} bot Telegram bot instance
 * @param {{intervalMs?:number}} [opts]
 */
function start(bot, opts = {}) {
  if (_timer || !bot) return;
  const every = opts.intervalMs || TICK_MS;
  _timer = setInterval(() => { tick(bot).catch((e) => logger.warn(`sessionJanitor tick failed: ${e.message}`)); }, every);
  if (_timer.unref) _timer.unref();
  sessionStore.onExpiredByRead((snap) => {
    tombstone(bot, snap).catch((e) => logger.warn(`sessionJanitor: instant cleanup failed for ${snap.userId}/${snap.type}: ${e.message}`));
  });
  logger.info(`sessionJanitor started (every ${Math.round(every / 1000)}s, instant cleanup on user return)`);
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  sessionStore.onExpiredByRead(null);
}

module.exports = {
  start,
  stop,
  tick,
  invalidateConfigCache,
  _internals: { humanize, graceMsFor, getConfig, tombstone, pending, FLOW_LABELS },
};
