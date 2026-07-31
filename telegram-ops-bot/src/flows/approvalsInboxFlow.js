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

/** "sale_bundle" → "sale bundle". */
function actionLabel(item) {
  const a = (item && item.actionJSON && item.actionJSON.action) || 'unknown';
  return a.replace(/_/g, ' ');
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
    const waiting = transfers.length - inTransit;
    const mix = [waiting ? `${waiting} to dispatch` : '', inTransit ? `${inTransit} in transit` : '',
      received.length ? `${received.length} ✅` : ''].filter(Boolean).join(' · ');
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
 * APX-3c — mnemonic transfer chips (owner-confirmed Option A, 31-Jul):
 *   🟠DSP  LAG▸KAN  24Jul·01   dispatch pending (ball with the source)
 *   📦RCV  IDU▸KAN  24Jul·03   on the road, receive pending
 * Warehouse code = first 3 letters; short id = date·sequence from the
 * TR number. The screen hint carries the legend so the codes teach
 * themselves. Telegram buttons cannot be tinted — icon IS the shade.
 */
function whCode(w) {
  const letters = String(w || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  return letters.slice(0, 3) || '???';
}

function shortTransferId(requestId) {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = String(requestId || '').match(/^TR-(\d{4})(\d{2})(\d{2})-(\d+)$/);
  if (!m) return String(requestId || '');
  const seq = m[4].replace(/^0+/, '') || '0';
  return `${m[3]}${MON[Number(m[2]) - 1]}·${seq.padStart(2, '0')}`;
}

function transferChipLabel(it) {
  const aj = it.actionJSON || {};
  const route = aj.from || aj.to ? `  ${whCode(aj.from)}▸${whCode(aj.to)}` : '';
  // APX-3d — approved = receipt confirmed = inventory really moved.
  if (String(it.status || '').toLowerCase() === 'approved') {
    return `✅${route}  ${shortTransferId(it.requestId)}`;
  }
  const stage = aj.stage === 'in_transit' ? '📦RCV' : '🟠DSP';
  return `${stage}${route}  ${shortTransferId(it.requestId)}`;
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
  // APX-3d — greens ride at the bottom of the transfers list: actionable
  // rows first, the last 48h of confirmed receipts after.
  if (session.category === 'transfers') {
    items = items.concat(await recentReceivedTransfers());
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

  const rows = slice.map((it) => {
    const i = items.indexOf(it);
    const days = ageDays(it.createdAt);
    const who = nameOf.get(String(it.user || '')) || it.user || '—';
    const dup = dupIdx.has(String(it.requestId)) ? '⧉ ' : '';
    const label = isTransfers
      ? transferChipLabel(it)
      : `${dup}${ageDot(days)} ${shortDate(it.createdAt)} · ${actionLabel(it)} · ${who}`;
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
    ? '\n🟠DSP = dispatch pending · 📦RCV = receive pending · ✅ = received · from▸to\n_Not approvals — tap one to open its transfer card._'
    : '';
  const headCount = isTransfers
    ? (() => {
      const done = items.filter((it) => String(it.status || '').toLowerCase() === 'approved').length;
      return `*${items.length - done}* open${done ? ` · ${done} ✅` : ''}`;
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
  await render(bot, chatId, userId,
    `${card}\n\n_Requested by ${who} · ${ageDot(days)}${days > 0 ? `${days}d` : 'today'} · ${approvalCards.shortRequestRef(item.requestId)}_${dualNote}${dupNote}`,
    [
      [{ text: '✅ Approve', callback_data: `abx:ok:${idx}` },
        { text: '❌ Reject', callback_data: `abx:no:${idx}` }],
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
    try {
      await require('../flows/transferFlow').handleCallback(bot,
        Object.assign(Object.create(Object.getPrototypeOf(query)), query, { data: `trf:card:${item.requestId}` }));
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
