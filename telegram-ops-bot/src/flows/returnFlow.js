'use strict';

/**
 * returnFlow — RET-4 ↩️ Return goods: the customer-first, multi-than return
 * door (specs/RET-3_RETURN_CREDIT.md Part B, owner-locked 02-Sep-2026).
 *
 *   customer → bale → tick thans → returned-on → condition → photo → confirm
 *
 * One request per SET of ticked thans (action `return_thans`, dual-admin):
 * both admins sign the whole set, so every than in it still carries two
 * signatures (DUAL-1). TRF-INT4: the return lands in the warehouse the bale
 * was SOLD from — cross-warehouse returns are out until §6 is re-ruled, and
 * the `returned_to` step slots between the thans and date steps when it is
 * (see prevStep/nextStep — those two lines are the whole seam).
 * §6d: the condition is recorded and shown; the than still goes back to
 * `available`.
 *
 * Session (type 'return_flow', callback namespace `rn:`):
 *   { step, flowMessageId, _customers/_bales/_thans/_picked (chip index
 *     arrays — callback_data carries ONLY the index, 64-byte cap),
 *     customer, customerId, packageNo, warehouse, design, shade,
 *     arrivalBatch, returnedOn, calYm, maxDaysBack, condition,
 *     conditionNote, photoFileId, photoKind, yards, rate, qtyLabel,
 *     _submitting }
 */

const sessionStore = require('../utils/sessionStore');
const {
  makeRenderer, rowsFor, chunk, mdEscape, beginSubmit, endSubmit,
} = require('../utils/flowKit');
const menuNav = require('../utils/menuNav');
const dateCalendar = require('../utils/dateCalendar');
const inventoryRepository = require('../repositories/inventoryRepository');
const unitDisplayService = require('../services/unitDisplayService');
const customerEntity = require('../services/customerEntity');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const idGenerator = require('../utils/idGenerator');
const { cbSafe, safeDelete } = require('../utils/telegramUI');
const { fmtQty, fmtMoneyShort } = require('../utils/format');
const fmtDate = require('../utils/formatDate');
const logger = require('../utils/logger');

const SESSION_TYPE = 'return_flow';
const NS = 'rn:';
const FLOW_TTL_MS = 20 * 60 * 1000;   // photo + typing steps; paymentFlow precedent
const MAX_CUSTOMER_CHIPS = 24;
const MAX_BALE_CHIPS = 24;
const MAX_THAN_CHIPS = 40;
const NOTE_MAX = 120;
const RISK_REASON = 'All return operations require two-admin approval.';
const EXPIRED_ALERT = 'Card expired — open ↩️ Return goods again.';

const render = makeRenderer({ parseMode: 'Markdown', requireSession: true });
const { backAndCancelRow, cancelRow, menuRow } = rowsFor('rn');

const norm = customerEntity._internals.norm;

/* ── the quantity labeller (§6c — no hardcoded "4B" / "2t" anywhere) ──────
 *
 * unitDisplayService.createQtyLabeller is ASYNC (it awaits the than-visible
 * warehouse set); the value it resolves to is the SYNC labeller. Calling it
 * without awaiting yields a Promise that is then invoked as a function —
 * a TypeError that would make the tile do nothing at all. It is resolved
 * once per run and cached with the whole-sheet snapshot it was built from.
 */
const _snapshots = new Map();          // userId -> { rows, label, at }
const SNAPSHOT_TTL_MS = FLOW_TTL_MS;

