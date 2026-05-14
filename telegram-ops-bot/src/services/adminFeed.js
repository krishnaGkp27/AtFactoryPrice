/**
 * Admin Activity Feed (T2).
 *
 * Single fan-out point for "broadcast" notifications that should reach
 * admins (and other principals later). Each admin can opt OUT per
 * event type via the Notifications screen, persisted in the
 * Users.notification_prefs column.
 *
 * Why this exists:
 *   - Multiple call sites in controllers used to loop over
 *     `config.access.adminIds` and call `bot.sendMessage` directly.
 *     That made it impossible to centrally honor per-admin preferences
 *     or to add new principals (finance, dept heads) later.
 *   - This service is the single chokepoint. New event types live in
 *     DEFAULT_POLICY below; the UI in notificationsFlow.js renders one
 *     toggle per type.
 *
 * Backward compatibility:
 *   - When a user has no prefs row (or an empty/malformed JSON),
 *     DEFAULT_POLICY decides. The default for every event type that
 *     existed before T2 is `true` — so today's behavior is preserved
 *     until an admin explicitly toggles something off.
 *   - New (T2-introduced) event types default to `false` so the system
 *     doesn't ambush admins with new noise on install.
 */

'use strict';

const config = require('../config');
const usersRepo = require('../repositories/usersRepository');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Event catalog
// ---------------------------------------------------------------------------
// Tuple format: [eventType, label, group, defaultOn]
//
// `label` is what the toggle screen renders; `group` is a UI bucket
// (📋 Tasks / 🛒 Orders / 💰 Finance). `defaultOn` is what
// DEFAULT_POLICY returns when the user has no override stored.
//
// Order in this list is the order of the toggle screen.
// ---------------------------------------------------------------------------

const CATALOG = Object.freeze([
  ['task.assigned',    'Task assigned in your org',          'tasks',   true ],
  ['task.completed',   'Task signed off (completed)',        'tasks',   true ],
  ['task.dropped',     'Task dropped by a manager',          'tasks',   true ],
  ['task.declined',    'Doer declined a task',               'tasks',   true ],
  ['task.priority',    'Priority changed on a live task',    'tasks',   false],

  ['order.created',    'New order proposed',                 'orders',  true ],
  ['order.accepted',   'Order accepted by salesperson',      'orders',  true ],
  ['order.delivered',  'Order delivered',                    'orders',  true ],

  ['payout.paid',      'Payout disbursed (finance only)',    'finance', true ],
]);

const DEFAULT_POLICY = Object.freeze(
  Object.fromEntries(CATALOG.map(([k, , , def]) => [k, def]))
);

const GROUP_META = Object.freeze({
  tasks:   { icon: '📋', label: 'Tasks' },
  orders:  { icon: '🛒', label: 'Orders / Sales' },
  finance: { icon: '💰', label: 'Finance' },
});

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * @returns {boolean} whether `eventType` should be delivered given the
 *   user's stored prefs. Missing/malformed prefs fall back to
 *   DEFAULT_POLICY for that event.
 */
function isEnabled(prefs, eventType) {
  if (!prefs || typeof prefs !== 'object' || prefs._malformed) {
    return DEFAULT_POLICY[eventType] !== false;
  }
  if (Object.prototype.hasOwnProperty.call(prefs, eventType)) {
    return !!prefs[eventType];
  }
  return DEFAULT_POLICY[eventType] !== false;
}

/**
 * Broadcast a feed event to every admin who has it enabled. Best-effort:
 * per-admin failures are logged and swallowed so one bad chat_id never
 * blocks the rest.
 *
 * @param {Object}  bot          telegram-bot-api instance
 * @param {string}  eventType    one of CATALOG keys (see top of file)
 * @param {string}  text         message body (Markdown unless overridden in opts)
 * @param {Object}  [opts]       passed straight to bot.sendMessage
 * @param {Object}  [extra]
 * @param {string}  [extra.excludeUserId]  skip this user id (e.g. the actor)
 * @returns {Promise<{sent:number, skipped:number}>}
 */
async function notify(bot, eventType, text, opts = {}, extra = {}) {
  const adminIds = (config && config.access && config.access.adminIds) || [];
  if (!adminIds.length) return { sent: 0, skipped: 0 };
  const excludeId = extra.excludeUserId ? String(extra.excludeUserId) : null;

  let sent = 0;
  let skipped = 0;

  for (const rawId of adminIds) {
    const id = String(rawId);
    if (excludeId && id === excludeId) { skipped += 1; continue; }
    let prefs = null;
    try {
      const u = await usersRepo.findByUserId(id);
      prefs = u ? u.notification_prefs : null;
    } catch (e) {
      logger.warn(`adminFeed.notify: prefs lookup failed for ${id}: ${e.message}`);
    }
    if (!isEnabled(prefs, eventType)) { skipped += 1; continue; }
    try {
      await bot.sendMessage(id, text, opts);
      sent += 1;
    } catch (e) {
      logger.warn(`adminFeed.notify: send to ${id} failed for ${eventType}: ${e.message}`);
      skipped += 1;
    }
  }
  return { sent, skipped };
}

/** All event types in declaration order — used by the toggle screen. */
function listEventTypes() {
  return CATALOG.map(([k]) => k);
}

/** Catalog entry shape: { eventType, label, group, default } */
function getCatalogEntry(eventType) {
  const row = CATALOG.find(([k]) => k === eventType);
  return row ? { eventType: row[0], label: row[1], group: row[2], default: row[3] } : null;
}

function listGroups() {
  return Object.entries(GROUP_META).map(([id, meta]) => ({ id, ...meta }));
}

module.exports = {
  notify,
  isEnabled,
  listEventTypes,
  getCatalogEntry,
  listGroups,
  DEFAULT_POLICY,
  CATALOG,
  GROUP_META,
};
