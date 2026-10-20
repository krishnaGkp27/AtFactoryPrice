'use strict';

/**
 * returnBundleFlow — RET-5 the typed multi-bale return (owner, 20-Oct-2026).
 *
 *   `Return 771, 779, 6189/5`  →  review card (every bale with its sold thans,
 *   grouped by the BUYER the sale record names)  →  🔎 Open a bale to untick
 *   →  date → condition → photo → ONE confirm card → ONE `return_bundle`
 *   request, dual-admin, every than credited to its own buyer at the rate
 *   it was charged.
 *
 * Owner's words: "No need to write customer name — it will show up when the
 * employee selects the bale number and than from it, as like in sell. Don't
 * make it bound to return from single customer only." So the line carries
 * bale numbers only, a bare bale loads EVERY than of it still sold (whoever
 * bought them), and a line may return several customers' goods at once.
 * Rulings R1–R5 (chat, 20-Oct-2026): one request per line; one date,
 * condition and photo per line; bales sold from different stores are
 * allowed (each goes back where it was sold from — TRF-INT4); the old
 * "Return than 2 from Bale 5801" line opens this same card; the tap tile
 * (↩️ Return goods, returnFlow) stays.
 *
 * Grammar = the typed sell line's (`thanListParser`): a comma starts a new
 * bale, `6189/5` one than, `6189/1+2` several thans of one bale, `771 x3`
 * opens the bale with its chips UNTICKED (SELL-T3 §2 — three of five is the
 * seller's choice).
 *
 * Session (type 'return_bundle_flow', callback namespace `rb:`):
 *   { step, flowMessageId, bales[], notLoaded[], bad[], ignored, openIdx,
 *     returnedOn, calYm, maxDaysBack, condition, conditionNote,
 *     photoFileId, photoKind, _submitting }
 *   bales[i] = { packageNo, warehouse, design, arrivalBatch, whole, needPick,
 *                inStockThans[], thans[{ thanNo, yards, shade, soldTo, rate,
 *                baleUid, picked, customer, customerId }] }
 * Callback payloads carry only indexes (64-byte cap).
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, rowsFor, mdEscape, beginSubmit, endSubmit } = require('../utils/flowKit');
const menuNav = require('../utils/menuNav');
const dateCalendar = require('../utils/dateCalendar');
const inventoryRepository = require('../repositories/inventoryRepository');
const unitDisplayService = require('../services/unitDisplayService');
const customerEntity = require('../services/customerEntity');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const idGenerator = require('../utils/idGenerator');
const { fmtQty } = require('../utils/format');
const money = require('../utils/money');
const fmtDate = require('../utils/formatDate');
const logger = require('../utils/logger');
const { parseThanList } = require('../utils/thanListParser');

const SESSION_TYPE = 'return_bundle_flow';
const NS = 'rb:';
const FLOW_TTL_MS = 20 * 60 * 1000;   // photo + typing steps; returnFlow precedent
const NOTE_MAX = 120;
const MAX_BALES = 40;
const RISK_REASON = 'All return operations require two-admin approval.';
const EXPIRED_ALERT = 'Card expired — type the return line again.';

const render = makeRenderer({ parseMode: 'Markdown', requireSession: true });
const { backAndCancelRow, cancelRow, menuRow } = rowsFor('rb');

const pkgKey = (s) => String(s == null ? '' : s).trim().toUpperCase();
const lc = (s) => String(s || '').trim().toLowerCase();
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const CONDITIONS = [
  { code: 'good', chip: '✅ Good — back to stock', line: '✅ Good — back to stock', short: '✅ Good' },
  { code: 'damaged', chip: '⚠️ Damaged', line: '⚠️ Damaged', short: '⚠️ Damaged' },
  { code: 'cut', chip: '✂️ Cut / short', line: '⚠️ Cut / short', short: '⚠️ Cut / short' },
  { code: 'other', chip: '📝 Other — I will type it', line: '⚠️ Condition noted', short: '⚠️ Noted' },
];
const conditionOf = (code) => CONDITIONS.find((c) => c.code === code) || null;

const PREV = {
  open: 'review', more: 'review', date: 'review', date_cal: 'date', condition: 'date',
  condition_note: 'condition', photo: 'condition', confirm: 'photo',
};

/* ── the inventory snapshot + the rule-6c labeller (one read per card) ──── */
const _snapshots = new Map();          // userId -> { rows, label, at }

async function snapshotFor(userId, { fresh = false } = {}) {
  const key = String(userId);
  const hit = _snapshots.get(key);
  if (!fresh && hit && (Date.now() - hit.at) < FLOW_TTL_MS) return hit;
  const rows = await inventoryRepository.getAll(true);   // status-mutating path: read fresh
  const label = await unitDisplayService.createQtyLabeller(rows);
  const entry = { rows, label, at: Date.now() };
  _snapshots.set(key, entry);
  return entry;
}
function forgetSnapshot(userId) { _snapshots.delete(String(userId)); }

