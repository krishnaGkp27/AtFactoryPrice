'use strict';

/**
 * TRM-1 — automatic task reminders, armed by two admins (owner, 27-Aug-2026).
 *
 * The owner's shape, in his words: "start sending the reminder on the
 * telegram bot for the person who is assigned the task, but the last door
 * of reminder will only go through it once it gets approved through two
 * admin gateways. Also the admin will be reminded that this task has been
 * reminded to this person, so that both understand each other
 * synchronously. If we need to stop the reminder, we will have a chance."
 *
 * So there are three parties and three guarantees:
 *   ARM     two distinct admins sign `task_reminder_enable` (risk/evaluate);
 *           nothing here can fire for a task that was never armed.
 *   NUDGE   the DOER gets one DM carrying the same action chip their own
 *           card would show — the reminder is a shortcut, not a scolding.
 *   MIRROR  the ASSIGNER gets one line saying exactly what was sent and
 *           when, so neither side has to ask "did he get told?".
 *   STOP    ⏹ Stop reminders on the task card (single admin — quieting a
 *           nudge is always safe; only applying pressure needs two).
 *
 * Cadence lives in Settings (TASK_REMINDER_HOURS, master TASK_REMINDER_ENABLED)
 * so the owner retunes it in one cell with no deploy. A task is nudged at
 * most ONCE PER LAGOS DAY whatever the cadence says — the floor the manual
 * 🔔 Remind already keeps, so the two doors can never gang up on someone.
 *
 * Scheduler shape follows approvalReminder (APR-1): server.js calls sweep()
 * shortly after boot and hourly; the service decides whether a pass is due.
 * The per-task ledger is in-memory ON PURPOSE (storage rule 5b: no new state
 * sheets) — after a redeploy the worst case is one extra polite reminder.
 */

const tasksRepository = require('../repositories/tasksRepository');
const taskEventsRepository = require('../repositories/taskEventsRepository');
const usersRepository = require('../repositories/usersRepository');
const settingsRepository = require('../repositories/settingsRepository');
const { LAGOS_TZ } = require('../utils/dates');
const logger = require('../utils/logger');

/** Safety cap per sweep — an armed backlog can never flood the chats. */
const MAX_DMS_PER_SWEEP = 20;

/**
 * The Lagos calendar day of a given instant. The once-per-day guard and the
 * cadence window MUST read the same clock — deriving the day from `now`
 * instead of the wall clock is what keeps them honest (and is what makes
 * the guard testable at all).
 */
function lagosDayOf(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: LAGOS_TZ }).format(new Date(ms));
}

/**
 * The event type every reminder writes, whichever door sent it.
 *
 * REVIEW FIX (TRM-1, 27-Aug): the ledger used to be in-memory only, so every
 * deploy reset it — and this repo deploys by pushing to main, several times
 * a day. The boot sweep 90s later would then re-nudge every armed task, and
 * "once per Lagos day" quietly became "once per deploy". The manual 🔔 Remind
 * kept a SECOND private ledger, so the two doors could also double up.
 *
 * Both now write and read ONE durable record in TaskEvents — which is not a
 * new state sheet but the append-only audit trail this feature already
 * writes to, and "the bot told this person on this day" is exactly the
 * business record the owner asked to be able to see.
 */
const REMINDER_EVENT = 'reminder_sent';
/** How far back the sweep reads events — a day guard needs one day. */
const EVENT_LOOKBACK_MS = 3 * 86400000;

/** task_id → { day, at } of the last reminder THIS process sent. */
const _sentOn = new Map();

function _resetForTests() { _sentOn.clear(); _lastSweepMs = 0; _histCache = { at: 0, map: null }; }
let _lastSweepMs = 0;

/**
 * task_id → Lagos day of its most recent reminder, from the durable trail.
 * Read ONCE per sweep. A read failure degrades to the in-memory map rather
 * than silencing the feature (a missing guard costs one extra nudge; a
 * thrown sweep costs every nudge).
 */
let _histCache = { at: 0, map: null };
const HIST_CACHE_MS = 60 * 1000;

