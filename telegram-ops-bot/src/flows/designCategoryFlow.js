/**
 * Set Design Category flow — DCAT-1.
 *
 * Shortest path from "this design needs a label" to a dual-admin-approved
 * mapping in the DesignCategories sheet:
 *
 *   act:set_design_category (Designs hub, admin-only entry)
 *     → pick design chip (current category shown on the chip)
 *     → pick category chip (Cashmere / Chinos / Gaberdine / Senator / TR /
 *       any label already in the sheet)
 *     → confirm card → Submit
 *     → approval queue (action `set_design_category`,
 *       ALWAYS_APPROVAL_ACTIONS → a 2nd admin must approve; self-approval
 *       is blocked in approvalEvents)
 *     → inventoryService.executeApprovedAction writes the sheet row and
 *       drops the read cache, so every screen shows the new label at once.
 *
 * UX standard (UX-C1):
 *   - Single anchored card via editMessageText (no message stack).
 *   - Every step exposes Back AND Cancel.
 *
 * Session shape (`type: 'dcat_flow'`):
 *   {
 *     step: 'design' | 'category' | 'confirm',
 *     flowMessageId: number|null,
 *     page: number,            // design-list page
 *     _designs: string[],      // chip index → design
 *     _cats: string[],         // chip index → category
 *     design: string,          // picked design
 *     prevCategory: string,    // design's current category ('' if none)
 *     category: string,        // picked category, pending submit
 *     startedAt: ISO,
 *   }
 *
 * Callback namespace `dcat:*`:
 *   dcat:pg:<n>    design-list page n
 *   dcat:dg:<i>    pick design by index
 *   dcat:ct:<i>    pick category by index
 *   dcat:back      one step back (context-sensitive)
 *   dcat:submit    queue for dual-admin approval
 *   dcat:cancel    abandon flow
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, chunk } = require('../utils/flowKit');
const auth = require('../middlewares/auth');
const idGenerator = require('../utils/idGenerator');
const riskEvaluate = require('../risk/evaluate');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const approvalEvents = require('../events/approvalEvents');
const auditLogRepository = require('../repositories/auditLogRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const designCategoriesRepository = require('../repositories/designCategoriesRepository');
const logger = require('../utils/logger');

const ACTION = 'set_design_category';
const SESSION_TYPE = 'dcat_flow';
const PAGE_SIZE = 24; // 8 rows × 3 chips
const CHIPS_PER_ROW = 3;

/** Split an array of buttons into keyboard rows. */

function cancelRow() { return [{ text: '❌ Cancel', callback_data: 'dcat:cancel' }]; }
function navRow() {
  return [{ text: '⬅ Back', callback_data: 'dcat:back' }, { text: '❌ Cancel', callback_data: 'dcat:cancel' }];
}

/**
 * Render-in-place primitive — anchored card via editMessageText, falling
 * back to a fresh message (same convention as warehouseFlow).
 * @param {object} bot Telegram bot instance.
 * @param {number|string} chatId Chat id.
 * @param {string} userId Telegram user id.
 * @param {string} prompt Card body (Markdown).
 * @param {Array} rows Inline-keyboard rows.
 * @returns {Promise<void>}
 */
// Shared flowKit renderer with this flow's fixed header.
const render = makeRenderer({ titlePrefix: '🏷️ *Set Design Category*\n\n' });

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Step 1 — design picker. Chips show the design's current category so the
 * admin can spot unmapped designs at a glance.
 */