/* ── load the typed items against the sheet (pure — unit-tested) ────────── */

/**
 * @param {Array<{packageNo:string, thans?:number[], count?:number}>} items parsed tokens
 * @param {Array<object>} rows the whole Inventory
 * @param {Array<object>} [existing] bales already on the list (➕ Add more)
 * @returns {{bales:Array<object>, notLoaded:Array<{packageNo:string, reason:string}>}}
 */
function loadLine(items, rows, existing = []) {
  const byPkg = new Map();
  for (const r of rows || []) {
    const k = pkgKey(r && r.packageNo);
    if (!k) continue;
    if (!byPkg.has(k)) byPkg.set(k, []);
    byPkg.get(k).push(r);
  }
  const bales = (existing || []).slice();
  const have = new Set(bales.map((b) => pkgKey(b.packageNo)));
  const notLoaded = [];
  for (const it of items || []) {
    const raw = String((it && it.packageNo) || '').trim();
    const k = pkgKey(raw);
    if (!k) continue;
    if (have.has(k)) { notLoaded.push({ packageNo: raw, reason: 'already on the list' }); continue; }
    if (bales.length >= MAX_BALES) {
      notLoaded.push({ packageNo: raw, reason: `the list holds ${MAX_BALES} bales — raise the rest as a second return` });
      continue;
    }
    const all = byPkg.get(k) || [];
    if (!all.length) { notLoaded.push({ packageNo: raw, reason: 'not found in Inventory — check the number' }); continue; }
    const sold = all.filter((r) => lc(r.status) === 'sold');
    const inStock = all.filter((r) => lc(r.status) === 'available');
    const transit = all.filter((r) => lc(r.status) === 'in_transit');
    if (!sold.length) {
      let reason;
      if (inStock.length) reason = `nothing sold — ${inStock.length === all.length ? 'all ' : ''}${plural(inStock.length, 'than')} in stock`;
      else if (transit.length) reason = 'still on the road — nothing sold';
      else reason = `nothing sold (status: ${all[0].status || 'unknown'})`;
      notLoaded.push({ packageNo: raw, reason });
      continue;
    }
    const places = new Set(sold.map((r) => `${pkgKey(r.warehouse)}|${String(r.arrivalBatch || '').trim()}`));
    if (places.size > 1) {
      notLoaded.push({ packageNo: raw, reason: 'this number was sold from two places or containers — raise it from ↩️ Return goods' });
      continue;
    }
    let picked = sold;
    let whole = true;
    let needPick = 0;
    if (Array.isArray(it.thans) && it.thans.length) {
      whole = false;
      const want = it.thans.map(String);
      picked = sold.filter((r) => want.includes(String(r.thanNo)));
      const missing = want.filter((n) => !sold.some((r) => String(r.thanNo) === n));
      if (!picked.length) {
        notLoaded.push({
          packageNo: `${raw}/${want.join('+')}`,
          reason: missing.map((n) => (all.some((r) => String(r.thanNo) === n) ? `than ${n} is not sold` : `than ${n} does not exist`)).join(', '),
        });
        continue;
      }
      if (missing.length) notLoaded.push({ packageNo: `${raw}/${missing.join('+')}`, reason: 'not sold — left out' });
    } else if (it.count) {
      whole = false;
      needPick = Number(it.count) || 0;
    }
    const first = sold[0];
    bales.push({
      packageNo: String(first.packageNo).trim(),
      warehouse: String(first.warehouse || '').trim(),
      design: String(first.design || '').trim(),
      arrivalBatch: String(first.arrivalBatch || '').trim(),
      whole,
      needPick,
      inStockThans: inStock.map((r) => String(r.thanNo)).sort((a, b) => Number(a) - Number(b)),
      thans: picked.slice().sort((a, b) => Number(a.thanNo) - Number(b.thanNo)).map((r) => ({
        thanNo: String(r.thanNo), yards: Number(r.yards) || 0, shade: String(r.shade || '').trim(),
        soldTo: String(r.soldTo || '').trim(), rate: Number(r.pricePerYard) || 0,
        baleUid: String(r.baleUid || ''), picked: !needPick, customer: '', customerId: '',
      })),
    });
    have.add(k);
  }
  return { bales, notLoaded };
}

/** Every than's buyer, canonical through the registry (one resolve per spelling). */
async function resolveBuyers(bales) {
  const cache = new Map();
  for (const b of bales) {
    for (const t of b.thans) {
      if (t.customer) continue;
      const raw = t.soldTo;
      if (!cache.has(raw)) {
        let found = null;
        if (raw) {
          try { found = await customerEntity.resolve({ name: raw }); } catch (_) { found = null; }
        }
        cache.set(raw, found && found.name ? { name: found.name, id: String(found.customer_id || '') } : { name: raw, id: '' });
      }
      const c = cache.get(raw);
      t.customer = c.name;
      t.customerId = c.id;
    }
  }
}

