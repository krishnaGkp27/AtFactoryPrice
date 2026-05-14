/**
 * Goods Receipt Note (GRN) flow — P2.
 *
 * Compact 6-step picker for marking new bales as physically received at a
 * warehouse. Admin executes directly; employees route through admin
 * approval (see WRITE_ACTIONS in risk/evaluate.js).
 *
 * Steps:
 *   1. Warehouse  — existing list + ➕ New warehouse (dual-admin gated)
 *   2. Supplier   — Contacts (type='supplier') + ➕ New supplier + 🚫 None
 *   3. Design     — existing distinct designs + ➕ New design (free-text)
 *   4. Shade      — existing shades for the picked design + ➕ New shade
 *   5. Bales      — CSV (e.g. "5801,5802") or range (e.g. "5801-5810")
 *                   then a single yards-per-bale prompt (admin can revise
 *                   on the confirm card per-bale later if needed)
 *   6. Confirm    — shows every bale row before write; ✅ Submit / ❌ Cancel
 *
 * Session shape:
 *   {
 *     type: 'grn_flow',
 *     step: 'warehouse' | 'supplier' | 'design' | 'shade' | 'bales' | 'yards' | 'confirm'
 *         | 'new_warehouse' | 'new_supplier' | 'new_design' | 'new_shade',
 *     flowMessageId: number,
 *     warehouse: string,
 *     supplier: string, supplier_id: string,
 *     design: string, shade: string,
 *     bales: [{ packageNo, yards }],
 *     yardsPerBale: number,
 *     notes: string,
 *     startedAt: ISO,
 *   }
 *
 * Callback namespace: `gr:*`
 *   gr:wh:<warehouse>         pick warehouse
 *   gr:wh_new                 enter inline new-warehouse step
 *   gr:sp:<contact_id>        pick supplier from contacts
 *   gr:sp_new                 enter inline new-supplier step
 *   gr:sp_none                proceed without a supplier
 *   gr:dg:<design>            pick design
 *   gr:dg_new                 enter inline new-design step
 *   gr:sh:<shade>             pick shade
 *   gr:sh_new                 enter inline new-shade step
 *   gr:sh_none                proceed with empty shade
 *   gr:back:<step>            jump back to a prior step
 *   gr:cancel                 abandon flow
 *   gr:submit                 final submit
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const inventoryRepository = require('../repositories/inventoryRepository');
const contactsRepository = require('../repositories/contactsRepository');
const settingsRepository = require('../repositories/settingsRepository');
const goodsReceiptsRepo = require('../repositories/goodsReceiptsRepository');
const auth = require('../middlewares/auth');
const config = require('../config');
const riskEvaluate = require('../risk/evaluate');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const approvalEvents = require('../events/approvalEvents');
const auditLogRepository = require('../repositories/auditLogRepository');
const inventoryService = require('../services/inventoryService');
const adminFeed = require('../services/adminFeed');
const idGenerator = require('../utils/idGenerator');
const logger = require('../utils/logger');
const { editOrSend } = require('../utils/telegramUI');
const { fmtQty } = require('../utils/format');

const DEFAULT_YARDS_PER_BALE = 50;

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function header(session) {
  const lines = ['📥 *Receive Goods*'];
  if (session.warehouse) lines.push(`✓ Warehouse: *${session.warehouse}*`);
  if (session.supplier) lines.push(`✓ Supplier: *${session.supplier}*`);
  else if (session.supplier === '__none__') lines.push('✓ Supplier: _none_');
  if (session.design) lines.push(`✓ Design: *${session.design}*`);
  if (session.shade) lines.push(`✓ Shade: *${session.shade}*`);
  else if (session.shade === '__none__') lines.push('✓ Shade: _none_');
  if (Array.isArray(session.bales) && session.bales.length) {
    const totalYards = session.bales.reduce((s, b) => s + (b.yards || 0), 0);
    lines.push(`✓ Bales: *${session.bales.length}* · ${fmtQty(totalYards, { maxFraction: 2 })} yards total`);
  }
  return lines.join('\n');
}

async function render(bot, chatId, userId, prompt, rows) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const text = header(session) + '\n\n' + prompt;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  const mid = session.flowMessageId;
  if (mid) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...opts });
      return;
    } catch (_) { /* fall through to send */ }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  session.flowMessageId = sent.message_id;
  sessionStore.set(userId, session);
}

function cancelRow() {
  return [{ text: '❌ Cancel', callback_data: 'gr:cancel' }];
}