async function showDesignPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;

  const raw = await inventoryRepository.getDistinctDesigns();
  const designs = [...new Set(raw.map((d) => (d.design || '').trim()).filter(Boolean))].sort();
  if (!designs.length) {
    await render(bot, chatId, userId, '⚠️ No designs found in inventory.', [cancelRow()]);
    return;
  }
  let catMap = new Map();
  try { catMap = await designCategoriesRepository.getMap(); } catch { /* render bare */ }

  const pages = Math.max(1, Math.ceil(designs.length / PAGE_SIZE));
  const page = Math.min(Math.max(session.page || 0, 0), pages - 1);
  const visible = designs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  session._designs = visible;
  session.page = page;
  session.step = 'design';
  sessionStore.set(userId, session);

  const chips = visible.map((d, i) => {
    const cat = catMap.get(designCategoriesRepository.normalizeDesign(d)) || '';
    return { text: cat ? `${d} · ${cat}` : d, callback_data: `dcat:dg:${i}` };
  });
  const rows = chunk(chips, CHIPS_PER_ROW);
  if (pages > 1) {
    const pager = [];
    if (page > 0) pager.push({ text: '⬅ Prev', callback_data: `dcat:pg:${page - 1}` });
    pager.push({ text: `${page + 1}/${pages}`, callback_data: `dcat:pg:${page}` });
    if (page < pages - 1) pager.push({ text: 'Next ➡', callback_data: `dcat:pg:${page + 1}` });
    rows.push(pager);
  }
  rows.push(cancelRow());
  await render(bot, chatId, userId,
    'Pick the *design* to categorize.\n_Chips already showing a category can be re-mapped._',
    rows);
}

/** Step 2 — category picker (defaults ∪ sheet-known labels). */
async function showCategoryPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;

  const cats = await designCategoriesRepository.listCategories();
  session._cats = cats;
  session.step = 'category';
  sessionStore.set(userId, session);

  const chips = cats.map((c, i) => ({
    text: c.toLowerCase() === (session.prevCategory || '').toLowerCase() ? `✓ ${c}` : c,
    callback_data: `dcat:ct:${i}`,
  }));
  const rows = chunk(chips, 2);
  rows.push(navRow());
  const current = session.prevCategory ? `Current: *${session.prevCategory}*` : '_No category yet._';
  await render(bot, chatId, userId,
    `Design *${session.design}* — pick its category.\n${current}`,
    rows);
}

/** Step 3 — confirm card. */
async function showConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;
  session.step = 'confirm';
  sessionStore.set(userId, session);

  const fromTo = session.prevCategory
    ? `${session.prevCategory} → *${session.category}*`
    : `(none) → *${session.category}*`;
  await render(bot, chatId, userId,
    `Confirm:\n\n• Design: *${session.design}*\n• Category: ${fromTo}\n\n`
    + '_On submit: queued for 2nd-admin approval (you cannot self-approve). '
    + 'Once approved, the label shows next to this design number everywhere._',
    [
      [{ text: '✅ Submit for approval', callback_data: 'dcat:submit' }],
      navRow(),
    ]);
}

// ---------------------------------------------------------------------------
// Submit → approval queue
// ---------------------------------------------------------------------------

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE || !session.design || !session.category) return;
  const { design, category, prevCategory } = session;

  // Duplicate guard: one pending category change per design at a time.
  const pending = await approvalQueueRepository.getAllPending();
  const dup = pending.find((p) => p.actionJSON
    && p.actionJSON.action === ACTION
    && designCategoriesRepository.normalizeDesign(p.actionJSON.design)
       === designCategoriesRepository.normalizeDesign(design));
  if (dup) {
    await render(bot, chatId, userId,
      `⚠️ A category change for *${design}* is already awaiting approval (\`${dup.requestId}\`).`,
      [navRow()]);
    return;
  }

  const aj = { action: ACTION, design, category, prevCategory: prevCategory || '' };
  const risk = await riskEvaluate.evaluate({ action: ACTION, userId });
  const requestId = idGenerator.requestId();
  try {
    await approvalQueueRepository.append({
      requestId, user: String(userId), actionJSON: aj,
      riskReason: risk.reason || 'dual_admin_required', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, action: ACTION, design, category }, String(userId));

    const isAdm = auth.isAdmin(String(userId));
    const excludeId = isAdm ? String(userId) : undefined;
    const summary = prevCategory
      ? `🏷️ Design ${design} category: ${prevCategory} → ${category}`
      : `🏷️ Design ${design} category: ${category}`;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, String(userId), summary,
      risk.reason || 'dual_admin_required', excludeId);

    // UX-C1: render success BEFORE clearing the session (render needs it).
    await render(bot, chatId, userId,
      `⏳ *Submitted for approval*\n\n• Design: *${design}*\n• Category: *${category}*\n• Request: \`${requestId}\`\n• Approver: 2nd admin (you cannot self-approve)\n\n`
      + '_Once approved, the label appears next to the design number on every screen._',
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    sessionStore.clear(userId);
    logger.info(`designCategoryFlow.submit: queued ${ACTION} design=${design} category=${category} request=${requestId} by=${userId}`);
  } catch (e) {
    logger.error(`designCategoryFlow.submit failed: ${e.message}`);
    await render(bot, chatId, userId,
      `⚠️ Could not queue the request: ${e.message}`,
      [navRow()]);
  }
}

