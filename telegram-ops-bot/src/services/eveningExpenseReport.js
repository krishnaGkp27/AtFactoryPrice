'use strict';

/**
 * eveningExpenseReport — EXP-1 (owner-confirmed, 08-Aug-2026).
 *
 * The evening counterpart of the ☀️ morning digest: at
 * EXPENSE_REPORT_TIME (Settings, default 20:00 Lagos) every admin — the
 * finance team for now — gets one 🌇 card per active branch with the
 * day's office record: per-person allowances, office items, commissions,
 * cash received, spent total and the COMPUTED running balance.
 *
 * The reporting reminder rides the same tick: a branch that filed
 * NOTHING today (no outflows, no cash-in, no zero-day marker) gets its
 * recent filers DM'd with two chips — 📝 File now / ✅ Nothing spent
 * today — and the admins' card says the reminder went out. A missing day
 * and a zero day are never confused: zero is an explicit marker.
 *
 * Scheduler discipline copied from morningDigest (MORN-2): minute tick,
 * in-memory last-sent day, catch-up only within EXPENSE_REPORT_CATCHUP_
 * MINUTES after the send time — a late redeploy marks the day done
 * silently instead of reporting at midnight.
 */

const settingsRepository = require('../repositories/settingsRepository');
const branchOpsService = require('./branchOpsService');
const usersRepository = require('../repositories/usersRepository');
const config = require('../config');
const logger = require('../utils/logger');
const { LAGOS_TZ } = require('../utils/dates');
const { mdEscape } = require('../utils/flowKit');

const CHECK_INTERVAL_MS = 60 * 1000;
let _timer = null;
let _lastSentDay = null;

