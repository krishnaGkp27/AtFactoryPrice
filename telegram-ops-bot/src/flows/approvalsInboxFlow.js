'use strict';

/**
 * src/flows/approvalsInboxFlow.js — APX-1 🛂 Approvals Inbox.
 *
 * Owner request (26-Jul-2026): before this, a pending approval could only be
 * reached from the DM card pushed when it was queued, the APR-1 reminder
 * re-send, or a flat text block in the morning digest that showed the newest
 * 10 of 50 and carried no buttons. Miss the card and the request was
 * effectively unreachable — hence a 50-deep backlog with 40 items invisible.
 *
 * This is a triage surface: pending requests grouped BY CONCERN, newest
 * first, each opening the same approval card the admin would have received
 * by DM, with ✅ Approve / ❌ Reject on it.
 *
 *   1. pick_category  — categories with counts + the age of the oldest item
 *                       (the age badge stays OLDEST so staleness is visible)
 *   2. pick_item      — that category's requests, NEWEST first (owner
 *                       31-Jul-2026, reversing the APX-1 oldest-first
 *                       choice: fresh requests are the ones being waited on)
 *   3. view_item      — the full card + Approve / Reject
 *
 * DELEGATION, NOT REIMPLEMENTATION. Approve/Reject do NOT contain approval
 * logic: they rebuild the standard `approve:<id>` / `reject:<id>` callback
 * and hand it to approvalEvents.handleApprovalCallback, so the self-approval
 * block (SEC-P1 H1), the super-admin gate (USR-C3b), dual-admin counting
 * (DUAL-1) and every executor branch behave exactly as they do from a DM
 * card. Nothing in risk/evaluate.js, approvalEvents.js or inventoryService
 * is modified by this feature.
 *
 * TRANSFERS ARE NOT APPROVALS. Staged Transfer Stock requests sit in the
 * same ApprovalQueue sheet with action `transfer_stock`, but
 * executeApprovedAction has no branch for them — tapping Approve returns
 * "Unknown action type." They are shown in their own group and routed to
 * the transfer card (dispatch / receive) instead of getting Approve buttons.
 *
 * Admin-only: managers cannot approve anything, so a read-only queue would
 * be noise.
 *
 * Callback namespace `abx:*`:
 *   abx:close            end the flow → menu
 *   abx:back             step back one level
 *   abx:cat:<key>        open a category
 *   abx:pg:<n>           page within a category
 *   abx:i:<idx>          open one request (index into session._items)
 *   abx:ok:<idx>         → delegates to approve:<requestId>
 *   abx:no:<idx>         → delegates to reject:<requestId>
 *   abx:trf:<idx>        open a transfer's own card
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, rowsFor } = require('../utils/flowKit');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const approvalCards = require('../services/approvalCards');
const settingsRepository = require('../repositories/settingsRepository');
const { duplicateIndex } = require('../utils/duplicateApprovals');
const config = require('../config');
const logger = require('../utils/logger');

const SESSION_TYPE = 'approvals_inbox_flow';
const { closeRow, backRow } = rowsFor('abx');
const render = makeRenderer();

const ITEMS_PER_PAGE = 8;
/** Items older than this land in the 🧹 Stale group as well as their own. */
const STALE_DAYS = 14;

/**
 * Approval actions grouped by business concern. Order here is the order the
 * categories render in. `dual` marks groups whose actions need two admins
 * (DUAL_ADMIN_ACTIONS in src/risk/evaluate.js) — surfaced so an admin knows
 * their tap may not be the last one.
 */
const CATEGORIES = [
  { key: 'sales', label: '💰 Sales', actions: ['sell_than', 'sell_package', 'sell_batch', 'sell_mixed', 'sell', 'sale_bundle', 'supply_request'] },
  { key: 'crm', label: '👤 Customers & contacts', actions: ['add_customer', 'add_contact', 'add_contact_link', 'update_contact_info'] },
  { key: 'intake', label: '📦 Stock intake', actions: ['receive_goods', 'bulk_receive_goods', 'add', 'add_stock'], dual: true },
  { key: 'finance', label: '💵 Finance', actions: ['record_payment', 'update_price', 'finalize_landed_cost', 'record_office_expense', 'add_bank', 'remove_bank', 'confirm_bank_reconciliation', 'set_forex_rate'], dual: true },
  { key: 'returns', label: '↩️ Returns & reversals', actions: ['return_than', 'return_package', 'revert_sale_bundle'], dual: true },
  { key: 'people', label: '👥 People & access', actions: ['add_user', 'deactivate_user', 'promote_admin'], dual: true },
  { key: 'warehouse', label: '🏭 Warehouse & labels', actions: ['add_warehouse', 'rename_warehouse', 'set_unit_display', 'set_design_category'], dual: true },
  { key: 'samples', label: '🧪 Samples & marketing', actions: ['give_sample', 'catalog_loan', 'catalog_return', 'register_marketer', 'design_asset_upload'] },
  { key: 'config', label: '⚙️ Config & messaging', actions: ['set_reminder_config', 'notify_wholesaler', 'broadcast_wholesalers'] },
];

