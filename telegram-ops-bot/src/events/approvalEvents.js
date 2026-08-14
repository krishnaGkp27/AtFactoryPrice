/**
 * Event handlers for approval workflow: notify admins, handle approve/reject.
 * For sale approvals: admin must enter rate (Naira per unit), payment mode, and amount paid (if paid).
 * Unit foundation: 'yard' for now; structure ready for other units (metre, piece) later.
 */

const config = require('../config');
const inventoryService = require('../services/inventoryService');
const logger = require('../utils/logger');
const inventoryRepository = require('../repositories/inventoryRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const usersRepository = require('../repositories/usersRepository');
const departmentsRepository = require('../repositories/departmentsRepository');
const driveClient = require('../repositories/driveClient');
const fmtDate = require('../utils/formatDate');
// Hoisted (TG-1): inline `require('../services/sessionStore')` calls in
// handleNewCustomerApproval crashed at runtime because sessionStore lives
// under utils/, not services/. Top-of-file require makes the path
// surface-visible and prevents the bug from re-appearing in a stray
// require deeper in the file.
const sessionStore = require('../utils/sessionStore');
const cartFormat = require('../utils/cartFormat');
// APX-4 — human-readable request refs on every user-facing message.
const { shortRequestRef } = require('../services/approvalCards');
// ANL-1 — usage analytics capture (fire-and-forget; no-op until enabled).
const usageTracker = require('../services/usageTracker');

const SALE_ACTIONS = ['sell_than', 'sell_package', 'sale_bundle'];
const DEFAULT_SALE_UNIT = 'yard';

/*
 * APC-1 (owner, 08-Aug-2026) — approval concurrency, Phase A.
 *
 * The sale wizard used to hold ONE state per admin: a second ✅ Approve
 * mid-wizard silently overwrote the first, and chips carried no request
 * identity, so a tap on the old card acted on the NEW request (the owner's
 * "complete mess"). Now:
 *   - state is keyed adminId|requestId — wizards run in parallel, one per
 *     request, and starting one never touches another;
 *   - every chip payload carries its requestId (enr:q:<rid>:…), so a tap
 *     always acts on the request whose card was tapped;
 *   - a typed reply goes to the LAST-TOUCHED wizard; with several open and
 *     none touched recently the bot ASKS which request it is for (§2 —
 *     never guess);
 *   - each wizard renders IN PLACE on its approval card (one anchored
 *     message per request, no step flood);
 *   - rate/payment answers persist to the queue row (enrichDraft) so a
 *     redeploy or expiry costs nothing — the wizard rebuilds mid-step.
 */
const pendingEnrichment = new Map(); // `${adminId}|${requestId}` → wizard state
const lastTouchedWizard = new Map(); // adminId → { requestId, at }
const heldEnrichmentText = new Map(); // adminId → { text, at } parked behind a "which request?" ask
const WIZARD_TTL_MS = 60 * 60 * 1000;
const TYPED_ROUTE_FRESH_MS = 5 * 60 * 1000;
const HELD_TEXT_TTL_MS = 2 * 60 * 1000;

function wizKey(adminId, requestId) { return `${adminId}|${requestId}`; }

function sweepWizards() {
  const now = Date.now();
  for (const [k, s] of pendingEnrichment) {
    if (now - (s.touchedAt || s.startedAt || 0) > WIZARD_TTL_MS) pendingEnrichment.delete(k);
  }
}

/** Open wizards belonging to one admin (TTL-swept). */
function wizardsOf(adminId) {
  sweepWizards();
  return [...pendingEnrichment.values()].filter((s) => String(s.adminId) === String(adminId));
}

function touchWizard(state) {
  state.touchedAt = Date.now();
  lastTouchedWizard.set(String(state.adminId), { requestId: state.requestId, at: state.touchedAt });
}

/**
 * The wizard an un-addressed input belongs to: the only open one, else the
 * last-touched. For TYPED input a stale last-touch (several wizards open,
 * none used in a while) returns null so the caller asks instead of guessing.
 */
function activeWizard(adminId, opts = {}) {
  const open = wizardsOf(adminId);
  if (!open.length) return null;
  if (open.length === 1) return open[0];
  const last = lastTouchedWizard.get(String(adminId));
  const lastState = last && pendingEnrichment.get(wizKey(adminId, last.requestId));
  if (lastState && (!opts.forTyping || Date.now() - last.at <= TYPED_ROUTE_FRESH_MS)) return lastState;
  return null;
}

// Tracks dispatch users currently typing a free-text rejection or
// decline reason. Keyed by user_id so the controller's text handler
// can route the next message back to the right Stage 1 / Stage 3
// callback.
//
// APC-1 Phase B — the value is a QUEUE (newest first), not a single slot:
// tapping ❌ on a second card before typing the first reason used to
// OVERWRITE the slot, stranding the first request with its buttons
// already wiped. Now the newest prompt is answered first and the bot
// re-prompts for each remaining one until the queue is empty — no
// decision is ever silently dropped. Entries:
// { kind: 'manager_reject'|'dispatch_decline', requestId, chatId, at }.
const pendingReason = new Map();

const REASON_KIND_LABEL = {
  manager_reject: 'Reject supply request',
  dispatch_decline: 'Decline supply request',
};

/** Queue a reason prompt (same request re-armed replaces its old entry).
 *  Returns how many OTHER prompts this user still owes. */
function armReasonPrompt(userId, entry) {
  const q = (pendingReason.get(String(userId)) || []).filter((e) => e.requestId !== entry.requestId);
  pendingReason.set(String(userId), [{ ...entry, at: Date.now() }, ...q]);
  return q.length;
}

/** Ask (or re-ask) for the reason at the head of the user's queue. */
async function promptNextReason(bot, userId) {
  const q = pendingReason.get(String(userId)) || [];
  if (!q.length) return;
  const head = q[0];
  try {
    await bot.sendMessage(head.chatId,
      `❌ *${REASON_KIND_LABEL[head.kind] || 'Reason needed'}* \`${head.requestId}\`\n\nReply with a brief reason (or type *cancel*).`,
      { parse_mode: 'Markdown' });
  } catch (_) { /* best-effort */ }
}

/**
 * Send a notification to the employee who raised the request.
 * Uses direct ID lookup (getByRequestId) as primary, falls back to provided userId.
 * Logs failures instead of silently swallowing them.
 */
/**
 * DSP-1 — close the loop on the dispatcher's own card.
 *
 * The dispatcher raised the request without knowing the buyer, so the
 * approval result has to come back to THEM: the card they submitted is
 * edited in place to show the approval plus the customer's name and phone,
 * which is what they need to actually dispatch.
 *
 * Editing can fail for ordinary reasons — the card is old, the chat was
 * cleared, Telegram refuses the edit — and none of them should cost the
 * dispatcher the information, so every failure falls back to a fresh
 * message. Returns nothing; delivery is best-effort by design.
 */
async function updateRequesterCard(bot, item, requestId, requestingUser, headline) {
  const aj = (item && item.actionJSON) || {};
  const customer = String(aj.customer || '').trim();
  let contact = '';
  if (customer) {
    try {
      const crmService = require('../services/crmService');
      const cust = await crmService.getCustomer(customer);
      const phone = cust && (cust.phone || cust.phone_number);
      if (phone) contact = `\n📞 ${phone}`;
    } catch (e) {
      logger.warn(`DSP-1: customer contact lookup failed for ${requestId}: ${e.message}`);
    }
  }
  const text = `${headline}\n\n👤 Customer: *${customer || '—'}*${contact}\nRef: ${shortRequestRef(requestId)}`;

  const chatId = aj.requesterChatId || requestingUser;
  const messageId = aj.requesterMessageId;
  if (chatId && messageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]] },
      });
      return;
    } catch (e) {
      logger.warn(`DSP-1: could not edit requester card for ${requestId}: ${e.message}`);
    }
  }
  await notifyEmployee(bot, requestingUser, requestId, text.replace(/[*`]/g, ''));
}

async function notifyEmployee(bot, requestingUser, requestId, message) {
  let userId = requestingUser;
  if (!userId) {
    try {
      const row = await approvalQueueRepository.getByRequestId(requestId);
      if (row && row.user) userId = row.user;
    } catch (e) {
      logger.error(`notifyEmployee: failed to look up user for request ${requestId}`, e.message);
    }
  }
  if (!userId) {
    logger.warn(`notifyEmployee: no user ID found for request ${requestId} — cannot notify employee`);
    return false;
  }
  try {
    await bot.sendMessage(userId, message);
    return true;
  } catch (e) {
    logger.error(`notifyEmployee: failed to send message to user ${userId} for request ${requestId}`, e.message);
    return false;
  }
}

/** Resolve the approval queue item and requesting user, with fallback. */
async function resolveRequest(requestId) {
  let item = null;
  let requestingUser = null;
  try {
    item = await approvalQueueRepository.getByRequestId(requestId);
    if (item) requestingUser = item.user;
  } catch (e) {
    logger.error(`resolveRequest: failed to fetch request ${requestId}`, e.message);
  }
  if (!item) {
    try {
      const pending = await approvalQueueRepository.getAllPending();
      item = pending.find((p) => p.requestId === requestId);
      if (item) requestingUser = item.user;
    } catch (e) {
      logger.error(`resolveRequest: fallback getAllPending also failed for ${requestId}`, e.message);
    }
  }
  return { item, requestingUser };
}

async function getDesignsForSale(item) {
  const aj = item?.actionJSON || {};
  if (aj.action === 'sell_than' || aj.action === 'sell_package') {
    return aj.design ? [String(aj.design).trim()] : [];
  }
  if (aj.action === 'sale_bundle' && Array.isArray(aj.items)) {
    const designs = new Set();
    for (const si of aj.items) {
      // TRF-INT4 — scoped so a same-numbered bale in another warehouse can't
      // put the wrong design on the admin's rate chips.
      const pkg = si.packageNo ? await inventoryRepository.findByPackage(si.packageNo, { warehouse: si.warehouse || aj.warehouse }) : [];
      if (pkg.length && pkg[0].design) designs.add(String(pkg[0].design).trim());
    }
    return Array.from(designs);
  }
  return [];
}

/**
 * ST-1 Part B — the customer's LAST PAID rate for a design (owner-locked
 * rate chip source). Reads recent sale rows from the Transactions sheet
 * (they carry customerName + pricePerYard since the sale executors write
 * them). Returns null when no prior matching sale exists.
 */
async function getLastPaidRate(customer, design) {
  if (!customer || !design) return null;
  try {
    const transactionsRepository = require('../repositories/transactionsRepository');
    const rows = await transactionsRepository.getLast(400);
    // CUS-2 — match every spelling this customer has been filed under, so
    // the "last paid" rate chip survives merges instead of going blind.
    const custNames = new Set([String(customer).trim().toLowerCase()]);
    try {
      const entity = require('../services/customerEntity');
      const cust0 = await entity.resolve({ name: customer });
      if (cust0) entity.namesFor(cust0).forEach((n) => custNames.add(String(n).trim().toLowerCase()));
    } catch (_) { /* single-spelling match still works */ }
    const dgn = String(design).trim().toUpperCase();
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (!/^(sell|sale)/i.test(String(r.action || ''))) continue;
      if (!custNames.has(String(r.customerName || '').trim().toLowerCase())) continue;
      if (String(r.design || '').trim().toUpperCase() !== dgn) continue;
      const rate = parseFloat(r.pricePerYard);
      if (Number.isFinite(rate) && rate > 0) return rate;
    }
  } catch (e) {
    logger.warn(`getLastPaidRate(${customer}, ${design}) failed: ${e.message}`);
  }
  return null;
}

/** ST-1 Part B — registered banks (Settings BANK_LIST) for payment chips. */
async function getRegisteredBanks() {
  try {
    const settingsRepository = require('../repositories/settingsRepository');
    const all = await settingsRepository.getAll();
    return (all.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean);
  } catch (_) { return []; }
}

/**
 * DSP-1 — Step 1 of the approval chain: WHO is this going to?
 *
 * The dispatcher no longer picks a customer (owner decision, 26-Jul-2026):
 * they raise what physically leaves the warehouse, and the admin attaches
 * the buyer here, at approval. That is a control point — nothing ships
 * before management has named the customer.
 *
 * Offers recent buyers as one-tap chips, the full list paginated, a
 * ➕ New customer path (moved here from the sale flows), and free-text
 * search. Typing works at every step, as everywhere else in this chain.
 */
async function sendCustomerStep(bot, chatId, state, note) {
  state.step = 'customer';

  // CUS-1 Phase D (owner, 28-Jul: "suggested customers as per their sales,
  // and the previous rate for that design"). For a single-design sale the
  // top chips are buyers of THIS design, newest first, each carrying the
  // rate they LAST paid for it — the reminder and an identity check in one:
  // if the admin expects CJE around ₦1,500 and the chip says ₦900, either
  // memory or the books are wrong, and that is worth noticing BEFORE the
  // tap. Multi-design bundles have no single "the rate", so their chips
  // stay unannotated (general recency) — Step 2 handles per-design rates.
  const designBuyers = [];
  if ((state.designs || []).length === 1) {
    try {
      const rateSuggestionService = require('../services/rateSuggestionService');
      const customerEntity = require('../services/customerEntity');
      const sales = await rateSuggestionService.recentSalesForDesign(state.designs[0]);
      const seenIds = new Set();
      for (const sale of sales) {
        if (designBuyers.length >= 5) break;
        const cust = await customerEntity.resolve({ name: sale.customer });
        if (!cust || seenIds.has(cust.customer_id)) continue;
        if (String(cust.status || 'Active').toLowerCase() !== 'active') continue;
        seenIds.add(cust.customer_id);
        // Newest-first input → the first sale seen per customer IS their
        // latest rate for this design.
        designBuyers.push({ name: cust.name, rate: sale.pricePerYard });
      }
    } catch (e) {
      logger.warn(`design-buyer suggestions failed (falling back to recents): ${e.message}`);
    }
  }

  const recent = await getRecentBuyers();
  const names = designBuyers.map((b) => b.name);
  // CUS-ID2 (owner, 06-Aug-2026: "no recommendation, no guessing, only
  // solid customers") — recent-buyer chips came from raw Transactions
  // history, so a retired SPELLING could ride a chip and be filed as the
  // customer. Every chip now resolves through the registry: only live
  // entities appear, and each chip shows its CANONICAL name.
  for (const n of recent) {
    if (names.length >= 8) break;
    let canonical = null;
    try {
      const cust = await require('../services/customerEntity').resolve({ name: n });
      if (cust && String(cust.status || 'Active').toLowerCase() === 'active') {
        canonical = String(cust.name || '').trim();
      }
    } catch (_) { /* registry down → no history chips, typed search still works */ }
    if (canonical && !names.includes(canonical)) names.push(canonical);
  }
  state._custRecent = names;

  const rows = [];
  // Design buyers first, one per row — the rate needs the width.
  designBuyers.forEach((b, i) => {
    const rate = Number.isFinite(b.rate) && b.rate > 0
      ? ` — ₦${Number(b.rate).toLocaleString('en-NG')}/yd` : '';
    rows.push([{ text: `👤 ${b.name.slice(0, 24)}${rate}`, callback_data: wizCb(state, `cust:r:${i}`) }]);
  });
  for (let i = designBuyers.length; i < names.length; i += 2) {
    const row = [{ text: `👤 ${names[i].slice(0, 26)}`, callback_data: wizCb(state, `cust:r:${i}`) }];
    if (names[i + 1]) row.push({ text: `👤 ${names[i + 1].slice(0, 26)}`, callback_data: wizCb(state, `cust:r:${i + 1}`) });
    rows.push(row);
  }
  // CUS-1 — no creation here: the admin picks from the official list. A
  // genuinely new buyer is added via CRM first (single door).
  rows.push([{ text: '📋 All customers', callback_data: wizCb(state, 'cust:all:0') }]);
  const what = describeSaleForCustomerStep(state);
  await renderWizard(bot, chatId, state,
    `${note ? `${note}\n\n` : ''}${wizHeader(state)}${what}\n\n`
    + `*Step 1 — Who is buying${(state.designs || []).length === 1 ? ` ${state.designs[0]}` : ''}?* Tap below, or reply with a name to search.\n`
    + `${designBuyers.length ? '_Buyers of this design first, with the rate they last paid for it._' : ''}${TYPED_NOTE}`,
    rows);
}

/** One line describing what is being dispatched, so the admin names the buyer with context. */
function describeSaleForCustomerStep(state) {
  const aj = (state.item && state.item.actionJSON) || {};
  const bits = [];
  if (state.designs && state.designs.length) bits.push(`Design(s): ${state.designs.join(', ')}`);
  if (aj.packageNo) bits.push(`Bale: ${aj.packageNo}`);
  else if (Array.isArray(aj.items) && aj.items.length) bits.push(`${aj.items.length} item(s)`);
  if (aj.warehouse) bits.push(`From: ${aj.warehouse}`);
  return bits.length ? `\n${bits.join(' · ')}` : '';
}

/** Buyers seen most recently in Transactions, newest first — resolved to
 *  CANONICAL ACTIVE customers only (CUS-1): a history typo or a merged/
 *  pending name is never suggested, because suggesting it perpetuates it. */
async function getRecentBuyers() {
  try {
    const transactionsRepository = require('../repositories/transactionsRepository');
    const customerEntity = require('../services/customerEntity');
    const rows = await transactionsRepository.getLast(300);
    const seen = [];
    const seenIds = new Set();
    for (let i = rows.length - 1; i >= 0 && seen.length < 8; i--) {
      const r = rows[i];
      if (!/^(sell|sale)/i.test(String(r.action || ''))) continue;
      const n = String(r.customerName || '').trim();
      if (!n) continue;
      const cust = await customerEntity.resolve({ name: n });
      if (!cust || seenIds.has(cust.customer_id)) continue;
      const status = String(cust.status || 'Active').toLowerCase();
      if (status !== 'active') continue;
      seenIds.add(cust.customer_id);
      seen.push(cust.name);
    }
    return seen;
  } catch (e) {
    logger.warn(`getRecentBuyers failed: ${e.message}`);
    return [];
  }
}

/** DSP-1 — one page of the full customer list (active first, 10 per page). */
async function sendCustomerPage(bot, chatId, state, page) {
  const PER = 10;
  let all = [];
  try {
    // CUS-1 — active canonical customers only (Pending used to leak here).
    all = (await require('../services/customerEntity').activeList())
      .map((c) => c.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch (e) {
    logger.warn(`DSP-1 customer list failed: ${e.message}`);
  }
  if (!all.length) {
    try {
      await bot.sendMessage(chatId, 'No customers on file yet — an admin can add them via 👥 CRM → ➕ Add Customer.');
    } catch (_) { /* best-effort */ }
    return;
  }
  const pages = Math.max(1, Math.ceil(all.length / PER));
  const p = Math.min(Math.max(0, page), pages - 1);
  state._custPage = all.slice(p * PER, (p + 1) * PER);
  const rows = state._custPage.map((n, i) => [{ text: `👤 ${n.slice(0, 40)}`, callback_data: wizCb(state, `cust:a:${i}`) }]);
  const nav = [];
  if (p > 0) nav.push({ text: '⬅ Prev', callback_data: wizCb(state, `cust:all:${p - 1}`) });
  if (p < pages - 1) nav.push({ text: 'Next ➡', callback_data: wizCb(state, `cust:all:${p + 1}`) });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '⬅ Back', callback_data: wizCb(state, 'cust:back') }]);
  await renderWizard(bot, chatId, state,
    `${wizHeader(state)}\n📋 *All customers* (page ${p + 1}/${pages}) — or reply with a name to search.${TYPED_NOTE}`,
    rows);
}

/**
 * Record the admin's customer choice on the QUEUE ROW, not just in memory.
 *
 * Writing it to actionJSON is what makes every downstream consumer work
 * unchanged — inventoryService, the ledger, the invoice, reports and the
 * duplicate detector all read aj.customer and none of them need to know
 * the value arrived at approval time rather than at request time.
 */
async function assignCustomer(bot, chatId, state, name, opts = {}) {
  const clean = String(name || '').trim();
  if (!clean) return false;
  // CUS-1 — the entity id rides with the name on the queue row, so every
  // downstream consumer can key on the id once Phase C lands.
  let custId = '';
  let canonical = clean;
  try {
    const cust = await require('../services/customerEntity').resolve({ name: clean });
    if (cust) { custId = cust.customer_id; canonical = String(cust.name || clean).trim(); }
  } catch (_) { /* id is additive; the name still works */ }
  // CUS-ID2 (owner, 06-Aug-2026: "give the transparency at pick time") —
  // when the picked spelling resolves to a DIFFERENT canonical customer
  // (an alias from a merge), the admin confirms before anything is filed.
  // The invoice and ledger will carry the canonical name; that must never
  // again be a surprise discovered on the finished paper.
  if (custId && canonical.toLowerCase() !== clean.toLowerCase() && !opts.aliasConfirmed) {
    state._aliasPending = { spelling: clean, canonical };
    await renderWizard(bot, chatId, state,
      `${wizHeader(state)}\nℹ️ *${clean}* is filed under *${canonical}* — the invoice and ledger will read ${canonical}.`,
      [
        [{ text: `✅ Continue as ${canonical}`.slice(0, 60), callback_data: wizCb(state, 'cust:cf:y') },
          { text: '👥 Pick another customer', callback_data: wizCb(state, 'cust:cf:n') }],
      ]);
    return false;
  }
  try {
    await approvalQueueRepository.updateActionJSON(state.requestId, { customer: clean, customerId: custId });
  } catch (e) {
    // CUS-2 — the executor RE-READS actionJSON from the queue sheet, so an
    // unpersisted assignment would execute the sale with no customer at
    // all. Fail loud and stay on this step instead of advancing.
    logger.error(`DSP-1: could not persist customer on ${state.requestId}: ${e.message}`);
    try { await bot.sendMessage(chatId, `⚠️ Could not record the customer on ${state.requestId} (${e.message}). Nothing was saved — tap the customer again.`); } catch (_) {}
    return false;
  }
  if (state.item && state.item.actionJSON) {
    state.item.actionJSON.customer = clean;
    state.item.actionJSON.customerId = custId;
  }
  state.customer = clean;
  await sendRateStep(bot, chatId, state);
  return true;
}


/** APC-1 — every wizard chip carries its request: enr:q:<requestId>:<action>. */
function wizCb(state, suffix) { return `enr:q:${state.requestId}:${suffix}`; }

/** APC-1 — the step header: the admin must always know which request they
 *  are inside, because several cards can be open at once. */
function wizHeader(state) {
  return `📋 *Confirm sale — ${shortRequestRef(state.requestId)}*`;
}

const TYPED_NOTE = '\n✍️ _A typed reply goes to the request you touched last._';

/**
 * APC-1 — the wizard lives IN the approval card: every step edits the same
 * anchored message (per request), so processing three sales is three cards,
 * not an interleaved stack of step messages. A failed edit (old card, chat
 * cleared) falls back to a fresh message which becomes the new anchor.
 */
async function renderWizard(bot, chatId, state, text, rows) {
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  const anchorChat = state.anchorChatId || chatId;
  if (state.anchorMessageId) {
    try {
      await bot.editMessageText(text, { chat_id: anchorChat, message_id: state.anchorMessageId, ...opts });
      return;
    } catch (_) { /* stale/unchanged card → fresh anchor below */ }
  }
  try {
    const m = await bot.sendMessage(anchorChat, text, opts);
    if (m && m.message_id) { state.anchorMessageId = m.message_id; state.anchorChatId = anchorChat; }
  } catch (_) { /* best-effort */ }
}

/** APC-1 — persist mid-wizard answers on the queue row (best-effort): a
 *  redeploy or TTL expiry then costs nothing, the wizard rebuilds at the
 *  first unanswered step. The customer pick has its own load-bearing
 *  persistence in assignCustomer; this carries rate + payment mode. */
async function persistEnrichDraft(state) {
  try {
    await approvalQueueRepository.updateActionJSON(state.requestId, {
      enrichDraft: {
        ratePerUnitByDesign: state.ratePerUnitByDesign || null,
        paymentMode: state.paymentMode || null,
      },
    });
  } catch (e) {
    logger.warn(`APC-1: enrichDraft persist failed for ${state.requestId}: ${e.message}`);
  }
}

async function startApprovalEnrichment(bot, adminId, chatId, requestId, item, requestingUser, anchorMessageId = null) {
  const designs = await getDesignsForSale(item);
  const unit = DEFAULT_SALE_UNIT;
  const aj = (item && item.actionJSON) || {};
  const draft = aj.enrichDraft || {};
  const state = {
    requestId, step: 'rate', item, requestingUser, designs, unit,
    adminId: String(adminId), customer: aj.customer || '',
    anchorChatId: chatId, anchorMessageId: anchorMessageId || null,
    startedAt: Date.now(),
    ratePerUnitByDesign: (draft.ratePerUnitByDesign && Object.keys(draft.ratePerUnitByDesign).length)
      ? draft.ratePerUnitByDesign : undefined,
    paymentMode: draft.paymentMode || undefined,
  };
  // APC-1 — one wizard per REQUEST: starting this one leaves every other
  // in-flight wizard untouched.
  pendingEnrichment.set(wizKey(state.adminId, requestId), state);
  touchWizard(state);

  // DSP-1 — a request that already names a customer (anything queued before
  // this change, and any path that still supplies one) keeps its buyer and
  // goes straight to the rate step. Only customer-less requests are asked.
  if (!String(aj.customer || '').trim()) {
    await sendCustomerStep(bot, chatId, state);
    return;
  }
  // APC-1 resume — answers already persisted on the row skip their steps:
  // rejoin at the first unanswered one.
  if (state.ratePerUnitByDesign) {
    if (state.paymentMode) { await sendAmountStep(bot, chatId, state); return; }
    await sendPaymentStep(bot, chatId, state);
    return;
  }
  await sendRateStep(bot, chatId, state);
}

/** ST-1 Part B — Step 2: rate chips (the customer's last paid rate first). */
async function sendRateStep(bot, chatId, state) {
  state.step = 'rate';
  const { designs, unit } = state;
  const designList = designs.length ? designs.join(', ') : 'this item';
  const customer = state.customer || (state.item && state.item.actionJSON && state.item.actionJSON.customer) || '';

  // ST-1 Part B — tappable rate step: single-design sales offer the
  // customer's last-paid rate as a one-tap chip (owner decision); typing
  // a rate still works exactly as before at every step. This is why the
  // customer step runs FIRST — without a buyer there is no last-paid rate.
  const rows = [];
  if (designs.length === 1) {
    const last = await getLastPaidRate(customer, designs[0]);
    if (last) {
      state.lastPaidRate = last;
      rows.push([{ text: `₦${Number(last).toLocaleString('en-NG')}/yd — last paid by ${String(customer).slice(0, 24)}`, callback_data: wizCb(state, 'rate:v') }]);
    }
  }
  rows.push([{ text: '✏️ Type a custom rate', callback_data: wizCb(state, 'rate:custom') }]);
  // DSP-1b — a mistapped buyer must be recoverable HERE. Without this chip
  // the wrong customer was locked in: the choice persists on the queue row
  // the moment it is tapped, so abandoning and re-approving skipped Step 1
  // entirely and the only exit was editing the sheet by hand.
  rows.push([{ text: `✎ Change customer (${String(customer || '—').slice(0, 24)})`, callback_data: wizCb(state, 'cust:back') }]);
  // CUS-1 Phase D (owner: "I would go with the outstanding balance on
  // step 2") — credit exposure belongs where more stock is being assigned,
  // not only AFTER the sale executes. Best-effort: a ledger hiccup never
  // blocks the chain.
  let outstandingLine = '';
  try {
    if (customer) {
      const accountingService = require('../services/accountingService');
      const { outstandingAsOfToday } = await accountingService.getCustomerLedger(customer);
      if (Number.isFinite(outstandingAsOfToday)) {
        outstandingLine = `\n📒 Outstanding: ₦${Number(outstandingAsOfToday).toLocaleString('en-NG')}`;
      }
    }
  } catch (e) {
    logger.warn(`outstanding lookup failed for "${customer}": ${e.message}`);
  }

  await renderWizard(bot, chatId, state,
    `${wizHeader(state)}\n\nCustomer: *${customer || '—'}*${outstandingLine}\nDesign(s): ${designList}\nUnit: ${unit} (Naira per ${unit})\n\n*Step 2 — Rate:* tap below, or reply with rate per ${unit}.\n• Single design: e.g. \`1500\`\n• Multiple: e.g. \`44200:1500, 44201:1200\`${TYPED_NOTE}`,
    rows);
}

/** ST-1 Part B — Step 2 with payment-mode chips (banks from Settings). */
async function sendPaymentStep(bot, chatId, state) {
  state.step = 'payment';
  state.banks = await getRegisteredBanks();
  const rows = [[{ text: '💵 Cash', callback_data: wizCb(state, 'pay:cash') }, { text: '🕐 Not yet paid', callback_data: wizCb(state, 'pay:nyp') }]];
  for (let i = 0; i < state.banks.length; i += 2) {
    const row = [{ text: `🏦 ${state.banks[i]}`, callback_data: wizCb(state, `pay:b:${i}`) }];
    if (state.banks[i + 1]) row.push({ text: `🏦 ${state.banks[i + 1]}`, callback_data: wizCb(state, `pay:b:${i + 1}`) });
    rows.push(row);
  }
  rows.push([{ text: '✏️ Type payment mode', callback_data: wizCb(state, 'pay:custom') }]);
  // BANK-2 — no dead-end mid-approval: if the receiving account isn't
  // registered yet, one tap opens 🏦 Manage Banks (admin-only anyway).
  rows.push([{ text: '🏦 Manage accounts', callback_data: 'act:manage_banks' }]);
  await renderWizard(bot, chatId, state,
    `${wizHeader(state)}\n👤 ${state.customer || '—'}\n\n*Step 3 — Payment mode:* tap below, or reply with one of:\n• Cash\n• Credit\n• Paid to [Bank]\n• Not yet paid${TYPED_NOTE}`,
    rows);
}

/** ST-1 Part B — Step 3 with a computed "Paid in full" chip when possible. */
async function sendAmountStep(bot, chatId, state) {
  state.step = 'amount_paid';
  const aj = (state.item && state.item.actionJSON) || {};
  let full = 0;
  const rates = state.ratePerUnitByDesign || {};
  if (aj.yardsByDesign && Object.keys(aj.yardsByDesign).length) {
    for (const [d, yds] of Object.entries(aj.yardsByDesign)) {
      const r = rates[d] ?? rates[Object.keys(rates)[0]];
      if (Number.isFinite(r) && r > 0 && Number.isFinite(yds)) full += r * yds;
    }
  } else if (Number.isFinite(parseFloat(aj.yards)) && state.designs.length === 1) {
    const r = rates[state.designs[0]];
    if (Number.isFinite(r)) full = r * parseFloat(aj.yards);
  }
  state.fullAmount = full > 0 ? Math.round(full) : null;
  const rows = [];
  if (state.fullAmount) {
    rows.push([{ text: `✅ Paid in full — ₦${state.fullAmount.toLocaleString('en-NG')}`, callback_data: wizCb(state, 'amt:full') }]);
  }
  rows.push([{ text: '✏️ Type the amount', callback_data: wizCb(state, 'amt:custom') }]);
  await renderWizard(bot, chatId, state,
    `${wizHeader(state)}\n👤 ${state.customer || '—'} · ${state.paymentMode || ''}\n\n*Step 4 — Amount paid:* tap below, or reply with the amount received (Naira), e.g. 50000${TYPED_NOTE}`,
    rows);
}

/**
 * ST-1 Part B — enrichment chip taps (enr: namespace). Mirrors the typed
 * transitions in handleEnrichmentMessage exactly; typing keeps working at
 * every step. All acks are best-effort (stale-query hardening).
 */
async function handleEnrichmentCallback(bot, callbackQuery) {
  let data = callbackQuery.data || '';
  if (!data.startsWith('enr:')) return false;
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const ack = async (text) => { try { await bot.answerCallbackQuery(callbackQuery.id, text ? { text } : undefined); } catch (_) {} };

  // APC-1 — chips carry their request (enr:q:<rid>:<rest>): the tap acts on
  // THAT wizard, never on "whatever the admin opened last".
  let rid = null;
  if (data.startsWith('enr:q:')) {
    const after = data.slice('enr:q:'.length);
    const cut = after.indexOf(':');
    if (cut > 0) { rid = after.slice(0, cut); data = `enr:${after.slice(cut + 1)}`; }
  }
  let state = null;
  if (rid) {
    state = pendingEnrichment.get(wizKey(adminId, rid));
    if (!state) {
      // A redeploy or TTL expiry ate the in-memory state. The persisted
      // customer + enrichDraft let the wizard rebuild — restart it in
      // place on this card instead of dead-ending the tap.
      const { item, requestingUser } = await resolveRequest(rid);
      const resumable = item && String(item.status || '').toLowerCase() === 'pending'
        && SALE_ACTIONS.includes(((item.actionJSON) || {}).action)
        && config.access.adminIds.includes(adminId);
      await ack(resumable ? 'Resuming…' : 'That request is no longer open.');
      if (resumable) {
        await startApprovalEnrichment(bot, adminId, chatId, rid, item, requestingUser,
          callbackQuery.message.message_id);
      }
      return true;
    }
  } else {
    // Legacy chip from a pre-APC-1 card: safe only when exactly one wizard
    // is open — with several, acting on any of them would be a guess (§2).
    const open = wizardsOf(adminId);
    if (!open.length) { await ack('No sale confirmation in progress.'); return true; }
    if (open.length > 1) {
      await ack('This card is from before the update — tap ✅ Approve on the request again.');
      return true;
    }
    state = open[0];
  }
  touchWizard(state);
  const CURRENCY = config.currency || 'NGN';
  const fmt = (n) => `${CURRENCY} ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`;

  const finish = async (amountPaid) => {
    state.amountPaid = amountPaid;
    state.step = null;
    pendingEnrichment.delete(wizKey(adminId, state.requestId));
    // Seal this wizard's card before executing so its chips die with it.
    await renderWizard(bot, chatId, state,
      `${wizHeader(state)}\n⏳ Applying…`, []);
    const enrichment = {
      unit: state.unit,
      ratePerUnitByDesign: state.ratePerUnitByDesign,
      paymentMode: state.paymentMode,
      amountPaid,
    };
    await runApprovedSaleWithEnrichment(bot, chatId, adminId, state.requestId, state.item, state.requestingUser, enrichment, fmt);
  };

  // APC-1 — "which request?" pick for a typed reply that was parked because
  // several wizards were open and none was touched recently.
  if (data === 'enr:route') {
    const held = heldEnrichmentText.get(adminId);
    heldEnrichmentText.delete(adminId);
    await ack();
    if (held && Date.now() - held.at <= HELD_TEXT_TTL_MS) {
      await applyEnrichmentText(bot, chatId, adminId, state, held.text);
    } else {
      try { await bot.sendMessage(chatId, 'That reply expired — type it again.'); } catch (_) { /* best-effort */ }
    }
    return true;
  }

  // DSP-1 — Step 1 customer taps. Every branch ends either by assigning a
  // buyer (which advances to the rate step) or by re-rendering a picker;
  // none of them can fall through to execution without a customer.
  if (data.startsWith('enr:cust:')) {
    const rest = data.slice('enr:cust:'.length);
    // CUS-ID2 — the alias-transparency confirm.
    if (rest === 'cf:y') {
      const p = state._aliasPending;
      state._aliasPending = null;
      if (!p) { await ack('That confirmation expired — pick again.'); return true; }
      await ack(p.canonical);
      await assignCustomer(bot, chatId, state, p.canonical, { aliasConfirmed: true });
      return true;
    }
    if (rest === 'cf:n') {
      state._aliasPending = null;
      await ack();
      await sendCustomerStep(bot, chatId, state, 'Pick the right customer:');
      return true;
    }
    if (rest.startsWith('r:')) {
      const name = (state._custRecent || [])[Number(rest.slice(2))];
      if (!name) { await ack('That option expired — pick again.'); return true; }
      await ack(name);
      await assignCustomer(bot, chatId, state, name);
      return true;
    }
    if (rest.startsWith('all:')) {
      await ack();
      await sendCustomerPage(bot, chatId, state, Number(rest.slice(4)) || 0);
      return true;
    }
    if (rest.startsWith('a:')) {
      const name = (state._custPage || [])[Number(rest.slice(2))];
      if (!name) { await ack('That option expired — pick again.'); return true; }
      await ack(name);
      await assignCustomer(bot, chatId, state, name);
      return true;
    }
    if (rest === 'back') {
      await ack();
      await sendCustomerStep(bot, chatId, state);
      return true;
    }
    await ack();
    return true;
  }

  if (data === 'enr:rate:v' && state.step === 'rate' && state.lastPaidRate) {
    const rateByDesign = {};
    state.designs.forEach((d) => { rateByDesign[d] = state.lastPaidRate; });
    state.ratePerUnitByDesign = rateByDesign;
    await ack(`Rate: ₦${state.lastPaidRate}/yd`);
    await persistEnrichDraft(state);
    await sendPaymentStep(bot, chatId, state);
    return true;
  }
  if (data === 'enr:rate:custom') {
    await ack();
    try { await bot.sendMessage(chatId, 'Reply with the rate per yard, e.g. `1500` (or `44200:1500, 44201:1200`).', { parse_mode: 'Markdown' }); } catch (_) {}
    return true;
  }
  if (data === 'enr:pay:cash' && state.step === 'payment') {
    state.paymentMode = 'Cash';
    await ack('Cash');
    await persistEnrichDraft(state);
    await sendAmountStep(bot, chatId, state);
    return true;
  }
  if (data === 'enr:pay:nyp' && state.step === 'payment') {
    state.paymentMode = 'Not yet paid';
    await ack('Not yet paid');
    await finish(0);
    return true;
  }
  if (data.startsWith('enr:pay:b:') && state.step === 'payment') {
    const bank = (state.banks || [])[parseInt(data.slice('enr:pay:b:'.length), 10)];
    if (!bank) { await ack('Expired — pick again.'); return true; }
    state.paymentMode = `Paid to ${bank}`;
    await ack(bank);
    await persistEnrichDraft(state);
    await sendAmountStep(bot, chatId, state);
    return true;
  }
  if (data === 'enr:pay:custom') {
    await ack();
    try { await bot.sendMessage(chatId, 'Reply with the payment mode (e.g. `Paid to GTBank`, `Credit`).', { parse_mode: 'Markdown' }); } catch (_) {}
    return true;
  }
  if (data === 'enr:amt:full' && state.step === 'amount_paid' && state.fullAmount) {
    await ack(`₦${state.fullAmount.toLocaleString('en-NG')}`);
    await finish(state.fullAmount);
    return true;
  }
  if (data === 'enr:amt:custom') {
    await ack();
    try { await bot.sendMessage(chatId, 'Reply with the amount received (Naira), e.g. 50000.'); } catch (_) {}
    return true;
  }
  await ack();
  return true;
}

async function handleEnrichmentMessage(bot, chatId, adminId, text) {
  if (!text) return false;
  const admin = String(adminId);
  const open = wizardsOf(admin);
  if (!open.length) return false;
  // APC-1 — a typed reply goes to the wizard the admin touched LAST. With
  // several open and none touched recently, routing would be a guess — ask.
  const state = activeWizard(admin, { forTyping: true });
  if (!state) {
    heldEnrichmentText.set(admin, { text: String(text).trim(), at: Date.now() });
    const rows = open.map((s) => {
      const who = s.customer || ((s.item && s.item.actionJSON && s.item.actionJSON.customer)) || `step: ${s.step}`;
      return [{ text: `${shortRequestRef(s.requestId)} — ${who}`.slice(0, 60), callback_data: wizCb(s, 'route') }];
    });
    try {
      await bot.sendMessage(chatId,
        '✋ More than one sale confirmation is open — which request is this reply for?',
        { reply_markup: { inline_keyboard: rows } });
    } catch (_) { /* best-effort */ }
    return true;
  }
  touchWizard(state);
  return applyEnrichmentText(bot, chatId, admin, state, text);
}

/** APC-1 — apply one typed reply to ONE resolved wizard state. */
async function applyEnrichmentText(bot, chatId, adminId, state, text) {
  const t = String(text).trim();
  const CURRENCY = config.currency || 'NGN';
  const fmt = (n) => `${CURRENCY} ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`;

  // CUS-1 — Step 1 typed: SEARCH ONLY over the official list, alias-aware.
  // The "add as new" escape is gone (owner, 29-Jul): a typed string can
  // never become a customer. New buyers are added via CRM first.
  if (state.step === 'customer') {
    let matches = [];
    try {
      const customerEntity = require('../services/customerEntity');
      matches = (await customerEntity.search(t)).map((c) => c.name);
    } catch (e) {
      logger.warn(`DSP-1 customer search failed: ${e.message}`);
    }
    const exact = matches.find((n) => n.toLowerCase() === t.toLowerCase());
    if (exact) { await assignCustomer(bot, chatId, state, exact); return true; }
    if (matches.length === 1) { await assignCustomer(bot, chatId, state, matches[0]); return true; }
    if (matches.length > 1) {
      state._custPage = matches.slice(0, 10);
      const rows = state._custPage.map((n, i) => [{ text: `👤 ${n.slice(0, 40)}`, callback_data: `enr:cust:a:${i}` }]);
      rows.push([{ text: '⬅ Back', callback_data: 'enr:cust:back' }]);
      try {
        await bot.sendMessage(chatId, `Customers matching “${t}” — tap one:`,
          { reply_markup: { inline_keyboard: rows } });
      } catch (_) { /* best-effort */ }
      return true;
    }
    try {
      await bot.sendMessage(chatId,
        `No customer matches “${t}”. Type again to search, or ask an admin to add them via 👥 CRM → ➕ Add Customer first.`,
        { reply_markup: { inline_keyboard: [[{ text: '📋 All customers', callback_data: 'enr:cust:all:0' }]] } });
    } catch (_) { /* best-effort */ }
    return true;
  }

  if (state.step === 'rate') {
    const rateByDesign = {};
    if (/^\d+(\.\d+)?$/.test(t)) {
      const single = parseFloat(t);
      if (isNaN(single) || single < 0) {
        await bot.sendMessage(chatId, 'Please enter a valid number for rate (Naira per yard).');
        return true;
      }
      state.designs.forEach((d) => { rateByDesign[d] = single; });
    } else {
      const pairs = t.split(/[,;]/).map((s) => s.trim());
      for (const p of pairs) {
        const [design, rateStr] = p.split(':').map((s) => s.trim());
        const rate = parseFloat(rateStr);
        if (design && !isNaN(rate) && rate >= 0) rateByDesign[design] = rate;
      }
      if (Object.keys(rateByDesign).length === 0) {
        await bot.sendMessage(chatId, 'Could not parse rates. Use single number (e.g. 1500) or design:rate (e.g. 44200:1500, 44201:1200).');
        return true;
      }
    }
    state.ratePerUnitByDesign = rateByDesign;
    await persistEnrichDraft(state);
    // ST-1 Part B — typed rate advances to the same tappable payment step.
    await sendPaymentStep(bot, chatId, state);
    return true;
  }

  // APC-1 — typed finishes seal this wizard's own card and delete ITS state
  // (never another request's), exactly like the chip finishes.
  const finishTyped = async (amountPaid) => {
    state.amountPaid = amountPaid;
    state.step = null;
    pendingEnrichment.delete(wizKey(adminId, state.requestId));
    await renderWizard(bot, chatId, state, `${wizHeader(state)}\n⏳ Applying…`, []);
    const enrichment = {
      unit: state.unit,
      ratePerUnitByDesign: state.ratePerUnitByDesign,
      paymentMode: state.paymentMode,
      amountPaid,
    };
    await runApprovedSaleWithEnrichment(bot, chatId, adminId, state.requestId, state.item, state.requestingUser, enrichment, fmt);
  };

  if (state.step === 'payment') {
    const mode = t;
    state.paymentMode = mode;
    const isPaid = /^paid\s+to\s+/i.test(mode) || /^cash$/i.test(mode);
    if (isPaid) {
      await persistEnrichDraft(state);
      // ST-1 Part B — typed mode advances to the same tappable amount step.
      await sendAmountStep(bot, chatId, state);
      return true;
    }
    await finishTyped(0);
    return true;
  }

  if (state.step === 'amount_paid') {
    const amount = parseFloat(t.replace(/[,]/g, ''));
    if (isNaN(amount) || amount < 0) {
      await bot.sendMessage(chatId, 'Please enter a valid amount (Naira), e.g. 50000');
      return true;
    }
    await finishTyped(amount);
    return true;
  }

  return false;
}

async function uploadSaleDocToDrive(bot, item, requestId) {
  const aj = item?.actionJSON || {};
  if (!aj.sale_doc_file_id) return null;
  try {
    const file = await bot.getFile(aj.sale_doc_file_id);
    const url = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
    const https = require('https');
    const buffer = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
    const ext = file.file_path.split('.').pop() || (aj.sale_doc_type === 'document' ? 'pdf' : 'jpg');
    const customer = (aj.customer || 'unknown').replace(/\s+/g, '_');
    const fileName = `sale_bill_${customer}_${requestId.slice(0, 12)}.${ext}`;
    const mimeType = aj.sale_doc_type === 'document' ? 'application/pdf' : 'image/jpeg';
    return await driveClient.uploadFile(buffer, fileName, mimeType);
  } catch (e) {
    logger.error(`Failed to upload sale doc for ${requestId}`, e.message);
    return null;
  }
}

async function runApprovedSaleWithEnrichment(bot, chatId, adminId, requestId, item, requestingUser, enrichment, fmt) {
  // DSP-1 fail-closed. The customer name is the ledger key: it stamps the
  // Inventory row, the Transactions row, the customer ledger and the
  // invoice. A sale applied without one is an untraceable stock movement
  // that no downstream report can reconstruct — so refuse rather than
  // write a blank buyer.
  if (!String((item && item.actionJSON && item.actionJSON.customer) || '').trim()) {
    logger.error(`DSP-1: refusing to execute ${requestId} — no customer assigned`);
    try {
      await bot.sendMessage(chatId,
        `⚠️ ${requestId} was NOT applied — no customer is assigned.\nTap ✅ Approve again and pick the buyer at Step 1.`);
    } catch (_) { /* best-effort */ }
    return;
  }
  try {
    const result = await inventoryService.executeApprovedAction(requestId, adminId, enrichment);
    if (result.ok) {
      let driveInfo = null;
      try { driveInfo = await uploadSaleDocToDrive(bot, item, requestId); } catch (_) {}
      // Fix B — if any items silently failed inside the bundle, show them
      // loudly to both the approving admin and the requesting employee.
      const rep = result.bundleReport;
      const partial = rep && rep.failedItems && rep.failedItems.length > 0;
      let partialTail = '';
      if (partial) {
        const lines = rep.failedItems.map((f) => {
          const base = f.type === 'than'
            ? `Bale ${f.packageNo} Than ${f.thanNo}`
            : `Bale ${f.packageNo}`;
          return `  • ${base}: ${f.reason}`;
        }).join('\n');
        const balesWord = rep.appliedPkgCount === 1 ? 'Bale' : 'Bales';
        partialTail = `\n\n⚠️ Partial apply — ${rep.failedItems.length} of ${rep.requestedItems} item(s) did NOT apply (${rep.appliedPkgCount} ${balesWord} / ${rep.appliedThans} thans / ${rep.appliedYards} yds were recorded):\n${lines}`;
      }
      // H6 — inventory applied but one or more ledger/book writes failed.
      // Loud, admin-facing: silent success here is how balances drift.
      const erpFails = Array.isArray(result.erpFailures) ? result.erpFailures : [];
      let erpTail = '';
      if (erpFails.length) {
        const failLines = erpFails.map((f) => `  • ${f.stage}: ${f.error}`).join('\n');
        erpTail = `\n\n🛑 BOOKS NOT UPDATED — the sale was applied to stock but these ledger entries FAILED:\n${failLines}\nCustomer balance may be off. Check LedgerTransactions for ${requestId} and re-post manually (details in AuditLog under erp_hook_failed).`;
      }
      const balesWordMsg = rep && rep.appliedPkgCount === 1 ? 'Bale' : 'Bales';
      let msg = partial
        ? `⚠️ Request ${shortRequestRef(requestId)} approved, but applied only ${rep.appliedPkgCount} of ${rep.requestedItems} ${balesWordMsg}. Ledger updated for what was applied.`
        : (erpFails.length
          ? `⚠️ Request ${shortRequestRef(requestId)} approved — stock updated, but the LEDGER write failed (see below).`
          : `✅ Request ${shortRequestRef(requestId)} approved. Sale and ledger updated.`);
      msg += partialTail;
      msg += erpTail;
      if (driveInfo) msg += `\n📎 [View Sales Bill](${driveInfo.webViewLink})`;
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
      // DSP-1 — the dispatcher's card is updated in place with the customer
      // the admin assigned. A partial apply still needs the full detail, so
      // that path keeps the plain message.
      if (partial) {
        await notifyEmployee(bot, requestingUser, requestId,
          `⚠️ Your request ${shortRequestRef(requestId)} was approved, but only ${rep.appliedPkgCount} of ${rep.requestedItems} ${balesWordMsg} could be applied. ${rep.failedItems.length} item(s) were stale/invalid and skipped. Please check with admin.${partialTail}`);
      } else {
        await updateRequesterCard(bot, item, requestId, requestingUser,
          '✅ *Approved — ready to dispatch*');
      }
      const customer = item?.actionJSON?.customer || item?.actionJSON?.customerName;
      if (customer) {
        try {
          const accountingService = require('../services/accountingService');
          const { outstandingAsOfToday } = await accountingService.getCustomerLedger(customer);
          await bot.sendMessage(chatId, `📒 *${customer}* — Outstanding as of today: ${fmt(outstandingAsOfToday)}`);
        } catch (_) {}
      }
      // INV-1a — deliver the issued invoice PDF to approver + requester
      // (statement-style, WhatsApp-forwardable). Best-effort: the sale is
      // already applied; a delivery hiccup only logs.
      if (result.invoice) {
        try {
          const invoiceService = require('../services/invoiceService');
          await invoiceService.deliver(bot, result.invoice, [chatId, requestingUser]);
        } catch (e) { logger.warn(`INV-1a delivery failed for ${requestId}: ${e.message}`); }
      }
    } else if (result.allItemsFailed) {
      // APF-1 — every bale in the sale is already sold/gone. This is either
      // an executed-but-unresolved row (a crash landed between the stock
      // flip and the status flip) or a duplicate of a sale that ran under
      // another request. NO money side effects ran (the executor aborts
      // before Transactions/ledger/payment now), and the bot must not
      // guess which case it is — the admin decides with two safe buttons.
      await bot.sendMessage(chatId,
        `⚠️ Request ${requestId}: ${result.message || 'no items could be applied.'}\n\n`
        + 'If this sale already went through (goods sold, papers done), Mark as done '
        + 'closes the request WITHOUT selling or charging anything again. If it '
        + 'duplicates another request, Reject it.', {
          reply_markup: { inline_keyboard: [
            [{ text: '✅ Mark as done (no re-run)', callback_data: `apz:done:${requestId}` }],
            [{ text: '❌ Reject', callback_data: `reject:${requestId}` }],
          ] },
        });
    } else {
      await bot.sendMessage(chatId, `⚠️ Approved but execution failed: ${result.message || 'Unknown error'}`);
      await notifyEmployee(bot, requestingUser, requestId, `⚠️ Your request (${requestId}) was approved but could not be completed. Admin has been notified. Please follow up.`);
    }
  } catch (e) {
    logger.error('Enrichment execution error', e);
    await bot.sendMessage(chatId, `⚠️ Error: ${e.message}`);
    await notifyEmployee(bot, requestingUser, requestId, `⚠️ Your request (${requestId}) encountered an error during processing. Admin has been notified. Please follow up.`);
  }
}

/**
 * Notify all admins (excluding the one who raised the request, if applicable)
 * that an approval is pending.
 *
 * @param {object} bot
 * @param {string} requestId
 * @param {string} userLabel
 * @param {string} actionSummary
 * @param {string} riskReason
 * @param {string} [excludeUserId]
 * @param {object} [opts]                  optional decoration
 * @param {string} [opts.previewPhoto]     Telegram file_id or HTTPS URL — shown above the approval message
 */
/**
 * Build a compact Stage-1 summary for a supply_request actionJSON.
 * Surfaces only what a Dispatch person needs to confirm feasibility:
 * warehouse, total Bales, # designs, customer, requested date.
 *
 * Full cart lines / payment / salesperson stay behind the "Show
 * details" button to keep the card scannable on small screens.
 */
function buildSupplyDispatchCompactSummary(aj) {
  const cart = Array.isArray(aj && aj.cart) ? aj.cart : [];
  const totalQty = cart.reduce((s, c) => s + (Number(c.quantity) || 0), 0);
  const distinctDesigns = new Set(cart.map((c) => c.design)).size;
  let s = `📦 *Supply Request — needs Dispatch confirmation*\n\n`;
  s += `🏭 Warehouse: *${(aj && aj.warehouse) || '-'}*\n`;
  s += `📦 Total: *${totalQty} bales* across *${distinctDesigns} design${distinctDesigns === 1 ? '' : 's'}*\n`;
  s += `👤 Customer: *${(aj && aj.customer) || '-'}*\n`;
  s += `📅 Date: *${fmtDate(aj && aj.salesDate)}*`;
  return s;
}

/**
 * Build a fully-expanded Stage-1 summary (cart lines + customer +
 * salesperson + payment + date). Used when the dispatch user taps
 * 🔍 Show details on the compact card.
 */
async function buildSupplyDispatchFullSummary(aj) {
  const productTypesRepo = require('../repositories/productTypesRepository');
  const labels = await productTypesRepo.getLabels((aj && aj.productType) || 'fabric');
  const cShort = labels.container_short;
  const cart = Array.isArray(aj && aj.cart) ? aj.cart : [];
  // SRF-UX: shades of one design fold into a single line.
  const cartLines = cartFormat.formatCartLines(cart.map((c) => {
    const m = productTypesRepo.getMaterialInfo(c.design);
    const shadeName = c.shadeName || '';
    return { icon: m.icon, design: c.design, name: m.name, shadeRef: shadeName ? `${c.shade} - ${shadeName}` : String(c.shade || ''), quantity: c.quantity };
  }), cShort).join('\n');
  const totalQty = cart.reduce((s, c) => s + (Number(c.quantity) || 0), 0);
  const containerPlural = productTypesRepo.pluralize(labels.container_label, totalQty).toLowerCase();
  let s = `📦 *Supply Request — full details*\n\n`;
  s += `🏭 Warehouse: *${(aj && aj.warehouse) || '-'}*\n`;
  s += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  s += `${cartLines}\n`;
  s += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  s += `📦 Total: *${totalQty} ${containerPlural}*\n`;
  s += `👤 Customer: *${(aj && aj.customer) || '-'}*\n`;
  // APU-2: customer phone/address so the approving admin can sanity-check
  // WHO is being supplied (parity with the classic sale card).
  try {
    const contact = await require('../services/approvalCards').customerContact((aj && aj.customer) || '');
    if (contact.phone) s += `📞 Phone: ${contact.phone}\n`;
    if (contact.address) s += `🏠 Address: ${contact.address}\n`;
  } catch (_) { /* best effort */ }
  s += `🧑 Salesperson: *${(aj && aj.salesperson) || '-'}*\n`;
  s += `💳 Payment: *${(aj && aj.paymentMode) || '-'}*\n`;
  s += `📅 Date: *${fmtDate(aj && aj.salesDate)}*`;
  if (aj && aj.sale_doc_file_id) s += `\n📎 Document attached`;
  return s;
}

/**
 * Stage 1 routing: send the dispatch confirmation card to every
 * active user who belongs to the Dispatch department, excluding the
 * requester. Self-heals by ensuring the Dispatch department row
 * exists. Returns:
 *   { routed: true, recipients: [...] }   if at least one was notified,
 *   { routed: false, reason: 'no_users' } if no Dispatch users exist
 *                                          (caller should fall back
 *                                          to admin Stage-2 directly).
 */
async function notifyDispatchManagers(bot, requestId, item, requesterUserId) {
  // Self-heal: ensure the Dispatch department row exists so admins
  // never need to hand-edit the Departments sheet.
  try {
    await departmentsRepository.ensureDept({ dept_name: 'Dispatch' });
  } catch (e) {
    logger.warn(`notifyDispatchManagers: ensureDept failed — ${e.message}`);
  }

  const dispatchUsers = await usersRepository.findByDepartment('Dispatch');
  const recipients = dispatchUsers.filter((u) => String(u.user_id) !== String(requesterUserId));
  if (!recipients.length) {
    logger.warn(`notifyDispatchManagers(${requestId}): no active Dispatch users found, falling back to admin stage`);
    return { routed: false, reason: 'no_users' };
  }

  const aj = (item && item.actionJSON) || {};
  const compact = buildSupplyDispatchCompactSummary(aj);
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔍 Show details', callback_data: `smc:d:${requestId}` }],
      [
        { text: '✅ Confirm', callback_data: `smc:c:${requestId}` },
        { text: '❌ Reject',  callback_data: `smc:r:${requestId}` },
      ],
    ],
  };

  const sent = [];
  for (const u of recipients) {
    try {
      await bot.sendMessage(u.user_id, compact, { parse_mode: 'Markdown', reply_markup: keyboard });
      sent.push(u);
    } catch (e) {
      logger.warn(`notifyDispatchManagers: failed to notify ${u.user_id} (${u.name || ''}) — ${e.message}`);
    }
  }
  return { routed: sent.length > 0, recipients: sent };
}