async function lastRemindedDays(nowMs, { fresh = false } = {}) {
  // REVIEW FIX: the sweep reads this hourly, but the manual 🔔 tap reads it
  // too — a full TaskEvents read in front of a human waiting for a DM. A
  // 60s cache bounds that to one read a minute across both doors while
  // staying far shorter than the day it guards.
  if (!fresh && _histCache.map && nowMs - _histCache.at < HIST_CACHE_MS) {
    return _histCache.map;
  }
  const map = new Map();
  try {
    const events = await taskEventsRepository.getAll();
    for (const e of events || []) {
      if (String(e.event_type) !== REMINDER_EVENT) continue;
      const t = e.at ? new Date(e.at).getTime() : NaN;
      if (!Number.isFinite(t) || nowMs - t > EVENT_LOOKBACK_MS) continue;
      const prev = map.get(e.task_id);
      // Keep the INSTANT as well as the day: the day guard needs the day,
      // and a TASK_REMINDER_HOURS above 24 needs the instant — reading the
      // cadence from process memory alone made it collapse back to daily
      // after every redeploy.
      if (!prev || t > prev.at) map.set(e.task_id, { day: lagosDayOf(t), at: t });
    }
    _histCache = { at: nowMs, map };
  } catch (e) {
    logger.warn(`taskReminder: reminder history unreadable, falling back to memory: ${e.message}`);
  }
  return map;
}

/**
 * Record that SOMEONE reminded this task's doer today. Called by the sweep
 * and by the manual 🔔 Remind, so the two doors share one day guard.
 */
async function noteReminded(taskId, actorUserId, { now = Date.now(), via = 'auto' } = {}) {
  _sentOn.set(taskId, { day: lagosDayOf(now), at: now });
  _histCache = { at: 0, map: null }; // a new reminder invalidates the cache
  try {
    await taskEventsRepository.append({
      task_id: taskId, event_type: REMINDER_EVENT,
      from_status: '', to_status: '', actor_user_id: String(actorUserId || 'bot'),
      // Stamp with the SAME instant the day guard reads. In production they
      // are identical; keeping them one value is what makes the guard
      // provable instead of accidentally right.
      at: new Date(now).toISOString(),
      meta: { via },
    });
  } catch (e) {
    logger.warn(`taskReminder: could not record the reminder for ${taskId}: ${e.message}`);
  }
}

/** Drop in-memory entries older than the lookback — the map is a cache of
 *  the durable trail, not an archive, and a long-lived container should not
 *  accumulate an entry per task ever armed. */
function prune(nowMs) {
  for (const [id, v] of _sentOn) {
    if (nowMs - v.at > EVENT_LOOKBACK_MS) _sentOn.delete(id);
  }
}

/** Has this task already been reminded today, by EITHER door? */
function remindedToday(taskId, history, nowMs) {
  const day = lagosDayOf(nowMs);
  const mem = _sentOn.get(taskId);
  if (mem && mem.day === day) return true;
  const hist = history.get(taskId);
  return !!hist && hist.day === day;
}

/** The last time ANY door reminded this task, or 0 — durable across restarts. */
function lastRemindedAt(taskId, history) {
  const mem = _sentOn.get(taskId);
  const hist = history.get(taskId);
  return Math.max(mem ? mem.at : 0, hist ? hist.at : 0);
}

/**
 * Telegram refusals that are PERMANENT for this recipient. Everything else
 * (429, 5xx, a network blip) is transient: the day must NOT be burned on it,
 * or one bad second costs the whole day's reminder.
 */
function isPermanentDmFailure(message) {
  return /blocked|deactivated|chat not found|user is deactivated|bot can't initiate/i.test(String(message || ''));
}

/**
 * Is this task's next move the DOER's, right now?
 *
 * 'assigned' / 'awaiting_final_ack' — nothing is happening and it is their
 * turn, so silence is exactly what a reminder is for. 'active' is different:
 * the clock is running inside time THEY committed to, and nagging someone
 * who is working on schedule is how a reminder system gets muted. So an
 * active task is only nudged once its own agreed finish has passed —
 * salaried by started_at + proposed_hours, incentivized by the deadline.
 */
