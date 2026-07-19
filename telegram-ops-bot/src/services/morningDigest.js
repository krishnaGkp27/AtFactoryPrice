'use strict';

/**
 * MORN-1 — morning digest to admins (owner, 17-Jul-2026).
 *
 * MORN-1b (owner UX rule): the 10:00 message is a SUMMARY — one line per
 * enabled category — with tappable drill-down buttons (≤5). Tapping a
 * button swaps the message to that category's full detail (recomputed
 * live, session-free), with ◀ Summary to go back. Detail lists stay
 * capped; deep exploration happens in the owning feature's own screens.
 *
 * Categories COMPLEMENT the hourly reminder jobs — the digest never calls
 * any markReminderSent, and it surfaces what those jobs structurally miss
 * (OVERDUE follow-ups are exact-today matched there and rot silently).
 *
 * Scheduler = sheetBackup pattern: minute tick, catch-up semantics (fires
 * on the first tick at/after the configured time), in-memory once-per-day
 * guard (a mid-morning redeploy may repeat the digest — accepted; state
 * sheets are banned by storage rule 5b and the PG store is not configured
 * yet). All times are Nigeria local (Africa/Lagos) per dates.js.
 */

const settingsRepository = require('../repositories/settingsRepository');
const config = require('../config');
const logger = require('../utils/logger');
const { LAGOS_TZ } = require('../utils/dates');

const CHECK_INTERVAL_MS = 60 * 1000;
const NOTES_CAP = 15;
const LIST_CAP = 10;
const LOWSTOCK_CAP = 20;
const MAX_BUTTONS = 5;

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Owner 17-Jul: friendly note dates — "27-May", with year only when it differs. */
function fmtNiceDay(iso, todayIso) {
  const d = fmtDay(iso);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  const nice = `${Number(m[3])}-${MONTHS[Number(m[2]) - 1]}`;
  const thisYear = String(todayIso || '').slice(0, 4);
  return m[1] === thisYear ? nice : `${nice}-${m[1].slice(2)}`;
}

/* ── per-category loaders: raw rows once, summary + detail derived ── */

async function loadNotes(settings, todayIso) {
  const repo = require('../repositories/customerNotesRepository');
  const days = Number(settings.DIGEST_NOTES_DAYS) || 7;
  const cutoff = new Date(Date.parse(todayIso) - days * 86400000).toISOString().slice(0, 10);
  const all = (await repo.getAll())
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const newCount = all.filter((n) => fmtDay(n.created_at) >= cutoff).length;
  return { days, all, newCount };
}

async function loadFollowups(settings, todayIso) {
  const repo = require('../repositories/customerFollowupsRepository');
  const pending = (await repo.getAll()).filter((f) => (f.status || '').toLowerCase() === 'pending');
  return {
    dueToday: pending.filter((f) => fmtDay(f.followup_date) === todayIso),
    overdue: pending.filter((f) => fmtDay(f.followup_date) && fmtDay(f.followup_date) < todayIso)
      .sort((a, b) => String(a.followup_date).localeCompare(String(b.followup_date))),
  };
}