/**
 * Stage 1 actions — confirm / reject / show-details. Wired from the
 * controller's callback dispatcher (`smc:` prefix).
 */
async function handleDispatchManagerCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  // smc:<action>:<requestId>
  const m = data.match(/^smc:([cdr]):(.+)$/);
  if (!m) return;
  const verb = m[1];
  const requestId = m[2];
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  const row = await approvalQueueRepository.getByRequestId(requestId);
  if (!row) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Request no longer exists.' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
    return;
  }
  const aj = row.actionJSON || {};
  if (aj.action !== 'supply_request') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Not a supply request.' });
    return;
  }
  // Only active Dispatch users may act on this card. (Anyone else who
  // somehow taps the buttons gets a polite "not authorized" toast.)
  const acting = await usersRepository.findByUserId(userId);
  if (!acting || acting.status !== 'active' || !usersRepository.inDepartment(acting, 'Dispatch')) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only Dispatch members can act on this.' });
    return;
  }

  // Race protection: another dispatch member already confirmed or
  // rejected this request — this card is stale.
  if (aj.stage && aj.stage !== 'dispatch_review') {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: aj.confirmedByDispatch
        ? `Already confirmed by ${aj.confirmedByDispatch.name || 'another dispatch member'}.`
        : 'Already actioned.',
      show_alert: false,
    });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
    return;
  }

  if (verb === 'd') {
    // Show details — expand the card in place but keep the buttons.
    const full = await buildSupplyDispatchFullSummary(aj);
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Confirm', callback_data: `smc:c:${requestId}` },
          { text: '❌ Reject',  callback_data: `smc:r:${requestId}` },
        ],
      ],
    };
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageText(full, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => {});
    return;
  }

  if (verb === 'c') {
    // Confirm — record the confirmer, advance to Stage 2 (admin review),
    // notify the requester + the admins (excluding the requester if
    // they're an admin themselves) with the manager-confirmation note
    // prepended to the existing approval card.
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Confirming...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});

    const confirmedAt = new Date().toISOString();
    const confirmerName = acting.name || acting.user_id;
    await approvalQueueRepository.updateActionJSON(requestId, {
      stage: 'admin_review',
      confirmedByDispatch: { user_id: userId, name: confirmerName, ts: confirmedAt },
    });

    await bot.editMessageText(
      `✅ Confirmed.\n\nRequest \`${requestId}\` is now waiting for 2nd-admin approval.`,
      { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' },
    ).catch(() => {});

    // Notify creator
    await notifyEmployee(bot, row.user, requestId,
      `✅ *Dispatch confirmed* your supply request \`${requestId}\` (by ${confirmerName}). Waiting for 2nd-admin approval.`);

    // Notify admins with prepended confirmation note. Exclude the
    // requester if they're an admin themselves (mirrors the original
    // requester-excluded broadcast).
    const requesterIsAdmin = config.access.adminIds.includes(String(row.user));
    const excludeId = requesterIsAdmin ? row.user : undefined;
    const userLabel = await getRequesterDisplayName(row.user);
    const summary = await buildSupplyDispatchFullSummary(aj);
    // TIME-1 — toLocaleString with no timeZone renders the SERVER's clock
    // (Railway = UTC), so this note was an hour behind Lagos on every card.
    const fmtTime = (() => {
      try { return require('../utils/formatDate').withTime(confirmedAt); } catch { return confirmedAt; }
    })();
    await notifyAdminsApprovalRequest(
      bot, requestId, userLabel, summary, row.riskReason || 'Supply request requires admin approval',
      excludeId,
      { prependNote: `✅ Confirmed by Dispatch: ${confirmerName} on ${fmtTime}` },
    );

    // Forward attached bill (if any) to admins. Skipped at Stage 1
    // because dispatch members don't need to see it.
    if (aj.sale_doc_file_id) {
      for (const adminId of config.access.adminIds) {
        if (excludeId && String(adminId) === String(excludeId)) continue;
        try {
          if (aj.sale_doc_type === 'photo') {
            await bot.sendPhoto(adminId, aj.sale_doc_file_id, { caption: `📎 Bill for ${requestId}` });
          } else {
            await bot.sendDocument(adminId, aj.sale_doc_file_id, { caption: `📎 Bill for ${requestId}` });
          }
        } catch (_) {}
      }
    }
    return;
  }

  if (verb === 'r') {
    // Reject — prompt for a brief reason via free-text. The next
    // message from this user lands in handleDispatchReasonReply (in
    // approvalEvents) which finalizes the rejection.
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
    const othersQueued = armReasonPrompt(userId, { kind: 'manager_reject', requestId, chatId });
    await bot.sendMessage(chatId,
      `❌ *Reject supply request* \`${requestId}\`\n\nReply with a brief reason (or type *cancel* to abort).`
      + (othersQueued ? `\n\n_(${othersQueued} other reason${othersQueued === 1 ? '' : 's'} still pending — asked next.)_` : ''),
      { parse_mode: 'Markdown' });
    return;
  }
}