async function snapshotFor(userId, { fresh = false } = {}) {
  const key = String(userId);
  const hit = _snapshots.get(key);
  if (!fresh && hit && (Date.now() - hit.at) < SNAPSHOT_TTL_MS) return hit;
  // TRF-INT1 — this is a status-mutating path: the picker reads fresh.
  const rows = await inventoryRepository.getAll(true);
  const label = await unitDisplayService.createQtyLabeller(rows);
  const entry = { rows, label, at: Date.now() };
  _snapshots.set(key, entry);
  if (_snapshots.size > 200) {         // bounded: an abandoned flow cannot leak
    const oldest = [..._snapshots.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _snapshots.delete(oldest[0]);
  }
  return entry;
}

function forgetSnapshot(userId) { _snapshots.delete(String(userId)); }

/* ── data helpers ─────────────────────────────────────────────────────── */

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

/** Bale identity for the picker: §6c — a printed number recycles across
 *  containers, and §5 lets a SOLD 9037 sit beside a LIVE 9037 in one store. */
function baleKeyOf(r) {
  return `${upper(r.warehouse)}|${upper(r.packageNo)}|${upper(r.arrivalBatch)}`;
}

/**
 * Customers with goods still out, most recent sale first.
 *
 * Deliberately NOT inventoryRepository.getSoldRows(): that helper also
 * requires soldDate, and a sold row with a blank date would be unreturnable.
 *
 * @param {Array<object>} allRows every Inventory row
 * @param {Function} label the resolved qty labeller
 * @returns {Array<{name:string, key:string, rows:Array<object>, label:string}>}
 */
function loadCustomers(allRows, label) {
  const groups = new Map();
  for (const r of allRows || []) {
    if (String(r.status || '').toLowerCase() !== 'sold') continue;
    const name = String(r.soldTo || '').trim();
    if (!name) continue;
    const key = norm(name);
    if (!groups.has(key)) groups.set(key, { name, key, rows: [], lastSold: '' });
    const g = groups.get(key);
    g.rows.push(r);
    const d = String(r.soldDate || '');
    if (d > g.lastSold) g.lastSold = d;
  }
  const list = [...groups.values()];
  list.sort((a, b) => (b.lastSold || '').localeCompare(a.lastSold || '')
    || a.name.localeCompare(b.name));
  for (const g of list) {
    const qty = typeof label === 'function' ? label(g.rows) : '';
    g.label = qty ? `${g.name} · ${qty}` : g.name;
  }
  return list;
}

/**
 * One customer's sold rows grouped into physical bales.
 *
 * `rosterThans` is the bale's FULL roster (all statuses) for the same
 * warehouse|packageNo|arrivalBatch, so a whole bale can be told from a part.
 * `ambiguous` marks the §3 container gap: two entries sharing
 * warehouse|packageNo differ only by container, which the owner-locked
 * payload cannot carry — those chips refuse to advance rather than let the
 * executor flip the wrong same-numbered bale.
 *
 * @param {Array<object>} custRows @param {Array<object>} allRows
 * @param {Function} label the resolved qty labeller
 */
function balesFor(custRows, allRows, label) {
  const roster = new Map();
  // §5/Q1 — how many CONTAINERS a printed number has in one store, counted
  // over every row of every status. Counting only the customer's own sold
  // rows would leave the second container invisible whenever it is live, in
  // transit, or sold to somebody else — and the request cannot say which
  // container it means, so the executor would be free to pick either.
  const containers = new Map();
  for (const r of allRows || []) {
    const k = baleKeyOf(r);
    roster.set(k, (roster.get(k) || 0) + 1);
    const pk = `${upper(r.warehouse)}|${upper(r.packageNo)}`;
    if (!containers.has(pk)) containers.set(pk, new Set());
    containers.get(pk).add(upper(r.arrivalBatch));
  }
  const map = new Map();
  for (const r of custRows || []) {
    const key = baleKeyOf(r);
    if (!map.has(key)) {
      map.set(key, {
        key,
        packageNo: String(r.packageNo || ''),
        warehouse: String(r.warehouse || ''),
        design: String(r.design || ''),
        shade: String(r.shade || ''),
        arrivalBatch: String(r.arrivalBatch || ''),
        baleUid: String(r.baleUid || ''),
        thans: [],
      });
    }
    map.get(key).thans.push({
      thanNo: Number(r.thanNo) || 0,
      yards: Number(r.yards) || 0,
      pricePerYard: Number(r.pricePerYard) || 0,
      warehouse: String(r.warehouse || ''),
      packageNo: String(r.packageNo || ''),
      design: String(r.design || ''),
      shade: String(r.shade || ''),
      arrivalBatch: String(r.arrivalBatch || ''),
      baleUid: String(r.baleUid || ''),
      rowIndex: r.rowIndex,
    });
  }
  const list = [...map.values()];
  for (const b of list) {
    b.thans.sort((a, c) => a.thanNo - c.thanNo);
    b.rosterThans = roster.get(b.key) || b.thans.length;
    b.yards = b.thans.reduce((s, t) => s + t.yards, 0);
  }
  for (const b of list) {
    const pk = `${upper(b.warehouse)}|${upper(b.packageNo)}`;
    b.ambiguous = ((containers.get(pk) || new Set()).size) > 1;
    const qty = typeof label === 'function' ? label(b.thans) : '';
    const goods = [b.design, b.shade].filter(Boolean).join(' ');
    b.label = [
      b.packageNo,
      `🏭 ${b.warehouse}`,
      goods,
      qty,
      `${fmtQty(b.yards)} yds`,
    ].filter(Boolean).join(' · ');
  }
  list.sort((a, c) => String(a.packageNo).localeCompare(String(c.packageNo), 'en', { numeric: true }));
  return list;
}

/**
 * The booked-rate credit for a set of than rows — the SAME maths the
 * executor posts (inventoryService._internals.returnCreditFor), so the
 * number on the card is the number the ledger writes.
 * @returns {{yards:number, amount:number, rate:number}}
 */
function creditFor(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  try {
    const inv = require('../services/inventoryService');
    if (inv && inv._internals && typeof inv._internals.returnCreditFor === 'function') {
      return inv._internals.returnCreditFor({}, list);
    }
  } catch (e) {
    logger.warn(`[returnFlow] returnCreditFor unavailable (${e.message}) — local mirror`);
  }
  // Local mirror of the executor's formula, used only if the service cannot
  // be loaded (it is a heavy module); identical shape, identical maths.
  const yards = list.reduce((s, t) => s + (Number(t.yards) || 0), 0);
  const amount = list.reduce((s, t) => s + (Number(t.yards) || 0) * (Number(t.pricePerYard) || 0), 0);
  return { yards, amount, rate: yards > 0 && amount > 0 ? amount / yards : 0 };
}

/** ⬅ Back — the single map a future `returned_to` step edits. */
const PREV = {
  customer_search: 'customer',
  bale: 'customer',
  thans: 'bale',
  date: 'thans',
  date_cal: 'date',
  condition: 'date',
  condition_note: 'condition',
  photo: 'condition',
  confirm: 'photo',
};
function prevStep(step) { return PREV[step] || ''; }

const CONDITIONS = [
  { code: 'good', chip: '✅ Good — back to stock', line: '✅ Good — back to stock', short: '✅ Good' },
  { code: 'damaged', chip: '⚠️ Damaged', line: '⚠️ Damaged', short: '⚠️ Damaged' },
  { code: 'cut', chip: '✂️ Cut / short', line: '⚠️ Cut / short', short: '⚠️ Cut / short' },
  { code: 'other', chip: '📝 Other — I will type it', line: '⚠️ Condition noted', short: '⚠️ Noted' },
];
function conditionOf(code) { return CONDITIONS.find((c) => c.code === code) || null; }

/** The running fact strip every card carries (sellBaleFlow.header grammar). */
function header(session) {
  const s = session || {};
  const bits = ['↩️ *Return goods*'];
  if (s.customer) bits.push(`👤 ${mdEscape(s.customer)}`);
  if (s.packageNo) bits.push(`📦 Bale ${mdEscape(s.packageNo)}`);
  if (s.qtyLabel) bits.push(`🧵 ${s.qtyLabel} · ${fmtQty(s.yards || 0)} yds`);
  else if (s.warehouse) bits.push(`🏭 ${mdEscape(s.warehouse)}`);
  if (s.returnedOn) bits.push(`📅 ${fmtDate(s.returnedOn)}`);
  const cond = conditionOf(s.condition);
  if (cond) bits.push(cond.short);
  return bits.join('  ·  ');
}

/** The thans ticked so far, as rows (ascending). */
function pickedRows(session) {
  const thans = (session && session._thans) || [];
  return ((session && session._picked) || [])
    .slice()
    .sort((a, b) => a - b)
    .map((i) => thans[i])
    .filter(Boolean);
}

/** The owner-locked payload — the one contract every side agrees on. */
function buildActionJSON(session) {
  const rows = pickedRows(session);
  // `credit.rate` is the yards-WEIGHTED rate of the ticked set: rate × yards
  // reproduces the exact booked total, which is what the admin card shows.
  // It is a DISPLAY figure, not an instruction: the executor deliberately
  // ignores it and re-prices from each surviving row's own booked rate, so a
  // partial apply (a than re-sold while the request waited) can never credit
  // the survivors at the set's average. See the return_thans branch in
  // inventoryService.executeApprovedAction.
  const credit = creditFor(rows);
  return {
    action: 'return_thans',
    packageNo: String(session.packageNo || ''),
    warehouse: String(session.warehouse || ''),
    thanNos: rows.map((t) => Number(t.thanNo)),
    customer: String(session.customer || ''),
    customerId: String(session.customerId || ''),
    returnedOn: String(session.returnedOn || ''),
    condition: String(session.condition || ''),
    conditionNote: String(session.conditionNote || ''),
    return_photo_file_id: String(session.photoFileId || ''),
    // Telegram refuses to re-send a file as a different type: a picture sent
    // as a File (📎 → File, the SHP-1 habit) has a DOCUMENT file_id and
    // sendPhoto rejects it. Record which it is, exactly as the sales bill
    // records sale_doc_type, so every forward picks the right sender.
    return_photo_type: session.photoFileId ? String(session.photoKind || 'photo') : '',
    pricePerYard: credit.rate,
    yards: credit.yards,
    design: String(session.design || ''),
    shade: String(session.shade || ''),
  };
}

/* ── screens ──────────────────────────────────────────────────────────── */

async function showCustomers(bot, chatId, userId, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const { rows, label } = await snapshotFor(userId);
  const all = loadCustomers(rows, label);
  if (!all.length) {
    await render(bot, chatId, userId,
      '↩️ *Return goods*\n\nNo goods are out with any customer right now.',
      [menuRow()]);
    forgetSnapshot(userId);
    sessionStore.clear(userId);
    return;
  }
  const filter = norm(session._custFilter || '');
  const list = filter ? all.filter((c) => c.key.includes(filter)) : all;
  session._customers = list.slice(0, MAX_CUSTOMER_CHIPS);
  session.step = 'customer';
  sessionStore.set(userId, session);

  const notes = [];
  if (opts.note) notes.push(opts.note);
  if (filter && list.length) notes.push(`_Showing matches for "${mdEscape(session._custFilter)}"._`);
  if (filter && !list.length) notes.push(`_No customer with goods out matches "${mdEscape(session._custFilter)}"._`);
  if (!filter && all.length > MAX_CUSTOMER_CHIPS) {
    notes.push(`_Showing the ${MAX_CUSTOMER_CHIPS} most recent — type a name for the rest._`);
  }

  const keyboard = session._customers.map((c, i) => ([
    { text: `👤 ${c.label}`, callback_data: cbSafe(`${NS}cust:${i}`) },
  ]));
  keyboard.push([{ text: '🔎 Type a name', callback_data: `${NS}csearch` }]);
  keyboard.push(cancelRow());
  keyboard.push(menuRow());
  await render(bot, chatId, userId,
    `${header(session)}\n\n${notes.length ? `${notes.join('\n')}\n\n` : ''}Who is returning?`,
    keyboard);
}

async function showCustomerSearch(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'customer_search';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `${header(session)}\n\nType part of the customer's name:`,
    [backAndCancelRow(), menuRow()]);
}

