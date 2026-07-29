'use strict';

/**
 * GLA-1 — 📈 Business Glance (owner, 29-Jul).
 *
 * One admin card answering "what is going on right now?" in a single open:
 * approvals waiting, today's sales, stock on hand, attendance, samples out.
 * Modelled on the Home control-panel tab of the owner's Fabric Sample
 * Catalog workbook (Key Numbers / Needs Attention at a glance); this is the
 * in-bot seed of that view — Looker Studio and richer exports come later
 * and will read the same sheets.
 *
 * Every section is BEST-EFFORT: one unreachable sheet renders that section
 * as "unavailable" and never blanks the card. A glance that dies on the
 * slowest sheet is a glance nobody opens twice.
 *
 * Read-only. Admin-only. Namespace `bgl:`.
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer } = require('../utils/flowKit');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');
const { todayInLagos } = require('../utils/dates');
const fmtDate = require('../utils/formatDate');

const SESSION_TYPE = 'business_glance_flow';
const NS = 'bgl:';

const render = makeRenderer({ parseMode: 'Markdown', requireSession: true });

function ageDays(iso) {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? Math.floor((Date.now() - ms) / 86400000) : 0;
}

/** Each section resolves to a display line; failures degrade in place. */
async function sectionApprovals() {
  const approvalQueueRepository = require('../repositories/approvalQueueRepository');
  const pending = await approvalQueueRepository.getAllPending();
  if (!pending.length) return '🛂 Approvals: *none waiting* ✅';
  const oldest = Math.max(...pending.map((p) => ageDays(p.createdAt)));
  return `🛂 Approvals: *${pending.length} waiting*${oldest > 0 ? ` · oldest ${oldest}d` : ''}`;
}

async function sectionSalesToday() {
  const transactionsRepository = require('../repositories/transactionsRepository');
  const today = todayInLagos();
  const rows = (await transactionsRepository.getBySalesDateRange(today, today))
    .filter((t) => /^(sell|sale)/i.test(t.action) && /^(approved|completed)$/i.test(t.status || 'approved'));
  if (!rows.length) return '💰 Sales today: *none yet*';
  const yards = Math.round(rows.reduce((s, t) => s + (Number(t.qty) || 0), 0));
  const customers = new Set(rows.map((t) => (t.customerName || '').trim()).filter(Boolean));
  return `💰 Sales today: *${rows.length}* (${yards} yds · ${customers.size} customer${customers.size === 1 ? '' : 's'})`;
}

async function sectionStock() {
  const inventoryRepository = require('../repositories/inventoryRepository');
  const rows = await inventoryRepository.getAll();
  const byWh = new Map();
  const bales = new Set();
  for (const r of rows) {
    if (String(r.status || '').toLowerCase() !== 'available' || !r.packageNo) continue;
    const key = `${r.warehouse}|${r.packageNo}`;
    if (bales.has(key)) continue;
    bales.add(key);
    byWh.set(r.warehouse, (byWh.get(r.warehouse) || 0) + 1);
  }
  if (!bales.size) return '📦 Stock: *no available bales*';
  const top = [...byWh.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([w, n]) => `${w} ${n}`).join(' · ');
  return `📦 Stock: *${bales.size} bales available*\n      ${top}`;
}

async function sectionAttendance() {
  const attendanceService = require('../services/attendanceService');
  const audience = await attendanceService.getAudience();
  if (!audience.length) return '🕘 Attendance: _no one required_';
  const { rows } = await attendanceService.getTodayAll();
  const marked = new Set(rows.map((r) => String(r.telegram_id)));
  const done = audience.filter((a) => marked.has(String(a.user_id))).length;
  const flag = done < audience.length ? ` · *${audience.length - done} missing*` : ' ✅';
  return `🕘 Attendance: *${done}/${audience.length}* marked${flag}`;
}

async function sectionSamples() {
  const samplesRepository = require('../repositories/samplesRepository');
  const active = await samplesRepository.getActive();
  if (!active.length) return '🧪 Samples out: *none*';
  return `🧪 Samples out: *${active.length}* with customers`;
}

const SECTIONS = [
  ['approvals', sectionApprovals],
  ['sales', sectionSalesToday],
  ['stock', sectionStock],
  ['attendance', sectionAttendance],
  ['samples', sectionSamples],
];

async function buildGlance() {
  const lines = [];
  for (const [name, fn] of SECTIONS) {
    try {
      lines.push(await fn());
    } catch (e) {
      logger.warn(`businessGlance: section ${name} failed: ${e.message}`);
      lines.push(`_${name}: unavailable right now_`);
    }
  }
  return lines.join('\n');
}

async function show(bot, chatId, userId) {
  const body = await buildGlance();
  await render(bot, chatId, userId,
    `📈 *Business Glance — ${fmtDate(todayInLagos())}*\n\n${body}\n\n_Live view — tap Refresh for current numbers._`,
    [
      [{ text: '🔁 Refresh', callback_data: `${NS}refresh` }],
      [{ text: '🛂 Approvals', callback_data: 'act:approvals_inbox' },
        { text: '📦 Supply Details', callback_data: 'act:supply_details' }],
      [{ text: '🏠 Back to menu', callback_data: 'act:__back__' }],
    ]);
}

async function start(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(String(userId))) {
    await bot.sendMessage(chatId, '📈 Business Glance is admin-only.');
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'view',
    flowMessageId: messageId || null, ttlMs: 20 * 60 * 1000,
  });
  await show(bot, chatId, userId);
}

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith(NS)) return false;
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;
  try { await bot.answerCallbackQuery(query.id, { text: 'Refreshing…' }); } catch (_) { /* stale */ }
  if (!auth.isAdmin(userId)) return true;
  let session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    session = { type: SESSION_TYPE, step: 'view', flowMessageId: query.message.message_id, ttlMs: 20 * 60 * 1000 };
    sessionStore.set(userId, session);
  }
  if (data === `${NS}refresh`) {
    await show(bot, chatId, userId);
  }
  return true;
}

module.exports = { SESSION_TYPE, start, handleCallback, _internals: { buildGlance, SECTIONS } };