/**
 * Helper for buildSupplyDispatchFullSummary's prepend caller.
 * Resolves a label for the requester (name + dept) so the admin card
 * reads like "Yarima (Sales)" instead of a bare numeric ID.
 */
async function getRequesterDisplayName(userId) {
  try {
    const u = await usersRepository.findByUserId(userId);
    if (!u) return String(userId);
    const depts = (u.departments && u.departments.length) ? u.departments.join(', ') : (u.department || '');
    return depts ? `${u.name || u.user_id} (${depts})` : (u.name || u.user_id);
  } catch (_) {
    return String(userId);
  }
}

/**
 * Handle the free-text reply that follows a Stage-1 rejection or a
 * Stage-3 decline. Returns true if the message was consumed (so the
 * caller can early-return from its text handler), false otherwise.
 */
async function handleReasonReply(bot, msg) {
  const userId = String(msg.from.id);
  // APC-1 Phase B — answer the NEWEST prompt (the card the user just
  // tapped), then re-prompt for each remaining one. Nothing is dropped.
  const queue = pendingReason.get(userId);
  const state = Array.isArray(queue) ? queue[0] : queue; // array since APC-1
  if (!state) return false;
  const dropHead = () => {
    const q = (pendingReason.get(userId) || []).slice(Array.isArray(queue) ? 1 : 0);
    if (Array.isArray(queue) && q.length) pendingReason.set(userId, q);
    else pendingReason.delete(userId);
    return q.length;
  };

  const text = (msg.text || '').trim();
  if (!text) {
    await bot.sendMessage(state.chatId, 'Please type a reason or *cancel*.', { parse_mode: 'Markdown' });
    return true;
  }
  if (text.toLowerCase() === 'cancel') {
    const remaining = dropHead();
    await bot.sendMessage(state.chatId, 'Cancelled. The request stays as it was.');
    if (remaining) await promptNextReason(bot, userId);
    return true;
  }
  const reason = text.slice(0, 200);
  const remaining = dropHead();
  // Every exit of the finalize below re-prompts for the next owed reason.
  const done = async () => { if (remaining) await promptNextReason(bot, userId); return true; };

  const row = await approvalQueueRepository.getByRequestId(state.requestId);
  if (!row) {
    await bot.sendMessage(state.chatId, `⚠️ Request \`${state.requestId}\` no longer exists.`, { parse_mode: 'Markdown' });
    return done();
  }

  const acting = await usersRepository.findByUserId(userId);
  const actorName = (acting && acting.name) || userId;
  const ts = new Date().toISOString();

  if (state.kind === 'manager_reject') {
    // Stage-1 rejection — finalize. Admins were never involved at
    // this stage, so no admin notification is needed.
    await approvalQueueRepository.updateActionJSON(state.requestId, {
      stage: 'rejected_by_dispatch',
      dispatchRejection: { user_id: userId, name: actorName, ts, reason },
    });
    await approvalQueueRepository.updateStatus(state.requestId, 'rejected', ts);

    await bot.sendMessage(state.chatId,
      `❌ Rejected. Request \`${state.requestId}\` will not proceed.\n\nReason recorded: _${reason}_`,
      { parse_mode: 'Markdown' });

    await notifyEmployee(bot, row.user, state.requestId,
      `❌ *Dispatch rejected* your supply request \`${state.requestId}\`.\n\nReason: _${reason}_\n\nReason given by: ${actorName}\n\nYou can edit and resubmit if you want to retry.`);
    return done();
  }

  if (state.kind === 'dispatch_decline') {
    // Stage-3 decline — bounce back to the 2nd admin's picker so
    // they can pick a different dispatch person.
    const aj = row.actionJSON || {};
    await approvalQueueRepository.updateActionJSON(state.requestId, {
      stage: 'admin_repick',
      dispatchDecline: { user_id: userId, name: actorName, ts, reason },
    });

    await bot.sendMessage(state.chatId,
      `❌ Declined. Admin will be asked to assign someone else.\n\nReason recorded: _${reason}_`,
      { parse_mode: 'Markdown' });

    // Notify the creator (informational).
    await notifyEmployee(bot, row.user, state.requestId,
      `⚠️ *${actorName} declined* the dispatch assignment for \`${state.requestId}\`.\n\nReason: _${reason}_\n\nAdmin will reassign shortly.`);

    // Re-show warehouse boy picker to all admins (or the original
    // approver if recorded). For simplicity broadcast to all admins.
    const approvedBy = aj.approvedByAdmin && aj.approvedByAdmin.user_id;
    const targets = approvedBy ? [approvedBy] : (config.access.adminIds || []);
    for (const adminId of targets) {
      try {
        await bot.sendMessage(adminId,
          `⚠️ Dispatch decline on \`${state.requestId}\` — please reassign.\n\nDeclined by: *${actorName}*\nReason: _${reason}_`,
          { parse_mode: 'Markdown' });
        await showWarehouseBoyPicker(bot, adminId, state.requestId, row, row.user);
      } catch (e) {
        logger.warn(`re-show picker failed for admin ${adminId}: ${e.message}`);
      }
    }
    return done();
  }

  return done();
}