/* ── the request body (one builder — review, confirm and the queue row) ─── */

const buyerKey = (t) => String(t.customerId || '').trim() || pkgKey(t.customer || t.soldTo || '');

function buildActionJSON(session, label) {
  const items = [];
  const wholeBales = [];
  for (const b of session.bales || []) {
    const picked = b.thans.filter((t) => t.picked);
    if (!picked.length) continue;
    // A whole-bale LINE (`771 · 150 yd`) means the whole bale: every sold than
    // ticked AND nothing of it left on the shelf. A bale with a than still in
    // stock prints per than, however it was typed.
    if (b.whole && !b.inStockThans.length && picked.length === b.thans.length) wholeBales.push(b.packageNo);
    for (const t of picked) {
      items.push({
        packageNo: b.packageNo, thanNo: t.thanNo, baleUid: t.baleUid, warehouse: b.warehouse,
        design: b.design, shade: t.shade, arrivalBatch: b.arrivalBatch, yards: t.yards,
        pricePerYard: t.rate, soldTo: t.soldTo, customer: t.customer || t.soldTo, customerId: t.customerId || '',
      });
    }
  }
  const groups = [];
  for (const it of items) {
    const k = buyerKey(it);
    let g = groups.find((x) => x.key === k);
    if (!g) {
      g = { key: k, customer: it.customer, customerId: it.customerId, thans: 0, yards: 0, amount: 0, noRateThans: 0, qty: '', _items: [] };
      groups.push(g);
    }
    g.thans += 1;
    g.yards += Number(it.yards) || 0;
    if (Number(it.pricePerYard) > 0) g.amount += (Number(it.yards) || 0) * Number(it.pricePerYard);
    else g.noRateThans += 1;
    g._items.push(it);
  }
  groups.sort((a, b) => String(a.customer).localeCompare(String(b.customer)));
  for (const g of groups) {
    g.amount = Math.round(g.amount);
    g.qty = label ? label(g._items) : '';
    delete g._items;
    delete g.key;
  }
  const stores = [...new Set(items.map((it) => it.warehouse).filter(Boolean))];
  return {
    action: 'return_bundle',
    items,
    wholeBales,
    groups,
    stores,
    qty: label && items.length ? label(items) : '',
    thans: items.length,
    yards: items.reduce((s, it) => s + (Number(it.yards) || 0), 0),
    returnedOn: String(session.returnedOn || ''),
    condition: String(session.condition || ''),
    conditionNote: String(session.conditionNote || ''),
    return_photo_file_id: String(session.photoFileId || ''),
    return_photo_type: session.photoFileId ? String(session.photoKind || 'photo') : '',
  };
}

function creditLine(aj) {
  if (!aj.groups.length) return '';
  const bits = aj.groups.map((g) => (g.amount > 0
    ? `${mdEscape(g.customer || 'the buyer')} ${money.sale(g.amount)}${g.noRateThans ? ` (${g.noRateThans} without a rate)` : ''}`
    : `${mdEscape(g.customer || 'the buyer')} — no rate on record`));
  return `💰 Credits: ${bits.join(' · ')} _(at the rates charged)_`;
}

function header(session, aj) {
  const bits = ['↩️ *Return*'];
  if (aj && aj.items.length) bits.push(`📦 ${aj.qty} · ${fmtQty(aj.yards)} yd`);
  if (session.returnedOn) bits.push(`📅 ${fmtDate(session.returnedOn)}`);
  const cond = conditionOf(session.condition);
  if (cond) bits.push(cond.short);
  return bits.join('  ·  ');
}

/* ── cards ────────────────────────────────────────────────────────────── */

