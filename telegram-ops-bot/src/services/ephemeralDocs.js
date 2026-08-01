'use strict';

/**
 * ephemeralDocs — TRF-9b (owner 01-Aug): on-demand document views are
 * EPHEMERAL. A fetched dispatch/receipt file must not park designs and
 * quantities in the chat window:
 *   - the next tap anywhere (transfer cards/lists, greeting-menu taps)
 *     sweeps the previous view away;
 *   - fetching a doc again replaces the earlier copy instead of stacking;
 *   - a timed backstop deletes a view the owner just walked away from
 *     (Settings DOC_VIEW_MINUTES, default 15; 0 turns the backstop off —
 *     navigation sweeps still apply).
 *
 * In-memory by design: this is private-chat VIEWER state, not business
 * data — the files themselves stay archived on Drive and on the transfer's
 * queue row, one tap away. A restart drops the tracking for messages sent
 * before it; those are still swept by the >48h-safe navigation taps that
 * follow. Never throws — a cleanup failure must not break a tap.
 */

const settingsRepository = require('../repositories/settingsRepository');
const logger = require('../utils/logger');

const MAX_PER_USER = 10;
const TICK_MS = 60 * 1000;
const DEFAULT_MINUTES = 15;

const _byUser = new Map(); // userId -> [{chatId, messageId, at}]
let _timer = null;

function _arm(bot) {
  if (_timer || !bot) return;
  _timer = setInterval(() => {
    _ttlPass(bot).catch((e) => logger.warn(`ephemeralDocs ttl pass failed: ${e.message}`));
  }, TICK_MS);
  if (_timer.unref) _timer.unref();
}

/** Remember one delivered doc-view message for later disposal. */
function track(bot, userId, chatId, messageId) {
  if (!messageId) return;
  const k = String(userId);
  if (!_byUser.has(k)) _byUser.set(k, []);
  const list = _byUser.get(k);
  list.push({ chatId, messageId, at: Date.now() });
  if (list.length > MAX_PER_USER) list.splice(0, list.length - MAX_PER_USER);
  _arm(bot);
}

/** Delete every tracked doc view for this user (best-effort). */
async function sweep(bot, userId) {
  const k = String(userId);
  const list = _byUser.get(k);
  if (!list || !list.length) return 0;
  const items = list.splice(0);
  _byUser.delete(k);
  let n = 0;
  for (const it of items) {
    try { await bot.deleteMessage(it.chatId, it.messageId); n += 1; } catch (_) { /* already gone */ }
  }
  return n;
}

/** Minutely backstop: delete views older than DOC_VIEW_MINUTES. */
async function _ttlPass(bot) {
  let minutes = DEFAULT_MINUTES;
  try {
    const v = Number((await settingsRepository.getAll()).DOC_VIEW_MINUTES);
    if (Number.isFinite(v)) minutes = v;
  } catch (_) { /* defaults on sheet trouble */ }
  if (minutes <= 0) return;
  const cutoff = Date.now() - minutes * 60 * 1000;
  for (const [k, list] of _byUser) {
    const stale = [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].at < cutoff) stale.push(...list.splice(i, 1));
    }
    if (!list.length) _byUser.delete(k);
    for (const it of stale) {
      try { await bot.deleteMessage(it.chatId, it.messageId); } catch (_) { /* already gone */ }
    }
  }
}

/** Test hook: wipe state + timer. */
function _resetForTests() {
  _byUser.clear();
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { track, sweep, _internals: { _ttlPass, _resetForTests, _byUser } };