async function notifyAdminsApprovalRequest(bot, requestId, userLabel, actionSummary, riskReason, excludeUserId, opts = {}) {
  const esc = (s) => (s || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  // Optional prepended note (used by Stage 2 of the supply-request flow
  // to surface "✅ Confirmed by Dispatch: <name> on <time>" at the top
  // of the admin card so reviewers see upstream provenance at a glance).
  const noteLine = opts && opts.prependNote ? `${esc(opts.prependNote)}\n\n` : '';
  // CARD-3 (owner 10-Aug-2026) — the boilerplate half of the reason repeats
  // the header and names the approver's role, which is no longer always an
  // admin. Only facts about THIS request survive; the rest reads "Sent for
  // approval". Real reasons (backdated, threshold) are untouched.
  const shortWhy = require('../services/approvalCards').shortReason(riskReason);
  const text = `${noteLine}🔔 *Approval required*\n\nRef: \`${requestId}\`\nFrom: ${esc(userLabel)}\n\n${esc(actionSummary)}\n\n_${esc(shortWhy)}_\n\nUse buttons below to approve or reject\\.`;
  // CNET-2 — a caller may hand the card a routing keyboard (the add-contact
  // destination chips); everything else keeps the standard pair.
  const keyboard = (opts && opts.keyboard) || {
    inline_keyboard: [
      [{ text: '✅ Approve', callback_data: `approve:${requestId}` }, { text: '❌ Reject', callback_data: `reject:${requestId}` }],
    ],
  };
  // APU-1: report delivery so callers can tell the requester when a queued
  // request reached NO admin at all (queue-without-notify was silent before).
  let sent = 0;
  let failed = 0;
  for (const adminId of config.access.adminIds) {
    if (excludeUserId && String(adminId) === String(excludeUserId)) continue;
    // Best-effort photo preview (e.g. for design_asset_upload). Never blocks the text notification.
    if (opts && opts.previewPhoto) {
      try {
        await bot.sendPhoto(adminId, opts.previewPhoto, {
          caption: opts.previewCaption || `📷 Preview for request \`${requestId}\``,
          parse_mode: 'Markdown',
        });
      } catch (e) {
        logger.warn(`Failed to send preview photo to admin ${adminId} for ${requestId}`, e.message);
      }
    }
    try {
      await bot.sendMessage(adminId, text, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
      sent += 1;
    } catch (e) {
      logger.error('Failed to notify admin', adminId, e.message);
      try {
        const plain = `🔔 Approval required\n\nRef: ${requestId}\nFrom: ${userLabel}\n\n${actionSummary}\n\n${shortWhy}\n\nUse buttons below to approve or reject.`;
        await bot.sendMessage(adminId, plain, { reply_markup: keyboard });
        sent += 1;
      } catch (e2) {
        failed += 1;
        logger.error('Failed to notify admin (plain fallback)', adminId, e2.message);
      }
    }
  }
  // VRF-1 (owner 22-Jul) — fire-and-forget bill-vs-request check for
  // documented sales: the card above is never delayed by OCR; the 🔬
  // verdict follows as its own message. The service itself filters to
  // sale actions with an attached doc and skips snap-sourced requests.
  try {
    const notified = config.access.adminIds.filter((a) => !(excludeUserId && String(a) === String(excludeUserId)));
    const verifyP = require('../services/saleDocVerifyService')
      .maybeVerify(bot, requestId, { adminIds: notified });
    if (opts && opts.awaitVerify) await verifyP;
  } catch (e) { logger.warn(`saleDocVerify launch ${requestId}: ${e.message}`); }
  return { sent, failed };
}

async function handleApprovalCallback(bot, callbackQuery, action) {
  const data = callbackQuery.data || '';
  const requestId = data.replace(/^(approve|reject):/, '');
  const adminId = String(callbackQuery.from.id);
  if (!config.access.adminIds.includes(adminId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only admins can approve.' });
    return;
  }

  const { item, requestingUser } = await resolveRequest(requestId);

  // APF-1 (owner report, 08-Aug-2026): a request that is no longer pending
  // is DEAD on every card, everywhere. Before this guard a stale tap passed
  // every gate — a resolved SALE even walked the admin through the whole
  // customer/rate/payment wizard before dead-ending, a stale DUAL-1 tap
  // recorded a phantom signoff, and the eventual refusal read like an error
  // ("Approved but execution failed") instead of the truth. Old DM cards
  // and re-sent reminder cards keep live buttons forever, so this is the
  // one choke point that makes them all harmless.
  if (item && String(item.status || '').toLowerCase() !== 'pending') {
    const st = String(item.status || 'resolved').toLowerCase();
    try { await bot.answerCallbackQuery(callbackQuery.id, { text: `Already ${st} — nothing to do.` }); } catch (_) { /* ignore */ }
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] },
        { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    } catch (_) { /* stale card */ }
    try {
      const when = item.resolvedAt ? ` on ${fmtDate(item.resolvedAt)}` : '';  // TIME-1
      await bot.sendMessage(callbackQuery.message.chat.id,
        `ℹ️ Request ${requestId} was already ${st}${when} — no change made.`);
    } catch (_) { /* ignore */ }
    return;
  }

  // SEC-P1 (H1): an admin may not approve their OWN queued request when a
  // second admin exists to review it. Excluding the requester from the
  // approval NOTIFICATION (requireApproval's excludeId) was cosmetic — the
  // requester still knows the requestId and could forge `approve:<id>`,
  // defeating the dual-admin gate on sales, price changes, add_user, etc.
  // If the requester is the ONLY admin in the system, self-approval is
  // allowed (otherwise nothing they raise could ever clear). Never blocks
  // on its own failure.
  if (item && String(item.user) === adminId) {
    // SEC: decide FIRST, then act. The refusal toast used to sit inside this
    // try, so a transient Telegram failure while showing "you cannot approve
    // your own request" was swallowed by the catch and execution fell through
    // — approving the request anyway. The refusal now returns from OUTSIDE the
    // guard's try, so a failed toast can never unlock a self-approval.
    let anotherAdminExists = false;
    try {
      const authMod = require('../middlewares/auth');
      const envAdmins = config.access.adminIds.map(String);
      let sheetAdmins = [];
      try { sheetAdmins = (authMod._internals.snapshotAdmins() || []).map(String); } catch { /* cache not ready */ }
      const allAdmins = new Set([...envAdmins, ...sheetAdmins]);
      anotherAdminExists = [...allAdmins].some((id) => id !== adminId);
    } catch (e) {
      // Deliberately non-blocking (sole-admin deployments must still work),
      // but never silent — this is a security guard degrading.
      logger.warn(`self-approval guard could not enumerate admins: ${e.message}`);
    }
    if (anotherAdminExists) {
      try {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: '🔒 You cannot approve your own request — a second admin must review it.',
          show_alert: true,
        });
      } catch (e) { logger.warn(`self-approval refusal toast failed: ${e.message}`); }
      return;
    }
  }

  // USR-C3b — restricted approvals: actions in SUPER_ADMIN_APPROVAL_ACTIONS
  // (e.g. promote_admin) require the APPROVER to be in SUPER_ADMIN_IDS.
  // We surface the gate as an alert so the admin understands why their
  // tap was refused — they aren't powerless, the right person just needs
  // to act. The card remains live (we did NOT clear its buttons yet).
  // Same shape as the self-approval guard above: decide inside the try,
  // refuse from outside it, so a failed alert cannot let a restricted action
  // (e.g. promote_admin) through on a non-super-admin's tap.
  let needsSuperAdmin = false;
  try {
    const riskMod = require('../risk/evaluate');
    const auth = require('../middlewares/auth');
    const restricted = Array.isArray(riskMod.SUPER_ADMIN_APPROVAL_ACTIONS)
      ? riskMod.SUPER_ADMIN_APPROVAL_ACTIONS : [];
    const actName = item && item.actionJSON && item.actionJSON.action;
    needsSuperAdmin = !!actName && restricted.includes(actName) && !auth.isSuperAdmin(adminId);
  } catch (e) {
    logger.warn(`super-admin guard could not evaluate the action: ${e.message}`);
  }
  if (needsSuperAdmin) {
    try {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: '🔒 Super-admin only — this action requires SUPER_ADMIN approval.',
        show_alert: true,
      });
    } catch (e) { logger.warn(`super-admin refusal alert failed: ${e.message}`); }
    return;
  }

  // DUAL-1 (specs/DUAL-1_TWO_ADMIN_APPROVAL.md) — inventory + finance
  // actions must involve TWO admins before execution. An admin requester
  // counts as the first (the H1 guard above already forces a different
  // admin to tap), so employee requests need two distinct signoffs: the
  // first tap is recorded in ActionJSON.approvals and the request stays
  // pending until a second admin taps their own copy of the card.
  // Rejection stays single-admin at any stage (fail-closed bias).
  if (action === 'approve') {
    try {
      const riskMod = require('../risk/evaluate');
      const actName = item && item.actionJSON && item.actionJSON.action;
      if (actName && riskMod.DUAL_ADMIN_ACTIONS.includes(actName)) {
        const prior = Array.isArray(item.actionJSON.approvals)
          ? item.actionJSON.approvals.map(String) : [];
        if (prior.includes(adminId)) {
          // Ack is best-effort (stale queries throw) — the refusal must
          // hold either way.
          try {
            await bot.answerCallbackQuery(callbackQuery.id, {
              text: '🔏 You already gave the first approval — a different admin must give the second.',
              show_alert: true,
            });
          } catch (_) { /* stale query */ }
          return;
        }
        const authMod = require('../middlewares/auth');
        const requesterIsAdmin = authMod.isAdmin(String(item.user));
        // Distinct admins able to approve (env + sheet cache, minus an
        // admin requester). Lets requiredAdminApprovals degrade a 1-admin
        // deployment instead of deadlocking it — same tradeoff as the
        // update_price "Only 1 admin configured — auto-approved" path.
        let adminCount = 2;
        try {
          const envAdmins = config.access.adminIds.map(String);
          let sheetAdmins = [];
          try { sheetAdmins = (authMod._internals.snapshotAdmins() || []).map(String); } catch { /* cache not ready */ }
          const pool = new Set([...envAdmins, ...sheetAdmins]);
          if (requesterIsAdmin) pool.delete(String(item.user));
          adminCount = pool.size;
        } catch { /* keep default 2 — fail strict, not open */ }
        const required = riskMod.requiredAdminApprovals({
          action: actName, requesterIsAdmin, adminCount,
        });
        if (prior.length + 1 < required) {
          await approvalQueueRepository.updateActionJSON(requestId, {
            approvals: [...prior, adminId],
          });
          try {
            const auditLogRepository = require('../repositories/auditLogRepository');
            await auditLogRepository.append('approval_first_signoff',
              { requestId, action: actName, signedBy: adminId }, adminId);
          } catch (e) { logger.warn(`DUAL-1 first-signoff audit failed: ${e.message}`); }
          usageTracker.track({ userId: adminId, surface: 'approval', feature: actName, event: 'approval_signed', requestId });
          // From here on the signoff IS recorded (updateActionJSON above):
          // every messaging step is best-effort — a stale ack or failed DM
          // must never fall through to the execute path with one signoff.
          try { await bot.answerCallbackQuery(callbackQuery.id, { text: `🔏 Approval 1 of ${required} recorded.` }); } catch (_) { /* stale query */ }
          // Freeze THIS admin's card; other admins' cards stay live so one
          // of them can give the second signoff.
          try {
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
              chat_id: callbackQuery.message.chat.id,
              message_id: callbackQuery.message.message_id,
            });
          } catch (_) { /* stale card; not fatal */ }
          try {
            await bot.sendMessage(callbackQuery.message.chat.id,
              `🔏 Request ${requestId}: your approval is recorded (1 of ${required}). Waiting for a second admin.`);
          } catch (_) { /* chat unreachable */ }
          try {
            await notifyEmployee(bot, requestingUser, requestId,
              `🔏 Your request (${requestId}) has 1 of ${required} admin approvals. One more to go.`);
          } catch (_) { /* best-effort */ }
          // Ping the remaining env admins so the request doesn't stall
          // silently (sheet-cache admins still have live cards; best-effort).
          const others = config.access.adminIds
            .map(String)
            .filter((id) => id !== adminId && id !== String(item.user));
          for (const otherId of others) {
            try {
              await bot.sendMessage(otherId,
                `🔔 Request ${requestId} (${require('../services/approvalCards').actionLabel(actName)}) has its first admin approval and needs a SECOND. Use the approval card in your chat.`);
            } catch (e) { logger.warn(`DUAL-1 second-signoff ping failed for ${otherId}: ${e.message}`); }
          }
          return;
        }
      }
    } catch (e) {
      // House style for approval guards: log loudly, fall through to
      // single-approval semantics rather than blocking ALL approvals on a
      // gate bug (matches the H1 / super-admin guards above).
      logger.error(`DUAL-1 dual-approval gate error (falling back to single approval): ${e.message}`);
    }
  }

  const chatIdCb = callbackQuery.message.chat.id;
  const msgIdCb = callbackQuery.message.message_id;

  // ANL-1 — time-to-decision KPI: queue row createdAt → this tap.
  const _decisionMs = item && item.createdAt ? Date.now() - Date.parse(item.createdAt) : undefined;
  const _actFeature = (item && item.actionJSON && item.actionJSON.action) || 'unknown';

  try {
    if (action === 'approve') {
      // Stale-ack hardening (live 14-Jul): when the bot was redeploying at
      // tap time, Telegram redelivers the update later and the callback id
      // has expired — answerCallbackQuery throws "query is too old". The
      // tap is still a valid admin decision: cosmetic ack/edit failures
      // must NEVER abort the approval.
      try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Approving...' }); } catch (_) { /* stale query */ }
      try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatIdCb, message_id: msgIdCb }); } catch (_) { /* stale card */ }
      usageTracker.track({ userId: adminId, surface: 'approval', feature: _actFeature, event: 'approval_approved', requestId, durationMs: _decisionMs });

      const isNewCustomer = item && item.actionJSON && item.actionJSON.action === 'new_customer';
      if (isNewCustomer) {
        await handleNewCustomerApproval(bot, chatIdCb, requestId, item, requestingUser, true);
        return;
      }

      const isSupplyReq = item && item.actionJSON && item.actionJSON.action === 'supply_request';
      if (isSupplyReq) {
        await showWarehouseBoyPicker(bot, chatIdCb, requestId, item, requestingUser);
        return;
      }

      const isSale = item && item.actionJSON && SALE_ACTIONS.includes(item.actionJSON.action);
      if (isSale) {
        // APF-2 (owner, 08-Aug-2026): when the request's stock is ALREADY
        // gone, walking the admin through the customer/rate/payment wizard
        // is nonsense — it can only dead-end at the all-items-failed
        // refusal. Offer the two real choices up front instead. Best-effort:
        // an Inventory read failure falls through to the normal wizard,
        // whose executor still refuses safely.
        try {
          const { allItemsGone } = require('../services/saleStockCheck');
          const inventoryRepository = require('../repositories/inventoryRepository');
          if (allItemsGone(item.actionJSON, await inventoryRepository.getAll())) {
            await bot.sendMessage(chatIdCb,
              `⚠️ Request ${requestId}: every bale/than in it is already sold or gone — there is nothing to sell.\n\n`
              + 'If this sale already went through (goods sold, papers done), Mark as done '
              + 'closes the request WITHOUT selling or charging anything again. If it '
              + 'duplicates another request, Reject it.', {
                reply_markup: { inline_keyboard: [
                  [{ text: '✅ Mark as done (no re-run)', callback_data: `apz:done:${requestId}` }],
                  [{ text: '❌ Reject', callback_data: `reject:${requestId}` }],
                ] },
              });
            return;
          }
        } catch (e) {
          logger.warn(`APF-2 stock-gone pre-check failed for ${requestId}: ${e.message}`);
        }
        // APC-1 — the tapped card (keyboard already wiped above) becomes the
        // wizard's anchor: every step edits it in place.
        await startApprovalEnrichment(bot, adminId, chatIdCb, requestId, item, requestingUser, msgIdCb);
        return;
      }

      const result = await inventoryService.executeApprovedAction(requestId, adminId);
      if (result.ok) {
        // H6 — surface "applied but books failed" instead of a clean ✅.
        const erpFails = Array.isArray(result.erpFailures) ? result.erpFailures : [];
        let approvedMsg = `✅ Request ${requestId} approved. Changes applied.`;
        if (erpFails.length) {
          const failLines = erpFails.map((f) => `  • ${f.stage}: ${f.error}`).join('\n');
          approvedMsg = `⚠️ Request ${requestId} approved — changes applied, but these ledger/book entries FAILED:\n${failLines}\nCheck AuditLog (erp_hook_failed) and re-post manually.`;
        }
        await bot.sendMessage(chatIdCb, approvedMsg);
        await notifyEmployee(bot, requestingUser, requestId, `✅ Your request ${shortRequestRef(requestId)} has been approved by admin. Changes applied.`);

        // CAT-C1 — a container landed with designs lacking fresh catalogue
        // photos (shades differ per shipment): ONE checklist card to every
        // env admin (specs/CAT-C1_CONTAINER_PHOTOS.md, owner decision #2).
        const photoChk = result.bundleReport && result.bundleReport.photoChecklist;
        if (photoChk && Array.isArray(photoChk.missingDesigns) && photoChk.missingDesigns.length) {
          const shown = photoChk.missingDesigns.slice(0, 20).join(', ')
            + (photoChk.missingDesigns.length > 20 ? ` …+${photoChk.missingDesigns.length - 20} more` : '');
          const chkTxt = `📸 New container *${photoChk.batch}* landed — ${photoChk.missingDesigns.length} design(s) need a FRESH catalogue photo:\n${shown}\n\n_Upload via 🖼 Upload Design Photo → design → pick ${photoChk.batch}. Shades can differ per shipment, so old photos are not shown for this container._`;
          for (const admId of config.access.adminIds) {
            try { await bot.sendMessage(admId, chkTxt, { parse_mode: 'Markdown' }); }
            catch (e) { logger.warn(`CAT-C1 checklist DM failed for ${admId}: ${e.message}`); }
          }
        }

        // USR-C3 — welcome DM to the new user (best-effort; fails silently
        // if they haven't /start-ed the bot, which is the expected case
        // for admin-initiated add without prefill).
        const isAddUser = item && item.actionJSON && item.actionJSON.action === 'add_user';
        if (isAddUser) {
          const aj = item.actionJSON;
          try {
            await bot.sendMessage(aj.telegram_id,
              `👋 *Welcome to AtFactoryPrice!*\n\nYou've been added as *${aj.name}* in the *${aj.department}* department.\nRole: ${aj.role}\n\nSend /menu to see what you can do.`,
              { parse_mode: 'Markdown' });
          } catch (e) {
            logger.info(`add_user welcome DM skipped for ${aj.telegram_id} (likely no /start yet): ${e.message}`);
          }
        }

        // For design_asset_upload, send the now-active photo to the
        // approving admin as a confirmation. This warms up the Telegram
        // file_id cache (first send produces a Buffer→Telegram upload;
        // the captured file_id is cached on the asset row, so every
        // subsequent consumer access is instant).
        const isDesignAsset = item && item.actionJSON && item.actionJSON.action === 'design_asset_upload';
        if (isDesignAsset) {
          try {
            const designAssetsService = require('../services/designAssetsService');
            const aj = item.actionJSON;
            const lines = (aj.shades && aj.shades.length)
              ? aj.shades.map((s) => `${s.number}. ${s.name}`).join(' • ')
              : (aj.shadeNames || []).map((n, i) => `${i + 1}. ${n}`).join(' • ');
            const ok = await designAssetsService.sendDesignPhoto({
              bot, chatId: chatIdCb, design: aj.design,
              caption: `✅ *${aj.design}* — photo activated\n${lines}\n\nNow visible in Supply Request, Sample, Order, Update Price, and Stock pickers.`,
            });
            if (!ok) logger.warn(`approval design_asset_upload: post-approval photo send failed for ${aj.design}`);
          } catch (e) {
            logger.warn('post-approval design_asset send failed', e.message);
          }
        }

        // PAY-1 — an approved payment is not a paid payment. Hand it to
        // the ONE finance id (owner's business rule) as an actionable
        // card; the money leaves only when a human transfers it at the
        // bank and taps Mark Done. Fire-and-forget: a delivery failure
        // must never roll back an approval that already happened.
        if (item && item.actionJSON && item.actionJSON.action === 'request_payment') {
          try {
            const paymentCards = require('../services/paymentCards');
            await paymentCards.sendFinanceCard(bot, item.actionJSON.payment_id);
          } catch (e) {
            logger.warn(`PAY-1 finance card dispatch failed for ${requestId}: ${e.message}`);
          }
        }

        const customer = item && item.actionJSON && (item.actionJSON.customer || item.actionJSON.customerName);
        if (customer) {
          try {
            const accountingService = require('../services/accountingService');
            const { outstandingAsOfToday } = await accountingService.getCustomerLedger(customer);
            const fmt = (n) => `${config.currency || 'NGN'} ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`;
            await bot.sendMessage(chatIdCb, `📒 *${customer}* — Outstanding as of today: ${fmt(outstandingAsOfToday)}`);
          } catch (_) {}
        }
      } else {
        await bot.sendMessage(chatIdCb, `⚠️ Approved but execution failed: ${result.message || 'Unknown error'}`);
        await notifyEmployee(bot, requestingUser, requestId, `⚠️ Your request (${requestId}) was approved but could not be completed. Admin has been notified. Please follow up.`);
      }
    } else {
      // Same stale-ack hardening as the approve branch above.
      try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Rejecting...' }); } catch (_) { /* stale query */ }
      try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatIdCb, message_id: msgIdCb }); } catch (_) { /* stale card */ }
      usageTracker.track({ userId: adminId, surface: 'approval', feature: _actFeature, event: 'approval_rejected', requestId, durationMs: _decisionMs });

      const isNewCustReject = item && item.actionJSON && item.actionJSON.action === 'new_customer';
      if (isNewCustReject) {
        await handleNewCustomerApproval(bot, chatIdCb, requestId, item, requestingUser, false);
        return;
      }

      const result = await inventoryService.rejectApproval(requestId, adminId);
      if (result.ok) {
        await bot.sendMessage(chatIdCb, `❌ Request ${requestId} rejected.`);
        await notifyEmployee(bot, requestingUser, requestId, `❌ Your request ${shortRequestRef(requestId)} has been rejected by admin.`);
      } else {
        await bot.sendMessage(chatIdCb, `⚠️ Rejection failed: ${result.message || 'Unknown error'}`);
      }
    }
  } catch (e) {
    logger.error('Approval callback error', e);
    try { await bot.sendMessage(chatIdCb, `⚠️ Error processing request ${requestId}: ${e.message}`); } catch (_) {}
    await notifyEmployee(bot, requestingUser, requestId, `⚠️ Your request (${requestId}) encountered an error during processing. Admin has been notified. Please follow up.`);
  }
}