/**
 * Rows that live in the queue but are NOT approve/reject decisions — the
 * staged Transfer Stock flow parks its requests here while waiting on a
 * dispatcher or receiver. Legacy transfer_* rows are retired and refuse at
 * execution, so they belong in the same group rather than looking approvable.
 */
const TRANSFER_ACTIONS = ['transfer_stock', 'transfer_than', 'transfer_package', 'transfer_batch'];

const ACTION_CATEGORY = new Map();
for (const c of CATEGORIES) for (const a of c.actions) ACTION_CATEGORY.set(a, c.key);

/** Category key for a queue row; unmapped actions fall into 'other'. */
function categoryOf(item) {
  const action = (item && item.actionJSON && item.actionJSON.action) || '';
  if (TRANSFER_ACTIONS.includes(action)) return 'transfers';
  return ACTION_CATEGORY.get(action) || 'other';
}

/** Whole days since an ISO timestamp; 0 when unparseable. */
function ageDays(createdAt) {
  const ms = Date.parse(createdAt || '');
  if (!isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

/** 🟢 fresh · 🟠 getting old · 🔴 needs clearing. */
function ageDot(days) {
  if (days >= 7) return '🔴';
  if (days >= 3) return '🟠';
  return '🟢';
}

function ageLabel(days) {
  if (days <= 0) return 'today';
  return `${days}d`;
}

/**
 * LBL-1 — "sale_bundle" → "sale bale", via the shared owner-vocabulary map
 * in approvalCards (the internal code stays; only the words change).
 */
function actionLabel(item) {
  const a = (item && item.actionJSON && item.actionJSON.action) || 'unknown';
  return approvalCards.actionLabel(a);
}

function shortDate(createdAt) {
  const ms = Date.parse(createdAt || '');
  if (!isFinite(ms)) return '—';
  return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

/**
 * Duplicate-clustering window in minutes — a business knob, so it lives in
 * the Settings sheet (owner-editable, no deploy) with an in-code default.
 * @returns {Promise<number>}
 */
async function duplicateWindowMinutes() {
  const fallback = settingsRepository.DEFAULTS.DUPLICATE_WINDOW_MINUTES;
  try {
    const v = Number((await settingsRepository.getAll()).DUPLICATE_WINDOW_MINUTES);
    return isFinite(v) && v > 0 ? v : fallback;
  } catch (_) {
    return fallback; // getAll already falls back to DEFAULTS; belt and braces
  }
}

/**
 * One queue read plus the duplicate index derived from it.
 *
 * Both come from the SAME snapshot on purpose: computing the ⧉ badges from a
 * second read could decorate a list against a queue that changed in between,
 * showing a badge on a row whose twin had just been rejected.
 *
 * @returns {Promise<{pending: Array<object>, dupIdx: Map<string, Array<object>>}>}
 */
async function loadQueue() {
  const pending = await approvalQueueRepository.getAllPending();
  return { pending, dupIdx: duplicateIndex(pending, await duplicateWindowMinutes()) };
}

/**
 * APX-3d/3e: transfers whose receipt landed in Inventory stay visible,
 * marked ✅ — completion is seen without drilling down. confirmReceipt is
 * what flips the bales' warehouse AND resolves the queue row to approved,
 * so status=approved IS the "inventory really changed" signal.
 *
 * Retention (owner 31-Jul): greens NEVER leave the list by default
 * (TRANSFER_RECEIVED_HOURS = 0) — nothing visible may vanish until a
 * complete backup regime exists. A Settings row restores a window
 * (e.g. 48) once backups are live. Queue-sheet rows are permanent
 * either way — this only governs the inbox display.
 */
async function recentReceivedTransfers() {
  try {
    const settings = await settingsRepository.getAll().catch(() => ({}));
    const hours = Number(settings.TRANSFER_RECEIVED_HOURS ?? 0);
    const cutoff = hours > 0 ? Date.now() - hours * 3600 * 1000 : null;
    return (await approvalQueueRepository.getResolved())
      .filter((r) => TRANSFER_ACTIONS.includes(String((r.actionJSON || {}).action || ''))
        && String(r.status || '').toLowerCase() === 'approved'
        && (cutoff === null || (r.resolvedAt && new Date(r.resolvedAt).getTime() >= cutoff)))
      .sort((a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt)));
  } catch (_) { return []; } // best-effort: greens are informational
}

/* ───────────────────────────── entry ───────────────────────────── */

/**
 * Open the inbox on its category list.
 * @param {object} bot @param {number|string} chatId
 * @param {string} userId @param {number|null} messageId anchor to edit
 */
async function start(bot, chatId, userId, messageId = null) {
  if (!config.access.adminIds.includes(String(userId))) {
    try { await bot.sendMessage(chatId, '🛂 Approvals are admin-only.'); } catch (_) { /* ignore */ }
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'pick_category',
    flowMessageId: messageId || null,
    startedAt: new Date().toISOString(),
    ttlMs: 20 * 60 * 1000, // triage takes a while — generous clock
    category: '', page: 0,
    _items: [],
  });
  await renderCategories(bot, chatId, userId);
}

/* ─────────────────────── level 1: categories ─────────────────────── */

async function renderCategories(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;

  let pending;
  let dupIdx;
  try {
    ({ pending, dupIdx } = await loadQueue());
  } catch (e) {
    logger.warn(`approvalsInbox: queue read failed: ${e.message}`);
    await render(bot, chatId, userId,
      '🛂 *Approvals*\n\n⚠️ Could not read the approval queue just now — try again in a moment.',
      [[{ text: '🔁 Try again', callback_data: 'abx:back' }], closeRow()]);
    return;
  }

  if (!pending.length) {
    await render(bot, chatId, userId,
      '🛂 *Approvals*\n\n✅ _Queue is clear — nothing waiting._',
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return;
  }

  const byCat = new Map();
  for (const p of pending) {
    const k = categoryOf(p);
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(p);
  }

  session.step = 'pick_category';
  session.page = 0;
  sessionStore.set(userId, session);

  const rows = [];
  for (const c of CATEGORIES) {
    const items = byCat.get(c.key);
    if (!items || !items.length) continue;
    const oldest = Math.max(...items.map((i) => ageDays(i.createdAt)));
    const dual = c.dual ? ' ⚠️' : '';
    rows.push([{
      text: `${c.label} — ${items.length}${dual} ${ageDot(oldest)}${ageLabel(oldest)}`,
      callback_data: `abx:cat:${c.key}`,
    }]);
  }
  // Anything unmapped still has to be reachable, or it would be invisible.
  const other = byCat.get('other');
  if (other && other.length) {
    const oldest = Math.max(...other.map((i) => ageDays(i.createdAt)));
    rows.push([{ text: `❓ Other — ${other.length} ${ageDot(oldest)}${ageLabel(oldest)}`, callback_data: 'abx:cat:other' }]);
  }
  const transfers = byCat.get('transfers') || [];
  // APX-3b/3d: the chip tells the STAGE mix at a glance — five identical
  // trucks hid which transfers actually needed a hand; ✅ received (48h)
  // rides along so completion shows without drilling.
  const received = await recentReceivedTransfers();
  if (transfers.length || received.length) {
    const inTransit = transfers.filter((t) => (t.actionJSON || {}).stage === 'in_transit').length;
    // TRF-18 — a parked package is the ADMIN's move; lumping it into the red
    // "waiting for dispatch" count hid the one stage that is waiting on YOU.
    const adminReview = transfers.filter((t) => (t.actionJSON || {}).stage === 'admin_review').length;
    const waiting = transfers.length - inTransit - adminReview;
    const mix = [adminReview ? `${adminReview} 🛂` : '', waiting ? `${waiting} 🔴` : '',
      inTransit ? `${inTransit} 🟡` : '',
      received.length ? `${received.length} 🟢` : ''].filter(Boolean).join(' · ');
    rows.push([{ text: `🚚 Transfers — ${transfers.length + received.length}${mix ? ` (${mix})` : ''}`, callback_data: 'abx:cat:transfers' }]);
  }
  // APX-2 — same request queued more than once (a double-tapped Submit).
  // Flagged, never auto-actioned: approving four copies of one sale would
  // sell the stock four times.
  // Count GROUPS, not flagged rows — "3 duplicates" must mean three things
  // queued twice, not one thing queued three times.
  const dupGroups = new Set(dupIdx.values()).size;
  if (dupGroups) {
    rows.push([{ text: `⧉ Possible duplicates — ${dupGroups}`, callback_data: 'abx:cat:dupes' }]);
  }
  const stale = pending.filter((p) => ageDays(p.createdAt) >= STALE_DAYS);
  if (stale.length) {
    rows.push([{ text: `🧹 Stale (>${STALE_DAYS}d) — ${stale.length}`, callback_data: 'abx:cat:stale' }]);
  }
  rows.push(closeRow());
  rows.push([{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]);

  await render(bot, chatId, userId,
    `🛂 *Approvals — ${pending.length} pending*\n_Newest first inside each group._`,
    rows);
}

/**
 * Human title for a category key. The pseudo-categories (stale, dupes,
 * transfers, other) are not in CATEGORIES, so every screen that shows a
 * heading has to go through here — otherwise one of them renders as the bare
 * lowercase key.
 *
 * @param {string} key
 * @returns {string}
 */
function titleFor(key) {
  if (key === 'stale') return `🧹 Stale (>${STALE_DAYS}d)`;
  if (key === 'dupes') return '⧉ Possible duplicates';
  if (key === 'transfers') return '🚚 Transfers';
  if (key === 'other') return '❓ Other';
  const meta = CATEGORIES.find((c) => c.key === key);
  return meta ? meta.label : key;
}

/* ───────────────────────── level 2: items ───────────────────────── */

/**
 * Pending rows for the session's current category, newest first.
 * Pure — the caller supplies the snapshot so one read serves the whole render.
 *
 * @param {object} session
 * @param {Array<object>} pending
 * @param {Map<string, Array<object>>} dupIdx
 * @returns {Array<object>}
 */
function itemsForCategory(session, pending, dupIdx) {
  let list;
  if (session.category === 'stale') {
    list = pending.filter((p) => ageDays(p.createdAt) >= STALE_DAYS);
  } else if (session.category === 'dupes') {
    list = pending.filter((p) => dupIdx.has(String(p.requestId)));
  } else {
    list = pending.filter((p) => categoryOf(p) === session.category);
  }
  // Newest first (owner 31-Jul-2026) — recent requests are the ones a
  // requester is actively waiting on; the 🔴 age badges keep stale items
  // findable further down (and the Stale group still collects 3d+).
  return list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * APX-6 (owner 01-Aug, replaces the APX-3c DSP/RCV mnemonics): colour dot
 * IS the stage, position IS the date — the list runs newest → oldest so
 * words and date tokens are noise:
 *   🔴 IDU▸KAN ·3B        requested, waiting for dispatch
 *   🟡 LAG▸KAN ·3B, 5T    in transit, waiting to be received
 *   🟢 LAG▸KAN ·2B, 4T    received — inventory really moved
 * ·NB = whole bales, NT = LOOSE thans travelling as their own cargo
 * (owner 01-Aug: NOT the thans packed inside the bales). Telegram buttons
 * cannot be tinted — the dot emoji is the tint.
 */
function whCode(w) {
  const letters = String(w || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  return letters.slice(0, 3) || '???';
}

// APX-4b — shared ref logic; legacy UUID transfers fall back to R-XXXX
// instead of splattering the raw UUID across a chip.
const shortTransferId = approvalCards.shortTransferRef;

/** Bales riding a transfer: logged bales, else dispatched sum, else the
 *  requested line quantities (pre-dispatch nothing is logged yet). */
function transferBaleCount(aj) {
  if (Array.isArray(aj.bales) && aj.bales.length) return aj.bales.length;
  if (Array.isArray(aj.dispatched) && aj.dispatched.length) {
    return aj.dispatched.reduce((s, d) => s + (Number(d.sent) || 0), 0);
  }
  if (Array.isArray(aj.lines) && aj.lines.length) {
    return aj.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  }
  return 0;
}

/** LOOSE thans riding a transfer as their own cargo (owner 01-Aug: "3B, 5T"
 *  means 3 whole bales AND 5 loose thans — NOT the thans inside the bales).
 *  The staged bale pipeline carries none today; legacy transfer_than rows
 *  and any future loose-than lines surface here. */
function transferThanCount(aj) {
  if (Array.isArray(aj.thans) && aj.thans.length) return aj.thans.length;
  if (Array.isArray(aj.thanItems) && aj.thanItems.length) return aj.thanItems.length;
  if (String(aj.action || '') === 'transfer_than') return 1;
  return 0;
}

function transferChipLabel(it) {
  const aj = it.actionJSON || {};
  const dot = String(it.status || '').toLowerCase() === 'approved' ? '🟢'
    : (aj.stage === 'in_transit' ? '🟡' : aj.stage === 'admin_review' ? '🛂' : '🔴');
  // Legacy rows without a route keep the short ref so the chip isn't blank.
  const route = (aj.from || aj.to) ? `${whCode(aj.from)}▸${whCode(aj.to)}` : shortTransferId(it.requestId);
  const parts = [];
  const b = transferBaleCount(aj);
  const t = transferThanCount(aj);
  if (b) parts.push(`${b}B`);
  if (t) parts.push(`${t}T`);
  return parts.length ? `${dot} ${route} ·${parts.join(', ')}` : `${dot} ${route}`;
}

async function renderItems(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  let pending;
  let dupIdx;
  try {
    ({ pending, dupIdx } = await loadQueue());
  } catch (e) {
    logger.warn(`approvalsInbox: queue read failed: ${e.message}`);
    await render(bot, chatId, userId,
      '🛂 *Approvals*\n\n⚠️ Could not read the approval queue just now — try again in a moment.',
      [[{ text: '🔁 Try again', callback_data: 'abx:back' }], closeRow()]);
    return;
  }

  let items = itemsForCategory(session, pending, dupIdx);
  // APX-6 (owner 01-Aug) — ONE strict newest→oldest timeline across open
  // and received transfers: the chip carries no date, so position is the
  // only recency signal and must never lie.
  if (session.category === 'transfers') {
    items = items.concat(await recentReceivedTransfers());
    const ts = (r) => new Date(r.createdAt || r.resolvedAt || 0).getTime() || 0;
    items.sort((a, b) => ts(b) - ts(a));
  }
  session._items = items;
  session.step = 'pick_item';
  sessionStore.set(userId, session);

  const title = titleFor(session.category);

  if (!items.length) {
    await render(bot, chatId, userId,
      `${title}\n\n✅ _Nothing left here._`,
      [backRow('⬅ Categories'), closeRow()]);
    return;
  }

  const pages = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE));
  const page = Math.min(Math.max(0, session.page || 0), pages - 1);
  const slice = items.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

  const isTransfers = session.category === 'transfers';

  // Names, never raw Telegram ids (owner rule, 19-Jul — the digest and the
  // reminder sweep already do this). Resolved once per DISTINCT requester on
  // this page; resolveUserLabel keeps its own cache, so paging is cheap.
  const nameOf = new Map();
  for (const id of new Set(slice.map((it) => String(it.user || '')))) {
    if (!id) continue;
    try {
      nameOf.set(id, await approvalCards.resolveUserLabel(id, bot));
    } catch (_) {
      nameOf.set(id, id); // fall back to the id rather than losing the row
    }
  }

  // APF-2 (owner, 08-Aug-2026): a pending sale whose stock is already gone
  // is not a normal "waiting on you" row — the age dot (🔴 = 7d+) read as
  // "unprocessed" when the sale had in fact executed. Those rows carry ⚠️
  // instead, matching the transfer group's rule that the icon tells STATE.
  let goneByReq = new Set();
  if (slice.some((it) => require('../services/saleStockCheck').SALE_ACTIONS.includes(((it.actionJSON || {}).action) || ''))) {
    try {
      const { allItemsGone, SALE_ACTIONS } = require('../services/saleStockCheck');
      const inv = await require('../repositories/inventoryRepository').getAll();
      goneByReq = new Set(slice
        .filter((it) => SALE_ACTIONS.includes(((it.actionJSON || {}).action) || '')
          && String(it.status || 'pending').toLowerCase() === 'pending'
          && allItemsGone(it.actionJSON, inv))
        .map((it) => String(it.requestId)));
    } catch (e) {
      logger.warn(`approvalsInbox: stock-gone chips skipped: ${e.message}`);
    }
  }

  const rows = slice.map((it) => {
    const i = items.indexOf(it);
    const days = ageDays(it.createdAt);
    const who = nameOf.get(String(it.user || '')) || it.user || '—';
    const dup = dupIdx.has(String(it.requestId)) ? '⧉ ' : '';
    const dot = goneByReq.has(String(it.requestId)) ? '⚠️' : ageDot(days);
    const label = isTransfers
      ? transferChipLabel(it)
      : `${dup}${dot} ${shortDate(it.createdAt)} · ${actionLabel(it)} · ${who}`;
    return [{ text: label.slice(0, 60), callback_data: `${isTransfers ? 'abx:trf' : 'abx:i'}:${i}` }];
  });
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '◀ Prev', callback_data: `abx:pg:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: 'abx:noop' });
    if (page < pages - 1) nav.push({ text: 'Next ▶', callback_data: `abx:pg:${page + 1}` });
    rows.push(nav);
  }
  rows.push(backRow('⬅ Categories'));
  rows.push(closeRow());

  const note = isTransfers
    ? '\n🔴 requested · 🟡 in transit · 🟢 received · B bales · T thans — newest first\n_Not approvals — tap one to open its transfer card._'
    : `\n🟢 new · 🟠 3d+ · 🔴 7d+ waiting${goneByReq.size ? ' · ⚠️ stock already gone — open it and use Mark as done / Reject' : ''}`;
  const headCount = isTransfers
    ? (() => {
      const done = items.filter((it) => String(it.status || '').toLowerCase() === 'approved').length;
      return `*${items.length - done}* open${done ? ` · ${done} 🟢` : ''}`;
    })()
    : `*${items.length}* pending`;
  await render(bot, chatId, userId, `${title} — ${headCount}${note}`, rows);
}

/* ───────────────────────── level 3: one item ───────────────────────── */

async function renderItem(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const item = (session._items || [])[idx];
  if (!item) { await renderItems(bot, chatId, userId); return; }

  session.step = 'view_item';
  session.itemIdx = idx;
  sessionStore.set(userId, session);

  // APF-1 — the list is a snapshot; the row may have resolved since (the
  // other admin, an older card, a race). Re-read LIVE before offering
  // Approve/Reject: a resolved request renders as a record, not a decision.
  try {
    const live = await approvalQueueRepository.getByRequestId(item.requestId);
    if (live && String(live.status || '').toLowerCase() !== 'pending') {
      const st = String(live.status).toLowerCase();
      const when = live.resolvedAt ? ` · ${String(live.resolvedAt).slice(0, 10)}` : '';
      let card = '';
      try { card = await approvalCards.buildCardFromActionJSON(live.actionJSON) || ''; } catch (_) { /* bare */ }
      await render(bot, chatId, userId,
        `${card}\n\n${st === 'approved' ? '✅' : '❌'} _Already ${st}${when} — no action needed._`,
        [backRow('⬅ Back to list'), closeRow()]);
      return;
    }
  } catch (e) {
    logger.warn(`approvalsInbox: live status re-check failed for ${item.requestId}: ${e.message}`);
    // Fall through to the snapshot card — the executor still refuses.
  }

  let card = '';
  try {
    card = await approvalCards.buildCardFromActionJSON(item.actionJSON) || '';
  } catch (e) {
    logger.warn(`approvalsInbox: card build failed for ${item.requestId}: ${e.message}`);
  }
  if (!card) card = `${actionLabel(item)} request`;

  let who = String(item.user || '—');
  try { who = await approvalCards.resolveUserLabel(item.user, bot); } catch (_) { /* id fallback */ }

  const days = ageDays(item.createdAt);
  // DUAL-1: a first approval is recorded on actionJSON.approvals and the
  // request stays pending until a DIFFERENT admin gives the second.
  const prior = Array.isArray(item.actionJSON && item.actionJSON.approvals)
    ? item.actionJSON.approvals : [];
  const dualNote = prior.length
    ? `\n\n⚠️ _1 of 2 approvals already given — a different admin must give the second._`
    : '';

  // APX-2 — the warning that matters most sits HERE, on the card being
  // approved: approving several copies of one sale would apply it several
  // times. Siblings are listed so the admin can go and reject the extras.
  // Read fresh rather than reusing the list's snapshot: by the time the admin
  // opens this card a sibling may already have been approved or rejected, and
  // a stale warning about a request that is no longer pending is worse than
  // none. Only rows still PENDING can be double-applied.
  let dupNote = '';
  try {
    const { dupIdx } = await loadQueue();
    const group = dupIdx.get(String(item.requestId));
    if (group && group.length > 1) {
      const others = group.filter((g) => String(g.requestId) !== String(item.requestId));
      dupNote = `\n\n⧉ *${group.length} identical requests* were queued within minutes of each other.\n`
        + `_Approve ONE — approving more applies this ${actionLabel(item)} ${group.length} times._\n`
        + `_Others: ${others.map((o) => approvalCards.shortRequestRef(o.requestId)).join(', ')}_`;
    }
  } catch (e) {
    logger.warn(`approvalsInbox: duplicate check failed for ${item.requestId}: ${e.message}`);
  }

  // APX-4 — one compact footer line; the raw UUID never reaches the screen.
  // SAB-1 (owner, 06-Aug-2026) — the bill on demand. "(see below)" was a lie
  // on this card: the forwarded bill sat next to the REQUEST-time DM, which
  // may have scrolled away days before the admin opens the inbox. The chip
  // delivers it right here, as an ephemeral view swept on the next tap.
  const docRow = item.actionJSON && item.actionJSON.sale_doc_file_id
    ? [[{ text: '📄 Sales bill', callback_data: `abx:doc:${idx}` }]]
    : [];
  // APF-2 (owner, 08-Aug-2026): a pending sale whose stock is ALL gone gets
  // the two REAL choices — plain Approve could only walk the wizard into a
  // dead end. Same shared judgement as the ⚠️ chips and Sentinel C8; if the
  // Inventory read fails, the normal buttons stand and the executor still
  // refuses safely.
  let decisionRows = [[{ text: '✅ Approve', callback_data: `abx:ok:${idx}` },
    { text: '❌ Reject', callback_data: `abx:no:${idx}` }]];
  try {
    const { allItemsGone, SALE_ACTIONS } = require('../services/saleStockCheck');
    const aj = item.actionJSON || {};
    if (SALE_ACTIONS.includes(aj.action)
      && allItemsGone(aj, await require('../repositories/inventoryRepository').getAll())) {
      decisionRows = [
        [{ text: '✅ Mark as done (no re-run)', callback_data: `apz:done:${item.requestId}` }],
        [{ text: '❌ Reject', callback_data: `abx:no:${idx}` }],
      ];
    }
  } catch (e) {
    logger.warn(`approvalsInbox: stock-gone button check failed for ${item.requestId}: ${e.message}`);
  }
  await render(bot, chatId, userId,
    `${card}\n\n_Requested by ${who} · ${ageDot(days)}${days > 0 ? `${days}d` : 'today'} · ${approvalCards.shortRequestRef(item.requestId)}_${dualNote}${dupNote}`,
    [
      ...decisionRows,
      ...docRow,
      backRow('⬅ Back to list'),
      closeRow(),
    ]);
}

/**
 * Hand a decision to the STANDARD approval handler.
 *
 * The inbox deliberately owns no approval logic: it rebuilds the canonical
 * `approve:<id>` / `reject:<id>` callback and calls the same entry point a
 * DM card would, so every guard and executor runs unchanged. The handler
 * wipes this card's keyboard and reports the outcome on it, so afterwards we
 * send a fresh one-line footer with the way back into the list.
 */
async function delegateDecision(bot, query, userId, idx, decision) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const item = (session._items || [])[idx];
  if (!item) { await renderItems(bot, chatId(query), userId); return; }

  const approvalEvents = require('../events/approvalEvents');
  const delegated = Object.assign(Object.create(Object.getPrototypeOf(query)), query, {
    data: `${decision}:${item.requestId}`,
  });
  try {
    await approvalEvents.handleApprovalCallback(bot, delegated, decision);
  } catch (e) {
    logger.error(`approvalsInbox: ${decision} of ${item.requestId} failed: ${e.message}`);
    try {
      await bot.sendMessage(chatId(query), `⚠️ Could not ${decision} ${item.requestId}: ${e.message}`);
    } catch (_) { /* ignore */ }
  }

  // The decided card is now a record. Re-anchor the inbox onto a FRESH
  // message so the admin can carry straight on — and so this never competes
  // with the sale-enrichment prompts an approval may kick off.
  // Re-count from a fresh read: the row just decided is no longer pending.
  // A failed read must not lose the admin's place, so fall back to a count
  // that simply excludes the row we just acted on.
  let remaining = Math.max(0, (session._items || []).length - 1);
  try {
    const { pending, dupIdx } = await loadQueue();
    remaining = itemsForCategory(session, pending, dupIdx).length;
  } catch (e) {
    logger.warn(`approvalsInbox: recount after ${decision} failed: ${e.message}`);
  }
  session.flowMessageId = null;
  session.page = 0;
  sessionStore.set(userId, session);
  await render(bot, chatId(query), userId,
    `🛂 ${titleFor(session.category)} — *${remaining}* still pending.`,
    [
      [{ text: `⬅ Back to ${remaining ? 'list' : 'categories'}`, callback_data: 'abx:back' }],
      [{ text: '🏠 Menu', callback_data: 'act:__back__' }],
    ]);
}

function chatId(query) {
  return query && query.message && query.message.chat && query.message.chat.id;
}

/* ──────────────────────────── callbacks ─────────────────────────── */

/**
 * Route an `abx:*` callback.
 * @param {object} bot @param {object} query
 * @returns {Promise<boolean>} true when handled
 */
async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('abx:')) return false;
  const userId = String(query.from.id);
  const cid = chatId(query);

  // Approve/Reject must NOT be pre-answered here — the delegated handler
  // answers the query itself (and a second answer is dropped by Telegram).
  const delegating = data.startsWith('abx:ok:') || data.startsWith('abx:no:');
  if (!delegating) {
    try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
  }
  // SAB-1 — bills delivered by 📄 are peeks, not chat residents: any next
  // inbox tap sweeps them (same contract as the transfer doc views).
  try { await require('../services/ephemeralDocs').sweep(bot, userId); } catch (_) { /* best-effort */ }

  // SAB-1 — deliver the sales bill for the card being viewed.
  if (data.startsWith('abx:doc:')) {
    const session0 = sessionStore.get(userId);
    const idx = parseInt(data.slice('abx:doc:'.length), 10);
    const item = session0 && Array.isArray(session0._items) ? session0._items[idx] : null;
    const aj = item && item.actionJSON;
    if (!aj || !aj.sale_doc_file_id) {
      try { await bot.answerCallbackQuery(query.id, { text: 'No bill attached to this request.', show_alert: true }); } catch (_) { /* answered above */ }
      return true;
    }
    const caption = `📄 Sales bill — ${approvalCards.shortRequestRef(item.requestId)}`;
    let sent = null;
    try {
      sent = aj.sale_doc_type === 'photo'
        ? await bot.sendPhoto(cid, aj.sale_doc_file_id, { caption })
        : await bot.sendDocument(cid, aj.sale_doc_file_id, { caption });
    } catch (_) {
      // Stored kind can be wrong for old rows — the other sender is the fallback.
      try {
        sent = aj.sale_doc_type === 'photo'
          ? await bot.sendDocument(cid, aj.sale_doc_file_id, { caption })
          : await bot.sendPhoto(cid, aj.sale_doc_file_id, { caption });
      } catch (e2) { logger.warn(`approvalsInbox: bill send failed for ${item.requestId}: ${e2.message}`); }
    }
    if (sent && sent.message_id) {
      require('../services/ephemeralDocs').track(bot, userId, cid, sent.message_id);
    }
    return true;
  }

  if (data === 'abx:noop') return true;

  if (!config.access.adminIds.includes(userId)) {
    try { await bot.answerCallbackQuery(query.id, { text: 'Approvals are admin-only.', show_alert: true }); } catch (_) { /* ignore */ }
    return true;
  }

  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    sessionStore.set(userId, {
      type: SESSION_TYPE, step: 'pick_category',
      flowMessageId: query.message.message_id,
      ttlMs: 20 * 60 * 1000,
      category: '', page: 0, _items: [],
    });
    await renderCategories(bot, cid, userId);
    return true;
  }

  if (data === 'abx:close') {
    sessionStore.clear(userId);
    try {
      await bot.editMessageText('🛂 Closed.', {
        chat_id: cid, message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]] },
      });
    } catch (_) { /* ignore */ }
    return true;
  }

  if (data === 'abx:back') {
    if (session.step === 'view_item') { await renderItems(bot, cid, userId); return true; }
    if (session.step === 'pick_item' && session.category) { await renderCategories(bot, cid, userId); return true; }
    await renderCategories(bot, cid, userId);
    return true;
  }

  if (data.startsWith('abx:cat:')) {
    session.category = data.slice('abx:cat:'.length);
    session.page = 0;
    sessionStore.set(userId, session);
    await renderItems(bot, cid, userId);
    return true;
  }

  if (data.startsWith('abx:pg:')) {
    session.page = parseInt(data.slice('abx:pg:'.length), 10) || 0;
    sessionStore.set(userId, session);
    await renderItems(bot, cid, userId);
    return true;
  }

  if (data.startsWith('abx:i:')) {
    await renderItem(bot, cid, userId, parseInt(data.slice('abx:i:'.length), 10));
    return true;
  }

  if (data.startsWith('abx:trf:')) {
    // Transfers are actioned in their own flow, never approved here.
    const item = (session._items || [])[parseInt(data.slice('abx:trf:'.length), 10)];
    if (!item) { await renderItems(bot, cid, userId); return true; }
    // TRF-9b — opening a card is navigation: sweep fetched doc views.
    try { await require('../services/ephemeralDocs').sweep(bot, userId); } catch (_) { /* viewer state only */ }
    try {
      // TRF-10 — the card replaces THIS list in place; ⬅ Back re-renders it.
      await require('../flows/transferFlow').showActionCard(bot, query, item.requestId, { backCb: 'abx:cat:transfers' });
    } catch (e) {
      logger.warn(`approvalsInbox: transfer card ${item.requestId} failed: ${e.message}`);
      try { await bot.sendMessage(cid, `🚚 Open 📋 Transfers to action ${item.requestId}.`); } catch (_) { /* ignore */ }
    }
    return true;
  }

  if (data.startsWith('abx:ok:')) {
    await delegateDecision(bot, query, userId, parseInt(data.slice('abx:ok:'.length), 10), 'approve');
    return true;
  }
  if (data.startsWith('abx:no:')) {
    await delegateDecision(bot, query, userId, parseInt(data.slice('abx:no:'.length), 10), 'reject');
    return true;
  }

  logger.warn(`approvalsInboxFlow: unhandled callback ${data}`);
  return true;
}

module.exports = {
  start,
  handleCallback,
  SESSION_TYPE,
  _internals: { categoryOf, ageDays, ageDot, CATEGORIES, TRANSFER_ACTIONS, STALE_DAYS },
};