async function showReview(bot, chatId, userId, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const { label } = await snapshotFor(userId);
  session.step = 'review';
  session.openIdx = null;
  sessionStore.set(userId, session);
  const aj = buildActionJSON(session, label);
  const lines = await require('../services/approvalCards').returnBundleLines(aj, mdEscape);
  const bales = session.bales || [];

  let text = `↩️ *Return*${aj.stores.length ? ` · 🏭 ${aj.stores.map(mdEscape).join(' + ')}` : ''}`;
  text += aj.items.length
    ? `\n📦 ${aj.qty} · ${fmtQty(aj.yards)} yd${aj.groups.length > 1 ? ` · ${aj.groups.length} customers` : ''}`
    : '\n_Nothing loaded yet._';
  if (opts.note) text += `\n\n${opts.note}`;
  if (lines.length) text += `\n\n${lines.join('\n')}`;

  const wholeNow = bales.filter((b) => b.whole && b.thans.length && b.thans.every((t) => t.picked));
  if (wholeNow.length) {
    text += `\n\n📦 Loaded with every sold than: ${wholeNow.map((b) => mdEscape(b.packageNo)).join(', ')} — tap 🔎 Open to drop one.`;
  }
  const needPick = bales.filter((b) => b.needPick && !b.thans.some((t) => t.picked));
  if (needPick.length) {
    text += `\n\n🔎 *Tick the thans yourself (${needPick.length})*`;
    for (const b of needPick) text += `\n• ${mdEscape(b.packageNo)} — you asked for ${b.needPick} of ${b.thans.length} sold`;
  }
  const unticked = bales.filter((b) => !b.needPick && b.thans.length && !b.thans.some((t) => t.picked));
  const notLoaded = [...(session.notLoaded || []), ...unticked.map((b) => ({ packageNo: b.packageNo, reason: 'nothing ticked' }))];
  if (notLoaded.length) {
    text += `\n\n⚠️ *Not loaded (${notLoaded.length})*`;
    for (const n of notLoaded) text += `\n• ${mdEscape(n.packageNo)} — ${mdEscape(n.reason)}`;
  }
  if ((session.bad || []).length) {
    text += `\n\n❓ Could not read: ${session.bad.map((b) => `\`${String(b).replace(/`/g, '')}\``).join(', ')}`;
  }
  if (session.ignored) {
    text += `\nℹ️ I ignored "${mdEscape(session.ignored)}" — the buyer comes from the sale record.`;
  }
  if (aj.items.length) text += `\n\n${creditLine(aj)}`;

  const rows = [];
  for (let i = 0; i < bales.length; i += 2) {
    const row = [{ text: `🔎 Open ${bales[i].packageNo}`, callback_data: `${NS}o:${i}` }];
    if (bales[i + 1]) row.push({ text: `🔎 Open ${bales[i + 1].packageNo}`, callback_data: `${NS}o:${i + 1}` });
    rows.push(row);
  }
  if (aj.items.length) rows.push([{ text: '✅ Continue — date, condition, photo', callback_data: `${NS}go` }]);
  rows.push([{ text: '➕ Add more', callback_data: `${NS}more` }]);
  rows.push(cancelRow());
  await render(bot, chatId, userId, text, rows);
}

async function showOpen(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const b = (session.bales || [])[idx];
  if (!b) { await showReview(bot, chatId, userId); return; }
  session.step = 'open';
  session.openIdx = idx;
  sessionStore.set(userId, session);
  const approvalCards = require('../services/approvalCards');
  const shades = [...new Set(b.thans.map((t) => t.shade))];
  let shadeBit = '';
  if (shades.length === 1 && shades[0]) {
    let names = new Map();
    try { names = await approvalCards.shadeNamesFor(b.design, b.arrivalBatch); } catch (_) { /* bare */ }
    shadeBit = ` · ${mdEscape(approvalCards.shadeHeading(shades[0], names))}`;
  }
  let text = `↩️ *Return* · Bale *${mdEscape(b.packageNo)}*${b.design ? ` · ${mdEscape(b.design)}` : ''}${shadeBit}`;
  if (b.inStockThans.length) {
    text += `\n#${b.inStockThans.join(', #')} ${b.inStockThans.length === 1 ? 'is' : 'are'} in stock — not part of this return.`;
  }
  text += b.needPick
    ? `\n\nYou asked for ${b.needPick} of ${b.thans.length} sold — tick them:`
    : '\n\nUntick the thans that did NOT come back:';
  const chips = b.thans.map((t, i) => ({
    text: `${t.picked ? '☑' : '☐'} #${t.thanNo} · ${fmtQty(t.yards)}y · ${String(t.customer || t.soldTo || '?').slice(0, 14)}`,
    callback_data: `${NS}t:${idx}:${i}`,
  }));
  const rows = [];
  for (let i = 0; i < chips.length; i += 2) rows.push(chips.slice(i, i + 2));
  const allOn = b.thans.length > 0 && b.thans.every((t) => t.picked);
  rows.push([
    { text: allOn ? '⬜ Untick all' : `✅ Tick all ${b.thans.length}`, callback_data: `${NS}tall:${idx}` },
    { text: '⬅ Back to list', callback_data: `${NS}list` },
  ]);
  rows.push(cancelRow());
  await render(bot, chatId, userId, text, rows);
}

async function showMore(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'more';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `${header(session)}\n\nType the next bale numbers, comma-separated (\`6210, 6199/2\`):`,
    [backAndCancelRow(), menuRow()]);
}

async function showDate(bot, chatId, userId, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  if (!session.maxDaysBack) session.maxDaysBack = await dateCalendar.saleMaxDaysBack();
  session.step = 'date';
  sessionStore.set(userId, session);
  const { label } = await snapshotFor(userId);
  const keyboard = dateCalendar.quickChipRows('rb');
  keyboard.push(backAndCancelRow());
  keyboard.push(menuRow());
  await render(bot, chatId, userId,
    `${header(session, buildActionJSON(session, label))}\n\n${opts.note ? `${opts.note}\n\n` : ''}When did the goods come back?`,
    keyboard);
}