async function showWarehouseBoyPicker(bot, chatId, requestId, item, requestingUser) {
  const aj = item?.actionJSON || {};
  const warehouse = aj.warehouse || '';
  const allUsers = await usersRepository.getAll();
  const dispatchUsers = allUsers.filter((u) => {
    if (u.status && u.status !== 'active') return false;
    const inDispatch = usersRepository.inDepartment(u, 'Dispatch')
      || usersRepository.inDepartment(u, 'Warehouse')
      || usersRepository.inDepartment(u, 'Logistics');
    if (!inDispatch) return false;
    const whs = u.warehouses || [];
    return !warehouse || whs.includes(warehouse);
  });

  const productTypesRepo = require('../repositories/productTypesRepository');
  const labels = await productTypesRepo.getLabels(aj.productType || 'fabric');
  const cShort = labels.container_short;
  // SRF-UX: shades of one design fold into a single line.
  const cartLines = cartFormat.formatCartLines((aj.cart || []).map((ci) => {
    const m = productTypesRepo.getMaterialInfo(ci.design);
    return { icon: m.icon, design: ci.design, name: m.name, shadeRef: String(ci.shade), quantity: ci.quantity };
  }), cShort).join('\n');
  const totalQty = (aj.cart || []).reduce((s, c) => s + c.quantity, 0);
  const containerPlural = productTypesRepo.pluralize(labels.container_label, totalQty).toLowerCase();
  let summary = `✅ Supply request approved.\n\n`;
  summary += `🏭 Warehouse: ${warehouse}\n`;
  summary += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  summary += `${cartLines}\n`;
  summary += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  summary += `📦 Total: ${totalQty} ${containerPlural}\n`;
  summary += `👤 Customer: ${aj.customer || '-'}\n`;
  summary += `📅 Date: ${fmtDate(aj.salesDate)}\n\n`;
  summary += `Assign to a warehouse boy:`;

  if (!dispatchUsers.length) {
    const allWithWh = allUsers.filter((u) => (u.warehouses || []).includes(warehouse));
    const fallback = allWithWh.length ? allWithWh : allUsers;
    const rows = fallback.map((u) => [{
      text: `🧑 ${u.name || u.user_id}`,
      callback_data: `srf_assign:${requestId}|${u.user_id}`,
    }]);
    await bot.sendMessage(chatId, summary, { reply_markup: { inline_keyboard: rows } });
    return;
  }

  const rows = dispatchUsers.map((u) => [{
    text: `🧑 ${u.name || u.user_id}`,
    callback_data: `srf_assign:${requestId}|${u.user_id}`,
  }]);
  await bot.sendMessage(chatId, summary, { reply_markup: { inline_keyboard: rows } });
}

