'use strict';

/**
 * MORN-1 — 09:15 morning digest to admins (owner, 17-Jul-2026).
 *
 * One message to every admin before the office opens, built from toggleable
 * categories. Owner's launch state: CUSTOMER NOTES on, everything else off.
 * Categories deliberately COMPLEMENT the hourly reminder jobs — the digest
 * never calls any markReminderSent, so the detailed per-item hourly cards
 * still fire; it also surfaces what the hourly jobs structurally miss
 * (OVERDUE follow-ups are exact-today matched there and rot silently).
 *
 * Scheduler = sheetBackup pattern: minute tick, catch-up semantics (fires on
 * the first tick at/after the configured time, so a bot that was down at
 * 09:15 still sends when it returns), in-memory once-per-day guard (a
 * mid-morning redeploy may repeat the digest — accepted; state sheets are
 * banned by storage rule 5b and the PG store is not configured yet).
 * All times are Nigeria local (Africa/Lagos) per the dates.js convention.
 */

const settingsRepository = require('../repositories/settingsRepository');
const config = require('../config');
const logger = require('../utils/logger');
const { LAGOS_TZ } = require('../utils/dates');

const CHECK_INTERVAL_MS = 60 * 1000;
const NOTES_CAP = 15;
const LIST_CAP = 10;

let _timer = null;
let _lastSentDay = null;

function dayInTz(now, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); }
  catch { return now.toISOString().slice(0, 10); }
}
function timeInTz(now, tz) {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now); }
  catch { return now.toISOString().slice(11, 16); }
}
function fmtDay(iso) { return String(iso || '').slice(0, 10); }

/* ── category builders — each returns a section string or '' ── */

async function buildCustomerNotes(settings, todayIso) {
  const customerNotesRepository = require('../repositories/customerNotesRepository');
  const days = Number(settings.DIGEST_NOTES_DAYS) || 7;
  const cutoff = new Date(Date.parse(todayIso) - days * 86400000).toISOString().slice(0, 10);
  const all = await customerNotesRepository.getAll();
  const recent = all
    .filter((n) => fmtDay(n.created_at) >= cutoff)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (!recent.length) return `🗒 *Customer notes* — nothing new in the last ${days} days.`;
  const lines = recent.slice(0, NOTES_CAP).map((n) => `• *${n.customer}* — ${fmtDay(n.created_at)}: ${n.note}`);
  const more = recent.length > NOTES_CAP ? `\n_…and ${recent.length - NOTES_CAP} more (Customer Details → Notes)_` : '';
  return `🗒 *Customer notes* (last ${days} days, newest first):\n${lines.join('\n')}${more}`;
}

async function buildFollowups(settings, todayIso) {
  const repo = require('../repositories/customerFollowupsRepository');
  const all = await repo.getAll();
  const pending = all.filter((f) => (f.status || '').toLowerCase() === 'pending');
  const dueToday = pending.filter((f) => fmtDay(f.followup_date) === todayIso);
  const overdue = pending.filter((f) => fmtDay(f.followup_date) && fmtDay(f.followup_date) < todayIso)
    .sort((a, b) => String(a.followup_date).localeCompare(String(b.followup_date)));
  if (!dueToday.length && !overdue.length) return '';
  let s = '📅 *Follow-ups*:';
  if (dueToday.length) s += `\n• due today: ${dueToday.slice(0, LIST_CAP).map((f) => `${f.customer} (${f.reason || '—'})`).join('; ')}`;
  if (overdue.length) s += `\n• ⚠️ OVERDUE ${overdue.length}: ${overdue.slice(0, LIST_CAP).map((f) => `${f.customer} since ${fmtDay(f.followup_date)}`).join('; ')}`;
  return s;
}

async function buildApprovals() {
  const repo = require('../repositories/approvalQueueRepository');
  const pending = await repo.getAllPending();
  if (!pending.length) return '';
  const oldest = [...pending].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(0, 3);
  const heads = oldest.map((p) => `${((p.actionJSON || {}).action || 'action').replace(/_/g, ' ')} by ${p.user} (${fmtDay(p.createdAt)})`);
  return `🛂 *Approvals pending*: ${pending.length}\n• oldest: ${heads.join('; ')}`;
}

async function buildTasks(settings, todayIso) {
  const repo = require('../repositories/tasksRepository');
  const all = await repo.getAll();
  const dueActive = all.filter((t) => (t.status || '') === 'active' && fmtDay(t.proposed_deadline) && fmtDay(t.proposed_deadline) <= todayIso);
  const submitted = all.filter((t) => (t.status || '') === 'submitted');
  if (!dueActive.length && !submitted.length) return '';
  let s = '📋 *Tasks*:';
  if (dueActive.length) s += `\n• due/overdue: ${dueActive.slice(0, LIST_CAP).map((t) => `"${t.title || t.task_id}" @${t.assigned_to_name || t.assigned_to}`).join('; ')}`;
  if (submitted.length) s += `\n• awaiting sign-off: ${submitted.length}`;
  return s;
}