function isDoerMove(task, nowMs) {
  const status = String(task.status || '');
  if (status === 'assigned' || status === 'awaiting_final_ack') return true;
  if (status !== 'active') return false;
  const start = task.started_at ? new Date(task.started_at).getTime() : NaN;
  const hrs = Number(task.proposed_hours);
  // REVIEW FIX: `Number('')` is 0, which is finite — a blanked or garbled
  // proposed_hours cell (the kind of direct sheet edit this project does
  // routinely) made every active task permanently overdue. Zero hours is
  // not a commitment, so it is treated as "no commitment recorded".
  const committedMs = Number.isFinite(hrs) && hrs > 0 ? hrs * 3600000 : null;
  if (String(task.track) !== 'incentivized') {
    if (!Number.isFinite(start) || committedMs === null) return false;
    return start + committedMs <= nowMs;
  }
  // REVIEW FIX: comparing with setHours() ran in the SERVER's timezone (UTC
  // on Railway), so a Lagos deadline expired an hour into the wrong day.
  // Comparing Lagos day strings keeps the module on the one clock it claims.
  const due = String(task.proposed_deadline).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return false;
  // REVIEW FIX: TSK-V2 lets an assigner accept a proposal whose date has
  // already passed, and the card promises "Accepting restarts his Nd from
  // today". The stored deadline stays stale, so judging by it alone nudged
  // the doer as overdue from minute one of work they had just agreed to.
  // When the clock started AFTER the deadline, the restart is the promise
  // that counts.
  if (Number.isFinite(start) && lagosDayOf(start) > due) {
    return committedMs !== null && start + committedMs <= nowMs;
  }
  return lagosDayOf(nowMs) > due; // not blown until its Lagos day has ended
}

/** What the doer is actually being asked for — one plain sentence. */
function askFor(task) {
  switch (String(task.status || '')) {
    case 'assigned':
      return String(task.track) !== 'incentivized'
        ? 'It is waiting on your time — open it and tap *⏱ Accept — give time*.'
        : 'It is waiting on your timeline — open it and tap *⏱ Propose timeline*.';
    case 'awaiting_final_ack':
      return 'The deal is ready — open it and give your final OK.';
    default:
      return 'The agreed time has passed — open it and tap *✅ Mark done*, or tell your assigner what is holding it.';
  }
}

/** Whole days since the task last moved; null when unparseable. */
function silentDays(task, nowMs) {
  const iso = task.last_event_at || task.assigned_at || task.created_at;
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86400000));
}

/**
 * One reminder pass. Returns {sent, considered} — never throws, so a bad
 * row or a blocked DM can never take the scheduler down.
 */