async function handleSupplyAssign(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  const [requestId, assigneeId] = data.replace('srf_assign:', '').split('|');
  const adminId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;

  if (!config.access.adminIds.includes(adminId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin only.' });
    return;
  }
  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Assigning...' });
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

  const { item, requestingUser } = await resolveRequest(requestId);
  if (!item) {
    await bot.sendMessage(chatId, `⚠️ Request ${requestId} not found.`);
    return;
  }
  // APC-1 Phase D — a stale picker card must not re-assign a request that
  // already resolved (or was never a supply request): the tap used to pass
  // with NO status/action guard, stamping stage/assignee onto settled rows.
  const ajCur = item.actionJSON || {};
  if (ajCur.action !== 'supply_request' || String(item.status || '').toLowerCase() !== 'pending') {
    await bot.sendMessage(chatId,
      `ℹ️ Request ${requestId} is ${String(item.status || 'resolved').toLowerCase()} — this picker card is stale, no assignment was made.`);
    return;
  }

  // Stage 3 change: keep the queue row in `pending` until the
  // dispatch person Accepts. The admin's pick now records the
  // assignment + admin identity on actionJSON; final status flips
  // happen in handleSupplyAccept (or the request bounces on Decline).
  const assignTs = new Date().toISOString();
  const assigneeUser = await usersRepository.findByUserId(assigneeId);
  await approvalQueueRepository.updateActionJSON(requestId, {
    stage: 'dispatch_acceptance',
    assignedDispatch: { user_id: assigneeId, name: (assigneeUser && assigneeUser.name) || assigneeId, ts: assignTs },
    approvedByAdmin: { user_id: adminId, ts: assignTs },
  });

  const aj = item.actionJSON || {};
  const productTypesRepo = require('../repositories/productTypesRepository');
  const labels = await productTypesRepo.getLabels(aj.productType || 'fabric');
  const cShort = labels.container_short;
  // SRF-UX: shades of one design fold into a single line.
  const cartLines = cartFormat.formatCartLines((aj.cart || []).map((ci) => {
    const m = productTypesRepo.getMaterialInfo(ci.design);
    return { icon: m.icon, design: ci.design, name: m.name, shadeRef: String(ci.shade), quantity: ci.quantity };
  }), cShort).join('\n');
  const totalQty = (aj.cart || []).reduce((s, c) => s + c.quantity, 0);
  const containerPlural = productTypesRepo.pluralize(labels.container_label, totalQty).toLowerCase();
  let intimation = `📦 *New Supply Assignment*\n\n`;
  intimation += `🏭 Warehouse: *${aj.warehouse || '-'}*\n`;
  intimation += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  intimation += `${cartLines}\n`;
  intimation += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  intimation += `📦 Total: *${totalQty} ${containerPlural}*\n\n`;
  intimation += `👤 Customer: *${aj.customer || '-'}*\n`;
  intimation += `🧑 Salesperson: *${aj.salesperson || '-'}*\n`;
  intimation += `💳 Payment: *${aj.paymentMode || '-'}*\n`;
  intimation += `📅 Date: *${fmtDate(aj.salesDate)}*\n`;
  intimation += `\n🔔 Assigned by admin. Please *Accept* (you'll prep the stock) or *Decline* (admin will reassign).`;

  try {
    await bot.sendMessage(assigneeId, intimation, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [
          { text: '✅ Accept',  callback_data: `srf_acc:${requestId}` },
          { text: '❌ Decline', callback_data: `srf_dec:${requestId}` },
        ],
      ] },
    });
  } catch (e) {
    logger.error(`Failed to notify dispatch person ${assigneeId}`, e.message);
    await bot.sendMessage(chatId, `⚠️ Could not send message to user ${assigneeId}. They may need to start the bot first.`);
    return;
  }

  const assigneeName = (assigneeUser && assigneeUser.name) || assigneeId;
  await bot.sendMessage(chatId, `✅ Supply request \`${requestId}\` assigned to *${assigneeName}*.\n\n⏳ Waiting for them to *Accept* before stock leaves the warehouse.`, { parse_mode: 'Markdown' });
  await notifyEmployee(bot, requestingUser, requestId,
    `✅ Your supply request \`${requestId}\` was approved and assigned to *${assigneeName}*.\n\n⏳ Waiting for ${assigneeName} to *Accept* the dispatch.`);
}