// ---------------------------------------------------------------------------
// Step 1 — Warehouse
// ---------------------------------------------------------------------------

async function start(bot, chatId, userId, messageId = null) {
  sessionStore.set(userId, {
    type: 'grn_flow', step: 'warehouse',
    flowMessageId: messageId || null,
    bales: [],
    startedAt: new Date().toISOString(),
  });
  await showWarehouseStep(bot, chatId, userId);
}

async function listAllWarehouses() {
  const fromInv = await inventoryRepository.getWarehouses();
  const fromSet = await settingsRepository.getAll();
  const extra = ((fromSet || {}).WAREHOUSE_LIST || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const all = new Set([...fromInv, ...extra]);
  return Array.from(all).sort();
}

async function showWarehouseStep(bot, chatId, userId) {
  const warehouses = await listAllWarehouses();
  const rows = [];
  for (let i = 0; i < warehouses.length; i += 2) {
    const row = [{ text: `🏭 ${warehouses[i]}`, callback_data: `gr:wh:${warehouses[i]}` }];
    if (warehouses[i + 1]) row.push({ text: `🏭 ${warehouses[i + 1]}`, callback_data: `gr:wh:${warehouses[i + 1]}` });
    rows.push(row);
  }
  rows.push([{ text: '➕ New warehouse', callback_data: 'gr:wh_new' }]);
  rows.push(cancelRow());
  const prompt = warehouses.length
    ? 'Select the *receiving warehouse*:'
    : '_No warehouses registered yet._ Tap ➕ to register one (dual-admin approval).';
  await render(bot, chatId, userId, prompt, rows);
}

// ---------------------------------------------------------------------------
// Step 2 — Supplier
// ---------------------------------------------------------------------------

async function showSupplierStep(bot, chatId, userId) {
  const suppliers = await contactsRepository.getByType('supplier');
  const rows = [];
  for (const s of suppliers.slice(0, 12)) {
    rows.push([{ text: `🏢 ${s.name}`, callback_data: `gr:sp:${s.contact_id}` }]);
  }
  rows.push([{ text: '➕ New supplier', callback_data: 'gr:sp_new' }]);
  rows.push([{ text: '🚫 No supplier', callback_data: 'gr:sp_none' }]);
  rows.push([{ text: '⬅ Back', callback_data: 'gr:back:warehouse' }, ...cancelRow()]);
  await render(bot, chatId, userId, 'Select the *supplier* (or skip):', rows);
}

// ---------------------------------------------------------------------------
// Step 3 — Design
// ---------------------------------------------------------------------------

async function showDesignStep(bot, chatId, userId) {
  const distinct = await inventoryRepository.getDistinctDesigns();
  const seen = new Set();
  const designs = [];
  for (const d of distinct) {
    const key = (d.design || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    designs.push(key);
  }
  designs.sort();
  const rows = [];
  for (let i = 0; i < Math.min(designs.length, 12); i += 2) {
    const row = [{ text: designs[i], callback_data: `gr:dg:${designs[i]}` }];
    if (designs[i + 1]) row.push({ text: designs[i + 1], callback_data: `gr:dg:${designs[i + 1]}` });
    rows.push(row);
  }
  rows.push([{ text: '➕ New design', callback_data: 'gr:dg_new' }]);
  rows.push([{ text: '⬅ Back', callback_data: 'gr:back:supplier' }, ...cancelRow()]);
  await render(bot, chatId, userId, 'Select the *design*:', rows);
}

// ---------------------------------------------------------------------------
// Step 4 — Shade
// ---------------------------------------------------------------------------

async function showShadeStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const all = await inventoryRepository.getAll();
  const shades = Array.from(
    new Set(all.filter((r) => (r.design || '').trim() === (session.design || '').trim() && r.shade).map((r) => r.shade))
  ).sort();
  const rows = [];
  for (let i = 0; i < Math.min(shades.length, 12); i += 2) {
    const row = [{ text: shades[i], callback_data: `gr:sh:${shades[i]}` }];
    if (shades[i + 1]) row.push({ text: shades[i + 1], callback_data: `gr:sh:${shades[i + 1]}` });
    rows.push(row);
  }
  rows.push([{ text: '➕ New shade', callback_data: 'gr:sh_new' }, { text: '🚫 No shade', callback_data: 'gr:sh_none' }]);
  rows.push([{ text: '⬅ Back', callback_data: 'gr:back:design' }, ...cancelRow()]);
  await render(bot, chatId, userId, 'Select the *shade* (or skip):', rows);
}

// ---------------------------------------------------------------------------
// Step 5 — Bales
// ---------------------------------------------------------------------------

async function showBalesStep(bot, chatId, userId) {
  const rows = [
    [{ text: '⬅ Back', callback_data: 'gr:back:shade' }, ...cancelRow()],
  ];
  const prompt = [
    'Enter the *bale numbers* (reply in chat).',
    '',
    'Formats accepted:',
    ' • Comma list:  `5801,5802,5803`',
    ' • Range:       `5801-5810`',
    ' • Mixed:       `5801-5805, 5812, 5820`',
  ].join('\n');
  await render(bot, chatId, userId, prompt, rows);
}

async function showYardsStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const rows = [
    [
      { text: '40', callback_data: 'gr:y:40' },
      { text: '45', callback_data: 'gr:y:45' },
      { text: '50', callback_data: 'gr:y:50' },
    ],
    [
      { text: '55', callback_data: 'gr:y:55' },
      { text: '60', callback_data: 'gr:y:60' },
      { text: '✏️ Custom', callback_data: 'gr:y:custom' },
    ],
    [{ text: '⬅ Back', callback_data: 'gr:back:bales' }, ...cancelRow()],
  ];
  const baleCount = (session.bales || []).length;
  await render(bot, chatId, userId,
    `Pick *yards per bale* (applied to all ${baleCount} bales — you can revise per-bale before submit):`, rows);
}

