'use strict';

const crypto = require('crypto');
const sessionStore = require('../utils/sessionStore');
const catalogStockRepo = require('../repositories/catalogStockRepository');
const catalogLedgerRepo = require('../repositories/catalogLedgerRepository');
const marketersRepo = require('../repositories/marketersRepository');
const customersRepo = require('../repositories/customersRepository');
const inventoryRepo = require('../repositories/inventoryRepository');
const approvalQueueRepo = require('../repositories/approvalQueueRepository');
const auditLogRepo = require('../repositories/auditLogRepository');
const usersRepo = require('../repositories/usersRepository');
const { notifyAdminsApprovalRequest } = require('../events/approvalEvents');
const driveClient = require('../repositories/driveClient');
const { downloadTelegramFile } = require('../utils/telegramFiles');
const fmtDate = require('../utils/formatDate');
const config = require('../config');
const logger = require('../utils/logger');
const idGenerator = require('../utils/idGenerator');

const DESIGNS_PER_PAGE = 12;
const FLOW_TTL_MS = 10 * 60 * 1000;

/* ── Helpers ─────────────────────────────────────────────────────── */

async function editOrSend(bot, chatId, messageId, text, opts = {}) {
  if (messageId) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
    } catch (_) { /* fall through to send */ }
  }
  return bot.sendMessage(chatId, text, opts);
}

async function getDisplayName(userId) {
  try {
    const u = await usersRepo.findByUserId(userId);
    return (u && u.name) || String(userId);
  } catch (_) {
    return String(userId);
  }
}

async function safeDelete(bot, chatId, messageId) {
  if (!messageId) return;
  try { await bot.deleteMessage(chatId, messageId); } catch (_) { /* ignore */ }
}

function cbSafe(data) {
  if (Buffer.byteLength(data, 'utf8') <= 64) return data;
  let s = data;
  while (Buffer.byteLength(s, 'utf8') > 64) s = s.slice(0, -1);
  return s;
}

function saveSession(userId, data) {
  sessionStore.set(userId, { ...data, ttlMs: FLOW_TTL_MS });
}

function trackMsg(session, msg) {
  if (msg && msg.message_id) session.flowMessageId = msg.message_id;
}

function buildBreadcrumb(session, recipientLabel) {
  const lines = [];
  if (session.warehouse) lines.push(`✓ Warehouse: ${session.warehouse}`);
  if (session.design) lines.push(`✓ Design: ${session.design}`);
  if (session.catalogSize) lines.push(`✓ Size: ${session.catalogSize}`);
  if (session.quantity != null) lines.push(`✓ Quantity: ${session.quantity}`);
  if (session.recipientName) lines.push(`✓ ${recipientLabel || 'Recipient'}: ${session.recipientName}`);
  return lines.length ? lines.join('\n') + '\n\n' : '';
}

/* ═══════════════════════════════════════════════════════════════════
   FLOW 1 — REGISTER MARKETER  (prefix mkr:)
   ═══════════════════════════════════════════════════════════════════ */

async function startRegisterMarketerFlow(bot, chatId, userId, messageId) {
  const session = { type: 'marketer_reg_flow', step: 'name', flowMessageId: null };
  const text = '📝 *Register New Marketer*\n\nEnter the marketer\'s full name:';
  const kb = { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'mkr:cancel' }]] };
  const msg = await editOrSend(bot, chatId, messageId, text, { parse_mode: 'Markdown', reply_markup: kb });
  trackMsg(session, msg);
  saveSession(userId, session);
}

async function renderMkrStep(bot, chatId, userId, session) {
  await cleanupReviewPhotos(bot, chatId, session);
  const { step } = session;
  let text, kb;

  if (step === 'name') {
    text = '📝 *Register New Marketer*\n\nEnter the marketer\'s full name:';
    kb = { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'mkr:cancel' }]] };
  } else if (step === 'phone') {
    text = `📝 *Register New Marketer*\n✓ Name: ${session.marketerName}\n\nEnter phone number:`;
    kb = { inline_keyboard: [
      [{ text: '⏭ Skip', callback_data: 'mkr:skip_phone' }],
      [{ text: '◀️ Back', callback_data: 'mkr:back:name' }, { text: '❌ Cancel', callback_data: 'mkr:cancel' }],
    ] };
  } else if (step === 'area') {
    text = `📝 *Register New Marketer*\n✓ Name: ${session.marketerName}\n✓ Phone: ${session.marketerPhone || '—'}\n\nEnter area/location:`;
    kb = { inline_keyboard: [
      [{ text: '⏭ Skip', callback_data: 'mkr:skip_area' }],
      [{ text: '◀️ Back', callback_data: 'mkr:back:phone' }, { text: '❌ Cancel', callback_data: 'mkr:cancel' }],
    ] };
  } else if (step === 'person_photo') {
    text = `📝 *Register New Marketer*\n✓ Name: ${session.marketerName}\n✓ Phone: ${session.marketerPhone || '—'}\n✓ Area: ${session.marketerArea || '—'}\n\n📸 Send a photo of the marketer:`;
    kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'mkr:back:area' }, { text: '❌ Cancel', callback_data: 'mkr:cancel' }]] };
  } else if (step === 'catalog_photo') {
    text = `📝 *Register New Marketer*\n✓ Name: ${session.marketerName}\n✓ Phone: ${session.marketerPhone || '—'}\n✓ Area: ${session.marketerArea || '—'}\n✓ Person photo: ✅\n\n📸 Send a photo of the catalogs:`;
    kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'mkr:back:person_photo' }, { text: '❌ Cancel', callback_data: 'mkr:cancel' }]] };
  } else { return; }

  const msg = await editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: kb });
  trackMsg(session, msg);
  saveSession(userId, session);
}

async function renderMkrReview(bot, chatId, userId, session) {
  await safeDelete(bot, chatId, session.flowMessageId);
  await cleanupReviewPhotos(bot, chatId, session);

  const photoMsgIds = [];
  if (session.personPhotoFileId) {
    try { const m = await bot.sendPhoto(chatId, session.personPhotoFileId, { caption: '👤 Marketer photo' }); photoMsgIds.push(m.message_id); } catch (_) { /* ignore */ }
  }
  if (session.catalogPhotoFileId) {
    try { const m = await bot.sendPhoto(chatId, session.catalogPhotoFileId, { caption: '📚 Catalog photo' }); photoMsgIds.push(m.message_id); } catch (_) { /* ignore */ }
  }
  session.reviewPhotoMsgIds = photoMsgIds;

  const text = '📋 *Marketer Registration — Review*\n\n' +
    `👤 Name: *${session.marketerName}*\n` +
    `📞 Phone: ${session.marketerPhone || '—'}\n` +
    `📍 Area: ${session.marketerArea || '—'}\n` +
    '📸 Person photo: ✅\n📸 Catalog photo: ✅\n\nReview and submit:';
  const kb = { inline_keyboard: [
    [{ text: '✅ Submit for Approval', callback_data: 'mkr:submit' }],
    [{ text: '✏️ Edit Name', callback_data: 'mkr:edit_name' }, { text: '📸 Retake Person', callback_data: 'mkr:retake_person' }],
    [{ text: '📸 Retake Catalog', callback_data: 'mkr:retake_catalog' }, { text: '❌ Cancel', callback_data: 'mkr:cancel' }],
  ] };
  const msg = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
  trackMsg(session, msg);
  session.step = 'review';
  saveSession(userId, session);
}