async function handleNewCustomerApproval(bot, chatId, requestId, item, requestingUser, approved) {
  const aj = item.actionJSON || {};
  const custName = aj.customer_name || 'Unknown';
  const custId = aj.customer_id;
  const requesterUserId = aj.requesterUserId || requestingUser;

  // APU-1 (adversarial review): decisions are final. Without this guard a
  // stale card's reject tap flipped an already-approved (Active, possibly
  // already-sold-to) customer to Rejected — and a stale approve un-rejected
  // a rejected one.
  if (String(item.status || '').toLowerCase() !== 'pending') {
    await bot.sendMessage(chatId, `Request ${requestId} is already ${item.status || 'decided'} — no change made.`);
    return;
  }

  await approvalQueueRepository.updateStatus(requestId, approved ? 'approved' : 'rejected', new Date().toISOString());

  if (approved) {
    // CUS-2 — activation recheck: between request and approval another
    // customer with this name/alias may have gone Active (or two duplicate
    // pending requests raced). Activating the second would break the
    // one-active-name invariant every name-fallback read depends on.
    try {
      const hit = await require('../services/customerEntity').resolve({ name: custName });
      if (hit && hit.customer_id !== custId
        && String(hit.status || '').trim().toLowerCase() === 'active') {
        if (custId) {
          const customersRepo = require('../repositories/customersRepository');
          await customersRepo.updateRow(custId, { status: 'Rejected', notes: `Name collision at approval with ${hit.customer_id}` }).catch(() => {});
        }
        await approvalQueueRepository.updateStatus(requestId, 'rejected', new Date().toISOString()).catch(() => {});
        await bot.sendMessage(chatId, `⚠️ "${custName}" already belongs to an ACTIVE customer (${hit.customer_id}). This registration was refused — use the existing customer instead.`);
        await notifyEmployee(bot, requesterUserId, requestId, `❌ Customer "${custName}" was not registered — that name already belongs to an existing customer. Pick them from the customer list.`);
        return;
      }
    } catch (e) {
      logger.warn(`new-customer activation recheck failed (continuing): ${e.message}`);
    }
    if (custId) {
      const customersRepo = require('../repositories/customersRepository');
      await customersRepo.updateRow(custId, { status: 'Active' });
    }
    await bot.sendMessage(chatId, `✅ Customer "${custName}" approved and activated.`);

    // sessionStore now hoisted to top-of-file (TG-1).
    const session = sessionStore.get(requesterUserId);
    if (session && session.type === 'supply_req_flow' && session.step === 'awaiting_customer_approval') {
      session.customer = custName;
      session.customerId = custId; // CUS-2 — the fresh entity id rides the resumed flow
      session.step = 'salesperson';
      delete session.pendingCustomerId;
      delete session.pendingCustomerName;
      delete session.customerApprovalId;
      sessionStore.set(requesterUserId, session);

      try {
        await bot.sendMessage(requesterUserId,
          `✅ Customer "*${custName}*" has been approved\\!\n\nContinuing your supply request\\.\\.\\. Select salesperson:`,
          { parse_mode: 'MarkdownV2' },
        );
        const telegramUsers = await usersRepository.getAll();
        const rows = [];
        for (let i = 0; i < telegramUsers.length; i += 2) {
          const row = [{ text: `🧑 ${telegramUsers[i].name || telegramUsers[i].user_id}`, callback_data: `srf_sp:${telegramUsers[i].name || telegramUsers[i].user_id}` }];
          if (telegramUsers[i + 1]) row.push({ text: `🧑 ${telegramUsers[i + 1].name || telegramUsers[i + 1].user_id}`, callback_data: `srf_sp:${telegramUsers[i + 1].name || telegramUsers[i + 1].user_id}` });
          rows.push(row);
        }
        await bot.sendMessage(requesterUserId, '🧑 Select salesperson:', { reply_markup: { inline_keyboard: rows } });
      } catch (e) {
        logger.error('Failed to resume supply flow for user after customer approval', e);
      }
    } else if (session && session.type === 'sample_flow' && session.step === 'awaiting_customer_approval') {
      // Resume Give Sample flow at the quantity step.
      session.customer = custName;
      session.customerId = custId; // CUS-2
      session.step = 'quantity';
      delete session.pendingCustomerId;
      delete session.pendingCustomerName;
      delete session.customerApprovalId;
      sessionStore.set(requesterUserId, session);
      try {
        await bot.sendMessage(requesterUserId,
          `✅ Customer "*${custName}*" approved.\n\nContinuing your sample request…`,
          { parse_mode: 'Markdown' },
        );
        const telegramController = require('../controllers/telegramController');
        if (typeof telegramController.showSampleQuantityPicker === 'function') {
          await telegramController.showSampleQuantityPicker(bot, requesterUserId, requesterUserId);
        }
      } catch (e) {
        logger.error('Failed to resume sample flow for user after customer approval', e);
      }
    } else if (session && session.type === 'order_flow' && session.step === 'awaiting_customer_approval') {
      session.customer = custName;
      session.customerId = custId; // CUS-2
      session.step = 'quantity';
      delete session.pendingCustomerId;
      delete session.pendingCustomerName;
      delete session.customerApprovalId;
      sessionStore.set(requesterUserId, session);
      try {
        await bot.sendMessage(requesterUserId,
          `✅ Customer "*${custName}*" approved. Continuing your order…\n\nPick quantity:`,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [
                { text: '1 Bale',  callback_data: 'oq:1' },
                { text: '2 Bales', callback_data: 'oq:2' },
                { text: '5 Bales', callback_data: 'oq:5' },
                { text: '10 Bales', callback_data: 'oq:10' },
              ],
              [{ text: '✏️ Custom', callback_data: 'oq:__custom__' }],
              [{ text: '❌ Cancel', callback_data: 'ocanc:1' }],
            ] },
          },
        );
      } catch (e) {
        logger.error('Failed to resume order flow for user after customer approval', e);
      }
    } else if (session && session.type === 'receipt_flow' && session.step === 'awaiting_customer_approval') {
      session.customer = custName;
      session.customerId = custId; // CUS-2
      session.step = 'amount';
      delete session.pendingCustomerId;
      delete session.pendingCustomerName;
      delete session.customerApprovalId;
      sessionStore.set(requesterUserId, session);
      try {
        await bot.sendMessage(requesterUserId,
          `✅ Customer "*${custName}*" approved. Continuing your receipt upload…\n\nEnter the payment *amount* received (NGN):`,
          { parse_mode: 'Markdown' },
        );
      } catch (e) {
        logger.error('Failed to resume receipt flow after customer approval', e);
      }
    } else {
      await notifyEmployee(bot, requesterUserId, requestId, `✅ Customer "${custName}" has been approved by admin.`);
    }
  } else {
    // APU-1 3.6: the flows append the customer row (status 'Pending')
    // BEFORE approval — on rejection flip it to 'Rejected' so no orphaned
    // Pending row lingers in the Customers sheet.
    if (custId) {
      try {
        const customersRepo = require('../repositories/customersRepository');
        await customersRepo.updateRow(custId, { status: 'Rejected' });
      } catch (e) {
        logger.warn(`new-customer reject: could not mark ${custId} Rejected: ${e.message}`);
      }
    }
    await bot.sendMessage(chatId, `❌ Customer "${custName}" registration rejected.`);

    // sessionStore now hoisted to top-of-file (TG-1).
    const session = sessionStore.get(requesterUserId);
    if (session && session.type === 'supply_req_flow' && session.step === 'awaiting_customer_approval') {
      session.step = 'customer';
      delete session.pendingCustomerId;
      delete session.pendingCustomerName;
      delete session.customerApprovalId;
      sessionStore.set(requesterUserId, session);
      try {
        await bot.sendMessage(requesterUserId,
          `❌ Customer "${custName}" was rejected by admin.\n\nPlease select a different customer:`,
        );
        const customersRepo = require('../repositories/customersRepository');
        const allCust = await customersRepo.getAll();
        const active = allCust.filter((c) => (c.status || 'Active').toLowerCase() === 'active');
        const rows = [];
        for (let i = 0; i < active.length; i += 2) {
          const row = [{ text: `👤 ${active[i].name}`, callback_data: `srf_cu:${active[i].name}` }];
          if (active[i + 1]) row.push({ text: `👤 ${active[i + 1].name}`, callback_data: `srf_cu:${active[i + 1].name}` });
          rows.push(row);
        }
        rows.push([{ text: '➕ Add New Customer', callback_data: 'srf_cu:__new__' }]);
        await bot.sendMessage(requesterUserId, '👤 Select customer:', { reply_markup: { inline_keyboard: rows } });
      } catch (e) {
        logger.error('Failed to resume supply flow for user after customer rejection', e);
      }
    } else if (session && session.type === 'sample_flow' && session.step === 'awaiting_customer_approval') {
      session.step = 'customer';
      delete session.pendingCustomerId;
      delete session.pendingCustomerName;
      delete session.customerApprovalId;
      sessionStore.set(requesterUserId, session);
      try {
        await bot.sendMessage(requesterUserId,
          `❌ Customer "${custName}" was rejected by admin.\n\nPlease pick a different customer for the sample request.`,
        );
        const telegramController = require('../controllers/telegramController');
        if (typeof telegramController.showSampleCustomerPicker === 'function') {
          await telegramController.showSampleCustomerPicker(bot, requesterUserId, requesterUserId);
        }
      } catch (e) {
        logger.error('Failed to resume sample flow for user after customer rejection', e);
      }
    } else if (session && session.type === 'order_flow' && session.step === 'awaiting_customer_approval') {
      sessionStore.clear(requesterUserId);
      try {
        await bot.sendMessage(requesterUserId,
          `❌ Customer "${custName}" was rejected by admin.\n\nYour order has been cancelled. Please start again with a different customer.`,
        );
      } catch (e) {
        logger.error('Failed to notify user after order-flow customer rejection', e);
      }
    } else if (session && session.type === 'receipt_flow' && session.step === 'awaiting_customer_approval') {
      sessionStore.clear(requesterUserId);
      try {
        await bot.sendMessage(requesterUserId,
          `❌ Customer "${custName}" was rejected by admin.\n\nReceipt upload cancelled. Please restart with a different customer.`,
        );
      } catch (e) {
        logger.error('Failed to notify user after receipt-flow customer rejection', e);
      }
    } else {
      await notifyEmployee(bot, requesterUserId, requestId, `❌ Customer "${custName}" registration was rejected by admin.`);
    }
  }
}

/**
 * Stage 3 — dispatch person taps ✅ Accept on the assignment card.
 * Finalizes the queue row and broadcasts the success to all parties:
 * creator, every admin (the original 2nd-admin approver included),
 * and the Stage-1 confirmer (so they know their feasibility check
 * paid off).
 *
 * Old `srf_ack:` callbacks (from messages sent before this upgrade)
 * are delivered here too via the alias in the controller's dispatch.
 */
