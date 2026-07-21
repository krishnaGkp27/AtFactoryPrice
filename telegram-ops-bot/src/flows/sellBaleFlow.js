'use strict';

/**
 * ST-1 Part A — 💰 Sell Bale: the fully tappable sale flow
 * (specs/ST-1_TAPPABLE_SALE.md, owner-locked 14-Jul-2026).
 *
 * Kills the typo sources of typed sales: customer, salesperson, bank and
 * date are all chips backed by real data. Steps:
 *   container → warehouse → design (+ catalogue photo) → bale multi-select
 *   cart → customer (recent + browse + search-by-typing over EXISTING
 *   customers only) → salesperson → payment → date → review.
 *
 * On review-confirm the flow hands off to the PROVEN typed-sale pipeline:
 * salesFlowService.startSession(...) + awaitingDocument → the existing
 * bill-photo step, confirm_sale summary, single-admin approval (DUAL-1a)
 * and the ST-1 Part B enrichment chips all run unchanged.
 *
 * Session: { type: 'sell_bale_flow', step, flowMessageId, arrivalBatch,
 *   warehouse, design, cart: [{packageNo, design, thans, yards}],
 *   _containers/_warehouses/_designs/_bales/_customers/_salespersons/
 *   _payOpts/_dates: index lists for 64-byte-safe callbacks }
 */

const sessionStore = require('../utils/sessionStore');
const inventoryRepository = require('../repositories/inventoryRepository');
const transactionsRepository = require('../repositories/transactionsRepository');
const customersRepository = require('../repositories/customersRepository');
const usersRepository = require('../repositories/usersRepository');
const salesFlow = require('../services/salesFlowService');
const designAssetsService = require('../services/designAssetsService');
const { fmtQty } = require('../utils/format');
const fmtDate = require('../utils/formatDate');
const logger = require('../utils/logger');

const SESSION_TYPE = 'sell_bale_flow';
const TTL_MS = 20 * 60 * 1000;
const MAX_CHIPS = 12;

