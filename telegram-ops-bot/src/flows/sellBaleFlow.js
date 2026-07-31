'use strict';

/**
 * ST-1 Part A — 💰 Sell Bale: the fully tappable sale flow
 * (specs/ST-1_TAPPABLE_SALE.md, owner-locked 14-Jul-2026).
 *
 * Kills the typo sources of typed sales: salesperson and date are chips
 * backed by real data. Steps:
 *   container → warehouse → design (+ catalogue photo) → bale multi-select
 *   cart → salesperson → date → review.
 *
 * DSP-1 (owner 26-Jul): the customer and payment steps were removed — the
 * admin assigns customer, rate and payment at approval, and the result is
 * written back into the dispatcher's submitted card.
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
const usersRepository = require('../repositories/usersRepository');
const salesFlow = require('../services/salesFlowService');
const designAssetsService = require('../services/designAssetsService');
const { fmtQty } = require('../utils/format');
const fmtDate = require('../utils/formatDate');
const logger = require('../utils/logger');
const { LAGOS_TZ } = require('../utils/dates');
const { isNotModified } = require('../utils/telegramUI');
// SJ-4 — catalogue photo cards are tracked and disposed of at
// finalize/cancel (and by the janitor on abandonment), leaving only the
// sealed receipt in the chat.
const { trackAux, disposeAux } = require('../utils/flowKit');

const SESSION_TYPE = 'sell_bale_flow';
const TTL_MS = 20 * 60 * 1000;
const MAX_CHIPS = 12;

function esc(s) { return String(s == null ? '' : s).replace(/[*_`[\]]/g, ''); }

function lagosISO(daysBack = 0) {
  return new Date(Date.now() - daysBack * 86400000)
    .toLocaleDateString('en-CA', { timeZone: LAGOS_TZ });
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
    } catch (e) {
      if (isNotModified(e)) return; // screen already correct — not a failure
      /* fall through to fresh send */
    }
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
    if (s.warehouse && String(r.warehouse || '').trim().toLowerCase() !== String(s.warehouse).trim().toLowerCase()) return false;
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
  // SJ-4 — a restart abandons any previous run; its tracked photo cards
  // would otherwise strand forever (deliberate clear() skips the janitor).
  await disposeAux(bot, chatId, userId);
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
      [{ text: `🧑 Pick salesperson (${s.cart.length} bales)`, callback_data: 'sb:rev' }],
      [{ text: '➕ Add more bales', callback_data: 'sb:more' }],
      cancelRow(),
    ]);
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function start(bot, chatId, userId) {
  // SJ-4 — see startWithBales: sweep the previous run's tracked messages.
  await disposeAux(bot, chatId, userId);
  sessionStore.clear(userId);
  save(userId, { type: SESSION_TYPE, step: 'container', cart: [], flowMessageId: null });
  const s = getSession(userId);
  let containers = [];
  try { containers = await inventoryRepository.getArrivalBatches(); } catch (_) {}
  if (!containers.length) {
    await render(bot, chatId, userId, '⚠️ No available stock to sell.',
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return;
  }
  s._containers = containers.map((c) => c.batch);
  s._containerMeta = containers.map((c) => ({ label: c.label, bales: c.bales }));
  s.ctPage = 0;
  save(userId, s);
  await showContainers(bot, chatId, userId);
}

/** WH-VIS1 — paged container chips. The old screen silently cut the list
 *  at MAX_CHIPS: stock in the 13th+ container (small or old batches) was
 *  unreachable through this flow with no hint it existed. */
async function showContainers(bot, chatId, userId) {
  const s = getSession(userId);
  if (!s) return;
  const meta = s._containerMeta || [];
  const pages = Math.max(1, Math.ceil(meta.length / MAX_CHIPS));
  const page = Math.min(Math.max(s.ctPage || 0, 0), pages - 1);
  s.ctPage = page;
  save(userId, s);
  const startIdx = page * MAX_CHIPS;
  const slice = meta.slice(startIdx, startIdx + MAX_CHIPS);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    // Chip indexes stay ABSOLUTE into s._containers so paging never
    // changes what a tap means.
    const a = startIdx + i;
    const row = [{ text: `🚢 ${slice[i].label} (${slice[i].bales} bls)`, callback_data: `sb:ct:${a}` }];
    if (slice[i + 1]) row.push({ text: `🚢 ${slice[i + 1].label} (${slice[i + 1].bales} bls)`, callback_data: `sb:ct:${a + 1}` });
    rows.push(row);
  }
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `sb:ctpg:${page - 1}` });
  if (page < pages - 1) nav.push({ text: `More containers (${meta.length - startIdx - slice.length}) ➡️`, callback_data: `sb:ctpg:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push(cancelRow());
  rows.push([{ text: '🏠 Menu', callback_data: 'act:__back__' }]);
  await render(bot, chatId, userId, `${header(s)}\n\nSelect container (arrival batch):`, rows);
}

async function showWarehouses(bot, chatId, userId) {
  const s = getSession(userId);
  const rows0 = await scopedRows(s);
  // WH-VIS1 — dedupe case-insensitively ('Kano office' / 'Kano Office' are
  // one warehouse); first-seen spelling is the display label.
  const whSeen = new Map();
  for (const r of rows0) {
    const w = String(r.warehouse || '').trim();
    if (w && !whSeen.has(w.toLowerCase())) whSeen.set(w.toLowerCase(), w);
  }
  const warehouses = [...whSeen.values()].sort();
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
      const sentPhoto = await designAssetsService.sendDesignPhoto({
        bot, chatId, design: s.design,
        arrivalBatch: s.arrivalBatch === inventoryRepository.UNLABELLED_BATCH ? undefined : s.arrivalBatch,
        caption: `📷 *${esc(s.design)}*${s.arrivalBatch ? ` · 🚢 ${esc(s.arrivalBatch)}` : ''}`,
        returnSentMessage: true,
      });
      const supersededCardId = s.flowMessageId;
      s.flowMessageId = null; save(userId, s); // next render below the photo
      // SJ-4 — disposed of at finalize/cancel/abandon. trackAux mutates the
      // STORED session, so it must run after the final save() above — the
      // superseded anchor card would otherwise strand with a live keyboard.
      if (supersededCardId) trackAux(userId, supersededCardId);
      if (sentPhoto && sentPhoto.message_id) trackAux(userId, sentPhoto.message_id);
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
  await render(bot, chatId, userId, `${header(s)}\n\nSelect salesperson:`, rows);
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
 * opts.highlight — an ISO day rendered as [D]: a TYPED date only marks the
 * day; the TAP is the sole commit (owner refinement 21-Jul).
 * opts.note — one-line message above the grid.
 */
async function showCalendar(bot, chatId, userId, ym, opts = {}) {
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
      ? { text: opts.highlight === iso ? `[${d}]` : String(d), callback_data: `sb:cd:${iso}` }
      : { text: '·', callback_data: 'sb:noop' });
    if (week.length === 7) { rows.push(week); week = []; }
  }
  if (week.length) { while (week.length < 7) week.push({ text: ' ', callback_data: 'sb:noop' }); rows.push(week); }
  rows.push([{ text: '⬅ Quick dates', callback_data: 'sb:dts' }]);
  rows.push(cancelRow());
  s.step = 'date'; save(userId, s);
  await render(bot, chatId, userId,
    `${header(s)}\n\n${opts.note ? `${opts.note}\n\n` : ''}📆 *Tap* the sale date (up to ${CALENDAR_MAX_DAYS_BACK} days back). Dots are out of range.`, rows);
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
    `🧑 Salesperson: *${esc(s.salesperson)}*`,
    `📅 Date: *${fmtDate(s.salesDate)}*`,
    ...(s.backdatedDays
      ? ['', `⚠️ *BACKDATED — ${s.backdatedDays} days in the past.* Both admins will see this flag and it is stamped in the sales record.`]
      : []),
    '',
    '_Next: attach the sales bill photo, then it goes for admin approval._',
    '_The admin assigns the customer, rate and payment — you will get the customer name and number back here once approved._',
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
  // SJ-4 — the catalogue photo cards served their purpose; only the sale
  // receipt should remain. Must run BEFORE startSession replaces the session.
  await disposeAux(bot, chatId, userId);
  const reviewCardId = s.flowMessageId || null;
  const items = s.cart.map((c) => ({ type: 'package', packageNo: c.packageNo }));
  const saleType = items.length > 1 ? 'sell_batch' : 'sell_package';
  salesFlow.startSession(userId, saleType, items, {
    // DSP-1 — customer and payment mode are assigned by the admin at
    // approval; the dispatcher supplies only what physically ships.
    customer: '',
    salesperson: s.salesperson,
    paymentMode: '',
    salesDate: s.salesDate,
  });
  // SJ-4 — the review card becomes the bill prompt (edited in place, dead
  // sb: buttons gone) and rides the sale session's aux list so the sale's
  // submit/cancel — or the janitor on abandonment — can dispose of it.
  const promptText = '📎 Please send the *sales bill photo or PDF* to attach with this sale.';
  let promptMsgId = null;
  if (reviewCardId) {
    try {
      await bot.editMessageText(promptText, { chat_id: chatId, message_id: reviewCardId, parse_mode: 'Markdown' });
      promptMsgId = reviewCardId;
    } catch (_) { /* deleted / un-editable — fresh send below */ }
  }
  if (!promptMsgId) {
    try {
      const sent = await bot.sendMessage(chatId, promptText, { parse_mode: 'Markdown' });
      promptMsgId = (sent && sent.message_id) || null;
    } catch (_) { /* prompt failed — the typed-sale nag will re-ask */ }
  }
  const saleSession = salesFlow.getSession(userId);
  if (saleSession) {
    saleSession.awaitingDocument = true;
    if (promptMsgId) saleSession._auxMsgIds = [promptMsgId];
    sessionStore.set(userId, saleSession);
  }
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
      await ack('Cancelled');
      // SJ-4 — cancelled: the photo cards go with the flow.
      await disposeAux(bot, chatId, userId);
      // Render BEFORE clearing so the anchored card is edited in place, and
      // leave a Menu button instead of a dead empty keyboard.
      await render(bot, chatId, userId, '❌ Sale cancelled. Nothing was submitted.',
        [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
      sessionStore.clear(userId);
      return true;
    }
    if (data === 'sb:noop') { await ack(); return true; }

    const s = getSession(userId);
    if (!s) {
      await ack('Session expired — start again from 💰 Sell Bale.');
      return true;
    }

    if (data.startsWith('sb:ctpg:')) {
      // WH-VIS1 — container paging.
      s.ctPage = parseInt(data.slice(8), 10) || 0; save(userId, s);
      await ack();
      await showContainers(bot, chatId, userId);
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
    // DSP-1 — cart goes straight to salesperson: the customer and the
    // payment terms are the admin's to set at approval.
    if (data === 'sb:rev') {
      if (!s.cart.length) { await ack('Cart is empty.'); return true; }
      await ack();
      await showSalespersons(bot, chatId, userId);
      return true;
    }
    if (data.startsWith('sb:sp:')) {
      const sp = (s._salespersons || [])[parseInt(data.slice(6), 10)];
      if (!sp) { await ack('Expired — pick again.'); return true; }
      s.salesperson = sp; save(userId, s);
      await ack(sp);
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
  if (s.step === 'date') {
    if (!q || q.length > 30) return false;
    // Owner refinement 21-Jul: a TYPED date NEVER executes — it only
    // navigates the calendar to that month with the day marked [D]; the
    // tap is the sole commit. A typo'd year just opens the wrong page,
    // visibly, instead of silently becoming the sale date.
    const { normalizeSalesDate } = require('../utils/dates');
    const iso = normalizeSalesDate(q);
    const todayIso = lagosISO(0);
    const oldestIso = lagosISO(CALENDAR_MAX_DAYS_BACK);
    if (iso && iso <= todayIso && iso >= oldestIso) {
      await showCalendar(bot, msg.chat.id, userId, iso.slice(0, 7), {
        highlight: iso,
        note: `You typed *${fmtDate(iso)}* — confirm it with a TAP:`,
      });
      return true;
    }
    await showCalendar(bot, msg.chat.id, userId, todayIso.slice(0, 7), {
      note: iso
        ? `⚠️ ${fmtDate(iso)} is out of range (no future, max ${CALENDAR_MAX_DAYS_BACK} days back) — tap a valid date:`
        : `⚠️ Could not read "${esc(q)}" as a date — tap it instead:`,
    });
    return true;
  }
  return false;
}

module.exports = {
  start, startWithBales, handleCallback, handleText, SESSION_TYPE,
  _internals: { showDates, showCalendar, applyDate, CALENDAR_MAX_DAYS_BACK },
};