async function showBales(bot, chatId, userId, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const { rows, label } = await snapshotFor(userId);
  const cust = (loadCustomers(rows, label)).find((c) => c.key === norm(session._customerKey || session.customer));
  const bales = balesFor(cust ? cust.rows : [], rows, label);
  session._bales = bales.slice(0, MAX_BALE_CHIPS);
  session.step = 'bale';
  sessionStore.set(userId, session);
  if (!session._bales.length) {
    await render(bot, chatId, userId,
      `${header(session)}\n\nNothing is out with this customer any more.`,
      [backAndCancelRow(), menuRow()]);
    return;
  }
  const keyboard = session._bales.map((b, i) => ([
    { text: `📦 ${b.label}`, callback_data: cbSafe(`${NS}bale:${i}`) },
  ]));
  keyboard.push(backAndCancelRow());
  keyboard.push(menuRow());
  await render(bot, chatId, userId,
    `${header(session)}\n\n${opts.note ? `${opts.note}\n\n` : ''}Which bale is coming back?`,
    keyboard);
}

async function showThans(bot, chatId, userId, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const { label } = await snapshotFor(userId);
  const thans = session._thans || [];
  const picked = new Set(session._picked || []);
  const rowsPicked = pickedRows(session);
  session.qtyLabel = rowsPicked.length ? label(rowsPicked) : '';
  session.yards = rowsPicked.reduce((s, t) => s + (Number(t.yards) || 0), 0);
  session.step = 'thans';
  sessionStore.set(userId, session);

  const chips = thans.map((t, i) => ({
    text: `${picked.has(i) ? '☑' : '☐'} #${t.thanNo} · ${fmtQty(t.yards)} yds`,
    callback_data: cbSafe(`${NS}t:${i}`),
  }));
  const keyboard = chunk(chips, 2);
  const allOn = thans.length > 0 && picked.size === thans.length;
  keyboard.push([
    { text: allOn ? '⬜ Untick all' : `✅ All ${thans.length}`, callback_data: `${NS}tall` },
    { text: '➡ Next', callback_data: `${NS}tnext` },
  ]);
  keyboard.push(backAndCancelRow());
  keyboard.push(menuRow());
  const goods = [session.design, session.shade].filter(Boolean).map(mdEscape).join(' · ');
  await render(bot, chatId, userId,
    `${header(session)}\n\n${goods ? `${goods}\n` : ''}${opts.note ? `${opts.note}\n` : ''}Tick the thans coming back:`,
    keyboard);
}

