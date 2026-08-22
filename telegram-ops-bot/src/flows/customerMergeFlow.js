'use strict';

/**
 * CUS-1 Phase E — 🔀 Merge Customers (owner-locked: "Yes Merge, not delete").
 *
 * The typo-cleanup tool. A typo customer is never deleted — it is MERGED
 * into the real one: its name becomes an alias on the canonical row, its row
 * is kept as status 'Merged' for audit, and every read that resolves through
 * the entity (rates, ledger, payments, suggestions) consolidates instead of
 * going blind. Deleting would orphan the history; merging keeps it.
 *
 * Admin-only, and the merge itself is DUAL-ADMIN gated: it moves ledger
 * identity, which is exactly the class of action two people should see.
 *
 * Steps: pick the TYPO (type to search) → pick the REAL customer → confirm
 * card → queued for second-admin approval → executor calls
 * customerEntity.mergeInto.
 *
 * Callback namespace `cmg:`.
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, mdEscape } = require('../utils/flowKit');
const customersRepository = require('../repositories/customersRepository');
const customerEntity = require('../services/customerEntity');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const idGenerator = require('../utils/idGenerator');
const auth = require('../middlewares/auth');
const config = require('../config');
const logger = require('../utils/logger');

const SESSION_TYPE = 'customer_merge_flow';
const NS = 'cmg:';

const render = makeRenderer({ parseMode: 'Markdown', requireSession: true });

function cancelRow() {
  return [{ text: '❌ Cancel', callback_data: `${NS}cancel` }, { text: '🏠 Menu', callback_data: 'act:__back__' }];
}

/** Everything except already-merged rows — a typo may be Active OR Pending. */
async function searchMergeable(query, excludeId) {
  const q = String(query || '').trim().toLowerCase();
  const all = await customersRepository.getAll();
  return all.filter((c) => String(c.status || 'Active').toLowerCase() !== 'merged'
    && c.customer_id !== excludeId
    && (c.name.toLowerCase().includes(q)
      || (c.aliases || []).some((a) => a.toLowerCase().includes(q))))
    .slice(0, 8);
}

async function start(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(String(userId))) {
    await bot.sendMessage(chatId, '🔀 Merging customers is admin-only.');
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'pick_typo',
    flowMessageId: messageId || null, ttlMs: 15 * 60 * 1000,
    typo: null, canonical: null, _hits: [],
  });
  await render(bot, chatId, userId,
    '🔀 *Merge Customers*\n\n'
    + 'Fold a duplicate/typo customer INTO the real one. Nothing is deleted: '
    + 'the typo becomes an alias, its history consolidates onto the real '
    + 'customer, and it disappears from every picker.\n\n'
    + '*Step 1 of 2 — type part of the DUPLICATE (typo) name to search:*',
    [cancelRow()]);
}

async function showHits(bot, chatId, userId, session, hits, title) {
  session._hits = hits.map((c) => ({ id: c.customer_id, name: c.name, status: c.status }));
  sessionStore.set(userId, session);
  const rows = hits.map((c, i) => ([{
    text: `👤 ${customerEntity.labelFor(c, hits)}${String(c.status).toLowerCase() !== 'active' ? ` (${c.status})` : ''}`,
    callback_data: `${NS}pick:${i}`,
  }]));
  rows.push(cancelRow());
  await render(bot, chatId, userId, title, rows);
}

async function showConfirm(bot, chatId, userId, session) {
  session.step = 'confirm';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `🔀 *Confirm merge*\n\n`
    + `Duplicate: *${mdEscape(session.typo.name)}* (\`${session.typo.id}\`)\n`
    + `Real customer: *${mdEscape(session.canonical.name)}* (\`${session.canonical.id}\`)\n\n`
    + `After the merge:\n`
    + `• "${mdEscape(session.typo.name)}" becomes an alias of *${mdEscape(session.canonical.name)}*\n`
    + `• All history under the old spelling consolidates (rates, ledger, payments)\n`
    + `• The duplicate disappears from every picker (kept as Merged for audit)\n\n`
    + `⚠️ _Requires a SECOND admin's approval — merging moves ledger identity._`,
    [
      [{ text: '✅ Queue merge for approval', callback_data: `${NS}ok` }],
      [{ text: '⬅ Start over', callback_data: `${NS}restart` }],
      cancelRow(),
    ]);
}