const CATEGORIES = [
  {
    key: 'DIGEST_CUSTOMER_NOTES',
    label: '🗒 Notes',
    async summarize(settings, todayIso) {
      const { days, all, newCount } = await loadNotes(settings, todayIso);
      if (!all.length) return { line: '🗒 Customer notes: none yet', count: 0 };
      return { line: `🗒 Customer notes: *${all.length}* total · *${newCount}* new in ${days} days`, count: all.length };
    },
    // Owner 17-Jul (v2): tapping Notes shows CUSTOMER chips; tapping a
    // customer shows that customer's notes. Rendering lives in the flow
    // (needs custom keyboards) via notesIndex/notesForCustomer below.
    async detail(settings, todayIso) {
      const { all } = await loadNotes(settings, todayIso);
      if (!all.length) return { text: '🗒 *Customer notes* — none recorded yet.', totalPages: 1 };
      const customers = notesGroups(all);
      return {
        text: `🗒 *Customer notes* — ${all.length} across ${customers.length} customer(s).\nTap a customer to read their notes.`,
        totalPages: 1,
      };
    },
  },
  {
    key: 'DIGEST_FOLLOWUPS',
    label: '📅 Follow-ups',
    async summarize(settings, todayIso) {
      const { dueToday, overdue } = await loadFollowups(settings, todayIso);
      const count = dueToday.length + overdue.length;
      if (!count) return { line: '', count: 0 };
      return { line: `📅 Follow-ups: *${dueToday.length}* due today${overdue.length ? ` · ⚠️ *${overdue.length}* overdue` : ''}`, count };
    },
    async detail(settings, todayIso) {
      const { dueToday, overdue } = await loadFollowups(settings, todayIso);
      if (!dueToday.length && !overdue.length) return '📅 *Follow-ups* — nothing due or overdue.';
      let s = '📅 *Follow-ups*';
      if (dueToday.length) s += `\n\n*Due today:*\n${dueToday.slice(0, LIST_CAP).map((f) => `• ${f.customer} — ${f.reason || '—'}`).join('\n')}`;
      if (overdue.length) s += `\n\n⚠️ *Overdue (${overdue.length}):*\n${overdue.slice(0, LIST_CAP).map((f) => `• ${f.customer} — since ${fmtDay(f.followup_date)} (${f.reason || '—'})`).join('\n')}`;
      return s;
    },
  },
  {
    key: 'DIGEST_APPROVALS',
    label: '🛂 Approvals',
    async summarize() {
      const pending = await require('../repositories/approvalQueueRepository').getAllPending();
      if (!pending.length) return { line: '', count: 0 };
      return { line: `🛂 Approvals pending: *${pending.length}*`, count: pending.length };
    },
    async detail() {
      const pending = await require('../repositories/approvalQueueRepository').getAllPending();
      if (!pending.length) return '🛂 *Approvals* — queue is clear.';
      const newest = [...pending].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const lines = newest.slice(0, LIST_CAP).map((p) => `• ${fmtDay(p.createdAt)} — ${((p.actionJSON || {}).action || 'action').replace(/_/g, ' ')} by ${p.user} \`${String(p.requestId).slice(0, 8)}\``);
      const older = pending.length - Math.min(pending.length, LIST_CAP);
      return `🛂 *Approvals pending: ${pending.length}* (newest first)\n${lines.join('\n')}${older ? `\n_…and ${older} older — reminder cards re-send via ⏰ APR-1_` : ''}`;
    },
  },
  {
    key: 'DIGEST_TASKS',
    label: '📋 Tasks',
    async summarize(settings, todayIso) {
      const all = await require('../repositories/tasksRepository').getAll();
      const due = all.filter((t) => (t.status || '') === 'active' && fmtDay(t.proposed_deadline) && fmtDay(t.proposed_deadline) <= todayIso);
      const submitted = all.filter((t) => (t.status || '') === 'submitted');
      const count = due.length + submitted.length;
      if (!count) return { line: '', count: 0 };
      return { line: `📋 Tasks: *${due.length}* due/overdue${submitted.length ? ` · *${submitted.length}* awaiting sign-off` : ''}`, count };
    },
    async detail(settings, todayIso) {
      const all = await require('../repositories/tasksRepository').getAll();
      const due = all.filter((t) => (t.status || '') === 'active' && fmtDay(t.proposed_deadline) && fmtDay(t.proposed_deadline) <= todayIso);
      const submitted = all.filter((t) => (t.status || '') === 'submitted');
      if (!due.length && !submitted.length) return '📋 *Tasks* — nothing due.';
      let s = '📋 *Tasks*';
      if (due.length) s += `\n\n*Due/overdue:*\n${due.slice(0, LIST_CAP).map((t) => `• "${t.title || t.task_id}" — @${t.assigned_to_name || t.assigned_to}, due ${fmtDay(t.proposed_deadline)}`).join('\n')}`;
      if (submitted.length) s += `\n\n*Awaiting sign-off:* ${submitted.length}`;
      return s;
    },
  },
  {
    key: 'DIGEST_SAMPLES',
    label: '🎨 Samples',
    async summarize(settings, todayIso) {
      const out = (await require('../repositories/samplesRepository').getAll()).filter((x) => (x.status || '') === 'with_customer');
      if (!out.length) return { line: '', count: 0 };
      const past = out.filter((x) => fmtDay(x.followup_date) && fmtDay(x.followup_date) <= todayIso);
      return { line: `🎨 Samples out: *${out.length}*${past.length ? ` (${past.length} past follow-up)` : ''}`, count: out.length };
    },
    async detail(settings, todayIso) {
      const out = (await require('../repositories/samplesRepository').getAll()).filter((x) => (x.status || '') === 'with_customer');
      if (!out.length) return '🎨 *Samples* — none out with customers.';
      const lines = out.slice(0, LIST_CAP).map((x) => `• ${x.design}/${x.shade} → ${x.customer} (given ${fmtDay(x.date_given)})`);
      return `🎨 *Samples out: ${out.length}*\n${lines.join('\n')}${out.length > LIST_CAP ? `\n_…and ${out.length - LIST_CAP} more_` : ''}`;
    },
  },
  // (Low stock deliberately absent — owner 17-Jul: availability alone does
  //  not define low stock for this business; returns after the analysis.)
  {
    key: 'DIGEST_ORDERS',
    label: '🚚 Orders',
    async summarize(settings, todayIso) {
      const all = await require('../repositories/ordersRepository').getAll();
      const due = all.filter((o) => (o.status || '') === 'accepted' && fmtDay(o.scheduled_date) && fmtDay(o.scheduled_date) <= todayIso);
      const unaccepted = all.filter((o) => (o.status || '') === 'pending');
      const count = due.length + unaccepted.length;
      if (!count) return { line: '', count: 0 };
      return { line: `🚚 Orders: *${due.length}* due today${unaccepted.length ? ` · *${unaccepted.length}* unaccepted` : ''}`, count };
    },
    async detail(settings, todayIso) {
      const all = await require('../repositories/ordersRepository').getAll();
      const due = all.filter((o) => (o.status || '') === 'accepted' && fmtDay(o.scheduled_date) && fmtDay(o.scheduled_date) <= todayIso);
      const unaccepted = all.filter((o) => (o.status || '') === 'pending');
      if (!due.length && !unaccepted.length) return '🚚 *Orders* — nothing due.';
      let s = '🚚 *Orders*';
      if (due.length) s += `\n\n*Due today:*\n${due.slice(0, LIST_CAP).map((o) => `• ${o.design} → ${o.customer} (@${o.salesperson_name || o.salesperson_id})`).join('\n')}`;
      if (unaccepted.length) s += `\n\n*Unaccepted:* ${unaccepted.length}`;
      return s;
    },
  },
];