async function showDate(bot, chatId, userId, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  if (!session.maxDaysBack) {
    // BKD-1 — one knob (SALE_CALENDAR_MAX_DAYS_BACK) for sale and return
    // dates; no new Settings key.
    session.maxDaysBack = await dateCalendar.saleMaxDaysBack();
  }
  session.step = 'date';
  sessionStore.set(userId, session);
  const keyboard = dateCalendar.quickChipRows('rn');
  keyboard.push(backAndCancelRow());
  keyboard.push(menuRow());
  await render(bot, chatId, userId,
    `${header(session)}\n\n${opts.note ? `${opts.note}\n\n` : ''}When did the goods come back?`,
    keyboard);
}

async function showCalendar(bot, chatId, userId, ym, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  if (!session.maxDaysBack) session.maxDaysBack = await dateCalendar.saleMaxDaysBack();
  session.step = 'date_cal';
  session.calYm = ym;
  sessionStore.set(userId, session);
  const keyboard = dateCalendar.calendarRows('rn', ym, {
    maxDaysBack: session.maxDaysBack,
    highlight: opts.highlight || session.returnedOn || '',
  });
  keyboard.push(backAndCancelRow());
  keyboard.push(menuRow());
  await render(bot, chatId, userId,
    `${header(session)}\n\n${opts.note ? `${opts.note}\n\n` : ''}`
    + `📆 *Tap* the day the goods came back (up to ${session.maxDaysBack} days back). Dots are out of range.`,
    keyboard);
}