async function buildSamples(settings, todayIso) {
  const repo = require('../repositories/samplesRepository');
  const all = await repo.getAll();
  const out = all.filter((x) => (x.status || '') === 'with_customer');
  if (!out.length) return '';
  const past = out.filter((x) => fmtDay(x.followup_date) && fmtDay(x.followup_date) <= todayIso);
  return `🎨 *Samples out*: ${out.length} with customers${past.length ? ` (${past.length} past follow-up date)` : ''}`;
}

async function buildLowStock() {
  try {
    const { computeLowStock, getLowStockThreshold } = require('../flows/procurementPlanView')._internals;
    const threshold = await getLowStockThreshold();
    const rows = await computeLowStock(threshold);
    if (!rows.length) return '';
    const lines = rows.slice(0, 8).map((r) => `${r.design}/${r.shade}: ${r.bales} bls`);
    return `📉 *Low stock* (<${threshold} bls): ${lines.join('; ')}${rows.length > 8 ? ` …+${rows.length - 8}` : ''}`;
  } catch (e) {
    logger.warn(`digest low-stock section failed: ${e.message}`);
    return '';
  }
}

async function buildOrders(settings, todayIso) {
  const repo = require('../repositories/ordersRepository');
  const all = await repo.getAll();
  const todayDue = all.filter((o) => (o.status || '') === 'accepted' && fmtDay(o.scheduled_date) && fmtDay(o.scheduled_date) <= todayIso);
  const unaccepted = all.filter((o) => (o.status || '') === 'pending');
  if (!todayDue.length && !unaccepted.length) return '';
  let s = '🚚 *Orders*:';
  if (todayDue.length) s += `\n• due today: ${todayDue.slice(0, LIST_CAP).map((o) => `${o.design} → ${o.customer}`).join('; ')}`;
  if (unaccepted.length) s += `\n• unaccepted: ${unaccepted.length}`;
  return s;
}

/**
 * Category registry — the toggle screen (rmd:) renders from this table.
 * key = Settings key (1 = on). Owner launch state: notes ON, rest OFF.
 */
const CATEGORIES = [
  { key: 'DIGEST_CUSTOMER_NOTES', label: '🗒 Customer notes', build: buildCustomerNotes },
  { key: 'DIGEST_FOLLOWUPS', label: '📅 Follow-ups due/overdue', build: buildFollowups },
  { key: 'DIGEST_APPROVALS', label: '🛂 Pending approvals', build: buildApprovals },
  { key: 'DIGEST_TASKS', label: '📋 Tasks due', build: buildTasks },
  { key: 'DIGEST_SAMPLES', label: '🎨 Samples out', build: buildSamples },
  { key: 'DIGEST_LOW_STOCK', label: '📉 Low stock', build: buildLowStock },
  { key: 'DIGEST_ORDERS', label: '🚚 Orders due', build: buildOrders },
];

/** Compose the digest text from enabled categories ('' when all disabled). */
async function buildDigest(settings, now = new Date()) {
  const tz = settings.DIGEST_TIMEZONE || LAGOS_TZ;
  const todayIso = dayInTz(now, tz);
  const sections = [];
  for (const cat of CATEGORIES) {
    if (Number(settings[cat.key]) !== 1) continue;
    try {
      const s = await cat.build(settings, todayIso);
      if (s) sections.push(s);
    } catch (e) {
      logger.warn(`digest section ${cat.key} failed: ${e.message}`);
    }
  }
  if (!sections.length) return '';
  return `☀️ *Good morning — ${todayIso}*\n\n${sections.join('\n\n')}`;
}

/** Send the digest to every admin (best-effort per admin). Returns count. */
async function sendDigest(bot, settings, now = new Date()) {
  const text = await buildDigest(settings, now);
  if (!text) return 0;
  let sent = 0;
  for (const adminId of config.access.adminIds) {
    try {
      await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' });
      sent += 1;
    } catch (e) { logger.warn(`digest to ${adminId} failed: ${e.message}`); }
  }
  return sent;
}

/** One scheduler pass. Injected `now` keeps it testable. Never throws. */
async function tick(bot, now = new Date()) {
  try {
    let settings;
    try { settings = await settingsRepository.getAll(); } catch { settings = {}; }
    if (Number(settings.DIGEST_ENABLED ?? 1) !== 1) return false;
    const tz = settings.DIGEST_TIMEZONE || LAGOS_TZ;
    const day = dayInTz(now, tz);
    if (_lastSentDay === day) return false;
    const at = String(settings.DIGEST_TIME || '09:15').padStart(5, '0');
    if (timeInTz(now, tz) < at) return false;
    _lastSentDay = day; // set BEFORE sending so a hung send can't double-fire
    const sent = await sendDigest(bot, settings, now);
    if (sent) logger.info(`morningDigest: sent to ${sent} admin(s) for ${day}`);
    return sent > 0;
  } catch (e) {
    logger.error('morningDigest tick failed:', e.message);
    return false;
  }
}

function start(bot) {
  if (_timer) return;
  tick(bot);
  _timer = setInterval(() => tick(bot), CHECK_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  logger.info('morningDigest: scheduler started (minute tick, Lagos time)');
}

function _resetForTests() { _lastSentDay = null; if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, tick, buildDigest, sendDigest, CATEGORIES, _resetForTests };