// ---------------------------------------------------------------------------
// Step 6 — Confirm
// ---------------------------------------------------------------------------

async function showConfirmStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const totalYards = (session.bales || []).reduce((s, b) => s + (b.yards || 0), 0);
  const lines = [];
  lines.push('*Review and submit*');
  lines.push('');
  const preview = (session.bales || []).slice(0, 10);
  for (const b of preview) {
    lines.push(`• Bale *${b.packageNo}* — ${fmtQty(b.yards, { maxFraction: 2 })} yards`);
  }
  if ((session.bales || []).length > 10) {
    lines.push(`_…and ${session.bales.length - 10} more_`);
  }
  lines.push('');
  lines.push(`*Total:* ${session.bales.length} bales · ${fmtQty(totalYards, { maxFraction: 2 })} yards`);

  const rows = [
    [{ text: '✅ Submit', callback_data: 'gr:submit' }],
    [{ text: '⬅ Change yards', callback_data: 'gr:back:yards' }],
    [{ text: '⬅ Back to bales', callback_data: 'gr:back:bales' }, ...cancelRow()],
  ];
  await render(bot, chatId, userId, lines.join('\n'), rows);
}

// ---------------------------------------------------------------------------
// Bale-list parser
// ---------------------------------------------------------------------------

/**
 * Parse a free-text bale list into an array of distinct package numbers.
 * Supports:
 *   "5801,5802"       → ['5801','5802']
 *   "5801-5803"       → ['5801','5802','5803']  (numeric range only)
 *   "5801-5803, 5810" → ['5801','5802','5803','5810']
 *   "A1, A2"          → ['A1','A2']
 *
 * Range bounds must be pure integers; mixed ranges like "A1-A3" stay literal.
 * Returns { ok, bales, error }.
 */