async function showCondition(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'condition';
  sessionStore.set(userId, session);
  const keyboard = CONDITIONS.map((c) => ([
    { text: c.chip, callback_data: cbSafe(`${NS}c:${c.code}`) },
  ]));
  keyboard.push(backAndCancelRow());
  keyboard.push(menuRow());
  await render(bot, chatId, userId,
    `${header(session)}\n\nHow do the goods look?\n`
    + '_Recorded on the card. The than still goes back to stock._',
    keyboard);
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
  const note = session.conditionNote ? `_“${mdEscape(session.conditionNote)}”_\n` : '';
  await render(bot, chatId, userId,
    `${header(session)}\n\n${note}📎 Send ONE photo of the goods — the admins see it on the card.`,
    [[{ text: '⏭ Skip photo', callback_data: `${NS}pskip` }], backAndCancelRow(), menuRow()]);
}

async function showConfirm(bot, chatId, userId, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const { label } = await snapshotFor(userId);
  const rows = pickedRows(session);
  const credit = creditFor(rows);
  session.step = 'confirm';
  session.qtyLabel = rows.length ? label(rows) : '';
  session.yards = credit.yards;
  session.rate = credit.rate;
  session.creditAmount = credit.amount;
  sessionStore.set(userId, session);

  const cond = conditionOf(session.condition);
  const lines = [
    '↩️ *Confirm return*',
    '',
    `👤 Customer: *${mdEscape(session.customer)}*`,
    `📦 Bale *${mdEscape(session.packageNo)}*${session.design ? ` — ${mdEscape(session.design)}` : ''}`
      + `${session.warehouse ? ` · 🏭 ${mdEscape(session.warehouse)}` : ''}`,
    `Thans *${rows.map((t) => `#${t.thanNo}`).join(', ')}* · ${fmtQty(credit.yards)} yds`,
    `📅 Returned: *${fmtDate(session.returnedOn)}*`,
  ];
  if (cond) {
    lines.push(`${cond.line}${session.conditionNote ? ` — ${mdEscape(session.conditionNote)}` : ''}`);
  }
  if (session.photoFileId) lines.push('📎 Photo attached');
  if (credit.rate > 0 && credit.yards > 0) {
    lines.push(`💰 Credits ${mdEscape(session.customer)} *${fmtMoneyShort(credit.amount)}* `
      + `(${fmtQty(credit.yards)} yds × ${fmtMoneyShort(credit.rate)}/yd)`);
  } else {
    lines.push('⚠️ No rate on record for these thans — the stock comes back, but NO credit '
      + 'posts until a rate exists.');
  }
  lines.push('');
  if (opts.note) { lines.push(opts.note); lines.push(''); }
  lines.push("Approving puts the stock back and credits this customer's account.");
  lines.push('Queues dual-admin approval (two admins, per than).');

  await render(bot, chatId, userId, lines.join('\n'), [
    [{ text: '✅ Submit for approval', callback_data: `${NS}submit` }],
    backAndCancelRow(),
    menuRow(),
  ]);
}

function submittedText(session, requestId, isAdmin, sentCards) {
  const rows = pickedRows(session);
  const lines = [
    '↩️ *Return — submitted*',
    '',
    `👤 *${mdEscape(session.customer)}* · Bale *${mdEscape(session.packageNo)}* · `
      + `Thans *${rows.map((t) => `#${t.thanNo}`).join(', ')}*`,
    '',
    // The receipt names the REAL gate: requiredAdminApprovals returns 1 for
    // an admin requester (they are the first signature), so telling an admin
    // "two admins" would be a lie on exactly the cards they raise. `isAdmin`
    // is auth.isAdmin — env AND sheet-cache admins, the test the dual path
    // itself uses — not the env-only config.access.adminIds.
    isAdmin ? "⏳ Waiting for a 2nd admin's approval." : '⏳ Waiting for two admins to sign.',
    `Request: \`${requestId}\``,
  ];
  if (!sentCards) lines.push('\n⚠️ No admin card went out — tell an admin the ref.');
  return lines.join('\n');
}