async function showCalendar(bot, chatId, userId, ym, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  if (!session.maxDaysBack) session.maxDaysBack = await dateCalendar.saleMaxDaysBack();
  session.step = 'date_cal';
  session.calYm = ym;
  sessionStore.set(userId, session);
  const { label } = await snapshotFor(userId);
  const keyboard = dateCalendar.calendarRows('rb', ym, {
    maxDaysBack: session.maxDaysBack,
    highlight: opts.highlight || session.returnedOn || '',
  });
  keyboard.push(backAndCancelRow());
  keyboard.push(menuRow());
  await render(bot, chatId, userId,
    `${header(session, buildActionJSON(session, label))}\n\n${opts.note ? `${opts.note}\n\n` : ''}`
    + `📆 *Tap* the day the goods came back (up to ${session.maxDaysBack} days back). Dots are out of range.`,
    keyboard);
}

async function showCondition(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'condition';
  sessionStore.set(userId, session);
  const { label } = await snapshotFor(userId);
  const rows = CONDITIONS.map((c) => [{ text: c.chip, callback_data: `${NS}c:${c.code}` }]);
  rows.push(backAndCancelRow());
  rows.push(menuRow());
  await render(bot, chatId, userId,
    `${header(session, buildActionJSON(session, label))}\n\nHow do the goods look?\n`
    + '_One condition for the whole line — goods in a different state go as a second return._',
    rows);
}

async function showConditionNote(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'condition_note';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `${header(session)}\n\nType what is wrong with the goods (one line):`,
    [backAndCancelRow(), menuRow()]);
}

async function showPhoto(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'photo';
  sessionStore.set(userId, session);
  const cond = conditionOf(session.condition);
  const note = cond && cond.code !== 'good' && !session.conditionNote ? '_You can also type a one-line note first._\n\n' : '';
  await render(bot, chatId, userId,
    `${header(session)}\n\n${note}📎 Send ONE photo of the goods — the admins see it on the card.`,
    [[{ text: '⏭ Skip photo', callback_data: `${NS}pskip` }], backAndCancelRow(), menuRow()]);
}

async function showConfirm(bot, chatId, userId, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const { label } = await snapshotFor(userId);
  session.step = 'confirm';
  sessionStore.set(userId, session);
  const aj = buildActionJSON(session, label);
  const lines = await require('../services/approvalCards').returnBundleLines(aj, mdEscape);
  const cond = conditionOf(session.condition);
  const facts = [
    `📅 Returned *${fmtDate(session.returnedOn)}*`,
    cond ? `${cond.line}${session.conditionNote ? ` — ${mdEscape(session.conditionNote)}` : ''}` : '',
    session.photoFileId ? '📎 Photo attached' : '',
  ].filter(Boolean);
  const parts = [
    `↩️ *Confirm return*${aj.stores.length ? ` · 🏭 ${aj.stores.map(mdEscape).join(' + ')}` : ''}`,
    facts.join(' · '),
    '',
    ...lines,
    '',
    `Σ ${aj.qty} · ${fmtQty(aj.yards)} yd`,
    creditLine(aj),
  ];
  if (aj.groups.some((g) => g.amount <= 0 || g.noRateThans)) {
    parts.push('⚠️ Thans without a rate come back to stock, but NO credit posts for them until a rate exists.');
  }
  parts.push('');
  if (opts.note) { parts.push(opts.note); parts.push(''); }
  parts.push("Approving puts the stock back and credits each customer's account.");
  parts.push('Queues dual-admin approval.');
  await render(bot, chatId, userId, parts.join('\n'), [
    [{ text: '✅ Submit for approval', callback_data: `${NS}submit` }],
    backAndCancelRow(),
    menuRow(),
  ]);
}

function submittedText(aj, requestId, isAdmin, sentCards) {
  const lines = [
    '↩️ *Return — submitted*',
    '',
    `📦 ${aj.qty} · ${fmtQty(aj.yards)} yd · ${aj.groups.map((g) => mdEscape(g.customer || 'the buyer')).join(', ')}`,
    '',
    isAdmin ? "⏳ Waiting for a 2nd admin's approval." : '⏳ Waiting for two admins to sign.',
    `Request: \`${requestId}\``,
  ];
  if (!sentCards) lines.push('\n⚠️ No admin card went out — tell an admin the ref.');
  return lines.join('\n');
}

/* ── entry ────────────────────────────────────────────────────────────── */

/**
 * Open the review card for a typed line. Returns true when a card was shown
 * (the controller then stops), false when nothing on the line could be read.
 * @param {object} parsed `thanListParser.parseThanList` output
 */