function esc(s) { return String(s == null ? '' : s).replace(/[*_`[\]]/g, ''); }

function lagosISO(daysBack = 0) {
  return new Date(Date.now() - daysBack * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

function getSession(userId) {
  const s = sessionStore.get(userId);
  return s && s.type === SESSION_TYPE ? s : null;
}

function save(userId, s) { sessionStore.set(userId, { ...s, ttlMs: TTL_MS }); }

async function render(bot, chatId, userId, text, rows) {
  const s = getSession(userId);
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  if (s && s.flowMessageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: s.flowMessageId, ...opts });
      return;
    } catch (_) { /* fall through to fresh send */ }
  }
  try {
    const sent = await bot.sendMessage(chatId, text, opts);
    if (s && sent && sent.message_id) { s.flowMessageId = sent.message_id; save(userId, s); }
  } catch (e) {
    logger.warn(`[sellBaleFlow] render failed (${e.message}); retrying plain`);
    try { await bot.sendMessage(chatId, text.replace(/[*_]/g, ''), { reply_markup: { inline_keyboard: rows } }); } catch (_) { /* unreachable chat */ }
  }
}

const cancelRow = () => [{ text: '❌ Cancel', callback_data: 'sb:x' }];

function header(s) {
  const bits = ['💰 *Sell Bale*'];
  if (s.arrivalBatch) bits.push(`🚢 ${esc(s.arrivalBatch)}`);
  if (s.warehouse) bits.push(`🏭 ${esc(s.warehouse)}`);
  if (s.cart && s.cart.length) {
    const yds = s.cart.reduce((t, c) => t + c.yards, 0);
    bits.push(`🛒 ${s.cart.length} bale${s.cart.length === 1 ? '' : 's'} · ${fmtQty(yds)} yds`);
  }
  return bits.join('  ·  ');
}

/** Available rows scoped to the session's container (+warehouse +design). */
async function scopedRows(s, { design } = {}) {
  const all = await inventoryRepository.getAll();
  const ab = s.arrivalBatch === inventoryRepository.UNLABELLED_BATCH ? '' : String(s.arrivalBatch || '').toUpperCase();
  const inCart = new Set((s.cart || []).map((c) => c.packageNo));
  return all.filter((r) => {
    if (r.status !== 'available') return false;
    if (s.arrivalBatch && String(r.arrivalBatch || '').toUpperCase() !== ab) return false;
    if (s.warehouse && r.warehouse !== s.warehouse) return false;
    if (design && String(r.design).toUpperCase() !== String(design).toUpperCase()) return false;
    if (inCart.has(r.packageNo)) return false;
    return true;
  });
}

// ── SELL-T1: typed head, tappable tail ──────────────────────────────────────
//
// "Sell package 507,503,492" typed by the office manager preloads those
// bales into THIS flow (validated against the sheet, per-number reasons,
// warehouse tap for ambiguous numbers) and continues with the normal
// tappable customer → salesperson → bank → date steps. Numbers are the
// only thing worth typing — names/banks/dates stay taps (owner 20-Jul).

/** All available bales grouped per (warehouse, packageNo). */
async function availableBaleMap() {
  const all = await inventoryRepository.getAll();
  const map = new Map();
  for (const r of all) {
    if (!r.packageNo) continue;
    const k = `${r.warehouse}|${r.packageNo}`;
    if (!map.has(k)) map.set(k, { packageNo: String(r.packageNo), warehouse: r.warehouse, design: String(r.design || ''), thans: 0, yards: 0, soldTo: '' });
    const b = map.get(k);
    if (r.status === 'available') { b.thans += 1; b.yards += Number(r.yards) || 0; }
    else if (r.soldTo && !b.soldTo) b.soldTo = r.soldTo;
  }
  return [...map.values()];
}

async function startWithBales(bot, chatId, userId, packageNos) {
  sessionStore.clear(userId);
  save(userId, { type: SESSION_TYPE, step: 'preload', cart: [], flowMessageId: null });
  const s = getSession(userId);
  const bales = await availableBaleMap();
  const seen = new Set();
  const skipped = [];
  const ambiguous = [];
  for (const raw of packageNos || []) {
    const digits = String(raw).replace(/\D/g, '');
    if (!digits || seen.has(digits)) continue;
    seen.add(digits);
    const hits = bales.filter((b) => {
      const bd = String(b.packageNo).replace(/\D/g, '');
      return (bd === digits || String(b.packageNo).toUpperCase().endsWith(digits)) && b.thans > 0;
    });
    if (hits.length === 1) {
      const b = hits[0];
      s.cart.push({ packageNo: b.packageNo, design: b.design, thans: b.thans, yards: b.yards });
    } else if (hits.length > 1) {
      ambiguous.push({ digits, options: hits });
    } else {
      const anywhere = bales.find((b) => String(b.packageNo).replace(/\D/g, '') === digits);
      skipped.push({ no: digits, reason: anywhere && anywhere.soldTo ? `already sold to ${anywhere.soldTo}` : (anywhere ? 'no available thans' : 'not found in the sheet') });
    }
  }
  s._ambigQueue = ambiguous;
  s._skipped = skipped;
  save(userId, s);
  if (!s.cart.length && !ambiguous.length) {
    await render(bot, chatId, userId,
      '💰 *Sell Bale*\n\n⚠️ None of the typed bale numbers matched available stock:\n'
      + skipped.map((x) => `  • ${x.no} — ${x.reason}`).join('\n')
      + '\n\nPick bales the tappable way instead:',
      [[{ text: '💰 Open Sell Bale', callback_data: 'act:sell_bale' }], cancelRow()]);
    sessionStore.clear(userId);
    return;
  }
  await nextPreloadStep(bot, chatId, userId);
}

/** Resolve ambiguities one by one, then show the preload summary. */
async function nextPreloadStep(bot, chatId, userId) {
  const s = getSession(userId);
  const q = s._ambigQueue || [];
  if (q.length) {
    const cur = q[0];
    const rows = cur.options.map((o, i) => ([{
      text: `🏭 ${o.warehouse} — ${o.design} · ${o.thans} thans · ${fmtQty(o.yards)} yds`,
      callback_data: `sb:amb:${i}`,
    }]));
    rows.push([{ text: '⏭ Skip this bale', callback_data: 'sb:ambskip' }]);
    rows.push(cancelRow());
    s.step = 'preload_ambig'; save(userId, s);
    await render(bot, chatId, userId,
      `💰 *Sell Bale*\n\nBale *${esc(cur.digits)}* exists in ${cur.options.length} places — which one is being sold?`, rows);
    return;
  }
  const yds = s.cart.reduce((t, c) => t + c.yards, 0);
  const lines = s.cart.map((c) => `  ✅ Bale ${c.packageNo}: ${esc(c.design)}, ${c.thans} thans, ${fmtQty(c.yards)} yds`);
  for (const x of (s._skipped || [])) lines.push(`  ⚠️ ${esc(x.no)} — ${esc(x.reason)} (skipped)`);
  s.step = 'preload_review'; save(userId, s);
  await render(bot, chatId, userId,
    `💰 *Sell Bale — ${s.cart.length} bale(s) loaded from your message* (${fmtQty(yds)} yds)\n\n${lines.join('\n')}\n\n`
    + 'Continue with taps — customer, salesperson, bank, date:',
    [
      [{ text: `👤 Pick customer (${s.cart.length} bales)`, callback_data: 'sb:rev' }],
      [{ text: '➕ Add more bales', callback_data: 'sb:more' }],
      cancelRow(),
    ]);
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function start(bot, chatId, userId) {
  sessionStore.clear(userId);
  save(userId, { type: SESSION_TYPE, step: 'container', cart: [], flowMessageId: null });
  const s = getSession(userId);
  let containers = [];
  try { containers = await inventoryRepository.getArrivalBatches(); } catch (_) {}
  if (!containers.length) {
    await render(bot, chatId, userId, '⚠️ No available stock to sell.', [cancelRow()]);
    return;
  }
  s._containers = containers.map((c) => c.batch);
  save(userId, s);
  const rows = [];
  for (let i = 0; i < containers.length && i < MAX_CHIPS; i += 2) {
    const row = [{ text: `🚢 ${containers[i].label} (${containers[i].bales} bls)`, callback_data: `sb:ct:${i}` }];
    if (containers[i + 1]) row.push({ text: `🚢 ${containers[i + 1].label} (${containers[i + 1].bales} bls)`, callback_data: `sb:ct:${i + 1}` });
    rows.push(row);
  }
  rows.push(cancelRow());
  await render(bot, chatId, userId, `${header(s)}\n\nSelect container (arrival batch):`, rows);
}

async function showWarehouses(bot, chatId, userId) {
  const s = getSession(userId);
  const rows0 = await scopedRows(s);
  const warehouses = [...new Set(rows0.map((r) => r.warehouse).filter(Boolean))].sort();
  if (!warehouses.length) {
    await render(bot, chatId, userId, `${header(s)}\n\n⚠️ No available stock in this container.`, [cancelRow()]);
    return;
  }
  s._warehouses = warehouses; s.step = 'warehouse'; save(userId, s);
  const rows = [];
  for (let i = 0; i < warehouses.length; i += 2) {
    const row = [{ text: `🏭 ${warehouses[i]}`, callback_data: `sb:wh:${i}` }];
    if (warehouses[i + 1]) row.push({ text: `🏭 ${warehouses[i + 1]}`, callback_data: `sb:wh:${i + 1}` });
    rows.push(row);
  }
  rows.push(cancelRow());
  await render(bot, chatId, userId, `${header(s)}\n\nSelect warehouse:`, rows);
}

async function showDesigns(bot, chatId, userId) {
  const s = getSession(userId);
  const avail = await scopedRows(s);
  const byDesign = new Map();
  for (const r of avail) {
    const d = String(r.design);
    if (!byDesign.has(d)) byDesign.set(d, new Set());
    byDesign.get(d).add(r.packageNo);
  }
  const designs = [...byDesign.entries()].sort((a, b) => b[1].size - a[1].size).map(([d, set]) => ({ d, n: set.size }));
  if (!designs.length) {
    await render(bot, chatId, userId, `${header(s)}\n\n⚠️ Nothing left to add here.`, s.cart.length ? [[{ text: `🛒 Review sale (${s.cart.length})`, callback_data: 'sb:rev' }], cancelRow()] : [cancelRow()]);
    return;
  }
  s._designs = designs.map((x) => x.d); s.step = 'design'; save(userId, s);
  const rows = [];
  for (let i = 0; i < designs.length && i < MAX_CHIPS * 2; i += 2) {
    const row = [{ text: `${designs[i].d} (${designs[i].n} bls)`, callback_data: `sb:dg:${i}` }];
    if (designs[i + 1]) row.push({ text: `${designs[i + 1].d} (${designs[i + 1].n} bls)`, callback_data: `sb:dg:${i + 1}` });
    rows.push(row);
  }
  if (s.cart.length) rows.push([{ text: `🛒 Done — review sale (${s.cart.length})`, callback_data: 'sb:rev' }]);
  rows.push(cancelRow());
  await render(bot, chatId, userId, `${header(s)}\n\nSelect design:`, rows);
}

async function showBales(bot, chatId, userId) {
  const s = getSession(userId);
  const avail = await scopedRows(s, { design: s.design });
  const byBale = new Map();
  for (const r of avail) {
    if (!byBale.has(r.packageNo)) byBale.set(r.packageNo, { packageNo: r.packageNo, thans: 0, yards: 0, shade: r.shade });
    const b = byBale.get(r.packageNo);
    b.thans += 1; b.yards += r.yards || 0;
  }
  const bales = [...byBale.values()].sort((a, b) => String(a.packageNo).localeCompare(String(b.packageNo), undefined, { numeric: true }));
  s._bales = bales; s.step = 'bales'; save(userId, s);

  // CAT-C1 — show this container's catalogue photo once per design visit.
  if (!s._photoShownFor || s._photoShownFor !== s.design) {
    s._photoShownFor = s.design; save(userId, s);
    try {
      await designAssetsService.sendDesignPhoto({
        bot, chatId, design: s.design,
        arrivalBatch: s.arrivalBatch === inventoryRepository.UNLABELLED_BATCH ? undefined : s.arrivalBatch,
        caption: `📷 *${esc(s.design)}*${s.arrivalBatch ? ` · 🚢 ${esc(s.arrivalBatch)}` : ''}`,
      });
      s.flowMessageId = null; save(userId, s); // next render below the photo
    } catch (_) { /* photo is optional */ }
  }

  const rows = [];
  for (const [i, b] of bales.slice(0, MAX_CHIPS).entries()) {
    rows.push([{ text: `📦 Bale ${b.packageNo} — ${b.thans} thans · ${fmtQty(b.yards)} yds`, callback_data: `sb:bl:${i}` }]);
  }
  if (bales.length > MAX_CHIPS) rows.push([{ text: `…${bales.length - MAX_CHIPS} more — narrow by design`, callback_data: 'sb:noop' }]);
  rows.push([{ text: '⬅️ Designs', callback_data: 'sb:more' }]);
  if (s.cart.length) rows.push([{ text: `🛒 Done — review sale (${s.cart.length})`, callback_data: 'sb:rev' }]);
  rows.push(cancelRow());
  await render(bot, chatId, userId, `${header(s)}\n\n*${esc(s.design)}* — tap a bale to add it to the sale:`, rows);
}

async function showCustomers(bot, chatId, userId, filter) {
  const s = getSession(userId);
  s.step = 'customer'; save(userId, s);
  let names = [];
  try {
    const all = await customersRepository.getAll();
    names = all.map((c) => c.name).filter(Boolean);
  } catch (_) {}
  let list;
  let title;
  if (filter) {
    const f = filter.toLowerCase();
    list = names.filter((n) => n.toLowerCase().includes(f)).slice(0, MAX_CHIPS);
    title = list.length ? `Customers matching “${esc(filter)}”:` : `No customer matches “${esc(filter)}” — type again, or browse:`;
  } else {
    // Recent buyers first (newest sale rows), then browse covers the rest.
    let recent = [];
    try {
      const txns = await transactionsRepository.getLast(200);
      const seen = new Set();
      for (let i = txns.length - 1; i >= 0 && recent.length < 6; i--) {
        const n = String(txns[i].customerName || '').trim();
        if (n && /^(sell|sale)/i.test(String(txns[i].action || '')) && !seen.has(n.toLowerCase())) {
          seen.add(n.toLowerCase()); recent.push(n);
        }
      }
    } catch (_) {}
    list = recent.length ? recent : names.slice(0, MAX_CHIPS);
    title = recent.length ? 'Recent customers — tap, type a name to search, or browse:' : 'Customers — tap, or type a name to search:';
  }
  s._customers = list; save(userId, s);
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    const row = [{ text: `👤 ${list[i]}`, callback_data: `sb:cu:${i}` }];
    if (list[i + 1]) row.push({ text: `👤 ${list[i + 1]}`, callback_data: `sb:cu:${i + 1}` });
    rows.push(row);
  }
  rows.push([{ text: '📖 Browse all customers', callback_data: 'sb:cub:0' }]);
  rows.push(cancelRow());
  await render(bot, chatId, userId, `${header(s)}\n\n${title}\n_New customers are added via 👥 CRM → Add Customer first._`, rows);
}

async function showCustomerBrowse(bot, chatId, userId, page) {
  const s = getSession(userId);
  let names = [];
  try { names = (await customersRepository.getAll()).map((c) => c.name).filter(Boolean).sort(); } catch (_) {}
  const per = MAX_CHIPS;
  const pages = Math.max(1, Math.ceil(names.length / per));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = names.slice(p * per, p * per + per);
  s._customers = slice; s.step = 'customer'; save(userId, s);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [{ text: `👤 ${slice[i]}`, callback_data: `sb:cu:${i}` }];
    if (slice[i + 1]) row.push({ text: `👤 ${slice[i + 1]}`, callback_data: `sb:cu:${i + 1}` });
    rows.push(row);
  }
  const nav = [];
  if (p > 0) nav.push({ text: '⬅️', callback_data: `sb:cub:${p - 1}` });
  nav.push({ text: `${p + 1}/${pages}`, callback_data: 'sb:noop' });
  if (p < pages - 1) nav.push({ text: '➡️', callback_data: `sb:cub:${p + 1}` });
  rows.push(nav);
  rows.push(cancelRow());
  await render(bot, chatId, userId, `${header(s)}\n\nAll customers (A–Z) — tap or type to search:`, rows);
}

async function showSalespersons(bot, chatId, userId) {
  const s = getSession(userId);
  let users = [];
  try {
    users = (await usersRepository.getAll())
      .filter((u) => (u.status || 'active').toLowerCase() === 'active')
      .map((u) => u.name || String(u.user_id)).filter(Boolean);
  } catch (_) {}
  s._salespersons = users.slice(0, MAX_CHIPS * 2); s.step = 'salesperson'; save(userId, s);
  const rows = [];
  for (let i = 0; i < s._salespersons.length; i += 2) {
    const row = [{ text: `🧑 ${s._salespersons[i]}`, callback_data: `sb:sp:${i}` }];
    if (s._salespersons[i + 1]) row.push({ text: `🧑 ${s._salespersons[i + 1]}`, callback_data: `sb:sp:${i + 1}` });
    rows.push(row);
  }
  rows.push(cancelRow());
  await render(bot, chatId, userId, `${header(s)}\n\n👤 Customer: *${esc(s.customer)}*\n\nSelect salesperson:`, rows);
}

async function showPayment(bot, chatId, userId) {
  const s = getSession(userId);
  let opts = ['Cash', 'Credit'];
  try { opts = await salesFlow.getPaymentOptions(); } catch (_) {}
  opts = [...opts, 'Not yet paid'];
  s._payOpts = opts; s.step = 'payment'; save(userId, s);
  const rows = [];
  for (let i = 0; i < opts.length; i += 2) {
    const icon = (o) => (/cash/i.test(o) ? '💵' : /credit|not yet/i.test(o) ? '🕐' : '🏦');
    const row = [{ text: `${icon(opts[i])} ${opts[i]}`, callback_data: `sb:py:${i}` }];
    if (opts[i + 1]) row.push({ text: `${icon(opts[i + 1])} ${opts[i + 1]}`, callback_data: `sb:py:${i + 1}` });
    rows.push(row);
  }
  rows.push(cancelRow());
  await render(bot, chatId, userId, `${header(s)}\n\nSelect payment mode:`, rows);
}

const CALENDAR_MAX_DAYS_BACK = 90;

async function showDates(bot, chatId, userId) {
  const s = getSession(userId);
  const dates = [0, 1, 2, 3, 4, 5, 6].map((d) => lagosISO(d));
  s._dates = dates; s.step = 'date'; save(userId, s);
  const rows = [
    [{ text: `📅 Today (${fmtDate(dates[0])})`, callback_data: 'sb:dt:0' }],
    [{ text: `Yesterday (${fmtDate(dates[1])})`, callback_data: 'sb:dt:1' }],
  ];
  for (let i = 2; i < 7; i += 2) {
    const row = [{ text: fmtDate(dates[i]), callback_data: `sb:dt:${i}` }];
    if (dates[i + 1]) row.push({ text: fmtDate(dates[i + 1]), callback_data: `sb:dt:${i + 1}` });
    rows.push(row);
  }
  rows.push([{ text: '📆 Older date — calendar', callback_data: `sb:cal:${lagosISO(0).slice(0, 7)}` }]);
  rows.push(cancelRow());
  await render(bot, chatId, userId,
    `${header(s)}\n\nSale date — tap a chip, open the calendar, or just type it (e.g. 11-Jul-2026).\n_Sales beyond yesterday are flagged BACKDATED to both admins._`, rows);
}

/**
 * SELL-T2 — month-grid calendar. Bounds: no future days, no further back
 * than CALENDAR_MAX_DAYS_BACK. ym = 'YYYY-MM'.
 */
async function showCalendar(bot, chatId, userId, ym) {
  const s = getSession(userId);
  const todayIso = lagosISO(0);
  const oldestIso = lagosISO(CALENDAR_MAX_DAYS_BACK);
  const [y, m] = ym.split('-').map(Number);
  const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=Sun

  const rows = [];
  const prevYm = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;
  const nextYm = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
  const nav = [];
  nav.push(prevYm >= oldestIso.slice(0, 7)
    ? { text: '◀', callback_data: `sb:cal:${prevYm}` } : { text: ' ', callback_data: 'sb:noop' });
  nav.push({ text: `${monthName} ${y}`, callback_data: 'sb:noop' });
  nav.push(nextYm <= todayIso.slice(0, 7)
    ? { text: '▶', callback_data: `sb:cal:${nextYm}` } : { text: ' ', callback_data: 'sb:noop' });
  rows.push(nav);
  rows.push(['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => ({ text: d, callback_data: 'sb:noop' })));

  let week = new Array(firstDow).fill({ text: ' ', callback_data: 'sb:noop' });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${ym}-${String(d).padStart(2, '0')}`;
    const pickable = iso <= todayIso && iso >= oldestIso;
    week.push(pickable
      ? { text: String(d), callback_data: `sb:cd:${iso}` }
      : { text: '·', callback_data: 'sb:noop' });
    if (week.length === 7) { rows.push(week); week = []; }
  }
  if (week.length) { while (week.length < 7) week.push({ text: ' ', callback_data: 'sb:noop' }); rows.push(week); }
  rows.push([{ text: '⬅ Quick dates', callback_data: 'sb:dts' }]);
  rows.push(cancelRow());
  s.step = 'date'; save(userId, s);
  await render(bot, chatId, userId,
    `${header(s)}\n\n📆 Pick the sale date (up to ${CALENDAR_MAX_DAYS_BACK} days back). Dots are out of range.`, rows);
}

/**
 * SELL-T2 — single gate every date pick (chip, calendar day, typed text)
 * goes through: blocks future + too-old, computes the backdated flag
 * (owner rule 21-Jul: BEYOND yesterday = backdated), then reviews.
 */
async function applyDate(bot, chatId, userId, iso) {
  const s = getSession(userId);
  const todayIso = lagosISO(0);
  if (iso > todayIso) {
    await render(bot, chatId, userId,
      `${header(s)}\n\n⚠️ ${fmtDate(iso)} is in the FUTURE — future sales aren't allowed. Pick again:`,
      [[{ text: '📆 Open calendar', callback_data: `sb:cal:${todayIso.slice(0, 7)}` }], [{ text: '⬅ Quick dates', callback_data: 'sb:dts' }], cancelRow()]);
    return;
  }
  if (iso < lagosISO(CALENDAR_MAX_DAYS_BACK)) {
    await render(bot, chatId, userId,
      `${header(s)}\n\n⚠️ ${fmtDate(iso)} is more than ${CALENDAR_MAX_DAYS_BACK} days back — ask an admin if this is a genuine old sale. Pick again:`,
      [[{ text: '📆 Open calendar', callback_data: `sb:cal:${todayIso.slice(0, 7)}` }], [{ text: '⬅ Quick dates', callback_data: 'sb:dts' }], cancelRow()]);
    return;
  }
  s.salesDate = iso;
  const daysBack = Math.round((Date.parse(todayIso) - Date.parse(iso)) / 86400000);
  s.backdatedDays = daysBack >= 2 ? daysBack : 0;
  save(userId, s);
  await showReview(bot, chatId, userId);
}

async function showReview(bot, chatId, userId) {
  const s = getSession(userId);
  s.step = 'review'; save(userId, s);
  const yds = s.cart.reduce((t, c) => t + c.yards, 0);
  const thans = s.cart.reduce((t, c) => t + c.thans, 0);
  const lines = s.cart.map((c) => `  📦 Bale ${c.packageNo}: ${esc(c.design)}, ${c.thans} thans, ${fmtQty(c.yards)} yds`);
  const text = [
    '💰 *Sell Bale — review*',
    '',
    ...lines,
    `  *Total: ${s.cart.length} bale${s.cart.length === 1 ? '' : 's'} (${thans} thans), ${fmtQty(yds)} yds*`,
    '',
    `👤 Customer: *${esc(s.customer)}*`,
    `🧑 Salesperson: *${esc(s.salesperson)}*`,
    `💳 Payment: *${esc(s.paymentMode)}*`,
    `📅 Date: *${fmtDate(s.salesDate)}*`,
    ...(s.backdatedDays
      ? ['', `⚠️ *BACKDATED — ${s.backdatedDays} days in the past.* Both admins will see this flag and it is stamped in the sales record.`]
      : []),
    '',
    '_Next: attach the sales bill photo, then the sale goes for admin approval._',
  ].join('\n');
  await render(bot, chatId, userId, text, [
    [{ text: '📎 Attach bill & submit', callback_data: 'sb:fin' }],
    [{ text: '➕ Add more bales', callback_data: 'sb:more' }],
    cancelRow(),
  ]);
}

/** Hand off to the proven typed-sale pipeline (bill photo → confirm → approval). */
async function finalize(bot, chatId, userId) {
  const s = getSession(userId);
  if (!s || !s.cart.length) return;
  const items = s.cart.map((c) => ({ type: 'package', packageNo: c.packageNo }));
  const saleType = items.length > 1 ? 'sell_batch' : 'sell_package';
  salesFlow.startSession(userId, saleType, items, {
    customer: s.customer,
    salesperson: s.salesperson,
    paymentMode: s.paymentMode,
    salesDate: s.salesDate,
  });
  const saleSession = salesFlow.getSession(userId);
  if (saleSession) {
    saleSession.awaitingDocument = true;
    sessionStore.set(userId, saleSession);
  }
  await bot.sendMessage(chatId, '📎 Please send the *sales bill photo or PDF* to attach with this sale.', { parse_mode: 'Markdown' });
}

// ── Callback + text dispatch ────────────────────────────────────────────────

async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('sb:')) return false;
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const ack = async (t) => { try { await bot.answerCallbackQuery(callbackQuery.id, t ? { text: t } : undefined); } catch (_) {} };

  try {
    if (data === 'sb:x') {
      sessionStore.clear(userId);
      await ack('Cancelled');
      await render(bot, chatId, userId, '❌ Sale cancelled. Nothing was submitted.', []);
      try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }); } catch (_) {}
      return true;
    }
    if (data === 'sb:noop') { await ack(); return true; }

    const s = getSession(userId);
    if (!s) {
      await ack('Session expired — start again from 💰 Sell Bale.');
      return true;
    }

    if (data.startsWith('sb:ct:')) {
      const batch = (s._containers || [])[parseInt(data.slice(6), 10)];
      if (batch === undefined) { await ack('Expired — start again.'); return true; }
      s.arrivalBatch = batch; save(userId, s);
      await ack(batch);
      await showWarehouses(bot, chatId, userId);
      return true;
    }
    if (data.startsWith('sb:wh:')) {
      const wh = (s._warehouses || [])[parseInt(data.slice(6), 10)];
      if (!wh) { await ack('Expired — start again.'); return true; }
      s.warehouse = wh; save(userId, s);
      await ack(wh);
      await showDesigns(bot, chatId, userId);
      return true;
    }
    if (data.startsWith('sb:dg:')) {
      const d = (s._designs || [])[parseInt(data.slice(6), 10)];
      if (!d) { await ack('Expired — start again.'); return true; }
      s.design = d; save(userId, s);
      await ack(d);
      await showBales(bot, chatId, userId);
      return true;
    }
    if (data.startsWith('sb:bl:')) {
      const b = (s._bales || [])[parseInt(data.slice(6), 10)];
      if (!b) { await ack('Expired — pick again.'); return true; }
      s.cart.push({ packageNo: b.packageNo, design: s.design, thans: b.thans, yards: b.yards });
      save(userId, s);
      await ack(`🛒 Bale ${b.packageNo} added`);
      await showBales(bot, chatId, userId);
      return true;
    }
    // SELL-T1 — warehouse pick / skip for an ambiguous typed bale number.
    if (data.startsWith('sb:amb:')) {
      const cur = (s._ambigQueue || [])[0];
      const o = cur && cur.options[parseInt(data.slice(7), 10)];
      if (!o) { await ack('Expired — type the command again.'); return true; }
      s.cart.push({ packageNo: o.packageNo, design: o.design, thans: o.thans, yards: o.yards });
      s._ambigQueue.shift(); save(userId, s);
      await ack(`🛒 Bale ${o.packageNo} (${o.warehouse}) added`);
      await nextPreloadStep(bot, chatId, userId);
      return true;
    }
    if (data === 'sb:ambskip') {
      const cur = (s._ambigQueue || []).shift();
      if (cur) (s._skipped = s._skipped || []).push({ no: cur.digits, reason: 'skipped by you (ambiguous)' });
      save(userId, s);
      await ack('Skipped');
      await nextPreloadStep(bot, chatId, userId);
      return true;
    }
    if (data === 'sb:more') { await ack(); await showDesigns(bot, chatId, userId); return true; }
    if (data === 'sb:rev') {
      if (!s.cart.length) { await ack('Cart is empty.'); return true; }
      await ack();
      await showCustomers(bot, chatId, userId);
      return true;
    }
    if (data.startsWith('sb:cub:')) { await ack(); await showCustomerBrowse(bot, chatId, userId, parseInt(data.slice(7), 10) || 0); return true; }
    if (data.startsWith('sb:cu:')) {
      const c = (s._customers || [])[parseInt(data.slice(6), 10)];
      if (!c) { await ack('Expired — pick again.'); return true; }
      s.customer = c; save(userId, s);
      await ack(c);
      await showSalespersons(bot, chatId, userId);
      return true;
    }
    if (data.startsWith('sb:sp:')) {
      const sp = (s._salespersons || [])[parseInt(data.slice(6), 10)];
      if (!sp) { await ack('Expired — pick again.'); return true; }
      s.salesperson = sp; save(userId, s);
      await ack(sp);
      await showPayment(bot, chatId, userId);
      return true;
    }
    if (data.startsWith('sb:py:')) {
      const p = (s._payOpts || [])[parseInt(data.slice(6), 10)];
      if (!p) { await ack('Expired — pick again.'); return true; }
      s.paymentMode = p; save(userId, s);
      await ack(p);
      await showDates(bot, chatId, userId);
      return true;
    }
    if (data.startsWith('sb:dt:')) {
      const d = (s._dates || [])[parseInt(data.slice(6), 10)];
      if (!d) { await ack('Expired — pick again.'); return true; }
      await ack(fmtDate(d));
      await applyDate(bot, chatId, userId, d);
      return true;
    }
    // SELL-T2 — calendar navigation / day pick / back to quick chips.
    if (data.startsWith('sb:cal:')) { await ack(); await showCalendar(bot, chatId, userId, data.slice(7)); return true; }
    if (data.startsWith('sb:cd:')) {
      const iso = data.slice(6);
      await ack(fmtDate(iso));
      await applyDate(bot, chatId, userId, iso);
      return true;
    }
    if (data === 'sb:dts') { await ack(); await showDates(bot, chatId, userId); return true; }
    if (data === 'sb:fin') { await ack('Attach the bill'); await finalize(bot, chatId, userId); return true; }
  } catch (err) {
    logger.error(`[sellBaleFlow] ${data} failed: ${err.message}`);
    try { await bot.sendMessage(chatId, `🚫 That step failed (${err.message}). Tap the last buttons again or restart from 💰 Sell Bale.`); } catch (_) {}
    return true;
  }
  return false;
}