async function submitMarketer(bot, chatId, userId, session) {
  const requestId = crypto.randomUUID();
  const displayName = await getDisplayName(userId);

  const marketerData = {
    name: session.marketerName, phone: session.marketerPhone || '',
    area: session.marketerArea || '', person_photo_file_id: session.personPhotoFileId || '',
    catalog_photo_file_id: session.catalogPhotoFileId || '', status: 'pending',
    approval_request_id: requestId,
  };
  const created = await marketersRepo.append(marketerData);

  let personDriveId = '', catalogDriveId = '';
  if (session.personPhotoFileId) {
    try {
      const f = await downloadTelegramFile(bot, session.personPhotoFileId);
      const dr = await driveClient.uploadFile(f.buffer, `marketer_${session.marketerName}_person.${f.ext}`, f.mimeType);
      personDriveId = dr.fileId;
    } catch (e) { logger.warn('Drive upload (person) failed:', e.message); }
  }
  if (session.catalogPhotoFileId) {
    try {
      const f = await downloadTelegramFile(bot, session.catalogPhotoFileId);
      const dr = await driveClient.uploadFile(f.buffer, `marketer_${session.marketerName}_catalog.${f.ext}`, f.mimeType);
      catalogDriveId = dr.fileId;
    } catch (e) { logger.warn('Drive upload (catalog) failed:', e.message); }
  }

  const actionJSON = {
    action: 'register_marketer', marketerId: created.marketer_id,
    name: session.marketerName, phone: session.marketerPhone || '',
    area: session.marketerArea || '', personPhotoFileId: session.personPhotoFileId || '',
    catalogPhotoFileId: session.catalogPhotoFileId || '',
    personPhotoDriveId: personDriveId, catalogPhotoDriveId: catalogDriveId,
    requestedBy: String(userId),
  };
  if (session.parentFlow) actionJSON.parentFlow = session.parentFlow;

  await approvalQueueRepo.append({ requestId, user: String(userId), actionJSON, riskReason: 'New marketer registration requires approval', status: 'pending' });

  for (const adminId of config.access.adminIds) {
    if (String(adminId) === String(userId)) continue;
    try {
      if (session.personPhotoFileId) await bot.sendPhoto(adminId, session.personPhotoFileId, { caption: `👤 ${session.marketerName} — person photo` });
      if (session.catalogPhotoFileId) await bot.sendPhoto(adminId, session.catalogPhotoFileId, { caption: `📚 ${session.marketerName} — catalog photo` });
    } catch (_) { /* ignore */ }
  }

  const summary = `Register marketer: ${session.marketerName}\nPhone: ${session.marketerPhone || '—'}\nArea: ${session.marketerArea || '—'}`;
  await notifyAdminsApprovalRequest(bot, requestId, displayName, summary, 'New marketer registration requires approval', String(userId));
  await auditLogRepo.append('register_marketer_request', actionJSON, String(userId));

  await cleanupReviewPhotos(bot, chatId, session);
  await safeDelete(bot, chatId, session.flowMessageId);

  let resp = `✅ *Marketer Registration Submitted*\n\nName: *${session.marketerName}*\nRequest ID: \`${requestId}\`\n\nWaiting for admin approval.`;
  if (session.parentFlow) resp += '\n\nYour loan flow has been paused. You will be notified once the marketer is approved.';
  await bot.sendMessage(chatId, resp, { parse_mode: 'Markdown' });
  sessionStore.clear(userId);
}

async function cleanupReviewPhotos(bot, chatId, session) {
  if (!session.reviewPhotoMsgIds) return;
  for (const mid of session.reviewPhotoMsgIds) await safeDelete(bot, chatId, mid);
  delete session.reviewPhotoMsgIds;
}

async function handleMarketerRegTextStep(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'marketer_reg_flow') return false;
  const trimmed = text.trim();
  if (!trimmed) return true;

  if (session.step === 'name') {
    session.marketerName = trimmed;
    session.step = 'phone';
    await renderMkrStep(bot, chatId, userId, session);
    return true;
  }
  if (session.step === 'phone') {
    session.marketerPhone = trimmed;
    session.step = 'area';
    await renderMkrStep(bot, chatId, userId, session);
    return true;
  }
  if (session.step === 'area') {
    session.marketerArea = trimmed;
    session.step = 'person_photo';
    await renderMkrStep(bot, chatId, userId, session);
    return true;
  }
  return false;
}

async function handleMarketerRegPhotoStep(bot, chatId, userId, msg) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'marketer_reg_flow') return false;
  const photos = msg.photo;
  if (!photos || !photos.length) return false;
  const fileId = photos[photos.length - 1].file_id;

  if (session.step === 'person_photo') {
    session.personPhotoFileId = fileId;
    session.step = 'catalog_photo';
    await renderMkrStep(bot, chatId, userId, session);
    return true;
  }
  if (session.step === 'catalog_photo') {
    session.catalogPhotoFileId = fileId;
    await renderMkrReview(bot, chatId, userId, session);
    return true;
  }
  return false;
}

async function handleMkrCallback(bot, callbackQuery) {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const userId = String(callbackQuery.from.id);

  if (data === 'mkr:cancel') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled' });
    const session = sessionStore.get(userId);
    if (session) { await cleanupReviewPhotos(bot, chatId, session); await safeDelete(bot, chatId, session.flowMessageId); }
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, '❌ Marketer registration cancelled.');
    return true;
  }

  const session = sessionStore.get(userId);
  if (!session || session.type !== 'marketer_reg_flow') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired. Please start again.' });
    return true;
  }
  await bot.answerCallbackQuery(callbackQuery.id);

  if (data === 'mkr:skip_phone')    { session.marketerPhone = ''; session.step = 'area';         await renderMkrStep(bot, chatId, userId, session); return true; }
  if (data === 'mkr:skip_area')     { session.marketerArea = '';  session.step = 'person_photo';  await renderMkrStep(bot, chatId, userId, session); return true; }
  if (data === 'mkr:edit_name')     { session.step = 'name';          await renderMkrStep(bot, chatId, userId, session); return true; }
  if (data === 'mkr:retake_person') { session.step = 'person_photo';  await renderMkrStep(bot, chatId, userId, session); return true; }
  if (data === 'mkr:retake_catalog'){ session.step = 'catalog_photo'; await renderMkrStep(bot, chatId, userId, session); return true; }
  if (data === 'mkr:submit')        { await submitMarketer(bot, chatId, userId, session); return true; }
  if (data.startsWith('mkr:back:')) { session.step = data.replace('mkr:back:', ''); await renderMkrStep(bot, chatId, userId, session); return true; }

  return true;
}

/* ═══════════════════════════════════════════════════════════════════
   FLOW 2 & 3 — SUPPLY / LOAN  (prefixes csf: clf:)
   ═══════════════════════════════════════════════════════════════════ */

const CATALOG_FLOWS = {
  csf: {
    prefix: 'csf', sessionType: 'catalog_supply_flow',
    recipientType: 'customer', recipientLabel: 'Customer', recipientIcon: '👤',
    action: 'catalog_supply', title: '📦 Supply Catalog',
    getRecipients: async () => { const all = await customersRepo.getAll(); return all.filter(c => (c.status || 'Active').toLowerCase() === 'active'); },
    recipientCbKey: 'cu', newCb: 'csf:newcust', newLabel: '➕ Add New Customer',
  },
  clf: {
    prefix: 'clf', sessionType: 'catalog_loan_flow',
    recipientType: 'marketer', recipientLabel: 'Marketer', recipientIcon: '🧑‍💼',
    action: 'catalog_loan', title: '📚 Loan Catalog',
    getRecipients: () => marketersRepo.listActive(),
    recipientCbKey: 'mk', newCb: 'clf:newmkt', newLabel: '➕ Register New Marketer',
  },
};

function flowCfgFor(prefix) { return CATALOG_FLOWS[prefix] || null; }
function flowCfgForSession(session) {
  if (!session) return null;
  if (session.type === 'catalog_supply_flow') return CATALOG_FLOWS.csf;
  if (session.type === 'catalog_loan_flow') return CATALOG_FLOWS.clf;
  return null;
}

async function startSupplyCatalogFlow(bot, chatId, userId, messageId) { await startCatFlow(bot, chatId, userId, messageId, CATALOG_FLOWS.csf); }
async function startLoanCatalogFlow(bot, chatId, userId, messageId)   { await startCatFlow(bot, chatId, userId, messageId, CATALOG_FLOWS.clf); }

async function startCatFlow(bot, chatId, userId, messageId, fc) {
  const user = await usersRepo.findByUserId(userId);
  const warehouses = (user && user.warehouses) || [];
  const session = { type: fc.sessionType, step: 'warehouse', flowPrefix: fc.prefix, flowMessageId: messageId, designPage: 0 };

  if (warehouses.length === 1) {
    session.warehouse = warehouses[0];
    session.step = 'design';
    saveSession(userId, session);
    await renderDesignPicker(bot, chatId, userId, session, fc);
    return;
  }
  saveSession(userId, session);
  await renderWarehousePicker(bot, chatId, userId, session, fc);
}