function parseBaleList(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, error: 'Empty input.' };
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, error: 'No bale numbers found.' };
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const rangeMatch = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      if (a > b) return { ok: false, error: `Range "${p}" must go low→high.` };
      if (b - a > 999) return { ok: false, error: `Range "${p}" exceeds 1000 bales; split it up.` };
      for (let n = a; n <= b; n += 1) {
        const s = String(n);
        if (!seen.has(s)) { seen.add(s); out.push(s); }
      }
    } else {
      if (!seen.has(p)) { seen.add(p); out.push(p); }
    }
  }
  if (!out.length) return { ok: false, error: 'Parsed list was empty.' };
  return { ok: true, bales: out };
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function submit(bot, chatId, userId, msgOrNull) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'grn_flow') return;
  const supplier = session.supplier === '__none__' ? '' : (session.supplier || '');
  const supplierId = session.supplier_id || '';
  const shade = session.shade === '__none__' ? '' : (session.shade || '');
  const aj = {
    action: 'receive_goods',
    warehouse: session.warehouse,
    supplier,
    supplier_id: supplierId,
    design: session.design,
    shade,
    bales: session.bales || [],
    dateReceived: new Date().toISOString().split('T')[0],
    productType: 'fabric',
    // P4 linkage — when the GRN was started from a PO context (via
    // "📥 Receive against this PO" in the Procurement Plan), the po_id
    // travels with the actionJSON so the service handler can update the
    // PO's line totals + advance status (partially_received / received).
    po_id: session.po_id || '',
  };

  const risk = await riskEvaluate.evaluate({ action: 'receive_goods', userId });
  if (risk.risk === 'approval_required') {
    const requestId = idGenerator.requestId();
    await approvalQueueRepository.append({
      requestId, user: userId, actionJSON: aj, riskReason: risk.reason, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);
    const isAdm = auth.isAdmin(userId);
    const approverLabel = isAdm ? '2nd admin' : 'admin';
    const excludeId = isAdm ? userId : undefined;
    const totalYards = (session.bales || []).reduce((s, b) => s + (b.yards || 0), 0);
    const summary = `📥 Receive Goods — ${aj.warehouse} · ${aj.design} ${aj.shade ? '/ ' + aj.shade : ''} · ${session.bales.length} bales · ${fmtQty(totalYards, { maxFraction: 2 })} yds`;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, String(userId), summary, risk.reason, excludeId);
    await render(bot, chatId, userId, `⏳ Submitted for ${approverLabel} approval.\nRequest: \`${requestId}\``, [cancelRow()]);
    sessionStore.clear(userId);
    return;
  }

  // Admin path — execute immediately by faking an approval row and calling
  // executeApprovedAction. Cleaner than duplicating the persistence logic.
  const requestId = idGenerator.requestId();
  await approvalQueueRepository.append({
    requestId, user: userId, actionJSON: aj, riskReason: 'admin_direct', status: 'pending',
  });
  let result;
  try {
    result = await inventoryService.executeApprovedAction(requestId, userId);
  } catch (e) {
    logger.error(`goodsReceiptFlow.submit: ${e.message}`);
    await render(bot, chatId, userId, `❌ Receive failed: ${e.message}`, [cancelRow()]);
    return;
  }
  if (!result || !result.ok) {
    await render(bot, chatId, userId, `❌ ${result && result.message ? result.message : 'Receive failed.'}`, [cancelRow()]);
    return;
  }
  const report = result.bundleReport || {};
  const grnId = report.grnId || '?';
  const totalYards = report.totalYards || 0;
  await render(bot, chatId, userId,
    `✅ *Goods received.*\nGRN: \`${grnId}\`\n${report.baleCount || 0} bales · ${fmtQty(totalYards, { maxFraction: 2 })} yards`,
    [[{ text: '📥 Receive more', callback_data: 'gr:more' }], [{ text: '🏠 Menu', callback_data: 'act:__back__' }]],
  );
  sessionStore.clear(userId);

  // Broadcast to admins via the opt-in feed (respects per-admin prefs).
  try {
    const text = `📥 *Goods received*\nWarehouse: *${aj.warehouse}*\n${aj.supplier ? 'Supplier: ' + aj.supplier + '\n' : ''}${aj.design}${aj.shade ? ' / ' + aj.shade : ''} · ${report.baleCount || 0} bales · ${fmtQty(totalYards, { maxFraction: 2 })} yards\nGRN: \`${grnId}\``;
    await adminFeed.notify(bot, 'goods.received', text, { parse_mode: 'Markdown' }, { excludeUserId: userId });
  } catch (_) { /* feed best-effort */ }
}

// ---------------------------------------------------------------------------
// Inline "New warehouse" (dual-admin approval gate)
// ---------------------------------------------------------------------------

async function startNewWarehouse(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'new_warehouse';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    'Type the *new warehouse name* (reply in chat).\n_Will be queued for 2nd-admin approval._',
    [[{ text: '⬅ Back', callback_data: 'gr:back:warehouse' }], cancelRow()],
  );
}