async function startWithLine(bot, chatId, userId, parsed, { messageId = null } = {}) {
  const uid = String(userId);
  const items = (parsed && Array.isArray(parsed.items)) ? parsed.items : [];
  if (!items.length) return false;
  forgetSnapshot(uid);
  let snap;
  try { snap = await snapshotFor(uid, { fresh: true }); } catch (e) {
    logger.warn(`returnBundleFlow: inventory read failed: ${e.message}`);
    await bot.sendMessage(chatId, '⚠️ Could not read the stock sheet just now — send the line again in a moment.');
    return true;
  }
  const { bales, notLoaded } = loadLine(items, snap.rows, []);
  await resolveBuyers(bales);
  const ignored = [parsed.ignoredCustomer, parsed.warehouseHint].filter(Boolean).join(' ');
  sessionStore.set(uid, {
    type: SESSION_TYPE,
    step: 'review',
    flowMessageId: messageId || null,
    startedAt: Date.now(),
    ttlMs: FLOW_TTL_MS,
    bales,
    notLoaded,
    bad: Array.isArray(parsed.bad) ? parsed.bad.slice(0, 6) : [],
    ignored,
    openIdx: null,
    returnedOn: '', calYm: '', maxDaysBack: 0,
    condition: '', conditionNote: '', photoFileId: '', photoKind: '',
  });
  await showReview(bot, chatId, uid, parsed.commaThanHint
    ? { note: '_For several thans of one bale use_ `1100/1+2+3` _(a comma always means a new bale)._' }
    : {});
  return true;
}

/* ── submit ───────────────────────────────────────────────────────────── */

async function submit(bot, chatId, userId, session) {
  await render(bot, chatId, userId, '⏳ *Submitting…*', []);
  const requestId = idGenerator.requestId();
  const { label } = await snapshotFor(userId);
  const actionJSON = buildActionJSON(session, label);
  try {
    await approvalQueueRepository.append({
      requestId,
      user: String(userId),
      actionJSON,
      riskReason: RISK_REASON,
      status: 'pending',
    });
  } catch (e) {
    logger.error(`[returnBundleFlow] queue append failed: ${e.message}`);
    endSubmit(session, userId);
    await showConfirm(bot, chatId, userId, {
      note: `⚠️ Could not submit: ${mdEscape(e.message)} — tap Submit again.`,
    });
    return;
  }
  try {
    await auditLogRepository.append('approval_queued', {
      requestId,
      action: 'return_bundle',
      thans: actionJSON.thans,
      yards: actionJSON.yards,
      bales: [...new Set(actionJSON.items.map((it) => it.packageNo))],
      customers: actionJSON.groups.map((g) => g.customer),
      condition: actionJSON.condition,
      returnedOn: actionJSON.returnedOn,
      photo: !!actionJSON.return_photo_file_id,
      source: 'return_bundle_flow',
    }, String(userId));
  } catch (e) { logger.warn(`[returnBundleFlow] audit row failed: ${e.message}`); }

  let isAdmin = false;
  try { isAdmin = require('../middlewares/auth').isAdmin(String(userId)); } catch (_) { /* employee */ }
  const excludeId = isAdmin ? String(userId) : undefined;

  let sentCards = 0;
  try {
    const approvalEvents = require('../events/approvalEvents');
    const approvalCards = require('../services/approvalCards');
    const card = await approvalCards.buildReturnBundleCard(actionJSON);
    const who = await approvalCards.resolveUserLabel(String(userId), bot);
    const res = await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, who, card, RISK_REASON, excludeId);
    sentCards = (res && res.sent) || 0;
    if (actionJSON.return_photo_file_id) {
      await approvalCards.forwardAttachmentsToAdmins(bot, requestId, [{
        fileId: actionJSON.return_photo_file_id,
        kind: actionJSON.return_photo_type === 'document' ? 'document' : 'photo',
        caption: `📷 Returned goods for request ${requestId}`,
      }], excludeId);
    }
  } catch (e) {
    logger.warn(`[returnBundleFlow] admin card for ${requestId}: ${e.message}`);
  }

  await render(bot, chatId, userId,
    submittedText(actionJSON, requestId, isAdmin, sentCards),
    [menuNav.hubAndMenuFooterRow('stock_move', 'Move Stock')]);
  try {
    await require('../utils/requesterCard').rememberRequesterCard(requestId, chatId, String(userId));
  } catch (e) { logger.warn(`[returnBundleFlow] requester card: ${e.message}`); }
  forgetSnapshot(userId);
  sessionStore.clear(String(userId));
}

/* ── callbacks ────────────────────────────────────────────────────────── */