async function handleSupplyAccept(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  const requestId = data.replace(/^srf_(acc|ack):/, '');
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;

  // APU-1 3.2 (SEC): this handler used to flip ANY pending queue row to
  // 'approved' with no auth, stage, or action validation — a forged or
  // stale srf_acc:<id> could mark arbitrary requests approved. Accept is
  // only valid on a pending supply_request at stage 'dispatch_acceptance',
  // tapped by the person the admin assigned.
  const row0 = await approvalQueueRepository.getByRequestId(requestId);
  const aj0 = (row0 && row0.actionJSON) || {};
  if (!row0 || aj0.action !== 'supply_request') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'This card is not a valid supply assignment.', show_alert: true }).catch(() => {});
    return;
  }
  if (String(row0.status || '').toLowerCase() !== 'pending' || aj0.stage !== 'dispatch_acceptance') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'This assignment is no longer awaiting acceptance.', show_alert: true }).catch(() => {});
    return;
  }
  const assignee = aj0.assignedDispatch && String(aj0.assignedDispatch.user_id);
  if (!assignee || assignee !== userId) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assigned dispatch person can accept this.', show_alert: true }).catch(() => {});
    return;
  }

  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Accepted!' }).catch(() => {});
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

  const ts = new Date().toISOString();
  await approvalQueueRepository.updateStatus(requestId, 'approved', ts);
  await approvalQueueRepository.updateActionJSON(requestId, {
    stage: 'completed',
    acceptedByDispatch: { user_id: userId, ts },
  });
  try {
    const auditLogRepository = require('../repositories/auditLogRepository');
    await auditLogRepository.append('supply_dispatch_accepted', { requestId }, userId);
  } catch (_) { /* audit is best-effort */ }

  const acting = await usersRepository.findByUserId(userId);
  const userName = (acting && acting.name) || userId;
  await bot.sendMessage(chatId, `✅ You accepted supply request \`${requestId}\`. Proceed to the warehouse for dispatch.`, { parse_mode: 'Markdown' });

  // Notify the creator (NEW — previously creator wasn't told).
  const row = await approvalQueueRepository.getByRequestId(requestId);
  const creator = row && row.user;
  if (creator) {
    await notifyEmployee(bot, creator, requestId,
      `✅ *${userName}* has accepted dispatch for your supply request \`${requestId}\`. Stock is being prepared.`);
  }

  // Notify every admin (existing behavior, slightly reworded).
  for (const adminId of config.access.adminIds) {
    try {
      await bot.sendMessage(adminId, `✅ *${userName}* accepted dispatch for supply request \`${requestId}\`.`, { parse_mode: 'Markdown' });
    } catch (_) {}
  }

  // Notify the Stage-1 confirmer (close the loop) — only if they're
  // not also the accepter or an admin (already notified above).
  try {
    const aj = (row && row.actionJSON) || {};
    const confirmerId = aj.confirmedByDispatch && aj.confirmedByDispatch.user_id;
    if (confirmerId
        && String(confirmerId) !== String(userId)
        && !config.access.adminIds.includes(String(confirmerId))) {
      await bot.sendMessage(confirmerId,
        `✅ *${userName}* accepted dispatch for supply request \`${requestId}\` — the one you confirmed earlier.`,
        { parse_mode: 'Markdown' });
    }
  } catch (_) {}
}

/**
 * Stage 3 — dispatch person taps ❌ Decline. Collects a reason via
 * the shared `pendingReason` channel; the actual finalization runs
 * in `handleReasonReply` once the user types their reason.
 */
async function handleSupplyDecline(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  const requestId = data.replace(/^srf_dec:/, '');
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;

  // APU-1 3.2 (adversarial review): same validation as Accept — without
  // it, a forged srf_dec:<id> put ANY queue row (any action, any status)
  // through the decline path, stamping stage='admin_repick' and falsely
  // notifying the creator + re-broadcasting warehouse-boy pickers.
  const row0 = await approvalQueueRepository.getByRequestId(requestId);
  const aj0 = (row0 && row0.actionJSON) || {};
  if (!row0 || aj0.action !== 'supply_request'
      || String(row0.status || '').toLowerCase() !== 'pending' || aj0.stage !== 'dispatch_acceptance') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'This assignment is no longer awaiting your decision.', show_alert: true }).catch(() => {});
    return;
  }
  const assignee = aj0.assignedDispatch && String(aj0.assignedDispatch.user_id);
  if (!assignee || assignee !== userId) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only the assigned dispatch person can decline this.', show_alert: true }).catch(() => {});
    return;
  }

  await bot.answerCallbackQuery(callbackQuery.id);
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

  const othersQueued = armReasonPrompt(userId, { kind: 'dispatch_decline', requestId, chatId });
  await bot.sendMessage(chatId,
    `❌ *Decline supply request* \`${requestId}\`\n\nReply with a brief reason (or type *cancel* to keep the assignment).`
    + (othersQueued ? `\n\n_(${othersQueued} other reason${othersQueued === 1 ? '' : 's'} still pending — asked next.)_` : ''),
    { parse_mode: 'Markdown' });
}

/**
 * APF-1 — `apz:done:<requestId>`: close an executed-but-unresolved sale
 * WITHOUT re-running anything. Offered only on the all-items-failed refusal
 * card (every bale already sold). Flips the queue row to approved, audits
 * the no-execution closure, and touches neither stock nor money — the safe
 * exit for the "sold goods, forever-pending row" zombie a crash between
 * the stock flip and the status flip leaves behind.
 */
async function handleMarkDone(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('apz:done:')) return false;
  const requestId = data.slice('apz:done:'.length);
  const adminId = String(callbackQuery.from.id);
  if (!config.access.adminIds.includes(adminId)) {
    try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admins only.' }); } catch (_) { /* ignore */ }
    return true;
  }
  const { item } = await resolveRequest(requestId);
  if (!item || String(item.status || '').toLowerCase() !== 'pending') {
    try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Already resolved — nothing to do.' }); } catch (_) { /* ignore */ }
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] },
        { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    } catch (_) { /* stale card */ }
    return true;
  }
  await approvalQueueRepository.updateStatus(requestId, 'approved', new Date().toISOString());
  try {
    const auditLogRepository = require('../repositories/auditLogRepository');
    await auditLogRepository.append('approval_marked_done_no_exec',
      { requestId, note: 'closed by admin — items already sold, nothing re-executed' }, adminId);
  } catch (_) { /* the closure itself matters more */ }
  try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Closed — nothing was re-executed.' }); } catch (_) { /* ignore */ }
  try {
    await bot.editMessageText(
      `✅ Request ${requestId} marked as done by admin — closed WITHOUT re-executing (stock and money untouched).`,
      { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
  } catch (_) { /* stale card */ }
  return true;
}

/* ───────────────────────────────────────────────────────────────────── */
/*  CNET-2 — add-contact triage at approval (owner, 13-Aug-2026)         */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * "Even after approving a contact requested by Abdul, I am not able to see
 * this customer when approving the sales bill." The approving admin now
 * ROUTES the contact: 🛒 Customer (CRM entity + bound buyer node),
 * 📒 Contact (phonebook, the old behaviour) or 🕸 Network (phonebook + a
 * subordinate_of edge under a buyer picked in place on the same card).
 *
 * The chips persist the choice onto the queued actionJSON and then delegate
 * to handleApprovalCallback('approve'), so EVERY existing guard holds:
 * stale-request, self-approval, super-admin, dual-admin. A plain `approve:`
 * from any old or generic surface executes as 📒 Contact — pre-CNET-2
 * behaviour, never a surprise registration.
 *
 * Callback shapes (all carry the requestId — APC-1 rule, no cross-wiring):
 *   ctg:<rid>:c        → destination customer, approve
 *   ctg:<rid>:p        → destination contact (phonebook), approve
 *   ctg:<rid>:n        → open the buyer picker in place
 *   ctg:<rid>:pg:<n>   → picker page
 *   ctg:<rid>:b:<i>    → pick buyer i (index into per-admin state)
 *   ctg:<rid>:ok       → confirm placement, approve
 *   ctg:<rid>:x        → back to the triage card
 */
const pendingTriage = new Map(); // `${adminId}|${requestId}` → { bosses, page, pick, at }
const TRIAGE_TTL_MS = 60 * 60 * 1000;
const TRIAGE_PAGE = 10;

function triageSweep() {
  const now = Date.now();
  for (const [k, v] of pendingTriage) {
    if (!v || now - (v.at || 0) > TRIAGE_TTL_MS) pendingTriage.delete(k);
  }
}

/** Buyer nodes a person can be placed under: customer-typed or CRM-bound contacts. */
async function triageBuyerList() {
  const contactsRepository = require('../repositories/contactsRepository');
  const all = await contactsRepository.getAll();
  return all
    .filter((c) => (c.status || 'active').toLowerCase() === 'active'
      && (c.type === 'customer' || c.customer_id))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

async function renderTriageCard(bot, chatId, messageId, requestId, aj) {
  const approvalCards = require('../services/approvalCards');
  const esc = (t) => (t || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  const text = `🔔 *Approval required*\n\nRef: \`${requestId}\`\n\n${esc(approvalCards.buildAddContactCard(aj))}`;
  const keyboard = approvalCards.keyboardForRequest(requestId, aj);
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'MarkdownV2', reply_markup: keyboard });
  } catch (e) {
    if (!/not modified/i.test(String(e.message || ''))) {
      // MarkdownV2 hiccup → plain-text fallback, never a dead card.
      await bot.editMessageText(`🔔 Approval required\n\nRef: ${requestId}\n\n${approvalCards.buildAddContactCard(aj)}`,
        { chat_id: chatId, message_id: messageId, reply_markup: keyboard }).catch(() => {});
    }
  }
}

async function renderTriagePicker(bot, query, requestId, state, aj) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const start = state.page * TRIAGE_PAGE;
  const slice = state.bosses.slice(start, start + TRIAGE_PAGE);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [{ text: `👤 ${slice[i].name}`.slice(0, 60), callback_data: `ctg:${requestId}:b:${start + i}` }];
    if (slice[i + 1]) row.push({ text: `👤 ${slice[i + 1].name}`.slice(0, 60), callback_data: `ctg:${requestId}:b:${start + i + 1}` });
    rows.push(row);
  }
  const nav = [];
  if (state.page > 0) nav.push({ text: '⬅️ Prev', callback_data: `ctg:${requestId}:pg:${state.page - 1}` });
  if (start + TRIAGE_PAGE < state.bosses.length) nav.push({ text: 'More ▸', callback_data: `ctg:${requestId}:pg:${state.page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '⬅️ Back', callback_data: `ctg:${requestId}:x` }]);
  const esc = (t) => (t || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  const text = `🕸 *Where in the network?*\n\nPlace *${esc(aj.name || '?')}* under one of the buyers:`
    + (state.bosses.length ? '' : '\n\n_No buyer nodes in the network yet — register a customer first, or choose 📒 Contact\\._');
  await bot.editMessageText(text, {
    chat_id: chatId, message_id: messageId, parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: rows },
  }).catch(() => {});
}

async function handleContactTriageCallback(bot, callbackQuery) {
  triageSweep();
  const data = String(callbackQuery.data || '');
  const m = data.match(/^ctg:([^:]+):(c|p|n|ok|x|pg:\d+|b:\d+)$/);
  if (!m) { try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) {} return; }
  const [, requestId, op] = m;
  const adminId = String(callbackQuery.from.id);
  if (!config.access.adminIds.includes(adminId)) {
    try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Only admins can approve.' }); } catch (_) {}
    return;
  }
  const { item } = await resolveRequest(requestId);
  if (!item || String(item.status || '').toLowerCase() !== 'pending') {
    try {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Already resolved — nothing to do.' });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] },
        { chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id });
    } catch (_) { /* stale card */ }
    return;
  }
  const aj = item.actionJSON || {};
  if (aj.action !== 'add_contact') {
    try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Not a contact request.' }); } catch (_) {}
    return;
  }
  const key = `${adminId}|${requestId}`;
  const approve = async (patch) => {
    await approvalQueueRepository.updateActionJSON(requestId, patch);
    pendingTriage.delete(key);
    // Delegate with a rewritten payload so the FULL approve path runs —
    // stale guard, self-approval, super-admin, dual-admin, executor, cards.
    await handleApprovalCallback(bot, { ...callbackQuery, data: `approve:${requestId}` }, 'approve');
  };

  if (op === 'c') { await approve({ destination: 'customer' }); return; }
  if (op === 'p') { await approve({ destination: 'contact' }); return; }

  if (op === 'n') {
    const bosses = await triageBuyerList().catch(() => []);
    const state = { bosses, page: 0, at: Date.now() };
    pendingTriage.set(key, state);
    try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) {}
    await renderTriagePicker(bot, callbackQuery, requestId, state, aj);
    return;
  }
  if (op.startsWith('pg:')) {
    const state = pendingTriage.get(key);
    if (!state) { await handleContactTriageCallback(bot, { ...callbackQuery, data: `ctg:${requestId}:n` }); return; }
    state.page = Math.max(0, parseInt(op.slice(3), 10) || 0);
    state.at = Date.now();
    try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) {}
    await renderTriagePicker(bot, callbackQuery, requestId, state, aj);
    return;
  }
  if (op.startsWith('b:')) {
    const state = pendingTriage.get(key);
    const boss = state && state.bosses[parseInt(op.slice(2), 10)];
    if (!boss) { await handleContactTriageCallback(bot, { ...callbackQuery, data: `ctg:${requestId}:n` }); return; }
    state.pick = boss;
    state.at = Date.now();
    try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) {}
    const esc = (t) => (t || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
    await bot.editMessageText(
      `🕸 *Confirm placement*\n\n👤 ${esc(aj.name || '?')} → under *${esc(boss.name)}*`,
      {
        chat_id: callbackQuery.message.chat.id, message_id: callbackQuery.message.message_id,
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Place & approve', callback_data: `ctg:${requestId}:ok` }],
          [{ text: '⬅️ Back', callback_data: `ctg:${requestId}:n` }],
        ] },
      },
    ).catch(() => {});
    return;
  }
  if (op === 'ok') {
    const state = pendingTriage.get(key);
    if (!state || !state.pick) { await handleContactTriageCallback(bot, { ...callbackQuery, data: `ctg:${requestId}:n` }); return; }
    await approve({ destination: 'network', boss_contact_id: state.pick.contact_id, boss_name: state.pick.name });
    return;
  }
  if (op === 'x') {
    pendingTriage.delete(key);
    try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) {}
    await renderTriageCard(bot, callbackQuery.message.chat.id, callbackQuery.message.message_id, requestId, aj);
    return;
  }
}

module.exports = {
  notifyAdminsApprovalRequest,
  handleApprovalCallback,
  handleContactTriageCallback,
  handleMarkDone,
  handleEnrichmentMessage,
  handleEnrichmentCallback,
  handleSupplyAssign,
  handleSupplyAccept,
  handleSupplyDecline,
  handleDispatchManagerCallback,
  handleReasonReply,
  notifyDispatchManagers,
  startApprovalEnrichment,
  _internals: {
    pendingEnrichment, getLastPaidRate, sendPaymentStep,
    // DSP-1 — exposed for the fail-closed test: a sale with no customer
    // must never reach executeApprovedAction.
    runApprovedSaleWithEnrichment, updateRequesterCard, sendCustomerStep,
    // APC-1 — per-request wizard mechanics, exposed for the concurrency tests.
    wizardsOf, activeWizard, wizKey, lastTouchedWizard, heldEnrichmentText,
    pendingReason, armReasonPrompt,
  },
};