async function submitNewWarehouse(bot, chatId, userId, name) {
  const aj = { action: 'add_warehouse', name };
  const risk = await riskEvaluate.evaluate({ action: 'add_warehouse', userId });
  // add_warehouse is in ALWAYS_APPROVAL_ACTIONS so risk is always 'approval_required'.
  const requestId = idGenerator.requestId();
  await approvalQueueRepository.append({
    requestId, user: userId, actionJSON: aj, riskReason: risk.reason || 'dual_admin_required', status: 'pending',
  });
  await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);
  const isAdm = auth.isAdmin(userId);
  const excludeId = isAdm ? userId : undefined;
  await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, String(userId),
    `🏭 Add warehouse: ${name}`, risk.reason, excludeId);
  await render(bot, chatId, userId,
    `⏳ "${name}" submitted for 2nd-admin approval.\nRequest: \`${requestId}\`\n\n_Pick a different warehouse for this GRN, or cancel and retry once approved._`,
    [[{ text: '⬅ Pick warehouse', callback_data: 'gr:back:warehouse' }], cancelRow()],
  );
  // Return to warehouse step (the new one isn't available yet).
  const session = sessionStore.get(userId);
  if (session) { session.step = 'warehouse'; sessionStore.set(userId, session); }
}

// ---------------------------------------------------------------------------
// Inline "New supplier"
// ---------------------------------------------------------------------------

async function startNewSupplier(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'new_supplier';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    'Type the *new supplier name* (reply in chat).\n_Added immediately to your Contacts; phone/address can be filled later from the Contacts hub._',
    [[{ text: '⬅ Back', callback_data: 'gr:back:supplier' }], cancelRow()],
  );
}

async function saveNewSupplier(bot, chatId, userId, name) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const saved = await contactsRepository.append({ name, type: 'supplier' });
  session.supplier = saved.name;
  session.supplier_id = saved.contact_id;
  session.step = 'design';
  sessionStore.set(userId, session);
  await showDesignStep(bot, chatId, userId);
}

// ---------------------------------------------------------------------------
// Inline "New design" / "New shade" (free-text capture)
// ---------------------------------------------------------------------------

async function startNewDesign(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'new_design';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId, 'Type the *new design name* (reply in chat):',
    [[{ text: '⬅ Back', callback_data: 'gr:back:design' }], cancelRow()]);
}

async function startNewShade(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'new_shade';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId, 'Type the *new shade name* (reply in chat):',
    [[{ text: '⬅ Back', callback_data: 'gr:back:shade' }], cancelRow()]);
}

// ---------------------------------------------------------------------------
// Callback dispatcher
// ---------------------------------------------------------------------------