async function handleCallback(bot, callbackQuery) {
  const data = (callbackQuery && callbackQuery.data) || '';
  if (!data.startsWith(NS)) return false;
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id;

  let answered = false;
  const ack = async (t, alert) => {
    if (answered) return;
    answered = true;
    try {
      await bot.answerCallbackQuery(callbackQuery.id, t ? { text: t, show_alert: !!alert } : undefined);
    } catch (_) { /* stale query id */ }
  };

  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    await ack(EXPIRED_ALERT, true);
    return true;
  }
  const tapped = callbackQuery.message && callbackQuery.message.message_id;
  if (session.flowMessageId && tapped && tapped !== session.flowMessageId) {
    await ack(EXPIRED_ALERT, true);
    return true;
  }
  const rest = data.slice(NS.length);
  try {
    if (rest === 'cancel') {
      await ack('Cancelled');
      await render(bot, chatId, userId, '❌ Return cancelled — nothing was queued.', [menuRow()]);
      forgetSnapshot(userId);
      sessionStore.clear(userId, 'cancelled');
      return true;
    }
    if (rest === 'submit') {
      if (!beginSubmit(session, userId)) { await ack('Already submitting…'); return true; }
      const anyPicked = (session.bales || []).some((b) => b.thans.some((t) => t.picked));
      if (session.step !== 'confirm' || !anyPicked) {
        endSubmit(session, userId);
        await ack('That card is no longer the live one.', true);
        return true;
      }
      await ack();
      await submit(bot, chatId, userId, session);
      return true;
    }
    if (rest === 'noop') { await ack(); return true; }
    if (rest === 'list') { await ack(); await showReview(bot, chatId, userId); return true; }
    if (rest === 'more') { await ack(); await showMore(bot, chatId, userId); return true; }
    if (rest.startsWith('o:')) {
      await ack();
      await showOpen(bot, chatId, userId, parseInt(rest.slice(2), 10));
      return true;
    }
    if (rest.startsWith('t:')) {
      const [bi, ti] = rest.slice(2).split(':').map((n) => parseInt(n, 10));
      const b = (session.bales || [])[bi];
      const t = b && b.thans[ti];
      if (!t) { await ack('That list expired.', true); await showReview(bot, chatId, userId); return true; }
      t.picked = !t.picked;
      sessionStore.set(userId, session);
      await ack();
      await showOpen(bot, chatId, userId, bi);
      return true;
    }
    if (rest.startsWith('tall:')) {
      const bi = parseInt(rest.slice(5), 10);
      const b = (session.bales || [])[bi];
      if (!b) { await ack(); await showReview(bot, chatId, userId); return true; }
      const allOn = b.thans.length > 0 && b.thans.every((t) => t.picked);
      for (const t of b.thans) t.picked = !allOn;
      sessionStore.set(userId, session);
      await ack();
      await showOpen(bot, chatId, userId, bi);
      return true;
    }
    if (rest === 'go') {
      if (!(session.bales || []).some((b) => b.thans.some((t) => t.picked))) {
        await ack('Nothing is ticked yet.', true);
        return true;
      }
      await ack();
      await showDate(bot, chatId, userId);
      return true;
    }
    if (rest === 'dq') { await ack(); await showDate(bot, chatId, userId); return true; }
    if (rest.startsWith('dm:')) { await ack(); await showCalendar(bot, chatId, userId, rest.slice(3)); return true; }
    if (rest.startsWith('dd:')) {
      const iso = rest.slice(3);
      if (!session.maxDaysBack) session.maxDaysBack = await dateCalendar.saleMaxDaysBack();
      const range = dateCalendar.checkRange(iso, session.maxDaysBack);
      if (!range.ok) {
        await ack(range.reason === 'future' ? 'That date is in the future.'
          : `That is further back than ${session.maxDaysBack} days.`, true);
        const note = range.reason === 'future'
          ? '⚠️ That date is in the future.'
          : `⚠️ That is further back than ${session.maxDaysBack} days.`;
        if (session.step === 'date_cal') await showCalendar(bot, chatId, userId, session.calYm || iso.slice(0, 7), { note });
        else await showDate(bot, chatId, userId, { note });
        return true;
      }
      session.returnedOn = iso;
      sessionStore.set(userId, session);
      await ack(fmtDate(iso));
      await showCondition(bot, chatId, userId);
      return true;
    }
    if (rest.startsWith('c:')) {
      const cond = conditionOf(rest.slice(2));
      if (!cond) { await ack(); return true; }
      session.condition = cond.code;
      if (cond.code !== 'other') session.conditionNote = '';
      sessionStore.set(userId, session);
      await ack(cond.short);
      if (cond.code === 'other') await showConditionNote(bot, chatId, userId);
      else await showPhoto(bot, chatId, userId);
      return true;
    }
    if (rest === 'pskip') {
      session.photoFileId = '';
      session.photoKind = '';
      sessionStore.set(userId, session);
      await ack('No photo');
      await showConfirm(bot, chatId, userId);
      return true;
    }
    if (rest === 'back') {
      const prev = PREV[session.step] || '';
      await ack();
      if (prev === 'review' || !prev) { await showReview(bot, chatId, userId); return true; }
      if (prev === 'date') { await showDate(bot, chatId, userId); return true; }
      if (prev === 'condition') { await showCondition(bot, chatId, userId); return true; }
      if (prev === 'photo') { await showPhoto(bot, chatId, userId); return true; }
      return true;
    }
  } catch (e) {
    logger.error(`[returnBundleFlow] ${data} failed: ${e.message}`);
    await ack('That step failed — tap the buttons again.', true);
    return true;
  }
  await ack();
  return true;
}