function categoryByKey(key) { return CATEGORIES.find((c) => c.key === key) || null; }

/** Distinct note customers, most-recent note first: [{customer, count, latest}]. */
function notesGroups(allNotes) {
  const map = new Map();
  for (const n of allNotes) {
    const key = (n.customer || '(no name)').trim();
    if (!map.has(key)) map.set(key, { customer: key, count: 0, latest: '' });
    const g = map.get(key);
    g.count += 1;
    if (String(n.created_at) > g.latest) g.latest = String(n.created_at);
  }
  return [...map.values()].sort((a, b) => b.latest.localeCompare(a.latest));
}

/** Customer chip index for the notes drill-down (recomputed per tap). */
async function notesIndex(settings) {
  const { all } = await loadNotes(settings, dayInTz(new Date(), settings.DIGEST_TIMEZONE || LAGOS_TZ));
  return { total: all.length, customers: notesGroups(all) };
}

const NOTES_PER_CUSTOMER_PAGE = 3;
const NOTE_TEXT_CAP = 600;

/**
 * Resolve note authors (created_by holds the raw Telegram id) to display
 * names via one Users read. Rows whose created_by is already a name (or an
 * unknown id) render as stored; blank renders 'Unknown'.
 */
async function noteAuthorResolver() {
  const map = new Map();
  try {
    const users = await require('../repositories/usersRepository').getAll();
    for (const u of users) map.set(String(u.user_id), u.name || String(u.user_id));
  } catch (e) { logger.warn(`digest notes: author lookup failed: ${e.message}`); }
  return (id) => {
    const key = String(id || '').trim();
    if (!key) return 'Unknown';
    return map.get(key) || key;
  };
}

/**
 * One customer's notes, GROUPED BY AUTHOR (owner 19-Jul: "display the
 * person who has added the customer notes… group them with the person").
 * Author groups are ordered by their newest note; notes inside a group stay
 * newest first. Paged 3 notes/page; a group's 👤 header repeats when its
 * notes continue onto the next page.
 */
