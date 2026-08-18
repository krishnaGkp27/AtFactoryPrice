'use strict';

/**
 * MNU-1 — no tap may finish unanswered.
 *
 * Until a callback_query is answered the Telegram client keeps a loading
 * state on the button. This bot reads Google Sheets inside its handlers, so
 * that window is real, and if the anchor has scrolled away the user sees a
 * spinner followed by nothing at all. The audit recorded this as "the button
 * is dead"; it was not, but that is the inference a real user makes.
 *
 * WHY A TRACKER RATHER THAN "ANSWER FIRST AT THE DISPATCHER". Telegram
 * accepts exactly ONE answer per callback query. The controller already
 * answers in 262 places, many carrying real text — destination toasts,
 * refusals, `show_alert` errors. A blanket answer at the top of the
 * dispatcher would win the race and silently discard every one of them,
 * turning a feature into a regression. So instead: let the branches answer
 * as they do today, record that they did, and answer only the ones that
 * reached the end of dispatch without doing so.
 *
 * The recorder is installed once by wrapping the shared bot instance
 * (server.js), so it sees every answer from every call site, including ones
 * written after this.
 */

/** Recently-answered callback query ids, bounded. */
const _answered = new Set();
const _order = [];
const MAX = 2048;

function markAnswered(callbackQueryId) {
  const id = String(callbackQueryId || '');
  if (!id || _answered.has(id)) return;
  _answered.add(id);
  _order.push(id);
  if (_order.length > MAX) _answered.delete(_order.shift());
}

function wasAnswered(callbackQueryId) {
  return _answered.has(String(callbackQueryId || ''));
}

/**
 * Install the recorder on a bot instance. Idempotent.
 * Wrapping must never break an answer: a tracking error is swallowed.
 */
function install(bot) {
  if (!bot || typeof bot.answerCallbackQuery !== 'function' || bot.__ackTracked) return bot;
  const original = bot.answerCallbackQuery;
  bot.answerCallbackQuery = async function trackedAnswer(id, ...rest) {
    try { markAnswered(id); } catch (_) { /* never block the answer */ }
    return original.call(this, id, ...rest);
  };
  bot.__ackTracked = true;
  return bot;
}

/**
 * The safety net, called once dispatch has finished. An empty answer just
 * clears the spinner — it shows no toast, so it cannot talk over a branch
 * that deliberately said nothing visible.
 */
async function ensureAnswered(bot, callbackQuery) {
  const id = callbackQuery && callbackQuery.id;
  if (!bot || !id || wasAnswered(id)) return false;
  try {
    await bot.answerCallbackQuery(id);
    return true;
  } catch (_) {
    // Stale/expired callback id — the tap is long gone. Nothing to do.
    return false;
  }
}

/** Test hook. */
function _resetForTests() { _answered.clear(); _order.length = 0; }

module.exports = { install, markAnswered, wasAnswered, ensureAnswered, _resetForTests };