async function renderWarehousePicker(bot, chatId, userId, session, fc) {
  const user = await usersRepo.findByUserId(userId);
  let whList = (user && user.warehouses) || [];
  if (!whList.length) { try { whList = await inventoryRepo.getWarehouses(); } catch (_) { whList = []; } }
  if (!whList.length) {
    const msg = await editOrSend(bot, chatId, session.flowMessageId, '⚠️ No warehouses configured. Please contact admin.');
    trackMsg(session, msg); saveSession(userId, session); return;
  }
  const rows = [];
  for (let i = 0; i < whList.length; i += 2) {
    const row = [{ text: `🏭 ${whList[i]}`, callback_data: cbSafe(`${fc.prefix}:wh:${whList[i]}`) }];
    if (whList[i + 1]) row.push({ text: `🏭 ${whList[i + 1]}`, callback_data: cbSafe(`${fc.prefix}:wh:${whList[i + 1]}`) });
    rows.push(row);
  }
  rows.push([{ text: '❌ Cancel', callback_data: `${fc.prefix}:cancel` }]);
  const msg = await editOrSend(bot, chatId, session.flowMessageId, `${fc.title}\n\n🏭 Select warehouse:`, { reply_markup: { inline_keyboard: rows } });
  trackMsg(session, msg); saveSession(userId, session);
}

async function renderDesignPicker(bot, chatId, userId, session, fc) {
  const designs = await catalogStockRepo.getDesignsWithStock(session.warehouse);
  if (!designs.length) {
    const text = buildBreadcrumb(session, fc.recipientLabel) + '⚠️ No designs with stock at this warehouse.';
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: `${fc.prefix}:back:wh` }, { text: '❌ Cancel', callback_data: `${fc.prefix}:cancel` }]] };
    const msg = await editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: kb });
    trackMsg(session, msg); saveSession(userId, session); return;
  }
  const page = session.designPage || 0;
  const totalPages = Math.ceil(designs.length / DESIGNS_PER_PAGE);
  const pageDesigns = designs.slice(page * DESIGNS_PER_PAGE, (page + 1) * DESIGNS_PER_PAGE);
  const rows = [];
  for (let i = 0; i < pageDesigns.length; i += 2) {
    const row = [];
    for (const d of [pageDesigns[i], pageDesigns[i + 1]]) {
      if (!d) continue;
      const parts = [];
      if (d.sizes.Big) parts.push(`B:${d.sizes.Big}`);
      if (d.sizes.Small) parts.push(`S:${d.sizes.Small}`);
      row.push({ text: `📋 ${d.design} (${parts.join(' ')})`, callback_data: cbSafe(`${fc.prefix}:dg:${d.design}`) });
    }
    rows.push(row);
  }
  if (totalPages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '◀️ Prev', callback_data: `${fc.prefix}:dgpg:prev` });
    nav.push({ text: `${page + 1}/${totalPages}`, callback_data: `${fc.prefix}:noop` });
    if (page < totalPages - 1) nav.push({ text: 'Next ▶️', callback_data: `${fc.prefix}:dgpg:next` });
    rows.push(nav);
  }
  rows.push([{ text: '✏️ Type design', callback_data: `${fc.prefix}:dtype` }]);
  rows.push([{ text: '◀️ Back', callback_data: `${fc.prefix}:back:wh` }, { text: '❌ Cancel', callback_data: `${fc.prefix}:cancel` }]);
  const header = buildBreadcrumb(session, fc.recipientLabel);
  const msg = await editOrSend(bot, chatId, session.flowMessageId, header + '📋 Select design:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  trackMsg(session, msg); saveSession(userId, session);
}

async function renderSizePicker(bot, chatId, userId, session, fc) {
  const stockRows = await catalogStockRepo.findByDesign(session.design);
  const whStock = stockRows.filter(r => r.warehouse.toLowerCase() === session.warehouse.toLowerCase() && r.in_office_qty > 0);
  if (!whStock.length) {
    const text = buildBreadcrumb(session, fc.recipientLabel) + '⚠️ No sizes available for this design at this warehouse.';
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: `${fc.prefix}:back:design` }, { text: '❌ Cancel', callback_data: `${fc.prefix}:cancel` }]] };
    const msg = await editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: kb });
    trackMsg(session, msg); saveSession(userId, session); return;
  }
  const rows = whStock.map(s => {
    const icon = s.catalog_size === 'Big' ? '📘' : '📗';
    return [{ text: `${icon} ${s.catalog_size} — ${s.in_office_qty} available`, callback_data: `${fc.prefix}:sz:${s.catalog_size}` }];
  });
  rows.push([{ text: '◀️ Back', callback_data: `${fc.prefix}:back:design` }, { text: '❌ Cancel', callback_data: `${fc.prefix}:cancel` }]);
  const header = buildBreadcrumb(session, fc.recipientLabel);
  const msg = await editOrSend(bot, chatId, session.flowMessageId, header + '📏 Select size:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  trackMsg(session, msg); saveSession(userId, session);
}

async function renderQtyPicker(bot, chatId, userId, session, fc) {
  const stock = await catalogStockRepo.find(session.design, session.catalogSize, session.warehouse);
  const available = stock ? stock.in_office_qty : 0;
  session.availableQty = available;
  if (available <= 0) {
    const text = buildBreadcrumb(session, fc.recipientLabel) + '⚠️ No stock available for this combination.';
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: `${fc.prefix}:back:size` }, { text: '❌ Cancel', callback_data: `${fc.prefix}:cancel` }]] };
    const msg = await editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: kb });
    trackMsg(session, msg); saveSession(userId, session); return;
  }
  const presets = [1, 2, 3, 5].filter(n => n <= available);
  const row = presets.map(n => ({ text: `${n}`, callback_data: `${fc.prefix}:qt:${n}` }));
  row.push({ text: '✏️ Custom', callback_data: `${fc.prefix}:qt:__custom__` });
  const rows = [row, [{ text: '◀️ Back', callback_data: `${fc.prefix}:back:size` }, { text: '❌ Cancel', callback_data: `${fc.prefix}:cancel` }]];
  const header = buildBreadcrumb(session, fc.recipientLabel);
  const msg = await editOrSend(bot, chatId, session.flowMessageId, header + `🔢 Select quantity (${available} available):`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  trackMsg(session, msg); saveSession(userId, session);
}