/* ── entry point ──────────────────────────────────────────────────────── */

/**
 * Open the return card. `messageId` is the tapped tile's message id, so the
 * first render EDITS in place (§15 — navigation edits, never appends). The
 * `act:` branch has already answered the callback; start() must not answer.
 */
async function start(bot, chatId, userId, messageId) {
  forgetSnapshot(userId);
  sessionStore.set(String(userId), {
    type: SESSION_TYPE,
    step: 'customer',
    flowMessageId: messageId || null,
    startedAt: Date.now(),
    ttlMs: FLOW_TTL_MS,
    _customers: [], _bales: [], _thans: [], _picked: [], _custFilter: '',
    customer: '', customerId: '', packageNo: '', warehouse: '',
    design: '', shade: '', arrivalBatch: '',
    returnedOn: '', condition: '', conditionNote: '', photoFileId: '', photoKind: '',
  });
  await snapshotFor(userId, { fresh: true });
  await showCustomers(bot, chatId, String(userId));
}

/* ── submit ───────────────────────────────────────────────────────────── */

async function submit(bot, chatId, userId, session) {
  await render(bot, chatId, userId, '⏳ *Submitting…*', []);
  const requestId = idGenerator.requestId();
  const actionJSON = buildActionJSON(session);
  try {
    await approvalQueueRepository.append({
      requestId,
      user: String(userId),
      actionJSON,
      riskReason: RISK_REASON,
      status: 'pending',
    });
  } catch (e) {
    logger.error(`[returnFlow] queue append failed: ${e.message}`);
    endSubmit(session, userId);
    await showConfirm(bot, chatId, userId, {
      note: `⚠️ Could not submit: ${mdEscape(e.message)} — tap Submit again.`,
    });
    return;
  }
  try {
    await auditLogRepository.append('approval_queued', {
      requestId,
      action: 'return_thans',
      packageNo: actionJSON.packageNo,
      warehouse: actionJSON.warehouse,
      thanNos: actionJSON.thanNos,
      yards: actionJSON.yards,
      condition: actionJSON.condition,
      conditionNote: actionJSON.conditionNote,
      returnedOn: actionJSON.returnedOn,
      photo: !!actionJSON.return_photo_file_id,
      source: 'return_flow',
    }, String(userId));
  } catch (e) { logger.warn(`[returnFlow] audit row failed: ${e.message}`); }

  // AUTH — config.access.adminIds is ENV-ONLY; the dual path judges the
  // requester with auth.isAdmin, which also counts sheet-cache admins.
  let isAdmin = false;
  try { isAdmin = require('../middlewares/auth').isAdmin(String(userId)); } catch (_) { /* employee */ }
  const excludeId = isAdmin ? String(userId) : undefined;

  let sentCards = 0;
  try {
    const approvalEvents = require('../events/approvalEvents');
    const approvalCards = require('../services/approvalCards');
    const card = await approvalCards.buildReturnThansCard(actionJSON);
    const label = await approvalCards.resolveUserLabel(String(userId), bot);
    const res = await approvalEvents.notifyAdminsApprovalRequest(
      bot, requestId, label, card, RISK_REASON, excludeId,
    );
    sentCards = (res && res.sent) || 0;
    if (actionJSON.return_photo_file_id) {
      await approvalCards.forwardAttachmentsToAdmins(bot, requestId, [{
        fileId: actionJSON.return_photo_file_id,
        kind: actionJSON.return_photo_type === 'document' ? 'document' : 'photo',
        caption: `📷 Returned goods for request ${requestId}`,
      }], excludeId);
    }
  } catch (e) {
    logger.warn(`[returnFlow] admin card for ${requestId}: ${e.message}`);
  }

  await render(bot, chatId, userId,
    submittedText(session, requestId, isAdmin, sentCards),
    [menuNav.hubAndMenuFooterRow('stock_move', 'Move Stock')]);
  try {
    await require('../utils/requesterCard').rememberRequesterCard(requestId, chatId, String(userId));
  } catch (e) { logger.warn(`[returnFlow] requester card: ${e.message}`); }
  forgetSnapshot(userId);
  // ANL-2 — approval_queued is the completion signal; no outcome here.
  sessionStore.clear(String(userId));
}

/* ── callbacks ────────────────────────────────────────────────────────── */