async function submit(bot, chatId, userId, session) {
  const requestId = idGenerator.requestId();
  await approvalQueueRepository.append({
    requestId,
    user: userId,
    actionJSON: {
      action: 'merge_customers',
      typoId: session.typo.id, typoName: session.typo.name,
      canonicalId: session.canonical.id, canonicalName: session.canonical.name,
    },
    riskReason: 'Merging customers moves ledger identity — dual-admin.',
    status: 'pending',
  });
  await auditLogRepository.append('approval_queued',
    { requestId, action: 'merge_customers', typo: session.typo.name, canonical: session.canonical.name }, userId);
  const approvalEvents = require('../events/approvalEvents');
  const requesterIsAdmin = config.access.adminIds.includes(String(userId));
  await approvalEvents.notifyAdminsApprovalRequest(
    bot, requestId,
    await require('../services/approvalCards').resolveUserLabel(userId, bot),
    `Merge Customers\nDuplicate: ${session.typo.name} (${session.typo.id})\nInto: ${session.canonical.name} (${session.canonical.id})\nThe duplicate becomes an alias; history consolidates.`,
    'Merging customers moves ledger identity — dual-admin.',
    requesterIsAdmin ? userId : undefined,
  );
  await render(bot, chatId, userId,
    `⏳ *Merge queued* — request \`${requestId}\`\n\n`
    + `*${mdEscape(session.typo.name)}* → *${mdEscape(session.canonical.name)}*\n`
    + `Waiting for a second admin to approve.`,
    [[{ text: '🔀 Merge another', callback_data: 'act:merge_customers' }, { text: '🏠 Menu', callback_data: 'act:__back__' }]]);
  sessionStore.clear(userId);
}

async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return false;
  if (session.step !== 'pick_typo' && session.step !== 'pick_canonical') return false;

  const pickingTypo = session.step === 'pick_typo';
  const hits = pickingTypo
    ? await searchMergeable(msg.text, null)
    // The canonical target must be ACTIVE — you cannot merge INTO a
    // pending/inactive row — and never the typo itself.
    : (await customerEntity.search(msg.text)).filter((c) => c.customer_id !== session.typo.id).slice(0, 8);

  if (!hits.length) {
    await render(bot, chatId, userId,
      `No customer matches “${mdEscape(String(msg.text || '').trim())}”. Type again:`,
      [cancelRow()]);
    return true;
  }
  await showHits(bot, chatId, userId, session, hits,
    pickingTypo
      ? 'Tap the *DUPLICATE* (the one to fold away):'
      : `Duplicate: *${mdEscape(session.typo.name)}*\n\n*Step 2 of 2 — tap the REAL customer it belongs to:*`);
  return true;
}

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith(NS)) return false;
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;
  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* stale */ }
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    try { await bot.sendMessage(chatId, 'This card expired — open 🔀 Merge Customers again.'); } catch (_) {}
    return true;
  }
  const rest = data.slice(NS.length);

  if (rest === 'cancel') {
    await render(bot, chatId, userId, '🔀 Merge cancelled — nothing changed.',
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    sessionStore.clear(userId, 'cancelled');
    return true;
  }
  if (rest === 'restart') {
    await start(bot, chatId, userId, query.message.message_id);
    return true;
  }
  if (rest.startsWith('pick:')) {
    const hit = (session._hits || [])[parseInt(rest.slice(5), 10)];
    if (!hit) return true;
    if (session.step === 'pick_typo') {
      session.typo = hit;
      session.step = 'pick_canonical';
      session._hits = [];
      sessionStore.set(userId, session);
      await render(bot, chatId, userId,
        `Duplicate: *${mdEscape(hit.name)}*\n\n*Step 2 of 2 — type part of the REAL customer's name:*`,
        [cancelRow()]);
    } else if (session.step === 'pick_canonical') {
      session.canonical = hit;
      await showConfirm(bot, chatId, userId, session);
    }
    return true;
  }
  if (rest === 'ok') {
    if (session.step !== 'confirm' || !session.typo || !session.canonical) return true;
    try {
      await submit(bot, chatId, userId, session);
    } catch (e) {
      logger.error(`customerMergeFlow.submit failed: ${e.message}`);
      try { await bot.sendMessage(chatId, `⚠️ Could not queue the merge: ${e.message}`); } catch (_) {}
    }
    return true;
  }
  return true;
}

module.exports = { SESSION_TYPE, start, handleCallback, handleText };