async function renderRecipientPicker(bot, chatId, userId, session, fc) {
  const recipients = await fc.getRecipients();
  const allLedger = await catalogLedgerRepo.getAll();
  const withCombo = new Set(
    allLedger.filter(e => e.status === 'active'
      && e.design.toLowerCase() === (session.design || '').toLowerCase()
      && e.catalog_size.toLowerCase() === (session.catalogSize || '').toLowerCase()
      && e.recipient_type === fc.recipientType)
      .map(e => e.recipient_name.toLowerCase()),
  );
  const rows = [];
  for (let i = 0; i < recipients.length; i += 2) {
    const row = [];
    for (const r of [recipients[i], recipients[i + 1]]) {
      if (!r) continue;
      const has = withCombo.has(r.name.toLowerCase());
      row.push({ text: `${fc.recipientIcon} ${has ? '✓ ' : ''}${r.name}`, callback_data: cbSafe(`${fc.prefix}:${fc.recipientCbKey}:${r.name}`) });
    }
    rows.push(row);
  }
  rows.push([{ text: fc.newLabel, callback_data: fc.newCb }]);
  rows.push([{ text: '◀️ Back', callback_data: `${fc.prefix}:back:qty` }, { text: '❌ Cancel', callback_data: `${fc.prefix}:cancel` }]);
  const header = buildBreadcrumb(session, fc.recipientLabel);
  const msg = await editOrSend(bot, chatId, session.flowMessageId, header + `${fc.recipientIcon} Select ${fc.recipientLabel.toLowerCase()}:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  trackMsg(session, msg); saveSession(userId, session);
}

async function renderCatConfirm(bot, chatId, userId, session, fc) {
  const sizeIcon = session.catalogSize === 'Big' ? '📘' : '📗';
  const text = `📋 *${fc.title} — Confirm*\n\n` +
    `🏭 Warehouse: *${session.warehouse}*\n` +
    `📋 Design: *${session.design}*\n` +
    `${sizeIcon} Size: *${session.catalogSize}*\n` +
    `🔢 Quantity: *${session.quantity}*\n` +
    `${fc.recipientIcon} ${fc.recipientLabel}: *${session.recipientName}*`;
  const kb = { inline_keyboard: [
    [{ text: '✅ Submit for Approval', callback_data: `${fc.prefix}:submit` }],
    [{ text: '◀️ Back', callback_data: `${fc.prefix}:back:customer` }, { text: '❌ Cancel', callback_data: `${fc.prefix}:cancel` }],
  ] };
  const msg = await editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: kb });
  trackMsg(session, msg); session.step = 'confirm'; saveSession(userId, session);
}

async function submitCatFlow(bot, chatId, userId, session, fc) {
  const requestId = crypto.randomUUID();
  const displayName = await getDisplayName(userId);
  const actionJSON = {
    action: fc.action, warehouse: session.warehouse, design: session.design,
    catalogSize: session.catalogSize, quantity: session.quantity,
    recipientType: fc.recipientType, recipientName: session.recipientName,
    requestedBy: String(userId), date: new Date().toISOString().split('T')[0],
  };
  await approvalQueueRepo.append({ requestId, user: String(userId), actionJSON, riskReason: `${fc.action} requires approval`, status: 'pending' });
  const sizeIcon = session.catalogSize === 'Big' ? '📘' : '📗';
  const summary = `${fc.action}: ${session.design} ${sizeIcon}${session.catalogSize} ×${session.quantity} → ${session.recipientName} (${session.warehouse})`;
  await notifyAdminsApprovalRequest(bot, requestId, displayName, summary, `${fc.action} requires approval`, String(userId));
  await auditLogRepo.append(`${fc.action}_request`, actionJSON, String(userId));
  await safeDelete(bot, chatId, session.flowMessageId);
  const label = fc.prefix === 'csf' ? 'Supply' : 'Loan';
  const text = `✅ *${label} Request Submitted*\n\n📋 ${session.design} ${sizeIcon} ${session.catalogSize} ×${session.quantity}\n${fc.recipientIcon} ${fc.recipientLabel}: ${session.recipientName}\n🏭 Warehouse: ${session.warehouse}\nRequest ID: \`${requestId}\`\n\nWaiting for admin approval.`;
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  sessionStore.clear(userId);
}

async function handleCatFlowCb(bot, callbackQuery, prefix) {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const userId = String(callbackQuery.from.id);
  const fc = flowCfgFor(prefix);
  if (!fc) return false;

  if (data === `${prefix}:cancel`) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled' });
    const s = sessionStore.get(userId);
    if (s) await safeDelete(bot, chatId, s.flowMessageId);
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, `❌ ${fc.prefix === 'csf' ? 'Supply' : 'Loan'} flow cancelled.`);
    return true;
  }

  const session = sessionStore.get(userId);
  if (!session || session.type !== fc.sessionType) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired. Please start again.' });
    return true;
  }
  await bot.answerCallbackQuery(callbackQuery.id);

  if (data === `${prefix}:noop`) return true;

  if (data.startsWith(`${prefix}:wh:`)) {
    session.warehouse = data.replace(`${prefix}:wh:`, '');
    session.step = 'design'; session.designPage = 0;
    saveSession(userId, session);
    await renderDesignPicker(bot, chatId, userId, session, fc);
    return true;
  }
  if (data.startsWith(`${prefix}:dg:`)) {
    session.design = data.replace(`${prefix}:dg:`, '');
    session.step = 'size'; saveSession(userId, session);
    await renderSizePicker(bot, chatId, userId, session, fc);
    return true;
  }
  if (data === `${prefix}:dgpg:prev`) { session.designPage = Math.max(0, (session.designPage || 0) - 1); saveSession(userId, session); await renderDesignPicker(bot, chatId, userId, session, fc); return true; }
  if (data === `${prefix}:dgpg:next`) { session.designPage = (session.designPage || 0) + 1; saveSession(userId, session); await renderDesignPicker(bot, chatId, userId, session, fc); return true; }

  if (data === `${prefix}:dtype`) {
    session.step = 'design_freetext';
    const header = buildBreadcrumb(session, fc.recipientLabel);
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: `${prefix}:back:design` }, { text: '❌ Cancel', callback_data: `${prefix}:cancel` }]] };
    const msg = await editOrSend(bot, chatId, session.flowMessageId, header + '✏️ Type the design name/number:', { parse_mode: 'Markdown', reply_markup: kb });
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }

  if (data.startsWith(`${prefix}:sz:`)) {
    session.catalogSize = data.replace(`${prefix}:sz:`, '');
    session.step = 'quantity'; saveSession(userId, session);
    await renderQtyPicker(bot, chatId, userId, session, fc);
    return true;
  }

  if (data.startsWith(`${prefix}:qt:`)) {
    const val = data.replace(`${prefix}:qt:`, '');
    if (val === '__custom__') {
      session.step = 'qty_custom';
      const header = buildBreadcrumb(session, fc.recipientLabel);
      const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: `${prefix}:back:qty` }, { text: '❌ Cancel', callback_data: `${prefix}:cancel` }]] };
      const msg = await editOrSend(bot, chatId, session.flowMessageId, header + `✏️ Enter quantity (max ${session.availableQty || '?'}):`, { parse_mode: 'Markdown', reply_markup: kb });
      trackMsg(session, msg); saveSession(userId, session);
      return true;
    }
    session.quantity = parseInt(val, 10);
    session.step = 'recipient'; saveSession(userId, session);
    await renderRecipientPicker(bot, chatId, userId, session, fc);
    return true;
  }

  if (data.startsWith(`${prefix}:${fc.recipientCbKey}:`)) {
    session.recipientName = data.replace(`${prefix}:${fc.recipientCbKey}:`, '');
    saveSession(userId, session);
    await renderCatConfirm(bot, chatId, userId, session, fc);
    return true;
  }

  if (data === 'csf:newcust') {
    session.step = 'new_cust_name';
    const header = buildBreadcrumb(session, fc.recipientLabel);
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: `${prefix}:back:customer` }, { text: '❌ Cancel', callback_data: `${prefix}:cancel` }]] };
    const msg = await editOrSend(bot, chatId, session.flowMessageId, header + '➕ *New Customer*\n\nEnter customer name:', { parse_mode: 'Markdown', reply_markup: kb });
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }

  if (data === 'clf:newmkt') {
    const parentFlow = { type: session.type, warehouse: session.warehouse, design: session.design, catalogSize: session.catalogSize, quantity: session.quantity };
    await safeDelete(bot, chatId, session.flowMessageId);
    sessionStore.clear(userId);
    const ns = { type: 'marketer_reg_flow', step: 'name', flowMessageId: null, parentFlow };
    const text = '📝 *Register New Marketer*\n\n_Your loan flow is paused and will resume after approval._\n\nEnter the marketer\'s full name:';
    const kb = { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'mkr:cancel' }]] };
    const msg = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
    trackMsg(ns, msg); saveSession(userId, ns);
    return true;
  }

  if (data === `${prefix}:submit`) { await submitCatFlow(bot, chatId, userId, session, fc); return true; }

  if (data.startsWith(`${prefix}:back:`)) {
    const target = data.replace(`${prefix}:back:`, '');
    if (target === 'wh') {
      delete session.warehouse; delete session.design; delete session.catalogSize; delete session.quantity; delete session.recipientName;
      session.step = 'warehouse'; session.designPage = 0; saveSession(userId, session);
      await renderWarehousePicker(bot, chatId, userId, session, fc);
      return true;
    }
    if (target === 'design') {
      delete session.design; delete session.catalogSize; delete session.quantity; delete session.recipientName;
      session.step = 'design'; saveSession(userId, session);
      await renderDesignPicker(bot, chatId, userId, session, fc);
      return true;
    }
    if (target === 'size') {
      delete session.catalogSize; delete session.quantity; delete session.recipientName;
      session.step = 'size'; saveSession(userId, session);
      await renderSizePicker(bot, chatId, userId, session, fc);
      return true;
    }
    if (target === 'qty') {
      delete session.quantity; delete session.recipientName;
      session.step = 'quantity'; saveSession(userId, session);
      await renderQtyPicker(bot, chatId, userId, session, fc);
      return true;
    }
    if (target === 'customer') {
      delete session.recipientName;
      session.step = 'recipient'; saveSession(userId, session);
      await renderRecipientPicker(bot, chatId, userId, session, fc);
      return true;
    }
    return true;
  }

  return true;
}