async function notesForCustomer(settings, customerIdx, page = 0) {
  const todayIso = dayInTz(new Date(), settings.DIGEST_TIMEZONE || LAGOS_TZ);
  const { all } = await loadNotes(settings, todayIso);
  const groups = notesGroups(all);
  const group = groups[customerIdx];
  if (!group) return null;
  const notes = all.filter((n) => (n.customer || '(no name)').trim() === group.customer);
  const nameOf = await noteAuthorResolver();
  // Group by author. `notes` is newest-first, so first appearance = the
  // author with the freshest note → Map insertion order is the group order.
  const byAuthor = new Map();
  for (const n of notes) {
    const author = nameOf(n.created_by);
    if (!byAuthor.has(author)) byAuthor.set(author, []);
    byAuthor.get(author).push(n);
  }
  const ordered = [];
  for (const [author, list] of byAuthor) for (const n of list) ordered.push({ author, n });
  const totalPages = Math.max(1, Math.ceil(ordered.length / NOTES_PER_CUSTOMER_PAGE));
  const p = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = ordered.slice(p * NOTES_PER_CUSTOMER_PAGE, (p + 1) * NOTES_PER_CUSTOMER_PAGE);
  const parts = [];
  let lastAuthor = null;
  for (const { author, n } of slice) {
    if (author !== lastAuthor) {
      parts.push(`👤 *${author}*`);
      lastAuthor = author;
    }
    const body = n.note.length > NOTE_TEXT_CAP ? `${n.note.slice(0, NOTE_TEXT_CAP)}…` : n.note;
    parts.push(`📌 *${fmtNiceDay(n.created_at, todayIso)}*\n${body}`);
  }
  return {
    customer: group.customer,
    text: `🗒 *${group.customer}* — ${notes.length} note(s) by ${byAuthor.size} ${byAuthor.size === 1 ? 'person' : 'people'}${totalPages > 1 ? ` (page ${p + 1}/${totalPages})` : ''}:\n\n${parts.join('\n\n')}`,
    totalPages,
  };
}

/**
 * The summary message + drill-down keyboard (MORN-1b): one line per
 * enabled category, buttons (≤MAX_BUTTONS) only for categories with data.
 * Returns { text, keyboard } — text '' when every category is off.
 */
async function buildSummary(settings, now = new Date()) {
  const tz = settings.DIGEST_TIMEZONE || LAGOS_TZ;
  const todayIso = dayInTz(now, tz);
  const lines = [];
  const buttons = [];
  for (const cat of CATEGORIES) {
    if (Number(settings[cat.key]) !== 1) continue;
    try {
      const { line, count } = await cat.summarize(settings, todayIso);
      if (line) lines.push(line);
      if (count > 0 && buttons.length < MAX_BUTTONS) {
        buttons.push({ text: `${cat.label} (${count})`, callback_data: `rmd:d:${cat.key}` });
      }
    } catch (e) { logger.warn(`digest summary ${cat.key} failed: ${e.message}`); }
  }
  if (!lines.length && !buttons.length) return { text: '', keyboard: null };
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  const text = `☀️ *Good morning — ${todayIso}*\n\n${lines.join('\n')}${buttons.length ? '\n\n_Tap a section for details._' : ''}`;
  return { text, keyboard: rows.length ? { inline_keyboard: rows } : null };
}

/**
 * Full detail for one category (session-free drill-down target).
 * Always returns { text, totalPages } — categories without pagination
 * report totalPages 1.
 */
async function buildDetail(key, settings, now = new Date(), page = 0) {
  const cat = categoryByKey(key);
  if (!cat) return { text: '', totalPages: 1 };
  const tz = settings.DIGEST_TIMEZONE || LAGOS_TZ;
  const out = await cat.detail(settings, dayInTz(now, tz), page);
  return typeof out === 'string' ? { text: out, totalPages: 1 } : out;
}

/** Back-compat plain-text digest (test button fallback / previews). */
async function buildDigest(settings, now = new Date()) {
  const { text } = await buildSummary(settings, now);
  return text;
}

/** Send the summary to every admin (best-effort). Returns count sent. */
async function sendDigest(bot, settings, now = new Date()) {
  const { text, keyboard } = await buildSummary(settings, now);
  if (!text) return 0;
  let sent = 0;
  for (const adminId of config.access.adminIds) {
    try {
      await bot.sendMessage(adminId, text, { parse_mode: 'Markdown', ...(keyboard ? { reply_markup: keyboard } : {}) });
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
    const at = String(settings.DIGEST_TIME || '10:00').padStart(5, '0');
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

module.exports = { start, tick, buildSummary, buildDetail, buildDigest, sendDigest, notesIndex, notesForCustomer, CATEGORIES, _resetForTests };