async function handleCallback(bot, callbackQuery) {
  const data = (callbackQuery && callbackQuery.data) || '';
  if (!data.startsWith(NS)) return false;
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id;

  // Telegram accepts exactly ONE answerCallbackQuery per callback id, so
  // there is no eager ack here: an empty one would make every later
  // show_alert a no-op and the user would tap and see nothing (§15).
  let answered = false;
  const ack = async (t, alert) => {
    if (answered) return;              // Telegram accepts ONE answer per id
    answered = true;
    try {
      await bot.answerCallbackQuery(callbackQuery.id,
        t ? { text: t, show_alert: !!alert } : undefined);
    } catch (_) { /* stale query id */ }
  };

  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    await ack(EXPIRED_ALERT, true);
    return true;
  }
  // Two tiles opened in a row must not let the older card steer the newer
  // session (the rt*/rtx stale-card guard).
  const tapped = callbackQuery.message && callbackQuery.message.message_id;
  if (session.flowMessageId && tapped && tapped !== session.flowMessageId) {
    await ack(EXPIRED_ALERT, true);
    return true;
  }

  const rest = data.slice(NS.length);
  try {
    if (rest === 'cancel') {
      await ack('Cancelled');
      // Render BEFORE clearing — the renderer is requireSession: true.
      await render(bot, chatId, userId,
        '❌ Return cancelled — nothing was queued.', [menuRow()]);
      forgetSnapshot(userId);
      sessionStore.clear(userId, 'cancelled');
      return true;
    }

    if (rest === 'submit') {
      // SUB-1 — synchronous, before any await: the second tap is a different
      // callback id and still gets its own single answer.
      if (!beginSubmit(session, userId)) { await ack('Already submitting…'); return true; }
      if (session.step !== 'confirm' || !(session._picked || []).length) {
        // Re-open the door: nothing was queued, so the flag must not stick.
        endSubmit(session, userId);
        await ack('That card is no longer the live one.', true);
        return true;
      }
      await ack();
      await submit(bot, chatId, userId, session);
      return true;
    }

    // Calendar chips FIRST — dateCalendar emits four shapes, and handling
    // only `dd:` would leave the calendar unopenable.
    if (rest === 'noop') { await ack(); return true; }
    if (rest === 'dq') { await ack(); await showDate(bot, chatId, userId); return true; }
    if (rest.startsWith('dm:')) {
      await ack();
      await showCalendar(bot, chatId, userId, rest.slice(3));
      return true;
    }
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
        if (session.step === 'date_cal') {
          await showCalendar(bot, chatId, userId, session.calYm || iso.slice(0, 7), { note });
        } else {
          await showDate(bot, chatId, userId, { note });
        }
        return true;
      }
      session.returnedOn = iso;
      sessionStore.set(userId, session);
      await ack(fmtDate(iso));
      await showCondition(bot, chatId, userId);
      return true;
    }

    if (rest === 'back') {
      const prev = prevStep(session.step);
      if (!prev) { await ack(); return true; }
      await ack();
      if (prev === 'customer') {
        if (session.step === 'customer_search') {
          session._custFilter = '';
          sessionStore.set(userId, session);
        }
        await showCustomers(bot, chatId, userId);
        return true;
      }
      if (prev === 'bale') { await showBales(bot, chatId, userId); return true; }
      if (prev === 'thans') { await showThans(bot, chatId, userId); return true; }
      if (prev === 'date') { await showDate(bot, chatId, userId); return true; }
      if (prev === 'condition') { await showCondition(bot, chatId, userId); return true; }
      if (prev === 'photo') { await showPhoto(bot, chatId, userId); return true; }
      return true;
    }

    if (rest === 'csearch') { await ack(); await showCustomerSearch(bot, chatId, userId); return true; }

    if (rest.startsWith('cust:')) {
      const entry = (session._customers || [])[parseInt(rest.slice(5), 10)];
      if (!entry) { await ack(); await expiredList(bot, chatId, userId); return true; }
      session.customer = entry.name;
      session._customerKey = entry.key;
      session.customerId = '';
      try {
        const c = await customerEntity.resolve({ name: entry.name });
        if (c) { session.customer = c.name; session.customerId = String(c.customer_id || ''); }
      } catch (_) { /* the raw spelling still names the buyer */ }
      sessionStore.set(userId, session);
      await ack(entry.name);
      await showBales(bot, chatId, userId);
      return true;
    }

    if (rest.startsWith('bale:')) {
      const b = (session._bales || [])[parseInt(rest.slice(5), 10)];
      if (!b) { await ack(); await expiredList(bot, chatId, userId); return true; }
      if (b.ambiguous) {
        // §3 container gap guard (a): the payload cannot say WHICH container,
        // and neither finder separates them — refuse rather than risk
        // flipping the same-numbered bale next to it.
        await ack('That bale number exists twice in this store.', true);
        await showBales(bot, chatId, userId, {
          note: `⚠️ Bale ${mdEscape(b.packageNo)} exists twice in ${mdEscape(b.warehouse)} `
            + '(different containers). Tell an admin — this return needs the container '
            + 'recorded before it can be raised.',
        });
        return true;
      }
      session.baleIdx = parseInt(rest.slice(5), 10);
      session.packageNo = b.packageNo;
      session.warehouse = b.warehouse;
      session.design = b.design;
      session.shade = b.shade;
      session.arrivalBatch = b.arrivalBatch;
      session._thans = b.thans.slice(0, MAX_THAN_CHIPS);
      session._picked = [];
      session.qtyLabel = '';
      session.yards = 0;
      sessionStore.set(userId, session);
      await ack(`Bale ${b.packageNo}`);
      await showThans(bot, chatId, userId);
      return true;
    }

    if (rest.startsWith('t:')) {
      const i = parseInt(rest.slice(2), 10);
      if (!(session._thans || [])[i]) { await ack(); await expiredList(bot, chatId, userId); return true; }
      const picked = new Set(session._picked || []);
      if (picked.has(i)) picked.delete(i); else picked.add(i);
      session._picked = [...picked].sort((a, b) => a - b);
      sessionStore.set(userId, session);
      await ack();
      await showThans(bot, chatId, userId);
      return true;
    }

    if (rest === 'tall') {
      const n = (session._thans || []).length;
      const allOn = n > 0 && (session._picked || []).length === n;
      session._picked = allOn ? [] : Array.from({ length: n }, (_, i) => i);
      sessionStore.set(userId, session);
      await ack();
      await showThans(bot, chatId, userId);
      return true;
    }

    if (rest === 'tnext') {
      if (!(session._picked || []).length) { await ack('Tick at least one than.', true); return true; }
      await ack();
      await showDate(bot, chatId, userId);
      return true;
    }

    if (rest.startsWith('c:')) {
      const cond = conditionOf(rest.slice(2));
      if (!cond) { await ack(); return true; }
      session.condition = cond.code;
      // Every condition tap starts the note afresh. Back walks
      // condition_note → condition without clearing, so keeping the old note
      // here would let "Other + a typed note → Back → ✅ Good" ship a note the
      // admin card does not print (it prints nothing for `good`) while the
      // confirm card and the AuditLog still carry it — two cards disagreeing
      // about the same return. The photo-step note is typed AFTER this tap.
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
  } catch (e) {
    logger.error(`[returnFlow] ${data} failed: ${e.message}`);
    await ack('That step failed — tap the buttons again.', true);
    return true;
  }
  await ack();
  return true;
}