/**
 * Typed text: customer step = search filter; date step (SELL-T2) = a typed
 * date like "11-Jul-2026" / "11 July" is accepted as a pick (Abdul's
 * instinct in the field — it used to dead-end into the intent parser).
 */
async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const s = getSession(userId);
  if (!s) return false;
  const q = String(msg.text || '').trim();
  if (s.step === 'customer') {
    if (!q || q.length > 60) return false;
    await showCustomers(bot, msg.chat.id, userId, q);
    return true;
  }
  if (s.step === 'date') {
    if (!q || q.length > 30) return false;
    const { normalizeSalesDate } = require('../utils/dates');
    const iso = normalizeSalesDate(q);
    if (!iso) {
      await render(bot, msg.chat.id, userId,
        `${header(s)}\n\n⚠️ Could not read "${esc(q)}" as a date. Try 11-Jul-2026 — or use the calendar:`,
        [[{ text: '📆 Open calendar', callback_data: `sb:cal:${lagosISO(0).slice(0, 7)}` }], [{ text: '⬅ Quick dates', callback_data: 'sb:dts' }], cancelRow()]);
      return true;
    }
    await applyDate(bot, msg.chat.id, userId, iso);
    return true;
  }
  return false;
}

module.exports = {
  start, startWithBales, handleCallback, handleText, SESSION_TYPE,
  _internals: { showDates, showCalendar, applyDate, CALENDAR_MAX_DAYS_BACK },
};