async function sweep(bot, { now = Date.now() } = {}) {
  const out = { sent: 0, considered: 0 };
  let attempts = 0;
  try {
    const settings = await settingsRepository.getAll().catch(() => ({}));
    // REVIEW FIX: `=== 0` failed OPEN — a sheet cell reading FALSE/no/off
    // gave NaN and the nudges kept running. The house convention (evening
    // report, attendance nudge) is fail-CLOSED: only an explicit 1 is on.
    if (Number(settings.TASK_REMINDER_ENABLED ?? 1) !== 1) return out;
    const hours = Number(settings.TASK_REMINDER_HOURS);
    const windowMs = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600000;
    // The sweep itself is due at most once per cadence window; the per-task
    // guard below is what actually spaces one task's nudges.
    if (_lastSweepMs && now - _lastSweepMs < Math.min(windowMs, 3600000)) return out;
    _lastSweepMs = now;

    const all = await tasksRepository.getAll();
    const history = await lastRemindedDays(now);   // durable, restart-proof
    prune(now);
    // assignerId → the lines they should hear about THIS sweep. Mirrors are
    // consolidated: an admin who armed twenty tasks must get one digest, not
    // twenty DMs — twenty is how a reminder bot gets muted, which would
    // defeat the very thing the owner asked for.
    const mirrors = new Map();
    const { mdEscape } = require('../utils/flowKit');
    const taskFlow = require('../flows/taskFlow');
    const pmFor = (t) => taskFlow._internals.PRIORITY_META[taskFlow._internals.getPriority(t)]
      || taskFlow._internals.PRIORITY_META.normal;

    for (const task of all) {
      if (!task.auto_remind) continue;              // never armed → never speaks
      if (!isDoerMove(task, now)) continue;         // not their move → silence
      out.considered += 1;
      // One per Lagos day whichever door sent it (durable across restarts).
      if (remindedToday(task.task_id, history, now)) continue;
      const lastAt = lastRemindedAt(task.task_id, history);
      if (lastAt && now - lastAt < windowMs) continue;
      // REVIEW FIX: the cap counts ATTEMPTS, not successes. Counting only
      // delivered DMs let a batch of blocked recipients push the loop past
      // Telegram's rate ceiling and turn into 429s for everyone else.
      if (attempts >= MAX_DMS_PER_SWEEP) break;
      attempts += 1;

      // Stamp BEFORE sending so a hung send cannot double-fire on the next
      // tick; rolled back below when the failure was only transient.
      _sentOn.set(task.task_id, { day: lagosDayOf(now), at: now });

      const doer = await usersRepository.findByUserId(task.assigned_to).catch(() => null);
      const doerName = (doer && doer.name) || String(task.assigned_to);
      // REVIEW FIX: a doer who has been deactivated (left the company, with
      // their tasks parked for reassignment) was nudged every day forever.
      // Skip them and say so ONCE in the assigner's digest — the assigner is
      // the person who can actually reassign the work.
      if (doer && String(doer.status || 'active').trim().toLowerCase() !== 'active') {
        await noteReminded(task.task_id, 'bot', { now, via: 'auto-inactive-doer' });
        const whoInactive = String(task.assigned_by || '');
        if (whoInactive) {
          if (!mirrors.has(whoInactive)) mirrors.set(whoInactive, []);
          mirrors.get(whoInactive).push(
            `⏸ ${pmFor(task).icon} ${mdEscape(task.title)} → ${mdEscape(doerName)} — *no longer active*, reassign or drop it`);
        }
        continue;
      }
      const daysQuiet = silentDays(task, now);
      const meta = taskFlow._internals;
      const pm = pmFor(task);

      let delivered = false;
      try {
        const chips = meta.buttonsForMyTask(task);
        await bot.sendMessage(task.assigned_to,
          `🔔 *Reminder — this task is waiting on you*\n\n`
          + `${pm.icon} *${mdEscape(task.title)}*${meta.descLine(task.description)}\n\n`
          + `${askFor(task)}\n\nID: \`${task.task_id}\``,
          { parse_mode: 'Markdown', reply_markup: chips ? { inline_keyboard: [chips] } : undefined });
        delivered = true;
        out.sent += 1;
        await noteReminded(task.task_id, 'bot', { now, via: 'auto' });
      } catch (e) {
        logger.warn(`taskReminder: DM to ${task.assigned_to} failed (${task.task_id}): ${e.message}`);
        if (!isPermanentDmFailure(e.message)) {
          // Transient (429, 5xx, a blip): give the day back so the next
          // hourly sweep retries instead of losing the reminder entirely.
          _sentOn.delete(task.task_id);
        } else {
          // Permanent for this recipient — record it so we stop retrying
          // today, and the digest below tells the assigner why.
          await noteReminded(task.task_id, 'bot', { now, via: 'auto-undeliverable' });
        }
      }

      // MIRROR — collected now, sent once below, so the assigner sees one
      // digest of everything the bot said on their behalf this pass.
      const who = String(task.assigned_by || '');
      if (who) {
        if (!mirrors.has(who)) mirrors.set(who, []);
        mirrors.get(who).push(delivered
          ? `${pm.icon} ${mdEscape(task.title)} → ${mdEscape(doerName)}`
            + `${daysQuiet == null ? '' : ` · quiet ${daysQuiet}d`}`
          : `⚠️ ${pm.icon} ${mdEscape(task.title)} → ${mdEscape(doerName)} — *not delivered* (the bot cannot DM them)`);
      }
    }

    for (const [assignerId, lines] of mirrors) {
      const n = lines.length;
      try {
        await bot.sendMessage(assignerId,
          `🔔 *Reminder${n === 1 ? '' : 's'} sent on your behalf*\n\n`
          + `${lines.join('\n')}\n\n`
          + `_${n === 1 ? 'They have' : 'They have each'} been asked to act. `
          + 'Open the task in 👥 Team Tasks and tap ⏹ Stop reminders to end these._',
          { parse_mode: 'Markdown', disable_notification: true });
      } catch (e) {
        logger.warn(`taskReminder: assigner mirror failed for ${assignerId}: ${e.message}`);
      }
    }
    if (out.sent) logger.info(`taskReminder: ${out.sent} reminder(s) sent of ${out.considered} armed and due`);
  } catch (e) {
    logger.warn(`taskReminder.sweep: ${e.message}`);
  }
  return out;
}

module.exports = {
  sweep,
  noteReminded,
  remindedToday,
  lastRemindedAt,
  lastRemindedDays,
  REMINDER_EVENT,
  _internals: {
    isDoerMove, askFor, silentDays, lagosDayOf, prune, isPermanentDmFailure,
    _sentOn, _resetForTests, MAX_DMS_PER_SWEEP,
  },
};