async function handleCatFlowText(bot, chatId, userId, text) {
  const session = sessionStore.get(userId);
  if (!session) return false;
  const fc = flowCfgForSession(session);
  if (!fc) return false;
  const trimmed = text.trim();
  if (!trimmed) return true;

  if (session.step === 'design_freetext') {
    session.design = trimmed; session.step = 'size'; saveSession(userId, session);
    await renderSizePicker(bot, chatId, userId, session, fc);
    return true;
  }
  if (session.step === 'qty_custom') {
    const qty = parseInt(trimmed, 10);
    if (isNaN(qty) || qty <= 0) { await bot.sendMessage(chatId, '⚠️ Please enter a valid positive number.'); return true; }
    if (session.availableQty && qty > session.availableQty) { await bot.sendMessage(chatId, `⚠️ Maximum available is ${session.availableQty}.`); return true; }
    session.quantity = qty; session.step = 'recipient'; saveSession(userId, session);
    await renderRecipientPicker(bot, chatId, userId, session, fc);
    return true;
  }
  if (session.step === 'new_cust_name') {
    session.newCustName = trimmed; session.step = 'new_cust_phone';
    const header = buildBreadcrumb(session, fc.recipientLabel);
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: `${fc.prefix}:back:customer` }, { text: '❌ Cancel', callback_data: `${fc.prefix}:cancel` }]] };
    const msg = await editOrSend(bot, chatId, session.flowMessageId, header + `➕ *New Customer: ${trimmed}*\n\nEnter phone number (or type "skip"):`, { parse_mode: 'Markdown', reply_markup: kb });
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }
  if (session.step === 'new_cust_phone') {
    const phone = trimmed.toLowerCase() === 'skip' ? '' : trimmed;
    const custId = idGenerator.customer();
    await customersRepo.append({ customer_id: custId, name: session.newCustName, phone, status: 'Pending' });
    const requestId = crypto.randomUUID();
    const displayName = await getDisplayName(userId);
    await approvalQueueRepo.append({
      requestId, user: String(userId),
      actionJSON: { action: 'new_customer', customer_id: custId, customer_name: session.newCustName, customer_phone: phone, requesterUserId: String(userId), parentFlowType: session.type },
      riskReason: 'New customer registration requires approval', status: 'pending',
    });
    await notifyAdminsApprovalRequest(bot, requestId, displayName, `New customer: ${session.newCustName} (Phone: ${phone || '—'})`, 'New customer registration requires approval', String(userId));
    session.step = 'awaiting_cust_approval'; session.customerApprovalId = requestId; session.pendingCustomerName = session.newCustName;
    const header = buildBreadcrumb(session, fc.recipientLabel);
    const msg = await editOrSend(bot, chatId, session.flowMessageId, header + `⏳ *Customer "${session.newCustName}" submitted for approval.*\n\nYou'll be notified when approved. Please restart the flow after approval.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } });
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }
  return false;
}

/* ═══════════════════════════════════════════════════════════════════
   FLOW 4 — RETURN CATALOG  (prefix crf:)
   ═══════════════════════════════════════════════════════════════════ */

async function startReturnCatalogFlow(bot, chatId, userId, messageId) {
  const session = { type: 'catalog_return_flow', step: 'recipient_type', flowMessageId: null, selectedItemIds: [] };
  const msg = await renderReturnTypePicker(bot, chatId, messageId);
  trackMsg(session, msg); saveSession(userId, session);
}

async function renderReturnTypePicker(bot, chatId, messageId) {
  const text = '🔄 *Return Catalog*\n\nReturn from:';
  const kb = { inline_keyboard: [
    [{ text: '👤 From Customer', callback_data: 'crf:type:customer' }],
    [{ text: '🧑‍💼 From Marketer', callback_data: 'crf:type:marketer' }],
    [{ text: '❌ Cancel', callback_data: 'crf:cancel' }],
  ] };
  return editOrSend(bot, chatId, messageId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function renderReturnPersonPicker(bot, chatId, userId, session) {
  const allLedger = await catalogLedgerRepo.getAll();
  const active = allLedger.filter(e => e.status === 'active' && e.recipient_type === session.returnRecipientType);
  const people = new Map();
  for (const e of active) {
    const key = e.recipient_name.toLowerCase();
    if (!people.has(key)) people.set(key, { name: e.recipient_name, count: 0 });
    people.get(key).count += e.quantity;
  }
  if (!people.size) {
    const typeLabel = session.returnRecipientType === 'customer' ? 'customers' : 'marketers';
    const text = `🔄 *Return Catalog*\n✓ Type: ${session.returnRecipientType}\n\n⚠️ No ${typeLabel} with active catalogs.`;
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'crf:back:type' }, { text: '❌ Cancel', callback_data: 'crf:cancel' }]] };
    const msg = await editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: kb });
    trackMsg(session, msg); saveSession(userId, session); return;
  }
  const icon = session.returnRecipientType === 'customer' ? '👤' : '🧑‍💼';
  const rows = [];
  for (const [, p] of people) rows.push([{ text: `${icon} ${p.name} (${p.count} catalogs)`, callback_data: cbSafe(`crf:person:${p.name}`) }]);
  rows.push([{ text: '◀️ Back', callback_data: 'crf:back:type' }, { text: '❌ Cancel', callback_data: 'crf:cancel' }]);
  const text = `🔄 *Return Catalog*\n✓ Type: ${session.returnRecipientType}\n\nSelect person:`;
  const msg = await editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  trackMsg(session, msg); saveSession(userId, session);
}

async function renderReturnItems(bot, chatId, userId, session) {
  const items = await catalogLedgerRepo.findActive(session.returnPersonName, session.returnRecipientType);
  session.availableReturnItems = items.map(e => ({
    ledgerId: e.ledger_id, design: e.design, catalogSize: e.catalog_size,
    quantity: e.quantity, warehouse: e.warehouse, dateOut: e.date_out,
  }));
  if (!items.length) {
    const text = `🔄 *Return Catalog*\n✓ Type: ${session.returnRecipientType}\n✓ Person: ${session.returnPersonName}\n\n⚠️ No active catalog entries found.`;
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'crf:back:person' }, { text: '❌ Cancel', callback_data: 'crf:cancel' }]] };
    const msg = await editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: kb });
    trackMsg(session, msg); saveSession(userId, session); return;
  }
  const selected = new Set(session.selectedItemIds || []);
  const rows = session.availableReturnItems.map(item => {
    const icon = selected.has(item.ledgerId) ? '✅' : '⬜';
    const sizeIcon = item.catalogSize === 'Big' ? '📘' : '📗';
    const dateStr = item.dateOut ? ` (${fmtDate(item.dateOut)})` : '';
    return [{ text: `${icon} ${item.design} ${sizeIcon}${item.catalogSize} ×${item.quantity}${dateStr}`, callback_data: cbSafe(`crf:toggle:${item.ledgerId}`) }];
  });
  if (selected.size > 0) rows.push([{ text: `✅ Return selected (${selected.size})`, callback_data: 'crf:confirm_items' }]);
  rows.push([{ text: '☑️ Select All', callback_data: 'crf:select_all' }]);
  rows.push([{ text: '◀️ Back', callback_data: 'crf:back:person' }, { text: '❌ Cancel', callback_data: 'crf:cancel' }]);
  const text = `🔄 *Return Catalog*\n✓ Type: ${session.returnRecipientType}\n✓ Person: ${session.returnPersonName}\n\nSelect items to return:`;
  const msg = await editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  trackMsg(session, msg); saveSession(userId, session);
}

async function renderReturnWhPicker(bot, chatId, userId, session) {
  const selectedItems = (session.availableReturnItems || []).filter(i => (session.selectedItemIds || []).includes(i.ledgerId));
  const originalWhs = [...new Set(selectedItems.map(i => i.warehouse).filter(Boolean))];
  let allWhs;
  try { allWhs = await inventoryRepo.getWarehouses(); } catch (_) { allWhs = []; }
  const whSet = new Set([...originalWhs, ...allWhs]);
  const whList = Array.from(whSet);
  if (whList.length === 0 && originalWhs.length === 1) {
    session.returnWarehouse = originalWhs[0]; session.step = 'confirm'; saveSession(userId, session);
    await renderReturnConfirm(bot, chatId, userId, session); return;
  }
  const rows = whList.map(wh => {
    const isOrig = originalWhs.includes(wh);
    return [{ text: `🏭 ${wh}${isOrig ? ' (original)' : ''}`, callback_data: cbSafe(`crf:rtwh:${wh}`) }];
  });
  rows.push([{ text: '◀️ Back', callback_data: 'crf:back:items' }, { text: '❌ Cancel', callback_data: 'crf:cancel' }]);
  const selCount = (session.selectedItemIds || []).length;
  const text = `🔄 *Return Catalog*\n✓ Type: ${session.returnRecipientType}\n✓ Person: ${session.returnPersonName}\n✓ Items: ${selCount} selected\n\nReturn to which warehouse?`;
  const msg = await editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  trackMsg(session, msg); saveSession(userId, session);
}

async function renderReturnConfirm(bot, chatId, userId, session) {
  const selectedItems = (session.availableReturnItems || []).filter(i => (session.selectedItemIds || []).includes(i.ledgerId));
  const itemLines = selectedItems.map(i => {
    const sizeIcon = i.catalogSize === 'Big' ? '📘' : '📗';
    return `  • ${i.design} ${sizeIcon}${i.catalogSize} ×${i.quantity}`;
  }).join('\n');
  const text = `🔄 *Return Catalog — Confirm*\n\n📋 Type: *${session.returnRecipientType}*\n👤 Person: *${session.returnPersonName}*\n🏭 Return to: *${session.returnWarehouse}*\n\nItems to return:\n${itemLines}`;
  const kb = { inline_keyboard: [
    [{ text: '✅ Submit for Approval', callback_data: 'crf:submit' }],
    [{ text: '◀️ Back', callback_data: 'crf:back:warehouse' }, { text: '❌ Cancel', callback_data: 'crf:cancel' }],
  ] };
  const msg = await editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: kb });
  trackMsg(session, msg); session.step = 'confirm'; saveSession(userId, session);
}

async function submitReturn(bot, chatId, userId, session) {
  const requestId = crypto.randomUUID();
  const displayName = await getDisplayName(userId);
  const selectedItems = (session.availableReturnItems || []).filter(i => (session.selectedItemIds || []).includes(i.ledgerId));
  const actionJSON = {
    action: 'catalog_return', recipientType: session.returnRecipientType,
    recipientName: session.returnPersonName, returnItems: selectedItems,
    returnWarehouse: session.returnWarehouse, requestedBy: String(userId),
    date: new Date().toISOString().split('T')[0],
  };
  await approvalQueueRepo.append({ requestId, user: String(userId), actionJSON, riskReason: 'Catalog return requires approval', status: 'pending' });
  const summary = `Return ${selectedItems.length} catalog(s) from ${session.returnPersonName} (${session.returnRecipientType}) to ${session.returnWarehouse}`;
  await notifyAdminsApprovalRequest(bot, requestId, displayName, summary, 'Catalog return requires approval', String(userId));
  await auditLogRepo.append('catalog_return_request', actionJSON, String(userId));
  await safeDelete(bot, chatId, session.flowMessageId);
  const text = `✅ *Return Request Submitted*\n\n👤 ${session.returnPersonName} (${session.returnRecipientType})\n📦 Items: ${selectedItems.length}\n🏭 Return to: ${session.returnWarehouse}\nRequest ID: \`${requestId}\`\n\nWaiting for admin approval.`;
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  sessionStore.clear(userId);
}

async function handleReturnCb(bot, callbackQuery) {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const userId = String(callbackQuery.from.id);

  if (data === 'crf:cancel') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled' });
    const s = sessionStore.get(userId);
    if (s) await safeDelete(bot, chatId, s.flowMessageId);
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, '❌ Return flow cancelled.');
    return true;
  }
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'catalog_return_flow') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired. Please start again.' });
    return true;
  }
  await bot.answerCallbackQuery(callbackQuery.id);

  if (data.startsWith('crf:type:')) {
    session.returnRecipientType = data.replace('crf:type:', '');
    session.step = 'person'; saveSession(userId, session);
    await renderReturnPersonPicker(bot, chatId, userId, session);
    return true;
  }
  if (data.startsWith('crf:person:')) {
    session.returnPersonName = data.replace('crf:person:', '');
    session.step = 'items'; session.selectedItemIds = []; saveSession(userId, session);
    await renderReturnItems(bot, chatId, userId, session);
    return true;
  }
  if (data.startsWith('crf:toggle:')) {
    const lid = data.replace('crf:toggle:', '');
    const sel = session.selectedItemIds || [];
    const idx = sel.indexOf(lid);
    if (idx >= 0) sel.splice(idx, 1); else sel.push(lid);
    session.selectedItemIds = sel; saveSession(userId, session);
    await renderReturnItems(bot, chatId, userId, session);
    return true;
  }
  if (data === 'crf:select_all') {
    session.selectedItemIds = (session.availableReturnItems || []).map(i => i.ledgerId);
    saveSession(userId, session);
    await renderReturnItems(bot, chatId, userId, session);
    return true;
  }
  if (data === 'crf:confirm_items') {
    session.step = 'warehouse'; saveSession(userId, session);
    await renderReturnWhPicker(bot, chatId, userId, session);
    return true;
  }
  if (data.startsWith('crf:rtwh:')) {
    session.returnWarehouse = data.replace('crf:rtwh:', '');
    session.step = 'confirm'; saveSession(userId, session);
    await renderReturnConfirm(bot, chatId, userId, session);
    return true;
  }
  if (data === 'crf:submit') { await submitReturn(bot, chatId, userId, session); return true; }

  if (data.startsWith('crf:back:')) {
    const target = data.replace('crf:back:', '');
    if (target === 'type') {
      delete session.returnRecipientType; delete session.returnPersonName;
      session.selectedItemIds = []; session.step = 'recipient_type'; saveSession(userId, session);
      const msg = await renderReturnTypePicker(bot, chatId, session.flowMessageId);
      trackMsg(session, msg); saveSession(userId, session);
      return true;
    }
    if (target === 'person') {
      delete session.returnPersonName; session.selectedItemIds = [];
      session.step = 'person'; saveSession(userId, session);
      await renderReturnPersonPicker(bot, chatId, userId, session);
      return true;
    }
    if (target === 'items') {
      session.step = 'items'; saveSession(userId, session);
      await renderReturnItems(bot, chatId, userId, session);
      return true;
    }
    if (target === 'warehouse') {
      delete session.returnWarehouse; session.step = 'warehouse'; saveSession(userId, session);
      await renderReturnWhPicker(bot, chatId, userId, session);
      return true;
    }
    return true;
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════════════
   FLOW 5 — CATALOG TRACKER  (prefix ctr:)
   ═══════════════════════════════════════════════════════════════════ */

async function startCatalogTracker(bot, chatId, userId, messageId) {
  const session = { type: 'catalog_tracker', step: 'menu', flowMessageId: null };
  const msg = await renderTrackerMenu(bot, chatId, messageId);
  trackMsg(session, msg); saveSession(userId, session);
}

async function renderTrackerMenu(bot, chatId, messageId) {
  const text = '📊 *Catalog Tracker*\n\nSelect a view:';
  const kb = { inline_keyboard: [
    [{ text: '📦 Stock Overview', callback_data: 'ctr:stock' }],
    [{ text: '👤 By Customer', callback_data: 'ctr:customers' }],
    [{ text: '🧑‍💼 By Marketer', callback_data: 'ctr:marketers' }],
    [{ text: '📋 Marketer Profiles', callback_data: 'ctr:profiles' }],
    [{ text: '🕐 Recent Activity', callback_data: 'ctr:recent' }],
  ] };
  return editOrSend(bot, chatId, messageId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function renderStockWhPicker(bot, chatId, session) {
  let warehouses;
  try { warehouses = await inventoryRepo.getWarehouses(); } catch (_) { warehouses = []; }
  const rows = [[{ text: '📊 All Warehouses', callback_data: 'ctr:stk_wh:__all__' }]];
  for (const wh of warehouses) rows.push([{ text: `🏭 ${wh}`, callback_data: cbSafe(`ctr:stk_wh:${wh}`) }]);
  rows.push([{ text: '◀️ Back', callback_data: 'ctr:back' }]);
  return editOrSend(bot, chatId, session.flowMessageId, '📦 *Stock Overview*\n\nSelect warehouse:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function renderStockView(bot, chatId, session, warehouse) {
  let stock;
  if (warehouse === '__all__') stock = await catalogStockRepo.getAll();
  else stock = await catalogStockRepo.findByWarehouse(warehouse);
  if (!stock.length) {
    const whLabel = warehouse === '__all__' ? 'All' : warehouse;
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ctr:stock' }]] };
    return editOrSend(bot, chatId, session.flowMessageId, `📦 *Stock — ${whLabel}*\n\n_No catalog stock found._`, { parse_mode: 'Markdown', reply_markup: kb });
  }
  const designMap = new Map();
  for (const s of stock) {
    const key = `${s.design}|${s.warehouse}`;
    if (!designMap.has(key)) designMap.set(key, { design: s.design, warehouse: s.warehouse, sizes: {} });
    designMap.get(key).sizes[s.catalog_size] = { inOffice: s.in_office_qty, withCust: s.with_customers_qty, withMkt: s.with_marketers_qty };
  }
  const lines = [];
  for (const [, d] of designMap) {
    let line = `📋 *${d.design}*`;
    if (warehouse === '__all__') line += ` (${d.warehouse})`;
    const parts = [];
    for (const [size, c] of Object.entries(d.sizes)) {
      const icon = size === 'Big' ? '📘' : '📗';
      parts.push(`${icon}${size}: ${c.inOffice} office / ${c.withCust} cust / ${c.withMkt} mkt`);
    }
    line += '\n  ' + parts.join('\n  ');
    lines.push(line);
  }
  const page = session.stockPage || 0;
  const perPage = 10;
  const totalPages = Math.ceil(lines.length / perPage);
  const pageLines = lines.slice(page * perPage, (page + 1) * perPage);
  const whLabel = warehouse === '__all__' ? 'All Warehouses' : warehouse;
  let text = `📦 *Stock — ${whLabel}*\n\n` + pageLines.join('\n\n');
  const navRow = [];
  if (totalPages > 1) {
    if (page > 0) navRow.push({ text: '◀️ Prev', callback_data: 'ctr:stkpg:prev' });
    navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'ctr:noop' });
    if (page < totalPages - 1) navRow.push({ text: 'Next ▶️', callback_data: 'ctr:stkpg:next' });
  }
  const rows = [];
  if (navRow.length) rows.push(navRow);
  rows.push([{ text: '◀️ Back', callback_data: 'ctr:stock' }]);
  return editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function renderCustView(bot, chatId, session) {
  const allLedger = await catalogLedgerRepo.getAll();
  const active = allLedger.filter(e => e.status === 'active' && e.recipient_type === 'customer');
  const custMap = new Map();
  for (const e of active) {
    const key = e.recipient_name.toLowerCase();
    if (!custMap.has(key)) custMap.set(key, { name: e.recipient_name, count: 0 });
    custMap.get(key).count += e.quantity;
  }
  if (!custMap.size) {
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ctr:back' }]] };
    return editOrSend(bot, chatId, session.flowMessageId, '👤 *Catalogs by Customer*\n\n_No active catalog entries with customers._', { parse_mode: 'Markdown', reply_markup: kb });
  }
  const rows = [];
  for (const [, c] of custMap) rows.push([{ text: `👤 ${c.name} (${c.count} catalogs)`, callback_data: cbSafe(`ctr:cust:${c.name}`) }]);
  rows.push([{ text: '◀️ Back', callback_data: 'ctr:back' }]);
  return editOrSend(bot, chatId, session.flowMessageId, '👤 *Catalogs by Customer*\n\nSelect customer:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function renderCustDetail(bot, chatId, session, name) {
  const items = await catalogLedgerRepo.findActive(name, 'customer');
  if (!items.length) {
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ctr:customers' }]] };
    return editOrSend(bot, chatId, session.flowMessageId, `👤 *${name}*\n\n_No active catalog entries._`, { parse_mode: 'Markdown', reply_markup: kb });
  }
  const lines = items.map(e => {
    const sizeIcon = e.catalog_size === 'Big' ? '📘' : '📗';
    return `  • ${e.design} ${sizeIcon}${e.catalog_size} ×${e.quantity} (since ${fmtDate(e.date_out)})`;
  });
  const text = `👤 *${name}*\n\nActive catalogs:\n${lines.join('\n')}`;
  const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ctr:customers' }]] };
  return editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function renderMktView(bot, chatId, session) {
  const allLedger = await catalogLedgerRepo.getAll();
  const active = allLedger.filter(e => e.status === 'active' && e.recipient_type === 'marketer');
  const mktMap = new Map();
  for (const e of active) {
    const key = e.recipient_name.toLowerCase();
    if (!mktMap.has(key)) mktMap.set(key, { name: e.recipient_name, count: 0, oldestOut: null });
    const m = mktMap.get(key);
    m.count += e.quantity;
    if (e.date_out && (!m.oldestOut || e.date_out < m.oldestOut)) m.oldestOut = e.date_out;
  }
  if (!mktMap.size) {
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ctr:back' }]] };
    return editOrSend(bot, chatId, session.flowMessageId, '🧑‍💼 *Catalogs by Marketer*\n\n_No active catalog loans with marketers._', { parse_mode: 'Markdown', reply_markup: kb });
  }
  const rows = [];
  for (const [, m] of mktMap) {
    const daysOut = m.oldestOut ? Math.floor((Date.now() - new Date(m.oldestOut).getTime()) / 86400000) : '?';
    rows.push([{ text: `🧑‍💼 ${m.name} (${m.count} catalogs, ${daysOut}d)`, callback_data: cbSafe(`ctr:mkt:${m.name}`) }]);
  }
  rows.push([{ text: '◀️ Back', callback_data: 'ctr:back' }]);
  return editOrSend(bot, chatId, session.flowMessageId, '🧑‍💼 *Catalogs by Marketer*\n\nSelect marketer:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function renderMktDetail(bot, chatId, userId, session, name) {
  const items = await catalogLedgerRepo.findActive(name, 'marketer');
  const marketer = await marketersRepo.findByName(name);
  const lines = items.map(e => {
    const sizeIcon = e.catalog_size === 'Big' ? '📘' : '📗';
    const daysOut = e.date_out ? Math.floor((Date.now() - new Date(e.date_out).getTime()) / 86400000) : '?';
    return `  • ${e.design} ${sizeIcon}${e.catalog_size} ×${e.quantity} (${fmtDate(e.date_out)}, ${daysOut}d)`;
  });
  let text = `🧑‍💼 *${name}*\n`;
  if (marketer) text += `📞 ${marketer.phone || '—'} · 📍 ${marketer.area || '—'}\n`;
  text += `\nActive loans:\n${lines.length ? lines.join('\n') : '_None_'}`;

  if (marketer && marketer.person_photo_file_id) {
    await safeDelete(bot, chatId, session.flowMessageId);
    await cleanTrackerPhotos(bot, chatId, session);
    try {
      const pm = await bot.sendPhoto(chatId, marketer.person_photo_file_id, { caption: `👤 ${name}` });
      session.trackerPhotoMsgIds = [pm.message_id];
    } catch (_) { /* ignore */ }
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ctr:marketers' }]] };
    const msg = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
    trackMsg(session, msg); saveSession(userId, session);
    return msg;
  }
  const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ctr:marketers' }]] };
  return editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function renderProfilesView(bot, chatId, session) {
  const all = await marketersRepo.getAll();
  if (!all.length) {
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ctr:back' }]] };
    return editOrSend(bot, chatId, session.flowMessageId, '📋 *Marketer Profiles*\n\n_No marketers registered._', { parse_mode: 'Markdown', reply_markup: kb });
  }
  const rows = all.map(m => {
    const icon = m.status === 'active' ? '✅' : m.status === 'pending' ? '⏳' : '❌';
    return [{ text: `${icon} ${m.name} (${m.area || '—'})`, callback_data: cbSafe(`ctr:prof:${m.marketer_id}`) }];
  });
  rows.push([{ text: '◀️ Back', callback_data: 'ctr:back' }]);
  return editOrSend(bot, chatId, session.flowMessageId, '📋 *Marketer Profiles*\n\nSelect profile:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

async function renderProfileDetail(bot, chatId, userId, session, marketerId) {
  const m = await marketersRepo.findById(marketerId);
  if (!m) {
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ctr:profiles' }]] };
    return editOrSend(bot, chatId, session.flowMessageId, '⚠️ Marketer not found.', { reply_markup: kb });
  }
  const statusIcon = m.status === 'active' ? '✅' : m.status === 'pending' ? '⏳' : '❌';
  const text = `📋 *Marketer Profile*\n\n👤 Name: *${m.name}*\n📞 Phone: ${m.phone || '—'}\n📍 Area: ${m.area || '—'}\n${statusIcon} Status: ${m.status}\n📅 Registered: ${fmtDate(m.created_at)}`;

  await safeDelete(bot, chatId, session.flowMessageId);
  await cleanTrackerPhotos(bot, chatId, session);
  const photoMsgIds = [];
  if (m.person_photo_file_id) {
    try { const pm = await bot.sendPhoto(chatId, m.person_photo_file_id, { caption: `👤 ${m.name}` }); photoMsgIds.push(pm.message_id); } catch (_) { /* ignore */ }
  }
  if (m.catalog_photo_file_id) {
    try { const cm = await bot.sendPhoto(chatId, m.catalog_photo_file_id, { caption: `📚 ${m.name} — catalogs` }); photoMsgIds.push(cm.message_id); } catch (_) { /* ignore */ }
  }
  session.trackerPhotoMsgIds = photoMsgIds;
  const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ctr:profiles' }]] };
  const msg = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
  trackMsg(session, msg); saveSession(userId, session);
  return msg;
}

async function renderRecentActivity(bot, chatId, session) {
  const recent = await catalogLedgerRepo.getRecent(15);
  if (!recent.length) {
    const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ctr:back' }]] };
    return editOrSend(bot, chatId, session.flowMessageId, '🕐 *Recent Catalog Activity*\n\n_No activity found._', { parse_mode: 'Markdown', reply_markup: kb });
  }
  const lines = recent.map(e => {
    const sizeIcon = e.catalog_size === 'Big' ? '📘' : '📗';
    const actionIcon = e.action === 'supply' ? '📦' : e.action === 'loan' ? '📚' : e.action === 'return' ? '🔄' : '📋';
    return `${actionIcon} ${e.design} ${sizeIcon}${e.catalog_size} ×${e.quantity} → ${e.recipient_name} (${fmtDate(e.created_at || e.date_out)})`;
  });
  const text = '🕐 *Recent Catalog Activity*\n\n' + lines.join('\n');
  const kb = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ctr:back' }]] };
  return editOrSend(bot, chatId, session.flowMessageId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function cleanTrackerPhotos(bot, chatId, session) {
  if (session.trackerPhotoMsgIds) {
    for (const mid of session.trackerPhotoMsgIds) await safeDelete(bot, chatId, mid);
    delete session.trackerPhotoMsgIds;
  }
}

async function handleTrackerCb(bot, callbackQuery) {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const userId = String(callbackQuery.from.id);

  let session = sessionStore.get(userId);
  if (!session || session.type !== 'catalog_tracker') {
    session = { type: 'catalog_tracker', step: 'menu', flowMessageId: callbackQuery.message.message_id };
    saveSession(userId, session);
  }
  await bot.answerCallbackQuery(callbackQuery.id);
  if (data === 'ctr:noop') return true;

  if (data === 'ctr:back') {
    await cleanTrackerPhotos(bot, chatId, session);
    const msg = await renderTrackerMenu(bot, chatId, session.flowMessageId);
    trackMsg(session, msg); session.step = 'menu'; saveSession(userId, session);
    return true;
  }
  if (data === 'ctr:stock') {
    await cleanTrackerPhotos(bot, chatId, session);
    session.step = 'stock_wh';
    const msg = await renderStockWhPicker(bot, chatId, session);
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }
  if (data.startsWith('ctr:stk_wh:')) {
    session.stockWarehouse = data.replace('ctr:stk_wh:', '');
    session.stockPage = 0; session.step = 'stock_view';
    const msg = await renderStockView(bot, chatId, session, session.stockWarehouse);
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }
  if (data === 'ctr:stkpg:prev') {
    session.stockPage = Math.max(0, (session.stockPage || 0) - 1);
    const msg = await renderStockView(bot, chatId, session, session.stockWarehouse);
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }
  if (data === 'ctr:stkpg:next') {
    session.stockPage = (session.stockPage || 0) + 1;
    const msg = await renderStockView(bot, chatId, session, session.stockWarehouse);
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }
  if (data === 'ctr:customers') {
    await cleanTrackerPhotos(bot, chatId, session);
    session.step = 'customers';
    const msg = await renderCustView(bot, chatId, session);
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }
  if (data.startsWith('ctr:cust:')) {
    session.step = 'customer_detail';
    const msg = await renderCustDetail(bot, chatId, session, data.replace('ctr:cust:', ''));
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }
  if (data === 'ctr:marketers') {
    await cleanTrackerPhotos(bot, chatId, session);
    session.step = 'marketers';
    const msg = await renderMktView(bot, chatId, session);
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }
  if (data.startsWith('ctr:mkt:')) {
    session.step = 'marketer_detail';
    const msg = await renderMktDetail(bot, chatId, userId, session, data.replace('ctr:mkt:', ''));
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }
  if (data === 'ctr:profiles') {
    await cleanTrackerPhotos(bot, chatId, session);
    session.step = 'profiles';
    const msg = await renderProfilesView(bot, chatId, session);
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }
  if (data.startsWith('ctr:prof:')) {
    session.step = 'profile_detail';
    const msg = await renderProfileDetail(bot, chatId, userId, session, data.replace('ctr:prof:', ''));
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }
  if (data === 'ctr:recent') {
    await cleanTrackerPhotos(bot, chatId, session);
    session.step = 'recent';
    const msg = await renderRecentActivity(bot, chatId, session);
    trackMsg(session, msg); saveSession(userId, session);
    return true;
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN DISPATCHERS
   ═══════════════════════════════════════════════════════════════════ */

async function handleCatalogFlowCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  try {
    if (data.startsWith('mkr:')) return await handleMkrCallback(bot, callbackQuery);
    if (data.startsWith('csf:')) return await handleCatFlowCb(bot, callbackQuery, 'csf');
    if (data.startsWith('clf:')) return await handleCatFlowCb(bot, callbackQuery, 'clf');
    if (data.startsWith('crf:')) return await handleReturnCb(bot, callbackQuery);
    if (data.startsWith('ctr:')) return await handleTrackerCb(bot, callbackQuery);
  } catch (e) {
    logger.error('catalogFlowController callback error:', e);
    try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'An error occurred. Please try again.' }); } catch (_) { /* ignore */ }
  }
  return false;
}

async function handleCatalogFlowTextStep(bot, chatId, userId, text) {
  try {
    if (await handleMarketerRegTextStep(bot, chatId, userId, text)) return true;
    if (await handleCatFlowText(bot, chatId, userId, text)) return true;
  } catch (e) {
    logger.error('catalogFlowController text handler error:', e);
  }
  return false;
}

async function handleCatalogFlowPhotoStep(bot, chatId, userId, msg) {
  try {
    if (await handleMarketerRegPhotoStep(bot, chatId, userId, msg)) return true;
  } catch (e) {
    logger.error('catalogFlowController photo handler error:', e);
  }
  return false;
}

module.exports = {
  startSupplyCatalogFlow,
  startLoanCatalogFlow,
  startReturnCatalogFlow,
  startRegisterMarketerFlow,
  startCatalogTracker,
  handleCatalogFlowCallback,
  handleCatalogFlowTextStep,
  handleCatalogFlowPhotoStep,
};