// ---------------------------------------------------------------------------
// Entry + dispatcher
// ---------------------------------------------------------------------------

/**
 * Start the Set-Design-Category flow.
 * The controller already gates the `act:set_design_category` entry to
 * admins; this in-flow gate is defence-in-depth for any future entry door.
 * @param {object} bot Telegram bot instance.
 * @param {number|string} chatId Chat id.
 * @param {string} userId Telegram user id.
 * @param {number|null} messageId Optional message id to edit in place.
 * @returns {Promise<void>}
 */
async function start(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(String(userId))) {
    await bot.sendMessage(chatId, '🏷️ Design categories can be set by admins only.');
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'design',
    flowMessageId: messageId || null,
    page: 0,
    design: '',
    prevCategory: '',
    category: '',
    startedAt: new Date().toISOString(),
  });
  await showDesignPicker(bot, chatId, userId);
}

/**
 * Handle a `dcat:*` callback.
 * @param {object} bot Telegram bot instance.
 * @param {object} query Telegram callback query.
 * @returns {Promise<boolean>} True when the callback was handled.
 */
async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('dcat:')) return false;
  const chatId = query.message?.chat?.id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);

  if (!session || session.type !== SESSION_TYPE) {
    try {
      await bot.answerCallbackQuery(query.id, {
        text: 'This card expired. Open 🏷️ Set Design Category again.',
        show_alert: true,
      });
    } catch { /* ignore */ }
    return true;
  }
  try { await bot.answerCallbackQuery(query.id); } catch { /* ignore */ }

  if (data === 'dcat:cancel') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '❌ Cancelled — nothing was changed.', []);
    return true;
  }

  if (data.startsWith('dcat:pg:')) {
    session.page = parseInt(data.slice('dcat:pg:'.length), 10) || 0;
    sessionStore.set(userId, session);
    await showDesignPicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('dcat:dg:')) {
    const idx = parseInt(data.slice('dcat:dg:'.length), 10);
    const design = (session._designs || [])[idx];
    if (!design) { await showDesignPicker(bot, chatId, userId); return true; }
    session.design = design;
    try {
      session.prevCategory = await designCategoriesRepository.categoryOf(design);
    } catch { session.prevCategory = ''; }
    sessionStore.set(userId, session);
    await showCategoryPicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('dcat:ct:')) {
    const idx = parseInt(data.slice('dcat:ct:'.length), 10);
    const category = (session._cats || [])[idx];
    if (!category) { await showCategoryPicker(bot, chatId, userId); return true; }
    session.category = category;
    sessionStore.set(userId, session);
    await showConfirm(bot, chatId, userId);
    return true;
  }

  if (data === 'dcat:back') {
    if (session.step === 'confirm') {
      await showCategoryPicker(bot, chatId, userId);
    } else {
      session.design = '';
      session.prevCategory = '';
      sessionStore.set(userId, session);
      await showDesignPicker(bot, chatId, userId);
    }
    return true;
  }

  if (data === 'dcat:submit') {
    await submit(bot, chatId, userId);
    return true;
  }

  return true;
}

module.exports = {
  start,
  handleCallback,
  // Internals exposed for offline tests only.
  _internals: { showDesignPicker, showCategoryPicker, showConfirm, submit, ACTION, SESSION_TYPE },
};