// EXP-1b — same fallback discipline as morningDigest: an invalid
// DIGEST_TIMEZONE override must degrade to UTC, never kill the report
// while the morning digest keeps working.
function dayInTz(now, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  } catch (_) { return now.toISOString().slice(0, 10); }
}
function timeInTz(now, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  } catch (_) { return now.toISOString().slice(11, 16); }
}
function hmToMin(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
/** EXP-1b — tolerate a '2000'-style Settings typo: normalise to HH:MM or
 *  fall back to the default rather than misfiring at ~02:00. */
function normalizeTime(raw, fallback) {
  const s = String(raw || '').trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return s.padStart(5, '0');
  if (/^\d{3,4}$/.test(s)) return `${s.slice(0, -2).padStart(2, '0')}:${s.slice(-2)}`;
  return fallback;
}
const ngn = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;

/**
 * One branch's 🌇 report text (pure formatting over the report shape).
 * EXP-1b — the reminder claim is only made when the caller actually sent
 * reminders (opts.reminded > 0). The flow's 📒 Today card passes nothing
 * and gets a file-it prompt instead; the 20:00 card with zero reachable
 * filers says so plainly rather than pretending someone was chased.
 */
function formatBranchReport(rep, opts = {}) {
  const head = `🌇 *Office expenses — ${rep.date} (${mdEscape(rep.branch)})*`;
  if (!rep.filed) {
    const tail = opts.reminded > 0
      ? 'Reminder sent to the office.'
      : (opts.reminded === 0
        ? '⚠️ Could not reach any filer — follow up directly.'
        : '_File it from 💸 Office Expenses._');
    return `${head}\n\n⚠️ *Nothing filed today.* ${tail}\nBalance in hand: *${ngn(rep.balance)}*`;
  }
  if (rep.zeroDay && rep.spent === 0 && !rep.cashIn.length) {
    return `${head}\n\n✅ Nothing spent today (confirmed).\nBalance in hand: *${ngn(rep.balance)}*`;
  }
  const lines = [];
  if (rep.allowances.length) {
    lines.push(`👤 ${rep.allowances.map((a) => `${mdEscape(a.name)} ${ngn(a.amount)}`).join(' · ')}`);
  }
  if (rep.office.length) {
    lines.push(`🧾 ${rep.office.map((o) => `${mdEscape(o.title)} ${ngn(o.amount)}`).join(' · ')}`);
  }
  for (const c of rep.commissions) {
    lines.push(`🤝 ${mdEscape(c.note)} ${ngn(c.amount)}`);
  }
  for (const c of rep.cashIn) {
    lines.push(`➕ ${mdEscape(c.source)} ${ngn(c.amount)}`);
  }
  lines.push('━━━━━━━━━━');
  lines.push(`Spent *${ngn(rep.spent)}* · Balance in hand *${ngn(rep.balance)}*`);
  if (rep.pendingCount) lines.push(`_${rep.pendingCount} item(s) awaiting sign-off_`);
  return `${head}\n\n${lines.join('\n')}`;
}

/** The two-chip reminder sent to a branch's recent filers.
 *  EXP-1b — the zero-day chip carries ITS day (ofex:zd:<ISO date>): a tap
 *  on yesterday's reminder tomorrow morning must not mark the wrong day. */
function reminderMessage(branch, dateIso) {
  return {
    text: `⏰ *Office expenses — nothing filed today (${mdEscape(branch)})*\n\nFile the day's record now, or confirm nothing was spent.`,
    kb: {
      inline_keyboard: [[
        { text: '📝 File now', callback_data: 'act:office_expense' },
        { text: '✅ Nothing spent today', callback_data: `ofex:zd:${dateIso}` },
      ]],
    },
  };
}

/**
 * Build + send the day's reports and reminders. Exposed for tests and for
 * a manual run; `tick` gates it to once per day at the configured time.
 * @returns {Promise<{reports:number, reminders:number}>}
 */
async function sendReports(bot, now = new Date()) {
  const branches = await branchOpsService.activeExpenseBranches();
  if (!branches.length) return { reports: 0, reminders: 0 };
  let reports = 0;
  let reminders = 0;
  const active = new Set();
  try {
    (await usersRepository.getAll()).forEach((u) => {
      if (String(u.status || 'active').toLowerCase() === 'active') active.add(String(u.user_id));
    });
  } catch (e) { logger.warn(`eveningExpenseReport: users read failed (${e.message}) — reminding all recent filers`); }

  for (const { branch, filers } of branches) {
    let rep;
    try {
      rep = await branchOpsService.getExpenseDayReport({ branch });
    } catch (e) {
      logger.warn(`eveningExpenseReport: report for ${branch} failed: ${e.message}`);
      continue;
    }
    // Remind BEFORE reporting so the admins' card can say what ACTUALLY
    // happened (EXP-1b: reminded count feeds the wording, never assumed).
    let branchReminded = null;
    if (!rep.filed) {
      branchReminded = 0;
      const { text, kb } = reminderMessage(branch, rep.date);
      for (const uid of filers) {
        if (active.size && !active.has(String(uid))) continue; // left the company
        try {
          await bot.sendMessage(uid, text, { parse_mode: 'Markdown', reply_markup: kb });
          branchReminded += 1;
        } catch (e) { logger.warn(`eveningExpenseReport: reminder to ${uid} failed: ${e.message}`); }
      }
      reminders += branchReminded;
    }
    const text = formatBranchReport(rep, { reminded: branchReminded });
    for (const adminId of config.access.adminIds) {
      try {
        await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' });
        reports += 1;
      } catch (e) { logger.warn(`eveningExpenseReport: report to ${adminId} failed: ${e.message}`); }
    }
  }
  return { reports, reminders };
}

/** One scheduler pass. Injected `now` keeps it testable. Never throws. */
async function tick(bot, now = new Date()) {
  try {
    let settings;
    try { settings = await settingsRepository.getAll(); } catch { settings = {}; }
    if (Number(settings.EXPENSE_REPORT_ENABLED ?? 1) !== 1) return false;
    const tz = settings.DIGEST_TIMEZONE || LAGOS_TZ;
    const day = dayInTz(now, tz);
    if (_lastSentDay === day) return false;
    const at = normalizeTime(settings.EXPENSE_REPORT_TIME, '20:00');
    const nowHm = timeInTz(now, tz);
    if (nowHm < at) return false;
    const winMin = Number(settings.EXPENSE_REPORT_CATCHUP_MINUTES ?? 120);
    if (hmToMin(nowHm) - hmToMin(at) > winMin) { _lastSentDay = day; return false; }
    _lastSentDay = day; // set BEFORE sending so a hung send can't double-fire
    try {
      const { reports, reminders } = await sendReports(bot, now);
      if (reports || reminders) {
        logger.info(`eveningExpenseReport: ${reports} report(s), ${reminders} reminder(s) for ${day}`);
      }
      return reports > 0 || reminders > 0;
    } catch (e) {
      // EXP-1b — a transient sheet failure at 20:00 must not burn the whole
      // day: release the day marker so the next minute tick retries (still
      // inside the catch-up window; beyond it the day closes silently).
      _lastSentDay = null;
      logger.error(`eveningExpenseReport send failed (will retry within window): ${e.message}`);
      return false;
    }
  } catch (e) {
    logger.error('eveningExpenseReport tick failed:', e.message);
    return false;
  }
}

function start(bot) {
  if (_timer) return;
  tick(bot);
  _timer = setInterval(() => tick(bot), CHECK_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  logger.info('eveningExpenseReport: scheduler started (minute tick, Lagos time)');
}

module.exports = {
  start,
  tick,
  sendReports,
  formatBranchReport,
  reminderMessage,
  _internals: {
    resetForTest: () => { _lastSentDay = null; },
  },
};