/** An index that missed its array: the list the card was built from is gone. */
async function expiredList(bot, chatId, userId) {
  await render(bot, chatId, userId, '_That list expired._', [menuRow()]);
}

/* ── typed text ───────────────────────────────────────────────────────── */

/**
 * Consumes ONLY the typed steps (customer search, the condition note, and a
 * typed date, which merely navigates the calendar — the tap stays the sole
 * commit, owner rule 21-Jul). Every other step returns false so free text
 * still reaches intent parsing.
 */
/**
 * ANCH-1 — after the user's OWN message (a typed name, a note, a date, the
 * goods photo) the card would sit above what they just sent, and the next
 * step would edit in place up there. Drop the old card so the next render
 * lands at the bottom: delete when Telegram allows, else strip its
 * keyboard so no dead chips stay live.
 */
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

  if (session.step === 'customer_search') {
    session._custFilter = text.slice(0, 60);
    sessionStore.set(userId, session);
    await dropBelow(bot, chatId, userId, session);
    await showCustomers(bot, chatId, userId);
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

  // Card 5b's other half: a user who TAPPED ⚠️ Damaged / ✂️ Cut and then
  // types the detail instead of sending a picture is describing the goods.
  // Narrow on purpose — only while the photo card is up, only for a
  // non-good condition, and only until a note exists; everything else on
  // this step still falls through to intent parsing.
  if (session.step === 'photo' && session.condition && session.condition !== 'good'
      && !session.conditionNote) {
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

/* ── the optional photo ───────────────────────────────────────────────── */

/**
 * One photo of the goods that came back. A second photo of an ALBUM is
 * ignored because the step is closed SYNCHRONOUSLY, before the first await:
 * server.js dispatches each photo of an album with an un-awaited
 * handleFileMessage, so "the step is no longer photo" is only true if
 * nothing is awaited between reading the step and setting it.
 * @returns {Promise<boolean>} false lets the file reach later handlers.
 */
async function handlePhoto(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE || session.step !== 'photo') return false;
  let fileId = '';
  let kind = 'photo';
  if (Array.isArray(msg.photo) && msg.photo.length) fileId = msg.photo[msg.photo.length - 1].file_id;
  else if (msg.document && /^image\//i.test(String(msg.document.mime_type || ''))) {
    fileId = msg.document.file_id;
    kind = 'document';                             // sent as a File — uncompressed
  }
  if (!fileId) return false;                       // a PDF falls through
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
  start,
  handleCallback,
  handleText,
  handlePhoto,
  _internals: { loadCustomers, balesFor, creditFor, prevStep, buildActionJSON },
};