/* ── typed text and the photo ─────────────────────────────────────────── */

/** The typed reply sits BELOW the card: drop the card so the next render lands under the reply. */
async function dropBelow(bot, chatId, userId, session) {
  const mid = session.flowMessageId;
  if (!mid) return;
  let deleted = false;
  try { await bot.deleteMessage(chatId, mid); deleted = true; } catch (_) { /* >48h or already gone */ }
  if (!deleted) {
    try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: mid }); } catch (_) { /* gone */ }
  }
  session.flowMessageId = null;
  sessionStore.set(userId, session);
}

async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return false;
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();
  if (!text) return false;

  if (session.step === 'more' || session.step === 'review') {
    const line = /^(?:return|sell)\b/i.test(text) ? text : `return ${text}`;
    if (!/\d/.test(line)) return false;
    const parsed = parseThanList(line);
    if (!parsed.items.length && !(parsed.bad || []).length) return false;
    const { rows } = await snapshotFor(userId);
    const { bales, notLoaded } = loadLine(parsed.items, rows, session.bales || []);
    const added = bales.length - (session.bales || []).length;
    await resolveBuyers(bales);
    session.bales = bales;
    session.notLoaded = notLoaded;   // the earlier "not loaded" list is superseded by this line's
    session.bad = (parsed.bad || []).slice(0, 6);
    sessionStore.set(userId, session);
    await dropBelow(bot, chatId, userId, session);
    await showReview(bot, chatId, userId, { note: added ? `➕ Added ${plural(added, 'bale')}.` : '_Nothing new was added._' });
    return true;
  }
  if (session.step === 'condition_note') {
    session.conditionNote = text.slice(0, NOTE_MAX);
    if (!session.condition) session.condition = 'other';
    sessionStore.set(userId, session);
    await dropBelow(bot, chatId, userId, session);
    await showPhoto(bot, chatId, userId);
    return true;
  }
  if (session.step === 'photo' && session.condition && session.condition !== 'good' && !session.conditionNote) {
    session.conditionNote = text.slice(0, NOTE_MAX);
    sessionStore.set(userId, session);
    await dropBelow(bot, chatId, userId, session);
    await showPhoto(bot, chatId, userId);
    return true;
  }
  if (session.step === 'date' || session.step === 'date_cal') {
    if (text.length > 30) return false;
    const { normalizeSalesDate } = require('../utils/dates');
    const iso = normalizeSalesDate(text);
    if (!session.maxDaysBack) session.maxDaysBack = await dateCalendar.saleMaxDaysBack();
    const range = iso ? dateCalendar.checkRange(iso, session.maxDaysBack) : { ok: false };
    await dropBelow(bot, chatId, userId, session);
    if (iso && range.ok) {
      await showCalendar(bot, chatId, userId, iso.slice(0, 7), {
        highlight: iso,
        note: `You typed *${fmtDate(iso)}* — confirm it with a TAP:`,
      });
      return true;
    }
    await showCalendar(bot, chatId, userId, dateCalendar.lagosISO(0).slice(0, 7), {
      note: iso
        ? `⚠️ ${fmtDate(iso)} is out of range (no future, max ${session.maxDaysBack} days back) — tap a valid day:`
        : `⚠️ Could not read "${mdEscape(text)}" as a date — tap it instead:`,
    });
    return true;
  }
  return false;
}

async function handlePhoto(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE || session.step !== 'photo') return false;
  let fileId = '';
  let kind = 'photo';
  if (Array.isArray(msg.photo) && msg.photo.length) fileId = msg.photo[msg.photo.length - 1].file_id;
  else if (msg.document && /^image\//i.test(String(msg.document.mime_type || ''))) {
    fileId = msg.document.file_id;
    kind = 'document';
  }
  if (!fileId) return false;
  session.photoFileId = fileId;
  session.photoKind = kind;
  session.step = 'confirm';
  sessionStore.set(userId, session);
  await dropBelow(bot, msg.chat.id, userId, session);
  await showConfirm(bot, msg.chat.id, userId);
  return true;
}

module.exports = {
  SESSION_TYPE,
  startWithLine,
  handleCallback,
  handleText,
  handlePhoto,
  _internals: { loadLine, buildActionJSON, CONDITIONS },
};
