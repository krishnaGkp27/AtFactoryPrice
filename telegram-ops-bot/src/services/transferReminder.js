'use strict';
/**
 * TRF-20 (4/8) — nothing sits silently.
 *
 * The hourly approval sweep (APR-1) deliberately excludes transfers: their
 * lifecycle rides the trf:* buttons, not approve:/reject:. The owner's data
 * showed the cost of that silence — five transfers parked since 10-Aug that
 * nobody was ever nagged about, and a load raised three times in one day
 * because the first two sat unseen. This sweep re-sends the HOLDER's own
 * card, in the seat that holds it:
 *
 *   requested     → the dispatcher's card (Accept & dispatch / Decline)
 *   in_transit    → the receiver's card (Received / Reject)
 *   admin_review  → the admins' review card (Approve / Send back)
 *
 * and, after `TRANSFER_STALE_DAYS` (Settings, default 3; 0 = off), tells
 * every admin `⚠️ 18Sep·02 · 🔴 LAG▸KAN · 10B has waited 5d on Abdul` with
 * an Open button — the escalation the ops team asked for in all but words.
 *
 * Cadence follows APPROVAL_REMINDER_HOURS like every other reminder; one
 * card per transfer per window, oldest first (a stuck transfer is the
 * point, so no backlog guard hides the old ones), at most CAP per sweep.
 * Best-effort throughout: a failed DM never stops the next one.
 */
const settingsRepository = require('../repositories/settingsRepository');
const usersRepository = require('../repositories/usersRepository');
const config = require('../config');
const logger = require('../utils/logger');

const MIN_AGE_MS = 10 * 60 * 1000;
const CAP = 10;
const _remindedAt = new Map();
let _lastSweepMs = 0;

async function staleDays() {
  const dflt = Number(settingsRepository.DEFAULTS.TRANSFER_STALE_DAYS) || 0;
  try {
    const all = await settingsRepository.getAll();
    const raw = all && all.TRANSFER_STALE_DAYS;
    if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : dflt;
  } catch (_) { return dflt; }
}

async function nameMap(ids) {
  const out = {};
  try {
    for (const u of await usersRepository.getAll()) out[String(u.user_id)] = u.name || String(u.user_id);
  } catch (_) { /* raw ids */ }
  for (const id of ids) if (id && !out[String(id)]) out[String(id)] = String(id);
  return out;
}

function ageDays(row, now) {
  const t = Date.parse(String(row.createdAt || ''));
  return Number.isFinite(t) ? Math.floor((now - t) / 86400000) : 0;
}

const send = (bot, to, text, kb) => bot.sendMessage(String(to), text,
  { parse_mode: 'Markdown', ...(kb ? { reply_markup: kb } : {}) });

/**
 * @param {object} bot
 * @param {{now?:number}} [opts]
 * @returns {Promise<number>} holder cards sent
 */
async function sweep(bot, { now = Date.now() } = {}) {
  try {
    const reminderPolicy = require('./reminderPolicy');
    const hours = await reminderPolicy.hoursForAdmin();
    if (!hours || hours <= 0) return 0;
    const windowMs = hours * 60 * 60 * 1000;
    if (_lastSweepMs && now - _lastSweepMs < windowMs) return 0;
    _lastSweepMs = now;

    const transferService = require('./transferService');
    const tf = require('../flows/transferFlow');
    const transferRow = require('./transferRow');
    const { dispatcherCard, receiverCard, waitingLine, sendAdminReviewCards } = tf._internals;
    const stale = await staleDays();

    const due = (await transferService.getOpenTransfers())
      .filter((t) => {
        const created = Date.parse(t.createdAt || '') || 0;
        if (now - created < MIN_AGE_MS) return false;
        return now - (_remindedAt.get(t.requestId) || 0) >= windowMs;
      })
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(0, CAP);

    let sent = 0;
    for (const t of due) {
      const aj = t.actionJSON || {};
      try {
        const names = await nameMap([t.user, aj.dispatcher, aj.receiver]);
        const days = ageDays(t, now);
        const head = `⏰ *Reminder — this transfer is still waiting*\n`;
        let holder = null;
        if (aj.stage === 'in_transit') {
          holder = aj.receiver;
          const card = receiverCard(t.requestId, aj, waitingLine(t, names));
          await send(bot, holder, head + card.text, card.kb);
        } else if (aj.stage === 'admin_review') {
          await sendAdminReviewCards(bot, t.requestId);
        } else {
          holder = aj.dispatcher;
          const card = dispatcherCard(t.requestId, aj, names[String(aj.receiver)], waitingLine(t, names));
          await send(bot, holder, head + card.text, card.kb);
        }
        // Escalation: past the stale line, every admin hears it — except the
        // holder, who just received the card itself.
        if (stale > 0 && days >= stale && aj.stage !== 'admin_review') {
          const label = transferRow.label(t);
          const who = names[String(holder)] || String(holder || 'nobody');
          const verb = aj.stage === 'in_transit' ? 'confirm receipt' : 'dispatch';
          const kb = { inline_keyboard: [[{ text: `📋 Open ${require('./approvalCards').shortTransferRef(t.requestId)}`, callback_data: `trf:lcard:${t.requestId}` }]] };
          for (const adminId of config.access.adminIds) {
            if (String(adminId) === String(holder)) continue;
            try {
              await send(bot, adminId, `⚠️ *${label}* has waited *${days}d* on ${who} to ${verb}.`, kb);
            } catch (e) { logger.warn(`transferReminder: escalation to ${adminId} failed: ${e.message}`); }
          }
        }
        _remindedAt.set(t.requestId, now);
        sent += 1;
      } catch (e) {
        logger.warn(`transferReminder: card for ${t.requestId} failed: ${e.message}`);
      }
    }
    if (sent) logger.info(`transferReminder: re-sent ${sent} transfer card(s)`);
    return sent;
  } catch (e) {
    logger.error('transferReminder sweep failed:', e.message);
    return 0;
  }
}

function _resetForTests() { _remindedAt.clear(); _lastSweepMs = 0; }

module.exports = { sweep, staleDays, _resetForTests };