async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('gr:')) return false;
  try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) { /* noop */ }
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // Re-enter from a non-active state (e.g. tap "Receive more"): start fresh.
  let session = sessionStore.get(userId);
  if (data === 'gr:more') {
    await start(bot, chatId, userId, messageId);
    return true;
  }
  if (data === 'gr:cancel') {
    sessionStore.clear(userId);
    await editOrSend(bot, chatId, messageId, '❌ Cancelled.', {});
    return true;
  }
  if (!session || session.type !== 'grn_flow') {
    // Stale callback — start anew if user tapped a hub-level entry.
    return false;
  }

  // gr:back:<step>
  if (data.startsWith('gr:back:')) {
    const target = data.slice('gr:back:'.length);
    session.step = target;
    sessionStore.set(userId, session);
    if (target === 'warehouse') return showWarehouseStep(bot, chatId, userId), true;
    if (target === 'supplier')  return showSupplierStep(bot, chatId, userId), true;
    if (target === 'design')    return showDesignStep(bot, chatId, userId), true;
    if (target === 'shade')     return showShadeStep(bot, chatId, userId), true;
    if (target === 'bales')     return showBalesStep(bot, chatId, userId), true;
    if (target === 'yards')     return showYardsStep(bot, chatId, userId), true;
    return true;
  }

  // Warehouse
  if (data.startsWith('gr:wh:')) {
    session.warehouse = data.slice('gr:wh:'.length);
    session.step = 'supplier';
    sessionStore.set(userId, session);
    await showSupplierStep(bot, chatId, userId);
    return true;
  }
  if (data === 'gr:wh_new') {
    await startNewWarehouse(bot, chatId, userId);
    return true;
  }

  // Supplier
  if (data.startsWith('gr:sp:')) {
    const sid = data.slice('gr:sp:'.length);
    const s = (await contactsRepository.getByType('supplier')).find((c) => c.contact_id === sid);
    if (s) {
      session.supplier = s.name;
      session.supplier_id = s.contact_id;
    } else {
      session.supplier = '';
      session.supplier_id = '';
    }
    session.step = 'design';
    sessionStore.set(userId, session);
    await showDesignStep(bot, chatId, userId);
    return true;
  }
  if (data === 'gr:sp_new') { await startNewSupplier(bot, chatId, userId); return true; }
  if (data === 'gr:sp_none') {
    session.supplier = '__none__';
    session.supplier_id = '';
    session.step = 'design';
    sessionStore.set(userId, session);
    await showDesignStep(bot, chatId, userId);
    return true;
  }

  // Design
  if (data.startsWith('gr:dg:')) {
    session.design = data.slice('gr:dg:'.length);
    session.step = 'shade';
    sessionStore.set(userId, session);
    await showShadeStep(bot, chatId, userId);
    return true;
  }
  if (data === 'gr:dg_new') { await startNewDesign(bot, chatId, userId); return true; }

  // Shade
  if (data.startsWith('gr:sh:')) {
    session.shade = data.slice('gr:sh:'.length);
    session.step = 'bales';
    sessionStore.set(userId, session);
    await showBalesStep(bot, chatId, userId);
    return true;
  }
  if (data === 'gr:sh_new') { await startNewShade(bot, chatId, userId); return true; }
  if (data === 'gr:sh_none') {
    session.shade = '__none__';
    session.step = 'bales';
    sessionStore.set(userId, session);
    await showBalesStep(bot, chatId, userId);
    return true;
  }

  // Yards
  if (data.startsWith('gr:y:')) {
    const v = data.slice('gr:y:'.length);
    if (v === 'custom') {
      session.step = 'yards_custom';
      sessionStore.set(userId, session);
      await render(bot, chatId, userId, 'Type the *yards-per-bale* value (reply in chat):',
        [[{ text: '⬅ Back', callback_data: 'gr:back:yards' }], cancelRow()]);
      return true;
    }
    const yards = parseFloat(v) || DEFAULT_YARDS_PER_BALE;
    session.yardsPerBale = yards;
    session.bales = (session.bales || []).map((b) => ({ ...b, yards }));
    session.step = 'confirm';
    sessionStore.set(userId, session);
    await showConfirmStep(bot, chatId, userId);
    return true;
  }

  // Submit
  if (data === 'gr:submit') {
    await submit(bot, chatId, userId);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Text-step dispatcher
// ---------------------------------------------------------------------------

async function handleTextStep(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'grn_flow') return false;
  const chatId = msg.chat.id;
  const raw = (msg.text || '').trim();
  if (!raw) return false;

  if (session.step === 'new_warehouse') {
    if (raw.length > 50) {
      await bot.sendMessage(chatId, '⚠️ Warehouse name too long (max 50 chars).');
      return true;
    }
    await submitNewWarehouse(bot, chatId, userId, raw);
    return true;
  }
  if (session.step === 'new_supplier') {
    if (raw.length > 80) {
      await bot.sendMessage(chatId, '⚠️ Supplier name too long (max 80 chars).');
      return true;
    }
    await saveNewSupplier(bot, chatId, userId, raw);
    return true;
  }
  if (session.step === 'new_design') {
    session.design = raw;
    session.step = 'shade';
    sessionStore.set(userId, session);
    await showShadeStep(bot, chatId, userId);
    return true;
  }
  if (session.step === 'new_shade') {
    session.shade = raw;
    session.step = 'bales';
    sessionStore.set(userId, session);
    await showBalesStep(bot, chatId, userId);
    return true;
  }
  if (session.step === 'bales') {
    const parsed = parseBaleList(raw);
    if (!parsed.ok) {
      await bot.sendMessage(chatId, `⚠️ ${parsed.error} Try again or tap Cancel.`);
      return true;
    }
    session.bales = parsed.bales.map((p) => ({ packageNo: p, yards: DEFAULT_YARDS_PER_BALE }));
    session.step = 'yards';
    sessionStore.set(userId, session);
    await showYardsStep(bot, chatId, userId);
    return true;
  }
  if (session.step === 'yards_custom') {
    const v = parseFloat(raw);
    if (!isFinite(v) || v <= 0) {
      await bot.sendMessage(chatId, '⚠️ Enter a positive number, e.g. 47.5');
      return true;
    }
    session.yardsPerBale = v;
    session.bales = (session.bales || []).map((b) => ({ ...b, yards: v }));
    session.step = 'confirm';
    sessionStore.set(userId, session);
    await showConfirmStep(bot, chatId, userId);
    return true;
  }
  return false;
}

module.exports = {
  start,
  handleCallback,
  handleTextStep,
  // exported for smoke harness
  _internals: { parseBaleList, listAllWarehouses, DEFAULT_YARDS_PER_BALE },
};
